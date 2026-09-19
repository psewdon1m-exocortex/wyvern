# Functional corrections after the compliance audit — 2026-09-19

Baseline: [the original audit](compliance-review-2026-09-19.md). The owner explicitly
excluded Settings/Initialize/operation-observation/version/update cards for
Wyvern itself because it has no interface, and deferred decorative work.
This ledger records functional corrections, not a production qualification.

| Audit finding | Correction and evidence |
| --- | --- |
| W01 — premature release discovery | [Publisher](../scripts/publish-release.py) stages a prerelease and promotes only after anonymous asset/image verification and final receipts. Bootstrap and Updater reject prereleases on new installation. Failure/promotion regression tests pass. |
| W02 — unbounded deployment logs | Updater emits explicit Docker 10m × 3 rotation and an isolated volatile journal with byte, age and rate limits. Real Docker overflow test and a disposable systemd 255 namespace rehearsal pass. |
| W03 — signing-secret lifetime | [One-process signer](../scripts/sign-ephemeral.mjs) uses memory only and exits before uploads. Its job has read-only repository permissions; publication runs separately. RSA signature, public-pin mismatch and no-private-file tests pass. |
| W04 — no common applicability gate | [Pre-push](../scripts/pre-push.py), [seven-area profile](verification-profile.json), [exposure inventory](exposure-inventory.json) and immutable Part 12 pin are used by CI/candidate workflows. The 97 active catalog IDs and local links are linted; deployment readiness stays explicit. |
| W05 — source-only evidence and supply-chain gaps | [Candidate contract](../scripts/release_contract.py) hashes the complete artifact set; receipts bind its exact digest. Candidate workflow emits SPDX/provenance attestations, verified before signing. Source, archive/all-layer secrets, dependencies and image vulnerabilities are gated. Actions and image/scanner references are immutable. Same-source artifact replacement and stale policy fail tests. Real GitHub attestation production remains a release-time check. |
| W06 — incomplete observability | Structured redaction and correlated auth/authz/error/binding/media events; audit count/bytes/30-day age limits, restart and idle pruning. Negative logging, mixed-age cleanup, unsafe-file and audit-failure regressions pass. |
| W07 — anonymous version disclosure | Anonymous health returns state only; private admin diagnostics retain version. HTTP boundary test passes. |
| W08 — web lifecycle cards | Excluded by the owner's explicit instruction. Existing consumer binding controls and shared TUI remain the functional entry points. |
| W09 — consumer backup loses Adapter intent | Mastermind logical metadata and Laboratory backup v4 preserve only own scope/function/Adapter/profile choices. Clean restore, pending inference denial, no shared writes, missing configured link and legacy retention are tested. No provider credentials or link tokens enter these records. |
| W10 — stale completion/docs claims | [Implementation status](IMPLEMENTATION.md), [operations](operations.md), [release contract](releasing.md), consumer recovery guidance and embedded connection documentation now describe current behavior and external gates. |

Validation commands and counts are in [implementation status](IMPLEMENTATION.md).
The full local gate is `python3 scripts/pre-push.py --working-tree --workspace /path/to/exocortex`;
its report is development evidence with source digest and retained command/scan
outputs, never a fabricated release certificate.

The new runtime base replaced the old vulnerable base and removed unnecessary
npm/yarn tooling from the runtime stage. The checked image passed the current
HIGH/CRITICAL vulnerability and secret policy without suppression exceptions.

Full production installation, signed GitHub publication, live provider, external
ingress and mobile TUI acceptance were not performed. They need real compatible
published dependencies, protected signing configuration, exact-candidate Part 12
receipts and the intended host. These checks remain release/deployment gates.
Laboratory v4 archives require the updated application; retain pre-update backups
for rollback to old versions.
