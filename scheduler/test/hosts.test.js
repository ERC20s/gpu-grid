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

  await testPostHost(port);
  await testGetHosts(port);
  await testMatchUsesRegistry(port);

  server.close();
  console.log('Hosts tests passed');
}

async function testPostHost(port) {
  const host = {id: 'host-1', model: 'A100', vram_mb: 40960, gpu_util_pct: 10, free_memory_mb: 20000, timestamp: 1620000000};
  const res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(host));
  assert(res.statusCode === 200, 'POST /hosts should return 200');
  const returned = JSON.parse(res.body);
  assert(returned.id === host.id, 'returned host has id');
}

async function testGetHosts(port) {
  const res = await request({method: 'GET', port, path: '/hosts'});
  assert(res.statusCode === 200, 'GET /hosts 200');
  const payload = JSON.parse(res.body);
  assert(Array.isArray(payload.hosts), 'hosts array returned');
  assert(payload.hosts.length >= 1, 'at least one host present');
}

async function testMatchUsesRegistry(port) {
  const job = {required_min_vram_mb: 4000};
  const res = await request({method: 'POST', port, path: '/match'}, JSON.stringify({job}));
  assert(res.statusCode === 200, '/match returns 200');
  const payload = JSON.parse(res.body);
  assert(Array.isArray(payload.matches), 'matches array');
  assert(payload.matches.length >= 1, 'registry host matched');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
