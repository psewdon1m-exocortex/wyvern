// Explicit maintenance action; release builds never import sibling checkouts.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const target = process.argv[2];
if (!target || !path.isAbsolute(target)) throw new Error("Pass the absolute consumer contract directory");
await fs.mkdir(target, { recursive: true });
const hashes = {};
for (const file of ["config.js", "util.js", "errors.js"]) {
  const body = await fs.readFile(path.join(source, file));
  hashes[file] = createHash("sha256").update(body).digest("hex");
  await fs.writeFile(path.join(target, file), body);
}
await fs.writeFile(path.join(target, "manifest.json"), JSON.stringify({ schema: "exocortex.wyvern.vendored-contract.v1", config_schema: "exocortex.wyvern.config.v1", files: hashes }, null, 2) + "\n");
