import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(process.argv[2] || ".");
const files = dir => readdirSync(dir).flatMap(name => { const p = path.join(dir, name); return statSync(p).isDirectory() ? files(p) : [p]; });
assert.ok(existsSync(path.join(root, "dist/server/index.js")), "Missing Worker entrypoint");
const hosting = JSON.parse(readFileSync(path.join(root, "dist/.openai/hosting.json"), "utf8"));
assert.ok(hosting.project_id && !hosting.d1 && !hosting.r2 && !hosting.static, "Expected existing server-backed Site without DB bindings");
const assets = files(path.join(root, "dist/client"));
assert.ok(assets.length, "No client build");
for (const file of assets) {
  const source = readFileSync(file, "utf8");
  // The existing setup page intentionally documents environment variable names;
  // names alone are not secrets. Transport headers and secret values are not UI.
  for (const marker of ["CF-Access-Client-Id", "CF-Access-Client-Secret", "SITES_CAPABILITY_GATE_CANARY", "synthetic-secret", "synthetic-canary"]) {
    assert.ok(!source.includes(marker), `Server-only marker in ${path.relative(root, file)}`);
  }
}
console.log(JSON.stringify({ status: "ok", browserAssetsChecked: assets.length, serverEntry: "dist/server/index.js", databaseBindings: false }));
