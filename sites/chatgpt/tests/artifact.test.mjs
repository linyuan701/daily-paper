import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyArtifact } from "../scripts/verify-package.mjs";

test("built package has server-only credentials and no database bindings", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.equal(verifyArtifact(root).status, "ok");
});
test("artifact scan rejects leaked browser headers and actual secret values anywhere", () => {
  const root = mkdtempSync(path.join(tmpdir(), "daily-paper-artifact-fixture-"));
  try {
    for (const part of ["client", "server", ".openai"]) mkdirSync(path.join(root, "dist", part), { recursive: true });
    writeFileSync(path.join(root, "dist/.openai/hosting.json"), JSON.stringify({ project_id: "fixture", d1: null, r2: null }));
    const client = path.join(root, "dist/client/app.js"), server = path.join(root, "dist/server/index.js");
    writeFileSync(server, "export default {fetch(){}};");
    writeFileSync(client, "CF-Access-Client-Secret");
    assert.throws(() => verifyArtifact(root), /Server-only marker/);
    writeFileSync(client, "console.log('safe')");
    writeFileSync(server, "export default {value:'fixture-private-value'};");
    assert.throws(() => verifyArtifact(root, ["fixture-private-value"]), /Secret value/);
  } finally {
    // mkdtempSync returns this test's own absolute, disposable directory.
    assert.ok(path.dirname(root) === path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("daily-paper-artifact-fixture-"));
    rmSync(root, { recursive: true, force: true });
  }
});
