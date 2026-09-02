const http = require('http');
const assert = require('assert');
const { parseNvidiaCsv, runNvidiaSmi } = require('../lib/nvidia');
const agent = require('../index');

// small CSV fixture matching the expected columns: index,name,memory.total,memory.free,utilization.gpu
const FIXTURE = "0, A100, 40960, 20000, 10\n1, A100, 40960, 10000, 5\n";

async function request(options, body) {
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

async function runTests() {
  // Test parse
  const parsed = parseNvidiaCsv(FIXTURE, 'test-host');
  assert(Array.isArray(parsed) && parsed.length === 2, 'parsed two gpus');
  assert(parsed[0].id.startsWith('test-host-gpu'), 'id formed');
  assert(parsed[0].model === 'A100', 'model parsed');

  // Start a throwaway server to receive posts
  let posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      posts.push({path: req.url, body});
      // first call simulate 500, later 200
      const code = posts.length === 1 ? 500 : 200;
      res.writeHead(code, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: code === 200}));
    });
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const schedulerUrl = `http://localhost:${port}`;

  // call reportOnceFromCsv which posts to SCHEDULER_URL; temporarily set env var
  process.env.SCHEDULER_URL = schedulerUrl;
  process.env.HOST_ID = 'test-host';

  // Use the exported helper to post the fixture
  const results1 = await agent.reportOnceFromCsv(FIXTURE);
  // first round should have at least one failure (500)
  assert(results1.length === 2, 'two post attempts');
  // allow server to have recorded them
  assert(posts.length >= 2, 'server received posts');

  // Now run again to see that 200 responses are handled and do not throw
  const results2 = await agent.reportOnceFromCsv(FIXTURE);
  assert(results2.length === 2, 'two post attempts second round');

  server.close();
  console.log('Agent tests passed');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
