import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { NextRequest } from "next/server";

const keys = vi.hoisted(() => ({ resolve: vi.fn() }));
const database = vi.hoisted(() => ({
  client: vi.fn(), release: vi.fn(), forbidden: vi.fn(() => { throw new Error("Forbidden database operation"); })
}));
vi.mock("../../db/prisma/application-client", () => ({
  getApplicationPrismaClient: database.client, releaseApplicationPrismaClient: database.release
}));
vi.mock("jose", async (importOriginal) => ({
  ...await importOriginal<typeof import("jose")>(),
  createRemoteJWKSet: vi.fn((url: URL) => {
    expect(url.href).toBe("https://site-tests.cloudflareaccess.com/cdn-cgi/access/certs");
    return keys.resolve;
  })
}));

import { verifyCloudflareAccess, verifySiteDashboardAccess } from "./cloudflare-access";
import { middleware } from "../../middleware";
import { GET } from "../../app/api/site/dashboard/route";

const environment = {
  DEPLOYMENT_MODE: "cloud",
  TEAM_DOMAIN: "https://site-tests.cloudflareaccess.com",
  POLICY_AUD: "owner-audience",
  ACCESS_ALLOWED_EMAIL: "owner@example.test",
  SITE_READ_POLICY_AUD: "site-audience",
  SITE_READ_ACCESS_CLIENT_ID: "site-client.access"
};
let privateKey: CryptoKey;
const serviceClaims = { type: "app", common_name: environment.SITE_READ_ACCESS_CLIENT_ID };

async function token(payload: JWTPayload = serviceClaims, options: {
  audience?: string; issuer?: string; expires?: string | number; key?: CryptoKey; omitExpiry?: boolean
} = {}) {
  let jwt = new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.issuer ?? environment.TEAM_DOMAIN).setAudience(options.audience ?? environment.SITE_READ_POLICY_AUD)
    .setIssuedAt();
  if (!options.omitExpiry) jwt = jwt.setExpirationTime(options.expires ?? "5m");
  return jwt.sign(options.key ?? privateKey);
}

