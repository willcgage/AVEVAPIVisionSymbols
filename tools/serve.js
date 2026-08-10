#!/usr/bin/env node
/* ============================================================================
 * PVX preview server — serves the repo root over HTTP so dev/harness.html can
 * fetch dist/manifest.json and the built symbol files. `file://` blocks fetch,
 * which is the only reason this exists.
 *
 *   node tools/serve.js [port]
 * ==========================================================================*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8777;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.map': 'application/json'
};

const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') { rel = '/dev/harness.html'; }

    // Contain every request inside the repo — this server is for local
    // development, but a path-traversal hole is never worth leaving open.
    const target = path.normalize(path.join(ROOT, rel));
    if (!target.startsWith(ROOT)) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.stat(target, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel);
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        fs.createReadStream(target).pipe(res);
    });
});

server.listen(PORT, () => {
    const url = 'http://localhost:' + PORT + '/';
    console.log('\n  PVX preview   ' + url);
    console.log('  serving       ' + ROOT);
    console.log('\n  Ctrl+C to stop\n');

    // Best-effort browser launch; silently ignored on headless machines.
    const opener = process.platform === 'win32' ? 'cmd'
        : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const openArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    execFile(opener, openArgs, () => { });
});
