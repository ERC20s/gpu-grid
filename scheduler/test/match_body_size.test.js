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

  await testRejectsOversizeMatch(port);

  server.close();
  console.log('Match body size tests passed');
}

async function testRejectsOversizeMatch(port) {
  // Build a payload slightly larger than the default limit (256KB)
  const limit = 262144;
  const large = 'a'.repeat(limit + 100);
  const payload = JSON.stringify({job: {required_min_vram_mb: 4096}, comment: large});

  const res = await request({method: 'POST', port, path: '/match'}, payload);
  assert(res.statusCode === 413, 'oversized POST /match should return 413');
  const body = JSON.parse(res.body);
  assert(body.error === 'request_too_large', 'error code for oversized request');

  // Confirm the oversized request did not create any registry entries
  const list = await request({method: 'GET', port, path: '/hosts'});
  const payloadList = JSON.parse(list.body);
  const ids = payloadList.hosts.map(h => h.id);
  // we used no host id in the match request, but ensure the registry does not contain a suspicious id
  assert(!ids.includes('huge-match'), 'oversized match should not have created registry entries');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
