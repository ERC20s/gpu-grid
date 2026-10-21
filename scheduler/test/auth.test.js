// Authentication on the mutating endpoints: a per-host token for POST /hosts
// and DELETE /hosts/:id, a user token for POST /match. Unauthenticated writes
// are rejected and change nothing.
const http = require('http');
const assert = require('assert');
const server = require('../index');
const { parseTokenTable } = require('../lib/auth');

const TOKEN_A = 'host-a-token-0123456789';
const TOKEN_B = 'host-b-token-0123456789';
const USER_TOKEN = 'user-alice-token-0123456789';

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({statusCode: res.statusCode, headers: res.headers, body: data}));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function bearer(token) {
  return {Authorization: `Bearer ${token}`};
}

function report(id) {
  return {id, model: 'A100', vram_mb: 40960, gpu_util_pct: 5, free_memory_mb: 30000, timestamp: 1620000000};
}

function postHosts(port, body, headers) {
  return request({method: 'POST', port, path: '/hosts', headers}, JSON.stringify(body));
}

async function registeredIds(port) {
  const res = await request({method: 'GET', port, path: '/hosts'});
  return JSON.parse(res.body).hosts.map(h => h.id).sort();
}

function setTokens() {
  process.env.HOST_TOKENS = JSON.stringify({'host-a': TOKEN_A, 'host-b': TOKEN_B});
  process.env.USER_TOKENS = JSON.stringify({alice: USER_TOKEN});
}

async function runTests() {
  setTokens();
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await testHostReportWithoutTokenRejected(port);
  await testHostReportWithUnknownTokenRejected(port);
  await testNonBearerSchemeRejected(port);
  await testHostCannotReportForAnotherHost(port);
  await testHostReportsForItself(port);
  await testBatchWithForeignHostRejectedAtomically(port);
  await testDeleteNeedsTheHostsOwnToken(port);
  await testMatchNeedsUserToken(port);
  await testUserTokenCannotReportHosts(port);
  await testUnauthenticatedLargeBodyGets401(port);
  await testNoTokensConfiguredRejectsAllWrites(port);
  await testMalformedTokensRejectAllWrites(port);
  testParseTokenTable();

  server.close();
  console.log('Auth tests passed');
}

async function testHostReportWithoutTokenRejected(port) {
  const res = await postHosts(port, report('host-a'));
  assert.strictEqual(res.statusCode, 401, 'POST /hosts without a token is 401');
  assert.strictEqual(JSON.parse(res.body).error, 'unauthorized');
  assert.strictEqual(res.headers['www-authenticate'], 'Bearer', '401 names the Bearer scheme');
  assert.deepStrictEqual(await registeredIds(port), [], 'nothing was stored');
}

async function testHostReportWithUnknownTokenRejected(port) {
  const res = await postHosts(port, report('host-a'), bearer('not-a-configured-token'));
  assert.strictEqual(res.statusCode, 401, 'an unknown token is 401');
  assert.deepStrictEqual(await registeredIds(port), [], 'nothing was stored');
}

async function testNonBearerSchemeRejected(port) {
  const res = await postHosts(port, report('host-a'), {Authorization: `Basic ${TOKEN_A}`});
  assert.strictEqual(res.statusCode, 401, 'the right token under another scheme is 401');
}

async function testHostCannotReportForAnotherHost(port) {
  const res = await postHosts(port, report('host-b'), bearer(TOKEN_A));
  assert.strictEqual(res.statusCode, 403, "host-a's token cannot write host-b");
  assert.strictEqual(JSON.parse(res.body).error, 'forbidden');
  assert.deepStrictEqual(await registeredIds(port), [], 'host-b was not stored');
}

async function testHostReportsForItself(port) {
  const res = await postHosts(port, report('host-a'), bearer(TOKEN_A));
  assert.strictEqual(res.statusCode, 200, 'host-a may report itself');
  assert.deepStrictEqual(await registeredIds(port), ['host-a']);
}

async function testBatchWithForeignHostRejectedAtomically(port) {
  const res = await postHosts(port, [report('host-b'), report('host-a')], bearer(TOKEN_B));
  assert.strictEqual(res.statusCode, 403, 'a batch holding another host is 403');
  assert(JSON.parse(res.body).message.indexOf('hosts[1]') !== -1, 'the message names the offending entry');
  assert.deepStrictEqual(await registeredIds(port), ['host-a'], 'host-b from the rejected batch was not stored either');
}

