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

// Maximum accepted request body size for POST endpoints. Defaults to 256KB.
const DEFAULT_MAX_REQUEST_SIZE_BYTES = 262144;
function maxRequestSizeBytes() {
  const raw = process.env.MAX_REQUEST_SIZE_BYTES;
  const parsed = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_REQUEST_SIZE_BYTES;
  }
  return Math.floor(parsed);
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

function validationError(res, message) {
  res.writeHead(400, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'invalid_host', message}));
}

function jobValidationError(res, message) {
  res.writeHead(400, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'invalid_job', message}));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Validate a single host object. Returns null on success, or an error message
// string suitable for the validationError response.
function validateHost(host) {
  if (!host || typeof host !== 'object') return 'expected object';

  // Basic required fields presence
  const required = ['id', 'model', 'vram_mb', 'timestamp'];
  for (const k of required) {
    if (host[k] === undefined) {
      return `missing ${k}`;
    }
  }

  // id: non-empty string, capped length
  if (typeof host.id !== 'string' || host.id.length === 0) {
    return 'id must be a non-empty string';
  }
  if (host.id.length > 256) {
    return 'id too long';
  }

  // model: non-empty string
  if (typeof host.model !== 'string' || host.model.length === 0) {
    return 'model must be a non-empty string';
  }

  // vram_mb: finite non-negative number
  if (!isFiniteNumber(host.vram_mb) || host.vram_mb < 0) {
    return 'vram_mb must be a non-negative number';
  }

  // timestamp: finite number (allow seconds or ms)
  if (!isFiniteNumber(host.timestamp)) {
    return 'timestamp must be a number';
  }

  // optional gpu_util_pct: finite number in [0,100]
  if (host.gpu_util_pct !== undefined) {
    if (!isFiniteNumber(host.gpu_util_pct) || host.gpu_util_pct < 0 || host.gpu_util_pct > 100) {
      return 'gpu_util_pct must be between 0 and 100';
    }
  }

  // optional free_memory_mb: finite non-negative number
  if (host.free_memory_mb !== undefined) {
    if (!isFiniteNumber(host.free_memory_mb) || host.free_memory_mb < 0) {
      return 'free_memory_mb must be a non-negative number';
    }
  }

  return null;
}

// Validate a job spec exactly as lib/matcher.js reads it. The matcher silently
// downgrades anything it does not recognise (a string "10" for max_util_pct
// becomes "no utilisation limit", a bare "A100" for acceptable_gpu_models
// becomes "any model"), so a filter that is the wrong SHAPE quietly turns into
// "anything" and the job lands on the wrong card. Reject it up front instead.
// Unknown fields (image, cmd, resources, ...) stay ignored on purpose - they
// belong to the job-execution side, not to matching.
// Returns null on success or an error message string.
function validateJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return 'job must be an object';
  }

  if (job.required_min_vram_mb !== undefined) {
    if (!isFiniteNumber(job.required_min_vram_mb) || job.required_min_vram_mb < 0) {
      return 'job.required_min_vram_mb must be a non-negative number';
    }
  }

  if (job.max_util_pct !== undefined) {
    if (!isFiniteNumber(job.max_util_pct) || job.max_util_pct < 0 || job.max_util_pct > 100) {
      return 'job.max_util_pct must be a number between 0 and 100';
    }
  }

  if (job.required_min_free_memory_mb !== undefined) {
    if (!isFiniteNumber(job.required_min_free_memory_mb) || job.required_min_free_memory_mb < 0) {
      return 'job.required_min_free_memory_mb must be a non-negative number';
    }
  }

  if (job.acceptable_gpu_models !== undefined) {
    if (!Array.isArray(job.acceptable_gpu_models)) {
      return 'job.acceptable_gpu_models must be an array of strings';
    }
    for (let i = 0; i < job.acceptable_gpu_models.length; i++) {
      const model = job.acceptable_gpu_models[i];
      if (typeof model !== 'string' || model.length === 0) {
        return `job.acceptable_gpu_models[${i}] must be a non-empty string`;
      }
    }
  }

  return null;
}

