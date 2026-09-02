// Minimal test runner for matcher.test.js
const assert = require('assert');
const { match, compareHosts } = require('../lib/matcher');

function runTests() {
  testMatchBasic();
  testRejectLowVram();
  testAcceptModelFilter();
  testLowUtilBeatsLargeFreeMemory();
  testEqualUtilRanksByFreeMemory();
  testEqualUtilAndMemoryRanksByTimestamp();
  testFullTieOrdersById();
  testMillisecondTimestampDoesNotOutrankLowerUtil();
  testMissingFieldsTreatedAsZero();
  testInputArrayNotMutated();
  testCompareHostsExported();
  console.log('All tests passed');
}

function testMatchBasic() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'a', model: 'RTX2080', vram_mb: 8192, gpu_util_pct: 10, free_memory_mb: 4000, timestamp: 1000},
    {id: 'b', model: 'GTX1080', vram_mb: 4096, gpu_util_pct: 5, free_memory_mb: 2000, timestamp: 2000}
  ];
  const result = match(job, hosts);
  assert(Array.isArray(result), 'result should be array');
  assert(result.length === 2, 'should match both hosts');
  assert(result[0].id === 'a' || result[0].id === 'b', 'first host present');
}

function testRejectLowVram() {
  const job = { required_min_vram_mb: 6000 };
  const hosts = [
    {id: 'a', model: 'RTX2080', vram_mb: 4096, gpu_util_pct: 0, free_memory_mb: 1000, timestamp: 1000}
  ];
  const result = match(job, hosts);
  assert(result.length === 0, 'should reject low vram host');
}

function testAcceptModelFilter() {
  const job = { required_min_vram_mb: 2000, acceptable_gpu_models: ['A100'] };
  const hosts = [
    {id: 'a', model: 'RTX2080', vram_mb: 8192, gpu_util_pct: 0, free_memory_mb: 3000, timestamp: 1000},
    {id: 'b', model: 'A100', vram_mb: 40960, gpu_util_pct: 50, free_memory_mb: 20000, timestamp: 2000}
  ];
  const result = match(job, hosts);
  assert(result.length === 1, 'should only accept A100');
  assert(result[0].id === 'b', 'A100 is chosen');
}

// --- ranking: ordered comparison, not one additive score ---------------------

// Utilisation is decided first, so a big free_memory_mb can no longer buy a
// busy host the top slot. Under the old additive score 'busy' won (130000 vs
// 97000); under the ordered comparison 'quiet' wins.
function testLowUtilBeatsLargeFreeMemory() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'busy', model: 'A100', vram_mb: 81920, gpu_util_pct: 50, free_memory_mb: 80000, timestamp: 1000},
    {id: 'quiet', model: 'RTX2080', vram_mb: 8192, gpu_util_pct: 5, free_memory_mb: 2000, timestamp: 1000}
  ];
  const result = match(job, hosts);
  assert(result.length === 2, 'both hosts match');
  assert(result[0].id === 'quiet', 'lower utilisation ranks first, whatever the free memory');
  assert(result[1].id === 'busy', 'busier host ranks second');
}

function testEqualUtilRanksByFreeMemory() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'small', model: 'A100', vram_mb: 40960, gpu_util_pct: 10, free_memory_mb: 5000, timestamp: 1000},
    {id: 'large', model: 'A100', vram_mb: 40960, gpu_util_pct: 10, free_memory_mb: 30000, timestamp: 1000}
  ];
  const result = match(job, hosts);
  assert(result[0].id === 'large', 'on equal utilisation, more free memory ranks first');
  assert(result[1].id === 'small', 'less free memory ranks second');
}

function testEqualUtilAndMemoryRanksByTimestamp() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'old', model: 'A100', vram_mb: 40960, gpu_util_pct: 10, free_memory_mb: 20000, timestamp: 1000},
    {id: 'new', model: 'A100', vram_mb: 40960, gpu_util_pct: 10, free_memory_mb: 20000, timestamp: 2000}
  ];
  const result = match(job, hosts);
  assert(result[0].id === 'new', 'fresher report breaks a utilisation/memory tie');
  assert(result[1].id === 'old', 'older report ranks second');
}

function testFullTieOrdersById() {
  const job = { required_min_vram_mb: 4000 };
  const base = {model: 'A100', vram_mb: 40960, gpu_util_pct: 10, free_memory_mb: 20000, timestamp: 1000};
  const hosts = [
    Object.assign({id: 'zeta'}, base),
    Object.assign({id: 'alpha'}, base),
    Object.assign({id: 'mid'}, base)
  ];
  const ids = match(job, hosts).map(h => h.id);
  assert.deepStrictEqual(ids, ['alpha', 'mid', 'zeta'], 'a full tie is ordered by id, deterministically');
}

// A host that reports epoch MILLISECONDS used to add ~1.6e6 to its score and
// win outright. timestamp is now a tie-breaker only.
function testMillisecondTimestampDoesNotOutrankLowerUtil() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'ms', model: 'A100', vram_mb: 40960, gpu_util_pct: 90, free_memory_mb: 1000, timestamp: 1723456789000},
    {id: 'sec', model: 'A100', vram_mb: 40960, gpu_util_pct: 5, free_memory_mb: 20000, timestamp: 1723456789}
  ];
  const result = match(job, hosts);
  assert(result[0].id === 'sec', 'a millisecond timestamp cannot outrank a quieter host');
  assert(result[1].id === 'ms', 'the busy host reporting a huge timestamp ranks last');
}

function testMissingFieldsTreatedAsZero() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'reported', model: 'A100', vram_mb: 40960, gpu_util_pct: 20, free_memory_mb: 30000, timestamp: 2000},
    {id: 'silent', model: 'A100', vram_mb: 40960}
  ];
  const result = match(job, hosts);
  assert(result[0].id === 'silent', 'missing gpu_util_pct counts as 0, as it did before');
  assert(result[1].id === 'reported', 'the reporting host ranks second');
}

function testInputArrayNotMutated() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'busy', model: 'A100', vram_mb: 40960, gpu_util_pct: 80, free_memory_mb: 1000, timestamp: 1000},
    {id: 'quiet', model: 'A100', vram_mb: 40960, gpu_util_pct: 1, free_memory_mb: 1000, timestamp: 1000}
  ];
  const before = hosts.map(h => h.id);
  match(job, hosts);
  assert.deepStrictEqual(hosts.map(h => h.id), before, 'match() must not re-order the caller array');
}

function testCompareHostsExported() {
  assert(typeof compareHosts === 'function', 'compareHosts is exported for reuse and tests');
  const a = {id: 'a', gpu_util_pct: 10, free_memory_mb: 100, timestamp: 1};
  const b = {id: 'b', gpu_util_pct: 20, free_memory_mb: 900, timestamp: 9};
  assert(compareHosts(a, b) < 0, 'lower utilisation sorts first');
  assert(compareHosts(b, a) > 0, 'comparator is antisymmetric');
  assert(compareHosts(a, a) === 0, 'a host ties with itself');
}

if (require.main === module) runTests();
