const assert = require('assert');
const { parseNvidiaCsv } = require('../lib/nvidia');
const { buildHostReport, deriveId } = require('../index');

function run() {
  // fixture: two GPUs with the same model
  const csv = 'A100, 40960, 20000, 10\nA100, 40960, 20000, 20\n';
  const rows = parseNvidiaCsv(csv);
  assert(Array.isArray(rows) && rows.length === 2, 'parsed two rows');
  const host = buildHostReport(rows);
  assert(host.id, 'has id');
  assert(host.model.includes('A100'), 'model present');
  assert(host.vram_mb === 81920, 'vram summed');
  assert(host.free_memory_mb === 40000, 'free mem summed');
  assert(host.gpu_util_pct === 15, 'avg util');

  // malformed lines are skipped but do not crash
  const csv2 = 'BadLine\nA100, 40960, , 50\n';
  const rows2 = parseNvidiaCsv(csv2);
  const host2 = buildHostReport(rows2);
  assert(host2.vram_mb === 40960, 'handles missing free');

  // deriveId uses HOST_ID when set
  process.env.HOST_ID = 'explicit-host';
  assert(deriveId() === 'explicit-host', 'uses HOST_ID');
  delete process.env.HOST_ID;
  console.log('OK');
}

if (require.main === module) run();
