# gpu-grid
A marketplace for idle GPU time - host agent, scheduler, containerised job execution, live web console.

Scheduler API (added by proposal):

The scheduler provides a minimal HTTP endpoint POST /match which accepts a JSON payload:

{
  "job": {"required_min_vram_mb": 4096, "required_free_memory_mb": 4096, "acceptable_gpu_models": ["A100"], "max_util_pct": 50},
  "hosts": [ {"id": "host-1", "model": "A100", "vram_mb": 40960, "gpu_util_pct": 10, "free_memory_mb": 20000, "timestamp": 1620000000} ]
}

Response is JSON: {"matches": [ <host objects in ranked order> ] }

Job fields understood by the matcher:
- required_min_vram_mb: number - minimum TOTAL VRAM the host card must have.
- required_free_memory_mb: number, optional - minimum CURRENTLY FREE GPU memory. When present it is a
  hard constraint: a host is only offered if it reports a numeric free_memory_mb greater than or equal
  to this value. A host that does not report free_memory_mb (or reports a non-numeric value) is not
  offered, because it cannot prove it has room. When the field is absent, matching is exactly as before
  and free_memory_mb only acts as a tie-break in the ranking score.
- acceptable_gpu_models: array of strings, optional - allowed GPU model names.
- max_util_pct: number, optional - reject hosts busier than this (default 100).

Assumed host-report schema (used by scheduler matcher tests):
- id: string
- model: string (GPU model name)
- vram_mb: number (total VRAM in megabytes)
- gpu_util_pct: number (0-100)
- free_memory_mb: number (GPU memory currently free, in megabytes; required from a host that should be
  matched against jobs using required_free_memory_mb)
- timestamp: unix epoch seconds or ms (number)

This schema is an assumption for the minimal scheduler. If the host-agent implemented in the repository differs, the matcher will be adapted in a follow-up change.
