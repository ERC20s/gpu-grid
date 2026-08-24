const http = require('http');
const fs = require('fs');
const path = require('path');
const { match } = require('./lib/matcher');

const PORT = process.env.PORT || 3000;

// In-memory host registry: Map<id, hostObject>
const hostRegistry = new Map();

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

  // Serve a minimal static console: GET / or GET /console
  if (req.method === 'GET' && (req.url === '/' || req.url === '/console')) {
    const file = path.join(__dirname, 'static', 'index.html');
    fs.readFile(file, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'internal_error'}));
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(data);
    });
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

  res.writeHead(404, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'not_found'}));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('scheduler listening on', PORT);
  });
}

module.exports = server;
