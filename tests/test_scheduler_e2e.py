"""End-to-end: the real scheduler (scheduler/index.js) driven by the real CLI.

The scheduler is started by a fixture on a free port, so no server has to be
running before pytest. Needs `node` on PATH. Tokens are generated per run:
each host id gets its own host token, and the CLI gets a user token through
GRID_USER_TOKEN.
"""
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time

import pytest
import requests

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)
SCHEDULER_DIR = os.path.join(ROOT, 'scheduler')
SCRIPT = os.path.join(ROOT, 'scripts', 'gridctl.py')
MATCH_JOB_FILE = os.path.join(HERE, 'fixtures', 'match_job.json')

HOST_IDS = ['host-busy', 'host-idle', 'host-v100', 'host-hot', 'host-small']
HOST_TOKENS = {host_id: secrets.token_hex(16) for host_id in HOST_IDS}
USER_TOKEN = secrets.token_hex(16)


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


@pytest.fixture(scope='module')
def scheduler_url():
    node = shutil.which('node')
    if node is None:
        pytest.fail('node is required to run the scheduler end-to-end tests')
    port = _free_port()
    env = dict(os.environ, PORT=str(port),
               HOST_TOKENS=json.dumps(HOST_TOKENS),
               USER_TOKENS=json.dumps({'e2e-user': USER_TOKEN}))
    proc = subprocess.Popen([node, 'index.js'], cwd=SCHEDULER_DIR, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    url = f'http://127.0.0.1:{port}'
    deadline = time.time() + 10
    while True:
        if proc.poll() is not None:
            out = proc.stdout.read().decode('utf-8', 'replace')
            pytest.fail(f'scheduler exited with {proc.returncode}: {out}')
        try:
            if requests.get(url + '/health', timeout=1).status_code == 200:
                break
        except requests.ConnectionError:
            pass
        if time.time() > deadline:
            proc.kill()
            pytest.fail('scheduler did not answer GET /health within 10s')
        time.sleep(0.1)
    yield url
    proc.terminate()
    proc.wait(timeout=5)


def _report(url, host):
    headers = {'Authorization': f"Bearer {HOST_TOKENS[host['id']]}"}
    r = requests.post(url + '/hosts', json=host, headers=headers, timeout=5)
    assert r.status_code in (200, 201), r.text


def _run_cli(url, job_file, token):
    env = dict(os.environ)
    env.pop('GRID_USER_TOKEN', None)
    if token is not None:
        env['GRID_USER_TOKEN'] = token
    return subprocess.run(
        [sys.executable, SCRIPT, '--scheduler-url', url, '--job-file', job_file],
        capture_output=True, text=True, timeout=10, env=env)


def test_cli_matches_live_registry(scheduler_url):
    now = int(time.time())
    # host-busy and host-idle both pass the filters; host-idle must rank first.
    _report(scheduler_url, {'id': 'host-busy', 'model': 'A100', 'vram_mb': 40960,
                            'gpu_util_pct': 50, 'free_memory_mb': 30000, 'timestamp': now})
    _report(scheduler_url, {'id': 'host-idle', 'model': 'RTX4090', 'vram_mb': 24576,
                            'gpu_util_pct': 5, 'free_memory_mb': 10000, 'timestamp': now})
    # Filtered out by acceptable_gpu_models, max_util_pct and required_min_vram_mb.
    _report(scheduler_url, {'id': 'host-v100', 'model': 'V100', 'vram_mb': 32768,
                            'gpu_util_pct': 0, 'free_memory_mb': 30000, 'timestamp': now})
    _report(scheduler_url, {'id': 'host-hot', 'model': 'A100', 'vram_mb': 40960,
                            'gpu_util_pct': 90, 'free_memory_mb': 30000, 'timestamp': now})
    _report(scheduler_url, {'id': 'host-small', 'model': 'A100', 'vram_mb': 4096,
                            'gpu_util_pct': 0, 'free_memory_mb': 4096, 'timestamp': now})

    proc = _run_cli(scheduler_url, MATCH_JOB_FILE, USER_TOKEN)

    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.splitlines()
    assert lines[0] == '2 host(s) matched, best first:', proc.stdout
    assert lines[1].split()[:2] == ['1.', 'host-idle'], proc.stdout
    assert lines[2].split()[:2] == ['2.', 'host-busy'], proc.stdout
    for excluded in ('host-v100', 'host-hot', 'host-small'):
        assert excluded not in proc.stdout


def test_unauthenticated_writes_are_rejected(scheduler_url):
    host = {'id': 'host-idle', 'model': 'RTX4090', 'vram_mb': 24576,
            'gpu_util_pct': 99, 'free_memory_mb': 1, 'timestamp': int(time.time())}
    r = requests.post(scheduler_url + '/hosts', json=host, timeout=5)
    assert r.status_code == 401, r.text
    other = {'Authorization': f"Bearer {HOST_TOKENS['host-busy']}"}
    r = requests.post(scheduler_url + '/hosts', json=host, headers=other, timeout=5)
    assert r.status_code == 403, r.text
    r = requests.delete(scheduler_url + '/hosts/host-idle', headers=other, timeout=5)
    assert r.status_code == 403, r.text
    r = requests.post(scheduler_url + '/match', json={'job': {}}, timeout=5)
    assert r.status_code == 401, r.text


def test_cli_without_token_is_refused(scheduler_url):
    proc = _run_cli(scheduler_url, MATCH_JOB_FILE, None)
    assert proc.returncode == 2, proc.stdout
    assert '401' in proc.stderr and 'GRID_USER_TOKEN' in proc.stderr, proc.stderr
    assert 'matched' not in proc.stdout


def test_cli_job_needing_more_free_memory_than_any_host_matches_nothing(scheduler_url, tmp_path):
    now = int(time.time())
    _report(scheduler_url, {'id': 'host-busy', 'model': 'A100', 'vram_mb': 40960,
                            'gpu_util_pct': 50, 'free_memory_mb': 30000, 'timestamp': now})
    job_file = tmp_path / 'big_job.json'
    job_file.write_text(json.dumps({'required_min_free_memory_mb': 40000}))
    proc = _run_cli(scheduler_url, str(job_file), USER_TOKEN)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == 'No hosts matched.', proc.stdout
