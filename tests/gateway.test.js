import assert from "node:assert/strict";
import test from "node:test";
import { fixture, config, message, result, CLIENT_TOKEN, OTHER_TOKEN, KEY } from "./helpers.js";
import { validateConfig } from "../src/config.js";
import { compileSchema } from "../src/request.js";

test("real HTTP gateway authenticates caller, keeps provider key inside adapter, normalizes usage", async t => {
  const f = await fixture(t);
  const { response, data } = await f.call();
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].key, KEY);
  assert.equal(data.output[0].content[0].text, "hello"); assert.equal(data.usage.total_tokens, 5);
  assert.equal(data.target.model, "gemini-test"); assert.equal(data.attempts, 1);
  assert.equal(f.events.find(item => item.event === "attempt_finished").client_id, "mastermind");
  assert.equal(JSON.stringify([data, f.runtime.status(), f.events]).includes(KEY), false);
});

test("caller cannot spoof client identity, access another adapter or send upstream endpoints", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(message(), "wrong")).response.status, 401);
  assert.equal((await f.call(message({ metadata: { client_id: "mastermind" } }), OTHER_TOKEN)).response.status, 403);
  assert.equal((await f.call(message({ endpoint: "https://attacker.invalid" }))).response.status, 400);
  assert.equal(f.calls.length, 0);
  const catalog = await fetch(f.origin + "/v1/client", { headers: { Authorization: "Bearer " + OTHER_TOKEN } }).then(r => r.json());
  assert.deepEqual(catalog.adapters, []);
  assert.equal((await f.call({}, CLIENT_TOKEN, "/v1/drain")).response.status, 404);
});

test("function binding resolves inside gateway and rejects conflicting selection", async t => {
  const f = await fixture(t);
  assert.equal((await f.call({ messages: message().messages, function: "crusher" })).response.status, 200);
  assert.equal((await f.call(message({ function: "crusher", adapter_id: "other" }))).response.status, 409);
});

test("rotation in Volt without Register revision change activates the new key", async t => {
  const f = await fixture(t); const old = f.runtime.status().generation;
  f.state.key = "new-synthetic-key"; f.state.keyRevision++;
  await f.runtime.reload(); await f.call();
  assert.notEqual(f.runtime.status().generation, old);
  assert.equal(f.calls[0].key, "new-synthetic-key");
  assert.equal(f.resolveCalls[1].expected_register_revision, f.state.register);
  assert.equal(f.resolveCalls[1].expected_volt_revisions["wyvern.config.active"], 1);
});

test("invalid reload and temporary Kernel outage preserve last-known-good; stale auth eventually closes access", async t => {
  let now = 10000; const f = await fixture(t, { clock: () => now });
  const generation = f.runtime.status().generation;
  f.state.config.adapters.google.profiles.default.model = "../../secrets"; f.state.revision++;
  await assert.rejects(f.runtime.reload(), { code: "configuration_invalid" });
  assert.equal(f.runtime.status().generation, generation); assert.equal((await f.call()).response.status, 200);
  f.state.fail = true;
  await assert.rejects(f.runtime.reload(), { code: "kernel_unavailable" });
  assert.equal((await f.call()).response.status, 200);
  now += 300001;
  assert.equal((await f.call()).data.error.code, "authorization_stale");
  assert.equal(f.runtime.status().ready, false);
});

test("cold invalid config is live but never ready", async t => {
  const f = await fixture(t, { mutate: state => { state.config.clients.mastermind.allowed_adapters.push("missing"); } });
  assert.equal((await fetch(f.origin + "/health/live")).status, 200);
  assert.equal((await fetch(f.origin + "/health/ready")).status, 503);
  assert.equal((await f.call()).response.status, 503);
});

test("structured response is checked against schema without leaking invalid provider content", async t => {
  let answer = '{"title":"valid"}';
  const f = await fixture(t, { provider: (_req, res) => res.end(JSON.stringify(result(answer))) });
  const body = message({ response_format: { type: "json_schema", schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } } });
  assert.deepEqual((await f.call(body)).data.json, { title: "valid" });
  answer = '{"api_key":"must-not-escape"}';
  const failed = await f.call(body);
  assert.equal(failed.response.status, 502);
  assert.equal(JSON.stringify(failed.data).includes("must-not-escape"), false);
});