async function testDeleteNeedsTheHostsOwnToken(port) {
  let res = await request({method: 'DELETE', port, path: '/hosts/host-a'});
  assert.strictEqual(res.statusCode, 401, 'DELETE without a token is 401');
  res = await request({method: 'DELETE', port, path: '/hosts/host-a', headers: bearer(TOKEN_B)});
  assert.strictEqual(res.statusCode, 403, "host-b's token cannot delete host-a");
  assert.deepStrictEqual(await registeredIds(port), ['host-a'], 'host-a is still registered');
  res = await request({method: 'DELETE', port, path: '/hosts/host-a', headers: bearer(TOKEN_A)});
  assert.strictEqual(res.statusCode, 200, 'host-a may delete itself');
  assert.deepStrictEqual(await registeredIds(port), []);
}

async function testMatchNeedsUserToken(port) {
  await postHosts(port, report('host-a'), bearer(TOKEN_A));
  const body = JSON.stringify({job: {required_min_vram_mb: 1}});
  let res = await request({method: 'POST', port, path: '/match'}, body);
  assert.strictEqual(res.statusCode, 401, 'POST /match without a token is 401');
  res = await request({method: 'POST', port, path: '/match', headers: bearer(TOKEN_A)}, body);
  assert.strictEqual(res.statusCode, 401, 'a host token does not authorise job submission');
  res = await request({method: 'POST', port, path: '/match', headers: bearer(USER_TOKEN)}, body);
  assert.strictEqual(res.statusCode, 200, 'a user token does');
  assert.deepStrictEqual(JSON.parse(res.body).matches.map(h => h.id), ['host-a']);
}

async function testUserTokenCannotReportHosts(port) {
  const res = await postHosts(port, report('alice'), bearer(USER_TOKEN));
  assert.strictEqual(res.statusCode, 401, 'a user token does not authorise host reports');
}

async function testUnauthenticatedLargeBodyGets401(port) {
  // A body that does not fit in one write still gets the 401, not a reset.
  const big = JSON.stringify({id: 'host-a', model: 'x'.repeat(200000)});
  const res = await request({method: 'POST', port, path: '/hosts'}, big);
  assert.strictEqual(res.statusCode, 401);
}

async function testNoTokensConfiguredRejectsAllWrites(port) {
  delete process.env.HOST_TOKENS;
  delete process.env.USER_TOKENS;
  let res = await postHosts(port, report('host-a'), bearer(TOKEN_A));
  assert.strictEqual(res.statusCode, 401, 'with HOST_TOKENS unset no host can write');
  res = await request({method: 'POST', port, path: '/match', headers: bearer(USER_TOKEN)}, JSON.stringify({job: {}}));
  assert.strictEqual(res.statusCode, 401, 'with USER_TOKENS unset nobody can submit');
  setTokens();
}

async function testMalformedTokensRejectAllWrites(port) {
  // host-b's token is too short, so the whole table is refused - including
  // host-a's entry, which on its own would be fine.
  process.env.HOST_TOKENS = JSON.stringify({'host-a': TOKEN_A, 'host-b': 'short'});
  const res = await postHosts(port, report('host-a'), bearer(TOKEN_A));
  assert.strictEqual(res.statusCode, 401, 'a malformed HOST_TOKENS fails closed');
  setTokens();
}

function testParseTokenTable() {
  const ok = parseTokenTable(JSON.stringify({a: TOKEN_A, b: TOKEN_B}), 'HOST_TOKENS', true);
  assert.strictEqual(ok.error, null);
  assert.strictEqual(ok.table.size, 2);

  const cases = [
    ['not json', 'not valid JSON'],
    ['["a"]', 'must be a JSON object'],
    [JSON.stringify({a: 'short'}), 'at least 16'],
    [JSON.stringify({a: 'has a space in it 0123'}), 'non-space'],
    [JSON.stringify({a: 12345678901234567890}), 'must be a string'],
    [JSON.stringify({a: TOKEN_A, b: TOKEN_A}), 'share one token']
  ];
  for (const [raw, expected] of cases) {
    const result = parseTokenTable(raw, 'USER_TOKENS', true);
    assert(result.error && result.error.indexOf(expected) !== -1, `${raw} should fail with "${expected}", got ${result.error}`);
    assert.strictEqual(result.table.size, 0, `${raw} leaves no usable tokens`);
  }

  // Host tables may share a token (one agent reporting several GPUs).
  const shared = parseTokenTable(JSON.stringify({a: TOKEN_A, b: TOKEN_A}), 'HOST_TOKENS', false);
  assert.strictEqual(shared.error, null);
  assert.strictEqual(shared.table.size, 2);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
