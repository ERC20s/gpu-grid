const http = require('http');
const assert = require('assert');

// Start the scheduler server directly
const server = require('../index');

function postJson(url, obj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(obj);
    const u = new URL(url);
    const opts = {method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)}};
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { const d = JSON.parse(body || '{}'); resolve({status: res.statusCode, data: d}); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname};
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { const d = JSON.parse(body || '{}'); resolve({status: res.statusCode, data: d}); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  const port = 4000;
  server.listen(port);
  const base = `http://localhost:${port}`;

  // Submit a job
  const {status, data} = await postJson(`${base}/jobs`, {task: 'test'});
  assert(status === 200, 'job POST should return 200');
  assert(data.id, 'response should contain id');
  const jobId = data.id;

  // Poll logs until finished
  let finished = false;
  let logsSeen = [];
  for (let i = 0; i < 20; i++) {
    const res = await getJson(`${base}/jobs/${jobId}/logs`);
    assert(res.status === 200, 'logs endpoint should return 200');
    const body = res.data;
    logsSeen = body.logs || [];
    if ((body.status || '').toLowerCase() === 'finished') { finished = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }

  assert(finished, 'job should finish within timeout');
  assert(logsSeen.includes('starting'), 'logs should include starting');
  assert(logsSeen.includes('hello world'), 'logs should include hello world');

  server.close();
  console.log('jobs API tests passed');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
