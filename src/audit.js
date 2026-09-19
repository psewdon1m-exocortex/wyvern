import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fault } from "./errors.js";
import { logEvent } from "./observability.js";

const allowed = new Set(["config_activated", "drain_changed", "authentication_failed", "authorization_failed",
  "request_failed", "bindings_change_requested", "bindings_changed", "media_uploaded", "media_deleted"]);
const files = ["operator.jsonl", "operator.previous.jsonl"];
export class Audit {
  #tail = Promise.resolve();
  #queued = 0;
  #nextPrune = -Infinity;
  #count = 0;
  constructor(directory, { maxBytes = 524288, maxPending = 128, maxRecords = 5000, maxAgeMs = 30 * 86400000,
    clock = () => Date.now() } = {}) {
    if (![maxBytes, maxPending, maxRecords, maxAgeMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("invalid_audit_limits");
    Object.assign(this, { directory, maxBytes, maxPending, maxRecords, maxAgeMs, clock });
  }
  async #enqueue(run) {
    if (this.#queued >= this.maxPending) fault("audit_unavailable", 503);
    this.#queued++;
    const work = this.#tail.then(run);
    this.#tail = work.catch(() => {});
    try { return await work; } catch { fault("audit_unavailable", 503); } finally { this.#queued--; }
  }
  async #read(file) {
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > this.maxBytes || process.platform !== "win32" && (info.mode & 0o077)) throw new Error("invalid_audit_file");
      return await handle.readFile("utf8");
    } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
    finally { await handle?.close(); }
  }
  async #prune() {
    if (this.clock() < this.#nextPrune) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.directory)).isDirectory()) throw new Error("invalid_audit_directory");
    for (const name of files) {
      const file = path.join(this.directory, name), body = await this.#read(file);
      const rows = body.split("\n").filter(Boolean).map(line => {
        const row = JSON.parse(line), at = Date.parse(row.at);
        if (!Number.isFinite(at)) throw new Error("invalid_audit_timestamp");
        return { line, at };
      });
      const retained = rows.filter(row => row.at > this.clock() - this.maxAgeMs).slice(-this.maxRecords);
      if (name === files[0]) this.#count = retained.length;
      if (retained.length !== rows.length) {
        if (!retained.length) { await fs.rm(file, { force: true }); continue; }
        const temporary = file + ".pending";
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0), 0o600);
        try { await handle.writeFile(retained.map(row => row.line).join("\n") + "\n"); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, file);
      }
    }
    this.#nextPrune = this.clock() + Math.min(60000, this.maxAgeMs);
  }
  prune() { return this.#enqueue(() => this.#prune()); }
  async record(event, metadata = {}) {
    if (!allowed.has(event)) fault("audit_unavailable", 503);
    const details = {};
    if (event === "config_activated") {
      if (!/^[a-f0-9]{64}$/.test(metadata.generation)) fault("audit_unavailable", 503);
      details.actor = "configuration_loader"; details.generation = metadata.generation;
    } else if (event === "drain_changed") {
      if (typeof metadata.enabled !== "boolean") fault("audit_unavailable", 503);
      details.actor = "local_operator"; details.enabled = metadata.enabled;
    } else {
      for (const name of ["request_id", "client_id", "status", "route", "http_status"]) {
        if (metadata[name] !== undefined) details[name] = metadata[name];
      }
      details.actor = metadata.client_id ?? null;
    }
    const line = JSON.stringify(logEvent({ ...details, event }, this.clock)) + "\n";
    if (Buffer.byteLength(line) > this.maxBytes) fault("audit_unavailable", 503);
    return this.#enqueue(async () => {
      await this.#prune();
      const file = path.join(this.directory, files[0]);
      let info;
      try { info = await fs.lstat(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (info && (!info.isFile() || process.platform !== "win32" && (info.mode & 0o077))) throw new Error("invalid_audit_file");
      if (info && (info.size + Buffer.byteLength(line) > this.maxBytes || this.#count >= this.maxRecords)) {
        const previous = path.join(this.directory, files[1]);
        await fs.rm(previous, { force: true });
        await fs.rename(file, previous);
        this.#count = 0;
      }
      const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
      try { await handle.writeFile(line); await handle.sync(); this.#count++; } finally { await handle.close(); }
    });
  }
  flush() { return this.#tail; }
}
