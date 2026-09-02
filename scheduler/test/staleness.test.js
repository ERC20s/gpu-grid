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

const HOST = {
  id: 'host-stale-1',
  model: 'A100',
  vram_mb: 40960,
  gpu_util_pct: 10,
  free_memory_mb: 20000,
  timestamp: 1620000000
};

function ageEntryPastTtl(id) {
  const entry = server.hostRegistry.get(id);
  assert(entry, 'registry entry exists for ' + id);
  assert(typeof entry.seenAt === 'number', 'entry carries a server-side seenAt stamp');
  assert(entry.host.seenAt === undefined, 'seenAt is kept outside the host object');
  entry.seenAt = Date.now() - server.hostTtlMs() - 1000;
}

async function runTests() {
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await testTtlDefaultAndOverride();
  await testFreshHostMatches(port);
  await testStaleHostDropsOut(port);
  await testIncludeStaleStillLists(port);

  server.close();
  console.log('Staleness tests passed');
}

async function testTtlDefaultAndOverride() {
  const saved = process.env.HOST_TTL_SECONDS;
  delete process.env.HOST_TTL_SECONDS;
  assert(server.hostTtlMs() === 120000, 'default TTL is 120 seconds');
  process.env.HOST_TTL_SECONDS = '30';
  assert(server.hostTtlMs() === 30000, 'HOST_TTL_SECONDS is honoured');
  process.env.HOST_TTL_SECONDS = 'not-a-number';
  assert(server.hostTtlMs() === 120000, 'a junk TTL falls back to the default');
  if (saved === undefined) delete process.env.HOST_TTL_SECONDS;
  else process.env.HOST_TTL_SECONDS = saved;
}

async function testFreshHostMatches(port) {
  const posted = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(HOST));
  assert(posted.statusCode === 200, 'POST /hosts returns 200');

  const listed = JSON.parse((await request({method: 'GET', port, path: '/hosts'})).body);
  assert(listed.hosts.length === 1, 'a fresh host is listed');
  assert(listed.hosts[0].id === HOST.id, 'the listed host is the one posted');
  assert(listed.host_ttl_seconds > 0, 'GET /hosts reports the TTL in force');

  const matched = JSON.parse((await request(
    {method: 'POST', port, path: '/match'},
    JSON.stringify({job: {required_min_vram_mb: 4000}})
  )).body);
  assert(matched.matches.length === 1, 'a fresh registry host wins a match');
}

async function testStaleHostDropsOut(port) {
  ageEntryPastTtl(HOST.id);

  const matched = JSON.parse((await request(
    {method: 'POST', port, path: '/match'},
    JSON.stringify({job: {required_min_vram_mb: 4000}})
  )).body);
  assert(matched.matches.length === 0, 'a stale host never wins a match');

  const listed = JSON.parse((await request({method: 'GET', port, path: '/hosts'})).body);
  assert(listed.hosts.length === 0, 'GET /hosts hides stale hosts');
  assert(server.hostRegistry.size === 0, 'the expired entry is evicted from the map');

  // An explicit hosts array in the payload is still trusted as before.
  const explicit = JSON.parse((await request(
    {method: 'POST', port, path: '/match'},
    JSON.stringify({job: {required_min_vram_mb: 4000}, hosts: [HOST]})
  )).body);
  assert(explicit.matches.length === 1, 'payload-supplied hosts are unaffected by the TTL');
}

async function testIncludeStaleStillLists(port) {
  await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(HOST));
  ageEntryPastTtl(HOST.id);

  const all = JSON.parse((await request({method: 'GET', port, path: '/hosts?include_stale=1'})).body);
  assert(all.hosts.length === 1, 'include_stale lists the dead host');
  assert(all.hosts[0].stale === true, 'the dead host is marked stale');
  assert(typeof all.hosts[0].last_seen_ms_ago === 'number', 'last_seen_ms_ago is reported');
  assert(server.hostRegistry.size === 1, 'the stale view does not evict');

  // A re-report brings the same host straight back into matching.
  await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(HOST));
  const listed = JSON.parse((await request({method: 'GET', port, path: '/hosts'})).body);
  assert(listed.hosts.length === 1, 'a re-reporting host returns to the live list');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
