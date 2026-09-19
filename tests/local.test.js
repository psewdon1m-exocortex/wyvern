import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, stat, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "../src/server.js";
import { localRequest } from "../src/local-client.js";
import { Runtime } from "../src/runtime.js";
import { secretFile, listenLocal } from "../bin/wyvern.js";
import { Audit } from "../src/audit.js";

test("CLI emits a versioned JSON result and never echoes an unknown secret argument", () => {
  const version = spawnSync(process.execPath, ["bin/wyvern.js", "version", "--json"], { encoding: "utf8" });
  assert.equal(version.status, 0); assert.equal(JSON.parse(version.stdout).version, "0.0.1");
  const wrong = spawnSync(process.execPath, ["bin/wyvern.js", "--api-key=do-not-echo"], { encoding: "utf8" });
  assert.equal(wrong.status, 1); assert.doesNotMatch(wrong.stderr + wrong.stdout, /do-not-echo/);
});

test("failed second socket bind releases only the socket acquired by this process", { skip: process.platform === "win32" }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wyvern-bind-"));
  const existingRuntime = new Runtime({ kernel: {} });
  const existing = createServer(existingRuntime, { admin: true });
  const adminPath = path.join(dir, "admin.sock"), dataPath = path.join(dir, "data", "client.sock");
  existing.listen(adminPath); await once(existing, "listening");
  t.after(async () => { await new Promise(resolve => existing.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const runtime = new Runtime({ kernel: {} });
  await assert.rejects(listenLocal(runtime, dataPath, adminPath));
  assert.equal(runtime.stopped, true);
  await assert.rejects(stat(dataPath), { code: "ENOENT" });
  assert.equal((await localRequest(adminPath, "GET", "/v1/status")).service, "wyvern");
});

test("operator audit is bounded, persists across restart and excludes extraneous input", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wyvern-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audit = new Audit(dir, { maxBytes: 500 });
  await Promise.all(Array.from({ length: 12 }, (_, i) => audit.record("drain_changed", { enabled: Boolean(i % 2), api_key: "must-not-be-retained" })));
  const afterRestart = new Audit(dir, { maxBytes: 500 });
  await afterRestart.record("config_activated", { generation: "a".repeat(64) });
  const files = await readdir(dir); assert.equal(files.length, 2);
  for (const file of files) {
    const body = await readFile(path.join(dir, file), "utf8");
    assert.ok(Buffer.byteLength(body) <= 500); assert.doesNotMatch(body, /must-not|api_key/);
    for (const line of body.trim().split("\n")) assert.ok(JSON.parse(line).event);
  }
  await assert.rejects(afterRestart.record("arbitrary_event", {}), { code: "audit_unavailable" });
});

test("audit failure rejects operator mutations before changing runtime state", async () => {
  const runtime = new Runtime({ kernel: {}, audit: { async record() { throw new Error("disk-full"); } } });
  await assert.rejects(runtime.operatorDrain(true));
  assert.equal(runtime.status().drain, false);
});

test("Unix admin socket responds to the real CLI transport; data socket never exposes admin actions", { skip: process.platform === "win32" }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wyvern-uds-"));
  const runtime = new Runtime({ kernel: { async snapshot() { throw new Error("offline"); } } });
  const admin = createServer(runtime, { admin: true }), data = createServer(runtime);
  const adminPath = path.join(dir, "admin.sock"), dataPath = path.join(dir, "data.sock");
  admin.listen(adminPath); data.listen(dataPath);
  await Promise.all([once(admin, "listening"), once(data, "listening")]);
  t.after(async () => { await runtime.stop(0); await Promise.all([new Promise(r => admin.close(r)), new Promise(r => data.close(r))]); await rm(dir, { recursive: true, force: true }); });
  const status = await localRequest(adminPath, "GET", "/v1/status");
  assert.equal(status.configuration_loaded, false); assert.equal(status.ready, false);
  assert.equal((await localRequest(adminPath, "POST", "/v1/drain", { enabled: true })).drain, true);
  await assert.rejects(localRequest(dataPath, "POST", "/v1/drain", { enabled: false }));
});

test("secret file boundary rejects world-readable and newline-bearing credentials", { skip: process.platform === "win32" }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wyvern-secret-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "token"); await writeFile(file, "exact-key", { mode: 0o600 });
  assert.equal(await secretFile(file), "exact-key");
  await chmod(file, 0o644); await assert.rejects(secretFile(file));
  await chmod(file, 0o600); await writeFile(file, "exact-key\n"); await assert.rejects(secretFile(file));
});
