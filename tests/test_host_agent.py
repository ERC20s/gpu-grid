import json
import subprocess
import sys
import os
import time

import pytest
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

HERE = os.path.dirname(__file__)


class HostHandler(BaseHTTPRequestHandler):
    received = None

    def _send_json(self, data, code=200):
        b = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        if self.path == '/hosts':
            length = int(self.headers.get('Content-Length', '0'))
            body = self.rfile.read(length).decode('utf-8') if length else '{}'
            HostHandler.received = json.loads(body or '{}')
            self._send_json(HostHandler.received)
        else:
            self._send_json({'error': 'not found'}, code=404)


@pytest.fixture(scope='module')
def httpserver():
    server = HTTPServer(('localhost', 0), HostHandler)
    port = server.server_port
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://localhost:{port}'
    server.shutdown()


def test_host_agent_posts_to_scheduler(httpserver):
    script = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'scripts', 'host_agent.py')
    proc = subprocess.Popen([sys.executable, script, '--scheduler-url', httpserver], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stdout, stderr = proc.communicate(timeout=5)
    out = stdout.decode('utf-8')
    err = stderr.decode('utf-8')
    assert proc.returncode == 0
    # stdout should be a JSON object equal to what the server echoed
    data = json.loads(out)
    assert data.get('id')
    assert data.get('model')
    assert isinstance(data.get('vram_mb'), int)
    assert isinstance(data.get('timestamp'), int)
    # ensure handler saw same payload
    assert HostHandler.received is not None
    assert HostHandler.received['id'] == data['id']
    assert HostHandler.received['model'] == data['model']
    assert 'gpu_util_pct' in HostHandler.received
    assert 'free_memory_mb' in HostHandler.received
