// Free GPU memory is a hard scheduling constraint: a job is never matched to
// a host that does not have the memory it needs free, however good that host
// looks otherwise.
const http = require('http');
const assert = require('assert');
const server = require('../index');
const { match } = require('../lib/matcher');
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

async function matchIds(port, payload) {
  const res = await request({method: 'POST', port, path: '/match'}, JSON.stringify(payload));
  assert.strictEqual(res.statusCode, 200, res.body);
  return JSON.parse(res.body).matches.map(h => h.id);
}

// Big cards, mostly in use: plenty of total VRAM, little of it free. The
// idlest host has the least free memory, so ranking alone would pick it.
const REGISTRY = [
  {id: 'h100-busy', model: 'H100', vram_mb: 81920, gpu_util_pct: 1, free_memory_mb: 8000, timestamp: 1620000000},
  {id: 'a100-half', model: 'A100', vram_mb: 81920, gpu_util_pct: 30, free_memory_mb: 30000, timestamp: 1620000000},
  {id: 'a100-silent', model: 'A100', vram_mb: 81920, gpu_util_pct: 0, timestamp: 1620000000}
];
const MOST_FREE = 30000;

async function testJobNeedingMoreThanAnyHostHasIsNeverScheduled(port) {
  // Every card is big enough in total; none has this much free.
  const job = {required_min_vram_mb: 40960, required_min_free_memory_mb: MOST_FREE + 1};
  assert.deepStrictEqual(await matchIds(port, {job}), [], 'no host has the memory free, so nothing is matched');

  // More than any card has at all.
  const huge = {required_min_free_memory_mb: 81921};
  assert.deepStrictEqual(await matchIds(port, {job: huge}), [], 'a need larger than every card matches nothing');

  // Control: the same registry does match once a host has the memory free,
  // so the empty answers above come from the memory constraint.
  const fits = {required_min_vram_mb: 40960, required_min_free_memory_mb: MOST_FREE};
  assert.deepStrictEqual(await matchIds(port, {job: fits}), ['a100-half'],
    'only the host with enough free memory, even though h100-busy is idler');
}

async function testExplicitHostsAreHeldToTheSameConstraint(port) {
  const job = {required_min_free_memory_mb: MOST_FREE + 1};
  assert.deepStrictEqual(await matchIds(port, {job, hosts: REGISTRY}), [], 'an explicit hosts array gets no exemption');
}

async function testInflatedFreeMemoryCannotBeReported(port) {
  // The constraint cannot be dodged by claiming more free memory than the card has.
  const liar = {id: 'liar', model: 'RTX4090', vram_mb: 24576, gpu_util_pct: 0, free_memory_mb: 99999, timestamp: 1620000000};
  const res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(liar));
  assert.strictEqual(res.statusCode, 400, 'free_memory_mb above vram_mb is rejected');
  assert.deepStrictEqual(await matchIds(port, {job: {required_min_free_memory_mb: 50000}}), [], 'and the liar is never matched');
}

// Every match() answer, over many needs, holds only hosts with the need free.
function testMatcherNeverReturnsAHostWithoutTheMemory() {
  const hosts = [];
  for (let i = 0; i < 40; i++) {
    const h = {id: `h${i}`, model: 'A100', vram_mb: 81920, gpu_util_pct: i % 100, timestamp: 1};
    if (i % 5 !== 0) h.free_memory_mb = i * 2000;  // every 5th host stays silent
    hosts.push(h);
  }
  for (let need = 0; need <= 90000; need += 1500) {
    const got = match({required_min_free_memory_mb: need}, hosts);
    const expected = hosts.filter(h => typeof h.free_memory_mb === 'number' && h.free_memory_mb >= need).length;
    assert.strictEqual(got.length, expected, `need ${need}: every host with the memory free is matched`);
    for (const h of got) {
      assert(typeof h.free_memory_mb === 'number' && h.free_memory_mb >= need,
        `need ${need}: ${h.id} with free_memory_mb ${h.free_memory_mb} must not match`);
    }
  }
}

async function runTests() {
  testMatcherNeverReturnsAHostWithoutTheMemory();

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const seeded = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(REGISTRY));
  assert.strictEqual(seeded.statusCode, 200, seeded.body);

  await testJobNeedingMoreThanAnyHostHasIsNeverScheduled(port);
  await testExplicitHostsAreHeldToTheSameConstraint(port);
  await testInflatedFreeMemoryCannotBeReported(port);

  server.close();
  console.log('Free memory constraint tests passed');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
