import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, shaPattern, uuidPattern, verifyArtifact } from "./worker-release-artifact.mjs";

export const repository = "linyuan701/daily-paper";
const evidenceKind = "daily-paper-worker-release/v1";
const fail = (code) => { throw new Error(code); };
const requireValue = (value, pattern, code) => {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
};

export function activeDeployment(deployments) {
  const items = deployments?.deployments;
  if (!Array.isArray(items) || !items.length) fail("NO_DEPLOYMENT");
  const latest = [...items].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  requireValue(latest.id, uuidPattern, "INVALID_DEPLOYMENT_ID");
  if (!Number.isFinite(Date.parse(latest.created_on))) fail("INVALID_DEPLOYMENT_TIME");
  if (latest.versions?.length !== 1 || latest.versions[0].percentage !== 100) fail("NOT_SINGLE_100_PERCENT");
  requireValue(latest.versions[0].version_id, uuidPattern, "INVALID_ACTIVE_VERSION");
  return latest;
}

// Raw annotations are deliberately not artifacts: they are untrusted free text.
export function annotationEvidence(annotations = {}) {
  const tag = annotations["workers/tag"];
  const message = annotations["workers/message"] ?? "";
  return {
    tag: typeof tag === "string" && /^[a-f0-9]{7,40}$/.test(tag) ? tag : null,
    source_sha_claim: message.match(/\bsha=([a-f0-9]{40})\b/)?.[1] ?? null,
    message_sha256: digest(message),
    source_sha_attestation: false
  };
}

export function deploymentEvidence(deployment) {
  return {
    id: deployment.id, created_on: deployment.created_on,
    versions: deployment.versions.map(({ version_id, percentage }) => ({ version_id, percentage })),
    annotation: annotationEvidence(deployment.annotations)
  };
}

