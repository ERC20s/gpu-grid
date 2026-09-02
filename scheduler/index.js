const http = require('http');
const { match } = require('./lib/matcher');

const PORT = process.env.PORT || 3000;

// How long a host report stays true. A host agent that stops reporting drops
// out of matching after this many seconds. Read per request so an operator can
// change it without a code change; the NAME is declared in the root .d8a keys:
// block and in .env.example.
const DEFAULT_HOST_TTL_SECONDS = 120;

function hostTtlMs() {
  const raw = process.env.HOST_TTL_SECONDS;
  const parsed = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HOST_TTL_SECONDS * 1000;
  }
  return Math.floor(parsed * 1000);
}

// In-memory host registry: Map<id, {host, seenAt}>
// seenAt is a SERVER-side stamp (Date.now()), deliberately kept outside the
// host object so a host cannot claim to be alive with a forged timestamp and
// so callers keep seeing exactly the report they posted.
const hostRegistry = new Map();

// Live hosts only. Entries past the TTL are removed from the map as they are
// read, so a grid that churns through hosts does not grow without bound.
function freshHosts(now = Date.now()) {
  const ttl = hostTtlMs();
  const live = [];
  for (const [id, entry] of hostRegistry) {
    if (now - entry.seenAt > ttl) {
      hostRegistry.delete(id);
      continue;
    }
    live.push(entry.host);
  }
  return live;
}

// Everything in the registry, each entry annotated with liveness. Used by
// GET /hosts?include_stale=1 (the web console wants to show dead hosts greyed
// out rather than have them vanish). This view never deletes.
function allHostsAnnotated(now = Date.now()) {
  const ttl = hostTtlMs();
  return Array.from(hostRegistry.values()).map(entry => {
    const age = now - entry.seenAt;
    return Object.assign({}, entry.host, {
      stale: age > ttl,
      last_seen_ms_ago: age
    });
  });
}

function wantsStale(url) {
  const query = url.indexOf('?') === -1 ? '' : url.slice(url.indexOf('?') + 1);
  return /(^|&)include_stale=(1|true|yes)(&|$)/.test(query);
}

function pathOf(url) {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

const server = http.createServer((req, res) => {
  const path = pathOf(req.url || '');

  // POST /hosts -> accept single host JSON, validate and upsert
  if (req.method === 'POST' && path === '/hosts') {
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
        hostRegistry.set(host.id, {host, seenAt: Date.now()});
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(host));
      } catch (err) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'invalid_json', message: err.message}));
      }
    });
    return;
  }

  // GET /hosts -> list live hosts (add ?include_stale=1 for the full registry)
  if (req.method === 'GET' && path === '/hosts') {
    const hosts = wantsStale(req.url || '') ? allHostsAnnotated() : freshHosts();
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({hosts, host_ttl_seconds: Math.floor(hostTtlMs() / 1000)}));
    return;
  }

  // POST /match -> use payload.hosts if provided, otherwise use LIVE registry
  if (req.method === 'POST' && path === '/match') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const job = payload.job || {};
        const hosts = Array.isArray(payload.hosts) ? payload.hosts : freshHosts();
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
    console.log('scheduler listening on', PORT, '- host TTL', Math.floor(hostTtlMs() / 1000) + 's');
  });
}

module.exports = server;
// Test hooks: the suite needs to age an entry without waiting out the TTL.
module.exports.hostRegistry = hostRegistry;
module.exports.hostTtlMs = hostTtlMs;
module.exports.freshHosts = freshHosts;
