// A request body arrives from the socket in whatever pieces TCP delivers, and
// a multi-byte UTF-8 character can be cut in two at a piece boundary. The
// server must decode the body once it is complete, not piece by piece: the
// old `body += chunk` turned each half of "é" into U+FFFD, so a host called
// "host-é" was refused with 403 for an id its own token did not cover (or, in
// a /match hosts array, matched under a mangled model name).
//
// The client here is a raw socket so the split point is under our control:
// the first write ends between the two bytes of "é", the second starts with
// the rest. A short pause between the writes makes them arrive as two chunks.
const net = require('net');
const assert = require('assert');
const server = require('../index');

const HOST_ID = 'host-é';
const MODEL = 'RTX 4090 Ti™';
const HOST_TOKEN = 'utf8-host-token-0001';
const USER_TOKEN = 'utf8-user-token-0001';

// Send one request in two writes, cut at byte offset `cut` of the body, and
// return the parsed response.
function requestSplit(port, method, path, token, bodyBuf, cut) {
  const head = `${method} ${path} HTTP/1.1\r\nHost: localhost\r\n` +
    `Authorization: Bearer ${token}\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${bodyBuf.length}\r\nConnection: close\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(head);
      sock.write(bodyBuf.subarray(0, cut));
      setTimeout(() => sock.write(bodyBuf.subarray(cut)), 50);
    });
    const received = [];
    sock.on('data', c => received.push(c));
    sock.on('error', reject);
    sock.on('end', () => {
      const raw = Buffer.concat(received).toString('utf8');
      const statusCode = Number(raw.split(' ')[1]);
      const headerEnd = raw.indexOf('\r\n\r\n');
      let body = raw.slice(headerEnd + 4);
      if (/transfer-encoding: chunked/i.test(raw.slice(0, headerEnd))) {
        // Join the chunk payloads of a chunked response.
        body = body.split('\r\n').filter((_, i) => i % 2 === 1).join('');
      }
      resolve({statusCode, body: JSON.parse(body)});
    });
  });
}

// Byte offset just after the first byte of the first multi-byte character.
function cutInsideFirstMultibyteChar(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0xc0) return i + 1;
  }
  throw new Error('body has no multi-byte character to split');
}

async function testHostIdSplitAcrossChunks(port) {
  const report = {id: HOST_ID, model: MODEL, vram_mb: 24576, gpu_util_pct: 4, timestamp: 1620000000};
  const body = Buffer.from(JSON.stringify(report), 'utf8');
  const cut = cutInsideFirstMultibyteChar(body);
  assert(body[cut - 1] === 0xc3 && body[cut] === 0xa9, 'the split lands between the two bytes of "é"');

  const res = await requestSplit(port, 'POST', '/hosts', HOST_TOKEN, body, cut);
  assert.strictEqual(res.statusCode, 200, `a split id must still be accepted, got ${res.statusCode} ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.id, HOST_ID, 'the stored id is the one that was sent');
  assert.strictEqual(res.body.model, MODEL, 'the stored model is the one that was sent');

  const entry = server.hostRegistry.get(HOST_ID);
  assert(entry, 'the host is registered under its real id');
  assert.strictEqual(entry.host.model, MODEL);
  assert.strictEqual(server.hostRegistry.size, 1, 'no entry was stored under a mangled id');
}

async function testMatchHostsArraySplitAcrossChunks(port) {
  const payload = {
    job: {acceptable_gpu_models: [MODEL]},
    hosts: [{id: HOST_ID, model: MODEL, vram_mb: 24576, gpu_util_pct: 4, timestamp: 1620000000}]
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  // Cut inside the "™" of the model name in the hosts array, after the job.
  const marker = Buffer.from('"hosts"', 'utf8');
  const cut = cutInsideFirstMultibyteChar(body.subarray(body.indexOf(marker))) + body.indexOf(marker);

  const res = await requestSplit(port, 'POST', '/match', USER_TOKEN, body, cut);
  assert.strictEqual(res.statusCode, 200, `a split hosts array must still be matched, got ${res.statusCode} ${JSON.stringify(res.body)}`);
  assert.deepStrictEqual(res.body.matches.map(h => h.id), [HOST_ID], 'the host matches its own model name');
}

async function runTests() {
  process.env.HOST_TOKENS = JSON.stringify({[HOST_ID]: HOST_TOKEN});
  process.env.USER_TOKENS = JSON.stringify({'utf8-user': USER_TOKEN});
  server.hostRegistry.clear();
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await testHostIdSplitAcrossChunks(port);
  await testMatchHostsArraySplitAcrossChunks(port);

  server.close();
  console.log('UTF-8 body tests passed');
}

if (require.main === module) runTests().catch(err => { console.error(err); process.exit(1); });
