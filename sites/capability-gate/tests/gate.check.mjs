import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runCapabilityGate, GATE_REVISION } from "../overlay/lib/server/capability-gate.ts";
const env = { DAILY_PAPER_SITE_ALLOWED_EMAIL: "owner@example.test", DAILY_PAPER_API_ORIGIN: "https://daily-paper.zzy19990821.workers.dev", DAILY_PAPER_ACCESS_CLIENT_ID: "synthetic-id", DAILY_PAPER_ACCESS_CLIENT_SECRET: "synthetic-secret", SITES_CAPABILITY_GATE_CANARY: "synthetic-canary" };
const request = (method = "GET", headers = {}) => new Request("https://site.example/api/capability-gate", { method, headers: { "oai-authenticated-user-id": "synthetic-owner", "oai-authenticated-user-email": "owner@example.test", ...headers } });
test("owner and GET required before any environment/network operation", async () => {
  const network = () => assert.fail("Must not call upstream");
  assert.equal((await runCapabilityGate(request("POST"), env, network)).status, 405);
  assert.equal((await runCapabilityGate(request("GET", { "oai-authenticated-user-id": "" }), env, network)).status, 401);
  assert.equal((await runCapabilityGate(request("GET", { "oai-authenticated-user-email": "other@example.test" }), env, network)).status, 403);
  assert.equal((await runCapabilityGate(request(), { ...env, DAILY_PAPER_API_ORIGIN: "https://elsewhere.example" }, network)).status, 503);
});
test("fixed GETs inject credentials only on server and distinguish permitted scope", async () => {
  const calls = [];
  const result = await runCapabilityGate(request("GET", { authorization: "browser-token", cookie: "browser-cookie" }), env, async (url, init) => {
    calls.push([url, init]);
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "manual");
    assert.equal(init.headers.authorization, undefined); assert.equal(init.headers.cookie, undefined);
    if (!init.headers["CF-Access-Client-Secret"] || url.endsWith("/ready")) return new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login?token=not-output" } });
    assert.equal(init.headers["CF-Access-Client-Id"], env.DAILY_PAPER_ACCESS_CLIENT_ID);
    assert.equal(init.headers["CF-Access-Client-Secret"], env.DAILY_PAPER_ACCESS_CLIENT_SECRET);
    return Response.json({ status: "ok", schemaVersion: 1, privateData: env.DAILY_PAPER_ACCESS_CLIENT_SECRET });
  });
  const body = await result.text(); const data = JSON.parse(body);
  assert.equal(calls.length, 3); assert.equal(data.conclusion, "READ_PATH_PASSED_SECRET_PROOF_PENDING");
  assert.equal(data.checks[2].httpStatus, 302);
  assert.equal(data.secrets.canaryProof, createHash("sha256").update(GATE_REVISION + ":" + env.SITES_CAPABILITY_GATE_CANARY).digest("hex"));
  for (const secret of Object.values(env).filter(v => v.startsWith("synthetic"))) assert.equal(body.includes(secret), false);
  assert.equal(body.includes("privateData"), false); assert.equal(body.includes("not-output"), false);
});
test("anonymous success does not prove Access authentication", async () => {
  const response = await runCapabilityGate(request(), env, async () => Response.json({ status: "ok", schemaVersion: 1 }));
  assert.equal((await response.json()).conclusion, "NOT_YET_PROVEN");
});
test("network failures and HTML cannot pass or reflect secrets", async () => {
  let calls = 0;
  const response = await runCapabilityGate(request(), env, async () => {
    calls++; if (calls === 1) throw new Error(env.DAILY_PAPER_ACCESS_CLIENT_SECRET);
    return new Response(env.DAILY_PAPER_ACCESS_CLIENT_SECRET, { headers: { "content-type": "text/html" } });
  });
  const text = await response.text(); assert.equal(text.includes(env.DAILY_PAPER_ACCESS_CLIENT_SECRET), false);
  assert.equal(JSON.parse(text).conclusion, "NOT_YET_PROVEN"); assert.equal(calls, 3);
});
