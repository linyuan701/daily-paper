import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "dist/server");
await mkdir(output, { recursive: true });
await mkdir(join(root, "dist/.openai"), { recursive: true });
await mkdir(join(root, "dist/client"), { recursive: true });
const assets = {};
for (const [name, type] of Object.entries({
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "contracts.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "favicon.svg": "image/svg+xml",
})) {
  assets[`/${name}`] = {
    type,
    body: await readFile(join(root, "public", name), "utf8"),
  };
  await copyFile(join(root, "public", name), join(root, "dist/client", name));
}
const proxySource = await readFile(join(root, "src/proxy.mjs"), "utf8");
const workerSource = (
  await readFile(join(root, "src/worker.mjs"), "utf8")
).replace(/^import .* from "\.\/(?:proxy|assets)\.mjs";\r?\n/gm, "");
await writeFile(
  join(output, "index.js"),
  `const assets = ${JSON.stringify(assets)};\n${proxySource}\n${workerSource}`,
);
// Remove only obsolete generated module files at fixed paths inside this output.
await rm(join(output, "assets.mjs"), { force: true });
await rm(join(output, "proxy.mjs"), { force: true });
await copyFile(
  join(root, ".openai/hosting.json"),
  join(root, "dist/.openai/hosting.json"),
);
console.log("Built Cloudflare ESM Worker. No database or secrets included.");
