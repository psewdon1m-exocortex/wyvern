import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import urllib.error

spec = importlib.util.spec_from_file_location('bootstrap_download', Path(__file__).with_name('bootstrap.py'))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class DownloadTest(unittest.TestCase):
    def test_transient_retry_after_then_exact_bytes(self):
        response = io.BytesIO(b'archive')
        response.headers = {'Content-Length': '7'}
        opener = Mock()
        opener.open.side_effect = [urllib.error.HTTPError('https://example.test/asset', 503, 'unavailable', {'Retry-After': '2'}, None), response]
        with patch.object(bootstrap.urllib.request, 'build_opener', return_value=opener), patch.object(bootstrap.time, 'sleep') as sleep:
            self.assertEqual(bootstrap.fetch('https://example.test/asset', 10), b'archive')
        self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(sleep.call_args.args, (2.0,))

    def test_permanent_failure_and_oversized_body_are_not_retried(self):
        for outcome in [urllib.error.HTTPError('https://example.test/asset', 404, 'missing', {}, None), io.BytesIO(b'oversized')]:
            opener = Mock()
            opener.open.side_effect = [outcome]
            with patch.object(bootstrap.urllib.request, 'build_opener', return_value=opener), patch.object(bootstrap.time, 'sleep') as sleep:
                with self.assertRaises((urllib.error.HTTPError, ValueError)):
                    bootstrap.fetch('https://example.test/asset', 3)
            self.assertEqual(opener.open.call_count, 1)
            sleep.assert_not_called()

    def test_transient_failures_have_finite_attempts(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError('temporarily unreachable')
        with patch.object(bootstrap.urllib.request, 'build_opener', return_value=opener), patch.object(bootstrap.time, 'sleep') as sleep:
            with self.assertRaises(urllib.error.URLError):
                bootstrap.fetch('https://example.test/asset', 10)
        self.assertEqual(opener.open.call_count, 4)
        self.assertEqual(sleep.call_count, 3)