function request(jwt?: string, path = "/api/site/dashboard", method = "GET") {
  return new NextRequest(`https://daily.example${path}`, {
    method, headers: jwt ? { "cf-access-jwt-assertion": jwt } : {}
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys.resolve.mockImplementation(createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "test-key", alg: "RS256" }] }));
});
beforeEach(() => {
  database.client.mockReset();
  database.release.mockReset();
  database.forbidden.mockClear();
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  vi.stubEnv("ACCESS_JWT_LOCAL_PREVIEW_BYPASS", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("Site Access authorization with real RS256 verification and local test keys", () => {
  it("serves v1 through real middleware, route, aggregation and repositories for the scoped credential", async () => {
    const reads: Record<string, () => Promise<unknown>> = {
      "dailyIngestionRun.findMany": async () => [],
      "profileSnapshot.findFirst": async () => null,
      "candidateFeedbackLog.findMany": async () => []
    };
    const client = new Proxy({}, { get: (_target, model) => new Proxy({}, {
      get: (_delegate, method) => reads[`${String(model)}.${String(method)}`] ?? database.forbidden
    }) });
    database.client.mockReturnValue(client);
    const jwt = await token();
    const req = request(jwt);
    expect((await middleware(req)).status).toBe(200);
    const response = await GET(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", schemaVersion: 1,
      currentRun: null, recommendations: null, ranking: { recommendationsUnavailableReason: "no_run" } });
    expect(database.release.mock.calls[0][0] === client).toBe(true);
    expect(database.forbidden).not.toHaveBeenCalled();
    // Exactly the same signed credential cannot cross the protected API boundary.
    expect((await middleware(request(jwt, "/api/recommendations/daily"))).status).toBe(403);
    expect(database.client).toHaveBeenCalledOnce();
  });

  it.each(["https://daily.example", "http://localhost", "http://127.0.0.1"])(
    "rejects an anonymous dashboard request at %s before any database access", async (origin) => {
      vi.stubEnv("ACCESS_JWT_LOCAL_PREVIEW_BYPASS", "true");
      const response = await GET(new Request(`${origin}/api/site/dashboard`));
      expect(response.status).toBe(403);
      expect(database.client).not.toHaveBeenCalled();
    }
  );

  it("accepts the exact service audience and client on the one GET route", async () => {
    const req = request(await token());
    expect(await verifySiteDashboardAccess(req, environment)).toEqual({ ok: true });
    expect((await middleware(req)).status).toBe(200);
  });

  it("preserves personal GET and admin POST authentication with Site disabled or enabled", async () => {
    const jwt = await token({ email: " OWNER@example.test " }, { audience: environment.POLICY_AUD });
    for (const settings of [environment, { ...environment, SITE_READ_POLICY_AUD: "", SITE_READ_ACCESS_CLIENT_ID: "" }]) {
      expect(await verifyCloudflareAccess(request(jwt), settings)).toEqual({ ok: true, email: "owner@example.test" });
      expect(await verifySiteDashboardAccess(request(jwt), settings)).toEqual({ ok: true });
    }
    for (const [path, method] of [["/", "GET"], ["/api/profile/snapshot", "GET"], ["/api/profile/refresh", "POST"], ["/api/operations/retry", "POST"]]) {
      expect((await middleware(request(jwt, path, method))).status).toBe(200);
    }
  });

  it("accepts the owner from a dedicated path application only on dashboard GET", async () => {
    const jwt = await token({ type: "app", email: environment.ACCESS_ALLOWED_EMAIL });
    expect(await verifySiteDashboardAccess(request(jwt), environment)).toEqual({ ok: true });
    expect((await middleware(request(jwt))).status).toBe(200);
    expect((await middleware(request(jwt, "/api/profile/snapshot"))).status).toBe(403);
    expect((await middleware(request(jwt, "/api/site/dashboard", "POST"))).status).toBe(403);
  });

  it.each([
    "/api/operations/runs", "/api/profile/snapshot", "/api/profile/refresh", "/api/feedback/logs",
    "/api/ranking/recall", "/api/ranking/rerank", "/api/recommendations/daily", "/api/zotero/sync",
    "/api/health/ready", "/api/site/dashboard/", "/api/site/dashboard/extra", "/api/site/dashboard.json", "/"
  ])("does not grant the Site identity access to %s", async (path) => {
    const req = request(await token(), path);
    expect((await verifySiteDashboardAccess(req, environment)).ok).toBe(false);
    expect((await middleware(req)).status).toBe(403);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("rejects Site %s, including automatic HEAD", async (method) => {
    const req = request(await token(), "/api/site/dashboard", method);
    expect((await verifySiteDashboardAccess(req, environment)).ok).toBe(false);
    expect((await middleware(req)).status).toBe(403);
  });

  it("rejects unsigned headers, missing authentication and malformed JWTs", async () => {
    for (const req of [request(), request("not-a-jwt"), new NextRequest("https://daily.example/api/site/dashboard", {
      headers: { "CF-Access-Client-Id": environment.SITE_READ_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": "test-only" }
    })]) {
      expect((await verifySiteDashboardAccess(req, environment)).ok).toBe(false);
      expect((await middleware(req)).status).toBe(403);
    }
  });

  it("rejects incorrect signature, issuer, audience, client, type and expiry", async () => {
    const other = await generateKeyPair("RS256");
    const invalid = await Promise.all([
      token(serviceClaims, { key: other.privateKey }), token(serviceClaims, { issuer: "https://wrong.cloudflareaccess.com" }),
      token(serviceClaims, { audience: "wrong" }), token({ ...serviceClaims, common_name: "other-client.access" }),
      token({ ...serviceClaims, type: "org" }), token(serviceClaims, { expires: "-1m" }), token(serviceClaims, { omitExpiry: true }),
      token({ type: "app", email: "other@example.test" }), token({ ...serviceClaims, email: environment.ACCESS_ALLOWED_EMAIL })
    ]);
    for (const jwt of invalid) expect((await verifySiteDashboardAccess(request(jwt), environment)).ok).toBe(false);
  });

  it("never treats service claims as an owner even with the owner audience and email", async () => {
    const jwt = await token({ ...serviceClaims, email: environment.ACCESS_ALLOWED_EMAIL }, { audience: environment.POLICY_AUD });
    expect((await verifyCloudflareAccess(request(jwt), environment)).ok).toBe(false);
    expect((await middleware(request(jwt, "/api/feedback/logs", "POST"))).status).toBe(403);
  });

  it.each([null, "", 123, environment.SITE_READ_ACCESS_CLIENT_ID])(
    "does not promote any present common_name (%j) to owner authority", async (common_name) => {
      const jwt = await token({ type: "app", common_name, email: environment.ACCESS_ALLOWED_EMAIL },
        { audience: environment.POLICY_AUD });
      expect((await verifyCloudflareAccess(request(jwt), environment)).ok).toBe(false);
      expect((await middleware(request(jwt, "/api/recommendations/daily"))).status).toBe(403);
    }
  );

  it.each(["SITE_READ_POLICY_AUD", "SITE_READ_ACCESS_CLIENT_ID", "TEAM_DOMAIN"])("fails closed when %s is missing", async (key) => {
    expect((await verifySiteDashboardAccess(request(await token()), { ...environment, [key]: "" })).ok).toBe(false);
  });

  it("authenticates the new endpoint in Local Mode without enabling a preview bypass", async () => {
    expect((await verifySiteDashboardAccess(new Request("http://localhost/api/site/dashboard"), {
      ...environment, DEPLOYMENT_MODE: "local", ACCESS_JWT_LOCAL_PREVIEW_BYPASS: "true"
    })).ok).toBe(false);
  });
});
