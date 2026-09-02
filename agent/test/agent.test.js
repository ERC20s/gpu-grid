const assert = require('assert');
const { parseCsv } = require('../lib/nvidia');
const http = require('http');
const { aggregateGPUs } = require('../index');

// Test parseCsv with a sample fixture.
(function testParseCsv() {
  const sample = '0, A100, 40960, 20000, 10\n1, A100, 40960, 15000, 20\n';
  const parsed = parseCsv(sample);
  assert(Array.isArray(parsed));
  assert(parsed.length === 2);
  assert(parsed[0].name === 'A100');
  console.log('parseCsv OK');
})();

// Test aggregation logic.
(function testAggregate() {
  const gpus = [ { name: 'A100', memory_total_mb: 40960, memory_free_mb: 20000, util_pct: 10 }, { name: 'A100', memory_total_mb: 40960, memory_free_mb: 15000, util_pct: 20 } ];
  const host = aggregateGPUs(gpus);
  assert(host.vram_mb === 81920);
  assert(host.free_memory_mb === 35000);
  assert(host.gpu_util_pct === 15);
  console.log('aggregateGPUs OK');
})();

// Test the agent posts to a server — ensure it doesn't throw when server errors.
(async function testPostFlow() {
  const posted = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { posted.push(JSON.parse(body)); } catch (e) {}
      res.writeHead(500); res.end('ohno');
    });
  }).listen(0, '127.0.0.1');
  const port = srv.address().port;
  process.env.SCHEDULER_URL = 'http://127.0.0.1:' + port;
  process.env.AGENT_REPORT_SECONDS = '1';
  try {
    await require('../index').sampleOnce();
    // if we got here, the agent handled a server 500 without throwing
    console.log('post flow OK');
  } catch (e) {
    console.error('post flow failed', e);
    process.exit(1);
  } finally {
    srv.close();
  }
})();
