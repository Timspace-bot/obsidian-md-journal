// Static server for the browser harness: node tests/serve.cjs [port], then open /tests/harness.html
const http = require('node:http');
const { readFile } = require('node:fs');
const { join, normalize, extname } = require('node:path');

const root = join(__dirname, '..');
const port = Number(process.argv[2]) || 5178;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
  const file = join(root, path || 'tests/harness.html');
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log('MD Journal harness on http://localhost:' + port + '/tests/harness.html'));
