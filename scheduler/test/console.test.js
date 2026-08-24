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

  await testConsoleServed(port);

  server.close();
  console.log('Console tests passed');
}

async function testConsoleServed(port) {
  const res = await request({method: 'GET', port, path: '/'});
  assert(res.statusCode === 200, 'GET / should return 200');
  const ct = res.headers['content-type'] || res.headers['Content-Type'];
  assert(String(ct).startsWith('text/html'), 'Content-Type should be text/html');
  assert(res.body.includes("fetch('/hosts')") || res.body.includes('fetch("/hosts")'), "HTML should contain fetch('/hosts')");
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
