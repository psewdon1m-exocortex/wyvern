import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).resolve().parents[1] / 'scripts/verify-qualification.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
published_spec = importlib.util.spec_from_file_location('published', Path(__file__).resolve().parents[1] / 'scripts/verify-published.py')
published = importlib.util.module_from_spec(published_spec)
published_spec.loader.exec_module(published)


class QualificationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.revision = 'a' * 40
        self.catalog = b'| **REL-01** | A real problem description | A real solution description |\n| **REL-06** | Signature of final artifacts | Download and verify artifacts |\n'
        self.policy = {'revision': 'b' * 40, 'sha256': gate.digest(self.catalog)}
        assets = self.root / 'assets'
        assets.mkdir()
        manifest = {'source_sha': self.revision, 'version': '0.0.1', 'image': 'ghcr.io/example/wyvern@sha256:' + 'e' * 64,
                    'installer': {'url': 'https://github.com/example/wyvern/releases/download/wyvern-v0.0.1/wyvern-install.tar.gz', 'sha256': gate.digest(b'archive')}}
        values = {'wyvern-release.json': json.dumps(manifest).encode(), 'wyvern-release.json.sig.json': b'signature',
                  'wyvern-install.tar.gz': b'archive', 'bootstrap.sh': b'bootstrap', 'wyvern.pem': b'public',
                  'sbom.spdx.json': b'{"spdxVersion":"SPDX-2.3","packages":[{"name":"node"}]}',
                  'image-provenance.json': b'{}', 'image-sbom-attestation.json': b'{}'}
        for name, body in values.items():
            (assets / name).write_bytes(body)
        _, self.candidate = gate.contract.create_candidate(assets, self.revision, self.policy)
        (self.root / 'execution.log').write_bytes(b'synthetic command passed\n')
        proof = {'schema': 'wyvern.verification.v1', 'revision': self.revision, 'catalog_sha256': gate.digest(self.catalog), 'status': 'PASS', 'problem_ids': ['REL-01'], 'command': 'synthetic-test', 'exit_code': 0, 'log': 'execution.log', 'log_sha256': gate.digest((self.root / 'execution.log').read_bytes())}
        proof['candidate_sha256'] = self.candidate
        (self.root / 'execution.json').write_text(json.dumps(proof), encoding='utf-8')
        self.report = {'schema_version': 1, 'service': 'wyvern', 'revision': self.revision, 'release_tag': 'wyvern-v0.0.1', 'catalog_repository': 'https://github.com/psewdon1m-exocortex/general', 'catalog_path': gate.CATALOG, 'catalog_revision': 'b' * 40, 'catalog_sha256': gate.digest(self.catalog), 'checks': [{'id': 'REL-01', 'status': 'PASS', 'evidence': [{'path': 'execution.json', 'sha256': gate.digest((self.root / 'execution.json').read_bytes())}]}, {'id': 'REL-06', 'status': 'DEFERRED', 'required_phase': 'final', 'reason': 'Final signed artifacts are verified after anonymous download.'}]}
        self.report['candidate_sha256'] = self.candidate
        self.pin = patch.object(published.gate.contract, 'policy', return_value=self.policy)
        self.pin.start()
        self.addCleanup(self.pin.stop)

    def verify(self, report=None, **kwargs):
        (self.root / 'known-problems-report.json').write_text(json.dumps(report or self.report), encoding='utf-8')
        return gate.verify(self.root, self.revision, 'wyvern-v0.0.1', self.catalog, candidate=self.candidate, policy=self.policy, **kwargs)

    def test_exact_evidence_and_only_final_deferral(self):
        self.verify()
        with self.assertRaises(ValueError):
            self.verify(final=True)
        bad = copy.deepcopy(self.report)
        bad['checks'][0] = {**bad['checks'][1], 'id': 'REL-01'}
        with self.assertRaises(ValueError):
            self.verify(bad)

    def test_stale_missing_duplicate_and_unknown_fail_closed(self):
        for mutation in [lambda r: r.update(revision='c' * 40), lambda r: r['checks'].pop(), lambda r: r['checks'].__setitem__(1, r['checks'][0]), lambda r: r['checks'][0].update(status='UNKNOWN'), lambda r: r.update(catalog_sha256='d' * 64)]:
            bad = copy.deepcopy(self.report)
            mutation(bad)
            with self.assertRaises(ValueError):
                self.verify(bad)

    def test_not_applicable_before_pass_preserves_candidate_identity(self):
        self.catalog += b'| **UI-01** | A user interface requirement | Inspect whether an interface exists |\n'
        self.policy['sha256'] = gate.digest(self.catalog)
        _, self.candidate = gate.contract.create_candidate(self.root / 'assets', self.revision, self.policy)
        proof = gate.read_json(self.root / 'execution.json')
        proof.update(candidate_sha256=self.candidate, catalog_sha256=self.policy['sha256'])
        (self.root / 'execution.json').write_text(json.dumps(proof), encoding='utf-8')
        self.report.update(candidate_sha256=self.candidate, catalog_sha256=self.policy['sha256'])
        self.report['checks'][0]['evidence'][0]['sha256'] = gate.digest((self.root / 'execution.json').read_bytes())
        self.report['checks'].insert(0, {'id': 'UI-01', 'status': 'N/A', 'profile': 'exocortex.wyvern.release.v1',
                                       'reason': 'This headless gateway has no browser interface or Settings page of its own.',
                                       'inspected_paths': ['src/server.js']})
        self.verify()

    def test_log_tampering_and_path_escape_fail(self):
        (self.root / 'execution.log').write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.verify()
        for path in ('../execution.json', '/execution.json', 'a//b', 'C:/secret'):
            with self.assertRaises(ValueError):
                gate.safe_file(self.root, path)

    def published_fixture(self):
        self.verify()
        (self.root / 'catalog.md').write_bytes(self.catalog)
        assets = self.root / 'assets'
        return SimpleNamespace(assets=assets, bundle=self.root, public_key=assets/'wyvern.pem', revision=self.revision, tag='wyvern-v0.0.1', repository='example/wyvern')

    def test_final_asset_check_closes_deferral(self):
        args = self.published_fixture()
        refs = self.revision + '\trefs/heads/main\n' + self.revision + '\trefs/tags/wyvern-v0.0.1\n'
        with patch.object(published.bootstrap, 'fetch', side_effect=lambda url, limit: (args.assets/url.rsplit('/', 1)[-1]).read_bytes()), patch.object(published.bootstrap, 'verify'), patch.object(published.subprocess, 'check_output', return_value=refs), patch.object(published.subprocess, 'run') as pull:
            published.check(args)
            self.assertEqual(pull.call_args.args[0][:2], ['docker', 'pull'])
            self.assertFalse(Path(pull.call_args.kwargs['env']['DOCKER_CONFIG']).exists())
        gate.verify(self.root, self.revision, args.tag, self.catalog, candidate=self.candidate, policy=self.policy, final=True)

    def test_another_candidate_or_old_catalog_is_rejected_on_identical_source(self):
        for name, value in [('candidate_sha256', 'e' * 64), ('catalog_revision', 'd' * 40)]:
            bad = copy.deepcopy(self.report)
            bad[name] = value
            with self.assertRaises(ValueError):
                self.verify(bad)
        (self.root / 'assets/wyvern-install.tar.gz').write_bytes(b'changed candidate same commit')
        with self.assertRaises(ValueError):
            gate.contract.verify_candidate(self.root / 'assets', self.revision, self.policy)

    def test_changed_anonymous_asset_does_not_close_report(self):
        args = self.published_fixture()
        with patch.object(published.bootstrap, 'fetch', return_value=b'changed'):
            with self.assertRaises(ValueError):
                published.check(args)
        self.assertFalse(gate.read_json(self.root/'known-problems-report.json').get('release_qualification', False))
