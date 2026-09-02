const { exec } = require('child_process');

function parseCsv(output) {
  // nvidia-smi --query-gpu=index,name,memory.total,memory.free,utilization.gpu --format=csv,noheader,nounits
  // returns lines like: 0, A100, 40960, 20000, 10
  return output.trim().split('\n').map(line => {
    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 5) return null;
    const [index, name, memTotal, memFree, util] = parts;
    const parsed = {
      index: Number(index),
      name: name,
      memory_total_mb: Number(memTotal),
      memory_free_mb: Number(memFree),
      util_pct: Number(util)
    };
    if (Number.isNaN(parsed.index) || Number.isNaN(parsed.memory_total_mb) || Number.isNaN(parsed.memory_free_mb) || Number.isNaN(parsed.util_pct)) return null;
    return parsed;
  }).filter(Boolean);
}

function queryNvidia(cb) {
  exec('nvidia-smi --query-gpu=index,name,memory.total,memory.free,utilization.gpu --format=csv,noheader,nounits', { timeout: 2000 }, (err, stdout, stderr) => {
    if (err) return cb(err);
    try {
      const parsed = parseCsv(stdout);
      cb(null, parsed);
    } catch (e) {
      cb(e);
    }
  });
}

module.exports = { parseCsv, queryNvidia };
