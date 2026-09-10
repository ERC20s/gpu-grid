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
  await testSanitisesReservedFields(port);
  await testGetHosts(port);
  await testGetHostById(port);
  await testGetHostByEncodedId(port);
  await testGetUnknownHost(port);
  await testDeleteHostById(port);
  await testDeleteUnknownHost(port);
  await testDeleteHostByEncodedId(port);
  await testMatchUsesRegistry(port);
  await testRejectsInvalidHost(port);
  await testBulkPostAddsAllHosts(port);
  await testBulkPostAtomicReject(port);
  await testBulkPostRejectsDuplicateIds(port);

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

async function testSanitisesReservedFields(port) {
  const host = {
    id: 'host-reserved-1',
    model: 'A100',
    vram_mb: 16384,
    timestamp: 1620000000,
    seenAt: 123456789,
    stale: true,
    last_seen_ms_ago: 99999
  };

  const postRes = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(host));
  assert(postRes.statusCode === 200, 'POST /hosts should return 200');
  const returned = JSON.parse(postRes.body);
  assert(returned.id === host.id, 'returned host has id');
  assert(returned.seenAt === undefined && returned.stale === undefined && returned.last_seen_ms_ago === undefined, 'reserved fields removed from response');

  // Check stored entry does not carry the reserved fields in the host object
  const entry = server.hostRegistry.get(host.id);
  assert(entry, 'registry entry exists');
  assert(entry.host.seenAt === undefined, 'stored host does not contain seenAt');
  assert(entry.host.stale === undefined, 'stored host does not contain stale');
  assert(entry.host.last_seen_ms_ago === undefined, 'stored host does not contain last_seen_ms_ago');

  // The server should still have a server-side seenAt stamp for staleness
  assert(typeof entry.seenAt === 'number', 'entry carries a server-side seenAt stamp');
}

async function testGetHosts(port) {
  const res = await request({method: 'GET', port, path: '/hosts'});
  assert(res.statusCode === 200, 'GET /hosts 200');
  const payload = JSON.parse(res.body);
  assert(Array.isArray(payload.hosts), 'hosts array returned');
  assert(payload.hosts.length >= 1, 'at least one host present');
}

// New: ensure GET /hosts/:id returns the annotated host object for a known id
async function testGetHostById(port) {
  const res = await request({method: 'GET', port, path: '/hosts/host-1'});
  assert(res.statusCode === 200, 'GET /hosts/:id returns 200 for known id');
  const h = JSON.parse(res.body);
  assert(h.id === 'host-1', 'host id matches');
  assert(typeof h.last_seen_ms_ago === 'number', 'last_seen_ms_ago present');
  assert(typeof h.stale === 'boolean', 'stale flag present');
}

// New: an id with characters that must be percent-encoded (e.g. a space) can
// still be retrieved when the caller encodes it in the URL, as browsers and
// many HTTP clients do.
async function testGetHostByEncodedId(port) {
  const host = {id: 'host with space', model: 'A100', vram_mb: 24576, timestamp: 1620000000};
  const postRes = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(host));
  assert(postRes.statusCode === 200, 'POST /hosts should return 200 for encoded-id host');

  const encodedPath = '/hosts/' + encodeURIComponent(host.id);
  const res = await request({method: 'GET', port, path: encodedPath});
  assert(res.statusCode === 200, 'GET /hosts/:id returns 200 for URL-encoded id');
  const h = JSON.parse(res.body);
  assert(h.id === host.id, 'decoded host id matches original');
}

// New: unknown id returns 404 and error code
async function testGetUnknownHost(port) {
  const res = await request({method: 'GET', port, path: '/hosts/does-not-exist'});
  assert(res.statusCode === 404, 'GET /hosts/:id returns 404 for unknown id');
  const p = JSON.parse(res.body);
  assert(p.error === 'not_found', 'error code for not found');
}

// New: deleting a known host removes it from GET /hosts and GET /hosts/:id
// returns 404 for it afterwards.
async function testDeleteHostById(port) {
  const host = {id: 'host-delete-me', model: 'A100', vram_mb: 40960, timestamp: 1620000000};
  const postRes = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(host));
  assert(postRes.statusCode === 200, 'POST /hosts should return 200 for delete-target host');

  const delRes = await request({method: 'DELETE', port, path: '/hosts/host-delete-me'});
  assert(delRes.statusCode === 200, 'DELETE /hosts/:id returns 200 for known id');
  const delPayload = JSON.parse(delRes.body);
  assert(delPayload.deleted === true, 'deleted flag is true');
  assert(delPayload.id === 'host-delete-me', 'deleted response echoes id');

  const getRes = await request({method: 'GET', port, path: '/hosts/host-delete-me'});
  assert(getRes.statusCode === 404, 'GET /hosts/:id returns 404 after delete');

  const list = await request({method: 'GET', port, path: '/hosts'});
  const payload = JSON.parse(list.body);
  const ids = payload.hosts.map(h => h.id);
  assert(!ids.includes('host-delete-me'), 'deleted host absent from GET /hosts');
}

