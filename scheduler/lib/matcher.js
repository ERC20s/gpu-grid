// Pure matching logic for gpu-grid scheduler
// match(jobSpec, hosts[]) -> array of matches sorted by preference

function match(job, hosts) {
  if (!job || !hosts || !Array.isArray(hosts)) return [];

  const requiredVram = job.required_min_vram_mb || 0;
  const acceptableModels = Array.isArray(job.acceptable_gpu_models) ? job.acceptable_gpu_models : null;
  const maxUtilPct = typeof job.max_util_pct === 'number' ? job.max_util_pct : 100;

  // Optional hard constraint on CURRENTLY FREE GPU memory. Total vram_mb says
  // how big the card is; free_memory_mb says how much of it a job can still
  // have. When a job declares required_free_memory_mb we drop any host that
  // cannot prove it has that much free right now. When the field is absent
  // (or not a finite number) matching behaves exactly as it did before.
  const requiredFreeMem =
    typeof job.required_free_memory_mb === 'number' && isFinite(job.required_free_memory_mb)
      ? job.required_free_memory_mb
      : null;

  const candidates = hosts.filter(h => {
    if (typeof h.vram_mb !== 'number') return false;
    if (h.vram_mb < requiredVram) return false;
    if (requiredFreeMem !== null) {
      // An unproven host is not offered: a missing or non-numeric
      // free_memory_mb fails the constraint rather than defaulting to 0-or-ok.
      if (typeof h.free_memory_mb !== 'number' || !isFinite(h.free_memory_mb)) return false;
      if (h.free_memory_mb < requiredFreeMem) return false;
    }
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
