"""Assemble from an exact clean commit and qualified Updater bundle; sign separately."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
CAPABILITIES = ['text', 'streaming', 'structured_output', 'token_count', 'image', 'pdf', 'audio', 'video', 'youtube']


def digest(body):
    return hashlib.sha256(body).hexdigest()


def build(args):
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if sha != args.source_sha or subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT):
        raise ValueError('Build releases only from their exact clean source commit')
    if not re.fullmatch(r'ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+@sha256:[a-f0-9]{64}', args.image):
        raise ValueError('An immutable GHCR image is required')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
        raise ValueError('Invalid GitHub repository')
    version = json.loads((ROOT/'package.json').read_bytes())['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('An exact stable version is required')
    files = {'install.sh': (ROOT/'packaging/install.sh').read_bytes()}
    for path in args.updater_bundle.rglob('*'):
        if path.is_symlink():
            raise ValueError('Updater bundle must contain ordinary files')
        if path.is_file():
            files['updater/'+path.relative_to(args.updater_bundle).as_posix()] = path.read_bytes()
    required = ['install.sh', 'updater-linux-amd64', 'systemd/updater.service',
                *('release-trust/'+scope+'.pem' for scope in ['updater', 'neptune', 'gryphon', 'wyvern'])]
    if any('updater/'+name not in files for name in required):
        raise ValueError('Incomplete qualified Updater bundle')
    public = args.public_key.read_bytes()
    if files['updater/release-trust/wyvern.pem'] != public:
        raise ValueError('Updater must already pin this Wyvern signing key')
    capabilities = json.loads(subprocess.check_output([str(args.updater_bundle/'updater-linux-amd64'), 'wyvern', 'capabilities']))
    if capabilities != {'schema': 'exocortex.wyvern.updater.v1', 'api_version': 1}:
        raise ValueError('Updater does not implement Wyvern v1')
    args.output.mkdir(parents=True, exist_ok=True)
    bundle = args.output/'wyvern-install.tar.gz'
    with bundle.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped, tarfile.open(fileobj=zipped, mode='w|') as archive:
        for name, body in sorted(files.items()):
            if name.endswith(('.sh', '.service')) and b'\r' in body:
                raise ValueError('Linux installer inputs must use LF')
            entry = tarfile.TarInfo(name); entry.size = len(body); entry.mode = 0o755 if name.endswith(('.sh', 'updater-linux-amd64')) else 0o644
            archive.addfile(entry, io.BytesIO(body))
    base = f'https://github.com/{args.repository}/releases/download/wyvern-v{version}'
    manifest = {'schema': 'exocortex.wyvern.release.v1', 'product': 'wyvern', 'version': version, 'image': args.image,
                'api_version': 1, 'config_schema': 'exocortex.wyvern.config.v1', 'capabilities': CAPABILITIES, 'source_sha': sha,
                'installer': {'url': base+'/wyvern-install.tar.gz', 'sha256': digest(bundle.read_bytes())}}
    (args.output/'wyvern-release.json').write_text(json.dumps(manifest, indent=2)+'\n', newline='\n')
    source = base64.b64encode((ROOT/'packaging/bootstrap.py').read_bytes()).decode()
    script = "#!/bin/sh\nset -eu\numask 077\nexec python3 - '"+base+"' '"+base64.b64encode(public).decode()+"' '"+version+"' <<'PY'\nimport base64\nexec(compile(base64.b64decode('"+source+"'), '<wyvern-bootstrap>', 'exec'))\nPY\n"
    (args.output/'bootstrap.sh').write_text(script, newline='\n')
    (args.output/'wyvern.pem').write_bytes(public)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['output', 'updater-bundle', 'public-key']:
        parser.add_argument('--'+name, required=True, type=Path)
    for name in ['image', 'source-sha', 'repository']:
        parser.add_argument('--'+name, required=True)
    build(parser.parse_args())
