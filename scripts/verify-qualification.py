"""Validate exact-source Part 12 evidence before granting the signing job access."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.request
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_contract as contract

SHA = re.compile(r'[a-f0-9]{40}')
DIGEST = re.compile(r'[a-f0-9]{64}')
CATALOG = 'PART_12_KNOWN_DEPLOYMENT_AND_OPERATIONS_PROBLEMS.md'
FINAL_ONLY = {'REL-06', 'REL-09'}
SOURCE_ROOT = Path(__file__).resolve().parents[1]


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'Duplicate JSON key')
        value[key] = item
    return value


def safe_file(root, name):
    require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.\-/]+', name), 'Unsafe evidence path')
    parts = name.split('/')
    require(all(part not in ('', '.', '..') for part in parts), 'Unsafe evidence path')
    current = root
    for part in parts:
        current = current / part
        require(not current.is_symlink(), 'Evidence links are forbidden')
    require(current.is_file() and current.stat().st_size <= 2 * 1024**2, 'Missing or oversized evidence')
    return current


def read_json(path):
    return json.loads(path.read_bytes(), object_pairs_hook=unique)


def verify(root, revision, tag, catalog, *, candidate, policy, final=False):
    require(SHA.fullmatch(revision) and re.fullmatch(r'wyvern-v\d+\.\d+\.\d+', tag), 'Invalid release identity')
    report = read_json(safe_file(root, 'known-problems-report.json'))
    require(report.get('candidate_sha256') == candidate and DIGEST.fullmatch(candidate), 'Evidence belongs to another candidate')
    require(report.get('schema_version') == 1 and report.get('service') == 'wyvern'
            and report.get('revision') == revision and report.get('release_tag') == tag, 'Stale qualification identity')
    require(report.get('catalog_repository') == 'https://github.com/psewdon1m-exocortex/general'
            and report.get('catalog_path') == CATALOG and SHA.fullmatch(report.get('catalog_revision', ''))
            and report.get('catalog_sha256') == digest(catalog) == policy['sha256']
            and report.get('catalog_revision') == policy['revision'], 'Unpinned, stale or changed policy catalog')
    identifiers = []
    for line in catalog.decode('utf-8').splitlines():
        if line.startswith('| **CAT-NN** |'):
            continue
        match = re.fullmatch(r'\|\s*\*\*([A-Z]+-\d{2})\*\*\s*\|(.+)\|(.+)\|\s*', line)
        if match:
            name, problem, solution = match.groups()
            require(name not in identifiers and len(problem.strip()) > 10 and len(solution.strip()) > 10, 'Invalid catalog row')
            identifiers.append(name)
        else:
            require(not line.startswith('| **'), 'Malformed policy row')
    rows = report.get('checks')
    require(identifiers and isinstance(rows, list) and len(rows) == len(identifiers)
            and all(isinstance(row, dict) for row in rows)
            and {row.get('id') for row in rows} == set(identifiers), 'Missing or duplicate classifications')
    for row in rows:
        name, status = row['id'], row.get('status')
        if status == 'N/A':
            paths = row.get('inspected_paths')
            require(row.get('profile') == 'exocortex.wyvern.release.v1'
                    and isinstance(row.get('reason'), str) and len(row['reason'].strip()) >= 50
                    and isinstance(paths, list) and paths and all(isinstance(path, str) and path.strip() for path in paths), name + ': unexplained N/A')
            for path in paths:
                inspected = (SOURCE_ROOT / path).resolve()
                require(inspected.is_relative_to(SOURCE_ROOT) and inspected.exists(), name + ': uninspected source path')
            require(name not in FINAL_ONLY, name + ': signed artifact checks always apply')
            continue
        if not final and status == 'DEFERRED' and name in FINAL_ONLY:
            require(row.get('required_phase') == 'final' and len(row.get('reason', '').strip()) >= 30, 'Unexplained deferred check')
            continue
        require(status == 'PASS', name + ': unresolved qualification blocks release')
        references = row.get('evidence')
        require(isinstance(references, list) and references, name + ': missing executable evidence')
        for reference in references:
            require(isinstance(reference, dict) and DIGEST.fullmatch(reference.get('sha256', '')), 'Invalid evidence reference')
            path = safe_file(root, reference.get('path'))
            require(digest(path.read_bytes()) == reference['sha256'], 'Changed evidence')
            proof = read_json(path)
            require(proof.get('schema') == 'wyvern.verification.v1' and proof.get('revision') == revision
                    and proof.get('candidate_sha256') == candidate
                    and proof.get('catalog_sha256') == report['catalog_sha256']
                    and proof.get('status') == 'PASS' and name in proof.get('problem_ids', [])
                    and isinstance(proof.get('command'), str) and proof['command'].strip()
                    and type(proof.get('exit_code')) is int and proof['exit_code'] == 0, name + ': stale/failed evidence')
            log = safe_file(root, proof.get('log'))
            require(digest(log.read_bytes()) == proof.get('log_sha256'), 'Changed execution log')
    return report


def fetch_catalog(report):
    revision = report.get('catalog_revision', '')
    require(SHA.fullmatch(revision), 'An immutable central policy revision is required')
    url = f'https://raw.githubusercontent.com/psewdon1m-exocortex/general/{revision}/{CATALOG}'
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(2 * 1024**2 + 1)
    require(len(data) <= 2 * 1024**2, 'Oversized policy catalog')
    return data


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--assets', required=True, type=Path)
    args = parser.parse_args()
    report = read_json(safe_file(args.bundle, 'known-problems-report.json'))
    policy = contract.policy()
    catalog = contract.catalog_bytes(policy)
    contract.lint_catalog(catalog, policy)
    candidate, candidate_sha256 = contract.verify_candidate(args.assets, args.revision, policy)
    require(args.tag == 'wyvern-v' + candidate['version'], 'Candidate version differs from tag')
    verify(args.bundle, args.revision, args.tag, catalog, candidate=candidate_sha256, policy=policy)
    (args.bundle / 'catalog.md').write_bytes(catalog)
    print('PASS: exact-source Part 12 pre-signing evidence; only final asset checks may be deferred')
