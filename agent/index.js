const http = require('http');
const https = require('https');
const url = require('url');
const os = require('os');
const { parseNvidiaCsv, runNvidiaSmi } = require('./lib/nvidia');

const SCHEDULER_URL = process.env.SCHEDULER_URL;
const AGENT_REPORT_SECONDS = Number(process.env.AGENT_REPORT_SECONDS) || 30;
const HOST_ID_BASE = process.env.HOST_ID || os.hostname();

function postHost(schedulerUrl, hostObj) {
  return new Promise((resolve) => {
    try {
      const target = new url.URL(schedulerUrl);
      target.pathname = (target.pathname || '') + '/hosts';
      const body = JSON.stringify(hostObj);
      const opts = {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + (target.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const reqm = target.protocol === 'https:' ? https : http;
      const req = reqm.request(opts, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const payload = Buffer.concat(chunks).toString();
          resolve({statusCode: res.statusCode, body: payload});
        });
      });
      req.on('error', (err) => {
        resolve({error: err});
      });
      req.write(body);
      req.end();
    } catch (err) {
      resolve({error: err});
    }
  });
}

async function reportOnceFromCsv(csv) {
  const hosts = parseNvidiaCsv(csv, HOST_ID_BASE);
  return await Promise.all(hosts.map(async (h) => {
    // allow the host id to reflect GPU index more clearly
    return await postHost(SCHEDULER_URL, h);
  }));
}

async function reportOnce() {
  if (!SCHEDULER_URL) {
    console.error('SCHEDULER_URL is not set; skipping report');
    return;
  }
  try {
    const gpus = await runNvidiaSmi();
    if (!gpus || gpus.length === 0) {
      // nothing to post
      return;
    }
    for (const gpu of gpus) {
      // allow overriding id base for multi-gpu machines
      gpu.id = (process.env.HOST_ID ? process.env.HOST_ID : os.hostname()) + `-gpu${gpu.id.split('-gpu').pop()}`;
      const res = await postHost(SCHEDULER_URL, gpu);
      if (res.error) {
        console.error('Failed to post host', gpu.id, res.error && res.error.message);
      } else if (res.statusCode !== 200) {
        console.error('Non-200 from scheduler for', gpu.id, res.statusCode, res.body);
      }
    }
  } catch (err) {
    console.error('Error sampling GPUs:', err && err.message);
  }
}

let timer = null;

function start({once = false} = {}) {
  if (!SCHEDULER_URL) {
    console.error('SCHEDULER_URL not set; agent will not run');
    return;
  }
  if (once) return reportOnce();
  // immediate first run
  reportOnce();
  timer = setInterval(reportOnce, AGENT_REPORT_SECONDS * 1000);
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
}

if (require.main === module) {
  start();
}

module.exports = { start, stop, reportOnce, reportOnceFromCsv };
