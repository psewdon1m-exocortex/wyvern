import importlib.util
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bootstrap', root / 'packaging/bootstrap.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
assets = Path(sys.argv[1])
bootstrap.verify((assets / 'wyvern-release.json').read_bytes(), (assets / 'wyvern-release.json.sig.json').read_bytes(), (assets / 'wyvern.pem').read_bytes())
print('PASS: candidate signature matches pinned public trust')
