import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bootstrap

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


publisher = module('publisher', 'publish-release.py')
scanner = module('scanner', 'security-scan.py')
prepush = module('prepush', 'pre-push.py')


class ReleaseSafetyTests(unittest.TestCase):
    def test_failed_final_verification_leaves_candidate_excluded_from_discovery(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=1, stdout='')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(assets=root, bundle=root / 'evidence', tag='wyvern-v0.0.1', repository='example/wyvern')
            with self.assertRaises(ValueError):
                publisher.publish(args, run=run, check=lambda _: (_ for _ in ()).throw(ValueError('asset mismatch')))
        created = next(args for args in calls if args[1:3] == ['release', 'create'])
        self.assertIn('--prerelease', created)
        self.assertFalse(any('--prerelease=false' in args for args in calls))

    def test_promotion_happens_after_completed_report_upload(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=1, stdout='')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'evidence').mkdir()
            def verified(args):
                calls.append(['verified'])
                (args.bundle / 'known-problems-report.json').write_text('{"release_qualification":true}', encoding='utf-8')
            publisher.publish(SimpleNamespace(assets=root, bundle=root / 'evidence', tag='wyvern-v0.0.1', repository='example/wyvern'), run=run, check=verified)
        self.assertEqual(calls[-2][1:3], ['release', 'upload'])
        self.assertIn('--prerelease=false', calls[-1])
        self.assertLess(calls.index(['verified']), len(calls) - 2)

    def test_direct_bootstrap_refuses_draft_prerelease_and_unknown_release_state(self):
        base = 'https://github.com/example/wyvern/releases/download/wyvern-v0.0.1'
        stable = {'tag_name': 'wyvern-v0.0.1', 'draft': False, 'prerelease': False}
        with patch.object(bootstrap, 'fetch', return_value=json.dumps(stable).encode()):
            bootstrap.published_release(base, '0.0.1')
        for value in [{**stable, 'prerelease': True}, {**stable, 'draft': True}, {'tag_name': stable['tag_name']}, {**stable, 'tag_name': 'wyvern-v0.0.2'}]:
            with patch.object(bootstrap, 'fetch', return_value=json.dumps(value).encode()), self.assertRaises(ValueError):
                bootstrap.published_release(base, '0.0.1')

    def test_ephemeral_signer_emits_only_signature_and_checks_pinned_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', str(root / 'private')], check=True, capture_output=True)
            public = subprocess.check_output(['openssl', 'pkey', '-in', str(root / 'private'), '-pubout'])
            secret = (root / 'private').read_text()
            (root / 'private').unlink()
            (root / 'public').write_bytes(public)
            body = b'{"product":"wyvern"}'
            (root / 'manifest').write_bytes(body)
            run = subprocess.run(['node', str(ROOT / 'scripts/sign-ephemeral.mjs'), str(root / 'manifest'), str(root / 'public')],
                                 env={**os.environ, 'WYVERN_SIGNING_KEY': secret}, capture_output=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(bootstrap.verify(body, (root / 'manifest.sig.json').read_bytes(), public), {'product': 'wyvern'})
            self.assertEqual(set(p.name for p in root.iterdir()), {'manifest', 'public', 'manifest.sig.json'})
            self.assertNotIn(secret.encode(), run.stdout + run.stderr)
            (root / 'manifest.sig.json').unlink()
            (root / 'public').write_bytes(b'wrong public trust')
            run = subprocess.run(['node', str(ROOT / 'scripts/sign-ephemeral.mjs'), str(root / 'manifest'), str(root / 'public')],
                                 env={**os.environ, 'WYVERN_SIGNING_KEY': secret}, capture_output=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertFalse((root / 'manifest.sig.json').exists())

    def test_scanner_detects_private_material_in_a_deleted_image_layer(self):
        findings = []
        marker = b'-----BEGIN ' + b'PRIVATE KEY-----\n' + b'A' * 100 + b'\n-----END ' + b'PRIVATE KEY-----'
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / 'image.tar'
            layer = io.BytesIO()
            with tarfile.open(fileobj=layer, mode='w') as archive:
                member = tarfile.TarInfo('old/credential.pem')
                member.size = len(marker)
                archive.addfile(member, io.BytesIO(marker))
            with tarfile.open(image, 'w') as archive:
                for name, body in [('manifest.json', b'[{"Layers":["layer.tar"]}]'), ('layer.tar', layer.getvalue())]:
                    member = tarfile.TarInfo(name)
                    member.size = len(body)
                    archive.addfile(member, io.BytesIO(body))
            scanner.scan_image(image, findings)
        self.assertEqual(findings[0]['rule'], 'private-key')
        self.assertNotIn('AAAA', json.dumps(findings))

    def test_gate_rejects_missing_areas_and_unclassified_routes(self):
        profile = json.loads((ROOT / 'docs/verification-profile.json').read_bytes())
        inventory = json.loads((ROOT / 'docs/exposure-inventory.json').read_bytes())
        server = (ROOT / 'src/server.js').read_text(encoding='utf-8')
        prepush.validate_profile(profile, inventory, server)
        with self.assertRaises(ValueError):
            prepush.validate_profile(profile, inventory, server + '\nconst route = "/v1/unclassified";')
        profile['areas'].pop('security')
        with self.assertRaises(ValueError):
            prepush.validate_profile(profile, inventory, server)
        prepush.workflow_policy()
