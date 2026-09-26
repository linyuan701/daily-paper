import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { executeRelease, activeDeployment, annotationEvidence, bindingContract, cloudflareClient, healthProbe, validateMutationContext } from "./worker-release.mjs";
import { uploadConfig, inventory, verifyArtifact } from "./worker-release-artifact.mjs";

const oldVersion = "11111111-1111-1111-1111-111111111111";
const newVersion = "22222222-2222-2222-2222-222222222222";
const oldDeployment = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const newDeployment = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const recoveryDeployment = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const sha = "d".repeat(40);
const runtime = { compatibility_date: "2026-07-27", compatibility_flags: ["nodejs_compat"] };
const version = (id) => ({
  id, annotations: { "workers/tag": sha, "workers/message": `GitHub sha=${sha}` },
  resources: { script_runtime: runtime, bindings: [
    { name: "ASSETS", type: "assets" },
    { name: "DATABASE_URL", type: "secret_text" },
    { name: "DEPLOYMENT_MODE", type: "plain_text", text: "cloud" }
  ] }
});
const deployment = (id, versionId, time = "2026-09-20T00:00:00Z") => ({
  id, created_on: time, versions: [{ version_id: versionId, percentage: 100 }]
});
const workflow = { run_id: "123", control_sha: sha };

function fixture(mode = "deploy") {
  let active = deployment(oldDeployment, oldVersion);
  const writes = [];
  const saves = [];
  const versions = new Map([[oldVersion, version(oldVersion)], [newVersion, version(newVersion)]]);
  const deps = {
    cf: async (path, body) => {
      if (body) {
        assert.equal(path, "/deployments");
        assert.equal(body.force, undefined);
        writes.push(structuredClone(body));
        active = deployment(writes.length === 1 ? newDeployment : recoveryDeployment, body.versions[0].version_id);
        return structuredClone(active);
      }
      if (path === "/deployments") return { deployments: [structuredClone(active)] };
      if (path.startsWith("/versions/")) return structuredClone(versions.get(path.split("/").at(-1)));
      if (path === `/deployments/${oldDeployment}`) return deployment(oldDeployment, oldVersion);
      if (path === "/schedules") return { schedules: [{ cron: "15 0 * * *" }] };
      if (path === "/subdomain") return { enabled: true, previews_enabled: false };
      throw new Error("UNEXPECTED_TEST_REQUEST");
    },
    probe: async () => [{ path: "/api/health/live", status: 200 }, { path: "/api/site/dashboard", status: 200 }],
    save: async (evidence) => saves.push(structuredClone(evidence)),
    verify: async () => ({ source_sha: sha, manifest_sha256: "e".repeat(64) }),
    upload: async () => newVersion
  };
  return {
    input: { mode, sourceSha: sha, expectedDeployment: oldDeployment, workflow,
      versionId: oldVersion, historicalDeployment: oldDeployment },
    deps, writes, saves, versions,
    setActive: (value) => { active = value; }
  };
}

test("active version comes from latest deployment time, not API list order", () => {
  const older = deployment(oldDeployment, oldVersion);
  const newer = deployment(newDeployment, newVersion, "2026-09-21T00:00:00Z");
  for (const items of [[newer, older], [older, newer]]) {
    assert.equal(activeDeployment({ deployments: items }).id, newDeployment);
  }
  newer.versions[0].percentage = 99;
  assert.throws(() => activeDeployment({ deployments: [newer] }), /NOT_SINGLE_100_PERCENT/);
});

test("production mutations require this repository's master workflow_dispatch", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "linyuan701/daily-paper",
    GITHUB_REF: "refs/heads/master", GITHUB_SHA: sha, GITHUB_RUN_ID: "123" };
  validateMutationContext(env);
  for (const change of [{ GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/topic" }, { GITHUB_REPOSITORY: "attacker/fork" }]) {
    assert.throws(() => validateMutationContext({ ...env, ...change }), /GITHUB_MASTER_DISPATCH_REQUIRED/);
  }
});