export function bindingContract(version) {
  const resources = version?.resources;
  if (!resources?.script_runtime || !Array.isArray(resources.bindings)) fail("MISSING_VERSION_CONTRACT");
  const bindings = resources.bindings.map((binding) => {
    if (!["assets", "plain_text", "json", "secret_text", "secret_key"].includes(binding.type)) {
      fail("UNSUPPORTED_BINDING_REQUIRES_REVIEW");
    }
    // Assets change with code. Secret values are not returned by the versions API.
    return ["assets", "secret_text", "secret_key"].includes(binding.type)
      ? { name: binding.name, type: binding.type }
      : binding;
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { runtime: resources.script_runtime, bindings };
}

function sameContract(left, right) {
  try { assert.deepEqual(bindingContract(left), bindingContract(right)); }
  catch { fail("VERSION_BINDING_OR_RUNTIME_DRIFT"); }
}

function boundary(snapshot) {
  return {
    contract: bindingContract(snapshot.version),
    schedules: snapshot.schedules.schedules.map((entry) => entry.cron).sort(),
    subdomain: snapshot.subdomain
  };
}

function unchanged(before, after, expectedId = before.deployment.id) {
  if (after.deployment.id !== expectedId) fail("PRODUCTION_DEPLOYMENT_CHANGED");
  try { assert.deepEqual(boundary(before), boundary(after)); }
  catch { fail("PRODUCTION_BOUNDARY_CHANGED"); }
}

export function validateMutationContext(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== "refs/heads/master") {
    fail("GITHUB_MASTER_DISPATCH_REQUIRED");
  }
  requireValue(env.GITHUB_SHA, shaPattern, "INVALID_CONTROL_SHA");
  requireValue(env.GITHUB_RUN_ID, /^\d+$/, "INVALID_RUN_ID");
}

export function cloudflareClient(env, request = fetch) {
  requireValue(env.CLOUDFLARE_ACCOUNT_ID, /^[a-f0-9]{32}$/, "CLOUDFLARE_ACCOUNT_ID_REQUIRED");
  if (!env.CLOUDFLARE_API_TOKEN) fail("CLOUDFLARE_API_TOKEN_REQUIRED");
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/daily-paper`;
  return async (path, body) => {
    if (!/^\/(?:deployments(?:\/[a-f0-9-]+)?|versions\/[a-f0-9-]+|schedules|subdomain)$/.test(path) ||
        (body !== undefined && path !== "/deployments")) fail("FORBIDDEN_CLOUDFLARE_OPERATION");
    let response;
    try {
      response = await request(base + path, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      });
    } catch { fail("CLOUDFLARE_REQUEST_FAILED"); }
    let payload;
    try { payload = await response.json(); } catch { fail("CLOUDFLARE_INVALID_RESPONSE"); }
    if (!response.ok || payload.success !== true) fail(`CLOUDFLARE_HTTP_${response.status}`);
    return payload.result;
  };
}

export async function snapshot(cf) {
  const deployment = activeDeployment(await cf("/deployments"));
  const [version, schedules, subdomain] = await Promise.all([
    cf(`/versions/${deployment.versions[0].version_id}`), cf("/schedules"), cf("/subdomain")
  ]);
  if (version.id !== deployment.versions[0].version_id) fail("VERSION_ID_MISMATCH");
  const state = { deployment, version, schedules, subdomain };
  boundary(state); // Fail closed on missing or unsupported state.
  return state;
}

export function healthProbe(env, request = fetch) {
  let base;
  try { base = new URL(env.WORKER_BASE_URL); } catch { fail("WORKER_BASE_URL_REQUIRED"); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
      base.pathname !== "/" || !/^daily-paper\.[a-z0-9-]+\.workers\.dev$/.test(base.hostname)) {
    fail("INVALID_PRODUCTION_ORIGIN");
  }
  const path = env.WORKER_CRITICAL_API_PATH || "/api/site/dashboard";
  // The same scoped identity must read Site and be denied the broader API.
  if (path !== "/api/site/dashboard") fail("SCOPED_SITE_CRITICAL_API_REQUIRED");
  const deniedPath = "/api/recommendations/daily";
  if (!env.WORKER_ACCESS_CLIENT_ID || !env.WORKER_ACCESS_CLIENT_SECRET) fail("EXISTING_ACCESS_CREDENTIALS_REQUIRED");
  return async () => {
    const checks = [];
    for (const endpoint of ["/api/health/live", path, deniedPath]) {
      const headers = { "Cache-Control": "no-cache" };
      if (endpoint !== "/api/health/live") {
        headers["CF-Access-Client-Id"] = env.WORKER_ACCESS_CLIENT_ID;
        headers["CF-Access-Client-Secret"] = env.WORKER_ACCESS_CLIENT_SECRET;
      }
      let response;
      try {
        response = await request(new URL(endpoint, base), {
          method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(30_000)
        });
      } catch { fail("HEALTH_REQUEST_FAILED"); }
      if (endpoint === deniedPath) {
        // A random error or redirect is not proof of Access denial. Never follow
        // Location (or retain its query, which can contain Access metadata).
        let login;
        try { login = new URL(response.headers.get("location")); }
        catch { fail("NEGATIVE_API_NOT_DENIED"); }
        if (response.status !== 302 || login.protocol !== "https:" ||
            login.username || login.password || login.port || login.hash ||
            !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(login.hostname) ||
            login.pathname !== `/cdn-cgi/access/login/${base.hostname}` ||
            login.searchParams.getAll("redirect_url").length !== 1 ||
            login.searchParams.get("redirect_url") !== deniedPath) {
          fail("NEGATIVE_API_NOT_DENIED");
        }
        checks.push({ path: endpoint, status: 302, outcome: "access_denied",
          denial: "cloudflare_access_login_redirect", checked_at: new Date().toISOString() });
        continue;
      }
      if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) {
        fail(endpoint === path ? "CRITICAL_API_FAILED" : "LIVENESS_FAILED");
      }
      let payload;
      try { payload = await response.json(); } catch { fail("HEALTH_INVALID_JSON"); }
      if (endpoint === "/api/health/live" && payload.status !== "ok") fail("LIVENESS_INVALID_BODY");
      if (endpoint === "/api/site/dashboard" && payload?.schemaVersion !== 1) fail("CRITICAL_API_INVALID_BODY");
      checks.push({ path: endpoint, status: 200, checked_at: new Date().toISOString() });
    }
    return checks; // Never retain private API response bodies.
  };
}

export async function executeRelease(input, deps) {
  const { cf, probe, save, upload } = deps;
  if (!["inspect", "upload", "deploy", "rollback"].includes(input.mode)) fail("INVALID_RELEASE_MODE");
  requireValue(input.expectedDeployment, uuidPattern, "EXPECTED_DEPLOYMENT_REQUIRED");
  const evidence = {
    schema: evidenceKind, operation: input.mode, status: "preflight",
    source_commit_sha: null, source_sha_attestation: false,
    workflow: input.workflow, started_at: new Date().toISOString()
  };
  let baseline;
  let target;
  let switchAttempted = false;
  let verified = false;
  const persist = () => save(evidence);
  try {
    baseline = await snapshot(cf);
    if (baseline.deployment.id !== input.expectedDeployment) fail("STALE_EXPECTED_DEPLOYMENT");
    evidence.before = deploymentEvidence(baseline.deployment);
    evidence.rollback_version_id = baseline.version.id;
    evidence.binding_names = bindingContract(baseline.version).bindings.map(({ name, type }) => ({ name, type }));
    evidence.crons = baseline.schedules.schedules.map(({ cron }) => cron);
    evidence.version_annotation = annotationEvidence(baseline.version.annotations);
    await persist(); // Persist rollback anchor before any upload/switch.
    try { evidence.preflight_checks = await probe(); }
    catch {
      // Recovery must still work when the currently deployed application is broken.
      if (input.mode !== "rollback" || input.dryRun) fail("PREFLIGHT_HEALTH_FAILED");
      evidence.preflight_health = "failed; explicit rollback continues";
    }
    if (input.mode === "rollback") {
      requireValue(input.versionId, uuidPattern, "ROLLBACK_VERSION_REQUIRED");
      requireValue(input.historicalDeployment, uuidPattern, "HISTORICAL_DEPLOYMENT_REQUIRED");
      const historical = await cf(`/deployments/${input.historicalDeployment}`);
      if (historical.versions?.length !== 1 || historical.versions[0].version_id !== input.versionId ||
          historical.versions[0].percentage !== 100) fail("VERSION_NOT_IN_KNOWN_DEPLOYMENT");
      target = await cf(`/versions/${input.versionId}`);
      if (target.id !== input.versionId) fail("VERSION_ID_MISMATCH");
      sameContract(baseline.version, target);
      evidence.target_version_id = target.id;
      evidence.target_annotation = annotationEvidence(target.annotations);
      evidence.historical_deployment_id = input.historicalDeployment;
    } else if (input.mode !== "inspect") {
      requireValue(input.sourceSha, shaPattern, "SOURCE_SHA_REQUIRED");
      evidence.artifact = await deps.verify(input.sourceSha);
      unchanged(baseline, await snapshot(cf));
      const versionId = await upload(input.sourceSha);
      requireValue(versionId, uuidPattern, "UPLOAD_VERSION_ID_MISSING");
      evidence.target_version_id = versionId;
      evidence.source_commit_sha = input.sourceSha;
      await persist();
      target = await cf(`/versions/${versionId}`);
      if (target.id !== versionId) fail("VERSION_ID_MISMATCH");
      sameContract(baseline.version, target);
      if (target.annotations?.["workers/tag"] !== input.sourceSha ||
          !target.annotations?.["workers/message"]?.includes(`sha=${input.sourceSha}`)) fail("UPLOAD_ANNOTATION_MISMATCH");
      evidence.target_annotation = annotationEvidence(target.annotations);
    }
    unchanged(baseline, await snapshot(cf));
    if (input.mode === "inspect" || input.mode === "upload" || input.dryRun) {
      evidence.status = input.mode === "upload" ? "uploaded_not_deployed" : "read_only_verified";
      evidence.active = deploymentEvidence((await snapshot(cf)).deployment);
      await persist();
      return evidence;
    }
    await persist();
    switchAttempted = true;
    const deployment = await cf("/deployments", {
      strategy: "percentage", versions: [{ version_id: target.id, percentage: 100 }],
      annotations: { "workers/message": `${input.mode} run=${input.workflow.run_id} sha=${evidence.source_commit_sha ?? "unknown"}` }
    });
    requireValue(deployment.id, uuidPattern, "DEPLOYMENT_ID_MISSING");
    evidence.deployment = deploymentEvidence(deployment);
    await persist();
    const active = await snapshot(cf);
    unchanged(baseline, active, deployment.id);
    if (active.version.id !== target.id) fail("ACTIVE_VERSION_MISMATCH");
    evidence.postflight_checks = await probe();
    const final = await snapshot(cf);
    unchanged(baseline, final, deployment.id);
    if (final.version.id !== target.id) fail("ACTIVE_VERSION_MISMATCH");
    evidence.active = deploymentEvidence(final.deployment);
    verified = true;
    evidence.status = "verified";
    await persist();
    return evidence;
  } catch (error) {
    evidence.status = "failed";
    // Only fixed codes are recorded, never arbitrary provider/build/assertion messages.
    evidence.error_code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "RELEASE_CHECK_FAILED";
    if (switchAttempted && !verified && baseline && target) {
      try {
        const current = await snapshot(cf);
        if (current.version.id === target.id) {
          // Do not overwrite another operator's deployment or force a secret rollback.
          if (evidence.deployment && current.deployment.id !== evidence.deployment.id) fail("RECOVERY_CONCURRENT_DEPLOYMENT");
          if (!evidence.deployment && current.deployment.annotations?.["workers/message"] !==
              `${input.mode} run=${input.workflow.run_id} sha=${evidence.source_commit_sha ?? "unknown"}`) {
            fail("RECOVERY_AMBIGUOUS_DEPLOYMENT");
          }
          unchanged(baseline, current, current.deployment.id);
          const recovery = await cf("/deployments", {
            strategy: "percentage", versions: [{ version_id: baseline.version.id, percentage: 100 }],
            annotations: { "workers/message": `Automatic recovery run=${input.workflow.run_id}` }
          });
          const recovered = await snapshot(cf);
          unchanged(baseline, recovered, recovery.id);
          if (recovered.version.id !== baseline.version.id) fail("RECOVERY_VERSION_MISMATCH");
          evidence.recovery_checks = await probe();
          const afterRecoveryChecks = await snapshot(cf);
          unchanged(baseline, afterRecoveryChecks, recovery.id);
          if (afterRecoveryChecks.version.id !== baseline.version.id) fail("RECOVERY_VERSION_MISMATCH");
          evidence.recovery = deploymentEvidence(afterRecoveryChecks.deployment);
        }
      } catch { evidence.recovery_error = "RECOVERY_NOT_VERIFIED_REQUIRES_OPERATOR"; }
    }
    try { evidence.active = deploymentEvidence((await snapshot(cf)).deployment); }
    catch { evidence.active = null; }
    await persist();
    throw Object.assign(new Error(evidence.error_code), { evidence });
  }
}

async function uploadVersion(env, sha, root) {
  const output = resolve(env.RUNNER_TEMP, `worker-version-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.jsonl`);
  await writeFile(output, "");
  const childEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "RUNNER_TEMP"].filter((key) => env[key]).map((key) => [key, env[key]]));
  Object.assign(childEnv, {
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_OUTPUT_FILE_PATH: output,
    WRANGLER_LOG_PATH: resolve(env.RUNNER_TEMP, "worker-release-private.log")
  });
  const result = spawnSync(process.execPath, [
    resolve("node_modules/wrangler/bin/wrangler.js"), "versions", "upload",
    "--config", resolve(root, "wrangler.json"), "--no-bundle", "--keep-vars",
    "--tag", sha, "--message", `GitHub sha=${sha} run=${env.GITHUB_RUN_ID} attempt=${env.GITHUB_RUN_ATTEMPT}`
  ], { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
  // Wrangler output can contain remote vars; never forward it or upload its log.
  if (result.error || result.status !== 0) fail("WRANGLER_UPLOAD_FAILED");
  const records = (await readFile(output, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const ids = records.filter((entry) => entry.type === "version-upload").map((entry) => entry.version_id);
  if (ids.length !== 1) fail("AMBIGUOUS_UPLOAD_RESULT");
  return ids[0];
}

async function githubRequest(env, path, body) {
  if (!env.GH_TOKEN) fail("GITHUB_EVIDENCE_TOKEN_REQUIRED");
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch { fail("GITHUB_EVIDENCE_REQUEST_FAILED"); }
  if (!response.ok) fail("GITHUB_EVIDENCE_REQUEST_FAILED");
  return response.json();
}

async function publishLedger(env, evidence) {
  if (evidence.operation === "rollback") {
    // Resolve source only from prior workflow evidence, never from Cloudflare annotations.
    for (let page = 1; page <= 10; page += 1) {
      const records = await githubRequest(env, `/deployments?environment=production&per_page=100&page=${page}`);
      const match = records.find(({ payload }) => payload?.kind === evidenceKind &&
        payload.cloudflare?.versions?.length === 1 &&
        payload.cloudflare.versions[0].version_id === evidence.target_version_id &&
        payload.cloudflare.versions[0].percentage === 100 &&
        payload.workflow?.repository === repository &&
        shaPattern.test(payload.source_commit_sha ?? ""));
      if (match) {
        evidence.source_commit_sha = match.payload.source_commit_sha;
        evidence.source_evidence_github_deployment_id = match.id;
        break;
      }
      if (records.length < 100) break;
    }
  }
  const sourceSha = evidence.source_commit_sha;
  // ref is a control SHA for legacy rollbacks, never a claimed production SHA.
  const record = await githubRequest(env, "/deployments", {
    ref: sourceSha ?? env.GITHUB_SHA, auto_merge: false, required_contexts: [],
    environment: "production", description: "Verified Cloudflare Worker deployment",
    production_environment: true, transient_environment: false,
    payload: { kind: evidenceKind, source_commit_sha: sourceSha, source_sha_attestation: false,
      cloudflare: evidence.active, workflow: evidence.workflow, operation: evidence.operation }
  });
  evidence.github_deployment_id = record.id;
  await githubRequest(env, `/deployments/${record.id}/statuses`, {
    state: "success", auto_inactive: false, log_url: evidence.workflow.url,
    description: "Cloudflare version and 100% traffic verified; read-only HTTP checks passed"
  });
}

async function main(env) {
  validateMutationContext(env);
  const workflow = {
    repository, control_sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    url: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
  };
  const directory = resolve("artifacts/worker-release");
  await mkdir(directory, { recursive: true });
  const save = async (evidence) => {
    await writeFile(resolve(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  };
  const evidence = await executeRelease({
    mode: env.RELEASE_MODE, sourceSha: env.SOURCE_SHA,
    expectedDeployment: env.EXPECTED_DEPLOYMENT_ID,
    versionId: env.ROLLBACK_VERSION_ID, historicalDeployment: env.HISTORICAL_DEPLOYMENT_ID,
    dryRun: env.ROLLBACK_DRY_RUN === "true", workflow
  }, {
    cf: cloudflareClient(env), probe: healthProbe(env), save,
    verify: (sha) => verifyArtifact(resolve("release-payload"), sha),
    upload: (sha) => uploadVersion(env, sha, resolve("release-payload"))
  });
  if (evidence.status === "verified") {
    try { await publishLedger(env, evidence); }
    catch {
      evidence.ledger_error = "GITHUB_LEDGER_FAILED_SEE_ACTIONS_ARTIFACT";
      await save(evidence);
      fail("GITHUB_LEDGER_FAILED_SEE_ACTIONS_ARTIFACT");
    }
  }
  await save(evidence);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `Worker release: **${evidence.status}**\n\nSource commit: ${evidence.source_commit_sha ?? "unknown (legacy version; see annotation evidence)"}\n\nActive deployment: ${evidence.active?.id ?? "unknown"}\n\nSee the sanitized worker-release evidence artifact for version, traffic, timestamps and workflow provenance.\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env).catch((error) => {
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "RELEASE_FAILED");
    process.exitCode = 1;
  });
}
