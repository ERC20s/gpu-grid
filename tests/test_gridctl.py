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
JOB_FILE = os.path.join(HERE, 'fixtures', 'simple_job.json')


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


def test_gridctl_submits_and_streams_logs(httpserver, capsys):
    # Run the script as a subprocess to better emulate CLI
    script = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'scripts', 'gridctl.py')
    proc = subprocess.Popen([sys.executable, script, '--scheduler-url', httpserver, '--job-file', JOB_FILE], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stdout, stderr = proc.communicate(timeout=5)
    out = stdout.decode('utf-8')
    err = stderr.decode('utf-8')
    assert 'Job submitted: job-123' in out
    # logs should contain the lines produced
    assert 'starting' in out
    assert 'hello world' in out
    assert proc.returncode == 0
