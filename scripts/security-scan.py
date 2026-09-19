"""Fail closed on private keys/credentials and risky files, including image layers."""
import argparse
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'github-token': re.compile(rb'\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b'),
    'google-api-key': re.compile(rb'\bAIza[0-9A-Za-z_-]{35}\b'),
    'aws-access-key': re.compile(rb'\bAKIA[A-Z0-9]{16}\b'),
}
RISKY = re.compile(r'(^|/)(\.env|id_rsa|id_ed25519|credentials\.json|service-account\.json)$|\.(p12|pfx|key)$', re.I)
LIMIT = 256 * 1024**2


def scan_stream(stream, name, findings):
    if RISKY.search(name):
        findings.append({'path': name, 'rule': 'high-risk-file'})
    tail, size, matched = b'', 0, set()
    while chunk := stream.read(65536):
        size += len(chunk)
        if size > LIMIT:
            raise ValueError('Security scan member exceeds its bound: ' + name)
        window = tail + chunk
        for rule, pattern in PATTERNS.items():
            if rule not in matched and pattern.search(window):
                findings.append({'path': name, 'rule': rule})
                matched.add(rule)
        tail = window[-16384:]


def scan_tar(stream, label, findings):
    total, count = 0, 0
    with tarfile.open(fileobj=stream, mode='r|*') as archive:
        for member in archive:
            total += member.size
            count += 1
            if total > 2 * 1024**3 or count > 100000 or member.size > LIMIT:
                raise ValueError('Security scan archive exceeds its bounds')
            if member.isfile():
                scan_stream(archive.extractfile(member), label + '/' + member.name, findings)


def scan_image(filename, findings):
    with tarfile.open(filename) as archive:
        manifest = archive.getmember('manifest.json')
        if manifest.size > 1024**2:
            raise ValueError('Oversized Docker image inventory')
        images = json.load(archive.extractfile(manifest))
        layers = set(layer for image in images for layer in image['Layers'])
        for name in layers:
            member = archive.getmember(name)
            if not member.isfile() or member.size > 2 * 1024**3:
                raise ValueError('Unsafe Docker layer')
            scan_tar(archive.extractfile(member), 'image-layer/' + name, findings)


def scan_source(root, findings):
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).split(b'\0')
    for raw in sorted(set(names)):
        if not raw:
            continue
        name = raw.decode('utf-8')
        path = root / name
        if not path.exists():  # deleted outgoing paths contain no shipped bytes
            continue
        if path.is_symlink() or not path.is_file():
            raise ValueError('Unsafe source input: ' + name)
        with path.open('rb') as stream:
            scan_stream(stream, name, findings)


def scan_assets(root, findings):
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Output contains a link')
        if path.is_file():
            with path.open('rb') as stream:
                if path.name.endswith('.tar.gz'):
                    scan_tar(stream, path.name, findings)
                else:
                    scan_stream(stream, path.relative_to(root).as_posix(), findings)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', action='store_true')
    parser.add_argument('--assets', type=Path)
    parser.add_argument('--image-archive', type=Path)
    args = parser.parse_args()
    findings = []
    if not (args.source or args.assets or args.image_archive):
        parser.error('Select a source, assets or image archive')
    if args.source:
        scan_source(ROOT, findings)
    if args.assets:
        scan_assets(args.assets, findings)
    if args.image_archive:
        scan_image(args.image_archive, findings)
    print(json.dumps({'status': 'FAIL' if findings else 'PASS', 'findings': findings}))
    raise SystemExit(bool(findings))
