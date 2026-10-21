// Bearer-token authentication for the scheduler's mutating endpoints.
//
// Two token tables, both read from the environment as a JSON object of
// {"<id>": "<token>"} (values live on the server, never in the repo):
//
//   HOST_TOKENS  host id -> token. A host agent's token authorises writes
//                for that host id only (POST /hosts, DELETE /hosts/:id).
//   USER_TOKENS  user id -> token. Authorises job submission (POST /match);
//                the user id is the identity the submission rate limit uses.
//
// A missing or empty table means nobody can write: the scheduler fails closed.
const crypto = require('crypto');

const MIN_TOKEN_LENGTH = 16;
const MAX_ID_LENGTH = 256;

function digest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

// Parse one table. Returns {table: Map<id, sha256 digest>, error}. On any
// error the table is empty, so a malformed setting rejects every write
// instead of letting some through. uniqueTokens: refuse two ids sharing a
// token (a user token must name exactly one identity).
function parseTokenTable(raw, name, uniqueTokens) {
  const table = new Map();
  if (raw === undefined || raw.trim() === '') return {table, error: null};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {table, error: `${name} is not valid JSON`};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {table, error: `${name} must be a JSON object of {"<id>": "<token>"}`};
  }
  const seen = new Set();
  for (const [id, token] of Object.entries(parsed)) {
    if (id.length === 0 || id.length > MAX_ID_LENGTH) {
      return {table: new Map(), error: `${name}: ids must be 1-${MAX_ID_LENGTH} characters`};
    }
    if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) {
      return {table: new Map(), error: `${name}: token for "${id}" must be a string of at least ${MIN_TOKEN_LENGTH} non-space characters`};
    }
    if (uniqueTokens && seen.has(token)) {
      return {table: new Map(), error: `${name}: two ids share one token`};
    }
    seen.add(token);
    table.set(id, digest(token));
  }
  return {table, error: null};
}

// Parsed tables are cached against the raw setting, so the env var is still
// read per request (like the scheduler's other settings) but only re-parsed
// when it changes.
const cache = new Map();
function loadTable(name, uniqueTokens) {
  const raw = process.env[name];
  const hit = cache.get(name);
  if (hit && hit.raw === raw) return hit.result;
  const result = parseTokenTable(raw, name, uniqueTokens);
  cache.set(name, {raw, result});
  return result;
}

function hostTokens() {
  return loadTable('HOST_TOKENS', false);
}

function userTokens() {
  return loadTable('USER_TOKENS', true);
}

// The token from an "Authorization: Bearer <token>" header, or null.
function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer +(\S+) *$/i.exec(header);
  return m ? m[1] : null;
}

// Every id whose token equals the presented one. Compares digests in
// constant time against every entry, never stopping early, so response
// timing does not reveal how much of a token was right or which id it is.
function idsForToken(table, token) {
  const presented = digest(token);
  const ids = [];
  for (const [id, expected] of table) {
    if (crypto.timingSafeEqual(presented, expected)) ids.push(id);
  }
  return ids;
}

// Host ids the request's token may write, or null when the request carries
// no token or one that belongs to no host.
function authenticateHost(req) {
  const token = bearerToken(req);
  if (token === null) return null;
  const ids = idsForToken(hostTokens().table, token);
  return ids.length > 0 ? new Set(ids) : null;
}

// The user id the request's token belongs to, or null.
function authenticateUser(req) {
  const token = bearerToken(req);
  if (token === null) return null;
  const ids = idsForToken(userTokens().table, token);
  return ids.length === 1 ? ids[0] : null;
}

module.exports = {
  MIN_TOKEN_LENGTH,
  parseTokenTable,
  hostTokens,
  userTokens,
  bearerToken,
  authenticateHost,
  authenticateUser
};
