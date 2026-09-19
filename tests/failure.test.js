import assert from "node:assert/strict";
import test from "node:test";
import { fixture, message, CLIENT_TOKEN } from "./helpers.js";

test("oversized incoming body produces a stable 413 without calling provider", async t => {
  const f = await fixture(t, { mutate: state => { state.config.runtime.max_body_bytes = 1024; } });
  const failed = await f.call(message({ messages: [{ role: "user", content: "x".repeat(1100) }] }));
  assert.equal(failed.response.status, 413); assert.equal(failed.data.error.code, "payload_too_large");
  assert.equal(f.calls.length, 0);
});

test("total provider deadline cancels connection and releases the concurrency slot", async t => {
  const f = await fixture(t, { provider: (_req, _res) => {}, mutate: state => { state.config.adapters.google.request_timeout_ms = 100; } });
  const failed = await f.call();
  assert.equal(failed.response.status, 504); assert.equal(failed.data.error.retryable, false);
  assert.equal(f.runtime.status().active_requests, 0);
});

test("idle SSE timeout emits failure and never retries", async t => {
  const f = await fixture(t, { provider: (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write('data: {"candidates":[{"content":{"parts":[{"text":"prefix"}]}}]}\n\n');
  }, mutate: state => { state.config.runtime.idle_stream_timeout_ms = 100; } });
  const response = await fetch(f.origin + "/v1/generate", { method: "POST", headers: { Authorization: "Bearer " + CLIENT_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(message({ stream: true })) });
  const text = await response.text();
  assert.match(text, /output.delta/); assert.match(text, /request.failed/); assert.match(text, /provider_timeout/);
  assert.equal(f.calls.length, 1); assert.equal(f.runtime.status().active_requests, 0);
});

test("unbounded provider output is rejected with no sensitive body in logs", async t => {
  const f = await fixture(t, { provider: (_req, res) => res.end('sensitive-upstream-' + 'x'.repeat(2000)), mutate: state => { state.config.runtime.max_response_bytes = 1024; } });
  const failed = await f.call();
  assert.equal(failed.response.status, 502); assert.equal(failed.data.error.code, "provider_response_invalid");
  assert.equal(JSON.stringify([failed.data, f.events]).includes("sensitive-upstream"), false);
});

test("gateway health does not falsely claim an unbound client's LLM function is configured", async t => {
  const f = await fixture(t);
  const status = f.runtime.clientStatus("laboratory");
  assert.equal(status.ready, true); assert.equal(status.adapter_selected, false); assert.equal(status.llm_ready, false);
  f.state.config.adapters.google.enabled = false; f.state.revision++; await f.runtime.reload();
  assert.equal(f.runtime.clientStatus("mastermind").llm_ready, false);
  assert.equal((await f.call()).data.error.code, "adapter_disabled");
});
