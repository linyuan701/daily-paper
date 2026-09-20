import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const shaPattern = /^[a-f0-9]{40}$/;
export const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function inventory(root) {
  const entries = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), "Artifact symlinks are forbidden");
      if (entry.isDirectory()) await visit(file);
      else {
        assert.ok(entry.isFile(), "Unsupported artifact entry");
        const name = relative(root, file).replaceAll("\\", "/");
        assert.ok(name === "manifest.json" || name === "wrangler.json" ||
          name.startsWith("assets/") || name.startsWith("worker/"), "Unexpected release artifact file");
        assert.ok(!/(?:^|\/)(?:\.env(?:\.|$)|\.dev\.vars|\.wrangler)(?:\/|\.|$)|\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(name),
          "Runtime state or credentials must not enter a release artifact");
        if (name !== "manifest.json") entries[name] = digest(await readFile(file));
      }
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

export function uploadConfig(runtime) {
  assert.equal(runtime.compatibility_date, "2026-07-27", "Review runtime changes separately");
  assert.deepEqual(runtime.compatibility_flags, ["nodejs_compat"]);
  return {
    name: "daily-paper",
    main: "worker/custom-worker.js",
    compatibility_date: runtime.compatibility_date,
    compatibility_flags: runtime.compatibility_flags,
    no_bundle: true,
    find_additional_modules: true,
    rules: [
      { type: "ESModule", globs: ["**/*.js", "**/*.mjs"], fallthrough: true },
      { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }
    ],
    assets: { directory: "assets", binding: "ASSETS", run_worker_first: true },
    // versions upload preserves remote secrets; keep-vars also preserves remote vars.
    keep_vars: true,
    send_metrics: false
  };
}

export async function packArtifact(root, sourceSha, output) {
  assert.match(sourceSha, shaPattern, "A full immutable source SHA is required");
  const runtime = JSON.parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
  assert.equal(runtime.name, "daily-paper");
  assert.equal(runtime.main, "custom-worker.ts");
  assert.equal(runtime.assets.binding, "ASSETS");
  assert.equal(runtime.assets.run_worker_first, true);
  await mkdir(output, { recursive: true });
  await cp(resolve(root, "dist/cloudflare-dry-run"), resolve(output, "worker"), { recursive: true });
  await cp(resolve(root, ".open-next/assets"), resolve(output, "assets"), { recursive: true });
  const config = uploadConfig(runtime);
  await writeFile(resolve(output, "wrangler.json"), JSON.stringify(config, null, 2) + "\n");
  const files = await inventory(output);
  assert.ok(files["worker/custom-worker.js"], "Final Worker bundle is required");
  const manifest = { schema: 1, source_sha: sourceSha, files };
  await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function verifyArtifact(root, expectedSha) {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  assert.match(expectedSha, shaPattern);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.source_sha, expectedSha);
  assert.deepEqual(await inventory(root), manifest.files, "Release artifact integrity mismatch");
  const config = JSON.parse(await readFile(resolve(root, "wrangler.json"), "utf8"));
  assert.deepEqual(config, uploadConfig(config), "Release upload config contains unsupported settings");
  assert.ok(manifest.files["worker/custom-worker.js"]);
  return { source_sha: expectedSha, manifest_sha256: digest(await readFile(resolve(root, "manifest.json"))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "verify") {
    await verifyArtifact(resolve("dist/worker-release"), process.env.SOURCE_SHA);
  } else {
    await packArtifact(process.cwd(), process.env.SOURCE_SHA, resolve("dist/worker-release"));
  }
}
