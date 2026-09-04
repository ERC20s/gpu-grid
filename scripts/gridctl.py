#!/usr/bin/env python3
"""Minimal CLI to ask the scheduler which hosts match a job (and, when a job
execution API exists, to submit a job and stream its logs).

Usage:
    python scripts/gridctl.py --scheduler-url http://localhost:3000 \
        --job-file tests/fixtures/match_job.json

The scheduler's POST /match contract (see README.md and scheduler/index.js) is:

    request : {"job": {...}, "hosts": [ ... ]}   - "hosts" optional; without it
              the scheduler matches against its own live host registry.
    response: {"matches": [ <host objects in ranked order> ]}

So the job spec must be wrapped in a "job" key: posting the bare job document
as the whole body makes payload.job undefined on the scheduler side, which
means an empty filter that every live host passes.
"""
import argparse
import json
import sys
import time
from typing import Any, Dict, List, Tuple

import requests


def build_payload(document: Dict[str, Any]) -> Dict[str, Any]:
    """Turn a job file into a POST /match payload.

    A file that already carries a "job" key is treated as a complete payload
    (its optional "hosts" array is passed through). Anything else is treated as
    the job spec itself and is wrapped in {"job": ...}.
    """
    if isinstance(document, dict) and isinstance(document.get('job'), dict):
        payload: Dict[str, Any] = {'job': document['job']}
        if isinstance(document.get('hosts'), list):
            payload['hosts'] = document['hosts']
        return payload

    payload = {'job': document if isinstance(document, dict) else {}}
    if isinstance(document, dict) and isinstance(document.get('hosts'), list):
        # A job document that carries its own candidate host list.
        payload['hosts'] = document['hosts']
    return payload


def post_job(scheduler_url: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """POST the payload to /match, falling back to /jobs, and return the JSON."""
    base = scheduler_url.rstrip('/')
    for endpoint in ("/match", "/jobs"):
        url = f"{base}{endpoint}"
        try:
            resp = requests.post(url, json=payload)
        except requests.RequestException as e:
            raise RuntimeError(f"Failed to connect to scheduler at {url}: {e}")
        if resp.status_code in (404, 405):
            # Try next endpoint
            continue
        if not resp.ok:
            raise RuntimeError(f"Scheduler returned {resp.status_code}: {resp.text}")
        data = resp.json()
        if not isinstance(data, dict):
            raise RuntimeError(f"Scheduler returned an unexpected payload: {data}")
        return data
    raise RuntimeError(
        f"Scheduler did not accept job POST at {scheduler_url}/match or {scheduler_url}/jobs")


def _field(host: Dict[str, Any], key: str) -> str:
    value = host.get(key)
    return '-' if value is None else str(value)


def print_matches(matches: List[Any]) -> int:
    """Print the ranked hosts the scheduler returned. Rank 1 is the best host."""
    if not matches:
        print("No hosts matched.")
        return 0
    print(f"{len(matches)} host(s) matched, best first:")
    for rank, host in enumerate(matches, start=1):
        if not isinstance(host, dict):
            print(f"  {rank}. {host}")
            continue
        print(
            f"  {rank}. {_field(host, 'id')}"
            f"  model={_field(host, 'model')}"
            f"  gpu_util_pct={_field(host, 'gpu_util_pct')}"
            f"  free_memory_mb={_field(host, 'free_memory_mb')}"
        )
    return 0


def job_id_of(data: Dict[str, Any]) -> str:
    """Accept a few common id fields from a future job-execution API."""
    return data.get('id') or data.get('job_id') or data.get('jobId')


def submit_job(scheduler_url: str, job: Dict[str, Any]) -> Tuple[str, Any]:
    """Post a job document and say what came back.

    Returns ("matches", [...]) for the scheduler's POST /match contract, or
    ("job_id", "<id>") when the endpoint answered with a job id instead.
    """
    data = post_job(scheduler_url, build_payload(job))
    if isinstance(data.get('matches'), list):
        return ('matches', data['matches'])
    job_id = job_id_of(data)
    if job_id:
        return ('job_id', job_id)
    raise RuntimeError(f"Scheduler response contained neither matches nor a job id: {data}")


def stream_logs(scheduler_url: str, job_id: str, poll_interval: float = 0.5) -> int:
    base = scheduler_url.rstrip('/')
    url = f"{base}/jobs/{job_id}/logs"
    while True:
        try:
            resp = requests.get(url)
        except requests.RequestException as e:
            raise RuntimeError(f"Failed to get logs from {url}: {e}")
        if not resp.ok:
            raise RuntimeError(f"Logs endpoint returned {resp.status_code}: {resp.text}")
        data = resp.json()
        logs = data.get('logs', [])
        for line in logs:
            print(line)
        status = data.get('status', '').lower()
        if status in ('finished', 'succeeded', 'failed', 'done'):
            # Return non-zero on failed
            return 0 if status in ('finished', 'succeeded', 'done') else 1
        time.sleep(poll_interval)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Match a job against the grid (and stream its logs when the scheduler runs it)')
    parser.add_argument('--scheduler-url', required=True, help='Base URL of the scheduler service')
    parser.add_argument('--job-file', required=True, help='Path to JSON job description')
    parser.add_argument('--poll-interval', type=float, default=0.5, help='Polling interval in seconds')
    args = parser.parse_args(argv)

    try:
        with open(args.job_file, 'r') as f:
            job = json.load(f)
    except Exception as e:
        print(f"Failed to read job file: {e}", file=sys.stderr)
        return 2

    try:
        kind, result = submit_job(args.scheduler_url, job)
    except Exception as e:
        print(f"Job submission failed: {e}", file=sys.stderr)
        return 2

    if kind == 'matches':
        return print_matches(result)

    job_id = result
    print(f"Job submitted: {job_id}")

    try:
        return_code = stream_logs(args.scheduler_url, job_id, poll_interval=args.poll_interval)
    except Exception as e:
        print(f"Error streaming logs: {e}", file=sys.stderr)
        return 3
    return return_code


if __name__ == '__main__':
    exit(main())
