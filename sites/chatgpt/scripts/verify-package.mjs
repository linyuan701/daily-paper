// Runtime secrets are injected by Sites after build; never substitute them here.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
export function verifyArtifact(root, secrets = []) {
  const files = dir => readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
  const hosting = JSON.parse(readFileSync(path.join(root, "dist/.openai/hosting.json"), "utf8"));
  assert.ok(hosting.project_id && !hosting.d1 && !hosting.r2 && !hosting.static, "Server Site without database bindings required");
  const server = readFileSync(path.join(root, "dist/server/index.js"), "utf8");
  assert.ok(server.includes("export default"), "Missing Worker entrypoint");
  const client = files(path.join(root, "dist/client"));
  assert.ok(client.length, "Missing browser assets");
  for (const file of client) {
    const source = readFileSync(file, "utf8");
    for (const marker of ["CF-Access-Client-Id", "CF-Access-Client-Secret", "SITES_CAPABILITY_GATE_CANARY",
      "DAILY_PAPER_ACCESS_CLIENT_SECRET", "DAILY_PAPER_GITHUB_READ_TOKEN"]) {
      assert.ok(!source.includes(marker), `Server-only marker in ${path.relative(root, file)}`);
    }
  }
  // Scan the whole artifact for actual values if a caller supplies them in env.
  // Report only paths, never values or matched substrings.
  for (const file of files(path.join(root, "dist"))) {
    const bytes = readFileSync(file);
    assert.ok(!secrets.filter(Boolean).some(value => bytes.includes(Buffer.from(value))),
      `Secret value in ${path.relative(root, file)}`);
  }
  return { status: "ok", browserAssetsChecked: client.length, databaseBindings: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyArtifact(path.resolve(process.argv[2] || "."), [
    process.env.DAILY_PAPER_ACCESS_CLIENT_ID, process.env.DAILY_PAPER_ACCESS_CLIENT_SECRET,
    process.env.DAILY_PAPER_GITHUB_READ_TOKEN, process.env.SITES_ARTIFACT_SCAN_CANARY
  ])));
}
