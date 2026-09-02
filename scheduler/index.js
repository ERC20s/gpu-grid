const http = require('http');
const { match } = require('./lib/matcher');
const { validateHost } = require('./lib/validateHost');

const PORT = process.env.PORT || 3000;

// Largest request body the scheduler will read on a public endpoint (64 KB).
const MAX_BODY_BYTES = 64 * 1024;

// In-memory host registry: Map<id, hostObject>
const hostRegistry = new Map();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(payload));
}

// Route on the path only, so /hosts/ and /hosts?since=... reach the handler.
function pathnameOf(url) {
  const raw = String(url || '/');
  const path = raw.split('?')[0].split('#')[0];
  if (path.length > 1 && path.endsWith('/')) return path.replace(/\/+$/, '') || '/';
  return path;
}

// Collect a request body, refusing anything over MAX_BODY_BYTES with 413.
function readBody(req, res, onBody) {
  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', chunk => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      chunks.length = 0;
      // Answer once, then keep draining the rest of the upload without buffering
      // it, so the client reads the 413 instead of a reset connection.
      sendJson(res, 413, {error: 'payload_too_large', limit_bytes: MAX_BODY_BYTES});
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    onBody(Buffer.concat(chunks).toString('utf8'));
  });

  req.on('error', () => {
    if (aborted) return;
    aborted = true;
    sendJson(res, 400, {error: 'invalid_request'});
  });
}

const server = http.createServer((req, res) => {
  const path = pathnameOf(req.url);

  // POST /hosts -> accept single host JSON, validate, normalise and upsert
  if (req.method === 'POST' && path === '/hosts') {
    readBody(req, res, body => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, {error: 'invalid_json', message: err.message});
        return;
      }
      const result = validateHost(parsed);
      if (!result.ok) {
        sendJson(res, 400, {error: 'invalid_host', field: result.field, message: result.message});
        return;
      }
      hostRegistry.set(result.host.id, result.host);
      sendJson(res, 200, result.host);
    });
    return;
  }

  // GET /hosts -> list stored hosts
  if (req.method === 'GET' && path === '/hosts') {
    const hosts = Array.from(hostRegistry.values());
    sendJson(res, 200, {hosts});
    return;
  }

  // POST /match -> use payload.hosts if provided, otherwise use registry
  if (req.method === 'POST' && path === '/match') {
    readBody(req, res, body => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, {error: 'invalid_json', message: err.message});
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(res, 400, {error: 'invalid_json', message: 'expected an object'});
        return;
      }
      const job = payload.job || {};
      const hosts = Array.isArray(payload.hosts) ? payload.hosts : Array.from(hostRegistry.values());
      const matches = match(job, hosts);
      sendJson(res, 200, {matches});
    });
    return;
  }

  sendJson(res, 404, {error: 'not_found'});
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('scheduler listening on', PORT);
  });
}

module.exports = server;
