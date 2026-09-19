"""Reject fork/PR/stale inputs before downloading their workflow artifacts."""
import json
import os
import re
import subprocess
import sys

kind, run_id = sys.argv[1:]
if kind not in ('candidate', 'qualification') or not re.fullmatch(r'[1-9][0-9]*', run_id):
    raise ValueError('Set the exact successful candidate and qualification workflow run IDs')
repository, revision = os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_SHA']
result = json.loads(subprocess.check_output(['gh', 'api', 'repos/' + repository + '/actions/runs/' + run_id]))
if result.get('head_sha') != revision or result.get('conclusion') != 'success' or result.get('repository', {}).get('full_name') != repository \
        or result.get('head_repository', {}).get('full_name') != repository or result.get('event') not in ('workflow_dispatch', 'push', 'workflow_run'):
    raise ValueError('Workflow evidence is stale, untrusted or unsuccessful')
if kind == 'candidate' and result.get('path') != '.github/workflows/candidate.yml':
    raise ValueError('Candidate did not come from the trusted builder workflow')
print('PASS: exact-source ' + kind + ' run')
