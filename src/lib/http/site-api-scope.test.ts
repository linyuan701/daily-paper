import { describe, expect, it, vi } from "vitest";
import { verifyCloudflareAccess } from "./cloudflare-access";
import { isSiteApiRequest } from "./site-api-scope";
const env = { TEAM_DOMAIN: "https://fixture.cloudflareaccess.com", POLICY_AUD: "owner-aud", ACCESS_ALLOWED_EMAIL: "owner@example.test", SITE_API_POLICY_AUD: "site-aud", SITE_API_ACCESS_CLIENT_ID: "fixture.access" };
const request = (path: string, method = "GET") => new Request(`https://worker.example.test${path}`, { method, headers: { "cf-access-jwt-assertion": "fixture-token" } });
const claims = { type: "app", common_name: "fixture.access", exp: Date.now() / 1000 + 3600 };
describe("Site principal scope", () => {
  it("checks an exact path and method, never job/refresh/admin execution", () => {
    for (const [path, method] of [["/api/feedback/actions", "POST"], ["/api/candidates/content", "PUT"], ["/api/profile/refresh", "GET"]]) expect(isSiteApiRequest(request(path, method))).toBe(true);
    for (const [path, method] of [["/api/profile/refresh", "POST"], ["/api/operations/retry", "POST"], ["/api/jobs/daily", "POST"], ["/api/candidates/content", "POST"], ["/api/feedback/actions/", "POST"], ["/", "GET"]]) expect(isSiteApiRequest(request(path, method))).toBe(false);
  });
  it("validates dedicated audience before accepting an exact service identity", async () => {
    const verify = vi.fn().mockResolvedValue(claims);
    expect(await verifyCloudflareAccess(request("/api/feedback/actions", "POST"), env, verify)).toEqual({ ok: true, email: "site-service" });
    expect(verify).toHaveBeenCalledWith({ token: "fixture-token", teamDomain: env.TEAM_DOMAIN, audience: "site-aud" });
  });
  it("does not authorize other routes even for a valid service assertion", async () => {
    expect((await verifyCloudflareAccess(request("/api/operations/retry", "POST"), env, vi.fn().mockResolvedValue(claims))).ok).toBe(false);
  });
  it("rejects wrong identity, missing expiry, expired assertions, and mixed identities", async () => {
    for (const value of [{ ...claims, common_name: "different" }, { ...claims, exp: undefined }, { ...claims, exp: 1 }, { ...claims, email: env.ACCESS_ALLOWED_EMAIL }]) {
      expect((await verifyCloudflareAccess(request("/api/operations/runs"), env, vi.fn().mockResolvedValue(value))).ok).toBe(false);
    }
  });
  it("is opt-in and preserves owner authentication on existing routes", async () => {
    expect((await verifyCloudflareAccess(request("/api/operations/runs"), { ...env, SITE_API_POLICY_AUD: "" }, vi.fn().mockResolvedValue(claims))).ok).toBe(false);
    expect(await verifyCloudflareAccess(request("/api/operations/runs"), env, vi.fn().mockResolvedValue({ email: env.ACCESS_ALLOWED_EMAIL }))).toEqual({ ok: true, email: env.ACCESS_ALLOWED_EMAIL });
  });
  it("fails closed on invalid JWT verification", async () => {
    expect((await verifyCloudflareAccess(request("/api/profile/snapshot"), env, vi.fn().mockRejectedValue(new Error("bad signature")))).ok).toBe(false);
  });
  it("preserves the owner's access when an API-specific Access application issues its audience", async () => {
    const verifier = vi.fn().mockImplementation(async ({ audience }) => {
      if (audience !== "site-aud") throw new Error("wrong audience");
      return { type: "app", email: env.ACCESS_ALLOWED_EMAIL, exp: Date.now() / 1000 + 3600 };
    });
    expect(await verifyCloudflareAccess(request("/api/profile/snapshot"), env, verifier)).toEqual({ ok: true, email: env.ACCESS_ALLOWED_EMAIL });
    expect((await verifyCloudflareAccess(request("/api/operations/retry", "POST"), env, verifier)).ok).toBe(false);
  });
});
