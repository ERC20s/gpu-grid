// Submission rate limit: bounded, TTL-evicting, keyed by the authenticated
// user - never by x-forwarded-for.
const http = require('http');
const assert = require('assert');
const server = require('../index');
const { RateLimiter } = require('../lib/ratelimit');

function fakeClock(start = 0) {
  const clock = {t: start, now: () => clock.t};
  return clock;
}

// --- unit: RateLimiter -------------------------------------------------------

function testAllowsUpToLimitThenDenies() {
  const clock = fakeClock(1000);
  const rl = new RateLimiter({now: clock.now});
  const cfg = {limit: 3, windowMs: 10000, maxKeys: 10};
  assert.deepStrictEqual([1, 2, 3].map(() => rl.hit('u', cfg).allowed), [true, true, true]);
  clock.t = 4000;
  const denied = rl.hit('u', cfg);
  assert.strictEqual(denied.allowed, false, 'the 4th hit in the window is denied');
  assert.strictEqual(denied.retryAfterMs, 7000, 'retry once the window that started at t=1000 ends');
}

function testWindowExpiryResetsCount() {
  const clock = fakeClock(0);
  const rl = new RateLimiter({now: clock.now});
  const cfg = {limit: 1, windowMs: 1000, maxKeys: 10};
  assert.strictEqual(rl.hit('u', cfg).allowed, true);
  assert.strictEqual(rl.hit('u', cfg).allowed, false);
  clock.t = 999;
  assert.strictEqual(rl.hit('u', cfg).allowed, false, 'still inside the window');
  clock.t = 1000;
  assert.strictEqual(rl.hit('u', cfg).allowed, true, 'a new window starts once the old one ends');
}

function testKeysAreIndependent() {
  const rl = new RateLimiter({now: () => 0});
  const cfg = {limit: 1, windowMs: 1000, maxKeys: 10};
  assert.strictEqual(rl.hit('alice', cfg).allowed, true);
  assert.strictEqual(rl.hit('alice', cfg).allowed, false);
  assert.strictEqual(rl.hit('bob', cfg).allowed, true, "alice's limit does not touch bob");
}

function testSizeNeverExceedsMaxKeys() {
  const clock = fakeClock(0);
  const rl = new RateLimiter({now: clock.now});
  const cfg = {limit: 5, windowMs: 60000, maxKeys: 3};
  for (let i = 0; i < 50; i++) {
    clock.t = i;
    rl.hit(`user-${i}`, cfg);
    assert(rl.size <= 3, `size ${rl.size} exceeded maxKeys after ${i + 1} keys`);
  }
  assert.strictEqual(rl.size, 3, 'the map is full, not empty');
  assert.deepStrictEqual(Array.from(rl.entries.keys()), ['user-47', 'user-48', 'user-49'],
    'with every window live, the oldest windows are the ones dropped');
}

function testExpiredEntriesAreEvictedBeforeLiveOnes() {
  const clock = fakeClock(0);
  const rl = new RateLimiter({now: clock.now});
  rl.hit('long', {limit: 5, windowMs: 10000, maxKeys: 2});   // live until 10000
  clock.t = 10;
  rl.hit('short', {limit: 5, windowMs: 100, maxKeys: 2});    // expires at 110
  clock.t = 200;
  rl.hit('new', {limit: 5, windowMs: 10000, maxKeys: 2});
  assert.deepStrictEqual(Array.from(rl.entries.keys()).sort(), ['long', 'new'],
    'the expired entry made room; the older but live one stayed');
}

function testSweepEvictsExpired() {
  const clock = fakeClock(0);
  const rl = new RateLimiter({now: clock.now});
  const cfg = {limit: 5, windowMs: 1000, maxKeys: 100};
  for (let i = 0; i < 10; i++) rl.hit(`user-${i}`, cfg);
  clock.t = 500;
  rl.hit('late', cfg);
  rl.sweep(999);
  assert.strictEqual(rl.size, 11, 'nothing has expired at t=999');
  rl.sweep(1000);
  assert.deepStrictEqual(Array.from(rl.entries.keys()), ['late'], 'idle users are evicted once their window ends');
}

// --- HTTP: POST /match -------------------------------------------------------

const ALICE = 'alice-token-0123456789';
const BOB = 'bob-token-0123456789';

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

function submit(port, token, extraHeaders = {}) {
  const headers = Object.assign({Authorization: `Bearer ${token}`}, extraHeaders);
  return request({method: 'POST', port, path: '/match', headers}, JSON.stringify({job: {}}));
}

async function testHttpLimitIsPerAuthenticatedUser(port) {
  process.env.USER_TOKENS = JSON.stringify({alice: ALICE, bob: BOB});
  process.env.SUBMIT_RATE_LIMIT = '2';
  process.env.SUBMIT_RATE_WINDOW_SECONDS = '60';

  assert.strictEqual((await submit(port, ALICE, {'X-Forwarded-For': '10.0.0.1'})).statusCode, 200);
  assert.strictEqual((await submit(port, ALICE, {'X-Forwarded-For': '10.0.0.2'})).statusCode, 200);

  const limited = await submit(port, ALICE, {'X-Forwarded-For': '10.0.0.3'});
  assert.strictEqual(limited.statusCode, 429, "alice's 3rd submission is limited, whatever x-forwarded-for says");
  assert.strictEqual(JSON.parse(limited.body).error, 'rate_limited');
  const retryAfter = Number(limited.headers['retry-after']);
  assert(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${limited.headers['retry-after']} is within the window`);

  assert.strictEqual((await submit(port, ALICE)).statusCode, 429, 'and without the header too');
  assert.strictEqual((await submit(port, BOB, {'X-Forwarded-For': '10.0.0.1'})).statusCode, 200,
    "bob, from alice's claimed address, has a separate budget");
  assert.strictEqual(server.submissionLimiter.size, 2, 'one entry per authenticated user, none per header value');
}

async function testUnauthenticatedRequestsDoNotSpendABudget(port) {
  process.env.USER_TOKENS = JSON.stringify({carol: 'carol-token-0123456789'});
  process.env.SUBMIT_RATE_LIMIT = '1';
  const before = server.submissionLimiter.size;
  for (let i = 0; i < 5; i++) {
    const res = await request({method: 'POST', port, path: '/match'}, JSON.stringify({job: {}}));
    assert.strictEqual(res.statusCode, 401);
  }
  assert.strictEqual(server.submissionLimiter.size, before, 'a 401 never creates a limiter entry');
  assert.strictEqual((await submit(port, 'carol-token-0123456789')).statusCode, 200, "carol's one submission is still available");
}

async function runTests() {
  testAllowsUpToLimitThenDenies();
  testWindowExpiryResetsCount();
  testKeysAreIndependent();
  testSizeNeverExceedsMaxKeys();
  testExpiredEntriesAreEvictedBeforeLiveOnes();
  testSweepEvictsExpired();

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  await testHttpLimitIsPerAuthenticatedUser(port);
  await testUnauthenticatedRequestsDoNotSpendABudget(port);
  server.close();
  console.log('Rate limit tests passed');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
