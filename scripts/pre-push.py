"""One Linux/WSL gate; development evidence is bound to a working-tree digest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

import release_contract as contract

ROOT = contract.ROOT
AREAS = {'backup_restore', 'update_rollback', 'internal_documentation', 'technical_documentation', 'security', 'public_seo', 'private_exposure'}


def source_identity():
    digest = hashlib.sha256()
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).split(b'\0')
    for name in sorted(set(names)):
        if not name:
            continue
        path = ROOT / name.decode('utf-8')
        if path.is_file() and not path.is_symlink():
            digest.update(name + b'\0' + contract.file_digest(path).encode('ascii') + b'\0')
    return {'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(), 'tree_sha256': digest.hexdigest(),
            'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT))}


def validate_profile(profile, inventory, server):
    contract.require(profile.get('schema') == 'exocortex.wyvern.pre-push-profile.v1' and set(profile.get('areas', {})) == AREAS, 'Missing pre-push area')
    for area, value in profile['areas'].items():
        contract.require(type(value.get('applicable')) is bool and len(value.get('scope' if value['applicable'] else 'reason', '')) >= 40, 'Unclassified pre-push area: ' + area)
    contract.require(inventory.get('schema') == 'exocortex.wyvern.exposure.v1', 'Unknown exposure schema')
    routes = inventory.get('routes', [])
    paths = [row['path'] for row in routes]
    expected = set(re.findall(r'["\'](/(?:v1|health)/[a-z/-]+(?::id)?)["\']', server))
    contract.require(len(paths) == len(set(paths)) and set(paths) == expected, 'Unclassified or stale route')
    for row in routes:
        contract.require(row['boundary'] in ('client', 'admin', 'both') and row['auth'] in ('bearer', 'filesystem', 'minimal-health')
                         and row['methods'] and set(row['methods']) <= {'GET', 'POST', 'DELETE'}, 'Invalid route authority')
    contract.require({row['id'] for row in inventory['listeners']} == {'client', 'admin', 'remote'}
                     and all(row['exposure'] in ('private', 'public-authenticated-non-indexable') for row in inventory['listeners']), 'Unknown listener exposure')


def documentation():
    for name in ('README.md', 'docs/operations.md', 'docs/releasing.md', 'docs/decisions.md', 'docs/IMPLEMENTATION.md'):
        path = ROOT / name
        text = path.read_text(encoding='utf-8')
        contract.require(text.strip() and '\ufffd' not in text, 'Invalid documentation: ' + name)
        for link in re.findall(r'\]\(([^)]+)\)', text):
            if link.startswith(('http:', 'https:', '#')):
                continue
            target = (path.parent / link.split('#')[0]).resolve()
            # Cross-repository workspace references are not packaged local files.
            if target.is_relative_to(ROOT):
                contract.require(target.exists(), 'Broken project documentation link: ' + name)


def workflow_policy():
    for filename in (ROOT / '.github/workflows').glob('*.yml'):
        source = filename.read_text(encoding='utf-8')
        for action in re.findall(r'uses:\s*([^\s#]+)', source):
            contract.require(bool(re.fullmatch(r'[A-Za-z0-9_./-]+@[a-f0-9]{40}', action)), 'Unpinned workflow action: ' + action)
    release = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
    contract.require(release.count('secrets.WYVERN_RELEASE_PRIVATE_KEY') == 1, 'Unexpected release key exposure')
    sign = release.split('\n  sign:\n', 1)[1].split('\n  publish:\n', 1)[0]
    contract.require('contents: write' not in sign and 'packages: write' not in sign and 'sign-ephemeral.mjs' in sign, 'Signing job has publication authority')


def main(args):
    contract.require(sys.platform == 'linux', 'Run this gate on Linux or through WSL; POSIX checks must not be skipped')
    initial = source_identity()
    contract.require(args.working_tree or not initial['dirty'], 'Commit the outgoing revision, or use --working-tree for explicitly non-release development evidence')
    profile = json.loads((ROOT / 'docs/verification-profile.json').read_bytes())
    validate_profile(profile, json.loads((ROOT / 'docs/exposure-inventory.json').read_bytes()), (ROOT / 'src/server.js').read_text(encoding='utf-8'))
    documentation()
    workflow_policy()
    pin = contract.policy()
    catalog = contract.catalog_bytes(pin, args.docs)
    ids = contract.lint_catalog(catalog, pin, args.docs)
    evidence = []
    logs = args.report.parent / (args.report.stem + '-logs')
    logs.mkdir(parents=True, exist_ok=True)
    def run(command, *, cwd=ROOT):
        began = time.monotonic()
        print('+ ' + ' '.join(str(x) for x in command), flush=True)
        with tempfile.TemporaryFile() as log:
            result = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
            log.seek(0)
            digest = hashlib.file_digest(log, 'sha256').hexdigest()
            log.seek(0, 2)
            size = log.tell()
            contract.require(size <= 2 * 1024**2, 'Verification log exceeds its evidence budget')
            log.seek(0)
            retained = logs / (str(len(evidence) + 1).zfill(2) + '.log')
            with retained.open('wb') as output:
                shutil.copyfileobj(log, output)
            log.seek(max(0, size - 6000))
            tail = log.read().decode('utf-8', errors='replace')
        evidence.append({'command': [str(x) for x in command], 'cwd': str(cwd), 'exit_code': result.returncode,
                         'log': retained.relative_to(args.report.parent).as_posix(), 'log_sha256': digest, 'seconds': round(time.monotonic() - began, 2)})
        if result.returncode:
            print(tail, file=sys.stderr)
            raise RuntimeError('Verification command failed')
    report = {'schema': 'exocortex.wyvern.pre-push.v1', **initial, 'purpose': 'development' if initial['dirty'] else 'outgoing-revision',
              'catalog_revision': pin['revision'], 'catalog_sha256': pin['sha256'], 'catalog_ids': ids,
              'areas': {}, 'evidence': evidence, 'release_qualification': False, 'deployment': 'NOT_RUN'}
    try:
        run(['npm', 'run', 'check'])
        run([sys.executable, '-m', 'unittest', 'discover', '-s', 'packaging', '-p', 'test_*.py'])
        run([sys.executable, 'scripts/security-scan.py', '--source'])
        run(['npm', 'audit', '--omit=dev', '--audit-level=high'])
        run(['docker', 'build', '--quiet', '--target', 'verification', '-t', 'wyvern-gate-verification:local', '.'])
        run(['docker', 'build', '--quiet', '--target', 'runtime', '-t', 'wyvern-gate-runtime:local', '.'])
        run(['node', 'scripts/smoke-container.mjs', 'wyvern-gate-runtime:local'])
        with tempfile.TemporaryDirectory(prefix='wyvern-security-') as temporary:
            archive = Path(temporary) / 'image.tar'
            run(['docker', 'save', 'wyvern-gate-runtime:local', '-o', str(archive)])
            run([sys.executable, 'scripts/security-scan.py', '--image-archive', str(archive)])
            scanner = (ROOT / '.release/trivy.image').read_text().strip()
            contract.require(re.fullmatch(r'ghcr.io/aquasecurity/trivy@sha256:[a-f0-9]{64}', scanner), 'Unpinned security scanner')
            run(['docker', 'run', '--rm', '-v', temporary + ':/scan', '-v', 'wyvern-trivy-cache:/root/.cache/trivy', scanner,
                 'image', '--input', '/scan/image.tar', '--scanners', 'vuln,secret', '--severity', 'HIGH,CRITICAL', '--exit-code', '1', '--no-progress', '--format', 'json', '--output', '/scan/result.json'])
            result = contract.ordinary(Path(temporary), 'result.json', 16 * 1024**2)
            retained_scan = logs / 'image-scan.json'
            shutil.copyfile(result, retained_scan)
            evidence[-1]['result'] = retained_scan.relative_to(args.report.parent).as_posix()
            evidence[-1]['result_sha256'] = contract.file_digest(retained_scan)
        if args.workspace:
            workspace = args.workspace.resolve()
            run(['node', 'scripts/verify-workspace.mjs', str(workspace)])
            run([os.environ.get('WYVERN_GO', 'go'), 'test', './internal/component', './internal/hostrecovery'], cwd=workspace / 'updater')
        contract.require(source_identity() == initial, 'Source changed during verification')
        report['areas'] = {name: {'status': 'PASS' if value['applicable'] else 'N/A', **value} for name, value in profile['areas'].items()}
        report['status'] = 'PASS'
    except Exception:
        report['status'] = 'FAIL'
        report['areas'] = {name: {'status': 'FAIL' if value['applicable'] else 'N/A', **value} for name, value in profile['areas'].items()}
        raise
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('PASS: seven-area gate (' + report['purpose'] + '); no production/release qualification claimed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--working-tree', action='store_true')
    parser.add_argument('--docs', type=Path, default=ROOT.parent / '.docs')
    parser.add_argument('--workspace', type=Path)
    parser.add_argument('--report', type=Path, default=ROOT / 'artifacts/pre-push.json')
    main(parser.parse_args())
