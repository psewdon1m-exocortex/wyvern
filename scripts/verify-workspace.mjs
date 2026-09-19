// Explicit local integration qualification. Independent repository CI does not
// import neighboring sources; invoke only with the integration workspace path.
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Kernel } from "../src/kernel.js";
import { Runtime } from "../src/runtime.js";
import { createServer } from "../src/server.js";
import { config, result, message, listen, close, CLIENT_TOKEN } from "../tests/helpers.js";

const workspace = process.argv[2];
if (!workspace || !path.isAbsolute(workspace)) throw new Error("Pass the absolute local integration workspace path");
const load = file => import(pathToFileURL(path.join(workspace, file)).href);
const { createKernelApp } = await load("kernel/server/app.js");
const { createApp: createVoltApp } = await load("volt/server/app.js");
const { VoltStore } = await load("volt/server/store.js");
const { normalizeEntryPayload } = await load("volt/server/validation.js");
const directory = await mkdtemp(path.join(os.tmpdir(), "wyvern-real-chain-"));
const servers = [], calls = [], events = [];
let vault, kernelApp, runtime;
try {
  const google = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* bounded fixture input */ }
    calls.push(req.headers["x-goog-api-key"]); res.end(JSON.stringify(result("actual Kernel and Volt")));
  }); servers.push(google);
  const origin = await listen(google);
  vault = new VoltStore({ filename: path.join(directory, "vault.sqlite"), masterKey: randomBytes(32) });
  const providerPayload = value => normalizeEntryPayload({ title: "Synthetic provider credential", fields: [{ key: "api_key", value, visibility: "secret" }] });
  const secret = vault.createEntry(providerPayload("integration-secret-one"));
  const cfg = config(origin);
  const bundle = vault.createEntry(normalizeEntryPayload({ title: "Wyvern test config", fields: [{ key: "bundle", value: JSON.stringify(cfg), visibility: "plain" }] }));
  const brokerToken = "broker-" + randomBytes(24).toString("hex");
  const voltApp = createVoltApp({ store: vault, sessionKey: randomBytes(32), accessKey: "synthetic-owner", kernelToken: brokerToken });
  const voltServer = http.createServer(voltApp); servers.push(voltServer);
  const voltOrigin = await listen(voltServer);
  const legacy = "legacy-" + randomBytes(24).toString("hex"), scoped = "scoped-" + randomBytes(24).toString("hex");
  kernelApp = createKernelApp({ dataDir: path.join(directory, "kernel"), defaultsDir: path.join(workspace, "kernel/data/defaults"), distDir: path.join(directory, "missing"),
    accessKey: "synthetic-owner", sessionSecret: "s".repeat(40), apiToken: legacy, diskPath: directory,
    // Use the real Volt HTTP client without requiring service-discovery seed data.
    voltClient: (await load("kernel/server/volt-client.js")).createVoltClient({ baseUrl: voltOrigin, token: brokerToken }),
    serviceStatusFetch: async () => { throw new Error("isolated fixture"); } });
  const store = kernelApp.locals.kernel.store;
  store.upsertRegisterEntries([
    { key: "wyvern.config.active", value: `volt://${bundle.id}/1`, description: "config" },
    { key: "wyvern.credentials.google", value: `volt://${secret.id}/1`, description: "credential" },
  ], "fixture", { replace: true });
  store.setSetting("machine_principals_v1", JSON.stringify([{ id: "wyvern", token_sha256: createHash("sha256").update(scoped).digest("hex"),
    allowed_keys: ["wyvern.config.active", "wyvern.credentials.google"], enabled: true }]));
  const kernelServer = http.createServer(kernelApp); servers.push(kernelServer);
  const kernelOrigin = await listen(kernelServer);
  const kernel = new Kernel({ origin: kernelOrigin, token: () => scoped, allowLoopback: true });
  runtime = new Runtime({ kernel, sink: event => events.push(event) }); await runtime.reload();
  const gateway = createServer(runtime); servers.push(gateway); const gatewayOrigin = await listen(gateway);
  const generate = async () => {
    const response = await fetch(gatewayOrigin + "/v1/generate", { method: "POST", headers: { Authorization: "Bearer " + CLIENT_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(message()) });
    assert.equal(response.status, 200); return response.json();
  };
  const one = await generate(); assert.equal(calls.at(-1), "integration-secret-one");
  const revision = runtime.status().register_revision;
  vault.updateEntry(secret.id, providerPayload("integration-secret-two"), { expectedRevision: 1 });
  await runtime.reload(); const two = await generate();
  assert.equal(calls.at(-1), "integration-secret-two"); assert.notEqual(one.config_generation, two.config_generation);
  assert.equal(runtime.status().register_revision, revision);
  const forbidden = await fetch(kernelOrigin + "/api/v1/register/resolve", { method: "POST", headers: { Authorization: "Bearer " + legacy, "Content-Type": "application/json" }, body: JSON.stringify({ keys: ["wyvern.credentials.google"] }) });
  assert.equal(forbidden.status, 403);
  assert.doesNotMatch(JSON.stringify([one, two, events, store.exportAudit()]), /integration-secret-(one|two)/);
  process.stdout.write(JSON.stringify({ schema: "exocortex.wyvern.integration-evidence.v1", result: "PASS", transport: "HTTP", real_components: ["Wyvern", "Kernel", "Volt"], simulated: ["Google API"], generation_requests: calls.length, rotation_without_register_change: true, legacy_secret_denied: true }) + "\n");
} finally {
  await runtime?.stop(0); for (const server of servers.reverse()) await close(server);
  kernelApp?.locals.kernel.close(); vault?.close(); await rm(directory, { recursive: true, force: true });
}