test("upload creates a version without switching production and saves rollback anchor first", async () => {
  const f = fixture("upload");
  f.deps.upload = async () => {
    assert.equal(f.saves[0].rollback_version_id, oldVersion);
    return newVersion;
  };
  const result = await executeRelease(f.input, f.deps);
  assert.equal(result.status, "uploaded_not_deployed");
  assert.equal(result.target_version_id, newVersion);
  assert.equal(result.active.id, oldDeployment);
  assert.equal(f.writes.length, 0);
});

test("controlled deployment records real source, version, deployment, traffic and time", async () => {
  const f = fixture();
  const result = await executeRelease(f.input, f.deps);
  assert.equal(result.status, "verified");
  assert.equal(result.source_commit_sha, sha);
  assert.equal(result.active.id, newDeployment);
  assert.deepEqual(result.active.versions, [{ version_id: newVersion, percentage: 100 }]);
  assert.equal(result.active.created_on, "2026-09-20T00:00:00Z");
  assert.equal(result.source_sha_attestation, false);
  assert.equal(f.writes.length, 1);
});

test("stale state, split traffic, failed preflight and bad artifact cannot upload", async () => {
  for (const cause of ["stale", "split", "health", "artifact"]) {
    const f = fixture();
    f.deps.upload = async () => assert.fail("must not upload");
    if (cause === "stale") f.input.expectedDeployment = newDeployment;
    if (cause === "split") f.setActive({ ...deployment(oldDeployment, oldVersion), versions: [
      { version_id: oldVersion, percentage: 50 }, { version_id: newVersion, percentage: 50 }
    ] });
    if (cause === "health") f.deps.probe = async () => { throw new Error("CRITICAL_API_FAILED"); };
    if (cause === "artifact") f.deps.verify = async () => { throw new Error("untrusted private error"); };
    await assert.rejects(executeRelease(f.input, f.deps));
    assert.equal(f.writes.length, 0);
    assert.doesNotMatch(JSON.stringify(f.saves), /untrusted private error/);
  }
});

test("changed runtime, vars or secret names fail before switching traffic", async () => {
  for (const change of ["runtime", "vars", "secret"]) {
    const f = fixture();
    const target = f.versions.get(newVersion);
    if (change === "runtime") target.resources.script_runtime = { ...runtime, compatibility_date: "2026-09-20" };
    if (change === "vars") target.resources.bindings[2].text = "local";
    if (change === "secret") target.resources.bindings.push({ name: "NEW_SECRET", type: "secret_text" });
    await assert.rejects(executeRelease(f.input, f.deps), /VERSION_BINDING_OR_RUNTIME_DRIFT/);
    assert.equal(f.writes.length, 0);
  }
});

function assetsFixture(before = {}, after = { base_path: "/" }) {
  const f = fixture();
  for (const [id, assets] of [[oldVersion, before], [newVersion, after]]) {
    f.versions.get(id).resources.script_runtime = {
      ...runtime, usage_model: "standard",
      assets: { serve_directly: false, raw_run_worker_first: true, ...assets }
    };
  }
  return f;
}

test("root assets base paths are equivalent without mutating version metadata", async (t) => {
  const roots = { missing: {}, undefined: { base_path: undefined }, null: { base_path: null }, root: { base_path: "/" } };
  for (const [beforeName, before] of Object.entries(roots)) {
    for (const [afterName, after] of Object.entries(roots)) {
      await t.test(`${beforeName} -> ${afterName}`, async () => {
        const f = assetsFixture(before, after);
        const original = structuredClone(f.versions);
        assert.deepEqual(bindingContract(f.versions.get(oldVersion)), bindingContract(f.versions.get(newVersion)));
        assert.equal(bindingContract(f.versions.get(oldVersion)).runtime.assets.base_path, "/");
        const result = await executeRelease(f.input, f.deps);
        assert.equal(result.status, "verified");
        assert.equal(f.writes.length, 1);
        assert.deepEqual(f.versions, original);
      });
    }
  }
});

