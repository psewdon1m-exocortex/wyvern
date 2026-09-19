import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import importlib.util
from types import SimpleNamespace
from bootstrap import extract, verify


class BootstrapTests(unittest.TestCase):
    def test_clean_source_assembly_binds_installer_and_updater_trust(self):
        project=Path(__file__).resolve().parents[1]
        spec=importlib.util.spec_from_file_location('wyvern_builder',project/'scripts/build-release.py')
        builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';(source/'packaging').mkdir(parents=True)
            (source/'package.json').write_text('{"version":"0.0.1"}')
            for name in ['install.sh','bootstrap.py']:(source/'packaging'/name).write_bytes((project/'packaging'/name).read_bytes())
            for args in [['git','init'],['git','add','.'],['git','-c','user.name=Release test','-c','user.email=fixture@localhost','commit','-m','Fixture']]:
                subprocess.run(args,cwd=source,check=True,capture_output=True)
            sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
            helper=root/'updater';(helper/'release-trust').mkdir(parents=True);(helper/'systemd').mkdir()
            for scope in ['updater','neptune','gryphon','wyvern']:(helper/'release-trust'/f'{scope}.pem').write_text('synthetic already-qualified public trust\n')
            (helper/'install.sh').write_text('#!/bin/sh\nexit 0\n')
            (helper/'systemd/updater.service').write_text('[Service]\nExecStart=/usr/bin/updater\n')
            (helper/'updater-linux-amd64').write_text("#!/bin/sh\necho '{\"schema\":\"exocortex.wyvern.updater.v1\",\"api_version\":1}'\n")
            (helper/'updater-linux-amd64').chmod(0o755)
            builder.ROOT=source
            args=SimpleNamespace(source_sha=sha,image='ghcr.io/test/wyvern@sha256:'+'a'*64,repository='test/wyvern',output=root/'out',updater_bundle=helper,public_key=helper/'release-trust/wyvern.pem')
            builder.build(args)
            manifest=json.loads((args.output/'wyvern-release.json').read_bytes())
            self.assertEqual(manifest['source_sha'],sha)
            self.assertEqual(manifest['installer']['sha256'],hashlib.sha256((args.output/'wyvern-install.tar.gz').read_bytes()).hexdigest())
            self.assertIn('pdf',manifest['capabilities'])
            extract(args.output/'wyvern-install.tar.gz',root/'staged')
            subprocess.run(['sh','-n',str(args.output/'bootstrap.sh')],check=True)
            (source/'package.json').write_text('{"version":"0.0.2"}')
            with self.assertRaises(ValueError):builder.build(args)

    def test_signature_is_pinned_and_tampering_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', str(root/'key')], check=True, capture_output=True)
            public = subprocess.check_output(['openssl', 'pkey', '-in', str(root/'key'), '-pubout'])
            der = subprocess.check_output(['openssl', 'pkey', '-in', str(root/'key'), '-pubout', '-outform', 'DER'])
            body = b'{"product":"wyvern"}'
            (root/'body').write_bytes(body)
            signature = subprocess.check_output(['openssl', 'dgst', '-sha256', '-sign', str(root/'key'), '-sigopt', 'rsa_padding_mode:pss', '-sigopt', 'rsa_pss_saltlen:32', str(root/'body')])
            envelope = {'schema':'exocortex.release-signature.v1','algorithm':'RSA-PSS-SHA256','key_id':hashlib.sha256(der).hexdigest(),'signature':base64.b64encode(signature).decode()}
            self.assertEqual(verify(body,json.dumps(envelope),public), {'product':'wyvern'})
            with self.assertRaises(subprocess.CalledProcessError): verify(body+b' ',json.dumps(envelope),public)
            envelope['key_id']='0'*64
            with self.assertRaises(ValueError): verify(body,json.dumps(envelope),public)

    def test_archive_is_validated_before_any_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); target=root/'out';target.mkdir()
            for name in ['../outside','/etc/passwd','updater/../escape','updater\\escape']:
                with tarfile.open(root/'bundle','w:gz') as archive:
                    entry=tarfile.TarInfo(name);entry.size=1;archive.addfile(entry,io.BytesIO(b'x'))
                with self.assertRaises(ValueError): extract(root/'bundle',target)
                self.assertEqual(list(target.iterdir()),[])
            with tarfile.open(root/'bundle','w:gz') as archive:
                entry=tarfile.TarInfo('install.sh');entry.type=tarfile.SYMTYPE;entry.linkname='/bin/sh';archive.addfile(entry)
            with self.assertRaises(ValueError): extract(root/'bundle',target)
            names=['install.sh','updater/install.sh','updater/updater-linux-amd64','updater/systemd/updater.service',
                   *('updater/release-trust/'+scope+'.pem' for scope in ['updater','neptune','gryphon','wyvern'])]
            with tarfile.open(root/'bundle','w:gz') as archive:
                for name in names:
                    entry=tarfile.TarInfo(name);entry.size=1;entry.mode=0o6777;archive.addfile(entry,io.BytesIO(b'x'))
            extract(root/'bundle',target)
            self.assertEqual((target/'updater/updater-linux-amd64').stat().st_mode&0o7777,0o755)


if __name__ == '__main__': unittest.main()
