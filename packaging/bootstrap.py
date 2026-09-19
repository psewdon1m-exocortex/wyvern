"""Bounded HTTPS bootstrap using a separately pinned RSA release key."""
import base64
import hashlib
import json
import os
import random
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import urllib.error
from http.client import IncompleteRead
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit


def verify(body, envelope, public):
    signature = json.loads(envelope)
    if signature.get('schema') != 'exocortex.release-signature.v1' or signature.get('algorithm') != 'RSA-PSS-SHA256':
        raise ValueError('Unsupported release signature')
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        (root/'key').write_bytes(public)
        der = subprocess.check_output(['openssl', 'pkey', '-pubin', '-in', str(root/'key'), '-outform', 'DER'], stderr=subprocess.DEVNULL)
        if signature.get('key_id') != hashlib.sha256(der).hexdigest():
            raise ValueError('Release signer differs from the pinned key')
        detail = subprocess.check_output(['openssl', 'pkey', '-pubin', '-in', str(root/'key'), '-text', '-noout'], text=True)
        if not re.search(r'Public-Key: \((?:3072|4096|6144|8192) bit\)', detail):
            raise ValueError('Release trust requires RSA of at least 3072 bits')
        (root/'body').write_bytes(body)
        (root/'signature').write_bytes(base64.b64decode(signature['signature'], validate=True))
        subprocess.run(['openssl', 'dgst', '-sha256', '-verify', str(root/'key'), '-signature', str(root/'signature'),
                        '-sigopt', 'rsa_padding_mode:pss', '-sigopt', 'rsa_pss_saltlen:32', str(root/'body')],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return json.loads(body)


class HTTPSOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != 'https':
            raise ValueError('Release redirect is not HTTPS')
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch(url, limit):
    if urlsplit(url).scheme != 'https':
        raise ValueError('Release transport must use HTTPS')
    deadline = time.monotonic()+90
    for attempt in range(4):
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Release download exhausted its deadline')
        retry_after = 0
        try:
            with urllib.request.build_opener(HTTPSOnly()).open(url, timeout=min(10, remaining)) as response:
                body=bytearray()
                while True:
                    chunk=response.read1(min(65536,limit+1-len(body)))
                    if not chunk: break
                    body.extend(chunk)
                    if len(body)>limit or time.monotonic()>deadline:
                        raise ValueError('Release asset exceeded its byte or time limit')
                length=response.headers.get('Content-Length')
                if length is not None and int(length)!=len(body):
                    raise IncompleteRead(bytes(body))
                return bytes(body)
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
            value=error.headers.get('Retry-After', '')
            try:
                retry_after=float(value) if value.isdigit() else parsedate_to_datetime(value).timestamp()-time.time()
            except (TypeError, ValueError, OverflowError):
                retry_after=0
        except (urllib.error.URLError, TimeoutError, IncompleteRead):
            if attempt == 3:
                raise
        delay=max(0.5*2**attempt+random.uniform(0,0.25), retry_after)
        # Do not ignore a server's longer Retry-After to squeeze in another try.
        if delay >= deadline-time.monotonic():
            raise TimeoutError('Release retry exceeds its remaining deadline')
        time.sleep(delay)


def extract(filename, destination):
    with tarfile.open(filename) as archive:
        members=[]; total=0
        for item in archive:
            total+=item.size
            if len(members)>=256 or total>256*1024**2:
                raise ValueError('Release archive exceeded its limits')
            members.append(item)
        seen = set()
        for item in members:
            path = PurePosixPath(item.name)
            if not path.parts or path.is_absolute() or any(part in ('', '.', '..') for part in item.name.split('/')) or '\\' in item.name or item.name in seen or not item.isfile():
                raise ValueError('Unsafe release archive')
            seen.add(item.name)
        required = {'install.sh', 'updater/install.sh', 'updater/updater-linux-amd64', 'updater/systemd/updater.service',
                    *('updater/release-trust/'+scope+'.pem' for scope in ('updater', 'neptune', 'gryphon', 'wyvern'))}
        if not required <= seen:
            raise ValueError('Incomplete Wyvern installer')
        for item in members:
            target = destination/item.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(item).read())
            target.chmod(0o755 if item.name.endswith(('.sh', 'updater-linux-amd64')) else 0o644)


def install(base, encoded_public, version):
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('Bootstrap requires root on Linux')
    if not re.fullmatch(r'https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/wyvern-v\d+\.\d+\.\d+', base):
        raise ValueError('Invalid pinned release location')
    published_release(base, version)
    public = base64.b64decode(encoded_public, validate=True)
    body, signature = fetch(base+'/wyvern-release.json', 65536), fetch(base+'/wyvern-release.json.sig.json', 16384)
    manifest = verify(body, signature, public)
    if manifest.get('schema') != 'exocortex.wyvern.release.v1' or manifest.get('product') != 'wyvern' or manifest.get('version') != version:
        raise ValueError('Release identity mismatch')
    installer = manifest.get('installer', {})
    if installer.get('url') != base+'/wyvern-install.tar.gz':
        raise ValueError('Installer location differs from the pinned release')
    bundle = fetch(installer['url'], 128*1024**2)
    if hashlib.sha256(bundle).hexdigest() != installer.get('sha256'):
        raise ValueError('Installer digest mismatch')
    with tempfile.TemporaryDirectory(prefix='wyvern-bootstrap-') as temporary:
        root = Path(temporary)
        archive = root/'bundle.tar.gz'; archive.write_bytes(bundle)
        stage = root/'stage'; stage.mkdir()
        extract(archive, stage)
        if (stage/'updater/release-trust/wyvern.pem').read_bytes() != public:
            raise ValueError('Bundled Wyvern trust differs from bootstrap trust')
        (stage/'wyvern-release.json').write_bytes(body)
        (stage/'wyvern-release.json.sig.json').write_bytes(signature)
        subprocess.run(['sh', str(stage/'install.sh')], check=True)


def published_release(base, version):
    match = re.fullmatch(r'https://github.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/releases/download/(wyvern-v\d+\.\d+\.\d+)', base)
    if not match or match[2] != 'wyvern-v' + version:
        raise ValueError('Invalid release identity')
    release = json.loads(fetch('https://api.github.com/repos/' + match[1] + '/releases/tags/' + match[2], 1024**2))
    if release.get('tag_name') != match[2] or release.get('draft') is not False or release.get('prerelease') is not False:
        raise ValueError('Wyvern release is not qualified for installation')


if __name__ == '__main__':
    install(*sys.argv[1:])
