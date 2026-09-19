"""Verify anonymous exact release bytes, then close the two final-only gates."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


bootstrap = module('bootstrap', ROOT / 'packaging/bootstrap.py')
gate = module('qualification', ROOT / 'scripts/verify-qualification.py')


def check(args):
    manifest_path = args.assets / 'wyvern-release.json'
    manifest = json.loads(manifest_path.read_bytes())
    base = manifest['installer']['url'].removesuffix('/wyvern-install.tar.gz')
    gate.require(base == f'https://github.com/{args.repository}/releases/download/{args.tag}', 'Wrong release asset origin')
    gate.require(manifest['source_sha'] == args.revision and args.tag == 'wyvern-v' + manifest['version'], 'Wrong source/version')
    for name in ('wyvern-release.json', 'wyvern-release.json.sig.json', 'wyvern-install.tar.gz', 'bootstrap.sh', 'wyvern.pem'):
        expected = (args.assets / name).read_bytes()
        actual = bootstrap.fetch(base + '/' + name, 128 * 1024**2 if name.endswith('.tar.gz') else 1024**2)
        gate.require(actual == expected, 'Anonymous asset differs from qualified bytes: ' + name)
    bootstrap.verify(manifest_path.read_bytes(), (args.assets / 'wyvern-release.json.sig.json').read_bytes(), args.public_key.read_bytes())
    gate.require(gate.digest((args.assets / 'wyvern-install.tar.gz').read_bytes()) == manifest['installer']['sha256'], 'Archive checksum mismatch')
    references = subprocess.check_output(['git', 'ls-remote', 'https://github.com/' + args.repository + '.git',
                                          'refs/heads/main', 'refs/tags/' + args.tag, 'refs/tags/' + args.tag + '^{}'], text=True)
    refs = {line.split()[1]: line.split()[0] for line in references.splitlines()}
    gate.require(refs.get('refs/heads/main') == args.revision and refs.get('refs/tags/' + args.tag + '^{}', refs.get('refs/tags/' + args.tag)) == args.revision, 'Remote main/tag identity changed')
    report = gate.read_json(args.bundle / 'known-problems-report.json')
    log = args.bundle / 'published-assets.log'
    log.write_text('PASS: anonymous assets match; signature, archive hash and remote main/tag verified.\n', encoding='utf-8')
    proof = {'schema': 'wyvern.verification.v1', 'revision': args.revision, 'status': 'PASS', 'problem_ids': sorted(gate.FINAL_ONLY),
             'catalog_sha256': report['catalog_sha256'],
             'command': 'python3 scripts/verify-published.py (exact release assets)', 'exit_code': 0, 'log': log.name, 'log_sha256': gate.digest(log.read_bytes())}
    path = args.bundle / 'published-assets.json'
    path.write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
    for row in report['checks']:
        if row['id'] in gate.FINAL_ONLY:
            name = row['id']
            row.clear()
            row.update(id=name, status='PASS', evidence=[{'path': path.name, 'sha256': gate.digest(path.read_bytes())}])
    report['release_qualification'] = True
    (args.bundle / 'known-problems-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    gate.verify(args.bundle, args.revision, args.tag, (args.bundle / 'catalog.md').read_bytes(), final=True)
    print('PASS: final exact-source release qualification')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('assets', 'bundle', 'public-key'):
        parser.add_argument('--' + name, required=True, type=Path)
    for name in ('revision', 'tag', 'repository'):
        parser.add_argument('--' + name, required=True)
    check(parser.parse_args())
