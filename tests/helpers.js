import http from "node:http";
import { once } from "node:events";
import { hash } from "../src/util.js";
import { Kernel } from "../src/kernel.js";
import { Runtime } from "../src/runtime.js";
import { createServer } from "../src/server.js";

export const CLIENT_TOKEN = "test-client-one-" + "a".repeat(32);
export const OTHER_TOKEN = "test-client-two-" + "b".repeat(32);
export const KEY = "synthetic-provider-key-" + "c".repeat(32);
export const configKey = "wyvern.config.active";
export const credentialKey = "wyvern.credentials.google";
export function config(origin) {
  return { schema: "exocortex.wyvern.config.v1", instance_id: "host-test", runtime: {},
    adapters: { google: { name: "Google test", driver: "google", endpoint: origin, enabled: true, credential_ref: credentialKey,
      profiles: { default: { model: "gemini-test", capabilities: ["text", "structured_output", "streaming", "token_count"], max_output_tokens: 1000 } } } },
    clients: {
      mastermind: { token_sha256: hash(CLIENT_TOKEN), allowed_adapters: ["google"], enabled: true, bindings: { crusher: { adapter_id: "google", profile: "default" } } },
      laboratory: { token_sha256: hash(OTHER_TOKEN), allowed_adapters: [], enabled: true, bindings: {} },
    } };
}
export const message = (extra = {}) => ({ adapter_id: "google", messages: [{ role: "user", content: "test source" }], ...extra });
export function result(text = "hello", extra = {}) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }, ...extra };
}
export async function listen(server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}
export async function close(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
export async function fixture(t, { provider, mutate, clock, rawProvider = false } = {}) {
  const calls = [], resolveCalls = [], events = [];
  const google = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = rawProvider && !req.headers["content-type"]?.startsWith("application/json") ? bytes : JSON.parse(bytes);
    calls.push({ url: req.url, key: req.headers["x-goog-api-key"], body });
    if (provider) return provider(req, res, body);
    if (req.url.endsWith(":countTokens")) return res.end(JSON.stringify({ totalTokens: 10 }));
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result()));
  });
  const googleOrigin = await listen(google);
  const state = { config: config(googleOrigin), revision: 1, keyRevision: 1, key: KEY, register: "register-one", fail: false };
  mutate?.(state);
  const kernelServer = http.createServer(async (req, res) => {
    if (state.fail) { res.writeHead(503); return res.end(); }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); resolveCalls.push(body);
    if (body.expected_register_revision && body.expected_register_revision !== state.register ||
        body.expected_volt_revisions?.[configKey] && body.expected_volt_revisions[configKey] !== state.revision) {
      res.writeHead(409); return res.end();
    }
    const values = {
      [configKey]: { value: JSON.stringify(state.config), secret: false, volt_revision: state.revision },
      [credentialKey]: { value: state.key, secret: true, volt_revision: state.keyRevision },
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schema: "exocortex.register.resolution.v1", register_revision: state.register,
      values: Object.fromEntries(body.keys.map(key => [key, values[key]])) }));
  });
  const kernelOrigin = await listen(kernelServer);
  const kernel = new Kernel({ origin: kernelOrigin, token: () => "kernel-test", allowLoopback: true });
  const runtime = new Runtime({ kernel, clock, sink: event => events.push(event) });
  try { await runtime.reload(); } catch { /* unconfigured fixtures are supported */ }
  const gateway = createServer(runtime), admin = createServer(runtime, { admin: true });
  const origin = await listen(gateway), adminOrigin = await listen(admin);
  t.after(async () => { await runtime.stop(0); await Promise.all([close(gateway), close(admin), close(kernelServer), close(google)]); });
  const call = async (body = message(), token = CLIENT_TOKEN, path = "/v1/generate", options = {}) => {
    const response = await fetch(origin + path, { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body), ...options });
    return { response, data: await response.json() };
  };
  return { state, runtime, kernel, origin, adminOrigin, calls, resolveCalls, events, call };
}