test("non-root or invalid base paths still fail before switching traffic", async (t) => {
  for (const before of [{}, { base_path: "/" }]) {
    for (const path of ["/foo", "/assets", "/foo/", "//", "/./", " /", "", false, 0]) {
      await t.test(`${before.base_path ?? "missing"} -> ${JSON.stringify(path)}`, async () => {
        const f = assetsFixture(before, { base_path: path });
        assert.equal(bindingContract(f.versions.get(newVersion)).runtime.assets.base_path, path);
        await assert.rejects(executeRelease(f.input, f.deps), /VERSION_BINDING_OR_RUNTIME_DRIFT/);
        assert.equal(f.writes.length, 0);
      });
    }
  }
});

test("equal root paths do not hide other assets, runtime or binding drift", async (t) => {
  const changes = {
    "assets serve_directly": (r) => { r.script_runtime.assets.serve_directly = true; },
    "assets raw_run_worker_first": (r) => { r.script_runtime.assets.raw_run_worker_first = false; },
    "assets extra field": (r) => { r.script_runtime.assets.html_handling = "none"; },
    "assets removed field": (r) => { delete r.script_runtime.assets.serve_directly; },
    "compatibility date": (r) => { r.script_runtime.compatibility_date = "2026-09-26"; },
    "compatibility flags": (r) => { r.script_runtime.compatibility_flags = ["nodejs_compat", "no_nodejs_compat_v2"]; },
    "usage model": (r) => { r.script_runtime.usage_model = "bundled"; },
    "unknown runtime field": (r) => { r.script_runtime.new_runtime_field = true; },
    "binding value": (r) => { r.bindings[2].text = "local"; },
    "binding name": (r) => { r.bindings[1].name = "OTHER_SECRET"; },
    "binding type": (r) => { r.bindings[1].type = "secret_key"; },
    "binding removed": (r) => { r.bindings.pop(); }
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async () => {
      const f = assetsFixture({ base_path: "/" });
      change(f.versions.get(newVersion).resources);
      await assert.rejects(executeRelease(f.input, f.deps), /VERSION_BINDING_OR_RUNTIME_DRIFT/);
      assert.equal(f.writes.length, 0);
    });
  }
});

test("a missing or malformed assets object is not synthesized into root assets", async () => {
  for (const assets of [undefined, null, [], "", false, 0]) {
    const f = assetsFixture();
    if (assets === undefined) delete f.versions.get(oldVersion).resources.script_runtime.assets;
    else f.versions.get(oldVersion).resources.script_runtime.assets = assets;
    await assert.rejects(executeRelease(f.input, f.deps), /VERSION_BINDING_OR_RUNTIME_DRIFT/);
    assert.equal(f.writes.length, 0);
  }
});

