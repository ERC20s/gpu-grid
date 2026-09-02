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

async function runTests() {
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await testRejectsOversizeHost(port);

  server.close();
  console.log('Body size tests passed');
}

async function testRejectsOversizeHost(port) {
  // Build a payload slightly larger than the default limit (256KB)
  const limit = 262144;
  const large = 'a'.repeat(limit + 100);
  const payload = JSON.stringify({id: 'huge', model: 'A100', vram_mb: 40960, timestamp: 1620000000, extra: large});

  const res = await request({method: 'POST', port, path: '/hosts'}, payload);
  assert(res.statusCode === 413, 'oversized POST /hosts should return 413');
  const body = JSON.parse(res.body);
  assert(body.error === 'request_too_large', 'error code for oversized request');

  // Confirm the host was not added
  const list = await request({method: 'GET', port, path: '/hosts'});
  const payloadList = JSON.parse(list.body);
  const ids = payloadList.hosts.map(h => h.id);
  assert(!ids.includes('huge'), 'oversized host should not be added to registry');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
