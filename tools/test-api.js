#!/usr/bin/env node
/* ============================================================================
 * PVX api test — exercises PVX.api and the connectivity diagnostic against a
 * MOCK PI Web API, deliberately misconfigured in the ways real ones are.
 * ----------------------------------------------------------------------------
 *   node tools/test-api.js
 *
 * Two servers run on different ports, so every request is genuinely
 * cross-origin and the browser applies real CORS rules — the whole point.
 * Scenarios:
 *
 *   healthy        CORS correct, preflight anonymous, credentials accepted
 *   no-cors        no CORS headers at all (PI Web API not configured)
 *   wildcard-cors  Access-Control-Allow-Origin: * with credentials — the
 *                  combination browsers reject outright, and the reason
 *                  AVEVA's guidance says to list explicit origins
 *   preflight-401  OPTIONS answered with an auth challenge — the classic
 *                  Windows-auth-plus-CORS trap
 *   auth-required  reachable, but 401 unless credentials are sent
 *   forbidden      authenticated but no AF visibility
 *
 * Requires the dev dependency `playwright`. Set PVX_CHROMIUM to use a
 * pre-installed browser.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'dist', 'ext');
const VISION_PORT = 31780;   // stands in for the PI Vision origin
const API_PORT = 31781;      // stands in for PI Web API on another server

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m' };

let scenario = 'healthy';
const valueStore = {};   // webId -> value, so writes are actually observable
let writeLog = [];       // every write the mock received, in order

/* ---------------------------------------------------- mock PI Vision origin */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const visionServer = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') { rel = '/pvx/piwebapi-check.html'; }
    const target = path.normalize(path.join(EXT, rel));
    if (!target.startsWith(EXT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404).end('not found');
        return;
    }
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(target)] || 'text/plain') + '; charset=utf-8' });
    fs.createReadStream(target).pipe(res);
});

/* -------------------------------------------------------- mock PI Web API */
const ORIGIN = 'http://127.0.0.1:' + VISION_PORT;

function corsHeaders(req) {
    const h = {};
    if (scenario === 'no-cors') { return h; }
    if (scenario === 'wildcard-cors') {
        // Browsers refuse '*' when credentials are involved. This is exactly why
        // AVEVA's guidance says to list the explicit PI Vision URLs.
        h['Access-Control-Allow-Origin'] = '*';
        h['Access-Control-Allow-Credentials'] = 'true';
    } else {
        h['Access-Control-Allow-Origin'] = req.headers.origin || ORIGIN;
        h['Access-Control-Allow-Credentials'] = 'true';
    }
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With, Accept';
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS, POST, PUT, PATCH';
    h['Vary'] = 'Origin';
    return h;
}

const apiServer = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const headers = corsHeaders(req);

    if (req.method === 'OPTIONS') {
        if (scenario === 'preflight-401') {
            // IIS answering the preflight with a challenge. Chrome and Firefox
            // abandon the request here, before any credential can be offered.
            res.writeHead(401, Object.assign({ 'WWW-Authenticate': 'Negotiate' }, headers)).end();
            return;
        }
        res.writeHead(204, headers).end();
        return;
    }

    const authed = !!(req.headers.authorization || req.headers.cookie || req.headers['x-mock-credential']);
    const needsAuth = scenario === 'auth-required' || scenario === 'forbidden';

    if (needsAuth && !authed) {
        res.writeHead(401, Object.assign({ 'WWW-Authenticate': 'Negotiate' }, headers)).end('Unauthorized');
        return;
    }

    const json = (code, body) => {
        res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers));
        res.end(JSON.stringify(body));
    };

    if (url === '/piwebapi' || url === '/piwebapi/') {
        json(200, { Links: { Self: '/piwebapi', AssetServers: '/piwebapi/assetservers', DataServers: '/piwebapi/dataservers', Search: '/piwebapi/search' } });
        return;
    }
    if (url === '/piwebapi/assetservers') {
        if (scenario === 'forbidden') { json(403, { Errors: ['Access denied'] }); return; }
        json(200, { Items: [{ Name: 'AFSERVER01', WebId: 'F1RS-mock' }] });
        return;
    }
    if (url.indexOf('/piwebapi/assetdatabases') === 0) {
        json(200, { Name: 'Production', WebId: 'F1RD-mock' });
        return;
    }
    if (url.indexOf('/eventframes') !== -1) {
        json(200, { Items: [
            { Name: 'Downtime 2026-08-07', StartTime: '2026-08-07T14:02:00Z', EndTime: '2026-08-07T15:31:00Z' },
            { Name: 'Downtime 2026-08-06', StartTime: '2026-08-06T09:12:00Z', EndTime: '2026-08-06T09:48:00Z' }
        ] });
        return;
    }
    // --- value read/write, for the entry and acknowledgement symbols -------
    // 'W-LOCKED' always refuses, so the 403 path can be exercised; everything
    // else round-trips through a real in-memory store, which is what makes the
    // shared-acknowledgement merge testable rather than merely asserted.
    const vm = /^\/piwebapi\/streams\/([^/]+)\/value$/.exec(url);
    if (vm) {
        const webId = decodeURIComponent(vm[1]);
        if (req.method === 'GET') {
            json(200, { Timestamp: '2026-08-09T00:00:00Z', Value: valueStore[webId] === undefined ? null : valueStore[webId] });
            return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
            // Log the ATTEMPT, before the permission check. A refused write still
            // reached the server, and the property under test is that the client
            // sent each one separately — not that each one succeeded.
            writeLog.push({ webId: webId, refused: webId === 'W-LOCKED' });
            if (webId === 'W-LOCKED') { json(403, { Errors: ['Access denied'] }); return; }
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let parsed = {};
                try { parsed = JSON.parse(body); } catch (e) { json(400, { Errors: ['Bad body'] }); return; }
                valueStore[webId] = parsed.Value;
                res.writeHead(202, headers).end();
            });
            return;
        }
    }
    if (url.indexOf('/piwebapi/attributes') === 0) {
        json(200, { Name: 'Ack', WebId: 'W-ACK', Path: '\\\\AF\\DB\\El|Ack' });
        return;
    }

    if (url === '/piwebapi/batch' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let reqs = {};
            try { reqs = JSON.parse(body); } catch (e) { /* ignore */ }
            const out = {};
            Object.keys(reqs).forEach((id) => { out[id] = { Status: 200, Content: { echo: reqs[id].Resource } }; });
            json(200, out);
        });
        return;
    }
    json(404, { Errors: ['Not found'] });
});

