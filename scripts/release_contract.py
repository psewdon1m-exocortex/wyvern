"""Bounded candidate inventory and the reviewed immutable central-policy pin."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
FILES = {'wyvern-release.json': 65536, 'wyvern-install.tar.gz': 128 * 1024**2,
         'bootstrap.sh': 1024**2, 'wyvern.pem': 16384, 'sbom.spdx.json': 16 * 1024**2,
         'image-provenance.json': 2 * 1024**2, 'image-sbom-attestation.json': 2 * 1024**2}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def ordinary(root, name, limit):
    path = root / name
    require(not path.is_symlink() and path.is_file() and path.stat().st_size <= limit, 'Missing/unsafe/oversized candidate file: ' + name)
    return path


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def policy():
    value = json.loads((ROOT / '.release/policy.json').read_bytes())
    require(value.get('schema') == 'exocortex.wyvern.policy.v1'
            and value.get('repository') == 'https://github.com/psewdon1m-exocortex/general'
            and re.fullmatch(r'[a-f0-9]{40}', value.get('revision', ''))
            and re.fullmatch(r'[a-f0-9]{64}', value.get('sha256', ''))
            and value.get('catalog') == 'PART_12_KNOWN_DEPLOYMENT_AND_OPERATIONS_PROBLEMS.md', 'Invalid central policy pin')
    return value


def catalog_bytes(pin, local=None):
    if local and (Path(local) / '.git').exists():
        body = subprocess.check_output(['git', '-C', str(local), 'show', pin['revision'] + ':' + pin['catalog']])
    else:
        url = 'https://raw.githubusercontent.com/psewdon1m-exocortex/general/' + pin['revision'] + '/' + pin['catalog']
        with urllib.request.urlopen(url, timeout=30) as response:
            body = response.read(2 * 1024**2 + 1)
    require(len(body) <= 2 * 1024**2 and digest(body) == pin['sha256'], 'Central catalog differs from the reviewed pin')
    return body


def lint_catalog(body, pin, local=None):
    text = body.decode('utf-8')
    identifiers = []
    for line in text.splitlines():
        if line.startswith('| **CAT-NN** |'):
            continue
        match = re.fullmatch(r'\|\s*\*\*([A-Z]+-\d{2})\*\*\s*\|(.+)\|(.+)\|\s*', line)
        if match:
            name, problem, solution = match.groups()
            require(name not in identifiers and len(problem.strip()) > 10 and len(solution.strip()) > 10, 'Invalid central catalog row')
            identifiers.append(name)
        else:
            require(not line.startswith('| **'), 'Malformed central catalog row')
    require(identifiers and text.count('```') % 2 == 0, 'Malformed central catalog Markdown')
    for target in set(re.findall(r'\]\(([^)]+)\)', text)):
        if target.startswith(('https://', 'http://', '#')):
            continue
        name = target.split('#', 1)[0].removeprefix('./')
        require(name and not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts, 'Unsafe central documentation link')
        if local and (Path(local) / '.git').exists():
            subprocess.run(['git', '-C', str(local), 'cat-file', '-e', pin['revision'] + ':' + name], check=True, capture_output=True)
        else:
            url = 'https://raw.githubusercontent.com/psewdon1m-exocortex/general/' + pin['revision'] + '/' + name
            with urllib.request.urlopen(url, timeout=30) as response:
                require(response.status == 200, 'Broken central documentation link')
    return identifiers


def inventory(root):
    return {name: file_digest(ordinary(root, name, limit)) for name, limit in FILES.items()}


def create_candidate(root, revision, pin):
    manifest = json.loads(ordinary(root, 'wyvern-release.json', 65536).read_bytes())
    value = {'schema': 'exocortex.wyvern.candidate.v1', 'revision': revision, 'version': manifest['version'],
             'image': manifest['image'], 'catalog_revision': pin['revision'], 'catalog_sha256': pin['sha256'], 'assets': inventory(root)}
    (root / 'candidate.json').write_text(json.dumps(value, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    return verify_candidate(root, revision, pin)


def verify_candidate(root, revision, pin):
    body = ordinary(root, 'candidate.json', 65536).read_bytes()
    value = json.loads(body)
    require(value.get('schema') == 'exocortex.wyvern.candidate.v1' and value.get('revision') == revision
            and re.fullmatch(r'[a-f0-9]{40}', revision), 'Wrong candidate source')
    require(value.get('catalog_revision') == pin['revision'] and value.get('catalog_sha256') == pin['sha256'], 'Stale candidate policy')
    require(value.get('assets') == inventory(root), 'Candidate artifact set changed')
    manifest = json.loads((root / 'wyvern-release.json').read_bytes())
    require(manifest.get('source_sha') == revision and manifest.get('image') == value.get('image')
            and re.fullmatch(r'ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+@sha256:[a-f0-9]{64}', value.get('image', ''))
            and manifest.get('version') == value.get('version') and re.fullmatch(r'\d+\.\d+\.\d+', value.get('version', ''))
            and manifest.get('installer', {}).get('sha256') == value['assets']['wyvern-install.tar.gz'], 'Candidate manifest mismatch')
    sbom = json.loads((root / 'sbom.spdx.json').read_bytes())
    require(str(sbom.get('spdxVersion', '')).startswith('SPDX-') and isinstance(sbom.get('packages'), list) and sbom['packages'], 'Missing image SBOM')
    return value, digest(body)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['create', 'verify', 'catalog'])
    parser.add_argument('--assets', type=Path)
    parser.add_argument('--revision')
    parser.add_argument('--docs', type=Path)
    args = parser.parse_args()
    pin = policy()
    if args.mode == 'catalog':
        print('PASS: central catalog', len(lint_catalog(catalog_bytes(pin, args.docs), pin, args.docs)), 'active IDs')
    elif args.mode == 'create':
        print(create_candidate(args.assets, args.revision, pin)[1])
    else:
        print(verify_candidate(args.assets, args.revision, pin)[1])
