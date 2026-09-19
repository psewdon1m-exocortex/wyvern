import { fault, WyvernError } from "./errors.js";
import { ID, KEY, HASH, object, fields, integer, endpoint, freeze } from "./util.js";

export const CONFIG_KEY = "wyvern.config.active";
export const CONFIG_SCHEMA = "exocortex.wyvern.config.v1";
export const LIMITS = Object.freeze({ max_concurrent: 16, request_timeout_ms: 120000,
  max_body_bytes: 1048576, max_response_bytes: 2097152, max_auth_stale_ms: 300000,
  reload_interval_ms: 15000, idle_stream_timeout_ms: 30000 });
const RANGES = { max_concurrent: [1, 256], request_timeout_ms: [100, 300000],
  max_body_bytes: [1024, 4194304], max_response_bytes: [1024, 4194304],
  max_auth_stale_ms: [1000, 3600000], reload_interval_ms: [1000, 300000], idle_stream_timeout_ms: [100, 120000] };
export const CAPABILITIES = ["text", "streaming", "structured_output", "token_count", "image", "pdf", "audio", "video", "youtube"];

export function validateConfig(input, { allowLoopback = false } = {}) {
  try {
    fields(input, ["schema", "instance_id", "runtime", "adapters", "clients"], ["schema", "instance_id", "adapters", "clients"]);
    if (input.schema !== CONFIG_SCHEMA || !ID.test(input.instance_id)) fault("configuration_invalid", 503);
    fields(input.runtime ?? {}, Object.keys(LIMITS));
    const runtime = { ...LIMITS, ...input.runtime };
    for (const [key, [min, max]] of Object.entries(RANGES)) if (!integer(runtime[key], min, max)) fault("configuration_invalid", 503);
    if (!object(input.adapters) || Object.keys(input.adapters).length > 16 ||
        !object(input.clients) || Object.keys(input.clients).length > 256) fault("configuration_invalid", 503);
    const adapters = Object.create(null);
    const credentialKeys = new Set();
    for (const [id, value] of Object.entries(input.adapters)) {
      fields(value, ["name", "driver", "endpoint", "credential_ref", "profiles", "enabled", "max_concurrent", "request_timeout_ms"], ["name", "driver", "credential_ref", "profiles", "enabled"]);
      if (!ID.test(id) || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 100 ||
          /[\x00-\x1f\x7f\x9b]/.test(value.name) || value.driver !== "google" || typeof value.enabled !== "boolean" ||
          typeof value.credential_ref !== "string" || !KEY.test(value.credential_ref) || !value.credential_ref.startsWith("wyvern.credentials.")) fault("configuration_invalid", 503);
      const base = endpoint(value.endpoint ?? "https://generativelanguage.googleapis.com", { allowLoopback, originOnly: true });
      if (new URL(base).hostname !== "generativelanguage.googleapis.com" &&
          !(allowLoopback && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname))) fault("configuration_invalid", 503);
      if (!object(value.profiles) || !Object.hasOwn(value.profiles, "default") || Object.keys(value.profiles).length > 8) fault("configuration_invalid", 503);
      const profiles = Object.create(null);
      for (const [profileId, profile] of Object.entries(value.profiles)) {
        fields(profile, ["model", "capabilities", "max_output_tokens", "temperature", "thinking_budget"], ["model", "capabilities", "max_output_tokens"]);
        if (!ID.test(profileId) || typeof profile.model !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(profile.model) ||
            !Array.isArray(profile.capabilities) || !profile.capabilities.includes("text") ||
            new Set(profile.capabilities).size !== profile.capabilities.length || profile.capabilities.some(item => !CAPABILITIES.includes(item)) ||
            !integer(profile.max_output_tokens, 1, 65536) ||
            (profile.temperature !== undefined && !(typeof profile.temperature === "number" && profile.temperature >= 0 && profile.temperature <= 2)) ||
            (profile.thinking_budget !== undefined && !integer(profile.thinking_budget, 0, 32768))) fault("configuration_invalid", 503);
        profiles[profileId] = { ...profile };
      }
      const concurrency = value.max_concurrent ?? runtime.max_concurrent;
      const timeout = value.request_timeout_ms ?? runtime.request_timeout_ms;
      if (!integer(concurrency, 1, runtime.max_concurrent) || !integer(timeout, 100, runtime.request_timeout_ms)) fault("configuration_invalid", 503);
      adapters[id] = { ...value, endpoint: base, profiles, max_concurrent: concurrency, request_timeout_ms: timeout };
      credentialKeys.add(value.credential_ref);
    }
    const clients = Object.create(null);
    const hashes = new Set();
    for (const [id, client] of Object.entries(input.clients)) {
      fields(client, ["token_sha256", "allowed_adapters", "bindings", "enabled", "requirements"], ["token_sha256", "allowed_adapters", "bindings", "enabled"]);
      if (!ID.test(id) || !HASH.test(client.token_sha256) || hashes.has(client.token_sha256) || typeof client.enabled !== "boolean" ||
          !Array.isArray(client.allowed_adapters) || client.allowed_adapters.length > 16 ||
          new Set(client.allowed_adapters).size !== client.allowed_adapters.length ||
          client.allowed_adapters.some(key => !Object.hasOwn(adapters, key)) ||
          !object(client.bindings) || Object.keys(client.bindings).length > 32) fault("configuration_invalid", 503);
      hashes.add(client.token_sha256);
      const requirements = client.requirements ?? {};
      if (!object(requirements) || Object.keys(requirements).length > 32) fault("configuration_invalid", 503);
      for (const [feature, capabilities] of Object.entries(requirements)) {
        if (!ID.test(feature) || !Array.isArray(capabilities) || capabilities.length > CAPABILITIES.length || capabilities.some(cap => !CAPABILITIES.includes(cap)) || new Set(capabilities).size !== capabilities.length) fault("configuration_invalid", 503);
      }
      for (const [feature, binding] of Object.entries(client.bindings)) {
        fields(binding, ["adapter_id", "profile"], ["adapter_id", "profile"]);
        if (!ID.test(feature) || !client.allowed_adapters.includes(binding.adapter_id) ||
            !Object.hasOwn(adapters[binding.adapter_id].profiles, binding.profile) ||
            Object.keys(requirements).length && !Object.hasOwn(requirements, feature) ||
            (requirements[feature] ?? []).some(cap => !adapters[binding.adapter_id].profiles[binding.profile].capabilities.includes(cap))) fault("configuration_invalid", 503);
      }
      clients[id] = client;
    }
    return freeze({ schema: CONFIG_SCHEMA, instance_id: input.instance_id, runtime, adapters, clients, credential_keys: [...credentialKeys].sort() });
  } catch (error) {
    if (error instanceof WyvernError) fault("configuration_invalid", 503);
    throw error;
  }
}
