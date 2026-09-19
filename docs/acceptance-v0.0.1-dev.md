# Development acceptance — 2026-09-19

This record covers the runtime/security/TUI increment in the accepted v0.2 plan. It is not release qualification, producer-version certification or evidence of a production deployment.

| Area / central authority | Evidence and status |
| --- | --- |
| API / configuration | PASS for text generation, countTokens, structured JSON, SSE and captured snapshots. Explicit bounds, deadlines, cancellation, no retries after partial output and no caller-supplied provider endpoint. Media and configuration publication remain pending. |
| Identity / Part 07 | PASS for exact Kernel grants, protected secret aliases, independent revocation, request identity enforcement, admin/data separation, unknown-field denial and output redaction. General legacy-key migration remains outside this increment. |
| Persistence / Parts 02–03 | PASS for hash-only principal recovery metadata, bounded metadata audit and existing Updater durable job semantics. Wyvern has no offline secret/config cache. Full shared-component recovery and signed-release rollback remain pending. |
| Deployment / Parts 04–05 | PASS for the local pinned runtime image: non-root UID, read-only root, no-network cold-start smoke, explicit unconfigured readiness. Signed bootstrap, automatic install-or-reuse and compatible published releases remain pending. |
| Operator interface / Parts 01, 09–10 | PASS for the shared TUI's Adapter/client diagnostics, reload/drain/resume, shared-impact confirmation, job receipts, offline behavior, terminal sanitization and real PTY input/resize/restoration. Adapter editing, enrollment and consumer Settings cards remain pending. |
| Tests / Parts 06, 12 | 25 Wyvern Linux tests; 41 Kernel unit/API tests; full Updater Go suite and vet; targeted Go race tests; runtime-image smoke; actual Wyvern → Kernel → Volt HTTP integration with a simulated Google API. No full Part 12 release gate or production qualification is claimed. |
| Public SEO/GEO / Part 08 | N/A: no public/indexable content or new TCP listener is introduced. |

## Reproduce the changed-boundary checks

In Wyvern:

```sh
npm ci
npm run check
docker build --target verification -t wyvern-verification:local .
docker build --target runtime -t wyvern-runtime:local .
node scripts/smoke-container.mjs wyvern-runtime:local
node scripts/verify-workspace.mjs /absolute/path/to/exocortex
```

The workspace integration check is explicitly opt-in and needs the neighboring Kernel/Volt checkouts and their installed dependencies. Independent Wyvern CI does not import those sources. Windows skips three POSIX checks; Docker runs all 25.

In Kernel: `npm test`. In Updater on Linux with the declared Go toolchain:

```sh
go test ./...
go vet ./...
CGO_ENABLED=1 go test -race ./internal/api ./internal/console ./internal/tui
CGO_ENABLED=0 go build -trimpath -o /tmp/updater-wyvern-dev ./cmd/updater
python3 scripts/test-tui-pty.py /tmp/updater-wyvern-dev
```

The race detector needs a C compiler. Its Windows-hosted qualification ran in the already available `golang:1.24-bookworm` container, with the checkout mounted read-only. PTY tests use synthetic demo operations; actual Termius desktop/mobile acceptance is separate.

## Rollback and compatibility boundaries

- No running production service or consumer transport was migrated. Mastermind's unrelated working-tree changes remain intact; Laboratory's provider transport remains intact.
- Reverting the TUI increment removes the new operator view/actions while retaining the existing Updater job format. Interrupted jobs follow existing reconciliation, and a lost action response requires status inspection rather than automatic replay.
- Reverting Kernel scoped-principal enforcement while Wyvern secrets remain registered would restore legacy access to those values. Therefore a security rollback must first remove protected bindings/disable dependent clients or retain the enforcement patch; it is not a blind binary rollback.
- Provider keys used in tests are synthetic. No live LLM request, signing-key creation, trust enrollment, commit, push, release or production installation was performed by this increment.
