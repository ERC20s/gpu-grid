const http = require('http');
const { match } = require('./lib/matcher');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/match') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const job = payload.job || {};
        const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
        const matches = match(job, hosts);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({matches}));
      } catch (err) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'invalid_json', message: err.message}));
      }
    });
    return;
  }

  res.writeHead(404, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'not_found'}));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('scheduler listening on', PORT);
  });
}

module.exports = server;
