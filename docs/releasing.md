# Signed release qualification

The release workflow only publishes `wyvern-v<package version>` from current
`main`. Ordinary CI has no publication permissions. Runtime tests, packaging
tests and the actual runtime image smoke run before the signing environment is
available. The tested Docker image is transferred as an immutable workflow
artifact and pushed without rebuilding.

## Required external inputs

- A qualified signed Updater 0.6.0 release, pinned by
  `.release/updater-public-key.pem`, whose trust bundle contains the intended
  Wyvern public key. Updater must receive that public key before its own release.
- `WYVERN_RELEASE_PRIVATE_KEY` in the protected `release` environment. Its
  derived public key must exactly match the verified Updater trust bundle.
- Repository variable `WYVERN_QUALIFICATION_RUN_ID`: a successful qualification
  run in this repository on the exact release commit. That run must retain an
  artifact named `wyvern-qualification-<full source SHA>` containing the reviewed
  Part 12 report and its referenced execution receipts/logs. The release job
  checks the run's repository, commit and success before downloading it.

The qualification artifact is produced by the deployment/recovery acceptance
process, separately from the ordinary unit suite. It must not contain secrets,
private hostnames or raw provider request bodies. Missing evidence blocks
publication; local test success never substitutes for an unperformed case.

## Qualification artifact contract

`known-problems-report.json` contains `schema_version: 1`, `service: "wyvern"`,
the full `revision`, exact `release_tag`,
`catalog_repository: "https://github.com/psewdon1m-exocortex/general"`,
`catalog_path: "PART_12_KNOWN_DEPLOYMENT_AND_OPERATIONS_PROBLEMS.md"`, immutable
`catalog_revision`, exact `catalog_sha256`, and `checks` covering every active
catalog ID once. The verifier downloads the catalog from that immutable SHA.

Each classification is `PASS` with nonempty `evidence` entries (`path`, `sha256`)
or `N/A` with a concrete reason of at least 50 characters, existing
`inspected_paths`, and `profile: "exocortex.wyvern.release.v1"`. `FAIL`, `UNKNOWN`,
missing/duplicate IDs, changed logs and other source revisions block signing.
Only REL-06 and REL-09 may be `DEFERRED`, with `required_phase: "final"` and a
reason explaining why published signatures/anonymous downloads are needed.

Every evidence JSON contains `schema: "wyvern.verification.v1"`, matching
`revision` and `catalog_sha256`, `status: "PASS"`, applicable `problem_ids`, the
executed `command`, integer `exit_code: 0`, artifact-relative `log` and exact
`log_sha256`. Files are bounded, ordinary files inside the artifact directory;
links, parent traversal and duplicate JSON keys are rejected. These receipts
record real executions; filling their fields manually is not qualification.

Run the same gate locally with:

```sh
python3 scripts/verify-qualification.py --bundle /path/to/evidence --revision FULL_SOURCE_SHA --tag wyvern-v0.0.1
```

## Publication and failure

The workflow initially creates the signed release with `latest=false`, downloads
all installer assets anonymously, compares the exact built bytes, verifies the
signature/archive checksum, and rechecks remote main/tag identity. It replaces
the two deferred classifications with execution evidence, verifies the complete
report, and uploads that report plus its evidence archive before setting latest.
If final verification fails, the release is not promoted; investigate the failed
run and retained candidate without treating its existence as qualification.

Production activation is separate from release qualification. DNS/TLS, actual
installed producer versions, real provider quota/model behavior and Termius
acceptance remain explicitly unperformed until their operator checks run.