test("sanitized production metadata supports deploy, rollback, dry-run and recovery", async () => {
  // GET version metadata rechecked on 2026-09-26: old assets omitted base_path;
  // the #49 upload returned "/". Keep only runtime and binding names/types/vars.
  const bindings = [
    { name: "ASSETS", type: "assets" },
    ...["ACCESS_ALLOWED_EMAIL", "DAILY_SCHEDULER_GITHUB_TOKEN", "DATABASE_URL", "POLICY_AUD",
      "SITE_READ_ACCESS_CLIENT_ID", "SITE_READ_POLICY_AUD", "TEAM_DOMAIN"].map((name) => ({ name, type: "secret_text" })),
    { name: "DAILY_PAPER_RUNTIME_TARGET", type: "plain_text", text: "cloudflare" },
    { name: "DEPLOYMENT_MODE", type: "plain_text", text: "cloud" },
    { name: "NEXT_PUBLIC_DEPLOYMENT_MODE", type: "plain_text", text: "cloud" }
  ];
  for (const scenario of ["deploy", "rollback", "dry-run", "recovery"]) {
    const f = assetsFixture();
    for (const v of f.versions.values()) v.resources.bindings = structuredClone(bindings);
    if (scenario === "rollback" || scenario === "dry-run") {
      f.input.mode = "rollback";
      f.input.dryRun = scenario === "dry-run";
      f.setActive(deployment(newDeployment, newVersion));
      f.input.expectedDeployment = newDeployment;
      f.deps.upload = async () => assert.fail("rollback must not upload");
    }
    if (scenario === "recovery") {
      let probes = 0;
      f.deps.probe = async () => {
        if (++probes === 2) throw new Error("CRITICAL_API_FAILED");
        return [{ status: 200 }];
      };
      await assert.rejects(executeRelease(f.input, f.deps), /CRITICAL_API_FAILED/);
      assert.deepEqual(f.writes.map((body) => body.versions[0].version_id), [newVersion, oldVersion]);
      assert.equal(f.saves.at(-1).recovery.id, recoveryDeployment);
    } else {
      const result = await executeRelease(f.input, f.deps);
      assert.equal(result.status, scenario === "dry-run" ? "read_only_verified" : "verified");
      assert.equal(f.writes.length, scenario === "dry-run" ? 0 : 1);
      assert.equal(result.active.versions[0].version_id, scenario === "rollback" ? oldVersion : newVersion);
    }
  }
});

test("root canonicalization does not hide concurrent Cron, runtime or subdomain drift", async () => {
  for (const field of ["cron", "runtime", "subdomain"]) {
    const f = assetsFixture();
    let drift = false;
    const originalCf = f.deps.cf;
    f.deps.cf = async (path, body) => {
      const response = await originalCf(path, body);
      if (drift && path === "/schedules" && field === "cron") response.schedules[0].cron = "0 0 * * *";
      if (drift && path === "/subdomain" && field === "subdomain") response.previews_enabled = true;
      if (drift && path === `/versions/${oldVersion}` && field === "runtime") response.resources.script_runtime.assets.serve_directly = true;
      return response;
    };
    f.deps.verify = async () => { drift = true; return { source_sha: sha }; };
    f.deps.upload = async () => assert.fail("must not upload after boundary drift");
    await assert.rejects(executeRelease(f.input, f.deps), /PRODUCTION_BOUNDARY_CHANGED/);
    assert.equal(f.writes.length, 0);
  }
});

test("failed post-deploy health restores the saved version and verifies recovery", async () => {
  const f = fixture();
  let probes = 0;
  f.deps.probe = async () => {
    probes += 1;
    if (probes === 2) throw new Error("CRITICAL_API_FAILED");
    return [{ status: 200 }];
  };
  await assert.rejects(executeRelease(f.input, f.deps), /CRITICAL_API_FAILED/);
  assert.deepEqual(f.writes.map((body) => body.versions[0].version_id), [newVersion, oldVersion]);
  const result = f.saves.at(-1);
  assert.equal(result.status, "failed");
  assert.equal(result.recovery.id, recoveryDeployment);
  assert.equal(result.active.versions[0].version_id, oldVersion);
});

test("recovery does not overwrite a concurrent operator's deployment", async () => {
  const f = fixture();
  let probes = 0;
  f.deps.probe = async () => {
    if (++probes === 2) {
      f.setActive(deployment(recoveryDeployment, newVersion));
      throw new Error("CRITICAL_API_FAILED");
    }
    return [];
  };
  await assert.rejects(executeRelease(f.input, f.deps));
  assert.equal(f.writes.length, 1);
  assert.equal(f.saves.at(-1).recovery_error, "RECOVERY_NOT_VERIFIED_REQUIRES_OPERATOR");
});

