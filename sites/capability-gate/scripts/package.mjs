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
// GNU tar treats a Windows drive colon as a remote-host separator. Git Bash
// accepts /c/... paths and converts them for the packager's Node subprocesses.
const bashPath = value => process.platform === "win32"
  ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive) => "/" + drive.toLowerCase() + "/")
  : value;
const result = spawnSync(process.execPath, [helper, bashPath(project), bashPath(archive)], {
  cwd: project, env: environment, stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
