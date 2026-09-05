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

  await testOptionsPreflight(port);
  await testOptionsForMatch(port);
  await testPostReturnsCors(port);

  server.close();
  console.log('CORS tests passed');
}

async function testOptionsPreflight(port) {
  const res = await request({method: 'OPTIONS', port, path: '/hosts'});
  assert(res.statusCode === 204, 'OPTIONS /hosts should return 204');
  assert(res.headers['access-control-allow-origin'] === '*', 'CORS allow origin present');
  assert(/GET, POST/.test(res.headers['access-control-allow-methods'] || ''), 'Allow methods includes POST');
}

async function testOptionsForMatch(port) {
  const res = await request({method: 'OPTIONS', port, path: '/match'});
  assert(res.statusCode === 204, 'OPTIONS /match should return 204');
  assert(res.headers['access-control-allow-origin'] === '*', 'CORS allow origin present on /match');
}

async function testPostReturnsCors(port) {
  const res = await request({method: 'POST', port, path: '/match'}, JSON.stringify({job: {required_min_vram_mb: 1}}));
  assert(res.statusCode === 200, 'POST /match should return 200');
  assert(res.headers['access-control-allow-origin'] === '*', 'POST /match response includes CORS header');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
