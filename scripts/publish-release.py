"""Keep candidates excluded from discovery until anonymous verification succeeds."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('published', ROOT / 'scripts/verify-published.py')
published = importlib.util.module_from_spec(spec)
spec.loader.exec_module(published)


def publish(args, *, run=subprocess.run, check=published.check):
    release = run(['gh', 'release', 'view', args.tag, '--repo', args.repository, '--json', 'isDraft,isPrerelease,tagName'],
                  capture_output=True, text=True)
    if release.returncode == 0:
        existing = json.loads(release.stdout)
        if existing.get('tagName') != args.tag or existing.get('isDraft') or not existing.get('isPrerelease'):
            raise ValueError('An existing final or draft release must not be overwritten')
        # Retrying a candidate verifies identical public bytes; never clobber assets.
    else:
        run(['gh', 'release', 'create', args.tag, *[str(args.assets / name) for name in (*published.gate.contract.FILES, 'candidate.json', 'wyvern-release.json.sig.json')],
             '--repo', args.repository, '--verify-tag', '--prerelease', '--latest=false', '--title', 'Wyvern ' + args.tag,
             '--notes-file', str(ROOT / 'docs/release-notes.md')], check=True)
    check(args)
    report = args.bundle / 'known-problems-report.json'
    evidence = args.bundle.parent / 'qualification-evidence.tar.gz'
    with tarfile.open(evidence, 'w:gz') as archive:
        for path in sorted(args.bundle.rglob('*')):
            if path.is_symlink():
                raise ValueError('Qualification evidence contains a link')
            if path.is_file():
                archive.add(path, arcname=path.relative_to(args.bundle).as_posix(), recursive=False)
    run(['gh', 'release', 'upload', args.tag, str(report), str(evidence), '--repo', args.repository, '--clobber'], check=True)
    # This is the sole transition which makes the release installable.
    run(['gh', 'release', 'edit', args.tag, '--repo', args.repository, '--prerelease=false', '--latest'], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('assets', 'bundle', 'public-key'):
        parser.add_argument('--' + name, required=True, type=Path)
    for name in ('revision', 'tag', 'repository'):
        parser.add_argument('--' + name, required=True)
    publish(parser.parse_args())
