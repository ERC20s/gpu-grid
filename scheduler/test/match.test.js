// POST /match payload validation.
//
// The matcher downgrades anything it does not recognise, so a wrongly shaped
// filter used to mean "match everything". These tests pin the 400 invalid_job
// answers, and confirm a well-formed job still ranks the live registry.
const http = require('http');
const assert = require('assert');
const server = require('../index');

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({statusCode: res.statusCode, body: data}));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function postMatch(port, body) {
  return request({method: 'POST', port, path: '/match'}, body);
}

async function expectInvalidJob(port, body, what) {
  const res = await postMatch(port, typeof body === 'string' ? body : JSON.stringify(body));
  assert(res.statusCode === 400, `${what} should return 400, got ${res.statusCode}`);
  const payload = JSON.parse(res.body);
  assert(payload.error === 'invalid_job', `${what} should report invalid_job, got ${payload.error}`);
  assert(typeof payload.message === 'string' && payload.message.length > 0, `${what} should carry a message`);
}

async function runTests() {
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await seedRegistry(port);
  await testValidJobStillMatches(port);
  await testRejectsMissingJobWrapper(port);
  await testRejectsEmptyBody(port);
  await testRejectsNonObjectPayload(port);
  await testRejectsBadJobShape(port);
  await testRejectsBadFilterTypes(port);
  await testRejectsBadHostsArray(port);
  await testUnknownJobFieldsIgnored(port);
  await testUnreportedUtilRanksLastOverHttp(port);
  await testMaxUtilPctDropsUnreportedHostOverHttp(port);

  server.close();
  console.log('Match validation tests passed');
}

async function seedRegistry(port) {
  const hosts = [
    {id: 'm-idle', model: 'A100', vram_mb: 40960, gpu_util_pct: 5, free_memory_mb: 30000, timestamp: 1620000000},
    {id: 'm-busy', model: 'A100', vram_mb: 40960, gpu_util_pct: 90, free_memory_mb: 1000, timestamp: 1620000000},
    {id: 'm-small', model: 'RTX4090', vram_mb: 24576, gpu_util_pct: 1, free_memory_mb: 20000, timestamp: 1620000000}
  ];
  const res = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(hosts));
  assert(res.statusCode === 200, 'seeding the registry should return 200');
}

async function testValidJobStillMatches(port) {
  const job = {required_min_vram_mb: 40960, acceptable_gpu_models: ['A100'], max_util_pct: 50};
  const res = await postMatch(port, JSON.stringify({job}));
  assert(res.statusCode === 200, 'a valid job should return 200');
  const payload = JSON.parse(res.body);
  assert(Array.isArray(payload.matches), 'matches array returned');
  assert(payload.matches.length === 1, 'only the idle A100 passes the filters');
  assert(payload.matches[0].id === 'm-idle', 'best host first');
}

async function testRejectsMissingJobWrapper(port) {
  // The exact mistake the gridctl docstring warns about: the job spec posted
  // bare, without the {"job": ...} wrapper. It used to return the whole
  // registry as if every host matched.
  await expectInvalidJob(port, {required_min_vram_mb: 40960}, 'an unwrapped job spec');
}

async function testRejectsEmptyBody(port) {
  await expectInvalidJob(port, '', 'an empty body');
  await expectInvalidJob(port, {}, 'a payload with no job');
}

async function testRejectsNonObjectPayload(port) {
  await expectInvalidJob(port, '[]', 'an array payload');
  await expectInvalidJob(port, '"job"', 'a string payload');
  await expectInvalidJob(port, 'null', 'a null payload');
}

async function testRejectsBadJobShape(port) {
  await expectInvalidJob(port, {job: null}, 'a null job');
  await expectInvalidJob(port, {job: 'A100'}, 'a string job');
  await expectInvalidJob(port, {job: []}, 'an array job');
}

async function testRejectsBadFilterTypes(port) {
  await expectInvalidJob(port, {job: {max_util_pct: '10'}}, 'max_util_pct as a string');
  await expectInvalidJob(port, {job: {max_util_pct: 150}}, 'max_util_pct out of range');
  await expectInvalidJob(port, {job: {max_util_pct: -1}}, 'a negative max_util_pct');
  await expectInvalidJob(port, {job: {required_min_vram_mb: '8192'}}, 'required_min_vram_mb as a string');
  await expectInvalidJob(port, {job: {required_min_vram_mb: -5}}, 'a negative required_min_vram_mb');
  await expectInvalidJob(port, {job: {acceptable_gpu_models: 'A100'}}, 'acceptable_gpu_models as a bare string');
  await expectInvalidJob(port, {job: {acceptable_gpu_models: ['A100', 7]}}, 'a non-string model entry');
  await expectInvalidJob(port, {job: {acceptable_gpu_models: ['']}}, 'an empty model name');
}

