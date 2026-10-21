const http = require('http');
const assert = require('assert');
const server = require('../index');
const { withAuth } = require('./support/auth');

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(withAuth(options, body), res => {
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

  await testExpiredHostsDoNotHoldASlot(port);
  await testHeartbeatUnderTheCapDoesNotWalkTheRegistry(port);

  // Cleanup
  server.hostRegistry.clear();
  delete process.env.MAX_HOSTS;

  server.close();
  console.log('registry limit tests passed');
}

// A host whose TTL has run out is dead. It used to keep its slot until the
// periodic sweeper ran (up to half a TTL later), so with the registry full of
// dead hosts a live host reporting for the first time got 507.
async function testExpiredHostsDoNotHoldASlot(port) {
  server.hostRegistry.clear();
  process.env.MAX_HOSTS = '1';

  let res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'cap-dead', model: 'A100', vram_mb: 40960, timestamp: 1620000000}));
  assert.strictEqual(res.statusCode, 200, 'the only slot goes to the first host');
  const dead = server.hostRegistry.get('cap-dead');
  assert(dead, 'cap-dead is registered');
  dead.seenAt = Date.now() - server.hostTtlMs() - 1000; // past the TTL, not yet swept

  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'cap-live', model: 'A100', vram_mb: 40960, timestamp: 1620000001}));
  assert.strictEqual(res.statusCode, 200, `a live host takes the dead host's slot, got ${res.statusCode} ${res.body}`);
  assert.deepStrictEqual(Array.from(server.hostRegistry.keys()), ['cap-live'], 'the dead host is gone and the live one is in');

  // The batch path makes the same decision.
  server.hostRegistry.get('cap-live').seenAt = Date.now() - server.hostTtlMs() - 1000;
  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify([{id: 'cap-batch', model: 'A100', vram_mb: 40960, timestamp: 1620000002}]));
  assert.strictEqual(res.statusCode, 200, `a batch takes the dead host's slot, got ${res.statusCode} ${res.body}`);
  assert.deepStrictEqual(Array.from(server.hostRegistry.keys()), ['cap-batch']);

  // A live host still holds its slot: the cap is enforced, not bypassed.
  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'cap-extra', model: 'A100', vram_mb: 40960, timestamp: 1620000003}));
  assert.strictEqual(res.statusCode, 507, 'a second live host is still over the cap');
  assert.strictEqual(JSON.parse(res.body).error, 'registry_full');
}

// Eviction is only needed to make room. Walking the whole registry on every
// report made each heartbeat O(registry size) as soon as MAX_HOSTS was set
// (about 10x slower per report at 100k hosts), and dropped a stale host that
// GET /hosts/:id should still report as stale while the cap had room to spare.
async function testHeartbeatUnderTheCapDoesNotWalkTheRegistry(port) {
  server.hostRegistry.clear();
  process.env.MAX_HOSTS = '10';

  let res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'hb-quiet', model: 'A100', vram_mb: 40960, timestamp: 1620000000}));
  assert.strictEqual(res.statusCode, 200);
  res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'hb-busy', model: 'A100', vram_mb: 40960, timestamp: 1620000000}));
  assert.strictEqual(res.statusCode, 200);
  server.hostRegistry.get('hb-quiet').seenAt = Date.now() - server.hostTtlMs() - 1000;

  // Count full walks of the registry made while the reports below are handled.
  let walks = 0;
  const iterate = Map.prototype[Symbol.iterator];
  server.hostRegistry[Symbol.iterator] = function () {
    walks += 1;
    return iterate.call(this);
  };
  try {
    res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'hb-busy', model: 'A100', vram_mb: 40960, timestamp: 1620000001}));
    assert.strictEqual(res.statusCode, 200, 'a heartbeat from a registered host');
    res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify({id: 'hb-new', model: 'A100', vram_mb: 40960, timestamp: 1620000001}));
    assert.strictEqual(res.statusCode, 200, 'a new host while the cap has room');
    res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify([{id: 'hb-busy', model: 'A100', vram_mb: 40960, timestamp: 1620000002}, {id: 'hb-new2', model: 'A100', vram_mb: 40960, timestamp: 1620000002}]));
    assert.strictEqual(res.statusCode, 200, 'a batch while the cap has room');
  } finally {
    delete server.hostRegistry[Symbol.iterator];
  }
  assert.strictEqual(walks, 0, `reports that fit under MAX_HOSTS walked the registry ${walks} time(s)`);

  res = await request({method: 'GET', port, path: '/hosts/hb-quiet'});
  assert.strictEqual(res.statusCode, 200, 'the quiet host is still registered');
  assert.strictEqual(JSON.parse(res.body).stale, true, 'and reported as stale');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
