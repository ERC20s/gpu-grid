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
  await testRejectsInvalidHost(port);

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

async function testRejectsInvalidHost(port) {
  // non-numeric timestamp
  const bad1 = {id: 'bad-1', model: 'A100', vram_mb: 40960, timestamp: 'not-a-number'};
  let res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(bad1));
  assert(res.statusCode === 400, 'non-numeric timestamp should be rejected');
  const p1 = JSON.parse(res.body);
  assert(p1.error === 'invalid_host', 'error code for invalid host');

  // gpu_util_pct out of range
  const bad2 = {id: 'bad-2', model: 'A100', vram_mb: 40960, timestamp: 1620000000, gpu_util_pct: 150};
  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(bad2));
  assert(res.statusCode === 400, 'gpu_util_pct out of range should be rejected');
  const p2 = JSON.parse(res.body);
  assert(p2.error === 'invalid_host', 'error code for invalid host');

  // id too long
  const longId = 'x'.repeat(300);
  const bad3 = {id: longId, model: 'A100', vram_mb: 40960, timestamp: 1620000000};
  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(bad3));
  assert(res.statusCode === 400, 'too long id should be rejected');
  const p3 = JSON.parse(res.body);
  assert(p3.error === 'invalid_host', 'error code for invalid host');

  // ensure none of the bad hosts were added
  const list = await request({method: 'GET', port, path: '/hosts'});
  const payload = JSON.parse(list.body);
  const ids = payload.hosts.map(h => h.id);
  assert(!ids.includes('bad-1') && !ids.includes('bad-2') && !ids.includes(longId), 'bad hosts not present');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
