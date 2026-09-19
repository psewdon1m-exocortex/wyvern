# Runtime API v1

This is the development contract implemented by 0.0.1. Default transport is a local Unix socket; no domain or public listener is required. An HTTPS ingress may be added through the host Nginx when an explicitly configured remote consumer needs it.

Data socket: `/run/wyvern/client.sock`. Every client API request uses its own `Authorization: Bearer` credential. Identity is never accepted from request metadata.

| Method / path | Meaning |
| --- | --- |
| GET /health/live | Process liveness and running version; no provider request |
| GET /health/ready | Configuration/auth freshness and drain state; no provider request |
| GET /v1/client | Own bindings, allowed Adapter catalog, per-function readiness |
| POST /v1/generate | Adapter/profile or own function binding; normalized result or SSE |
| POST /v1/count-tokens | Count against the selected concrete model |

Request fields: `adapter_id`, optional `profile` (default), alternatively `function` from the caller's configured bindings, `messages`, optional `options`, `response_format`, `stream`, `metadata`. Unknown top-level fields are rejected. A function plus a conflicting Adapter/profile is rejected. No provider URL, raw credential or remote model override is accepted.

Messages currently carry string content and roles system/user/assistant. A system message, when present, is first and unique. Media and tools are separate pending gates; they are not silently discarded. Output contains request ID, target Adapter/profile/driver/model, configuration generation, attempts, normalized message, finish reason and usage. Missing token counts are null, not invented zeroes.

Structural JSON Schema supports bounded objects, arrays, enums, numeric/string bounds, compositions and acyclic local definitions. Remote/recursive references and regex vocabulary are rejected. Structured streaming is currently explicitly unsupported; non-streaming structured output is validated before delivery.

SSE events: `request.created`, `output.delta`, `request.completed`, `request.failed`. A broken stream produces a terminal failure; no retry follows a content delta. Client disconnect cancels the provider connection. Every request currently performs at most one provider attempt.

Admin socket: `/run/wyvern-admin/admin.sock`, mode 0600 in a distinct directory that must never be mounted into client containers. GET `/v1/status`, `/v1/preflight` and `/v1/catalog`; POST `/v1/reload`; POST `/v1/drain` with `{"enabled":true|false}`. Catalog contains Adapter/profile/model/capability and client-binding metadata, never credentials, token hashes or Volt references. These routes are absent from the data server. Configuration publication is not yet an admin endpoint.

Bootstrap JSON contains `kernel_origin`, `kernel_credential_file`, optional `config_key`, `client_socket`, `admin_socket`. It contains no provider key. Default configuration key is `wyvern.config.active`; independent hosts can use `wyvern.instances.<id>.config`. The Kernel principal must allow that key and the exact credential keys referenced by the bundle.

A missing bootstrap file starts an unconfigured process with working diagnostics and `ready=false`. Initial bootstrap provisioning requires a process restart; ordinary configuration/key changes use reload. Invalid explicit bootstrap syntax fails startup. A failed second socket bind closes the first socket without removing another process's endpoint.

The production CLI records configuration activations and drain changes in `/var/lib/wyvern/audit` (two rotating JSONL files, up to 512 KiB each, 128 queued entries). Audit failure rejects the mutation. These are bounded diagnostic records, not billing state or a configuration backup. Mount that directory on persistent host storage in production; the isolated smoke test uses temporary storage deliberately.

The shared Updater TUI uses its root-only operator listener: GET `/v1/wyvern` for diagnostics and POST `/v1/actions` with `component=wyvern`, `kind=reload|drain|resume`, and a stable `request_id`. No head identity, path, command, key or version is accepted for these host controls. Accepted actions use existing durable jobs and the host operation lock. A lost response is resolved by looking up the job, without automatically repeating the mutation. Daemon interruption follows the existing failed/interrupted job reconciliation; current Wyvern status must then be inspected.

Provider protocol references: [Google generation API](https://ai.google.dev/api/generate-content) and [Google Files API](https://ai.google.dev/api/files). Files support remains an implementation gate; the reference is not a claim of completed media migration.
