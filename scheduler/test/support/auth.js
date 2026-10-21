// Test support (not a test file): credentials for the HTTP tests that were
// written before the scheduler required them. withAuth(options, body) returns
// the request options with the Authorization header the endpoint needs, and
// registers the matching token in HOST_TOKENS / USER_TOKENS, which the
// scheduler re-reads per request. Pass {noAuth: true} to send no header.
//
// Every host id these tests report shares one token, so their multi-host
// batches stay valid. test/auth.test.js gives each host its own token and
// checks that one host cannot write another.
const HOST_TOKEN = 'test-host-token-shared';
const USER_ID = 'test-user';
const USER_TOKEN = 'test-user-token-0001';
// A host id always registered, so a body with no usable id still reaches
// validation instead of stopping at 401.
const FALLBACK_HOST_ID = 'test-agent';

function readTable(name) {
  return process.env[name] ? JSON.parse(process.env[name]) : {};
}

function registerHost(id) {
  // The scheduler rejects a whole table holding an id it could never accept,
  // so ids a validation test sends on purpose (too long, empty) are skipped.
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return;
  const table = readTable('HOST_TOKENS');
  if (table[id] === HOST_TOKEN) return;
  table[id] = HOST_TOKEN;
  process.env.HOST_TOKENS = JSON.stringify(table);
}

function registerUser() {
  const table = readTable('USER_TOKENS');
  if (table[USER_ID] === USER_TOKEN) return;
  table[USER_ID] = USER_TOKEN;
  process.env.USER_TOKENS = JSON.stringify(table);
}

function hostIdsIn(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.filter(h => h && typeof h === 'object').map(h => h.id);
}

function withAuth(options, body) {
  const out = Object.assign({}, options, {headers: Object.assign({}, options.headers)});
  delete out.noAuth;
  if (options.noAuth || out.headers.Authorization !== undefined) return out;

  const path = options.path || '';
  if (options.method === 'POST' && path === '/hosts') {
    registerHost(FALLBACK_HOST_ID);
    for (const id of hostIdsIn(body || '')) registerHost(id);
    out.headers.Authorization = `Bearer ${HOST_TOKEN}`;
  } else if (options.method === 'DELETE' && path.startsWith('/hosts/')) {
    registerHost(decodeURIComponent(path.slice('/hosts/'.length)));
    out.headers.Authorization = `Bearer ${HOST_TOKEN}`;
  } else if (options.method === 'POST' && path === '/match') {
    registerUser();
    out.headers.Authorization = `Bearer ${USER_TOKEN}`;
  }
  return out;
}

module.exports = { withAuth, HOST_TOKEN, USER_ID, USER_TOKEN };
