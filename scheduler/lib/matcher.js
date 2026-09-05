// Pure matching logic for gpu-grid scheduler
// match(jobSpec, hosts[]) -> array of matches sorted by preference

// Ranking is a strict, ordered comparison - NOT one additive score. The old
// score ((100 - util) * 1000 + free_memory_mb + timestamp / 1000) let an
// unbounded free_memory_mb outrank utilisation, and a host reporting an
// epoch-MILLISECOND timestamp (~1.6e9 / 1000 = ~1.6e6) swamped every other
// term - so a host could climb the ranking just by reporting a bigger number.
//
// Order of preference, each key decided before the next is looked at:
//   1. gpu_util_pct  ascending  (idler host first; UNREPORTED ranks after every
//      host that did report, however busy that host is)
//   2. free_memory_mb descending (more headroom first; unreported ranks after
//      every host that did report)
//   3. timestamp     descending (fresher report first; missing = 0)
//   4. id            ascending  (deterministic order on a full tie)
//
// Unknown is NOT zero. A missing gpu_util_pct used to score as 0% utilised, so
// the cheapest way for a host to win every match on a marketplace that sells
// idle GPU time was to stop reporting utilisation altogether. A host that does
// not report cannot prove it is idle, so it sorts behind the ones that do.
//
// timestamp is only ever a tie-breaker, so mixed second/millisecond units can
// no longer decide a match on their own. Deliberately no unit normalisation
// here: that was considered and rejected (proposals #22/#23).
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// A value only counts when it was actually reported as a finite number.
function isReported(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Compare one reported-or-not key. Returns a number when the key decides the
// order (including "reported beats unreported"), or 0 when it ties.
function compareReported(aValue, bValue, direction) {
  const aOk = isReported(aValue);
  const bOk = isReported(bValue);
  if (aOk && bOk) return direction === 'asc' ? aValue - bValue : bValue - aValue;
  if (aOk) return -1;   // a reported, b did not: a first
  if (bOk) return 1;    // b reported, a did not: b first
  return 0;             // neither reported: undecided, fall through
}

function compareHosts(a, b) {
  const utilDiff = compareReported(a.gpu_util_pct, b.gpu_util_pct, 'asc');
  if (utilDiff !== 0) return utilDiff;

  const memDiff = compareReported(a.free_memory_mb, b.free_memory_mb, 'desc');
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
  // A utilisation cap is only applied when the job actually carries one. When
  // it does, a host with no reported gpu_util_pct is EXCLUDED: it cannot prove
  // it is under the cap, and the old test (`typeof === 'number' && ...`) simply
  // never looked at it, so a silent host passed max_util_pct: 0.
  const hasMaxUtil = isReported(job.max_util_pct);

  // A free-memory floor filter: when the job explicitly requests a minimum
  // free GPU memory, a host that did not report free_memory_mb is excluded
  // (unknown is not acceptable), and hosts with too little free memory fail.
  const hasMinFree = isReported(job.required_min_free_memory_mb);

  const candidates = hosts.filter(h => {
    if (typeof h.vram_mb !== 'number') return false;
    if (h.vram_mb < requiredVram) return false;
    if (acceptableModels && acceptableModels.length > 0 && !acceptableModels.includes(h.model)) return false;
    if (hasMaxUtil) {
      if (!isReported(h.gpu_util_pct)) return false;
      if (h.gpu_util_pct > job.max_util_pct) return false;
    }
    if (hasMinFree) {
      if (!isReported(h.free_memory_mb)) return false;
      if (h.free_memory_mb < job.required_min_free_memory_mb) return false;
    }
    return true;
  });

  // Rank candidates: lower util, then larger free_memory_mb, then newer
  // timestamp, then id. slice() so the caller's array is never re-ordered.
  return candidates.slice().sort(compareHosts);
}

module.exports = { match, compareHosts };
