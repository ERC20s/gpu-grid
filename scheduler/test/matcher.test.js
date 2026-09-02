// Minimal test runner for matcher.test.js
const assert = require('assert');
const { match } = require('../lib/matcher');

function runTests() {
  testMatchBasic();
  testRejectLowVram();
  testAcceptModelFilter();
  testRejectBusyHostWithEnoughTotalVram();
  testAcceptHostWithEnoughFreeMemory();
  testRejectHostMissingFreeMemoryWhenJobAsks();
  testFreeMemoryIgnoredWhenJobDoesNotAsk();
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

// --- free-GPU-memory constraint (required_free_memory_mb) ---

// A 40 GB A100 that is already nearly full must not be offered for a job that
// declares how much free memory it actually needs.
function testRejectBusyHostWithEnoughTotalVram() {
  const job = { required_min_vram_mb: 4000, required_free_memory_mb: 4000 };
  const hosts = [
    {id: 'busy-a100', model: 'A100', vram_mb: 40960, gpu_util_pct: 95, free_memory_mb: 1024, timestamp: 1000}
  ];
  const result = match(job, hosts);
  assert(result.length === 0, 'busy host with big total VRAM but little free memory should be rejected');
}

function testAcceptHostWithEnoughFreeMemory() {
  const job = { required_min_vram_mb: 4000, required_free_memory_mb: 4000 };
  const hosts = [
    {id: 'busy-a100', model: 'A100', vram_mb: 40960, gpu_util_pct: 95, free_memory_mb: 1024, timestamp: 1000},
    {id: 'idle-a100', model: 'A100', vram_mb: 40960, gpu_util_pct: 5, free_memory_mb: 38000, timestamp: 2000}
  ];
  const result = match(job, hosts);
  assert(result.length === 1, 'only the host with enough free memory should match');
  assert(result[0].id === 'idle-a100', 'idle host is chosen');
}

// A host agent that never reports free_memory_mb cannot prove it has room, so
// it is not offered when the job asks for free memory.
function testRejectHostMissingFreeMemoryWhenJobAsks() {
  const job = { required_min_vram_mb: 2000, required_free_memory_mb: 2000 };
  const hosts = [
    {id: 'silent', model: 'RTX2080', vram_mb: 8192, gpu_util_pct: 0, timestamp: 1000},
    {id: 'nan', model: 'RTX2080', vram_mb: 8192, gpu_util_pct: 0, free_memory_mb: 'lots', timestamp: 1000}
  ];
  const result = match(job, hosts);
  assert(result.length === 0, 'hosts without a numeric free_memory_mb should be rejected when the job asks');
}

// Without the field, behaviour is unchanged: free memory stays a tie-break only.
function testFreeMemoryIgnoredWhenJobDoesNotAsk() {
  const job = { required_min_vram_mb: 4000 };
  const hosts = [
    {id: 'busy-a100', model: 'A100', vram_mb: 40960, gpu_util_pct: 95, free_memory_mb: 1024, timestamp: 1000},
    {id: 'silent', model: 'RTX2080', vram_mb: 8192, gpu_util_pct: 0, timestamp: 1000}
  ];
  const result = match(job, hosts);
  assert(result.length === 2, 'with no required_free_memory_mb both hosts still match');
  assert(result[0].id === 'silent', 'ranking is unchanged: lower utilisation still wins');
}

if (require.main === module) runTests();