/* --------------------------------------------------------------- scenarios */
const SCENARIOS = [
    { id: 'healthy',       expectWorking: true,  expect: /Working:/,            note: 'correct CORS, anonymous allowed' },
    { id: 'auth-required', expectWorking: true,  expect: /Working:/,            note: '401 without credentials, IWA accepted' },
    { id: 'no-cors',       expectWorking: false, expect: /No authentication method worked/, note: 'no CORS headers at all' },
    { id: 'wildcard-cors', expectWorking: false, expect: /Anonymous works, credentials do not/, note: 'Allow-Origin * with credentials \u2014 the partial-pass trap' },
    { id: 'preflight-401', expectWorking: false, expect: /No authentication method worked/, note: 'OPTIONS answered with a challenge' },
    { id: 'forbidden',     expectWorking: true,  expect: /Working:/,            note: 'authenticated but AF denied' }
];

(async function main() {
    if (!fs.existsSync(path.join(EXT, 'pvx', 'piwebapi-check.html'))) {
        console.error('dist/ext/pvx/piwebapi-check.html missing — run `npm run build` first.');
        process.exit(1);
    }

    await new Promise((r) => visionServer.listen(VISION_PORT, r));
    await new Promise((r) => apiServer.listen(API_PORT, r));

    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launchOpts.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launchOpts);

    console.log('\n' + C.bold + 'PVX api test' + C.reset + C.dim +
        '  mock PI Web API on :' + API_PORT + ', PI Vision origin on :' + VISION_PORT + C.reset + '\n');

    let failures = 0;

    for (const sc of SCENARIOS) {
        scenario = sc.id;
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));

        await page.goto(ORIGIN + '/pvx/piwebapi-check.html', { waitUntil: 'networkidle' });

        // 'auth-required' and 'forbidden' need SOMETHING that looks like a
        // credential; withCredentials alone sends no cookie in a fresh context,
        // so stand one in to exercise the credentialed path.
        if (sc.id === 'auth-required' || sc.id === 'forbidden') {
            await page.context().addCookies([{ name: 'mock-auth', value: '1', url: 'http://127.0.0.1:' + API_PORT }]);
        }

        await page.fill('#baseUrl', 'http://127.0.0.1:' + API_PORT + '/piwebapi');
        await page.fill('#afdb', '\\\\AFSERVER01\\Production');
        await page.click('#run');

        await page.waitForFunction(() => {
            const b = document.getElementById('verdictBox');
            return b && !b.hidden;
        }, { timeout: 25000 }).catch(() => { });

        const result = await page.evaluate(() => {
            const b = document.getElementById('verdictBox');
            const tests = Array.from(document.querySelectorAll('.test')).map((t) => ({
                name: t.querySelector('.name').textContent,
                state: t.querySelector('.badge').className.replace('badge ', '')
            }));
            return { verdict: b ? b.textContent : '(none)', tests: tests };
        });

        const passed = sc.expect.test(result.verdict) && pageErrors.length === 0;
        if (!passed) { failures++; }

        console.log((passed ? C.green + '  ok  ' : C.red + ' FAIL ') + C.reset +
            sc.id.padEnd(15) + C.dim + sc.note + C.reset);
        console.log('       ' + C.dim + result.tests.map((t) => t.name.replace(/ \(.*\)/, '') + ':' + t.state).join('  ') + C.reset);
        if (!passed) {
            console.log('       ' + C.red + 'verdict: ' + result.verdict.slice(0, 260).replace(/\s+/g, ' ') + C.reset);
            pageErrors.forEach((e) => console.log('       ' + C.red + 'pageerror: ' + e + C.reset));
        }
        await page.close();
    }

    /* -- batch + write paths, exercised directly rather than through the UI -- */
    scenario = 'healthy';
    const page = await browser.newPage();
    await page.goto(ORIGIN + '/pvx/piwebapi-check.html', { waitUntil: 'networkidle' });
    const unit = await page.evaluate(async (apiPort) => {
        const PVX = window.PVX;
        PVX.api.configure({ baseUrl: 'http://127.0.0.1:' + apiPort + '/piwebapi', auth: 'anonymous', maxBatchSize: 3, cacheTtlMs: 5000 });
        const out = {};

        // batch chunking: 7 requests at a chunk size of 3 must still come back whole
        const reqs = {};
        for (let i = 0; i < 7; i++) { reqs['r' + i] = { Method: 'GET', Resource: '/piwebapi/assetservers?i=' + i }; }
        const res = await PVX.api.batch(reqs);
        out.batchCount = Object.keys(res).length;
        out.batchResults = PVX.api.batchResults(res).failedCount;

        // cache: second identical GET must not touch the network
        const t0 = performance.now();
        await PVX.api.get('assetservers');
        const first = performance.now() - t0;
        const t1 = performance.now();
        await PVX.api.get('assetservers');
        out.cachedFaster = (performance.now() - t1) < Math.max(1, first);

        // an unconfigured client must refuse clearly rather than guessing a host
        PVX.api.configure({ baseUrl: '' });
        try { await PVX.api.get(''); out.unconfigured = 'resolved'; }
        catch (e) { out.unconfigured = e.pvxError && e.pvxError.code; }

        // bearer with no token supplied must say so, not send an empty header
        PVX.api.configure({ baseUrl: 'http://127.0.0.1:' + apiPort + '/piwebapi', auth: 'bearer', getToken: null });
        try { await PVX.api.get(''); out.noToken = 'resolved'; }
        catch (e) { out.noToken = (e.pvxError && e.pvxError.code) || 'rejected'; }

        /* ---- writes ---------------------------------------------------- *
         * A write is not idempotent from an operator's point of view, so the
         * properties worth asserting are about restraint: never cached, never
         * silently retried, never collapsed into a neighbour's result.       */
        PVX.api.configure({ baseUrl: 'http://127.0.0.1:' + apiPort + '/piwebapi', auth: 'anonymous' });

        await PVX.api.writeValue('W-A', 11);
        await PVX.api.writeValue('W-A', 22);
        const readBack = await PVX.api.readValue('W-A', { cache: false });
        out.writeVisible = readBack && readBack.Value === 22;

        // a refused write must reject, and must not be retried into succeeding
        try { await PVX.api.writeValue('W-LOCKED', 1); out.forbiddenWrite = 'resolved'; }
        catch (e) { out.forbiddenWrite = e.pvxError && e.pvxError.code; }

        // partial success must be reported as partial, never as failure
        const multi = await PVX.api.writeValues([
            { key: 'r1', webId: 'W-B', value: 1 },
            { key: 'r2', webId: 'W-LOCKED', value: 2 },
            { key: 'r3', webId: 'W-C', value: 3 }
        ]);
        out.partialOk = multi.ok.length;
        out.partialFailed = multi.failed.length;
        out.partialNamesFailure = multi.failed.length === 1 && multi.failed[0].key === 'r2';

        return out;
    }, API_PORT);

    const unitChecks = [
        ['batch chunking returns all 7', unit.batchCount === 7],
        ['batch reports zero failures', unit.batchResults === 0],
        ['second GET served from cache', unit.cachedFaster === true],
        ['unconfigured base refuses clearly', unit.unconfigured === 'not-configured'],
        ['bearer without token refuses clearly', unit.noToken === 'no-token'],
        ['a write is visible on read-back', unit.writeVisible === true],
        ['a refused write rejects, never retried into success', unit.forbiddenWrite === 'forbidden'],
        ['partial success reports 2 ok / 1 failed', unit.partialOk === 2 && unit.partialFailed === 1],
        ['the failed row is named, not just counted', unit.partialNamesFailure === true]
    ];
    console.log('');
    unitChecks.forEach((c) => {
        if (!c[1]) { failures++; }
        console.log((c[1] ? C.green + '  ok  ' : C.red + ' FAIL ') + C.reset + c[0]);
    });

    // Writes must not be cached or coalesced: 2 singles + 3 from writeValues
    // (the refused one still counts as an attempt) = 6 requests reaching the mock.
    const writeCount = writeLog.length;
    const noCoalescing = writeCount === 6;
    if (!noCoalescing) { failures++; }
    console.log((noCoalescing ? C.green + '  ok  ' : C.red + ' FAIL ') + C.reset +
        'writes reach the server individually (' + writeCount + ' of 6, never cached or coalesced)');

    await page.close();
    await browser.close();
    visionServer.close();
    apiServer.close();

    console.log('');
    if (failures) {
        console.log(C.red + C.bold + failures + ' check(s) failed' + C.reset + '\n');
        process.exit(1);
    }
    console.log(C.green + C.bold + 'PI Web API layer behaves correctly, including the misconfigurations' + C.reset + '\n');
})();
