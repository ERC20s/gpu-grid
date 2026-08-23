#!/usr/bin/env python3
"""Minimal CLI to submit jobs to the scheduler and stream logs.

Usage: python scripts/gridctl.py --scheduler-url http://localhost:8000 --job-file path/to/job.json
"""
import argparse
import json
import sys
import time
from typing import Any, Dict

import requests


def submit_job(scheduler_url: str, job: Dict[str, Any]) -> str:
    base = scheduler_url.rstrip('/')
    # Try /match first, then /jobs
    for endpoint in ("/match", "/jobs"):
        url = f"{base}{endpoint}"
        try:
            resp = requests.post(url, json=job)
        except requests.RequestException as e:
            raise RuntimeError(f"Failed to connect to scheduler at {url}: {e}")
        if resp.status_code in (404, 405):
            # Try next endpoint
            continue
        if not resp.ok:
            raise RuntimeError(f"Scheduler returned {resp.status_code}: {resp.text}")
        data = resp.json()
        # Accept a few common id fields
        job_id = data.get('id') or data.get('job_id') or data.get('jobId')
        if not job_id:
            raise RuntimeError(f"Scheduler response did not contain job id: {data}")
        return job_id
    raise RuntimeError(f"Scheduler did not accept job POST at {scheduler_url}/match or {scheduler_url}/jobs")


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
    parser = argparse.ArgumentParser(description='Submit a job and stream its logs')
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
        job_id = submit_job(args.scheduler_url, job)
    except Exception as e:
        print(f"Job submission failed: {e}", file=sys.stderr)
        return 2

    print(f"Job submitted: {job_id}")

    try:
        return_code = stream_logs(args.scheduler_url, job_id, poll_interval=args.poll_interval)
    except Exception as e:
        print(f"Error streaming logs: {e}", file=sys.stderr)
        return 3
    return return_code


if __name__ == '__main__':
    exit(main())