// Validate a whole POST /match payload: {"job": {...}, "hosts": [...]}. The
// hosts array (when supplied) is checked with the same validateHost the
// POST /hosts path uses, so a null or half-built entry cannot reach the matcher
// and come back as an invalid_json error with a raw JS message.
// Returns null on success or an error message string.
function validateMatchPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'payload must be a JSON object';
  }

  if (payload.job === undefined) {
    return 'missing job - post {"job": { ... }}';
  }

  const jobErr = validateJob(payload.job);
  if (jobErr) return jobErr;

  if (payload.hosts !== undefined) {
    if (!Array.isArray(payload.hosts)) {
      return 'hosts must be an array';
    }
    for (let i = 0; i < payload.hosts.length; i++) {
      const err = validateHost(payload.hosts[i]);
      if (err) return `hosts[${i}]: ${err}`;
    }
  }

  return null;
}

const server = http.createServer((req, res) => {
  const path = pathOf(req.url || '');

  // Add permissive CORS headers for browser clients. These are intentionally
  // permissive (Access-Control-Allow-Origin: *) so a web console served from a
  // different origin can interact with the scheduler. If a stricter policy is
  // desired later this header can be narrowed to an allowlist or configured.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  // Handle preflight requests quickly without exercising body parsing.
  if (req.method === 'OPTIONS') {
    // 204 No Content with CORS headers lets browsers proceed with the real
    // request. We do not send a body.
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /hosts -> accept single host JSON, validate and upsert
  if (req.method === 'POST' && path === '/hosts') {
    let body = '';
    let received = 0;
    const limit = maxRequestSizeBytes();
    let tooLarge = false;

    req.on('data', chunk => {
      if (tooLarge) return;
      const chunkLen = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      received += chunkLen;
      if (received > limit) {
        tooLarge = true;
        if (!res.headersSent) {
          res.writeHead(413, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({error: 'request_too_large', message: `body exceeds ${limit} bytes`}));
        }
        // Close the connection and stop processing further data.
        try { req.destroy(); } catch (e) {}
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (tooLarge) return;
      try {
        const parsed = JSON.parse(body || '{}');

        if (Array.isArray(parsed)) {
          // Batch path: validate all first, then upsert atomically
          const seen = new Set();
          for (let i = 0; i < parsed.length; i++) {
            const err = validateHost(parsed[i]);
            if (err) {
              return validationError(res, `hosts[${i}]: ${err}`);
            }
            // Duplicate id check: reject the whole batch if any id repeats
            const id = parsed[i].id;
            if (seen.has(id)) {
              return validationError(res, `hosts[${i}]: duplicate id "${id}"`);
            }
            seen.add(id);
          }
          // All valid and unique; upsert all
          const stored = [];
          const now = Date.now();
          for (const h of parsed) {
            hostRegistry.set(h.id, {host: h, seenAt: now});
            stored.push(h);
          }
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({hosts: stored}));
          return;
        }

        // Single-host path: preserve existing behaviour
        const host = parsed;
        if (!host || typeof host !== 'object') throw new Error('expected object');

        const err = validateHost(host);
        if (err) return validationError(res, err);

        hostRegistry.set(host.id, {host, seenAt: Date.now()});
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(host));
      } catch (err) {
        // JSON.parse or other unexpected errors
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

  // GET /health -> simple health and readiness check. Returns a small JSON with
  // deterministic fields that do not expose internal registry metrics.
  if (req.method === 'GET' && path === '/health') {
    const now = Date.now();
    const uptimeMs = Math.floor(process.uptime() * 1000);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      status: 'ok',
      now,
      uptime_ms: uptimeMs,
      host_ttl_seconds: Math.floor(hostTtlMs() / 1000)
    }));
    return;
  }

  // POST /match -> use payload.hosts if provided, otherwise use LIVE registry
  if (req.method === 'POST' && path === '/match') {
    let body = '';
    let received = 0;
    const limit = maxRequestSizeBytes();
    let tooLarge = false;

    req.on('data', chunk => {
      if (tooLarge) return;
      const chunkLen = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      received += chunkLen;
      if (received > limit) {
        tooLarge = true;
        if (!res.headersSent) {
          res.writeHead(413, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({error: 'request_too_large', message: `body exceeds ${limit} bytes`}));
        }
        try { req.destroy(); } catch (e) {}
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (tooLarge) return;
      try {
        const payload = JSON.parse(body || '{}');

        const err = validateMatchPayload(payload);
        if (err) return jobValidationError(res, err);

        const job = payload.job;
        const hosts = payload.hosts !== undefined ? payload.hosts : freshHosts();
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
module.exports.validateHost = validateHost;
module.exports.validateJob = validateJob;
module.exports.validateMatchPayload = validateMatchPayload;