// New: deleting an unknown id returns 404 with the same error shape as GET.
async function testDeleteUnknownHost(port) {
  const res = await request({method: 'DELETE', port, path: '/hosts/does-not-exist'});
  assert(res.statusCode === 404, 'DELETE /hosts/:id returns 404 for unknown id');
  const p = JSON.parse(res.body);
  assert(p.error === 'not_found', 'error code for not found');
}

// New: a URL-encoded id round-trips through DELETE the same way GET already
// handles it (see testGetHostByEncodedId).
async function testDeleteHostByEncodedId(port) {
  const host = {id: 'host to delete', model: 'A100', vram_mb: 24576, timestamp: 1620000000};
  const postRes = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(host));
  assert(postRes.statusCode === 200, 'POST /hosts should return 200 for encoded-id delete host');

  const encodedPath = '/hosts/' + encodeURIComponent(host.id);
  const delRes = await request({method: 'DELETE', port, path: encodedPath});
  assert(delRes.statusCode === 200, 'DELETE /hosts/:id returns 200 for URL-encoded id');
  const delPayload = JSON.parse(delRes.body);
  assert(delPayload.id === host.id, 'decoded id echoed back in delete response');

  const getRes = await request({method: 'GET', port, path: encodedPath});
  assert(getRes.statusCode === 404, 'GET /hosts/:id returns 404 after encoded-id delete');
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

async function testBulkPostAddsAllHosts(port) {
  const hosts = [
    {id: 'bulk-1', model: 'A100', vram_mb: 40960, timestamp: 1620000000},
    {id: 'bulk-2', model: 'A100', vram_mb: 81920, timestamp: 1620000000}
  ];
  const res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(hosts));
  assert(res.statusCode === 200, 'bulk POST should return 200');
  const payload = JSON.parse(res.body);
  assert(Array.isArray(payload.hosts), 'response contains hosts array');
  assert(payload.hosts.length === 2, 'two hosts returned');

  // ensure they appear in GET /hosts
  const list = await request({method: 'GET', port, path: '/hosts'});
  const lpayload = JSON.parse(list.body);
  const ids = lpayload.hosts.map(h => h.id);
  assert(ids.includes('bulk-1') && ids.includes('bulk-2'), 'bulk hosts present in registry');
}

async function testBulkPostAtomicReject(port) {
  const hosts = [
    {id: 'bulk-3', model: 'A100', vram_mb: 40960, timestamp: 1620000000},
    {id: 'bulk-bad', model: 'A100', vram_mb: 81920, timestamp: 'not-a-number'}
  ];
  const res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(hosts));
  assert(res.statusCode === 400, 'bulk POST with an invalid host should return 400');
  const payload = JSON.parse(res.body);
  assert(payload.error === 'invalid_host', 'error code for invalid batch');

  // ensure none of the batch were added
  const list = await request({method: 'GET', port, path: '/hosts'});
  const lpayload = JSON.parse(list.body);
  const ids = lpayload.hosts.map(h => h.id);
  assert(!ids.includes('bulk-3') && !ids.includes('bulk-bad'), 'no hosts from invalid batch present');
}

async function testBulkPostRejectsDuplicateIds(port) {
  const hosts = [
    {id: 'dup-1', model: 'A100', vram_mb: 40960, timestamp: 1620000000},
    {id: 'dup-1', model: 'A100', vram_mb: 40960, timestamp: 1620000000}
  ];
  const res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(hosts));
  assert(res.statusCode === 400, 'bulk POST with duplicate ids should return 400');
  const payload = JSON.parse(res.body);
  assert(payload.error === 'invalid_host', 'error code for duplicate ids');

  // ensure none of the batch were added
  const list = await request({method: 'GET', port, path: '/hosts'});
  const lpayload = JSON.parse(list.body);
  const ids = lpayload.hosts.map(h => h.id);
  assert(!ids.includes('dup-1'), 'duplicate hosts not present');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
