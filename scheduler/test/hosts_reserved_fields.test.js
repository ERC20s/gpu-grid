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

  await testSanitisesReservedFields(port);

  server.close();
  console.log('Reserved fields sanitisation tests passed');
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

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
