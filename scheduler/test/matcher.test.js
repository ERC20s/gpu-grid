// Minimal test runner for matcher.test.js
const assert = require('assert');
const { match } = require('../lib/matcher');

function runTests() {
  testMatchBasic();
  testRejectLowVram();
  testAcceptModelFilter();
  testTimestampNormalization();
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

function testTimestampNormalization() {
  // Two hosts identical except that one reports timestamp in seconds and the other in milliseconds.
  // They should rank the same relative to each other: the host with the newer time must be preferred.
  const job = { required_min_vram_mb: 1000 };
  const base = { model: 'A100', vram_mb: 16384, gpu_util_pct: 10, free_memory_mb: 5000 };

  const hostSecNewer = Object.assign({id: 'sec_newer'}, base, {timestamp: 1620000001});
  const hostMsOlder = Object.assign({id: 'ms_older'}, base, {timestamp: 1620000000000});
  // hostSecNewer timestamp 1620000001s == 1620000001000ms, so hostSecNewer is newer than hostMsOlder (ms older = 1620000000000ms)

  const result = match(job, [hostSecNewer, hostMsOlder]);
  assert(result.length === 2, 'should match both hosts');
  // newer timestamp should come first
  assert(result[0].id === 'sec_newer', 'host with newer timestamp should rank higher');

  // Now the inverse: milliseconds representation of newer host
  const hostSecOlder = Object.assign({id: 'sec_older'}, base, {timestamp: 1620000000});
  const hostMsNewer = Object.assign({id: 'ms_newer'}, base, {timestamp: 1620000001000});
  const result2 = match(job, [hostSecOlder, hostMsNewer]);
  assert(result2.length === 2, 'should match both hosts');
  assert(result2[0].id === 'ms_newer', 'host with newer ms timestamp should rank higher');
}

if (require.main === module) runTests();