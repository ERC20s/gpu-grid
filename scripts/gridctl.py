#!/usr/bin/env python3
"""Minimal CLI to match a job against the grid and, when the scheduler
accepts jobs, stream the job's logs.

The scheduler this repository ships (scheduler/index.js) exposes exactly one
job route:

    POST /match   body {"job": {...}, "hosts": [...]}  ->  {"matches": [host, ...]}

`hosts` is optional: when it is omitted the scheduler matches against its own
in-memory host registry (whatever the host agents have reported to POST /hosts).
There is no /jobs route yet, so the "submit and stream logs" path below is kept
only for a future executor and is used solely when a scheduler answers with a
job id.

Usage:
    python scripts/gridctl.py --scheduler-url http://localhost:3000 \
        --job-file tests/fixtures/simple_job.json
"""
import argparse
import json
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

# Result kinds returned by submit_job()
RESULT_MATCHES = 'matches'
RESULT_JOB_ID = 'job_id'


def submit_job(scheduler_url: str, job: Dict[str, Any],
               hosts: Optional[List[Dict[str, Any]]] = None) -> Tuple[str, Any]:
    """POST the job to the scheduler.

    Returns ("matches", [host, ...]) when the scheduler answered with the real
    /match contract, or ("job_id", "<id>") when it answered with a job id (a
    future executor / a /jobs route).
    """
    base = scheduler_url.rstrip('/')

    for endpoint in ("/match", "/jobs"):
        url = f"{base}{endpoint}"
        # /match takes the wrapped contract; /jobs (if it ever exists) takes the
        # job document itself.
        if endpoint == "/match":
            payload: Dict[str, Any] = {"job": job}
            if hosts is not None:
                payload["hosts"] = hosts
        else:
            payload = job
        try:
            resp = requests.post(url, json=payload)
        except requests.RequestException as e:
            raise RuntimeError(f"Failed to connect to scheduler at {url}: {e}")
        if resp.status_code in (404, 405):
            # Route not served by this scheduler — try the next one.
            continue
        if not resp.ok:
            raise RuntimeError(f"Scheduler returned {resp.status_code}: {resp.text}")
        try:
            data = resp.json()
        except ValueError as e:
            raise RuntimeError(f"Scheduler returned a non-JSON body from {url}: {e}")
        if isinstance(data, dict) and isinstance(data.get('matches'), list):
            return RESULT_MATCHES, data['matches']
        job_id = None
        if isinstance(data, dict):
            job_id = data.get('id') or data.get('job_id') or data.get('jobId')
        if job_id:
            return RESULT_JOB_ID, job_id
        raise RuntimeError(
            f"Scheduler response from {url} had neither 'matches' nor a job id: {data}")

    raise RuntimeError(
        f"Scheduler did not accept the job at {base}/match or {base}/jobs")


def format_host(host: Dict[str, Any]) -> str:
    """One ranked host as a single readable line."""
    if not isinstance(host, dict):
        return str(host)
    host_id = host.get('id', '<no id>')
    model = host.get('model', '?')
    vram = host.get('vram_mb', '?')
    util = host.get('gpu_util_pct', '?')
    return f"{host_id}\tmodel={model}\tvram_mb={vram}\tgpu_util_pct={util}"


def print_matches(matches: List[Dict[str, Any]]) -> int:
    """Print the ranked hosts. Exit 0 even when empty: an empty grid is an
    answer, not an error."""
    if not matches:
        print("No hosts matched this job.")
        return 0
    print(f"Matched {len(matches)} host(s), best first:")
    for host in matches:
        print(format_host(host))
    return 0


def stream_logs(scheduler_url: str, job_id: str, poll_interval: float = 0.5,
                timeout: Optional[float] = 60.0) -> int:
    """Poll /jobs/<id>/logs, printing each log line exactly once.

    The logs endpoint returns the whole log so far on every poll, so the number
    of lines already printed is tracked and only the new tail is printed.
    """
    base = scheduler_url.rstrip('/')
    url = f"{base}/jobs/{job_id}/logs"
    printed = 0
    deadline = None if not timeout else time.monotonic() + timeout

    while True:
        try:
            resp = requests.get(url)
        except requests.RequestException as e:
            raise RuntimeError(f"Failed to get logs from {url}: {e}")
        if not resp.ok:
            raise RuntimeError(f"Logs endpoint returned {resp.status_code}: {resp.text}")
        data = resp.json()
        logs = data.get('logs', []) or []
        for line in logs[printed:]:
            print(line)
        printed = max(printed, len(logs))
        status = str(data.get('status', '')).lower()
        if status in ('finished', 'succeeded', 'done'):
            return 0
        if status == 'failed':
            return 1
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError(
                f"Job {job_id} did not finish within {timeout:g}s "
                f"(last status: {status or 'unknown'})")
        time.sleep(poll_interval)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Match a job against the grid and stream its logs if it runs')
    parser.add_argument('--scheduler-url', required=True, help='Base URL of the scheduler service')
    parser.add_argument('--job-file', required=True, help='Path to JSON job description')
    parser.add_argument('--hosts-file', help='Optional JSON file with a host list to match '
                                             'against instead of the scheduler registry')
    parser.add_argument('--poll-interval', type=float, default=0.5, help='Polling interval in seconds')
    parser.add_argument('--timeout', type=float, default=60.0,
                        help='Give up waiting for logs after this many seconds (0 = wait forever)')
    parser.add_argument('--json', action='store_true', help='Print the raw match list as JSON')
    args = parser.parse_args(argv)

    try:
        with open(args.job_file, 'r') as f:
            job = json.load(f)
    except Exception as e:
        print(f"Failed to read job file: {e}", file=sys.stderr)
        return 2

    hosts = None
    if args.hosts_file:
        try:
            with open(args.hosts_file, 'r') as f:
                hosts = json.load(f)
            if isinstance(hosts, dict):
                hosts = hosts.get('hosts')
            if not isinstance(hosts, list):
                raise ValueError('expected a JSON list of hosts, or {"hosts": [...]}')
        except Exception as e:
            print(f"Failed to read hosts file: {e}", file=sys.stderr)
            return 2

    try:
        kind, result = submit_job(args.scheduler_url, job, hosts)
    except Exception as e:
        print(f"Job submission failed: {e}", file=sys.stderr)
        return 2

    if kind == RESULT_MATCHES:
        if args.json:
            print(json.dumps(result))
            return 0
        return print_matches(result)

    job_id = result
    print(f"Job submitted: {job_id}")

    try:
        return_code = stream_logs(args.scheduler_url, job_id,
                                  poll_interval=args.poll_interval,
                                  timeout=args.timeout or None)
    except TimeoutError as e:
        print(f"Timed out: {e}", file=sys.stderr)
        return 4
    except Exception as e:
        print(f"Error streaming logs: {e}", file=sys.stderr)
        return 3
    return return_code


if __name__ == '__main__':
    sys.exit(main())
