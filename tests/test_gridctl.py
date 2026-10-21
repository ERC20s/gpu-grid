import json
import subprocess
import sys
import os
import time

import pytest

import requests
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)
JOB_FILE = os.path.join(HERE, 'fixtures', 'simple_job.json')
MATCH_JOB_FILE = os.path.join(HERE, 'fixtures', 'match_job.json')
SCRIPT = os.path.join(ROOT, 'scripts', 'gridctl.py')

sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from gridctl import build_payload  # noqa: E402


class SimpleHandler(BaseHTTPRequestHandler):
    # Simple in-memory store for job state
    jobs = {}

    def _send_json(self, data, code=200):
        b = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        if self.path == '/match' or self.path == '/jobs':
            length = int(self.headers.get('Content-Length', '0'))
            body = self.rfile.read(length).decode('utf-8') if length else '{}'
            job = json.loads(body)
            job_id = 'job-123'
            # initialize job state
            SimpleHandler.jobs[job_id] = {'logs': [], 'status': 'running'}
            self._send_json({'id': job_id})
            # spawn a thread to simulate logs appearing
            def produce():
                time.sleep(0.1)
                SimpleHandler.jobs[job_id]['logs'].append('starting')
                time.sleep(0.1)
                SimpleHandler.jobs[job_id]['logs'].append('hello world')
                time.sleep(0.1)
                SimpleHandler.jobs[job_id]['status'] = 'finished'
            Thread(target=produce).start()
        else:
            self._send_json({'error': 'not found'}, code=404)

    def do_GET(self):
        if self.path.startswith('/jobs/') and self.path.endswith('/logs'):
            job_id = self.path.split('/')[-2]
            state = SimpleHandler.jobs.get(job_id)
            if not state:
                self._send_json({'error': 'not found'}, code=404)
                return
            self._send_json({'logs': state['logs'], 'status': state['status']})
        else:
            self._send_json({'error': 'not found'}, code=404)


@pytest.fixture(scope='module')
def httpserver():
    server = HTTPServer(('localhost', 0), SimpleHandler)
    port = server.server_port
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://localhost:{port}'
    server.shutdown()


class MatchHandler(BaseHTTPRequestHandler):
    """Fake scheduler that speaks the REAL POST /match contract.

    scheduler/index.js reads {"job": ..., "hosts": ...} and answers
    {"matches": [ <hosts in ranked order> ]}. A body without a "job" key means
    the CLI dropped the job spec, so this handler answers 400 for that instead
    of quietly matching everything - which is exactly the bug being fixed.
    """

    def log_message(self, *args):  # keep the test output clean
        pass

    def _send_json(self, data, code=200):
        b = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    last_payload = None
    posts = 0

    def do_POST(self):
        MatchHandler.posts += 1
        if self.path != '/match':
            self._send_json({'error': 'not found'}, code=404)
            return
        length = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(length).decode('utf-8') if length else '{}'
        payload = json.loads(body)
        MatchHandler.last_payload = payload
        job = payload.get('job')
        if not isinstance(job, dict):
            self._send_json({'error': 'invalid_json', 'message': 'missing job'}, code=400)
            return
        hosts = [
            {'id': 'host-a', 'model': 'A100', 'vram_mb': 40960,
             'gpu_util_pct': 5, 'free_memory_mb': 30000, 'timestamp': 1620000000},
            {'id': 'host-b', 'model': 'A100', 'vram_mb': 40960,
             'gpu_util_pct': 40, 'free_memory_mb': 12000, 'timestamp': 1620000000},
        ]
        required = job.get('required_min_vram_mb', 0)
        matches = [h for h in hosts if h['vram_mb'] >= required]
        matches.sort(key=lambda h: h['gpu_util_pct'])
        self._send_json({'matches': matches})


@pytest.fixture(scope='module')
def matchserver():
    server = HTTPServer(('localhost', 0), MatchHandler)
    port = server.server_port
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://localhost:{port}'
    server.shutdown()


