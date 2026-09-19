import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Media } from "../src/media.js";
import { fixture, message, result, CLIENT_TOKEN, OTHER_TOKEN, KEY } from "./helpers.js";

async function mediaFixture(t, options = {}) {
  const f = await fixture(t, { rawProvider: true, ...options, mutate(state) {
    state.config.adapters.google.profiles.default.capabilities.push("image", "pdf", "audio", "video", "youtube");
    state.config.clients.laboratory.allowed_adapters = ["google"];
  }, provider(req, res, body) {
    if (req.headers["x-goog-upload-command"] === "start") { res.setHeader("x-goog-upload-url", `http://${req.headers.host}/upload/v1beta/files?upload_id=opaque`); return res.end(); }
    if (req.headers["x-goog-upload-command"] === "upload, finalize") { assert.equal(body.toString(), "%PDF-fixture"); return res.end(JSON.stringify({ file: { name: "files/abc", state: "ACTIVE" } })); }
    if (req.method === "DELETE") return res.end("{}");
    if (req.method === "GET") return res.end(JSON.stringify({ name: "files/abc", state: "ACTIVE" }));
    if (req.url.endsWith(":countTokens")) return res.end(JSON.stringify({ totalTokens: 17 }));
    res.end(JSON.stringify(result()));
  } });
  f.upload = async () => {
    const response = await fetch(f.origin + "/v1/media", { method: "POST", headers: { Authorization: "Bearer " + CLIENT_TOKEN, "Content-Type": "application/pdf", "X-Wyvern-Function": "crusher" }, body: "%PDF-fixture" });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-request-id"), f.events.findLast(row => row.event === "media_uploaded").request_id);
    return response.json();
  };
  f.mediaCall = (id, method = "GET", token = CLIENT_TOKEN) => fetch(f.origin + "/v1/media/" + id, { method, headers: { Authorization: "Bearer " + token } });
  return f;
}
test("media flows through the gateway with opaque ownership, counting and cleanup", async t => {
  const f = await mediaFixture(t), handle = await f.upload();
  assert.equal(handle.state, "active"); assert.equal(handle.size_bytes, 12);
  assert.equal(JSON.stringify(handle).includes("files/"), false);
  assert.equal((await f.mediaCall(handle.media_id, "GET", OTHER_TOKEN)).status, 410);
  const input = message({ messages: [{ role: "user", content: [{ type: "text", text: "Read PDF" }, { type: "media", media_id: handle.media_id }] }] });
  assert.equal((await f.call(input, CLIENT_TOKEN, "/v1/count-tokens")).data.input_tokens, 17);
  const output = await f.call(input); assert.equal(output.response.status, 200);
  const generated = f.calls.find(call => call.url.endsWith(":generateContent"));
  assert.match(generated.body.contents[0].parts[1].fileData.fileUri, /\/v1beta\/files\/abc$/);
  assert.equal((await f.mediaCall(handle.media_id, "DELETE")).status, 200);
  assert.equal((await f.call(input)).response.status, 410);
  assert.equal(f.runtime.status().active_requests, 0);
  assert.equal(JSON.stringify([handle, output.data, f.events]).includes(KEY), false);
});
test("media survives restart without credentials; pinned generation prevents deletion; rotation expires handles", async t => {
  const f = await mediaFixture(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wyvern-media-")); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "media.json"); f.runtime.media = new Media({ filename });
  const handle = await f.upload();
  const recovered = new Media({ filename }); await recovered.load(); f.runtime.media = recovered;
  const input = message({ messages: [{ role: "user", content: [{ type: "media", media_id: handle.media_id }] }] });
  const operation = f.runtime.prepare("mastermind", input);
  const denied = await f.mediaCall(handle.media_id, "DELETE");
  assert.equal(denied.status, 409);
  const errorId = (await denied.json()).error.request_id;
  assert.equal(denied.headers.get("x-request-id"), errorId);
  assert.equal(f.events.findLast(row => row.event === "request_failed").request_id, errorId);
  operation.release("success");
  f.state.key = "rotated-key"; f.state.keyRevision++; await f.runtime.reload();
  assert.equal((await f.call(input)).response.status, 410);
  const ledger = await fs.readFile(filename, "utf8"); assert.equal(ledger.includes(KEY), false); assert.equal(ledger.includes("upload_id"), false); assert.equal(ledger.includes("%PDF"), false);
});
test("media expires locally and rejects arbitrary URLs or caller-supplied provider files", async t => {
  let now = Date.now(); const f = await mediaFixture(t, { clock: () => now }); f.runtime.media = new Media({ clock: () => now, ttl: 100 });
  const handle = await f.upload(); now += 101;
  assert.equal((await f.mediaCall(handle.media_id)).status, 410);
  for (const part of [{ type: "youtube", url: "http://127.0.0.1/private" }, { type: "media", media_id: handle.media_id, provider_file: { name: "files/other" } }]) {
    assert.equal((await f.call(message({ messages: [{ role: "user", content: [part] }] }))).response.status, 400);
  }
  await f.runtime.media.reap(() => ({ adapter: f.state.config.adapters.google, credential: KEY }), f.runtime.mediaDriver ?? { removeFile: async () => {} });
  assert.equal(f.runtime.media.records.size, 0);
});
test("YouTube and bounded video clipping use the selected Adapter without uploading", async t => {
  const f = await mediaFixture(t);
  assert.equal((await f.call(message({ messages: [{ role: "user", content: [{ type: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk", video: { end_seconds: 120, fps: 0.5 } }] }] }))).response.status, 200);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].body.contents[0].parts[0].videoMetadata, { startOffset: "0s", endOffset: "120s", fps: 0.5 });
});

test("provider cannot redirect an authenticated upload to another origin", async t => {
  const f = await fixture(t, { rawProvider:true, mutate(state) { state.config.adapters.google.profiles.default.capabilities.push('pdf'); },
    provider(_req,res) { res.setHeader('x-goog-upload-url','https://untrusted.invalid/upload/v1beta/files?key=private'); res.end(); } });
  const response=await fetch(f.origin+'/v1/media',{method:'POST',headers:{Authorization:'Bearer '+CLIENT_TOKEN,'Content-Type':'application/pdf','X-Wyvern-Function':'crusher'},body:'%PDF-fixture'});
  assert.equal(response.status,502);assert.equal(f.calls.length,1);
  assert.doesNotMatch(await response.text(),/untrusted|private|synthetic-provider/);
  assert.equal(f.runtime.status().active_requests,0);assert.equal(f.runtime.media.records.size,0);
});

test("processing and failed media never reach generation; quotas are reserved before upload", async t => {
  const f=await mediaFixture(t), handle=await f.upload();
  const row=f.runtime.media.records.get(handle.media_id);
  const input=message({messages:[{role:'user',content:[{type:'media',media_id:handle.media_id}]}]});
  row.state='PROCESSING';assert.equal((await f.call(input)).response.status,409);
  row.state='FAILED';assert.equal((await f.call(input)).response.status,422);
  assert.equal(f.calls.filter(call=>call.url.endsWith(':generateContent')).length,0);
  for(let i=0;i<15;i++) f.runtime.media.records.set('quota-'+i,{...row,id:'quota-'+i});
  const before=f.calls.length;
  const response=await fetch(f.origin+'/v1/media',{method:'POST',headers:{Authorization:'Bearer '+CLIENT_TOKEN,'Content-Type':'application/pdf','X-Wyvern-Function':'crusher'},body:'%PDF-fixture'});
  assert.equal(response.status,429);assert.equal(f.calls.length,before);assert.equal(f.runtime.status().active_requests,0);
});

test("expiry cleanup is bounded so it cannot starve configuration refresh", async () => {
  const media=new Media({clock:()=>100});let calls=0;
  for(let i=0;i<12;i++) media.records.set('expired-'+i,{id:'expired-'+i,expires_at:0,adapter_id:'google',credential_hash:'different'});
  await media.reap(()=>({credential:'key'}),{removeFile:async()=>{calls++}});
  assert.equal(media.records.size,8);assert.equal(calls,0);
});
