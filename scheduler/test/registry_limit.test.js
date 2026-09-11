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
  // Start the server on an ephemeral port
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  // Ensure registry is empty
  server.hostRegistry.clear();

  // Set MAX_HOSTS to 2 for this test by setting process.env
  process.env.MAX_HOSTS = '2';

  // Seed two hosts - should succeed
  let res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'r1', model: 'A100', vram_mb: 40960, timestamp: 1620000000}));
  assert(res.statusCode === 200, 'first seed should succeed');
  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'r2', model: 'A100', vram_mb: 40960, timestamp: 1620000000}));
  assert(res.statusCode === 200, 'second seed should succeed');

  // Third new host should be rejected with registry_full
  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'r3', model: 'A100', vram_mb: 40960, timestamp: 1620000000}));
  assert(res.statusCode === 507 || res.statusCode === 400, 'third new host should be rejected');
  const payload = JSON.parse(res.body);
  assert(payload.error === 'registry_full', 'error code for registry full');

  // Updating an existing host should still succeed
  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'r2', model: 'A100', vram_mb: 81920, timestamp: 1620000001}));
  assert(res.statusCode === 200, 'updating existing host should succeed');

  // Batch post where some ids already exist: net-new count considered
  const batch = [
    {id: 'r1', model: 'A100', vram_mb: 40960, timestamp: 1620000000},
    {id: 'r4', model: 'A100', vram_mb: 40960, timestamp: 1620000000}
  ];
  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(batch));
  // r4 would be the third unique id; should be rejected
  assert(res.statusCode === 507 || res.statusCode === 400, 'batch that would add net-new hosts beyond cap should be rejected');
  const p2 = JSON.parse(res.body);
  assert(p2.error === 'registry_full', 'batch error code should be registry_full');

  // Cleanup
  server.hostRegistry.clear();
  delete process.env.MAX_HOSTS;

  server.close();
  console.log('registry limit tests passed');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
