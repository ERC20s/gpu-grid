const { execFile } = require('child_process');

// Parse CSV output from nvidia-smi --query-gpu=index,name,memory.total,memory.free,utilization.gpu --format=csv,noheader,nounits
function parseNvidiaCsv(csv, hostname = require('os').hostname()) {
  if (!csv || typeof csv !== 'string') return [];
  return csv.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    // split on comma, but names may contain commas rarely; assume simple split
    const cols = line.split(',').map(s => s.trim());
    // expected: index, name, memory.total, memory.free, utilization.gpu
    if (cols.length < 5) return null;
    const [indexRaw, name, totalRaw, freeRaw, utilRaw] = cols;
    const index = indexRaw;
    const vram_mb = Number(totalRaw) || 0;
    const free_memory_mb = Number(freeRaw) || 0;
    const gpu_util_pct = Number(utilRaw) || 0;
    const id = `${hostname}-gpu${index}`;
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      id,
      model: name,
      vram_mb,
      gpu_util_pct,
      free_memory_mb,
      timestamp
    };
  }).filter(Boolean);
}

function runNvidiaSmi() {
  return new Promise((resolve) => {
    const args = ['--query-gpu=index,name,memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits'];
    execFile('nvidia-smi', args, {timeout: 5000}, (err, stdout, stderr) => {
      if (err) {
        // Could not run nvidia-smi; return empty array rather than reject
        return resolve([]);
      }
      try {
        const parsed = parseNvidiaCsv(stdout);
        resolve(parsed);
      } catch (e) {
        resolve([]);
      }
    });
  });
}

module.exports = {
  parseNvidiaCsv,
  runNvidiaSmi
};
