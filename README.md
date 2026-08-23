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
