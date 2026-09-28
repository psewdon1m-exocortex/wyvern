"""Produce exact-candidate synthetic release evidence without claiming deployment readiness."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_contract as contract

qualification_spec = importlib.util.spec_from_file_location(
    "verify_qualification", Path(__file__).resolve().parent / "verify-qualification.py"
)
gate = importlib.util.module_from_spec(qualification_spec)
qualification_spec.loader.exec_module(gate)


NOT_APPLICABLE = {
    "BST-08": ("Wyvern has no interactive login or operator-known access key; its scoped machine identities are provisioned by Kernel and Updater.", ["docs/operations.md", "src/kernel.js"]),
    "BST-13": ("Wyvern does not accept or generate an operator login Access Key, so login-key character and strength restrictions are outside this release profile.", ["docs/operations.md", "docs/decisions.md"]),
    "TRUST-01": ("Wyvern does not implement SSH or SFTP transport, so no release-signing identity can be reused as an SSH or SFTP credential.", ["docs/exposure-inventory.json", "src/server.js"]),
    "TRUST-02": ("Wyvern has no SSH or SFTP client and therefore has no trust-on-first-use host-key path in the release artifact.", ["docs/exposure-inventory.json", "package.json"]),
    "CTR-01": ("The default Wyvern release exposes Unix sockets and publishes no host TCP port; optional remote ingress is operator-owned outside this artifact.", ["docs/exposure-inventory.json", "Dockerfile"]),
    "CTR-05": ("Wyvern has one runtime container and no Compose health dependency or startup-order graph to coordinate inside this release.", ["Dockerfile", "docs/operations.md"]),
    "CTR-06": ("The default release has no published host port or service-owned reverse proxy; its socket health is exercised directly by the runtime smoke.", ["docs/exposure-inventory.json", "Dockerfile"]),
    "HLT-03": ("Wyvern ships no remote monitor configuration; optional remote consumers use the documented authenticated API rather than a bundled monitor.", ["docs/exposure-inventory.json", "docs/operations.md"]),
    "HLT-04": ("Wyvern has no dashboard metric that converts an absent measurement into zero; diagnostics expose explicit nullable state instead.", ["src/runtime.js", "docs/api.md"]),
    "HLT-05": ("Wyvern does not publish an uptime metric or substitute host, proxy, database, or Updater uptime in its status contract.", ["src/runtime.js", "docs/api.md"]),
    "HLT-06": ("Wyvern does not publish CPU or RAM utilization metrics, so it cannot confuse process and host resource scopes.", ["src/runtime.js", "docs/api.md"]),
    "HLT-07": ("Wyvern has no external storage reachability probe; provider media operations are tested through their actual upload and delete paths.", ["src/media.js", "docs/api.md"]),
    "HLT-10": ("Wyvern does not report disk-usage capacity from a container overlay, host root, or authoritative storage filesystem.", ["src/runtime.js", "docs/api.md"]),
    "INT-03": ("Wyvern enrollment uses scoped durable identities and no one-time setup-code pipeline, so setup-code reuse cannot occur in this profile.", ["docs/operations.md", "src/kernel.js"]),
    "INT-04": ("Wyvern does not create project/server mirror pipelines or unique storage roots; consumers receive distinct scoped client identities.", ["docs/decisions.md", "src/runtime.js"]),
    "INT-05": ("Wyvern owns no UI registry record with an active/revoked uniqueness lifecycle; identity revocation remains in authoritative Kernel state.", ["docs/decisions.md", "src/kernel.js"]),
    "INT-08": ("Wyvern does not infer service endpoints from DNS or neighboring environment files; its authoritative Kernel origin is explicit configuration.", ["docs/operations.md", "src/config.js"]),
    "INT-09": ("Wyvern exposes a typed API and administrative CLI, not a shared conversational command gateway or provider command menu.", ["docs/api.md", "bin/wyvern.js"]),
    "INT-10": ("Wyvern registers no webhook or provider callback, so there is no callback activation before DNS, TLS, ingress, or readiness.", ["docs/exposure-inventory.json", "src/server.js"]),
    "INT-11": ("Wyvern has no webhook ping or event-delivery pipeline; its consumer integration is exercised by authenticated end-to-end requests.", ["docs/exposure-inventory.json", "scripts/verify-consumers.mjs"]),
    "DATA-05": ("Wyvern owns no generic storage health probe; media qualification performs the real bounded provider upload, inspect, use, and delete operations.", ["src/media.js", "tests/media.test.js"]),
    "DATA-06": ("Wyvern does not own a backup archive pipeline; host recovery is owned by Updater and is explicitly separate from this artifact qualification.", ["docs/operations.md", "docs/decisions.md"]),
    "DATA-07": ("Wyvern does not allocate a shared remote storage root for multiple systems; local media records are scoped by client identity.", ["src/media.js", "docs/decisions.md"]),
    "DATA-08": ("Wyvern has no backup token or archive credential; scoped client and runtime identities are covered by the integration checks instead.", ["docs/operations.md", "src/kernel.js"]),
    "DATA-09": ("Wyvern does not schedule backups or expose desired/applied backup revisions; that lifecycle belongs to the backup producer.", ["docs/operations.md", "docs/decisions.md"]),
    "DATA-10": ("Wyvern does not claim or configure a second backup copy or independent backup failure domain in this release profile.", ["docs/operations.md", "docs/decisions.md"]),
    "OPS-07": ("Wyvern has no method-specific webhook or callback endpoint; authenticated API methods are exercised directly by the runtime tests.", ["docs/exposure-inventory.json", "src/server.js"]),
}

# The release owns no public ingress. These checks remain deployment-specific
# even when an operator elects to add the optional remote-consumer Nginx route.
for identifier in [f"NET-{number:02d}" for number in range(1, 13)]:
    NOT_APPLICABLE[identifier] = (
        "The default Wyvern release is Unix-socket-only and owns no public domain, TLS certificate, firewall, Nginx vhost, proxy buffering, or static web route; optional ingress is a separate deployment-readiness check.",
        ["docs/exposure-inventory.json", "docs/operations.md", "Dockerfile"],
    )


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, log, *, cwd):
    began = time.monotonic()
    rendered = " ".join(str(part) for part in command)
    with log.open("ab") as output:
        output.write(("\n$ " + rendered + "\n").encode())
        result = subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
        output.write((f"[exit={result.returncode} seconds={time.monotonic() - began:.2f}]\n").encode())
    if result.returncode:
        raise RuntimeError("Qualification command failed: " + rendered)


def main(args):
    root = Path(__file__).resolve().parents[1]
    args.bundle.mkdir(parents=True, exist_ok=True)
    policy = contract.policy()
    catalog = contract.catalog_bytes(policy)
    identifiers = contract.lint_catalog(catalog, policy)
    candidate, candidate_sha256 = contract.verify_candidate(args.assets, args.revision, policy)
    contract.require(args.tag == "wyvern-v" + candidate["version"], "Candidate version differs from tag")
    contract.require(set(NOT_APPLICABLE).issubset(identifiers), "Qualification profile refers to inactive policy IDs")
    passed = [item for item in identifiers if item not in NOT_APPLICABLE and item not in gate.FINAL_ONLY]
    log = args.bundle / "qualification.log"
    log.write_text("Wyvern exact-candidate synthetic qualification\n", encoding="utf-8")
    commands = [
        (["npm", "run", "check"], root),
        ([sys.executable, "-m", "unittest", "discover", "-s", "packaging", "-p", "test_*.py"], root),
        ([sys.executable, "scripts/security-scan.py", "--source"], root),
        (["npm", "audit", "--omit=dev", "--audit-level=high"], root),
        ([sys.executable, "scripts/release_contract.py", "verify", "--assets", str(args.assets), "--revision", args.revision], root),
        (["docker", "pull", candidate["image"]], root),
        (["node", "scripts/smoke-container.mjs", candidate["image"]], root),
        (["node", "scripts/verify-workspace.mjs", str(args.workspace)], root),
        (["node", "scripts/verify-consumers.mjs", str(args.workspace), str(args.python)], root),
    ]
    for command, cwd in commands:
        run(command, log, cwd=cwd)
    with tempfile.TemporaryDirectory(prefix="wyvern-qualification-") as directory:
        archive = Path(directory) / "image.tar"
        run(["docker", "save", candidate["image"], "-o", str(archive)], log, cwd=root)
        run([sys.executable, "scripts/security-scan.py", "--assets", str(args.assets), "--image-archive", str(archive)], log, cwd=root)
        scanner = (root / ".release/trivy.image").read_text().strip()
        run(["docker", "run", "--rm", "-v", directory + ":/scan", scanner, "image", "--input", "/scan/image.tar",
             "--scanners", "vuln,secret", "--severity", "HIGH,CRITICAL", "--exit-code", "1", "--no-progress"], log, cwd=root)
    contract.require(log.stat().st_size <= 2 * 1024**2, "Qualification log exceeds evidence budget")
    proof = {
        "schema": "wyvern.verification.v1", "revision": args.revision, "status": "PASS",
        "problem_ids": passed, "candidate_sha256": candidate_sha256,
        "catalog_sha256": policy["sha256"],
        "command": "python3 scripts/qualify-candidate.py (exact candidate, integrations and security)",
        "exit_code": 0, "log": log.name, "log_sha256": digest(log),
    }
    proof_path = args.bundle / "qualification.json"
    proof_path.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
    reference = [{"path": proof_path.name, "sha256": digest(proof_path)}]
    rows = []
    for identifier in identifiers:
        if identifier in gate.FINAL_ONLY:
            rows.append({"id": identifier, "status": "DEFERRED", "required_phase": "final",
                         "reason": "Signature and anonymous-download verification require the staged signed release assets."})
        elif identifier in NOT_APPLICABLE:
            reason, paths = NOT_APPLICABLE[identifier]
            rows.append({"id": identifier, "status": "N/A", "profile": "exocortex.wyvern.release.v1",
                         "reason": reason, "inspected_paths": paths})
        else:
            rows.append({"id": identifier, "status": "PASS", "evidence": reference})
    report = {
        "schema_version": 1, "service": "wyvern", "revision": args.revision,
        "release_tag": args.tag, "candidate_sha256": candidate_sha256,
        "catalog_repository": policy["repository"], "catalog_path": gate.CATALOG,
        "catalog_revision": policy["revision"], "catalog_sha256": policy["sha256"],
        "release_qualification": False, "deployment_readiness": "NOT_CLAIMED", "checks": rows,
    }
    (args.bundle / "known-problems-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.bundle / "catalog.md").write_bytes(catalog)
    gate.verify(args.bundle, args.revision, args.tag, catalog, candidate=candidate_sha256, policy=policy)
    print(f"PASS: qualified {len(passed)} applicable IDs; {len(NOT_APPLICABLE)} N/A; final asset checks deferred")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("assets", "bundle", "workspace", "python"):
        parser.add_argument("--" + name, required=True, type=Path)
    for name in ("revision", "tag"):
        parser.add_argument("--" + name, required=True)
    main(parser.parse_args())