test("no silent retry on 429, errors never relay provider body", async t => {
  const f = await fixture(t, { provider: (_req, res) => { res.writeHead(429); res.end('Authorization: leaked-key'); } });
  const { data, response } = await f.call();
  assert.equal(response.status, 429); assert.equal(data.error.retryable, true);
  assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(data).includes("leaked-key"), false);
});

test("count tokens uses actual selected model and checks capability", async t => {
  const f = await fixture(t);
  const { data } = await f.call(message(), CLIENT_TOKEN, "/v1/count-tokens");
  assert.equal(data.input_tokens, 10); assert.equal(data.estimate, false);
  assert.equal(f.calls[0].body.generateContentRequest.model, "models/gemini-test");
});

test("drain refuses new work, retains active old snapshot, then releases concurrency", async t => {
  let finish; const started = new Promise(resolve => { finish = resolve; });
  let release;
  const f = await fixture(t, { provider: async (_req, res) => { finish(); await new Promise(r => { release = r; }); res.end(JSON.stringify(result())); },
    mutate: state => { state.config.adapters.google.max_concurrent = 1; } });
  const first = f.call(); await started;
  assert.equal((await f.call()).response.status, 429);
  f.state.key = "rotated"; f.state.keyRevision++; await f.runtime.reload();
  f.runtime.drain(true);
  assert.equal((await f.call()).data.error.code, "service_draining");
  assert.equal(f.runtime.status().active_requests, 1);
  release(); assert.equal((await first).response.status, 200);
  assert.equal(f.calls[0].key, KEY); assert.equal(f.runtime.status().active_requests, 0);
  f.runtime.drain(false); assert.equal(f.runtime.status().ready, true);
});

test("SSE is normalized and partial failure never retries", async t => {
  const f = await fixture(t, { provider: (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"candidates":[{"content":{"parts":[{"text":"first"}]}}]}\n\n');
    res.end('data: broken-provider-json\n\n');
  } });
  const response = await fetch(f.origin + "/v1/generate", { method: "POST", headers: { Authorization: "Bearer " + CLIENT_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(message({ stream: true })) });
  const text = await response.text();
  assert.match(text, /event: request.created/); assert.match(text, /event: output.delta/); assert.match(text, /event: request.failed/);
  assert.doesNotMatch(text, /broken-provider-json/); assert.equal(f.calls.length, 1); assert.equal(f.runtime.status().active_requests, 0);
});

test("completed SSE and provider usage survive split UTF-8 chunks", async t => {
  const f = await fixture(t, { provider: (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    const bytes = Buffer.from("data: " + JSON.stringify(result("Привет")) + "\r\n\r\n");
    for (const byte of bytes) res.write(Buffer.from([byte])); res.end();
  } });
  const response = await fetch(f.origin + "/v1/generate", { method: "POST", headers: { Authorization: "Bearer " + CLIENT_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(message({ stream: true })) });
  const text = await response.text();
  assert.match(text, /Привет/); assert.match(text, /event: request.completed/); assert.doesNotMatch(text, /request.failed/);
});

test("disconnect aborts the downstream provider request", async t => {
  let signalClosed;
  const closed = new Promise(resolve => { signalClosed = resolve; });
  const f = await fixture(t, { provider: (_req, res) => {
    res.on("close", signalClosed);
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"candidates":[{"content":{"parts":[{"text":"start"}]}}]}\n\n');
  } });
  const controller = new AbortController();
  const response = await fetch(f.origin + "/v1/generate", { signal: controller.signal, method: "POST", headers: { Authorization: "Bearer " + CLIENT_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(message({ stream: true })) });
  const reader = response.body.getReader();
  let received = "";
  while (!received.includes("output.delta")) received += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Provider was not cancelled")), 2000); timer.unref(); })]);
  assert.equal(f.calls.length, 1);
});

test("bounds and schema safety reject before provider request", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(message({ options: { max_output_tokens: 1001 } }))).response.status, 422);
  assert.equal((await f.call(message({ messages: Array(129).fill({ role: "user", content: "x" }) }))).response.status, 400);
  assert.equal(f.calls.length, 0);
  assert.throws(() => compileSchema({ type: "string", pattern: "(a+)+$" }));
  assert.throws(() => compileSchema({ $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" }));
  assert.throws(() => compileSchema({ $ref: "https://attacker.invalid/schema" }));
  const cfg = config("https://generativelanguage.googleapis.com");
  cfg.adapters.google.endpoint = "https://attacker.invalid";
  assert.throws(() => validateConfig(cfg), { code: "configuration_invalid" });
});
