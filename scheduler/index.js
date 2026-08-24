const http = require('http');
const { match } = require('./lib/matcher');

const PORT = process.env.PORT || 3000;

// In-memory host registry: Map<id, hostObject>
const hostRegistry = new Map();

// In-memory jobs registry: Map<id, jobObject>
const jobsRegistry = new Map();
let jobCounter = 0;

const server = http.createServer((req, res) => {
  // POST /hosts -> accept single host JSON, validate and upsert
  if (req.method === 'POST' && req.url === '/hosts') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const host = JSON.parse(body || '{}');
        if (!host || typeof host !== 'object') throw new Error('expected object');
        const required = ['id', 'model', 'vram_mb', 'timestamp'];
        for (const k of required) {
          if (host[k] === undefined) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'invalid_host', message: `missing ${k}`}));
            return;
          }
        }
        hostRegistry.set(host.id, host);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(host));
      } catch (err) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'invalid_json', message: err.message}));
      }
    });
    return;
  }

  // GET /hosts -> list stored hosts
  if (req.method === 'GET' && req.url === '/hosts') {
    const hosts = Array.from(hostRegistry.values());
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({hosts}));
    return;
  }

  // POST /match -> use payload.hosts if provided, otherwise use registry
  if (req.method === 'POST' && req.url === '/match') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const job = payload.job || {};
        const hosts = Array.isArray(payload.hosts) ? payload.hosts : Array.from(hostRegistry.values());
        const matches = match(job, hosts);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({matches}));
      } catch (err) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'invalid_json', message: err.message}));
      }
    });
    return;
  }

  // POST /jobs -> accept a job JSON, create job id, store and start simulated executor
  if (req.method === 'POST' && req.url === '/jobs') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const job = JSON.parse(body || '{}');
        if (!job || typeof job !== 'object') throw new Error('expected object');
        const id = `job-${++jobCounter}`;
        const jobObj = { id, job, logs: [], status: 'running', created: Date.now() };
        jobsRegistry.set(id, jobObj);

        // Simulated executor: append a few logs then mark finished
        // Keep deterministic and short for tests
        const appendLog = (line) => {
          const j = jobsRegistry.get(id);
          if (!j) return;
          j.logs.push(line);
        };

        setTimeout(() => appendLog('Starting job ' + id), 10);
        setTimeout(() => appendLog('Running step 1'), 60);
        setTimeout(() => appendLog('Running step 2'), 120);
        setTimeout(() => {
          appendLog('Job finished');
          const j = jobsRegistry.get(id);
          if (j) j.status = 'finished';
        }, 180);

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({id}));
      } catch (err) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'invalid_json', message: err.message}));
      }
    });
    return;
  }

  // GET /jobs/:id/logs -> return {logs, status}
  if (req.method === 'GET' && req.url && req.url.startsWith('/jobs/') && req.url.endsWith('/logs')) {
    // extract id from /jobs/<id>/logs
    const parts = req.url.split('/');
    // ['', 'jobs', '<id>', 'logs']
    if (parts.length === 4) {
      const id = parts[2];
      const jobObj = jobsRegistry.get(id);
      if (!jobObj) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'job_not_found'}));
        return;
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({logs: jobObj.logs, status: jobObj.status}));
      return;
    }
  }

  res.writeHead(404, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'not_found'}));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('scheduler listening on', PORT);
  });
}

module.exports = server;
