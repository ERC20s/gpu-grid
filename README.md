# gpu-grid
A marketplace for idle GPU time - host agent, scheduler, containerised job execution, live web console.

Scheduler API (added by proposal):

The scheduler provides a minimal HTTP endpoint POST /match which accepts a JSON payload:

{
  "job": {"required_min_vram_mb": 4096, "acceptable_gpu_models": ["A100"], "max_util_pct": 50},
  "hosts": [ {"id": "host-1", "model": "A100", "vram_mb": 40960, "gpu_util_pct": 10, "free_memory_mb": 20000, "timestamp": 1620000000} ]
}

Response is JSON: {"matches": [ <host objects in ranked order> ] }

Host reports: POST /hosts

A host agent registers itself with POST /hosts and a single host object. The report is validated
by scheduler/lib/validateHost.js before it is stored, so a host that is stored is a host the
matcher can actually see.

Host-report schema (enforced at ingest):
- id: string, required, non-empty
- model: string, required, non-empty (GPU model name)
- vram_mb: number, required, finite and not negative (total VRAM in megabytes)
- timestamp: number, required, finite (unix epoch seconds or ms)
- gpu_util_pct: number, optional, 0-100
- free_memory_mb: number, optional, finite and not negative

Numeric strings are accepted and coerced, so a report with "vram_mb": "40960" is stored as the
number 40960 and ranks in POST /match like any other host. Fields the scheduler does not know
about are stored unchanged.

Responses from POST /hosts:
- 200 with the normalised host object on success
- 400 {"error": "invalid_host", "field": "vram_mb", "message": "..."} when a field is missing,
  the wrong type or out of range
- 400 {"error": "invalid_json", "message": "..."} when the body is not valid JSON
- 413 {"error": "payload_too_large", "limit_bytes": 65536} when the body exceeds 64 KB
  (the same 64 KB limit applies to POST /match)

Routing uses the request path only, so /hosts, /hosts/ and /hosts?since=... all reach the same
handler; unknown paths still return 404 {"error": "not_found"}.

Tests: cd scheduler && npm test runs the matcher, hosts and validation suites.
