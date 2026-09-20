// Thin launcher for the installed official Sites packager; not a hosting runtime.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
const [pluginRoot, project, archive] = process.argv.slice(2);
if (!pluginRoot || !project || !archive || ![pluginRoot, project, archive].every(path.isAbsolute)) {
  throw new Error("Usage: node package.mjs ABSOLUTE_SITES_PLUGIN_ROOT ABSOLUTE_SITE_PROJECT ABSOLUTE_ARCHIVE");
}
const helper = path.join(pluginRoot, "scripts", "package-site.mjs");
if (!existsSync(helper)) throw new Error("Official Sites package-site.mjs is unavailable");
const environment = { ...process.env };
if (process.platform === "win32") {
  const found = spawnSync("where.exe", ["git"], { encoding: "utf8" });
  const git = found.stdout?.split(/\r?\n/).find(p => /git\.exe$/i.test(p.trim()));
  if (git) {
    const bashDirectory = path.resolve(path.dirname(git.trim()), "..", "bin");
    if (existsSync(path.join(bashDirectory, "bash.exe"))) environment.PATH = bashDirectory + path.delimiter + process.env.PATH;
  }
}
const result = spawnSync(process.execPath, [helper, project.replaceAll("\\", "/"), archive.replaceAll("\\", "/")], {
  cwd: project, env: environment, stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