async function testRejectsBadHostsArray(port) {
  await expectInvalidJob(port, {job: {}, hosts: 'host-1'}, 'hosts that is not an array');
  await expectInvalidJob(port, {job: {}, hosts: [null]}, 'a null host entry');
  await expectInvalidJob(
    port,
    {job: {}, hosts: [{id: 'ok', model: 'A100', vram_mb: 40960, timestamp: 1620000000}, {id: 'bad', model: 'A100', vram_mb: 'lots', timestamp: 1620000000}]},
    'a host entry with a non-numeric vram_mb'
  );

  // A well-formed hosts array is still matched instead of the registry.
  const body = {
    job: {required_min_vram_mb: 1000},
    hosts: [{id: 'explicit', model: 'A100', vram_mb: 40960, gpu_util_pct: 3, free_memory_mb: 100, timestamp: 1620000000}]
  };
  const res = await postMatch(port, JSON.stringify(body));
  assert(res.statusCode === 200, 'a valid explicit hosts array should return 200');
  const payload = JSON.parse(res.body);
  assert(payload.matches.length === 1 && payload.matches[0].id === 'explicit', 'explicit hosts are matched, not the registry');
}

// New tests for required_min_free_memory_mb behaviour
async function testRejectsBadRequiredMinFreeMemory(port) {
  await expectInvalidJob(port, {job: {required_min_free_memory_mb: '1024'}}, 'required_min_free_memory_mb as a string');
  await expectInvalidJob(port, {job: {required_min_free_memory_mb: -1}}, 'a negative required_min_free_memory_mb');
}

async function testFreeMemoryFilterWithExplicitHosts(port) {
  const body = {
    job: {required_min_vram_mb: 1000, required_min_free_memory_mb: 1024},
    hosts: [
      {id: 'h1', model: 'A100', vram_mb: 40960, gpu_util_pct: 3, free_memory_mb: 2000, timestamp: 1620000000},
      {id: 'h2', model: 'A100', vram_mb: 40960, gpu_util_pct: 3, free_memory_mb: 512, timestamp: 1620000000},
      {id: 'h3', model: 'A100', vram_mb: 40960, gpu_util_pct: 3, timestamp: 1620000000}
    ]
  };
  const res = await postMatch(port, JSON.stringify(body));
  assert(res.statusCode === 200, 'explicit hosts path should return 200');
  const ids = JSON.parse(res.body).matches.map(h => h.id);
  assert.deepStrictEqual(ids, ['h1'], 'only hosts that reported enough free_memory_mb are returned');
}

async function testUnknownJobFieldsIgnored(port) {
  // Fields the matcher does not read (as in tests/fixtures/simple_job.json)
  // must not make a job invalid.
  const job = {image: 'nvidia/cuda:12', cmd: ['python', 'train.py'], resources: {gpus: 1}, required_min_vram_mb: 1000};
  const res = await postMatch(port, JSON.stringify({job}));
  assert(res.statusCode === 200, 'unknown job fields should be ignored, not rejected');
  const payload = JSON.parse(res.body);
  assert(Array.isArray(payload.matches) && payload.matches.length === 3, 'all seeded hosts clear a 1000MB floor');
}

// gpu_util_pct is optional at POST /hosts, so a host agent can report without
// it. End to end, such a host must not come back first, and must not clear a
// utilisation cap it never proved it meets.
const SILENT_MIX = [
  {id: 'u-silent', model: 'A100', vram_mb: 40960, free_memory_mb: 40000, timestamp: 1620000000},
  {id: 'u-busy', model: 'A100', vram_mb: 40960, gpu_util_pct: 92, free_memory_mb: 1000, timestamp: 1620000000},
  {id: 'u-idle', model: 'A100', vram_mb: 40960, gpu_util_pct: 7, free_memory_mb: 20000, timestamp: 1620000000}
];

async function testUnreportedUtilRanksLastOverHttp(port) {
  const res = await postMatch(port, JSON.stringify({job: {required_min_vram_mb: 1000}, hosts: SILENT_MIX}));
  assert(res.statusCode === 200, 'a host without gpu_util_pct is still a valid host report');
  const ids = JSON.parse(res.body).matches.map(h => h.id);
  assert.deepStrictEqual(ids, ['u-idle', 'u-busy', 'u-silent'], 'not reporting utilisation cannot buy the top slot');
}

async function testMaxUtilPctDropsUnreportedHostOverHttp(port) {
  const res = await postMatch(port, JSON.stringify({job: {required_min_vram_mb: 1000, max_util_pct: 10}, hosts: SILENT_MIX}));
  assert(res.statusCode === 200, 'a capped job is still a valid job');
  const ids = JSON.parse(res.body).matches.map(h => h.id);
  assert.deepStrictEqual(ids, ['u-idle'], 'max_util_pct: 10 returns only hosts that actually reported low load');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
