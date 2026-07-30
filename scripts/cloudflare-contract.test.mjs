import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function collectRuntimeSources(directory, label) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryLabel = `${label}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entryLabel === "src/modules/diagnostics") {
        continue;
      }
      files.push(
        ...(await collectRuntimeSources(new URL(`${entry.name}/`, directory), entryLabel))
      );
    } else if (/\.(?:mjs|ts|tsx)$/.test(entry.name)) {
      files.push({ label: entryLabel, url: new URL(entry.name, directory) });
    }
  }
  return files;
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const openNext = await readFile(new URL("../open-next.config.ts", import.meta.url), "utf8");
const nextConfig = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
const typegenRunner = await readFile(
  new URL("./run-cloudflare-typegen.mjs", import.meta.url),
  "utf8"
);
const postgresSchema = await readFile(
  new URL("../prisma/postgresql/schema.prisma", import.meta.url),
  "utf8"
);
const previewWorkflow = await readFile(
  new URL("../.github/workflows/cloudflare-preview.yml", import.meta.url),
  "utf8"
);
const previewSmoke = await readFile(
  new URL("./cloudflare-preview-smoke.mjs", import.meta.url),
  "utf8"
);
const artifactContract = await readFile(
  new URL("./cloudflare-artifact-contract.mjs", import.meta.url),
  "utf8"
);
const openNextRunner = await readFile(
  new URL("./run-opennext.mjs", import.meta.url),
  "utf8"
);
const prismaEnginePruner = await readFile(
  new URL("./prune-opennext-prisma-engines.mjs", import.meta.url),
  "utf8"
);

test("Cloudflare scripts preserve the existing local commands", () => {
  assert.equal(packageJson.scripts.dev, "next dev");
  assert.equal(packageJson.scripts.build, "node scripts/build.mjs");
  assert.equal(packageJson.scripts["cf:build"], "node scripts/run-opennext.mjs build");
  assert.match(packageJson.scripts["cf:preview"], /run-opennext\.mjs preview/);
  assert.match(packageJson.scripts["cf:deploy"], /--keep-vars/);
  assert.match(packageJson.scripts["cf:typegen"], /run-cloudflare-typegen\.mjs/);
  assert.match(typegenRunner, /wranglerCli/);
  assert.match(typegenRunner, /"types"/);
  assert.match(packageJson.scripts["prisma:worker:generate"], /workerClient/);
});

test("Wrangler targets a protected OpenNext Worker", () => {
  assert.match(wrangler, /"name"\s*:\s*"daily-paper"/);
  assert.match(wrangler, /"main"\s*:\s*"\.open-next\/worker\.js"/);
  assert.match(wrangler, /"nodejs_compat"/);
  assert.match(wrangler, /"workers_dev"\s*:\s*true/);
  assert.match(wrangler, /"preview_urls"\s*:\s*false/);
  assert.match(wrangler, /"run_worker_first"\s*:\s*true/);
  assert.match(wrangler, /"DEPLOYMENT_MODE"\s*:\s*"cloud"/);
  assert.match(wrangler, /"NEXT_PUBLIC_DEPLOYMENT_MODE"\s*:\s*"cloud"/);
  assert.doesNotMatch(wrangler, /DATABASE_URL|ZOTERO_KEY|LLM_API_KEY|@126\.com/);
  assert.doesNotMatch(wrangler, /ACCESS_JWT_LOCAL_PREVIEW_BYPASS/);
});

test("Worker build selects the OpenNext-patchable Neon client without replacing Node clients", () => {
  const workerGenerator = postgresSchema.match(/generator workerClient\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.doesNotMatch(workerGenerator, /output\s*=/);
  assert.doesNotMatch(workerGenerator, /engineType\s*=/);
  assert.match(nextConfig, /edge-application-client\.ts/);
  assert.match(nextConfig, /edge-application-json\.ts/);
  assert.match(nextConfig, /serverExternalPackages:\s*\["@prisma\/client",\s*"\.prisma\/client"\]/);
  assert.equal(packageJson.scripts["prisma:cloud:generate"].includes("--generator client"), true);
});

test("Worker database modules use the OpenNext-patchable Prisma package", async () => {
  const edgeClient = await readFile(
    new URL("../src/db/prisma/edge-application-client.ts", import.meta.url),
    "utf8"
  );
  const edgeJson = await readFile(
    new URL("../src/db/prisma/edge-application-json.ts", import.meta.url),
    "utf8"
  );
  assert.match(edgeClient, /from\s+["']@prisma\/client["']/);
  assert.match(edgeJson, /from\s+["']@prisma\/client["']/);
  assert.doesNotMatch(edgeClient + edgeJson, /prisma-postgresql-worker/);
});

test("Cloud-disabled operations declare an application capability guard", async () => {
  const routes = [
    "../src/app/api/jobs/daily/route.ts",
    "../src/app/api/jobs/mvp-flow/route.ts",
    "../src/app/api/jobs/monthly-reminder/route.ts",
    "../src/app/api/obsidian/export/daily/route.ts",
    "../src/app/api/ingestion/runs/route.ts",
    "../src/app/api/ingestion/dedup/route.ts",
    "../src/app/api/ingestion/enrichment/route.ts",
    "../src/app/api/ranking/recall/route.ts",
    "../src/app/api/ranking/rerank/route.ts",
    "../src/app/api/profile/refresh/route.ts",
    "../src/app/api/profile/snapshot/route.ts",
    "../src/app/api/profile/reminder/route.ts",
    "../src/app/api/zotero/sync/route.ts",
    "../src/app/api/zotero/tags/backfill/route.ts",
    "../src/app/api/zotero/tags/parse/route.ts",
    "../src/app/api/journals/pool/bootstrap/route.ts",
    "../src/app/api/journals/pool/health/route.ts"
  ];
  for (const route of routes) {
    assert.match(await readFile(new URL(route, import.meta.url), "utf8"), /rejectCloudCapability/);
  }
});

test("health and mutation boundaries are explicit", async () => {
  const live = await readFile(new URL("../src/app/api/health/live/route.ts", import.meta.url), "utf8");
  const ready = await readFile(new URL("../src/app/api/health/ready/route.ts", import.meta.url), "utf8");
  const boundary = await readFile(new URL("../src/lib/http/cloud-boundary.ts", import.meta.url), "utf8");
  assert.doesNotMatch(live, /DATABASE_URL|getEnv|Prisma|queryRaw/);
  assert.match(ready, /SELECT 1/);
  assert.match(boundary, /content-type/);
  assert.match(boundary, /origin/);
  assert.doesNotMatch(boundary, /Access-Control-Allow-Origin/);
});

test("OpenNext uses the Cloudflare adapter without Pages", () => {
  assert.match(openNext, /defineCloudflareConfig/);
  assert.doesNotMatch(openNext + wrangler, /next-on-pages|Cloudflare Pages/i);
});

test("Linux workerd preview is exercised without production secrets", () => {
  assert.match(previewWorkflow, /runs-on: ubuntu-latest/);
  assert.match(previewWorkflow, /actions\/checkout@v7/);
  assert.match(previewWorkflow, /actions\/setup-node@v7/);
  assert.match(previewWorkflow, /actions\/upload-artifact@v7/);
  assert.match(previewWorkflow, /node-version: 22/);
  assert.match(previewWorkflow, /env -u DATABASE_URL npm run cf:build/);
  assert.match(previewWorkflow, /node scripts\/cloudflare-artifact-contract\.mjs/);
  assert.ok(
    previewWorkflow.indexOf("node scripts/cloudflare-artifact-contract.mjs") >
      previewWorkflow.indexOf("env -u DATABASE_URL npm run cf:build"),
    "bundle inspection must run after the OpenNext build"
  );
  assert.ok(
    previewWorkflow.indexOf("wrangler dev --local") >
      previewWorkflow.indexOf("node scripts/cloudflare-artifact-contract.mjs"),
    "workerd must not start until the generated bundle passes inspection"
  );
  assert.match(previewWorkflow, /wrangler dev --local --port 8787/);
  assert.match(previewWorkflow, /TEAM_DOMAIN:https:\/\/ci\.cloudflareaccess\.com/);
  assert.match(previewWorkflow, /POLICY_AUD:ci-audience/);
  assert.match(previewWorkflow, /ACCESS_ALLOWED_EMAIL:ci-user@example\.invalid/);
  assert.doesNotMatch(previewWorkflow, /ACCESS_JWT_LOCAL_PREVIEW_BYPASS/);
  assert.match(previewWorkflow, /cloudflare-preview-smoke\.mjs/);
  assert.match(previewWorkflow, /cloudflare-worker-\$\{\{ github\.sha \}\}/);
  assert.match(previewWorkflow, /retention-days:\s*1/);
  assert.doesNotMatch(previewWorkflow, /secrets\./);
  assert.match(previewSmoke, /ACCESS_TOKEN_REQUIRED/);
  assert.match(previewSmoke, /api\/health\/live/);
  assert.match(previewSmoke, /cache-control/);
  assert.match(artifactContract, /Missing \.open-next artifact/);
  assert.match(artifactContract, /query_engine\|libquery_engine/);
  assert.match(artifactContract, /query_compiler_bg\\\.wasm/);
  assert.match(openNextRunner, /pruneOpenNextNativePrismaEngines/);
  assert.match(prismaEnginePruner, /node_modules\\\/\\\.prisma\\\/client/);
  assert.match(prismaEnginePruner, /unlink\(file\)/);
  assert.match(artifactContract, /PRIVATE KEY/);
  assert.match(artifactContract, /credentialed PostgreSQL URL/);
});

test("Cloud dashboard and APIs validate Access JWTs in the Worker", async () => {
  const middleware = await readFile(new URL("../src/middleware.ts", import.meta.url), "utf8");
  const verifier = await readFile(
    new URL("../src/lib/http/cloudflare-access.ts", import.meta.url),
    "utf8"
  );
  assert.match(middleware, /\/api\/health\/live/);
  assert.match(middleware, /verifyCloudflareAccess/);
  assert.match(verifier, /cf-access-jwt-assertion/i);
  assert.match(verifier, /createRemoteJWKSet/);
  assert.match(verifier, /issuer: input\.teamDomain/);
  assert.match(verifier, /audience: input\.audience/);
  assert.match(verifier, /ACCESS_ALLOWED_EMAIL/);
});

test("source-ranking diagnostics stay outside the Worker runtime graph", async () => {
  const runtimeSources = (
    await Promise.all([
      collectRuntimeSources(new URL("../src/app/", import.meta.url), "src/app"),
      collectRuntimeSources(new URL("../src/jobs/", import.meta.url), "src/jobs"),
      collectRuntimeSources(new URL("../src/modules/", import.meta.url), "src/modules")
    ])
  ).flat();
  runtimeSources.push({
    label: "src/middleware.ts",
    url: new URL("../src/middleware.ts", import.meta.url)
  });

  const forbidden = /diagnostics\/source-ranking|source-ranking-audit/;
  const imports = [];
  for (const source of runtimeSources) {
    if (forbidden.test(await readFile(source.url, "utf8"))) {
      imports.push(source.label);
    }
  }

  assert.deepEqual(imports, []);
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), forbidden);
});
