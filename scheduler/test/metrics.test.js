const http = require('http');
const assert = require('assert');
const server = require('../index');

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

function parseMetric(body, name) {
  const re = new RegExp('^' + name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + "\\s+([0-9]+(?:\\.[0-9]+)?)", 'm');
  const m = re.exec(body || '');
  if (!m) return NaN;
  return Number(m[1]);
}

async function runTests() {
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await testMetricsBasic(port);

  server.close();
  console.log('Metrics tests passed');
}

async function testMetricsBasic(port) {
  // Fetch metrics first and record initial counters
  const initial = await request({method: 'GET', port, path: '/metrics'});
  assert(initial.statusCode === 200, 'GET /metrics should return 200');
  assert(initial.headers['content-type'] && initial.headers['content-type'].includes('text/plain'), 'Content-Type is text/plain');
  const bodyInitial = initial.body;

  // Ensure the named metrics exist
  const want = ['gpu_grid_live_host_count', 'gpu_grid_registered_host_count', 'gpu_grid_uptime_ms', 'gpu_grid_host_ttl_seconds', 'gpu_grid_posts_hosts_total', 'gpu_grid_posts_match_total'];
  for (const w of want) {
    assert(bodyInitial.includes(w), `metrics body should include ${w}`);
  }

  const hostsBefore = parseMetric(bodyInitial, 'gpu_grid_posts_hosts_total');
  const matchBefore = parseMetric(bodyInitial, 'gpu_grid_posts_match_total');
  assert(Number.isFinite(hostsBefore), 'gpu_grid_posts_hosts_total should be a number');
  assert(Number.isFinite(matchBefore), 'gpu_grid_posts_match_total should be a number');

  // POST a host and assert the hosts counter increases
  const host = {id: 'h-metrics', model: 'A100', vram_mb: 40960, timestamp: Date.now()};
  const post = await request({method: 'POST', port, path: '/hosts', headers: {'Content-Type': 'application/json'}}, JSON.stringify(host));
  assert(post.statusCode === 200, 'POST /hosts should succeed');

  const resAfterHost = await request({method: 'GET', port, path: '/metrics'});
  assert(resAfterHost.statusCode === 200, 'GET /metrics should return 200');
  const hostsAfter = parseMetric(resAfterHost.body, 'gpu_grid_posts_hosts_total');
  assert(Number.isFinite(hostsAfter), 'gpu_grid_posts_hosts_total should be a number after POST');
  assert(hostsAfter > hostsBefore, `gpu_grid_posts_hosts_total should increase after POST /hosts (before=${hostsBefore}, after=${hostsAfter})`);

  // POST a minimal valid match payload and assert the match counter increases
  const matchBody = JSON.stringify({job: {required_min_vram_mb: 1}});
  const matchRes = await request({method: 'POST', port, path: '/match', headers: {'Content-Type': 'application/json'}}, matchBody);
  assert(matchRes.statusCode === 200, 'POST /match should return 200 for a valid job');

  const resAfterMatch = await request({method: 'GET', port, path: '/metrics'});
  assert(resAfterMatch.statusCode === 200, 'GET /metrics should return 200');
  const matchAfter = parseMetric(resAfterMatch.body, 'gpu_grid_posts_match_total');
  assert(Number.isFinite(matchAfter), 'gpu_grid_posts_match_total should be a number after POST');
  assert(matchAfter > matchBefore, `gpu_grid_posts_match_total should increase after POST /match (before=${matchBefore}, after=${matchAfter})`);
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
