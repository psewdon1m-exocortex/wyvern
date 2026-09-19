import { fault, WyvernError } from "../errors.js";
import { object, integer, readBody } from "../util.js";

function usage(value) {
  const token = key => value?.[key] === undefined ? null : value[key];
  const result = { input_tokens: token("promptTokenCount"), output_tokens: token("candidatesTokenCount"),
    total_tokens: token("totalTokenCount"), cached_tokens: token("cachedContentTokenCount"), reasoning_tokens: token("thoughtsTokenCount") };
  if (Object.values(result).some(item => item !== null && !integer(item, 0, 100000000))) fault("provider_response_invalid", 502);
  return result;
}
function normalize(data, { partial = false } = {}) {
  if (!object(data)) fault("provider_response_invalid", 502);
  const blocked = data.promptFeedback?.blockReason;
  if (blocked) return { text: "", finish_reason: "blocked", usage: usage(data.usageMetadata) };
  if (!Array.isArray(data.candidates) || data.candidates.length !== 1) fault("provider_response_invalid", 502);
  const candidate = data.candidates[0];
  const parts = candidate.content?.parts ?? [];
  if (!Array.isArray(parts) || parts.length > 1024) fault("provider_response_invalid", 502);
  const text = parts.filter(item => !item.thought).map(item => {
    if (!object(item) || typeof item.text !== "string") fault("provider_response_invalid", 502);
    return item.text;
  }).join("");
  const reasons = { STOP: "stop", MAX_TOKENS: "length", SAFETY: "blocked", RECITATION: "blocked", BLOCKLIST: "blocked", PROHIBITED_CONTENT: "blocked", SPII: "blocked" };
  const finish = candidate.finishReason === undefined && partial ? null : reasons[candidate.finishReason];
  if (finish === undefined) fault("provider_response_invalid", 502);
  return { text, finish_reason: finish, usage: usage(data.usageMetadata) };
}

