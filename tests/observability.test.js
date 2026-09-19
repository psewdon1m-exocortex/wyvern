import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Audit } from "../src/audit.js";
import { redact, logEvent } from "../src/observability.js";
import { fixture, message, OTHER_TOKEN } from "./helpers.js";

test("early HTTP denials and provider errors are correlated, audited and never log caller data", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wyvern-security-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await fixture(t);
  f.runtime.audit = new Audit(dir);
  const denied = await f.call(message(), "synthetic-denied-token");
  await f.call(message(), OTHER_TOKEN);
  await f.call(message({ endpoint: "https://secret.invalid/?token=hidden" }));
  const rows = (await readFile(path.join(dir, "operator.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(row => row.event), ["authentication_failed", "authorization_failed", "request_failed"]);
  assert.equal(rows[0].request_id, denied.data.error.request_id);
  assert.equal(rows[0].actor, null);
  assert.equal(rows[1].actor, "laboratory");
  assert.ok(rows.every(row => row.id && Number.isFinite(Date.parse(row.at)) && row.http_status >= 400));
  assert.doesNotMatch(JSON.stringify([rows, f.events]), /synthetic-denied-token|test source|secret\.invalid|hidden/);
  f.runtime.audit = { async record() { throw Error("disk full secret details"); } };
  assert.equal((await f.call(message(), "wrong")).response.status, 401);
  assert.ok(f.events.some(row => row.event === "audit_unavailable"));
});

test("health is minimal before authentication while admin diagnostics retain version", async t => {
  const f = await fixture(t);
  assert.deepEqual(await fetch(f.origin + "/health/live").then(r => r.json()), { alive: true });
  assert.deepEqual(await fetch(f.origin + "/health/ready").then(r => r.json()), { ready: true });
  assert.equal((await fetch(f.adminOrigin + "/v1/status").then(r => r.json())).version, "0.0.1");
});

test("central redactor bounds nested/cyclic metadata and removes keys and credential patterns", () => {
  const source = { nested: [{ apiKey: "synthetic-one", child: { password: "synthetic-two", note: "Bearer synthetic-three" } }], normal: "safe" };
  source.self = source;
  const text = JSON.stringify(redact(source));
  assert.doesNotMatch(text, /synthetic/);
  assert.match(text, /safe/);
  assert.match(text, /TRUNCATED/);
  assert.equal(source.nested[0].apiKey, "synthetic-one");
  assert.ok(JSON.stringify(logEvent({ event: "request_failed", request_id: "Bearer synthetic-four", payload: source })).length < 1000);
  assert.doesNotMatch(JSON.stringify(logEvent({ event: "request_failed", request_id: "Bearer synthetic-four", payload: source })), /synthetic|payload/);
});

test("audit limits records and expires old entries across restart and idle maintenance", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wyvern-retention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  const options = { maxRecords: 2, maxAgeMs: 1000, clock: () => now };
  const audit = new Audit(dir, options);
  for (let i = 0; i < 7; i++) await audit.record("drain_changed", { enabled: true });
  let count = 0;
  for (const name of await readdir(dir)) count += (await readFile(path.join(dir, name), "utf8")).trim().split("\n").length;
  assert.ok(count <= 4);
  now += 1100;
  await new Audit(dir, options).prune();
  assert.deepEqual(await readdir(dir), []);
  await audit.record("drain_changed", { enabled: false });
  now += 1100;
  await audit.prune();
  assert.deepEqual(await readdir(dir), []);
});

test("audit refuses unsafe persisted files", { skip: process.platform === "win32" }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wyvern-audit-link-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outside = path.join(dir, "untouched");
  await writeFile(outside, "original", { mode: 0o600 });
  await symlink(outside, path.join(dir, "operator.jsonl"));
  await assert.rejects(new Audit(dir).prune(), { code: "audit_unavailable" });
  assert.equal(await readFile(outside, "utf8"), "original");
});

test("age cleanup rewrites mixed-age files and preserves the fresh event identity", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wyvern-audit-age-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  const audit = new Audit(dir, { clock: () => now, maxAgeMs: 1000 });
  await audit.record("drain_changed", { enabled: true });
  now += 500;
  await audit.record("drain_changed", { enabled: false });
  const before = (await readFile(path.join(dir, "operator.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  now += 600;
  await audit.prune();
  const after = (await readFile(path.join(dir, "operator.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(after, [before[1]]);
});
