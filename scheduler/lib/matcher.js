// Pure matching logic for gpu-grid scheduler
// match(jobSpec, hosts[]) -> array of matches sorted by preference

// Ranking is a strict, ordered comparison - NOT one additive score. The old
// score ((100 - util) * 1000 + free_memory_mb + timestamp / 1000) let an
// unbounded free_memory_mb outrank utilisation, and a host reporting an
// epoch-MILLISECOND timestamp (~1.6e9 / 1000 = ~1.6e6) swamped every other
// term - so a host could climb the ranking just by reporting a bigger number.
//
// Order of preference, each key decided before the next is looked at:
//   1. gpu_util_pct  ascending  (idler host first; missing = 0)
//   2. free_memory_mb descending (more headroom first; missing = 0)
//   3. timestamp     descending (fresher report first; missing = 0)
//   4. id            ascending  (deterministic order on a full tie)
//
// timestamp is only ever a tie-breaker, so mixed second/millisecond units can
// no longer decide a match on their own. Deliberately no unit normalisation
// here: that was considered and rejected (proposals #22/#23).
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function compareHosts(a, b) {
  const utilDiff = num(a.gpu_util_pct) - num(b.gpu_util_pct);
  if (utilDiff !== 0) return utilDiff;

  const memDiff = num(b.free_memory_mb) - num(a.free_memory_mb);
  if (memDiff !== 0) return memDiff;

  const tsDiff = num(b.timestamp) - num(a.timestamp);
  if (tsDiff !== 0) return tsDiff;

  const aId = typeof a.id === 'string' ? a.id : String(a.id === undefined ? '' : a.id);
  const bId = typeof b.id === 'string' ? b.id : String(b.id === undefined ? '' : b.id);
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

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

  // Rank candidates: lower util, then larger free_memory_mb, then newer
  // timestamp, then id. slice() so the caller's array is never re-ordered.
  return candidates.slice().sort(compareHosts);
}

module.exports = { match, compareHosts };
