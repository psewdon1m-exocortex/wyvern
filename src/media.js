import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fault } from "./errors.js";
import { ID, integer } from "./util.js";

export const MEDIA_ID = /^media_[a-f0-9-]{36}$/;
export function mediaKind(mime) {
  if (mime === "application/pdf") return "pdf";
  if (/^image\/(?:png|jpeg|webp|heic|heif)$/.test(mime)) return "image";
  if (/^audio\/(?:wav|mpeg|mp3|aiff|aac|ogg|flac|mp4)$/.test(mime)) return "audio";
  if (/^video\/(?:mp4|mpeg|mov|quicktime|avi|x-flv|webm|wmv|3gpp)$/.test(mime)) return "video";
  fault("unsupported_media_type", 415);
}
const fingerprint = value => createHash("sha256").update(value).digest("hex");

// Only bounded provider identifiers are durable. Upload capabilities, keys,
// input bytes and filesystem paths never enter this ledger.
export class Media {
  constructor({ filename, clock = () => Date.now(), ttl = 3600000 } = {}) {
    this.filename = filename; this.clock = clock; this.ttl = ttl;
    this.records = new Map(); this.pins = new Map(); this.busy = new Set(); this.pending = new Map(); this.writes = Promise.resolve();
  }
  async load() {
    if (!this.filename) return;
    let body;
    try { const stat = await fs.stat(this.filename); if (stat.size > 262144) fault("media_storage_invalid", 503); body = await fs.readFile(this.filename, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const data = JSON.parse(body);
    if (data.schema !== "exocortex.wyvern.media.v1" || !Array.isArray(data.records) || data.records.length > 256) fault("media_storage_invalid", 503);
    for (const row of data.records) {
      if (!MEDIA_ID.test(row.id) || !ID.test(row.client_id) || !ID.test(row.adapter_id) || !ID.test(row.profile) || !/^[a-f0-9]{64}$/.test(row.credential_hash) ||
          !/^files\/[a-z0-9_-]{1,128}$/.test(row.name) || !["PROCESSING", "ACTIVE", "FAILED"].includes(row.state) || !integer(row.expires_at, 1, Number.MAX_SAFE_INTEGER) ||
          !integer(row.size, 1, 512*1024**2) || this.records.has(row.id)) fault("media_storage_invalid", 503);
      mediaKind(row.mime); this.records.set(row.id, row);
    }
  }
  async save() {
    if (!this.filename) return;
    const body = JSON.stringify({ schema: "exocortex.wyvern.media.v1", records: [...this.records.values()] });
    const write = async () => {
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = this.filename + "." + randomUUID();
      try {
        const file = await fs.open(temporary, "wx", 0o600);
        try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
        await fs.rename(temporary, this.filename);
        if (process.platform !== "win32") { const dir = await fs.open(path.dirname(this.filename)); try { await dir.sync(); } finally { await dir.close(); } }
      } finally { await fs.rm(temporary, { force: true }); }
    };
    const pending = this.writes.then(write, write); this.writes = pending.catch(() => {});
    try { await pending; } catch { fault("media_storage_unavailable", 503); }
  }
  record(client, id, { expired = false } = {}) {
    const row = this.records.get(id);
    if (!row || row.client_id !== client || !expired && row.expires_at <= this.clock()) fault("media_expired", 410);
    return row;
  }
  public(row) { return { media_id: row.id, state: row.state.toLowerCase(), mime_type: row.mime, size_bytes: row.size, expires_at: row.expires_at }; }
  compatible(row, operation) {
    if (row.adapter_id !== operation.target.adapter_id || row.profile !== operation.target.profile || row.credential_hash !== fingerprint(operation.context.credential)) fault("media_expired", 410);
    if (!operation.context.profile.capabilities.includes(mediaKind(row.mime))) fault("capability_not_supported", 422);
  }
  async upload(operation, stream, mime, size, driver) {
    const kind = mediaKind(mime), client = operation.client_id;
    if (!integer(size, 1, kind === "pdf" ? 50*1024**2 : 512*1024**2)) fault("payload_too_large", 413);
    if (!operation.context.profile.capabilities.includes(kind)) fault("capability_not_supported", 422);
    const totalPending = [...this.pending.values()].reduce((a,b) => a+b, 0);
    if (totalPending >= 4 || this.records.size + totalPending >= 256 || [...this.records.values()].filter(row => row.client_id === client).length + (this.pending.get(client) ?? 0) >= 16) fault("rate_limited", 429, true);
    this.pending.set(client, (this.pending.get(client) ?? 0) + 1);
    let uploaded;
    try {
      uploaded = await driver.upload(operation.context, stream, mime, size);
      const row = { id: "media_" + randomUUID(), client_id: client, adapter_id: operation.target.adapter_id, profile: operation.target.profile,
        credential_hash: fingerprint(operation.context.credential), name: uploaded.name, state: uploaded.state, mime, size, expires_at: this.clock() + this.ttl };
      this.records.set(row.id, row);
      try { await this.save(); } catch (error) { this.records.delete(row.id); throw error; }
      return this.public(row);
    } catch (error) {
      if (uploaded) { try { await driver.removeFile({ ...operation.context, signal: AbortSignal.timeout(5000) }, uploaded.name); } catch { /* provider expiry is the final bound */ } }
      throw error;
    } finally { const count = this.pending.get(client) - 1; if (count) this.pending.set(client, count); else this.pending.delete(client); }
  }
  async inspect(operation, id, driver, remove = false) {
    const row = this.record(operation.client_id, id, { expired: remove }); this.compatible(row, operation);
    if (this.busy.has(id) || remove && this.pins.has(id)) fault("media_busy", 409, true);
    this.busy.add(id);
    try {
      if (remove) { await driver.removeFile(operation.context, row.name); this.records.delete(id); await this.save(); return { deleted: true }; }
      row.state = (await driver.getFile(operation.context, row.name)).state;
      await this.save(); return this.public(row);
    } finally { this.busy.delete(id); }
  }
  bind(operation) {
    const used = new Set();
    for (const message of operation.context.request.messages) if (Array.isArray(message.content)) for (const part of message.content) if (part.type === "media") {
      const row = this.record(operation.client_id, part.media_id); this.compatible(row, operation);
      if (this.busy.has(row.id)) fault("media_busy", 409, true);
      if (row.state !== "ACTIVE") fault(row.state === "FAILED" ? "media_failed" : "media_processing", row.state === "FAILED" ? 422 : 409, row.state !== "FAILED");
      if (part.video && mediaKind(row.mime) !== "video") fault("invalid_request");
      used.add(row.id);
    }
    for (const id of used) this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    for (const message of operation.context.request.messages) if (Array.isArray(message.content)) message.content = message.content.map(part => {
      if (part.type !== "media") return part;
      const row = this.records.get(part.media_id);
      return { ...part, provider_file: { name: row.name, mime: row.mime } };
    });
    return () => { for (const id of used) { const count = this.pins.get(id) - 1; if (count) this.pins.set(id, count); else this.pins.delete(id); } };
  }
  async reap(contextFor, driver) {
    let remaining = 4;
    for (const [id, row] of this.records) if (remaining > 0 && row.expires_at <= this.clock() && !this.pins.has(id) && !this.busy.has(id)) {
      remaining--;
      this.busy.add(id);
      try {
        const context = contextFor(row.adapter_id);
        if (context && row.credential_hash === fingerprint(context.credential)) {
          try { await driver.removeFile({ ...context, signal: AbortSignal.timeout(5000) }, row.name); } catch { /* provider expires unreachable files */ }
        }
        this.records.delete(id); await this.save();
      } finally { this.busy.delete(id); }
    }
  }
}
