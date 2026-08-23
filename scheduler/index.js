const http = require('http');
const { match } = require('./lib/matcher');

const PORT = process.env.PORT || 3000;

// Simple in-memory jobs store
const jobs = {};
let jobCounter = 0;

const server = http.createServer((req, res) => {
  // Helper to send JSON
  function sendJson(obj, code = 200) {
    const b = JSON.stringify(obj);
    res.writeHead(code, {'Content-Type': 'application/json'});
    res.end(b);
  }

  // Only pay attention to POST and GET for our minimal API
  if (req.method === 'POST' && (req.url === '/match' || req.url === '/jobs')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        // Existing /match behaviour
        if (req.url === '/match') {
          const job = payload.job || {};
          const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
          const matches = match(job, hosts);
          sendJson({matches});
          return;
        }

        // New /jobs behaviour: accept a job JSON and return an id
        const receivedJob = payload || {};
        jobCounter += 1;
        const jobId = `job-${jobCounter}`;
        // initialize job state
        jobs[jobId] = {logs: [], status: 'running', job: receivedJob};
        sendJson({id: jobId});

        // Simulate log production and job completion with timers
        setTimeout(() => {
          jobs[jobId].logs.push('starting');
        }, 100);
        setTimeout(() => {
          jobs[jobId].logs.push('hello world');
        }, 200);
        setTimeout(() => {
          jobs[jobId].status = 'finished';
        }, 300);

      } catch (err) {
        sendJson({error: 'invalid_json', message: err.message}, 400);
      }
    });
    return;
  }

  if (req.method === 'GET' && /^\/jobs\/[^/]+\/logs$/.test(req.url)) {
    const parts = req.url.split('/');
    // ['', 'jobs', '<id>', 'logs']
    const jobId = parts[2];
    const state = jobs[jobId];
    if (!state) {
      sendJson({error: 'not_found'}, 404);
      return;
    }
    sendJson({logs: state.logs, status: state.status});
    return;
  }

  // Unknown route
  sendJson({error: 'not_found'}, 404);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('scheduler listening on', PORT);
  });
}

module.exports = server;
