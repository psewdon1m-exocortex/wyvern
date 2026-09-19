# Development acceptance — 2026-09-19

This record covers the completed source integration in the accepted v0.2 plan. See IMPLEMENTATION.md for results and release gates. It is not release qualification, producer-version certification or evidence of a production deployment.

| Area / central authority | Evidence and status |
| --- | --- |
| API / configuration | PASS for text generation, countTokens, structured JSON, SSE and captured snapshots. Explicit bounds, deadlines, cancellation, no retries after partial output and no caller-supplied provider endpoint. Media handles, YouTube parts and scoped transactional configuration publication are implemented and fixture-tested. |
| Identity / Part 07 | PASS for exact Kernel grants, protected secret aliases, independent revocation, request identity enforcement, admin/data separation, unknown-field denial and output redaction. General legacy-key migration remains outside this increment. |
| Persistence / Parts 02–03 | PASS for hash-only principal recovery metadata, bounded metadata audit and existing Updater durable job semantics. Wyvern has no offline secret/config cache. Encrypted host recovery and fixed external-state deployment rollback/repair are tested with injected host commands. |
| Deployment / Parts 04–05 | PASS for the local pinned runtime image: non-root UID, read-only root, no-network cold-start smoke, explicit unconfigured readiness. Signed bootstrap and install-or-reuse are implemented and fixture-tested; production releases remain unpublished. |
| Operator interface / Parts 01, 09–10 | PASS for the shared TUI's Adapter/client diagnostics, reload/drain/resume, shared-impact confirmation, job receipts, offline behavior, terminal sanitization and real PTY input/resize/restoration. Masked Kernel/Adapter forms, enrollment, grants and both consumer Settings cards are implemented and tested. |
| Tests / Parts 06, 12 | 32 Wyvern Linux tests; 41 Kernel unit/API tests; full Updater Go suite and vet; targeted Go race tests; runtime-image smoke; actual Wyvern → Kernel → Volt HTTP integration with a simulated Google API. No full Part 12 release gate or production qualification is claimed. |
| Public SEO/GEO / Part 08 | N/A: no public/indexable content or new TCP listener is introduced. |

## Reproduce the changed-boundary checks

In Wyvern:

```sh
npm ci
npm run check
python3 -m unittest discover -s packaging -p 'test_*.py'
docker build --target verification -t wyvern-verification:local .
docker build --target runtime -t wyvern-runtime:local .
node scripts/smoke-container.mjs wyvern-runtime:local
node scripts/verify-workspace.mjs /absolute/path/to/exocortex
node scripts/verify-consumers.mjs /absolute/path/to/exocortex /path/to/mastermind/python
```

The workspace integration check is explicitly opt-in and needs the neighboring Kernel/Volt checkouts and their installed dependencies. Independent Wyvern CI does not import those sources. Windows skips three POSIX checks; Docker runs all 32.

In Kernel and Volt: `npm test`. In Laboratory: `npm --prefix services/api test`. The Mastermind full pytest suite needs the Worker dependency image, including PDF/browser extractors; the Core image alone is insufficient. In Updater on Linux with the declared Go toolchain:

```sh
go test ./...
go vet ./...
CGO_ENABLED=1 go test -race ./internal/api ./internal/component ./internal/console ./internal/tui ./internal/hostrecovery
CGO_ENABLED=0 go build -trimpath -o /tmp/updater-wyvern-dev ./cmd/updater
python3 scripts/test-tui-pty.py /tmp/updater-wyvern-dev
```

The race detector needs a C compiler. Its Windows-hosted qualification ran in the already available `golang:1.24-bookworm` container, with the checkout mounted read-only. PTY tests use synthetic demo operations; actual Termius desktop/mobile acceptance is separate.

## Rollback and compatibility boundaries

- No running production service was migrated. Both consumer transports now use Wyvern in source. Unrelated Mastermind changes were preserved. All provider fixtures are synthetic; real systemd update/recovery, ingress and live-provider acceptance remain external gates.
- Reverting the TUI increment removes the new operator view/actions while retaining the existing Updater job format. Interrupted jobs follow existing reconciliation, and a lost action response requires status inspection rather than automatic replay.
- Reverting Kernel scoped-principal enforcement while Wyvern secrets remain registered would restore legacy access to those values. Therefore a security rollback must first remove protected bindings/disable dependent clients or retain the enforcement patch; it is not a blind binary rollback.
- Provider keys used in tests are synthetic. No live LLM request, signing-key creation, trust enrollment, commit, push, release or production installation was performed by this increment.
