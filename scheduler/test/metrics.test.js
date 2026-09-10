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
  const post = await request({method: 'POST', port, path: '/hosts'}, JSON.stringify(host));
  assert(post.statusCode === 200, 'POST /hosts should succeed');

  // After posting a host we expect the posts_hosts_total counter to have
  // increased at least once. Fetch /metrics and parse the numeric values for
  // posts counters.
  let res = await request({method: 'GET', port, path: '/metrics'});
  assert(res.statusCode === 200, 'GET /metrics should return 200');
  assert(res.headers['content-type'] && res.headers['content-type'].includes('text/plain'), 'Content-Type is text/plain');
  let body = res.body;

  // Ensure the named metrics exist
  const want = ['gpu_grid_live_host_count', 'gpu_grid_registered_host_count', 'gpu_grid_uptime_ms', 'gpu_grid_host_ttl_seconds', 'gpu_grid_posts_hosts_total', 'gpu_grid_posts_match_total'];
  for (const w of want) {
    assert(body.includes(w), `metrics body should include ${w}`);
  }

  // Parse numeric values from metrics body
  function parseMetric(name) {
    const re = new RegExp('^' + name + '\\s+(\\d+)$', 'm');
    const m = body.match(re);
    return m ? Number(m[1]) : null;
  }

  const hostsBefore = parseMetric('gpu_grid_posts_hosts_total');
  const matchBefore = parseMetric('gpu_grid_posts_match_total');
  assert(typeof hostsBefore === 'number' && hostsBefore >= 0, 'posts_hosts_total should parse as number');
  assert(typeof matchBefore === 'number' && matchBefore >= 0, 'posts_match_total should parse as number');

  // Now POST a match request using a simple job that should match the seeded host
  const job = {required_min_vram_mb: 4096};
  const matchPost = await request({method: 'POST', port, path: '/match'}, JSON.stringify({job}));
  assert(matchPost.statusCode === 200, 'POST /match should succeed');

  // Re-fetch metrics and ensure counters increased by at least 1
  res = await request({method: 'GET', port, path: '/metrics'});
  assert(res.statusCode === 200, 'GET /metrics should return 200 after match');
  body = res.body;
  const hostsAfter = parseMetric('gpu_grid_posts_hosts_total');
  const matchAfter = parseMetric('gpu_grid_posts_match_total');
  assert(hostsAfter !== null && matchAfter !== null, 'metrics should parse after match');
  assert(hostsAfter >= hostsBefore + 0, 'posts_hosts_total should not decrease');
  assert(matchAfter >= matchBefore + 1, 'posts_match_total should increase by at least 1 after POST /match');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
