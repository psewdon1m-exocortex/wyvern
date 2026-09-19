"""Fetch the exact signed dependency. Candidate assets never choose their trust key."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'packaging'))
from bootstrap import fetch, verify


def unpack(filename, target):
    with tarfile.open(filename) as archive:
        members=[];seen=set();total=0
        for member in archive:
            name=member.name.rstrip('/') if member.isdir() else member.name
            path=PurePosixPath(name)
            total+=member.size
            if len(members)>=128 or total>256*1024**2 or not path.parts or path.parts[0]!='updater' or path.is_absolute() or '..' in path.parts or '\\' in name or name in seen or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe Updater archive')
            seen.add(name);members.append(member)
        required=['install.sh','updater-linux-amd64','systemd/updater.service',*('release-trust/'+scope+'.pem' for scope in ['updater','neptune','gryphon','wyvern'])]
        if any('updater/'+name not in seen for name in required): raise ValueError('Updater does not include Wyvern trust and host lifecycle')
        for name in required:
            member=archive.getmember('updater/'+name)
            if not member.isfile(): raise ValueError('Required Updater file is not a file')
            output=target/name;output.parent.mkdir(parents=True,exist_ok=True)
            output.write_bytes(archive.extractfile(member).read())
            output.chmod(0o755 if name.endswith(('.sh','updater-linux-amd64')) else 0o644)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path);args=parser.parse_args()
    version=(ROOT/'.release/updater.version').read_text().strip()
    if not re.fullmatch(r'\d+\.\d+\.\d+',version):raise ValueError('Invalid dependency version')
    base='https://github.com/psewdon1m-exocortex/updater/releases/download/updater-v'+version
    manifest=verify(fetch(base+'/updater-release.json',65536),fetch(base+'/updater-release.json.sig.json',16384),(ROOT/'.release/updater-public-key.pem').read_bytes())
    if manifest.get('service')!='updater' or manifest.get('schema_version')!=1 or manifest.get('version')!=version:raise ValueError('Updater identity mismatch')
    if manifest.get('installer',{}).get('url')!=base+'/updater-'+version+'-install.tar.gz':raise ValueError('Updater asset URL mismatch')
    body=fetch(manifest['installer']['url'],128*1024**2)
    if hashlib.sha256(body).hexdigest()!=manifest['installer'].get('sha256'):raise ValueError('Updater archive checksum mismatch')
    if args.output.exists(): raise ValueError('Use a new output directory')
    with tempfile.TemporaryDirectory() as temporary:
        archive=Path(temporary)/'bundle';archive.write_bytes(body)
        stage=Path(temporary)/'updater';unpack(archive,stage)
        binary=stage/'updater-linux-amd64'
        if hashlib.sha256(binary.read_bytes()).hexdigest()!=manifest.get('binary',{}).get('sha256'):raise ValueError('Updater binary checksum mismatch')
        if subprocess.check_output([str(binary),'version'],text=True).strip()!=version:raise ValueError('Updater executable version mismatch')
        if json.loads(subprocess.check_output([str(binary),'wyvern','capabilities']))!={'schema':'exocortex.wyvern.updater.v1','api_version':1}:raise ValueError('Updater lacks Wyvern v1')
        import shutil
        shutil.copytree(stage,args.output)


if __name__=='__main__':main()
