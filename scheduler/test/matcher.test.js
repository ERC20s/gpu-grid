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
  testUnreportedUtilRanksLast();
  testUnreportedFreeMemoryRanksLastWithinUtilTie();
  testUnreportedHostsStillOrderedAmongThemselves();
  testMaxUtilPctDropsUnreportedHost();
  testNoMaxUtilPctStillKeepsUnreportedHost();
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

// --- unknown utilisation is not zero -----------------------------------------

// A host that simply omits gpu_util_pct used to be scored as 0% utilised and
// won every ranking - the cheapest exploit on a marketplace that sells idle
// GPU time. An unreported value now sorts behind every host that did report,
// however busy that host is.
function testUnreportedUtilRanksLast() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'silent', model: 'A100', vram_mb: 40960},
    {id: 'busy', model: 'A100', vram_mb: 40960, gpu_util_pct: 95, free_memory_mb: 1000, timestamp: 2000},
    {id: 'idle', model: 'A100', vram_mb: 40960, gpu_util_pct: 5, free_memory_mb: 30000, timestamp: 2000}
  ];
  const ids = match(job, hosts).map(h => h.id);
  assert.deepStrictEqual(ids, ['idle', 'busy', 'silent'], 'a host that reports nothing ranks behind one that reports 95%');

  // The comparator says the same thing on its own.
  const reported = {id: 'r', gpu_util_pct: 99};
  const unreported = {id: 'u'};
  assert(compareHosts(reported, unreported) < 0, 'reported utilisation sorts ahead of unreported');
  assert(compareHosts(unreported, reported) > 0, 'comparator stays antisymmetric');
}

function testUnreportedFreeMemoryRanksLastWithinUtilTie() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'no-mem', model: 'A100', vram_mb: 40960, gpu_util_pct: 10, timestamp: 2000},
    {id: 'tiny-mem', model: 'A100', vram_mb: 40960, gpu_util_pct: 10, free_memory_mb: 1, timestamp: 2000}
  ];
  const ids = match(job, hosts).map(h => h.id);
  assert.deepStrictEqual(ids, ['tiny-mem', 'no-mem'], 'inside a utilisation tie, 1MB reported beats free_memory_mb unreported');
}

// Among hosts that all stay silent the existing order still decides, so the
// ranking never becomes arbitrary.
function testUnreportedHostsStillOrderedAmongThemselves() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'z-old', model: 'A100', vram_mb: 40960, timestamp: 1000},
    {id: 'a-new', model: 'A100', vram_mb: 40960, timestamp: 2000},
    {id: 'b-new', model: 'A100', vram_mb: 40960, timestamp: 2000}
  ];
  const ids = match(job, hosts).map(h => h.id);
  assert.deepStrictEqual(ids, ['a-new', 'b-new', 'z-old'], 'silent hosts fall back to timestamp then id');
}

// The mirror-image hole in the filter: the old `typeof === "number" && >` test
// never looked at a host without the field, so a silent host passed even
// max_util_pct: 0.
function testMaxUtilPctDropsUnreportedHost() {
  const hosts = [
    {id: 'silent', model: 'A100', vram_mb: 40960},
    {id: 'idle', model: 'A100', vram_mb: 40960, gpu_util_pct: 4, free_memory_mb: 30000, timestamp: 2000},
    {id: 'busy', model: 'A100', vram_mb: 40960, gpu_util_pct: 80, free_memory_mb: 1000, timestamp: 2000}
  ];
  const strict = match({required_min_vram_mb: 4000, max_util_pct: 0}, hosts);
  assert(strict.length === 0, 'max_util_pct: 0 matches nobody - a silent host cannot claim to be idle');

  const capped = match({required_min_vram_mb: 4000, max_util_pct: 10}, hosts).map(h => h.id);
  assert.deepStrictEqual(capped, ['idle'], 'only a host that reported low load clears the cap');
}

function testNoMaxUtilPctStillKeepsUnreportedHost() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'silent', model: 'A100', vram_mb: 40960},
    {id: 'idle', model: 'A100', vram_mb: 40960, gpu_util_pct: 4, free_memory_mb: 30000, timestamp: 2000}
  ];
  const ids = match(job, hosts).map(h => h.id);
  assert.deepStrictEqual(ids, ['idle', 'silent'], 'without a cap a silent host is still matchable, just ranked last');
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
