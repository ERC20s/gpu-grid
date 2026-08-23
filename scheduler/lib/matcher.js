// Pure matching logic for gpu-grid scheduler
// match(jobSpec, hosts[]) -> array of matches sorted by preference

function match(job, hosts) {
  if (!job || !hosts || !Array.isArray(hosts)) return [];

  const requiredVram = job.required_min_vram_mb || 0;
  const acceptableModels = Array.isArray(job.acceptable_gpu_models) ? job.acceptable_gpu_models : null;
  const maxUtilPct = typeof job.max_util_pct === 'number' ? job.max_util_pct : 100;

  const candidates = hosts.filter(h => {
    if (typeof h.vram_mb !== 'number') return false;
    if (h.vram_mb < requiredVram) return false;
    if (acceptableModels && acceptableModels.length > 0 && !acceptableModels.includes(h.model)) return false;
    if (typeof h.gpu_util_pct === 'number' && h.gpu_util_pct > maxUtilPct) return false;
    return true;
  });

  // Score candidates: prefer lower util, then larger free_memory_mb, then newer timestamp
  const scored = candidates.map(h => {
    const util = typeof h.gpu_util_pct === 'number' ? h.gpu_util_pct : 0;
    const freeMem = typeof h.free_memory_mb === 'number' ? h.free_memory_mb : 0;
    const ts = typeof h.timestamp === 'number' ? h.timestamp : 0;
    const score = (100 - util) * 1000 + freeMem + ts / 1000;
    return {host: h, score};
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.map(s => s.host);
}

module.exports = { match };
