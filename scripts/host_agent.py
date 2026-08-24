#!/usr/bin/env python3
"""Minimal host agent CLI that posts a host report to the scheduler's /hosts.

Usage: python scripts/host_agent.py --scheduler-url http://localhost:3000 [--id host-1 ...]
"""
import argparse
import json
import sys
import time
from typing import Any, Dict

import requests


def post_host(scheduler_url: str, host: Dict[str, Any]) -> Dict[str, Any]:
    base = scheduler_url.rstrip('/')
    url = f"{base}/hosts"
    try:
        resp = requests.post(url, json=host)
    except requests.RequestException as e:
        raise RuntimeError(f"Failed to connect to scheduler at {url}: {e}")
    if not resp.ok:
        raise RuntimeError(f"Scheduler returned {resp.status_code}: {resp.text}")
    return resp.json()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Send a host report to the scheduler')
    parser.add_argument('--scheduler-url', required=True, help='Base URL of the scheduler service')
    parser.add_argument('--id', dest='id', help='Host id', default='fake-host-1')
    parser.add_argument('--model', help='GPU model', default='A100')
    parser.add_argument('--vram-mb', type=int, help='Total VRAM in MB', default=16384)
    parser.add_argument('--gpu-util-pct', type=int, help='GPU utilisation percent', default=0)
    parser.add_argument('--free-memory-mb', type=int, help='Free GPU memory in MB', default=8192)
    args = parser.parse_args(argv)

    host = {
        'id': args.id,
        'model': args.model,
        'vram_mb': args.vram_mb,
        'gpu_util_pct': args.gpu_util_pct,
        'free_memory_mb': args.free_memory_mb,
        # timestamp in seconds
        'timestamp': int(time.time())
    }

    try:
        resp = post_host(args.scheduler_url, host)
    except Exception as e:
        print(f"Failed to post host report: {e}", file=sys.stderr)
        return 2

    print(json.dumps(resp))
    return 0


if __name__ == '__main__':
    exit(main())
