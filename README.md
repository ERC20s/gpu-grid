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

## gridctl (CLI)

`scripts/gridctl.py` is the command line front end for the scheduler. It needs Python 3 and
`requests` (`pip install requests`). Start the scheduler first (`cd scheduler && npm start`,
port 3000), then:

    python scripts/gridctl.py --scheduler-url http://localhost:3000 --job-file tests/fixtures/simple_job.json

The job file is sent as the `job` half of the POST /match contract above — the CLI wraps it,
so a job document on disk stays a plain job document. By default the scheduler matches against
its own registry (whatever hosts have reported to POST /hosts); pass `--hosts-file hosts.json`
(a JSON list, or `{"hosts": [...]}`) to match against a fixed list instead.

Two outcomes:

- The scheduler answers with `{"matches": [...]}` — the ranked hosts are printed, best first,
  and the CLI exits 0. An empty grid prints `No hosts matched this job.` and still exits 0.

      Matched 2 host(s), best first:
      host-a	model=A100	vram_mb=40960	gpu_util_pct=10

  `--json` prints the raw match list instead, for piping into other tools.

- The scheduler answers with a job id (a future executor, or a `/jobs` route) — the CLI prints
  `Job submitted: <id>` and polls `/jobs/<id>/logs`, printing each log line exactly once, until
  the job finishes. It exits 0 when the job succeeds, 1 when it fails, and 4 if `--timeout`
  (default 60s, `0` = wait forever) elapses first. Today's scheduler has no `/jobs` route, so
  this path is dormant.

Other exit codes: 2 for a bad job file or a rejected submission, 3 for a log-streaming error.
