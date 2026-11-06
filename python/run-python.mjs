import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configured = process.env.AVE_PYTHON_PATH?.trim();
const localVenv = process.platform === "win32"
  ? path.join(projectRoot, ".venv", "Scripts", "python.exe")
  : path.join(projectRoot, ".venv", "bin", "python");
const executable = configured || (existsSync(localVenv) ? localVenv : "python");
const result = spawnSync(executable, process.argv.slice(2), {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true
});

if (result.error) {
  process.stderr.write(`Could not start Python (${executable}): ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
