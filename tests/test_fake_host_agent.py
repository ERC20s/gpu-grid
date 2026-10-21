"""scripts/fake_host_agent.js (the docker-compose demo host) against a fake
scheduler that counts what it receives. Needs `node` on PATH.

setInterval() treats a delay that is 0, negative, not a number or above
2^31-1 ms as 1 ms, so an agent started with REPORT_INTERVAL_SECONDS=0 or a typo
used to send hundreds of host reports a second. It must refuse to start instead.
"""
import os
import shutil
import signal
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import pytest

HERE = os.path.dirname(__file__)
AGENT = os.path.join(os.path.dirname(HERE), 'scripts', 'fake_host_agent.js')


class CountingHandler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):  # keep the test output clean
        pass

    def _answer(self):
        length = int(self.headers.get('Content-Length', '0'))
        if length:
            self.rfile.read(length)
        CountingHandler.requests.append((self.command, self.path))
        body = b'{}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = _answer
    do_DELETE = _answer


@pytest.fixture
def counting_scheduler():
    CountingHandler.requests = []
    server = HTTPServer(('127.0.0.1', 0), CountingHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_port}'
    server.shutdown()


def _agent_env(url, interval):
    env = dict(os.environ, SCHEDULER_URL=url, HOST_ID='fake-host-1',
               HOST_TOKEN='fake-host-token-0123456789')
    env.pop('REPORT_INTERVAL_SECONDS', None)
    if interval is not None:
        env['REPORT_INTERVAL_SECONDS'] = interval
    return env


def _node():
    node = shutil.which('node')
    if node is None:
        pytest.fail('node is required to run the fake host agent tests')
    return node


@pytest.mark.parametrize('interval', ['0', '-5', 'thirty', '3000000'])
def test_agent_refuses_an_interval_setinterval_cannot_keep(counting_scheduler, interval):
    proc = subprocess.run([_node(), AGENT], env=_agent_env(counting_scheduler, interval),
                          capture_output=True, text=True, timeout=5)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert 'REPORT_INTERVAL_SECONDS' in proc.stderr, proc.stderr
    assert CountingHandler.requests == [], 'nothing was reported'


@pytest.mark.parametrize('interval', [None, '30'])
def test_agent_reports_once_per_interval_and_deregisters(counting_scheduler, interval):
    proc = subprocess.Popen([_node(), AGENT], env=_agent_env(counting_scheduler, interval),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.time() + 5
        while not CountingHandler.requests and time.time() < deadline:
            time.sleep(0.05)
        time.sleep(1)  # an agent stuck on a 1 ms interval would report hundreds of times here
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=5)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert proc.returncode == 0, out + err
    assert CountingHandler.requests == [('POST', '/hosts'), ('DELETE', '/hosts/fake-host-1')], \
        CountingHandler.requests
