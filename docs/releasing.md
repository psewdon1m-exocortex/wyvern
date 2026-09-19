# Signed release qualification

Release preparation, signing and publication are separate operations. The
candidate is built once; no image or installer is rebuilt during the release.
Local green tests are not a completed Part 12 qualification or a production
deployment.

## Reproducible source gate

On a Linux operator computer, WSL or CI runner, from this repository:

```sh
python3 scripts/pre-push.py
```

This requires Node 24, Python 3.11+, Git, OpenSSL, Docker and network access for
the reviewed policy/dependency vulnerability databases. The command validates
all seven areas in `docs/verification-profile.json`, the route exposure inventory,
current project documentation, immutable CI actions and the pinned Part 12
catalog. It runs runtime and packaging regressions, source and all-image-layer
secret scans, npm audit, container isolation smoke and the HIGH/CRITICAL image
vulnerability policy. CI repeats this same command.

For uncommitted development changes use `--working-tree`. Its report records a
digest of all source bytes and explicitly says `development`; it cannot serve
as release qualification. Source changes during the run fail the gate. Reports
and bounded command logs are written to `artifacts/`. `--workspace /path/to/exocortex`
also exercises the local Kernel/Volt chain and Updater component/recovery tests;
`WYVERN_GO` can select the workspace Go executable.

## Candidate, evidence, signing and publication

1. Publish compatible qualified Kernel/Volt and Updater releases first. Updater
   0.6.0 must contain the intended Wyvern public trust pin. The signed Updater
   archive is verified using `.release/updater-public-key.pem` before any
   executable dependency is run. None of these operations receives Wyvern's
   private key.
2. On the exact intended `main` commit, dispatch `.github/workflows/candidate.yml`.
   It runs the source gate, builds/pushes a uniquely named OCI candidate with
   BuildKit SBOM/provenance, tests the exact digest, scans it, builds the pinned
   unsigned installer/bootstrap and creates GitHub provenance/SBOM attestations.
   It retains `wyvern-candidate-<SHA>` and its check logs. An image in GHCR alone
   is not an installable Wyvern release.
3. Evaluate every active Part 12 ID against this exact candidate. The separate
   acceptance process retains the real command receipts and logs in
   `wyvern-qualification-<SHA>` in a successful same-repository workflow run.
   Set `WYVERN_CANDIDATE_RUN_ID` and `WYVERN_QUALIFICATION_RUN_ID` to those exact
   successful producer runs. Missing evidence remains a blocker; unit-test
   fixture reports are not accepted as real release qualification.
4. Push `wyvern-v<package version>` pointing to that same current `main` commit.
   The release workflow validates producer identity, source, reviewed policy,
   every candidate file digest and every qualification receipt. It verifies
   image attestations against the trusted candidate workflow and source SHA,
   and scans the candidate again before opening the signing environment.
5. Only the `sign` job receives `WYVERN_RELEASE_PRIVATE_KEY` from the protected
   `release` environment. It has no content/package publication permission.
   A single Node process reads the key in memory, verifies its public counterpart
   against the already pinned public key, signs and exits. There is no temporary
   private-key file. Output signature verification and scans happen after that
   process exits and before artifact upload.
6. The separate `publish` job has no signing secret. It creates a **prerelease**,
   downloads the complete asset set anonymously, checks exact bytes/signature,
   pulls the OCI image with an empty Docker credential configuration, checks
   remote main/tag identity, closes final Part 12 checks, and uploads the complete
   report/evidence. Only then does it clear `prerelease` and move `latest`.

Failed final verification leaves a non-installable prerelease. Discovery and
explicit updates exclude it. Standalone bootstrap and Updater's embedded
manifest-install path also query the canonical GitHub release state and reject
draft/prerelease/unavailable versions. Consequently an initial online install
needs GitHub release API availability in addition to its signed downloads and
OCI registry. Existing runtime service does not depend on this API.

A retry of staging checks the existing candidate bytes without overwriting
them. An already final release cannot be republished by this command. Keep
release assets and their evidence for the full version support lifetime;
90-day workflow artifact retention is only staging retention.

## Evidence identity

`.release/policy.json` pins the reviewed central documentation revision and
catalog SHA-256. Advancing this pin is an explicit source change. An older
catalog chosen by an evidence file cannot override it.

`candidate.json` binds source SHA, version, image digest, policy and hashes of
the installer, unsigned manifest, bootstrap, public key, SPDX SBOM and image
attestation bundles. The known-problems report and each execution receipt must
include the SHA-256 of these exact `candidate.json` bytes as `candidate_sha256`.
Different artifact bytes on the same source commit are a different candidate.

`known-problems-report.json` requires schema version 1, service `wyvern`, the
full source `revision`, `release_tag`, `candidate_sha256`, the central
`catalog_repository`, `catalog_path`, pinned `catalog_revision` and
`catalog_sha256`, and one classification per active ID. `PASS` references
bounded evidence JSON and real execution logs with SHA-256 hashes. `N/A`
requires a concrete reason, inspected paths and the Wyvern release profile.
Missing/duplicate IDs, `FAIL`, `UNKNOWN`, stale policy/source/candidate or
changed logs prevent access to the signing key.

Only REL-06 and REL-09 may be `DEFERRED` before signing, with
`required_phase: "final"` and the signature/download-specific reason. Every
receipt contains `schema: "wyvern.verification.v1"`, source/candidate/catalog
identity, applicable `problem_ids`, executed `command`, `exit_code: 0`, `log`
and `log_sha256`. All paths are bounded ordinary files within the evidence
bundle. Never manufacture a receipt for an unperformed check.

```sh
python3 scripts/verify-qualification.py --assets /path/to/candidate --bundle /path/to/evidence --revision FULL_SHA --tag wyvern-v0.0.1
```

Actual DNS/TLS, real host installation/recovery, operator enrollment, provider
quota/model behavior and Termius remain separate deployment-readiness checks.
Synthetic qualification can establish artifact behavior without provider
credentials; it does not establish the readiness of an actual installation.

The pipeline uses [GitHub attestation verification](https://cli.github.com/manual/gh_attestation_verify)
with both producer workflow and source identity, and explicit
[Docker log rotation](https://docs.docker.com/engine/logging/drivers/json-file/).
