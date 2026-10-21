"""End-to-end: the real scheduler (scheduler/index.js) driven by the real CLI.

The scheduler is started by a fixture on a free port, so no server has to be
running before pytest. Needs `node` on PATH.
"""
import os
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
    env = dict(os.environ, PORT=str(port))
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
    r = requests.post(url + '/hosts', json=host, timeout=5)
    assert r.status_code in (200, 201), r.text


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
                            'gpu_util_pct': 0, 'free_memory_mb': 30000, 'timestamp': now})

    proc = subprocess.run(
        [sys.executable, SCRIPT, '--scheduler-url', scheduler_url, '--job-file', MATCH_JOB_FILE],
        capture_output=True, text=True, timeout=10)

    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.splitlines()
    assert lines[0] == '2 host(s) matched, best first:', proc.stdout
    assert lines[1].split()[:2] == ['1.', 'host-idle'], proc.stdout
    assert lines[2].split()[:2] == ['2.', 'host-busy'], proc.stdout
    for excluded in ('host-v100', 'host-hot', 'host-small'):
        assert excluded not in proc.stdout
