const http = require('http');
const assert = require('assert');
const server = require('../index');

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({statusCode: res.statusCode, body: data}));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runTests() {
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const job = {task: 'echo hello'};
  // POST /jobs
  const res = await request({method: 'POST', port, path: '/jobs'}, JSON.stringify(job));
  assert(res.statusCode === 200, 'POST /jobs should return 200');
  const data = JSON.parse(res.body);
  const jobId = data.id;
  assert(typeof jobId === 'string' && jobId.startsWith('job-'), 'returned id present');

  // Poll logs until finished or timeout
  const start = Date.now();
  let finished = false;
  let lastLogs = [];
  while (Date.now() - start < 5000) {
    const r = await request({method: 'GET', port, path: `/jobs/${jobId}/logs`});
    assert(r.statusCode === 200, 'GET logs 200');
    const payload = JSON.parse(r.body);
    lastLogs = payload.logs;
    if (payload.status === 'finished') { finished = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  assert(finished, 'job should finish within timeout');
  assert(lastLogs.length >= 1, 'logs should have at least one line');

  server.close();
  console.log('Jobs tests passed');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
