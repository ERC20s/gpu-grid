const os = require('os');
const { exec } = require('child_process');
const { queryNvidia } = require('./lib/nvidia');
const http = require('http');
const https = require('https');

const SCHEDULER_URL = process.env.SCHEDULER_URL;
const AGENT_REPORT_SECONDS = Number(process.env.AGENT_REPORT_SECONDS) || 30;
const HOST_ID = process.env.HOST_ID || os.hostname();

if (!SCHEDULER_URL) {
  console.error('SCHEDULER_URL not set; the agent will not start. Put SCHEDULER_URL in the environment.');
  process.exit(1);
}

function aggregateGPUs(gpus) {
  if (!gpus || !gpus.length) {
    return {
      id: HOST_ID,
      model: 'unknown',
      vram_mb: 0,
      gpu_util_pct: 0,
      free_memory_mb: 0,
      timestamp: Math.floor(Date.now() / 1000)
    };
  }
  const model = gpus[0].name || 'unknown';
  const vram_mb = gpus.reduce((s, g) => s + (g.memory_total_mb || 0), 0);
  const free_memory_mb = gpus.reduce((s, g) => s + (g.memory_free_mb || 0), 0);
  const gpu_util_pct = Math.floor(gpus.reduce((s, g) => s + (g.util_pct || 0), 0) / gpus.length);
  return {
    id: HOST_ID,
    model,
    vram_mb,
    gpu_util_pct,
    free_memory_mb,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

function postHost(host) {
  return new Promise((resolve) => {
    try {
      const url = new URL('/hosts', SCHEDULER_URL);
      const body = JSON.stringify(host);
      const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, opts, (res) => {
        // consume body
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            console.error('Failed to post host:', res.statusCode, res.statusMessage);
          }
          resolve();
        });
      });
      req.on('error', (err) => {
        console.error('Error posting host:', err && err.message ? err.message : err);
        resolve();
      });
      req.write(body);
      req.end();
    } catch (e) {
      console.error('Error posting host:', e && e.message ? e.message : e);
      resolve();
    }
  });
}

function sampleOnce() {
  return new Promise((resolve) => {
    queryNvidia((err, gpus) => {
      if (err) {
        console.error('nvidia-smi failed or not present, using empty GPU list');
        gpus = [];
      }
      const host = aggregateGPUs((gpus || []).map(g => ({ name: g.name, memory_total_mb: g.memory_total_mb, memory_free_mb: g.memory_free_mb, util_pct: g.util_pct })));
      postHost(host).then(() => resolve());
    });
  });
}

async function loop() {
  while (true) {
    await sampleOnce();
    await new Promise(r => setTimeout(r, AGENT_REPORT_SECONDS * 1000));
  }
}

if (require.main === module) {
  console.log('agent starting, reporting to', SCHEDULER_URL, 'every', AGENT_REPORT_SECONDS, 's');
  loop();
}

module.exports = { aggregateGPUs, sampleOnce };
