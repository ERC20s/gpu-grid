// Minimal test runner for matcher.test.js
const assert = require('assert');
const { match } = require('../lib/matcher');

function runTests() {
  testMatchBasic();
  testRejectLowVram();
  testAcceptModelFilter();
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

if (require.main === module) runTests();
