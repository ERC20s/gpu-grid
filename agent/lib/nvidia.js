function parseNvidiaCsv(text) {
  if (!text) return [];
  // Each line is: name, memory.total [MiB], memory.free [MiB], utilization.gpu [%]
  // Be permissive: trim, skip empty lines, allow missing columns.
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    // split on comma, but allow commas in names by limiting to 4 fields
    const parts = line.split(',').map(p => p.trim());
    // If there are more than 4, assume name had commas: name = all but last 3
    let name, total, free, util;
    if (parts.length >= 4) {
      name = parts.slice(0, parts.length - 3).join(',');
      total = Number(parts[parts.length - 3]);
      free = Number(parts[parts.length - 2]);
      util = Number(parts[parts.length - 1]);
    } else {
      name = parts[0] || '';
      total = Number(parts[1]);
      free = Number(parts[2]);
      util = Number(parts[3]);
    }
    const row = {
      model: name || undefined,
      vram_mb: Number.isFinite(total) ? total : undefined,
      free_memory_mb: Number.isFinite(free) ? free : undefined,
      gpu_util_pct: Number.isFinite(util) ? util : undefined,
      timestamp: Math.floor(Date.now())
    };
    rows.push(row);
  }
  return rows;
}

module.exports = { parseNvidiaCsv };