export class GoogleDriver {
  constructor({ fetchImpl = globalThis.fetch } = {}) { this.fetch = fetchImpl; }
  async fileRequest(context, route, options = {}) {
    try {
      const response = await this.fetch(route.startsWith("/") ? context.adapter.endpoint + route : route, {
        ...options, redirect: "error", signal: context.signal,
        headers: { ...options.headers, "x-goog-api-key": context.credential, "Accept-Encoding": "identity" },
      });
      if (!response.ok && !(options.method === "DELETE" && response.status === 404)) {
        await response.body?.cancel();
        if (response.status === 404) fault("media_expired", 410);
        if (response.status === 429) fault("rate_limited", 429, true);
        if (response.status >= 500) fault("provider_unavailable", 503, true);
        fault("provider_rejected_request", 502);
      }
      return response;
    } catch (error) {
      if (error instanceof WyvernError) throw error;
      if (context.signal.aborted) fault("provider_timeout", 504);
      fault("provider_unavailable", 503, true);
    }
  }
  fileRecord(value, expected) {
    if (!object(value) || !/^files\/[a-z0-9_-]{1,128}$/.test(value.name) || expected && value.name !== expected || !["ACTIVE", "PROCESSING", "FAILED"].includes(value.state)) fault("provider_response_invalid", 502);
    return { name: value.name, state: value.state };
  }
  async fileJSON(response, signal) {
    try { return JSON.parse((await readBody(response.body, 65536, signal)).toString("utf8")); }
    catch (error) { this.classify(error, signal); }
  }
  async upload(context, stream, mime, size) {
    const opened = await this.fileRequest(context, "/upload/v1beta/files", { method: "POST", headers: {
      "Content-Type": "application/json", "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size), "X-Goog-Upload-Header-Content-Type": mime,
    }, body: JSON.stringify({ file: { display_name: "Wyvern media" } }) });
    const location = opened.headers.get("x-goog-upload-url");
    await opened.body?.cancel();
    let target;
    try { target = new URL(location); } catch { fault("provider_response_invalid", 502); }
    if (location.length > 8192 || target.origin !== new URL(context.adapter.endpoint).origin || target.pathname !== "/upload/v1beta/files" || target.username || target.password || target.hash) fault("provider_response_invalid", 502);
    async function* bounded() {
      let bytes = 0;
      for await (const chunk of stream) { context.signal.throwIfAborted(); bytes += chunk.length; if (bytes > size) fault("payload_too_large", 413); yield chunk; }
      if (bytes !== size) fault("invalid_request");
    }
    const response = await this.fileRequest(context, target.href, { method: "POST", duplex: "half", body: bounded(), headers: {
      "Content-Length": String(size), "Content-Type": mime, "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize",
    } });
    return this.fileRecord((await this.fileJSON(response, context.signal)).file);
  }
  async getFile(context, name) { return this.fileRecord(await this.fileJSON(await this.fileRequest(context, "/v1beta/" + name), context.signal), name); }
  async removeFile(context, name) { const response = await this.fileRequest(context, "/v1beta/" + name, { method: "DELETE" }); await response.body?.cancel(); }
  body(request, profile) {
    const system = request.messages.find(item => item.role === "system");
    const body = { contents: request.messages.filter(item => item.role !== "system").map(item => ({
      role: item.role === "assistant" ? "model" : "user", parts: typeof item.content === "string" ? [{ text: item.content }] : item.content.map(part => {
        if (part.type === "text") return { text: part.text };
        const converted = { fileData: part.type === "youtube" ? { fileUri: part.url, mimeType: "video/*" } : { fileUri: request.provider_endpoint + "/v1beta/" + part.provider_file.name, mimeType: part.provider_file.mime } };
        if (part.video) converted.videoMetadata = { startOffset: (part.video.start_seconds ?? 0) + "s", ...(part.video.end_seconds !== undefined ? { endOffset: part.video.end_seconds + "s" } : {}), fps: part.video.fps ?? 1 };
        return converted;
      }),
    })) };
    if (system) body.systemInstruction = { parts: [{ text: system.content }] };
    body.generationConfig = { maxOutputTokens: request.options.max_output_tokens, temperature: request.options.temperature, candidateCount: 1 };
    if (profile.thinking_budget !== undefined) body.generationConfig.thinkingConfig = { thinkingBudget: profile.thinking_budget };
    if (request.response_format) Object.assign(body.generationConfig, { responseMimeType: "application/json", responseJsonSchema: request.response_format.schema });
    return body;
  }
  async open({ adapter, profile, credential, request, signal }, operation) {
    let body = this.body({ ...request, provider_endpoint: adapter.endpoint }, profile);
    if (operation === "countTokens") body = { generateContentRequest: { ...body, model: "models/" + profile.model } };
    let response;
    try {
      response = await this.fetch(`${adapter.endpoint}/v1beta/models/${profile.model}:${operation}${operation === "streamGenerateContent" ? "?alt=sse" : ""}`, {
        method: "POST", redirect: "error", signal,
        headers: { "x-goog-api-key": credential, "Content-Type": "application/json", "Accept-Encoding": "identity" }, body: JSON.stringify(body),
      });
    } catch {
      if (signal.aborted) fault("provider_timeout", 504);
      fault("provider_unavailable", 503, true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) fault("rate_limited", 429, true);
      if (response.status >= 500) fault("provider_unavailable", 503, true);
      fault("provider_rejected_request", 502);
    }
    return response;
  }
  async generate(context) {
    try {
      const response = await this.open(context, "generateContent");
      const data = JSON.parse((await readBody(response.body, context.max_response_bytes, context.signal)).toString("utf8"));
      const result = normalize(data);
      if (context.request.validate) {
        if (result.finish_reason !== "stop") fault("output_incomplete", 502);
        let json;
        try { json = JSON.parse(result.text); } catch { fault("provider_response_invalid", 502); }
        if (!context.request.validate(json)) fault("provider_response_invalid", 502);
        result.json = json;
      }
      return result;
    } catch (error) { this.classify(error, context.signal); }
  }
  async count(context) {
    try {
      const response = await this.open(context, "countTokens");
      const data = JSON.parse((await readBody(response.body, 65536, context.signal)).toString("utf8"));
      if (!integer(data?.totalTokens, 0, 100000000)) fault("provider_response_invalid", 502);
      return data.totalTokens;
    } catch (error) { this.classify(error, context.signal); }
  }
  async *stream(context) {
    const idle = new AbortController();
    const signal = AbortSignal.any([context.signal, idle.signal]);
    let timer;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), context.idle_stream_timeout_ms); timer.unref?.(); };
    reset();
    try {
      const response = await this.open({ ...context, signal }, "streamGenerateContent");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "", dataLines = [], total = 0, finished = false;
      for await (const chunk of response.body) {
        reset();
        total += chunk.length;
        if (total > context.max_response_bytes) fault("provider_response_invalid", 502);
        buffer += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(buffer) > context.max_response_bytes) fault("provider_response_invalid", 502);
        let next;
        while ((next = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, next).replace(/\r$/, "");
          buffer = buffer.slice(next + 1);
          if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
          else if (line === "" && dataLines.length) {
            const data = JSON.parse(dataLines.join("\n")); dataLines = [];
            if (finished) fault("provider_response_invalid", 502);
            const result = normalize(data, { partial: true });
            if (result.finish_reason) finished = true;
            yield result;
          }
        }
      }
      decoder.decode();
      if (!finished || buffer.trim() || dataLines.length) fault("provider_response_invalid", 502);
    } catch (error) { this.classify(error, signal); }
    finally { clearTimeout(timer); }
  }
  classify(error, signal) {
    if (signal.aborted) fault("provider_timeout", 504);
    if (error instanceof WyvernError && error.code !== "payload_too_large" && error.code !== "request_cancelled") throw error;
    fault("provider_response_invalid", 502);
  }
}
