# gpu-grid
A marketplace for idle GPU time - host agent, scheduler, containerised job execution, live web console.

Scheduler API (added by proposal):

The scheduler provides a minimal HTTP endpoint POST /match which accepts a JSON payload:

{
  "job": {"required_min_vram_mb": 4096, "required_min_free_memory_mb": 1024, "acceptable_gpu_models": ["A100"], "max_util_pct": 50},
  "hosts": [ {"id": "host-1", "model": "A100", "vram_mb": 40960, "gpu_util_pct": 10, "free_memory_mb": 20000, "timestamp": 1620000000} ]
}

Response is JSON: {"matches": [ <host objects in ranked order> ] }

POST /match payload rules:

The payload is validated before anything is matched, because the matcher treats a value it
does not recognise as "no filter at all" - a wrongly shaped job used to match every host
instead of failing. A payload that breaks a rule below gets 400
{"error": "invalid_job", "message": "<what was wrong>"} and nothing is matched:

- the body must be a JSON object (not an array, string, number or null) and must carry "job".
  A bare job spec posted without the {"job": ...} wrapper is now an error, not a full-registry
  match. An empty body is the same error.
- "job" must be an object. Unknown fields inside it (image, cmd, resources, ...) are ignored,
  not rejected - only the matching fields below are checked.
- required_min_vram_mb, when present, must be a finite number >= 0.
- max_util_pct, when present, must be a finite number between 0 and 100. The string "10" is
  rejected; it used to mean "no utilisation limit" and returned busy hosts.
- acceptable_gpu_models, when present, must be an array of non-empty strings. The bare string
  "A100" is rejected; it used to mean "any model".
- "hosts", when present, must be an array and every entry must satisfy the same host schema
  POST /hosts enforces. A bad entry is reported as hosts[<i>]: <reason>.

A body larger than MAX_REQUEST_SIZE_BYTES still gets 413 request_too_large, and a body that is
not JSON at all still gets 400 invalid_json.

Ranking rule:

Hosts that pass the filters (vram_mb, acceptable_gpu_models, max_util_pct) are ranked by a
strict ordered comparison - each key is only looked at when the one before it ties:

1. gpu_util_pct ascending - the idlest host first. An UNREPORTED value is not 0: a host that
   omits gpu_util_pct ranks behind every host that reported one, however busy that host is.
2. free_memory_mb descending - more headroom first. Unreported likewise ranks behind any
   reported value, inside a utilisation tie.
3. timestamp descending - the fresher report first (a missing value counts as 0).
4. id ascending - so a complete tie always comes back in the same order.

Unknown is not idle. gpu_util_pct is optional at POST /hosts, so a host can report without it -
but on a marketplace that sells idle GPU time, scoring silence as 0% utilised made "stop
reporting" the cheapest way to win every match and be paid for a saturated card. A host that
does not report cannot prove it is idle, so it sorts last. The filter follows the same rule:
when a job carries max_util_pct, a host with no reported gpu_util_pct is excluded from the
matches. Without max_util_pct such a host is still matchable, just ranked last.

There is no combined score. A large free_memory_mb can never outrank lower utilisation, and
timestamp only ever breaks a tie, so a host reporting epoch milliseconds where another
reports seconds cannot win a match on that alone. Timestamp units are deliberately not
normalised. Liveness is judged by the scheduler's own clock (see Host liveness), not by
this field.

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

gridctl (the CLI):

scripts/gridctl.py asks the scheduler which hosts match a job.

    python scripts/gridctl.py --scheduler-url http://localhost:3000 \
        --job-file tests/fixtures/match_job.json

The job file holds the matcher-shaped job spec itself:

{ "required_min_vram_mb": 8192, "acceptable_gpu_models": ["A100", "RTX4090"], "max_util_pct": 60 }

gridctl wraps it for the endpoint and posts {"job": { ... }} to POST /match, so the
scheduler's payload.job is the spec you wrote. Without that wrapper payload.job is
undefined, the filter is empty and every live host "matches" - that was the old bug.
A job file that already has a top-level "job" key is posted as it stands, and its
optional "hosts" array is passed through (POST /match then matches that list instead
of the live registry).

The reply {"matches": [...]} is printed best host first and the CLI exits 0:

    2 host(s) matched, best first:
      1. host-a  model=A100  gpu_util_pct=5  free_memory_mb=30000
      2. host-b  model=A100  gpu_util_pct=40  free_memory_mb=12000

An empty matches array prints "No hosts matched." and still exits 0. If a future
job-execution API answers with a job id instead ({"id": ...}), gridctl keeps its old
behaviour: it prints "Job submitted: <id>" and polls GET /jobs/<id>/logs. Run the CLI
tests with pytest -q.
