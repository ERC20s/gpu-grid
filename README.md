# gpu-grid
A marketplace for idle GPU time - host agent, scheduler, containerised job execution, live web console.

Scheduler API (added by proposal):

The scheduler provides a minimal HTTP endpoint POST /match which accepts a JSON payload:

{
  "job": {"required_min_vram_mb": 4096, "required_min_free_memory_mb": 1024, "acceptable_gpu_models": ["A100"], "max_util_pct": 50},
  "hosts": [ {"id": "host-1", "model": "A100", "vram_mb": 40960, "gpu_util_pct": 10, "free_memory_mb": 20000, "timestamp": 1620000000} ]
}

Response is JSON: {"matches": [ <host objects in ranked order> ] }

Authentication:

Every mutating endpoint needs "Authorization: Bearer <token>". Reads (GET /hosts,
GET /hosts/:id, GET /health, GET /metrics) stay open.

- POST /hosts (host ingest; re-reporting is the heartbeat that keeps a host live) and
  DELETE /hosts/:id need a HOST token. HOST_TOKENS maps each host id to its token, and a
  token may only write the host ids it is configured for: host-a's token posting a report
  for host-b, or a batch that contains host-b, gets 403 forbidden and nothing is stored.
- POST /match (job submission) needs a USER token. USER_TOKENS maps each user id to its
  token; no two users may share one. A host token is not a user token, and vice versa.
- No token, an unknown token, or a scheme other than Bearer gets 401 unauthorized before
  the body is read.

Both settings are JSON objects, {"<id>": "<token>", ...}, with tokens of at least 16
non-space characters (`openssl rand -hex 32` makes a good one). The values live on the
server and never in this repository; .env.example lists the names. If either is unset,
every write that needs it gets 401 - the scheduler fails closed - and a malformed value
stops the scheduler from starting.

Submission rate limit:

POST /match is limited per authenticated user id: SUBMIT_RATE_LIMIT submissions (default 60)
per SUBMIT_RATE_WINDOW_SECONDS (default 60). Over the limit the answer is 429 rate_limited
with a Retry-After header. The key is the user id the token resolves to, never
x-forwarded-for or any other header a client can set, and a 401 spends nobody's budget.
The limiter tracks at most RATE_LIMIT_MAX_KEYS users (default 10000); a window's entry is
evicted once it ends, and if the table is still full the oldest window makes room.

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
- required_min_vram_mb, when present, must be a number between 0 and 1048576.
- required_min_free_memory_mb, when present, must be a number between 0 and 1048576. It is
  a hard constraint (see Free GPU memory below).
- max_util_pct, when present, must be a finite number between 0 and 100. The string "10" is
  rejected; it used to mean "no utilisation limit" and returned busy hosts.
- acceptable_gpu_models, when present, must be an array of at most 64 strings of 1-128
  characters. The bare string "A100" is rejected; it used to mean "any model".
- "hosts", when present, must be an array of at most 1000 entries and every entry must
  satisfy the same host schema POST /hosts enforces. A bad entry is reported as
  hosts[<i>]: <reason>.

A body larger than MAX_REQUEST_SIZE_BYTES still gets 413 request_too_large, and a body that is
not JSON at all still gets 400 invalid_json.

Free GPU memory:

A job that carries required_min_free_memory_mb is only ever matched to a host that reported
at least that much free_memory_mb. A host that did not report free_memory_mb cannot prove it
has the room and is excluded, and so is a host that is idle or has a big card but too little
of it free. A job needing more memory than any host has free is never scheduled: the answer
is an empty matches array. The rule applies to the live registry and to an explicit "hosts"
array alike. required_min_vram_mb remains a filter on the card's total size, so a job that
needs 20GB free on a card of at least 40GB says
{"required_min_vram_mb": 40960, "required_min_free_memory_mb": 20480}.

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

Host-report schema (scheduler/lib/schema.js; POST /hosts answers 400 invalid_host otherwise):
- id: string, 1-256 characters (required)
- model: string, 1-128 characters - the GPU model name (required)
- vram_mb: number, 0-1048576 - total VRAM in megabytes (required)
- timestamp: number, 0-1e13 - unix epoch seconds or ms (required)
- gpu_util_pct: number, 0-100 (optional)
- free_memory_mb: number, 0-1048576 and not more than vram_mb - free GPU memory (optional)

A POST /hosts batch holds at most 1000 reports. Fields the schema does not name are dropped
before a report is stored, so GET /hosts returns only these fields.

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
- DELETE /hosts/:id is the explicit counterpart to TTL expiry: a host that is
  decommissioned, drained for maintenance, or crashed cleanly can be removed from the
  registry immediately instead of staying matchable for up to HOST_TTL_SECONDS after it
  is gone. It decodes a URL-encoded id the same way GET /hosts/:id does, returns
  {deleted: true, id} with 200 when the entry existed, and {error: 'not_found'} with 404
  when it did not.

Set HOST_TTL_SECONDS shorter than the reporting interval and the grid will look empty;
keep it comfortably above the agent's report period. See .env.example.

gridctl (the CLI):

scripts/gridctl.py asks the scheduler which hosts match a job.

    python scripts/gridctl.py --scheduler-url http://localhost:3000 \
        --job-file tests/fixtures/match_job.json

The job file holds the matcher-shaped job spec itself:

{ "required_min_vram_mb": 8192, "acceptable_gpu_models": ["A100", "RTX4090"], "max_util_pct": 60 }

Export the user token first; gridctl reads it from GRID_USER_TOKEN (not a flag, so it stays
out of shell history) and sends it as a Bearer token. Without it the scheduler answers 401
and gridctl exits 2 saying so.

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

Demo with docker compose:

docker-compose.yml starts the scheduler and one fake host agent (scripts/fake_host_agent.js,
which reports a made-up A100 every 30 seconds with its host token and deregisters when it
stops), so gridctl can be tried end to end without a GPU. Only Docker is needed; the
scheduler is published on 127.0.0.1:3000.

    export FAKE_HOST_TOKEN=$(openssl rand -hex 32)
    export GRID_USER_TOKEN=$(openssl rand -hex 32)
    docker compose up -d --wait
    python scripts/gridctl.py --scheduler-url http://localhost:3000 \
        --job-file tests/fixtures/match_job.json
    docker compose down

gridctl prints the fake host as the one match:

    1 host(s) matched, best first:
      1. fake-host-1  model=A100  gpu_util_pct=5  free_memory_mb=30000

Run every docker compose command from a shell where both tokens are exported; compose
refuses to start without them rather than run the scheduler with no tokens.
