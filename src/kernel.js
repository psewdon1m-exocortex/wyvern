import { fault } from "./errors.js";
import { canonical, endpoint, hash, object, readBody } from "./util.js";
import { CONFIG_KEY, validateConfig } from "./config.js";

export class Kernel {
  constructor({ origin, token, fetchImpl = globalThis.fetch, allowLoopback = false, configKey = CONFIG_KEY }) {
    this.origin = endpoint(origin, { allowLoopback, originOnly: true });
    this.token = token;
    this.fetch = fetchImpl;
    this.allowLoopback = allowLoopback;
    if (configKey !== CONFIG_KEY && !/^wyvern\.instances\.[a-z][a-z0-9_-]{0,63}\.config$/.test(configKey)) fault("configuration_invalid", 503);
    this.configKey = configKey;
  }
  async resolve(keys, expected = {}) {
    const signal = AbortSignal.timeout(10000);
    try {
      const response = await this.fetch(this.origin + "/api/v1/register/resolve", {
        method: "POST", redirect: "error", signal,
        headers: { "Authorization": "Bearer " + await this.token(), "Content-Type": "application/json", "Accept-Encoding": "identity" },
        body: JSON.stringify({ keys, ...expected }),
      });
      if (response.status === 409) fault("configuration_conflict", 409);
      if (response.status !== 200) fault("kernel_unavailable", 503);
      const data = JSON.parse((await readBody(response.body, 1048576, signal)).toString("utf8"));
      if (data?.schema !== "exocortex.register.resolution.v1" || typeof data.register_revision !== "string" || !object(data.values)) fault("configuration_invalid", 503);
      for (const key of keys) {
        const item = data.values[key];
        if (!item || typeof item.value !== "string" || Buffer.byteLength(item.value) > 262144 ||
            typeof item.secret !== "boolean" || !Number.isSafeInteger(item.volt_revision) || item.volt_revision < 1) fault("configuration_invalid", 503);
      }
      return data;
    } catch (error) {
      if (["configuration_invalid", "configuration_conflict"].includes(error?.code)) throw error;
      fault("kernel_unavailable", 503);
    }
  }
  async snapshot() {
    const CONFIG_KEY = this.configKey;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const first = await this.resolve([CONFIG_KEY]);
        let parsed;
        try { parsed = JSON.parse(first.values[CONFIG_KEY].value); } catch { fault("configuration_invalid", 503); }
        const config = validateConfig(parsed, { allowLoopback: this.allowLoopback });
        const complete = await this.resolve([CONFIG_KEY, ...config.credential_keys], {
          expected_register_revision: first.register_revision,
          expected_volt_revisions: { [CONFIG_KEY]: first.values[CONFIG_KEY].volt_revision },
        });
        if (complete.register_revision !== first.register_revision || complete.values[CONFIG_KEY].volt_revision !== first.values[CONFIG_KEY].volt_revision ||
            complete.values[CONFIG_KEY].value !== first.values[CONFIG_KEY].value) fault("configuration_conflict", 409);
        const credentials = new Map();
        const revisions = {};
        for (const [key, item] of Object.entries(complete.values)) {
          revisions[key] = item.volt_revision;
          if (key !== CONFIG_KEY) {
            if (!item.secret || item.value.length < 1 || Buffer.byteLength(item.value) > 4096 || /[\r\n\0]/.test(item.value)) fault("configuration_invalid", 503);
            credentials.set(key, item.value);
          }
        }
        const generation = hash(canonical({ register: complete.register_revision, revisions }));
        return { config, credentials, generation, register_revision: complete.register_revision, config_revision: complete.values[CONFIG_KEY].volt_revision };
      } catch (error) {
        if (error.code !== "configuration_conflict" || attempt === 2) throw error;
      }
    }
  }
  async changeBindings(instance, client, bindings, expectedRevision, requestId) {
    const signal = AbortSignal.timeout(15000);
    try {
      const response = await this.fetch(this.origin + "/api/v1/wyvern/" + instance + "/mutations", {
        method: "POST", redirect: "error", signal, headers: { Authorization: "Bearer " + await this.token(), "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "bind", client_id: client, bindings, expected_revision: expectedRevision, request_id: requestId }),
      });
      await readBody(response.body, 524288, signal);
      if (response.status === 409) fault("configuration_conflict", 409);
      if (response.status === 400 || response.status === 403) fault("permission_denied", 403);
      if (!response.ok) fault("kernel_unavailable", 503);
    } catch (error) {
      if (["configuration_conflict", "permission_denied"].includes(error.code)) throw error;
      fault("kernel_unavailable", 503);
    }
  }
}
