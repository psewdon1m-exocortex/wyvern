# Implementation ledger

Development began on 2026-09-19 under the accepted integration plan v0.2. This is an unpublished development candidate, version 0.0.1; release/deployment readiness is not claimed.

## Implemented and verified

- Node.js 24 runtime; independent dependency lock; Google driver and Adapter-first client contract.
- Scoped caller identities, Adapter catalog and function bindings, body/output/concurrency/deadline limits.
- Generation, structural JSON Schema validation, countTokens, normalized SSE, client cancellation and drain.
- Kernel/Volt snapshot loading: register and Volt revision preconditions; one bounded batch for bundle and referenced credentials; atomic activation; last-known-good with a bounded authorization freshness window.
- Local admin/data socket separation and CLI status/version/health/preflight/reload/drain/config validation.
- Kernel machine principals with exact key grants, independent revocation, recoverable hash-only identity metadata and protection of Wyvern secret aliases from the shared legacy token.
- Updater TUI diagnostics for Adapters and client bindings; host-scoped reload/drain/resume with separate operator transport, durable jobs, host locking and idempotent request receipts.
- Bounded persistent operator audit and non-root, read-only container packaging; cold unconfigured diagnostics and cleanup after partial socket startup.

## Evidence recorded during development

- `npm run check`: syntax checks and 25 tests. Windows skips three POSIX-specific checks; Docker verification executes all 25 successfully without skips.
- `docker build --target verification -t wyvern-verification:local .`: passed on Linux with the pinned Node base image.
- `node scripts/verify-workspace.mjs <absolute-workspace>`: passed using real Wyvern, Kernel and Volt HTTP servers and disposable databases, with Google simulated. Verified generation, key rotation without a Register change, denial of the legacy token and absence of provider secrets in output/audit.
- Kernel `npm test`: all 41 tests passed, including four new machine-principal/revision tests.
- Updater `go test ./...`, `go vet ./...` and Linux binary build: passed. Focused `go test -race ./internal/api ./internal/console ./internal/tui`: passed in the existing Go 1.24 Debian container; WSL has no C compiler.
- Updater `scripts/test-tui-pty.py`: passed with the built Linux binary, including Wyvern Adapter/client diagnostics, unbound readiness, host-scope confirmation, durable receipt, resize and terminal restoration. Real Termius client acceptance remains separate.
- `node scripts/smoke-container.mjs wyvern-runtime:local`: passed with the actual production target, UID 10001, read-only root, no network and no provider credentials. Temporary container removed after verification.
- `npm audit --omit=dev --audit-level=high`: no vulnerabilities in the Wyvern dependency set at this check.

These results qualify the runtime foundation, not the remaining integrations or a published release. All provider requests so far use synthetic credentials and a local provider fixture.

## Remaining implementation gates

- Shared component install-or-reuse, enrollment, signed release packaging and Updater compatibility/update/rollback.
- Operator publication of Adapter configuration/keys; full TUI editing/enrollment forms and typed publication operations.
- Mastermind/Laboratory Settings cards, scoped binding mutation and migration of the existing clients.
- PDF/audio/video handles and their recovery/cleanup contract.
- Signed deployment packaging, backup/recovery qualification and Part 12 release evidence.
- Exact tested producer versions and published release artifacts. Local development images are not installation trust inputs.

## Concurrent workspace baseline

Mastermind already has unrelated UI/runtime changes; they must be retained. The current Kernel profile now tolerates and preserves additional Register records, so the older plan's observation that all extra keys were rejected is historical. A specific Wyvern configuration contract is still required; the baseline profile itself is not weakened by this work.
