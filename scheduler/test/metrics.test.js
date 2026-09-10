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

  const res = await request({method: 'GET', port, path: '/metrics'});
  assert(res.statusCode === 200, 'GET /metrics should return 200');
  assert(res.headers['content-type'] && res.headers['content-type'].includes('text/plain'), 'Content-Type is text/plain');
  const body = res.body;
  // Ensure the named metrics exist
  const want = ['gpu_grid_live_host_count', 'gpu_grid_registered_host_count', 'gpu_grid_uptime_ms', 'gpu_grid_host_ttl_seconds', 'gpu_grid_posts_hosts_total', 'gpu_grid_posts_match_total'];
  for (const w of want) {
    assert(body.includes(w), `metrics body should include ${w}`);
  }
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
