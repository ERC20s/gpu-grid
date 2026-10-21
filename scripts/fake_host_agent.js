#!/usr/bin/env node
// Fake host agent for the docker-compose demo: reports one made-up GPU to the
// scheduler's POST /hosts every REPORT_INTERVAL_SECONDS, using its host token,
// and deregisters (DELETE /hosts/:id) on SIGTERM/SIGINT. No GPU needed; no
// dependencies beyond Node 22.
//
// Settings (environment):
//   SCHEDULER_URL            base URL of the scheduler (required)
//   HOST_ID                  the host id to report as (required)
//   HOST_TOKEN               that host's token from HOST_TOKENS (required)
//   REPORT_INTERVAL_SECONDS  default 30; keep it well under HOST_TTL_SECONDS
//   GPU_MODEL, VRAM_MB, FREE_MEMORY_MB, GPU_UTIL_PCT  what to report

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`fake-host: ${name} is not set`);
    process.exit(1);
  }
  return value;
}

const schedulerUrl = required('SCHEDULER_URL').replace(/\/+$/, '');
const hostId = required('HOST_ID');
const token = required('HOST_TOKEN');
const intervalSeconds = Number(process.env.REPORT_INTERVAL_SECONDS || 30);
// setInterval() runs a 0, negative, NaN or over-2^31-1 ms delay every 1 ms,
// which would flood the scheduler with reports.
const MAX_INTERVAL_SECONDS = Math.floor(2147483647 / 1000);
if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0 || intervalSeconds > MAX_INTERVAL_SECONDS) {
  console.error(`fake-host: REPORT_INTERVAL_SECONDS must be a positive number of seconds, at most ${MAX_INTERVAL_SECONDS}, not "${process.env.REPORT_INTERVAL_SECONDS}"`);
  process.exit(1);
}
const intervalMs = intervalSeconds * 1000;
const headers = {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`};

function hostReport() {
  return {
    id: hostId,
    model: process.env.GPU_MODEL || 'A100',
    vram_mb: Number(process.env.VRAM_MB || 40960),
    free_memory_mb: Number(process.env.FREE_MEMORY_MB || 30000),
    gpu_util_pct: Number(process.env.GPU_UTIL_PCT || 5),
    timestamp: Math.floor(Date.now() / 1000)
  };
}

async function report() {
  try {
    const res = await fetch(`${schedulerUrl}/hosts`, {method: 'POST', headers, body: JSON.stringify(hostReport())});
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      // A token problem will not fix itself; stop so the container shows it.
      console.error(`fake-host: scheduler refused ${hostId} (${res.status}): ${text}`);
      process.exit(1);
    }
    console.log(`fake-host: reported ${hostId} -> ${res.status}`);
  } catch (err) {
    console.error(`fake-host: report failed, will retry: ${err.message}`);
  }
}

async function deregister(signal) {
  console.log(`fake-host: ${signal}, deregistering ${hostId}`);
  try {
    const res = await fetch(`${schedulerUrl}/hosts/${encodeURIComponent(hostId)}`, {method: 'DELETE', headers});
    console.log(`fake-host: DELETE -> ${res.status}`);
  } catch (err) {
    console.error(`fake-host: deregister failed: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => deregister('SIGTERM'));
process.on('SIGINT', () => deregister('SIGINT'));

report();
setInterval(report, intervalMs);
