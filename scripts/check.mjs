import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

async function check(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) await check(filename);
    else if (/\.m?js$/.test(item.name)) {
      const result = spawnSync(process.execPath, ["--check", filename], { stdio: "inherit" });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const directory of ["src", "bin", "tests", "scripts"]) await check(directory);
