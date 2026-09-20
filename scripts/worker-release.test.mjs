import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { executeRelease, activeDeployment, annotationEvidence, cloudflareClient, healthProbe, validateMutationContext } from "./worker-release.mjs";
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

test("health probes are GET-only, refuse redirects and never retain response bodies", async () => {
  const env = { WORKER_BASE_URL: "https://daily-paper.example.workers.dev", WORKER_ACCESS_CLIENT_ID: "id",
    WORKER_ACCESS_CLIENT_SECRET: "secret", WORKER_CRITICAL_API_PATH: "/api/recommendations/daily" };
  const calls = [];
  const check = healthProbe(env, async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.pathname.endsWith("live") ? { status: "ok" } : { status: "ok", feed: { private: "value" } });
  });
  const result = await check();
  assert.doesNotMatch(JSON.stringify(result), /private|secret|value/);
  assert.ok(calls.every(({ options }) => options.method === "GET" && options.redirect === "manual"));
  assert.equal(calls[0].options.headers["CF-Access-Client-Secret"], undefined);
  assert.equal(calls[1].options.headers["CF-Access-Client-Secret"], "secret");
  assert.throws(() => healthProbe({ ...env, WORKER_CRITICAL_API_PATH: "/api/jobs/daily" }), /NOT_ALLOWLISTED/);
  assert.throws(() => healthProbe({ ...env, WORKER_BASE_URL: "https://attacker.invalid" }), /INVALID_PRODUCTION_ORIGIN/);
  await assert.rejects(healthProbe(env, async () => new Response("", { status: 302 }))(), /LIVENESS_FAILED/);
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