def test_gridctl_prints_ranked_matches(matchserver):
    """The CLI must wrap the job as {"job": ...} and print the ranked hosts."""
    proc = subprocess.Popen(
        [sys.executable, SCRIPT, '--scheduler-url', matchserver, '--job-file', MATCH_JOB_FILE],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stdout, stderr = proc.communicate(timeout=10)
    out = stdout.decode('utf-8')
    err = stderr.decode('utf-8')
    assert proc.returncode == 0, err
    assert '2 host(s) matched' in out
    assert '1. host-a' in out
    assert 'gpu_util_pct=5' in out
    assert 'free_memory_mb=30000' in out
    assert '2. host-b' in out
    # The job spec really reached the scheduler in the shape it expects.
    payload = MatchHandler.last_payload
    assert isinstance(payload, dict)
    assert payload.get('job', {}).get('required_min_vram_mb') == 8192
    assert payload.get('job', {}).get('acceptable_gpu_models') == ['A100', 'RTX4090']


def test_gridctl_submits_and_streams_logs(httpserver, capsys):
    # Run the script as a subprocess to better emulate CLI
    script = SCRIPT
    proc = subprocess.Popen([sys.executable, script, '--scheduler-url', httpserver, '--job-file', JOB_FILE], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stdout, stderr = proc.communicate(timeout=5)
    out = stdout.decode('utf-8')
    err = stderr.decode('utf-8')
    assert 'Job submitted: job-123' in out
    # logs should contain the lines produced
    assert 'starting' in out
    assert 'hello world' in out
    assert proc.returncode == 0


# A job file the CLI cannot understand must never reach the scheduler as
# {"job": {}}: an empty job has no filter, so the whole live grid "matches"
# and the top host is handed a job that was never specified.
MALFORMED_JOB_DOCUMENTS = [
    ('a list', '[1, 2, 3]'),
    ('a string', '"just a string"'),
    ('a number', '42'),
    ('null', 'null'),
    ('a job key that is a string', '{"job": "not-an-object"}'),
    ('a job key that is null', '{"job": null}'),
    ('a job key that is a list', '{"job": [{"required_min_vram_mb": 1}]}'),
]


@pytest.mark.parametrize('what,text', MALFORMED_JOB_DOCUMENTS, ids=[w for w, _ in MALFORMED_JOB_DOCUMENTS])
def test_build_payload_refuses_malformed_job_document(what, text):
    with pytest.raises(ValueError) as excinfo:
        build_payload(json.loads(text))
    assert 'object' in str(excinfo.value)


def test_build_payload_wraps_a_bare_job_spec_and_passes_through_a_full_payload():
    assert build_payload({'required_min_vram_mb': 8192}) == {'job': {'required_min_vram_mb': 8192}}
    full = {'job': {'max_util_pct': 10}, 'hosts': [{'id': 'h', 'model': 'A100', 'vram_mb': 1, 'timestamp': 1}]}
    assert build_payload(full) == full
    # An empty object is a valid (unfiltered) job: only a wrongly SHAPED file is refused.
    assert build_payload({}) == {'job': {}}


@pytest.mark.parametrize('what,text', MALFORMED_JOB_DOCUMENTS, ids=[w for w, _ in MALFORMED_JOB_DOCUMENTS])
def test_gridctl_rejects_malformed_job_file_without_posting(matchserver, tmp_path, what, text):
    job_file = tmp_path / 'job.json'
    job_file.write_text(text)
    posts_before = MatchHandler.posts
    proc = subprocess.run(
        [sys.executable, SCRIPT, '--scheduler-url', matchserver, '--job-file', str(job_file)],
        capture_output=True, text=True, timeout=10)
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert 'Invalid job file' in proc.stderr, proc.stderr
    assert 'matched' not in proc.stdout, proc.stdout
    assert MatchHandler.posts == posts_before, 'nothing was posted to the scheduler'


# A "hosts" value that is not a list must not be dropped either: without it the
# scheduler matches the job against its whole live registry instead of the
# candidates the file named. The scheduler answers 400 for such a payload, so
# gridctl refuses it rather than quietly posting a different one.
MALFORMED_HOSTS_DOCUMENTS = [
    ('hosts an object', '{"job": {}, "hosts": {"id": "h", "model": "A100", "vram_mb": 1, "timestamp": 1}}'),
    ('hosts null', '{"job": {"max_util_pct": 10}, "hosts": null}'),
    ('hosts a string in a bare job spec', '{"required_min_vram_mb": 1, "hosts": "h"}'),
]


@pytest.mark.parametrize('what,text', MALFORMED_HOSTS_DOCUMENTS, ids=[w for w, _ in MALFORMED_HOSTS_DOCUMENTS])
def test_build_payload_refuses_hosts_that_are_not_a_list(what, text):
    with pytest.raises(ValueError) as excinfo:
        build_payload(json.loads(text))
    assert '"hosts" must be a JSON array' in str(excinfo.value)


def test_build_payload_passes_hosts_list_through_from_a_bare_job_spec():
    hosts = [{'id': 'h', 'model': 'A100', 'vram_mb': 1, 'timestamp': 1}]
    assert build_payload({'required_min_vram_mb': 1, 'hosts': hosts})['hosts'] == hosts


@pytest.mark.parametrize('what,text', MALFORMED_HOSTS_DOCUMENTS, ids=[w for w, _ in MALFORMED_HOSTS_DOCUMENTS])
def test_gridctl_rejects_malformed_hosts_without_posting(matchserver, tmp_path, what, text):
    job_file = tmp_path / 'job.json'
    job_file.write_text(text)
    posts_before = MatchHandler.posts
    proc = subprocess.run(
        [sys.executable, SCRIPT, '--scheduler-url', matchserver, '--job-file', str(job_file)],
        capture_output=True, text=True, timeout=10)
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert 'Invalid job file' in proc.stderr, proc.stderr
    assert 'matched' not in proc.stdout, proc.stdout
    assert MatchHandler.posts == posts_before, 'nothing was posted to the scheduler'