test("rollback reuses known Cloudflare version without upload or build; dry-run never writes", async () => {
  for (const dryRun of [true, false]) {
    const f = fixture("rollback");
    f.input.dryRun = dryRun;
    f.deps.upload = async () => assert.fail("rollback cannot upload");
    const result = await executeRelease(f.input, f.deps);
    assert.equal(f.writes.length, dryRun ? 0 : 1);
    assert.equal(result.source_commit_sha, null);
    assert.equal(result.target_version_id, oldVersion);
  }
});

test("rollback requires proof the requested version was in the historical deployment", async () => {
  const f = fixture("rollback");
  f.input.versionId = newVersion;
  await assert.rejects(executeRelease(f.input, f.deps), /VERSION_NOT_IN_KNOWN_DEPLOYMENT/);
  assert.equal(f.writes.length, 0);
});

test("rollback actually transitions from the new version to the known old version", async () => {
  const f = fixture("rollback");
  const currentId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  f.setActive(deployment(currentId, newVersion));
  f.input.expectedDeployment = currentId;
  const result = await executeRelease(f.input, f.deps);
  assert.equal(result.before.versions[0].version_id, newVersion);
  assert.equal(result.active.versions[0].version_id, oldVersion);
  assert.equal(result.rollback_version_id, newVersion);
  assert.equal(result.status, "verified");
});

test("recovery rechecks deployment after HTTP checks before claiming recovery", async () => {
  const f = fixture();
  let probes = 0;
  f.deps.probe = async () => {
    probes += 1;
    if (probes === 2) throw new Error("CRITICAL_API_FAILED");
    if (probes === 3) f.setActive(deployment("dddddddd-dddd-dddd-dddd-dddddddddddd", newVersion));
    return [];
  };
  await assert.rejects(executeRelease(f.input, f.deps), /CRITICAL_API_FAILED/);
  assert.equal(f.saves.at(-1).recovery, undefined);
  assert.equal(f.saves.at(-1).recovery_error, "RECOVERY_NOT_VERIFIED_REQUIRES_OPERATOR");
});

test("explicit rollback can recover an unhealthy current application", async () => {
  const f = fixture("rollback");
  let calls = 0;
  f.deps.probe = async () => {
    if (++calls === 1) throw new Error("CRITICAL_API_FAILED");
    return [{ status: 200 }];
  };
  const result = await executeRelease(f.input, f.deps);
  assert.equal(result.status, "verified");
  assert.equal(result.preflight_health, "failed; explicit rollback continues");
  assert.equal(f.writes.length, 1);
});

