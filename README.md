# gpu-grid
A marketplace for idle GPU time - host agent, scheduler, containerised job execution, live web console.

Scheduler API (added by proposal):

The scheduler provides a minimal HTTP endpoint POST /match which accepts a JSON payload:

{
  "job": {"required_min_vram_mb": 4096, "acceptable_gpu_models": ["A100"], "max_util_pct": 50},
  "hosts": [ {"id": "host-1", "model": "A100", "vram_mb": 40960, "gpu_util_pct": 10, "free_memory_mb": 20000, "timestamp": 1620000000} ]
}

Response is JSON: {"matches": [ <host objects in ranked order> ] }

Assumed host-report schema (used by scheduler matcher tests):
- id: string
- model: string (GPU model name)
- vram_mb: number (total VRAM in megabytes)
- gpu_util_pct: number (0-100)
- free_memory_mb: number
- timestamp: unix epoch seconds or ms (number)

This schema is an assumption for the minimal scheduler. If the host-agent implemented in the repository differs, the matcher will be adapted in a follow-up change.

Host liveness:

The scheduler keeps an in-memory registry of the hosts that POST /hosts. A host stays
matchable only while it keeps reporting: an entry whose last report is older than
HOST_TTL_SECONDS (default 120) is treated as dead, evicted from the registry as it is
read, and never returned by POST /match when the payload carries no explicit hosts array.

- Host agents must re-report inside HOST_TTL_SECONDS or they drop out of matching.
- Liveness is measured with the scheduler's own clock at the moment a report arrives,
  not with the host-supplied timestamp field, so host clock skew cannot hide a dead machine.
- GET /hosts lists live hosts only, plus host_ttl_seconds (the TTL in force).
- GET /hosts?include_stale=1 lists every registry entry, each with stale (boolean) and
  last_seen_ms_ago (number), for the web console.
- A POST /match payload that supplies its own hosts array is unaffected by the TTL.

Set HOST_TTL_SECONDS shorter than the reporting interval and the grid will look empty;
keep it comfortably above the agent's report period. See .env.example.
