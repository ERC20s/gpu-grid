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
  // Seed a host so counts are non-zero
  const host = {id: 'h-metrics', model: 'A100', vram_mb: 40960, timestamp: Date.now()};
  const post = await request({method: 'POST', port, path: '/hosts', headers: {'Content-Type': 'application/json'}}, JSON.stringify(host));
  assert(post.statusCode === 200, 'POST /hosts should succeed');

  // Fetch metrics and record the initial POST /match counter
  const res1 = await request({method: 'GET', port, path: '/metrics'});
  assert(res1.statusCode === 200, 'GET /metrics should return 200');
  assert(res1.headers['content-type'] && res1.headers['content-type'].includes('text/plain'), 'Content-Type is text/plain');
  const body1 = res1.body;

  // Ensure the named metrics exist
  const want = ['gpu_grid_live_host_count', 'gpu_grid_registered_host_count', 'gpu_grid_uptime_ms', 'gpu_grid_host_ttl_seconds', 'gpu_grid_posts_hosts_total', 'gpu_grid_posts_match_total'];
  for (const w of want) {
    assert(body1.includes(w), `metrics body should include ${w}`);
  }

  const before = parseMetric(body1, 'gpu_grid_posts_match_total');
  assert(Number.isFinite(before), 'gpu_grid_posts_match_total should be a number');

  // POST a minimal valid match payload
  const matchBody = JSON.stringify({job: {required_min_vram_mb: 1}});
  const matchRes = await request({method: 'POST', port, path: '/match', headers: {'Content-Type': 'application/json'}}, matchBody);
  assert(matchRes.statusCode === 200, 'POST /match should return 200 for a valid job');

  // Re-fetch metrics and ensure the counter increased
  const res2 = await request({method: 'GET', port, path: '/metrics'});
  assert(res2.statusCode === 200, 'GET /metrics should return 200');
  const after = parseMetric(res2.body, 'gpu_grid_posts_match_total');
  assert(Number.isFinite(after), 'gpu_grid_posts_match_total should be a number after POST');
  assert(after > before, `gpu_grid_posts_match_total should increase after POST /match (before=${before}, after=${after})`);
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
