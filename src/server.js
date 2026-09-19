import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fault, publicError } from "./errors.js";
import { parseJSON, readBody } from "./util.js";

export function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}
async function event(res, type, data, signal) {
  signal.throwIfAborted();
  if (!res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)) await once(res, "drain", { signal });
}
export function createServer(runtime, { admin = false } = {}) {
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 300000 }, async (req, res) => {
    let requestId = "req_" + randomUUID(), operation, client;
    const route = ["/health/live", "/health/ready", "/v1/catalog", "/v1/status", "/v1/preflight", "/v1/reload", "/v1/drain",
      "/v1/client", "/v1/media", "/v1/bindings", "/v1/generate", "/v1/count-tokens"].includes(req.url) ? req.url
      : /^\/v1\/media\/media_[a-f0-9-]{36}$/.test(req.url) ? "/v1/media/:id" : "unknown";
    const cancelled = new AbortController();
    req.on("aborted", () => cancelled.abort());
    res.on("close", () => { if (!res.writableFinished) cancelled.abort(); });
    try {
      if (req.url === "/health/live" && req.method === "GET") return json(res, 200, { alive: true });
      if (req.url === "/health/ready" && req.method === "GET") {
        const ready = runtime.status().ready; return json(res, ready ? 200 : 503, { ready });
      }
      if (admin) {
        if (req.url === "/v1/catalog" && req.method === "GET") return json(res, 200, runtime.catalog());
        if (["/v1/status", "/v1/preflight"].includes(req.url) && req.method === "GET") return json(res, 200, runtime.status());
        if (req.url === "/v1/reload" && req.method === "POST") return json(res, 200, await runtime.reload());
        if (req.url === "/v1/drain" && req.method === "POST") {
          const body = parseJSON((await readBody(req, 1024, cancelled.signal)).toString("utf8"));
          if (typeof body?.enabled !== "boolean" || Object.keys(body).length !== 1) fault("invalid_request");
          return json(res, 200, await runtime.operatorDrain(body.enabled));
        }
        fault("not_found", 404);
      }
      const authorization = req.headers.authorization;
      client = runtime.authenticate(typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
      if (req.url === "/v1/client" && req.method === "GET") return json(res, 200, runtime.clientStatus(client));
      if (req.url === "/v1/media" && req.method === "POST") {
        if (req.headers["content-encoding"] || !/^\d+$/.test(req.headers["content-length"] ?? "")) fault("invalid_request");
        const selection = {};
        for (const name of ["function", "adapter_id", "profile"]) { const value = req.headers["x-wyvern-" + name.replace("_", "-")]; if (value !== undefined) selection[name] = value; }
        operation = runtime.prepareMedia(client, selection, cancelled.signal);
        requestId = operation.request_id;
        res.setHeader("X-Request-ID", requestId);
        const result = await runtime.uploadMedia(operation, req, req.headers["content-type"], Number(req.headers["content-length"]));
        await runtime.recordOutcome("media_uploaded", { client_id: client, request_id: operation.request_id, status: "success" });
        operation.release("success"); return json(res, 201, result);
      }
      if (/^\/v1\/media\/media_[a-f0-9-]{36}$/.test(req.url) && ["GET", "DELETE"].includes(req.method)) {
        const id = req.url.split("/").at(-1);
        operation = runtime.prepareMedia(client, runtime.mediaSelection(client, id), cancelled.signal);
        requestId = operation.request_id;
        res.setHeader("X-Request-ID", requestId);
        const result = await runtime.inspectMedia(operation, id, req.method === "DELETE");
        if (req.method === "DELETE") await runtime.recordOutcome("media_deleted", { client_id: client, request_id: operation.request_id, status: "success" });
        operation.release("success"); return json(res, 200, result);
      }
      if (req.url === "/v1/bindings" && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0] !== "application/json") fault("unsupported_media_type", 415);
        const input = parseJSON((await readBody(req, 16384, AbortSignal.any([cancelled.signal, AbortSignal.timeout(10000)]))).toString("utf8"));
        return json(res, 200, await runtime.changeBindings(client, input));
      }
      const countOnly = req.url === "/v1/count-tokens";
      if ((!countOnly && req.url !== "/v1/generate") || req.method !== "POST") fault("not_found", 404);
      if (req.headers["content-type"]?.split(";")[0] !== "application/json" || req.headers["content-encoding"]) fault("unsupported_media_type", 415);
      if (req.headers["content-length"] !== undefined && (!/^\d+$/.test(req.headers["content-length"]) || Number(req.headers["content-length"]) > runtime.limits.max_body_bytes)) fault("payload_too_large", 413);
      const bodySignal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(30000)]);
      const body = parseJSON((await readBody(req, runtime.limits.max_body_bytes, bodySignal)).toString("utf8"));
      operation = runtime.prepare(client, body, { signal: cancelled.signal, countOnly });
      requestId = operation.request_id;
      res.setHeader("X-Request-ID", requestId);
      const envelope = { request_id: requestId, target: operation.target, config_generation: operation.generation, attempts: 1 };
      if (countOnly) {
        const tokens = await runtime.count(operation);
        operation.release("success");
        return json(res, 200, { ...envelope, input_tokens: tokens, estimate: false });
      }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        await event(res, "request.created", envelope, operation.context.signal);
        let finishReason = null, usage = {};
        for await (const delta of runtime.stream(operation)) {
          if (delta.text) await event(res, "output.delta", { request_id: requestId, text: delta.text }, operation.context.signal);
          for (const [name, value] of Object.entries(delta.usage)) if (value !== null) usage[name] = value;
          if (delta.finish_reason) finishReason = delta.finish_reason;
        }
        await event(res, "request.completed", { ...envelope, finish_reason: finishReason, usage }, operation.context.signal);
        operation.release("success", usage); res.end(); return;
      }
      const result = await runtime.generate(operation);
      operation.release("success", result.usage);
      return json(res, 200, { ...envelope, output: [{ type: "message", role: "assistant", content: [{ type: "text", text: result.text }] }],
        ...(result.json !== undefined ? { json: result.json } : {}), finish_reason: result.finish_reason, usage: result.usage });
    } catch (error) {
      const safe = publicError(error, requestId);
      operation?.release(cancelled.signal.aborted ? "cancelled" : safe.body.error.code);
      await runtime.recordOutcome(safe.status === 401 ? "authentication_failed" : safe.status === 403 ? "authorization_failed" : "request_failed",
        { request_id: requestId, client_id: client ?? null, route, status: safe.body.error.code, http_status: safe.status });
      if (res.destroyed) return;
      if (res.headersSent) {
        res.end(`event: request.failed\ndata: ${JSON.stringify(safe.body)}\n\n`);
      } else {
        if (!req.complete) res.setHeader("Connection", "close");
        json(res, safe.status, safe.body);
      }
    }
  });
  server.maxConnections = 512;
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  return server;
}
