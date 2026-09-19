import { createHash, timingSafeEqual } from "node:crypto";
import { fault } from "./errors.js";

export const ID = /^[a-z][a-z0-9_-]{0,63}$/;
export const KEY = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;
export const HASH = /^[a-f0-9]{64}$/;
export const own = (obj, name) => Object.hasOwn(obj, name);
export const hash = value => createHash("sha256").update(value).digest("hex");
export function equalHash(value, expected) {
  return typeof value === "string" && value.length <= 4096 && HASH.test(expected || "") &&
    timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(expected, "hex"));
}
export function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function fields(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key)))
    fault("invalid_request");
}
export function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function parseJSON(text, code = "invalid_request") {
  try { return JSON.parse(text); } catch { fault(code); }
}
export function endpoint(value, { allowLoopback = false, originOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { fault("configuration_invalid", 503); }
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(allowLoopback && local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash ||
      (originOnly && url.pathname !== "/")) fault("configuration_invalid", 503);
  return url.origin + url.pathname.replace(/\/$/, "");
}
export async function readBody(stream, limit, signal) {
  const chunks = [];
  let size = 0;
  try {
    const source = typeof stream.iterator === "function" ? stream.iterator({ destroyOnReturn: false }) : stream;
    for await (const chunk of source) {
      signal?.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) fault("payload_too_large", 413);
      chunks.push(bytes);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (signal?.aborted) fault("request_cancelled", 499);
    throw error;
  }
}

// Never serializes arbitrary upstream errors, payloads, headers or caller metadata.
export function telemetry(sink, event) {
  const allowed = ["event", "request_id", "client_id", "adapter_id", "profile", "generation", "attempt", "status", "duration_ms", "input_tokens", "output_tokens"];
  const safe = Object.fromEntries(Object.entries(event).filter(([key]) => allowed.includes(key)));
  try { sink?.(safe); } catch { /* telemetry cannot fail a generation */ }
}
