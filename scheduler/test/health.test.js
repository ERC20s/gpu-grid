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

  await testHealthBasic(port);
  await testHealthAfterPost(port);

  server.close();
  console.log('Health tests passed');
}

async function testHealthBasic(port) {
  const res = await request({method: 'GET', port, path: '/health'});
  assert(res.statusCode === 200, 'GET /health should return 200');
  assert(res.headers['content-type'] && res.headers['content-type'].includes('application/json'), 'Content-Type is application/json');
  const payload = JSON.parse(res.body);
  assert(payload.status === 'ok', 'status ok');
  assert(typeof payload.now === 'number', 'now is a number');
  assert(typeof payload.uptime_ms === 'number', 'uptime_ms is a number');
  assert(typeof payload.host_ttl_seconds === 'number', 'host_ttl_seconds is a number');
}

async function testHealthAfterPost(port) {
  const host = {id: 'h-health', model: 'A100', vram_mb: 40960, timestamp: Date.now()};
  const post = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(host));
  assert(post.statusCode === 200, 'POST /hosts should succeed');

  const res = await request({method: 'GET', port, path: '/health'});
  assert(res.statusCode === 200, 'GET /health after POST should return 200');
  const payload = JSON.parse(res.body);
  assert(payload.status === 'ok', 'status ok after post');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