test("provider API client allows only reads and deployment POSTs and does not leak errors", async () => {
  const calls = [];
  const cf = cloudflareClient({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "private-value" },
    async (url, options) => {
      calls.push({ url, options });
      return Response.json({ success: false, errors: [{ message: "private-value" }] }, { status: 403 });
    });
  await assert.rejects(cf("/settings", {}), /FORBIDDEN_CLOUDFLARE_OPERATION/);
  await assert.rejects(cf("/schedules", {}), /FORBIDDEN_CLOUDFLARE_OPERATION/);
  await assert.rejects(cf("/deployments"), { message: "CLOUDFLARE_HTTP_403" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "error");
});

const probeEnv = {
  WORKER_BASE_URL: "https://daily-paper.example.workers.dev",
  WORKER_ACCESS_CLIENT_ID: "fixture-client-id", WORKER_ACCESS_CLIENT_SECRET: "fixture-client-secret",
  WORKER_CRITICAL_API_PATH: "/api/site/dashboard"
};
const deniedPath = "/api/recommendations/daily";
const accessLogin = "https://team.cloudflareaccess.com/cdn-cgi/access/login/daily-paper.example.workers.dev";
const denialLocation = accessLogin + "?kid=fixture-aud&meta=private-access-metadata&redirect_url=" + encodeURIComponent(deniedPath);
function probeResponse(url) {
  if (url.pathname === deniedPath) return new Response(null, { status: 302, headers: { Location: denialLocation } });
  return Response.json(url.pathname.endsWith("live") ? { status: "ok" } : { schemaVersion: 1, private: "private-body" });
}

test("scoped probes use the same credential for both APIs, never follow redirects or retain private data", async () => {
  const calls = [];
  const result = await healthProbe(probeEnv, async (url, options) => {
    calls.push({ url, options });
    return probeResponse(url);
  })();
  assert.deepEqual(calls.map(({ url }) => url.pathname), ["/api/health/live", "/api/site/dashboard", deniedPath]);
  assert.ok(calls.every(({ url, options }) => url.origin === probeEnv.WORKER_BASE_URL &&
    options.method === "GET" && options.redirect === "manual" && options.body === undefined));
  for (const header of ["CF-Access-Client-Id", "CF-Access-Client-Secret"]) {
    assert.equal(calls[0].options.headers[header], undefined);
    assert.equal(calls[1].options.headers[header], calls[2].options.headers[header]);
  }
  assert.equal(calls[1].options.headers["CF-Access-Client-Id"], probeEnv.WORKER_ACCESS_CLIENT_ID);
  assert.equal(calls[1].options.headers["CF-Access-Client-Secret"], probeEnv.WORKER_ACCESS_CLIENT_SECRET);
  assert.deepEqual(result.map(({ path, status, outcome, denial }) => ({ path, status, outcome, denial })), [
    { path: "/api/health/live", status: 200, outcome: undefined, denial: undefined },
    { path: "/api/site/dashboard", status: 200, outcome: undefined, denial: undefined },
    { path: deniedPath, status: 302, outcome: "access_denied", denial: "cloudflare_access_login_redirect" }
  ]);
  assert.ok(result.every(({ checked_at }) => Number.isFinite(Date.parse(checked_at))));
  assert.doesNotMatch(JSON.stringify(result), /private|fixture-client|Location|redirect_url|cloudflareaccess\.com/);
});

test("the Site positive probe is mandatory and defaults to Site, never the denied API", async () => {
  const calls = [];
  await healthProbe({ ...probeEnv, WORKER_CRITICAL_API_PATH: undefined }, async (url) => {
    calls.push(url.pathname);
    return probeResponse(url);
  })();
  assert.deepEqual(calls, ["/api/health/live", "/api/site/dashboard", deniedPath]);
  for (const path of [deniedPath, "/api/jobs/daily"]) {
    assert.throws(() => healthProbe({ ...probeEnv, WORKER_CRITICAL_API_PATH: path }), /SCOPED_SITE_CRITICAL_API_REQUIRED/);
  }
  for (const name of ["WORKER_ACCESS_CLIENT_ID", "WORKER_ACCESS_CLIENT_SECRET"]) {
    assert.throws(() => healthProbe({ ...probeEnv, [name]: "" }), /EXISTING_ACCESS_CREDENTIALS_REQUIRED/);
  }
  assert.throws(() => healthProbe({ ...probeEnv, WORKER_BASE_URL: "https://attacker.invalid" }), /INVALID_PRODUCTION_ORIGIN/);
  await assert.rejects(healthProbe(probeEnv, async () => new Response(null, { status: 302 }))(), /LIVENESS_FAILED/);
});

test("Site still requires HTTP 200 JSON and schemaVersion exactly 1", async () => {
  for (const response of [
    new Response(null, { status: 302, headers: { Location: denialLocation } }),
    new Response("private-error-body", { status: 500 }),
    new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
    Response.json({ schemaVersion: 2 }), Response.json({ schemaVersion: "1" }), Response.json({}), Response.json(null),
    new Response("not json", { headers: { "content-type": "application/json" } })
  ]) {
    const calls = [];
    await assert.rejects(healthProbe(probeEnv, async (url) => {
      calls.push(url.pathname);
      return url.pathname === "/api/site/dashboard" ? response : probeResponse(url);
    })(), /CRITICAL_API_FAILED|CRITICAL_API_INVALID_BODY|HEALTH_INVALID_JSON/);
    assert.deepEqual(calls, ["/api/health/live", "/api/site/dashboard"]);
  }
});

test("denial rejects successful access, errors and other status codes even with a valid Access Location", async () => {
  for (const status of [200, 201, 204, 301, 303, 307, 308, 401, 403, 404, 429, 500, 503]) {
    await assert.rejects(healthProbe(probeEnv, async (url) => url.pathname === deniedPath
      ? new Response(null, { status, headers: { Location: denialLocation } }) : probeResponse(url))(),
    { message: "NEGATIVE_API_NOT_DENIED" }, `status ${status} must not satisfy the observed 302 contract`);
  }
});

test("a denial must redirect to HTTPS Cloudflare Access login for this Worker and exact denied path", async () => {
  for (const location of [
    null, "/login", "not-a-url",
    denialLocation.replace("https:", "http:"),
    denialLocation.replace("team.cloudflareaccess.com", "attacker.invalid"),
    denialLocation.replace("team.cloudflareaccess.com", "team.cloudflareaccess.com.attacker.invalid"),
    denialLocation.replace("team.cloudflareaccess.com", "team.cloudflareaccess.com:8443"),
    denialLocation.replace("https://", "https://private:password@"),
    denialLocation + "#fragment",
    denialLocation.replace("/cdn-cgi/access/login/", "/login/"),
    denialLocation.replace("daily-paper.example.workers.dev", "another-worker.example.workers.dev"),
    accessLogin, accessLogin + "?redirect_url=/api/site/dashboard",
    accessLogin + "?redirect_url=https://attacker.invalid" + deniedPath,
    denialLocation + "&redirect_url=" + encodeURIComponent(deniedPath)
  ]) {
    await assert.rejects(healthProbe(probeEnv, async (url) => url.pathname === deniedPath
      ? new Response(null, { status: 302, headers: location === null ? {} : { Location: location } })
      : probeResponse(url))(), { message: "NEGATIVE_API_NOT_DENIED" });
  }
});

test("negative-probe transport failures fail closed without exposing credentials or response bodies", async () => {
  await assert.rejects(healthProbe(probeEnv, async (url) => {
    if (url.pathname === deniedPath) throw new Error("private-client-secret and private-response");
    return probeResponse(url);
  })(), { message: "HEALTH_REQUEST_FAILED" });
  await assert.rejects(healthProbe(probeEnv, async (url) => url.pathname === deniedPath
    ? { status: 200, headers: new Headers(), json: () => assert.fail("must not read private denied-API data") }
    : probeResponse(url))(), { message: "NEGATIVE_API_NOT_DENIED" });
});

test("read-only inspect and rollback dry-run retain both scoped probes and never upload or switch", async () => {
  for (const mode of ["inspect", "rollback"]) {
    const f = fixture(mode);
    f.input.dryRun = true;
    f.deps.probe = healthProbe(probeEnv, probeResponse);
    f.deps.upload = async () => assert.fail("dry-run cannot upload");
    const result = await executeRelease(f.input, f.deps);
    assert.equal(result.status, "read_only_verified");
    assert.equal(result.preflight_checks[1].path, "/api/site/dashboard");
    assert.equal(result.preflight_checks[2].outcome, "access_denied");
    assert.equal(result.active.id, oldDeployment);
    assert.equal(f.writes.length, 0);
  }
});

test("successful deploy and rollback evidence includes the same negative check after the switch", async () => {
  for (const mode of ["deploy", "rollback"]) {
    const f = fixture(mode);
    f.deps.probe = healthProbe(probeEnv, probeResponse);
    const result = await executeRelease(f.input, f.deps);
    assert.equal(result.status, "verified");
    assert.equal(result.postflight_checks.at(-1).outcome, "access_denied");
  }
});

test("post-switch scope leaks fail deploy and rollback and are checked again during guarded recovery", async () => {
  for (const mode of ["deploy", "rollback"]) {
    const f = fixture(mode);
    if (mode === "rollback") {
      f.setActive(deployment(oldDeployment, newVersion));
      f.input.historicalDeployment = recoveryDeployment;
      const originalCf = f.deps.cf;
      f.deps.cf = async (path, body) => path === `/deployments/${recoveryDeployment}`
        ? deployment(recoveryDeployment, oldVersion) : originalCf(path, body);
    }
    let negativeChecks = 0;
    f.deps.probe = healthProbe(probeEnv, async (url) => {
      if (url.pathname === deniedPath && ++negativeChecks === 2) return Response.json({ private: "unexpected-access" });
      return probeResponse(url);
    });
    await assert.rejects(executeRelease(f.input, f.deps), /NEGATIVE_API_NOT_DENIED/);
    assert.equal(negativeChecks, 3);
    assert.deepEqual(f.writes.map((body) => body.versions[0].version_id),
      mode === "deploy" ? [newVersion, oldVersion] : [oldVersion, newVersion]);
    assert.equal(f.saves.at(-1).status, "failed");
    assert.equal(f.saves.at(-1).recovery_checks.at(-1).outcome, "access_denied");
    assert.doesNotMatch(JSON.stringify(f.saves), /unexpected-access|private-access-metadata|fixture-client/);
  }
});

test("annotation claims stay separate from SHA attestation and redact arbitrary text", () => {
  const result = annotationEvidence({ "workers/tag": "secret", "workers/message": `private-value sha=${sha}` });
  assert.equal(result.source_sha_claim, sha);
  assert.equal(result.source_sha_attestation, false);
  assert.equal(result.tag, null);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});

test("artifact hashes detect tampering, unexpected files and unsafe uploader settings", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "worker-release-test-"));
  try {
    await mkdir(resolve(root, "worker"));
    await writeFile(resolve(root, "worker/custom-worker.js"), "export default {};");
    const config = uploadConfig(runtime);
    await writeFile(resolve(root, "wrangler.json"), JSON.stringify(config));
    const writeManifest = async () => writeFile(resolve(root, "manifest.json"), JSON.stringify({
      schema: 1, source_sha: sha, files: await inventory(root)
    }));
    await writeManifest();
    assert.equal((await verifyArtifact(root, sha)).source_sha, sha);
    await writeFile(resolve(root, "worker/custom-worker.js"), "tampered");
    await assert.rejects(verifyArtifact(root, sha), /integrity/);
    await writeManifest();
    await writeFile(resolve(root, "wrangler.json"), JSON.stringify({ ...config, build: { command: "unsafe" } }));
    await writeManifest();
    await assert.rejects(verifyArtifact(root, sha), /unsupported settings/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release inventory rejects workerd state and database files even before hashing", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "worker-release-state-test-"));
  try {
    await mkdir(resolve(root, ".wrangler/state"), { recursive: true });
    await writeFile(resolve(root, ".wrangler/state/metadata.sqlite"), "disposable fixture");
    await assert.rejects(inventory(root), /Unexpected release artifact file/);
    await rm(resolve(root, ".wrangler"), { recursive: true, force: true });
    await mkdir(resolve(root, "assets"));
    await writeFile(resolve(root, "assets/metadata.sqlite"), "disposable fixture");
    await assert.rejects(inventory(root), /Runtime state or credentials/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release inventory rejects environment-file variants inside assets", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "worker-release-env-test-"));
  try {
    await mkdir(resolve(root, "assets"));
    for (const name of [".env", ".env.production", ".dev.vars", ".dev.vars.production"]) {
      const file = resolve(root, "assets", name);
      await writeFile(file, "fixture");
      await assert.rejects(inventory(root), /Runtime state or credentials/);
      await rm(file);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
