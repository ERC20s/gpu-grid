const os = require('os');
const http = require('http');
const { parseNvidiaCsv } = require('./lib/nvidia');

const SCHEDULER_URL = process.env.SCHEDULER_URL;
const REPORT_SECONDS = Number(process.env.AGENT_REPORT_SECONDS || '30');

function deriveId() {
  return process.env.HOST_ID || os.hostname();
}

function buildHostReport(parsedRows) {
  // Aggregate multiple GPU rows into a single host object.
  // We sum vram_mb, take model list comma-joined, compute avg util and sum free mem.
  if (!parsedRows || !parsedRows.length) return null;
  const id = deriveId();
  const modelSet = new Set();
  let vram_mb = 0;
  let free_memory_mb = 0;
  let util_sum = 0;
  let util_count = 0;
  let timestamp = Date.now();

  for (const r of parsedRows) {
    if (r.model) modelSet.add(r.model);
    if (Number.isFinite(r.vram_mb)) vram_mb += r.vram_mb;
    if (Number.isFinite(r.free_memory_mb)) free_memory_mb += r.free_memory_mb;
    if (Number.isFinite(r.gpu_util_pct)) { util_sum += r.gpu_util_pct; util_count++; }
    if (r.timestamp) timestamp = r.timestamp;
  }

  const model = Array.from(modelSet).join(',') || 'unknown';
  const gpu_util_pct = util_count ? Math.round(util_sum / util_count) : 0;

  return { id, model, vram_mb, free_memory_mb, gpu_util_pct, timestamp };
}

function postToScheduler(host) {
  if (!SCHEDULER_URL) return Promise.reject(new Error('SCHEDULER_URL unset'));
  const url = new URL(SCHEDULER_URL);
  url.pathname = '/hosts';
  const data = JSON.stringify(host);
  const opts = { method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + (url.search || ''), headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? require('https') : http).request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        reject(new Error('bad_status ' + res.statusCode + ' ' + body));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function readNvidia() {
  try {
    // By default try to run nvidia-smi to get CSV output.
    const { stdout } = await require('child_process').promises.exec('nvidia-smi --query-gpu=name,memory.total,memory.free,utilization.gpu --format=csv,noheader,nounits');
    return parseNvidiaCsv(stdout);
  } catch (err) {
    // If nvidia-smi is unavailable, fall back to empty array.
    return [];
  }
}

async function tick() {
  const rows = await readNvidia();
  const host = buildHostReport(rows);
  if (!host) return;
  try {
    await postToScheduler(host);
    console.log('posted host', host.id);
  } catch (err) {
    console.error('post failed', err.message);
  }
}

if (require.main === module) {
  console.log('agent starting (report every', REPORT_SECONDS, 's)');
  // Do not run if SCHEDULER_URL unset: opt-in only
  if (!SCHEDULER_URL) {
    console.log('SCHEDULER_URL not set; agent disabled');
    process.exit(0);
  }
  tick();
  setInterval(tick, REPORT_SECONDS * 1000);
}

module.exports = { buildHostReport, deriveId };
