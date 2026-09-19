import { randomUUID } from "node:crypto";
import { fault } from "./errors.js";
import { equalHash, ID, object, telemetry, fields } from "./util.js";
import { LIMITS, validateConfig } from "./config.js";
import { validateRequest } from "./request.js";
import { GoogleDriver } from "./drivers/google.js";
import { Media } from "./media.js";

export class Runtime {
  #snapshot = null;
  #loading = null;
  #driver;
  constructor({ kernel, driver = new GoogleDriver(), sink, audit, clock = () => Date.now(), media = new Media({ clock }) }) {
    this.kernel = kernel; this.#driver = driver; this.sink = sink; this.audit = audit; this.clock = clock;
    this.lastSuccess = null; this.lastError = null; this.draining = false;
    this.active = new Map(); this.adapterCounts = new Map(); this.timer = null; this.media = media;
  }
  get limits() { return this.#snapshot?.config.runtime ?? LIMITS; }
  async reload() {
    if (this.#loading) return this.#loading;
    this.#loading = (async () => {
      try {
        const snapshot = await this.kernel.snapshot();
        if (snapshot.generation !== this.#snapshot?.generation) await this.audit?.record("config_activated", { generation: snapshot.generation });
        this.#snapshot = snapshot; this.lastSuccess = this.clock(); this.lastError = null;
        telemetry(this.sink, { event: "config_activated", generation: snapshot.generation, status: "success" });
        return this.status();
      } catch (error) {
        this.lastError = ["configuration_invalid", "configuration_conflict", "kernel_unavailable", "audit_unavailable"].includes(error.code) ? error.code : "configuration_invalid";
        telemetry(this.sink, { event: "config_reload_failed", status: this.lastError });
        throw error;
      } finally { this.#loading = null; }
    })();
    return this.#loading;
  }
  async start() {
    await this.media.load();
    try { await this.reload(); } catch { /* cold start remains live but not ready */ }
    const tick = async () => {
      try { await this.reload(); } catch { /* keep last known good */ }
      try { await this.media.reap(id => {
        const adapter = this.#snapshot?.config.adapters[id];
        return this.authFresh() && adapter ? { adapter, credential: this.#snapshot.credentials.get(adapter.credential_ref) } : null;
      }, this.#driver); } catch { telemetry(this.sink, { event: "media_cleanup_failed", status: "media_storage_unavailable" }); }
      if (!this.stopped) { this.timer = setTimeout(tick, this.limits.reload_interval_ms); this.timer.unref(); }
    };
    this.timer = setTimeout(tick, this.limits.reload_interval_ms); this.timer.unref();
  }
  authFresh() { return this.#snapshot !== null && this.clock() - this.lastSuccess <= this.limits.max_auth_stale_ms; }
  status() {
    const ready = this.authFresh() && !this.draining;
    return { schema: "exocortex.wyvern.status.v1", service: "wyvern", version: "0.0.1", api_version: 1,
      instance_id: this.#snapshot?.config.instance_id ?? null, installed: true, configuration_loaded: this.#snapshot !== null,
      ready, state: !this.#snapshot ? "unconfigured" : this.draining ? "draining" : this.lastError || !this.authFresh() ? "degraded" : "ready",
      generation: this.#snapshot?.generation ?? null, register_revision: this.#snapshot?.register_revision ?? null,
      config_revision: this.#snapshot?.config_revision ?? null,
      config_error: this.lastError, last_config_success_at: this.lastSuccess, active_requests: this.active.size,
      drain: this.draining, adapter_count: Object.keys(this.#snapshot?.config.adapters ?? {}).length };
  }
  catalog() {
    const config = this.#snapshot?.config;
    return { schema: "exocortex.wyvern.catalog.v1", instance_id: config?.instance_id ?? null, generation: this.#snapshot?.generation ?? null,
      adapters: Object.entries(config?.adapters ?? {}).map(([id, adapter]) => ({ adapter_id: id, name: adapter.name,
        driver: adapter.driver, enabled: adapter.enabled,
        profiles: Object.entries(adapter.profiles).map(([name, profile]) => ({ name, model: profile.model, capabilities: profile.capabilities })) })),
      clients: Object.entries(config?.clients ?? {}).map(([id, client]) => ({ client_id: id, enabled: client.enabled,
        allowed_adapters: client.allowed_adapters, bindings: client.bindings, requirements: client.requirements ?? {} })) };
  }
  authenticate(token) {
    if (!this.#snapshot) fault("configuration_unavailable", 503);
    if (!this.authFresh()) fault("authorization_stale", 503);
    let identity;
    for (const [id, client] of Object.entries(this.#snapshot.config.clients)) {
      if (equalHash(token, client.token_sha256) && client.enabled) identity = id;
    }
    if (!identity) fault("authentication_failed", 401);
    return identity;
  }
  clientStatus(clientId) {
    const client = this.#snapshot.config.clients[clientId];
    if (!client?.enabled) fault("permission_denied", 403);
    const adapters = client.allowed_adapters.map(id => {
      const adapter = this.#snapshot.config.adapters[id];
      return { adapter_id: id, name: adapter.name, driver: adapter.driver, enabled: adapter.enabled,
        profiles: Object.fromEntries(Object.entries(adapter.profiles).map(([name, profile]) => [name, { capabilities: profile.capabilities, max_output_tokens: profile.max_output_tokens }])) };
    });
    const names = new Set([...Object.keys(client.requirements ?? {}), ...Object.keys(client.bindings)]);
    const functions = Object.fromEntries([...names].map(name => {
      const binding = client.bindings[name];
      return [name, { ...(binding ?? {}), required_capabilities: client.requirements?.[name] ?? [],
        ready: Boolean(binding && this.status().ready && this.#snapshot.config.adapters[binding.adapter_id].enabled) }];
    }));
    return { schema: "exocortex.wyvern.client.v1", instance_id: this.#snapshot.config.instance_id,
      client_id: clientId, generation: this.#snapshot.generation, reachable: true, client_linked: true,
      bindings: client.bindings, functions, adapters, ready: this.status().ready, binding_revision: this.#snapshot.config_revision ?? null,
      adapter_selected: Object.keys(client.bindings).length > 0,
      llm_ready: Object.keys(functions).length > 0 && Object.values(functions).every(item => item.ready) };
  }
  async changeBindings(clientId, input) {
    fields(input, ["bindings", "expected_revision", "request_id"], ["bindings", "expected_revision", "request_id"]);
    if (!Number.isSafeInteger(input.expected_revision) || !/^[A-Za-z0-9_-]{16,128}$/.test(input.request_id)) fault("invalid_request");
    if (!this.authFresh()) fault("authorization_stale", 503);
    if (input.expected_revision !== this.#snapshot.config_revision) fault("configuration_conflict", 409);
    const config = structuredClone(this.#snapshot.config); delete config.credential_keys;
    if (!config.clients[clientId]?.enabled) fault("permission_denied", 403);
    config.clients[clientId].bindings = input.bindings;
    try { validateConfig(config, { allowLoopback: this.kernel.allowLoopback }); } catch { fault("binding_invalid", 422); }
    await this.kernel.changeBindings(config.instance_id, clientId, input.bindings, input.expected_revision, input.request_id);
    await this.reload();
    return this.clientStatus(clientId);
  }
  prepare(clientId, input, { signal, countOnly = false } = {}) {
    if (this.draining) fault("service_draining", 503, true);
    if (!this.authFresh()) fault("authorization_stale", 503);
    const snapshot = this.#snapshot;
    const client = snapshot.config.clients[clientId];
    if (!client?.enabled) fault("permission_denied", 403);
    if (!object(input)) fault("invalid_request");
    let adapterId = input.adapter_id, profileId = input.profile ?? "default";
    if (input.function !== undefined) {
      if (!ID.test(input.function)) fault("invalid_request");
      const binding = client.bindings[input.function];
      if (!binding) fault("binding_not_found", 404);
      if (adapterId !== undefined && adapterId !== binding.adapter_id || input.profile !== undefined && input.profile !== binding.profile) fault("binding_conflict", 409);
      adapterId = binding.adapter_id; profileId = binding.profile;
    }
    if (!client.allowed_adapters.includes(adapterId)) fault("permission_denied", 403);
    const adapter = snapshot.config.adapters[adapterId];
    if (!adapter.enabled) fault("adapter_disabled", 503);
    if (!Object.hasOwn(adapter.profiles, profileId)) fault("profile_not_found", 404);
    const profile = adapter.profiles[profileId];
    const request = validateRequest(structuredClone(input), profile, { countOnly });
    const count = this.adapterCounts.get(adapterId) ?? 0;
    if (this.active.size >= this.limits.max_concurrent || count >= adapter.max_concurrent) fault("rate_limited", 429, true);
    const requestId = "req_" + randomUUID();
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(Math.min(adapter.request_timeout_ms, request.options.timeout_ms ?? Infinity));
    const combined = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])]);
    this.active.set(requestId, controller); this.adapterCounts.set(adapterId, count + 1);
    const began = this.clock();
    const meta = { request_id: requestId, client_id: clientId, adapter_id: adapterId, profile: profileId, generation: snapshot.generation, attempt: 1 };
    telemetry(this.sink, { ...meta, event: "attempt_started" });
    let released = false, unpin = () => {};
    const operation = { ...meta, target: { adapter_id: adapterId, profile: profileId, driver: adapter.driver, model: profile.model },
      context: { adapter, profile, credential: snapshot.credentials.get(adapter.credential_ref), request, signal: combined,
        max_response_bytes: this.limits.max_response_bytes, idle_stream_timeout_ms: this.limits.idle_stream_timeout_ms },
      release: (status, usage = {}) => {
        if (released) return;
        released = true; unpin(); controller.abort(); this.active.delete(requestId);
        const left = this.adapterCounts.get(adapterId) - 1;
        if (left) this.adapterCounts.set(adapterId, left); else this.adapterCounts.delete(adapterId);
        telemetry(this.sink, { ...meta, event: "attempt_finished", status, duration_ms: this.clock() - began, ...usage });
      },
    };
    try { unpin = this.media.bind(operation); } catch (error) { operation.release(error.code); throw error; }
    return operation;
  }
  prepareMedia(client, selection, signal) {
    return this.prepare(client, { ...selection, messages: [{ role: "user", content: "media" }] }, { signal });
  }
  mediaSelection(client, id) { const row = this.media.record(client, id, { expired: true }); return { adapter_id: row.adapter_id, profile: row.profile }; }
  uploadMedia(operation, stream, mime, size) { return this.media.upload(operation, stream, mime, size, this.#driver); }
  inspectMedia(operation, id, remove = false) { return this.media.inspect(operation, id, this.#driver, remove); }
  async generate(operation) { return this.#driver.generate(operation.context); }
  async count(operation) { return this.#driver.count(operation.context); }
  stream(operation) { return this.#driver.stream(operation.context); }
  drain(enabled) { this.draining = enabled; return this.status(); }
  async operatorDrain(enabled) {
    await this.audit?.record("drain_changed", { enabled });
    return this.drain(enabled);
  }
  async stop(graceMs = 30000) {
    this.stopped = true; clearTimeout(this.timer); this.draining = true;
    const deadline = Date.now() + graceMs;
    while (this.active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    for (const controller of this.active.values()) controller.abort();
  }
}
