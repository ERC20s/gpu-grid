// Request-body schema limits: ranges and maximum sizes on POST /hosts and
// POST /match, and that stored host reports keep only schema fields.
const http = require('http');
const assert = require('assert');
const server = require('../index');
const { withAuth } = require('./support/auth');
const { MAX_MEMORY_MB, MAX_TIMESTAMP, MAX_HOSTS_PER_REQUEST, MAX_ACCEPTABLE_MODELS } = require('../lib/schema');

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

function host(overrides) {
  return Object.assign({id: 'h', model: 'A100', vram_mb: 40960, gpu_util_pct: 5, free_memory_mb: 20000, timestamp: 1620000000}, overrides);
}

async function expectStatus(port, path, body, status, error, what) {
  const res = await request({method: 'POST', port, path}, JSON.stringify(body));
  assert.strictEqual(res.statusCode, status, `${what}: expected ${status}, got ${res.statusCode} ${res.body}`);
  if (error) assert.strictEqual(JSON.parse(res.body).error, error, what);
  return res;
}

async function testHostRanges(port) {
  const bad = [
    [{free_memory_mb: 40961}, 'free_memory_mb above vram_mb'],
    [{vram_mb: MAX_MEMORY_MB + 1, free_memory_mb: 0}, 'vram_mb above the cap'],
    [{free_memory_mb: -1}, 'negative free_memory_mb'],
    [{timestamp: -1}, 'negative timestamp'],
    [{timestamp: MAX_TIMESTAMP + 1}, 'timestamp above the cap'],
    [{gpu_util_pct: 100.5}, 'gpu_util_pct above 100'],
    [{model: 'x'.repeat(129)}, 'model longer than 128'],
    [{model: ''}, 'empty model'],
    [{id: 'x'.repeat(257)}, 'id longer than 256'],
    [{vram_mb: '40960'}, 'vram_mb as a string']
  ];
  for (const [overrides, what] of bad) {
    await expectStatus(port, '/hosts', host(overrides), 400, 'invalid_host', what);
  }
  const ids = JSON.parse((await request({method: 'GET', port, path: '/hosts'})).body).hosts.map(h => h.id);
  assert.deepStrictEqual(ids, [], 'no rejected report was stored');

  // The boundaries themselves are accepted.
  await expectStatus(port, '/hosts', host({id: 'full', free_memory_mb: 40960}), 200, null, 'free_memory_mb equal to vram_mb');
  await expectStatus(port, '/hosts', host({id: 'big', vram_mb: MAX_MEMORY_MB, free_memory_mb: 0}), 200, null, 'vram_mb at the cap');
  await expectStatus(port, '/hosts', host({id: 'ms', timestamp: MAX_TIMESTAMP}), 200, null, 'timestamp at the cap');
}

async function testBatchSizeCap(port) {
  const batch = [];
  for (let i = 0; i <= MAX_HOSTS_PER_REQUEST; i++) batch.push({id: `b${i}`, model: 'A', vram_mb: 1, timestamp: 1});
  const res = await expectStatus(port, '/hosts', batch, 400, 'invalid_host', `a batch of ${batch.length}`);
  assert(JSON.parse(res.body).message.indexOf(String(MAX_HOSTS_PER_REQUEST)) !== -1, 'the message names the cap');
  await expectStatus(port, '/hosts', batch.slice(0, MAX_HOSTS_PER_REQUEST), 200, null, `a batch of ${MAX_HOSTS_PER_REQUEST}`);
}

async function testStoredReportKeepsOnlySchemaFields(port) {
  await expectStatus(port, '/hosts', host({id: 'extra', note: 'x'.repeat(1000), nested: {a: 1}}), 200, null, 'a report with extra fields');
  const stored = JSON.parse((await request({method: 'GET', port, path: '/hosts/extra'})).body);
  assert.strictEqual(stored.note, undefined, 'unknown field note was not stored');
  assert.strictEqual(stored.nested, undefined, 'unknown field nested was not stored');
  assert.strictEqual(stored.free_memory_mb, 20000, 'schema fields are kept');
}

async function testJobLimits(port) {
  const tooMany = [];
  for (let i = 0; i <= MAX_ACCEPTABLE_MODELS; i++) tooMany.push(`M${i}`);
  const bad = [
    [{job: {acceptable_gpu_models: tooMany}}, `${tooMany.length} acceptable models`],
    [{job: {acceptable_gpu_models: ['x'.repeat(129)]}}, 'a model name longer than 128'],
    [{job: {required_min_vram_mb: MAX_MEMORY_MB + 1}}, 'required_min_vram_mb above the cap'],
    [{job: {required_min_free_memory_mb: MAX_MEMORY_MB + 1}}, 'required_min_free_memory_mb above the cap'],
    [{job: {}, hosts: [host({free_memory_mb: 50000})]}, 'an explicit host with free_memory_mb above vram_mb']
  ];
  for (const [body, what] of bad) {
    await expectStatus(port, '/match', body, 400, 'invalid_job', what);
  }

  const hosts = [];
  for (let i = 0; i <= MAX_HOSTS_PER_REQUEST; i++) hosts.push({id: `m${i}`, model: 'A', vram_mb: 1, timestamp: 1});
  await expectStatus(port, '/match', {job: {}, hosts}, 400, 'invalid_job', `${hosts.length} explicit hosts`);
  await expectStatus(port, '/match', {job: {}, hosts: hosts.slice(0, MAX_HOSTS_PER_REQUEST)}, 200, null, `${MAX_HOSTS_PER_REQUEST} explicit hosts`);
}

async function runTests() {
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await testHostRanges(port);
  await testBatchSizeCap(port);
  await testStoredReportKeepsOnlySchemaFields(port);
  await testJobLimits(port);

  server.close();
  console.log('Schema tests passed');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
