const http = require('http');
const assert = require('assert');
const server = require('../index');

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({statusCode: res.statusCode, headers: res.headers, body: data}));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runTests() {
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await testHealthEmpty(port);
  await testHealthReflectsRegistry(port);

  server.close();
  console.log('Health tests passed');
}

async function testHealthEmpty(port) {
  const res = await request({method: 'GET', port, path: '/health'});
  assert(res.statusCode === 200, 'GET /health should return 200');
  assert(res.headers['content-type'].includes('application/json'), 'health Content-Type');
  const payload = JSON.parse(res.body);
  assert(payload.status === 'ok', 'status ok');
  assert(typeof payload.now === 'number', 'now is number');
  assert(typeof payload.uptime_ms === 'number', 'uptime_ms is number');
  assert(typeof payload.host_count === 'number', 'host_count is number');
  assert(typeof payload.host_ttl_seconds === 'number', 'host_ttl_seconds is number');
}

async function testHealthReflectsRegistry(port) {
  // Post a host and then check /health reports host_count increased
  const host = {id: 'health-host-1', model: 'A100', vram_mb: 40960, timestamp: 1620000000};
  const post = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(host));
  assert(post.statusCode === 200, 'POST /hosts ok');

  const before = JSON.parse((await request({method: 'GET', port, path: '/health'})).body);
  // host_count should equal the hostRegistry size exported by the server
  assert(before.host_count === server.hostRegistry.size, 'host_count matches registry size');

  // Add another host
  const host2 = {id: 'health-host-2', model: 'A100', vram_mb: 40960, timestamp: 1620000001};
  const post2 = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(host2));
  assert(post2.statusCode === 200, 'POST second host ok');

  const after = JSON.parse((await request({method: 'GET', port, path: '/health'})).body);
  assert(after.host_count === server.hostRegistry.size, 'after host_count matches registry size');
  assert(after.host_count >= before.host_count + 1, 'host_count increased after posting host');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
