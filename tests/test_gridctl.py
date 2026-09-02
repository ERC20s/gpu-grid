import json
import subprocess
import sys
import os
import time

import pytest

from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

HERE = os.path.dirname(__file__)
JOB_FILE = os.path.join(HERE, 'fixtures', 'simple_job.json')
SCRIPT = os.path.join(os.path.dirname(HERE), 'scripts', 'gridctl.py')


class _JsonHandler(BaseHTTPRequestHandler):
    def _send_json(self, data, code=200):
        b = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(length).decode('utf-8') if length else '{}'
        return json.loads(body)

    def log_message(self, fmt, *args):  # keep pytest output clean
        pass


class MatchHandler(_JsonHandler):
    """Answers POST /match exactly as scheduler/index.js does."""

    # Bodies the CLI sent, so a test can assert the wrapped contract.
    received = []

    HOSTS = [
        {'id': 'host-a', 'model': 'A100', 'vram_mb': 40960,
         'gpu_util_pct': 10, 'free_memory_mb': 20000, 'timestamp': 1620000000},
        {'id': 'host-b', 'model': 'A100', 'vram_mb': 24576,
         'gpu_util_pct': 40, 'free_memory_mb': 8000, 'timestamp': 1620000100},
    ]

    def do_POST(self):
        if self.path != '/match':
            self._send_json({'error': 'not_found'}, code=404)
            return
        payload = self._read_json()
        MatchHandler.received.append(payload)
        job = payload.get('job')
        if not isinstance(job, dict):
            # The real scheduler would silently match an empty job here; the
            # fake makes that failure loud instead.
            self._send_json({'error': 'job_not_wrapped'}, code=400)
            return
        self._send_json({'matches': MatchHandler.HOSTS})


class JobHandler(_JsonHandler):
    """A future-executor style scheduler: answers with a job id and serves the
    whole log so far on every poll of /jobs/<id>/logs."""

    jobs = {}

    def do_POST(self):
        if self.path not in ('/match', '/jobs'):
            self._send_json({'error': 'not_found'}, code=404)
            return
        self._read_json()
        job_id = 'job-123'
        JobHandler.jobs[job_id] = {'logs': [], 'status': 'running'}
        self._send_json({'id': job_id})

        def produce():
            time.sleep(0.15)
            JobHandler.jobs[job_id]['logs'].append('starting')
            time.sleep(0.25)
            JobHandler.jobs[job_id]['logs'].append('hello world')
            time.sleep(0.25)
            JobHandler.jobs[job_id]['status'] = 'finished'

        Thread(target=produce).start()

    def do_GET(self):
        if self.path.startswith('/jobs/') and self.path.endswith('/logs'):
            job_id = self.path.split('/')[-2]
            state = JobHandler.jobs.get(job_id)
            if not state:
                self._send_json({'error': 'not found'}, code=404)
                return
            self._send_json({'logs': list(state['logs']), 'status': state['status']})
        else:
            self._send_json({'error': 'not found'}, code=404)


def _serve(handler):
    server = HTTPServer(('localhost', 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f'http://localhost:{server.server_port}'


@pytest.fixture(scope='module')
def match_server():
    server, url = _serve(MatchHandler)
    yield url
    server.shutdown()


@pytest.fixture(scope='module')
def job_server():
    server, url = _serve(JobHandler)
    yield url
    server.shutdown()


def run_cli(*args, timeout=15):
    proc = subprocess.Popen([sys.executable, SCRIPT, *args],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stdout, stderr = proc.communicate(timeout=timeout)
    return proc.returncode, stdout.decode('utf-8'), stderr.decode('utf-8')


def test_gridctl_prints_ranked_hosts_from_real_match_contract(match_server):
    """The shape the shipped scheduler actually returns: {"matches": [...]}"""
    MatchHandler.received.clear()
    code, out, err = run_cli('--scheduler-url', match_server, '--job-file', JOB_FILE)
    assert code == 0, err
    assert 'host-a' in out
    assert 'host-b' in out
    # The job must be sent wrapped, or scheduler/index.js matches an empty job.
    assert MatchHandler.received, 'CLI did not POST /match'
    body = MatchHandler.received[-1]
    assert isinstance(body.get('job'), dict)
    assert body['job']['image'] == 'busybox'


def test_gridctl_json_output_is_the_match_list(match_server):
    code, out, err = run_cli('--scheduler-url', match_server,
                             '--job-file', JOB_FILE, '--json')
    assert code == 0, err
    parsed = json.loads(out.strip())
    assert [h['id'] for h in parsed] == ['host-a', 'host-b']


def test_gridctl_submits_and_streams_logs(job_server):
    code, out, err = run_cli('--scheduler-url', job_server, '--job-file', JOB_FILE,
                             '--poll-interval', '0.05')
    assert 'Job submitted: job-123' in out
    assert 'starting' in out
    assert 'hello world' in out
    assert code == 0, err


def test_gridctl_prints_each_log_line_once(job_server):
    """The logs endpoint replays the whole log every poll; the CLI must not."""
    code, out, err = run_cli('--scheduler-url', job_server, '--job-file', JOB_FILE,
                             '--poll-interval', '0.05')
    assert code == 0, err
    assert out.count('starting') == 1
    assert out.count('hello world') == 1
