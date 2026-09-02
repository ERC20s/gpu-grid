const http = require('http');
const assert = require('assert');
const { validateHost } = require('../lib/validateHost');
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

// ---- unit tests for validateHost -------------------------------------------

function testCoercion() {
  const res = validateHost({id: 'host-1', model: 'A100', vram_mb: '40960', gpu_util_pct: '12', timestamp: '1620000000'});
  assert(res.ok, 'numeric strings are accepted');
  assert.strictEqual(res.host.vram_mb, 40960, 'vram_mb coerced to number');
  assert.strictEqual(res.host.gpu_util_pct, 12, 'gpu_util_pct coerced to number');
  assert.strictEqual(res.host.timestamp, 1620000000, 'timestamp coerced to number');
}

function testExtraFieldsPreserved() {
  const res = validateHost({id: 'host-1', model: 'A100', vram_mb: 40960, timestamp: 1, region: 'eu-west'});
  assert(res.ok, 'unknown fields do not fail validation');
  assert.strictEqual(res.host.region, 'eu-west', 'unknown fields are preserved');
}

function testRejections() {
  const cases = [
    [undefined, 'body'],
    ['not an object', 'body'],
    [[1, 2], 'body'],
    [{model: 'A100', vram_mb: 1, timestamp: 1}, 'id'],
    [{id: '  ', model: 'A100', vram_mb: 1, timestamp: 1}, 'id'],
    [{id: 7, model: 'A100', vram_mb: 1, timestamp: 1}, 'id'],
    [{id: 'h', vram_mb: 1, timestamp: 1}, 'model'],
    [{id: 'h', model: 'A100', timestamp: 1}, 'vram_mb'],
    [{id: 'h', model: 'A100', vram_mb: 'lots', timestamp: 1}, 'vram_mb'],
    [{id: 'h', model: 'A100', vram_mb: -1, timestamp: 1}, 'vram_mb'],
    [{id: 'h', model: 'A100', vram_mb: 1}, 'timestamp'],
    [{id: 'h', model: 'A100', vram_mb: 1, timestamp: 'soon'}, 'timestamp'],
    [{id: 'h', model: 'A100', vram_mb: 1, timestamp: 1, gpu_util_pct: 'busy'}, 'gpu_util_pct'],
    [{id: 'h', model: 'A100', vram_mb: 1, timestamp: 1, gpu_util_pct: 140}, 'gpu_util_pct'],
    [{id: 'h', model: 'A100', vram_mb: 1, timestamp: 1, free_memory_mb: -5}, 'free_memory_mb']
  ];
  for (const [input, field] of cases) {
    const res = validateHost(input);
    assert(!res.ok, `expected rejection for ${JSON.stringify(input)}`);
    assert.strictEqual(res.field, field, `expected field ${field}, got ${res.field}`);
    assert(typeof res.message === 'string' && res.message.length > 0, 'rejection carries a message');
  }
}

// ---- HTTP tests -------------------------------------------------------------

async function testStringVramIsStoredAsNumberAndMatches(port) {
  const post = await request({method: 'POST', port, path: '/hosts'},
    JSON.stringify({id: 'host-str', model: 'A100', vram_mb: '40960', gpu_util_pct: '10', timestamp: '1620000000'}));
  assert.strictEqual(post.statusCode, 200, 'numeric-string report accepted');
  assert.strictEqual(JSON.parse(post.body).vram_mb, 40960, 'stored host has numeric vram_mb');

  const matched = await request({method: 'POST', port, path: '/match'},
    JSON.stringify({job: {required_min_vram_mb: 4000}}));
  const matches = JSON.parse(matched.body).matches;
  assert(matches.some(h => h.id === 'host-str'), 'coerced host is visible to /match');
}

async function testInvalidHostRejected(port) {
  const res = await request({method: 'POST', port, path: '/hosts'},
    JSON.stringify({id: 'bad', model: 'A100', vram_mb: 'lots', timestamp: 1620000000}));
  assert.strictEqual(res.statusCode, 400, 'non-numeric vram_mb is rejected');
  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.error, 'invalid_host', 'error code is invalid_host');
  assert.strictEqual(payload.field, 'vram_mb', 'offending field named');
}

async function testInvalidJsonRejected(port) {
  const res = await request({method: 'POST', port, path: '/hosts'}, '{not json');
  assert.strictEqual(res.statusCode, 400, 'malformed JSON is rejected');
  assert.strictEqual(JSON.parse(res.body).error, 'invalid_json', 'error code is invalid_json');
}

async function testQueryStringAndTrailingSlashRouting(port) {
  const listed = await request({method: 'GET', port, path: '/hosts?since=0'});
  assert.strictEqual(listed.statusCode, 200, 'GET /hosts?since=0 routes to the handler');
  assert(Array.isArray(JSON.parse(listed.body).hosts), 'hosts array returned');

  const slash = await request({method: 'GET', port, path: '/hosts/'});
  assert.strictEqual(slash.statusCode, 200, 'GET /hosts/ routes to the handler');

  const missing = await request({method: 'GET', port, path: '/nope'});
  assert.strictEqual(missing.statusCode, 404, 'unknown path still 404s');
}

async function testOversizedBodyRejected(port) {
  const big = JSON.stringify({id: 'huge', model: 'A100', vram_mb: 40960, timestamp: 1, pad: 'x'.repeat(70 * 1024)});
  const res = await request({method: 'POST', port, path: '/hosts'}, big);
  assert.strictEqual(res.statusCode, 413, 'oversized body is rejected');
  assert.strictEqual(JSON.parse(res.body).error, 'payload_too_large', 'error code is payload_too_large');

  const listed = await request({method: 'GET', port, path: '/hosts'});
  const hosts = JSON.parse(listed.body).hosts;
  assert(!hosts.some(h => h.id === 'huge'), 'oversized report was not stored');
}

async function runTests() {
  testCoercion();
  testExtraFieldsPreserved();
  testRejections();

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await testStringVramIsStoredAsNumberAndMatches(port);
  await testInvalidHostRejected(port);
  await testInvalidJsonRejected(port);
  await testQueryStringAndTrailingSlashRouting(port);
  await testOversizedBodyRejected(port);

  server.close();
  console.log('Validation tests passed');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
