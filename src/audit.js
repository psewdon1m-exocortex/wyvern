import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fault } from "./errors.js";

// Fixed metadata only. The audit is diagnostic, never a credential/config backup.
const allowed = new Set(["config_activated", "drain_changed"]);
export class Audit {
  #tail = Promise.resolve();
  #queued = 0;
  constructor(directory, { maxBytes = 524288, maxPending = 128 } = {}) {
    this.directory = directory; this.maxBytes = maxBytes; this.maxPending = maxPending;
  }
  async record(event, metadata = {}) {
    if (!allowed.has(event) || this.#queued >= this.maxPending) fault("audit_unavailable", 503);
    const entry = { at: new Date().toISOString(), event, actor: "local_operator" };
    if (event === "config_activated") {
      if (!/^[a-f0-9]{64}$/.test(metadata.generation)) fault("audit_unavailable", 503);
      entry.actor = "configuration_loader"; entry.generation = metadata.generation;
    } else {
      if (typeof metadata.enabled !== "boolean") fault("audit_unavailable", 503);
      entry.enabled = metadata.enabled;
    }
    const line = JSON.stringify(entry) + "\n";
    this.#queued++;
    const work = this.#tail.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, "operator.jsonl");
      let info;
      try { info = await fs.lstat(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (info && (!info.isFile() || process.platform !== "win32" && (info.mode & 0o077))) throw new Error("invalid_audit_file");
      if (info && info.size + Buffer.byteLength(line) > this.maxBytes) {
        const previous = path.join(this.directory, "operator.previous.jsonl");
        // Windows rename does not replace an existing destination.
        await fs.rm(previous, { force: true });
        await fs.rename(file, previous);
      }
      const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
      try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    });
    this.#tail = work.catch(() => {});
    try { await work; } catch { fault("audit_unavailable", 503); } finally { this.#queued--; }
  }
  flush() { return this.#tail; }
}
