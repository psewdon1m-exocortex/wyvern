import { randomUUID } from "node:crypto";

const secretKey = /authorization|cookie|password|passwd|secret|credential|apikey|accesstoken|refreshtoken|privatekey|clienttoken/;
const secretValue = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+\S+|\bAIza[\w-]{20,}|\bgh[pousr]_[\w]{20,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i;

// Used by every structured output boundary, including nested future metadata.
// Request/provider bodies and headers are deliberately not accepted by logEvent.
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === "string") return secretValue.test(value) ? "[REDACTED]" : value.slice(0, 512);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value || typeof value !== "object") return null;
  if (depth >= 6 || seen.has(value)) return "[TRUNCATED]";
  seen.add(value);
  const output = Array.isArray(value)
    ? value.slice(0, 32).map(item => redact(item, depth + 1, seen))
    : Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [key.slice(0, 80),
      secretKey.test(key.toLowerCase().replace(/[^a-z]/g, "")) || /^(token|key)$/i.test(key)
        ? "[REDACTED]" : redact(item, depth + 1, seen)]));
  seen.delete(value);
  return output;
}

export function logEvent(event, clock = () => Date.now()) {
  const allowed = ["event", "request_id", "client_id", "actor", "adapter_id", "profile", "generation", "attempt", "status",
    "duration_ms", "input_tokens", "output_tokens", "http_status", "route", "enabled"];
  const metadata = Object.fromEntries(Object.entries(event).filter(([key, value]) => allowed.includes(key)
    && (value === null || ["string", "number", "boolean"].includes(typeof value))));
  return redact({ id: randomUUID(), at: new Date(clock()).toISOString(), service: "wyvern",
    severity: event.http_status >= 500 ? "error" : event.http_status >= 400 ? "warning" : "info", ...metadata });
}
