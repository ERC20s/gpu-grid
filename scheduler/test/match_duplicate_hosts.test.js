// Test that POST /match rejects a hosts array containing duplicate ids.
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

function postMatch(port, body) {
  return request({method: 'POST', port, path: '/match'}, body);
}

async function run() {
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  // A benign seed so the registry is not empty; not strictly necessary for
  // the test as we're providing explicit hosts, but keeps the server state
  // similar to other match tests.
  await request({method: 'POST', port, path: '/hosts'}, JSON.stringify([
    {id: 'seed-1', model: 'A100', vram_mb: 40960, gpu_util_pct: 5, free_memory_mb: 30000, timestamp: 1620000000}
  ]));

  const body = {
    job: {required_min_vram_mb: 1000},
    hosts: [
      {id: 'dup', model: 'A100', vram_mb: 40960, gpu_util_pct: 3, free_memory_mb: 100, timestamp: 1620000000},
      {id: 'dup', model: 'A100', vram_mb: 40960, gpu_util_pct: 4, free_memory_mb: 200, timestamp: 1620000000}
    ]
  };

  const res = await postMatch(port, JSON.stringify(body));
  assert(res.statusCode === 400, `expected 400 for duplicate host ids, got ${res.statusCode}`);
  const payload = JSON.parse(res.body);
  assert(payload.error === 'invalid_job', `expected error invalid_job, got ${payload.error}`);
  assert(typeof payload.message === 'string' && payload.message.indexOf('duplicate id') !== -1, 'message should mention duplicate id');
  assert(payload.message.indexOf('dup') !== -1, 'message should include the offending id');

  server.close();
  console.log('match duplicate hosts test passed');
}

if (require.main === module) run().catch(err => { console.error(err); process.exit(1); });
