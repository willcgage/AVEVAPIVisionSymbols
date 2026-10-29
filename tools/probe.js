#!/usr/bin/env node
/* ============================================================================
 * PVX probe — render ONE symbol straight from src/ and screenshot it.
 * ----------------------------------------------------------------------------
 * Where tools/verify.js is the gate over the whole built library, this is the
 * inner development loop: no dist/ round-trip, no fixed port, one symbol, any
 * size, any config override. That makes it safe to run several at once while
 * different symbols are being worked on in parallel.
 *
 *   node tools/probe.js pvxHistogram
 *   node tools/probe.js pvxBoxPlot --w 900 --h 480 --dark --out /tmp/box.png
 *   node tools/probe.js pvxComboChart --config "TraceSpec=1:bar,2:line:right;StackBars=true"
 *   node tools/probe.js pvxStateDuration --count 6 --hours 24
 *   node tools/probe.js pvxProfile --empty
 *
 * Options
 *   --w --h        symbol box size            (default 320 x 200)
 *   --dark         dark canvas
 *   --empty        send a null payload
 *   --bad          mark data source 2 bad quality
 *   --count        number of data sources     (default 8, forced to 1 if Single)
 *   --points       samples per series         (default 140)
 *   --hours        window length in hours     (default 8)
 *   --config       comma-separated Key=Value config overrides
 *   --payload      JSON file sent as the data update instead of the mock, for
 *                  a test that needs to know the exact answer
 *   --out          PNG path                   (default /tmp/pvx-<symbol>.png)
 *   --port         override the auto-derived port
 *   --json         print the inspection report as JSON
 *   --clicks       "fx,fy;fx,fy": click at fractions of the box, in order
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');

/* ---------------------------------------------------------------- args ---- */
const argv = process.argv.slice(2);
const typeName = argv.find((a) => !a.startsWith('--'));
if (!typeName) {
    console.error('usage: node tools/probe.js <typeName> [options]');
    process.exit(1);
}
function opt(name, fallback) {
    const i = argv.indexOf('--' + name);
    return i === -1 ? fallback : argv[i + 1];
}
const flag = (name) => argv.indexOf('--' + name) !== -1;

const SYM_DIR = path.join(ROOT, 'src', 'symbols', typeName);
if (!fs.existsSync(SYM_DIR)) {
    console.error('no such symbol: src/symbols/' + typeName);
    process.exit(1);
}

const W = parseInt(opt('w', 320), 10);
const H = parseInt(opt('h', 200), 10);
const OUT = opt('out', '/tmp/pvx-' + typeName + '.png');

// Derive a stable per-symbol port so parallel probes usually miss each other.
// "Usually" is the honest word: a 20k-wide hash over two dozen names WILL collide
// eventually, so listen() retries on the next port rather than dying with
// EADDRINUSE — which is exactly how this bit itself the first time.
let hash = 0;
for (let i = 0; i < typeName.length; i++) { hash = (hash * 31 + typeName.charCodeAt(i)) >>> 0; }
const BASE_PORT = parseInt(opt('port', 0), 10) || (20000 + (hash % 20000));

// Pairs are separated by ';' not ',' — config VALUES routinely contain commas
// (TraceSpec, Thresholds, StateColors are all comma-separated grammars), and
// splitting on ',' silently dropped every entry after the first.
const overrides = {};
String(opt('config', '')).split(';').forEach((pair) => {
    if (!pair) { return; }
    const eq = pair.indexOf('=');
    if (eq === -1) { return; }
    const k = pair.slice(0, eq).trim();
    let v = pair.slice(eq + 1).trim();
    if (v === 'true') { v = true; } else if (v === 'false') { v = false; }
    else if (v !== '' && !isNaN(Number(v))) { v = Number(v); }
    // A list setting (SourceNames) as JSON: SourceNames=["Tray 21","Tray 30"]
    else if (v.charAt(0) === '[') { try { v = JSON.parse(v); } catch (e) { /* keep the text */ } }
    overrides[k] = v;
});

/* -------------------------------------------------------------- server ---- */
const read = (p) => fs.readFileSync(p, 'utf8');

function page() {
    // Same CSS assembly the build does: shared base first, symbol second.
    const css = read(path.join(ROOT, 'src', 'shared', 'base.css')) + '\n' +
                read(path.join(SYM_DIR, 'styles.css'));
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<style>html,body{margin:0;padding:0;height:100%;background:#fff}
body.dark{background:#1f2124}
#box{position:absolute;left:0;top:0;overflow:hidden}
${css}</style></head><body><div id="box"></div>
<script src="/dev/vendor/angular.min.js"></script>
<script src="/dev/pv-mock.js"></script>
<script src="/src/shared/pvx-core.js"></script>
<!-- A site with no PI Web API and discovery off, as in 1.12.0: the
     same-server probe would 404 here, and the browser logs every 404 as a
     console error, which this gate fails on. Discovery is proven by
     test-api, test-afpick and test-overview against mocks that answer. -->
<script>window.PVX.api.configure({ autoDiscover: false });</script>
<script src="/sym/symbol.js"></script>
</body></html>`;
}

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page());
        return;
    }
    const target = rel.startsWith('/sym/')
        ? path.join(SYM_DIR, rel.slice(5))
        : path.normalize(path.join(ROOT, rel));
    if (!target.startsWith(ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404).end('not found: ' + rel);
        return;
    }
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(target)] || 'text/plain') + '; charset=utf-8' });
    fs.createReadStream(target).pipe(res);
});

/* ----------------------------------------------------------------- run ---- */
let PORT = BASE_PORT;
let portAttempts = 0;
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && portAttempts < 40) {
        portAttempts += 1;
        PORT = 20000 + ((BASE_PORT - 20000 + portAttempts * 97) % 20000);
        server.listen(PORT);
        return;
    }
    console.error('probe server failed: ' + err.message);
    process.exit(1);
});

server.on('listening', async () => {
    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launchOpts.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launchOpts);
    const p = await browser.newPage({ viewport: { width: W + 60, height: H + 60 } });

    const errors = [];
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); } });

    // The hash must be in place BEFORE the symbol initialises — navigation
    // symbols read it during init to work out where they are.
    const hash = opt('hash', '');
    await p.goto('http://127.0.0.1:' + PORT + '/' + (hash ? '#' + String(hash).replace(/^#/, '') : ''),
        { waitUntil: 'networkidle' });

    // The mock profile lives in the symbol's own header comment, same tag the
    // build reads — so the probe feeds exactly what verify.js would.
    const mockProfile = (/@mock\s+(\w+)/.exec(read(path.join(SYM_DIR, 'symbol.js'))) || [])[1] || 'numeric';

    const report = await p.evaluate(async (a) => {
        if (a.dark) { document.body.classList.add('dark'); }
        const box = document.getElementById('box');
        box.style.width = a.w + 'px';
        box.style.height = a.h + 'px';

        const def = window.PVMock.get(a.typeName);
        if (!def) { return { fatal: 'symbol did not register' }; }

        const injector = angular.injector(['ng']);
        const $compile = injector.get('$compile');
        const scope = injector.get('$rootScope').$new(true);
        scope.config = def.getDefaultConfig ? def.getDefaultConfig() : {};
        Object.keys(a.overrides).forEach((k) => { scope.config[k] = a.overrides[k]; });
        scope.runtimeData = { isEditMode: false };
        scope.symbol = { Name: a.typeName };

        const tpl = await fetch('/sym/template.html').then((r) => r.text());
        // PI Vision hands init() its own wrapper element, with the template
        // linked INSIDE it, never the template root. Probing with the bare
        // template hid a bug where theme variables landed on the wrapper and
        // the root's stylesheet defaults overrode them.
        const host = document.createElement('div');
        host.className = 'pv-symbol-host';
        host.style.cssText = 'width:100%;height:100%';
        box.appendChild(host);
        let el;
        try { el = angular.element(host).append($compile(tpl)(scope)); }
        catch (e) { return { fatal: 'template compile: ' + e.message }; }

        try {
            const cfg = await fetch('/sym/config.html').then((r) => r.text());
            const holder = document.createElement('div');
            holder.style.cssText = 'position:absolute;left:-9999px;width:260px';
            document.body.appendChild(holder);
            angular.element(holder).append($compile(cfg)(scope));
        } catch (e) { return { fatal: 'config compile: ' + e.message }; }

        const vis = new def.visObjectType();
        try { vis.init(scope, el, undefined); }
        catch (e) { return { fatal: 'init(): ' + (e.stack || e.message) }; }

        const shape = scope.config.DataShape || 'None';
        const count = def.datasourceBehavior === 1 ? 1 : a.count;
        const mk = (tick) => a.payload ? JSON.parse(a.payload) : a.empty || shape === 'None' ? null : window.PVMock.generate(shape, {
            count: count, points: a.points, hours: a.hours, tick: tick, seed: 7,
            digital: a.mockProfile === 'digital',
            profile: a.mockProfile,
            badIndex: a.bad && count > 1 ? 1 : -1
        });

        try { vis.onDataUpdate(mk(1)); vis.onResize(a.w, a.h); }
        catch (e) { return { fatal: 'first update: ' + (e.stack || e.message) }; }
        scope.$applyAsync();
        await new Promise((r) => setTimeout(r, 200));

        // Second update exercises the re-render / node-reuse path.
        try { vis.onDataUpdate(mk(2)); }
        catch (e) { return { fatal: 'second update: ' + (e.stack || e.message) }; }
        await new Promise((r) => setTimeout(r, 220));

        // Clicks, each a fraction of the box across and down, for a symbol
        // that is used by pointing (the Combo Chart's rulers): a pointer
        // press on whatever is drawn there, then the release on the page.
        for (let ci = 0; ci < a.clicks.length; ci++) {
            const b0 = box.getBoundingClientRect();
            const cx = b0.left + a.clicks[ci][0] * b0.width, cy = b0.top + a.clicks[ci][1] * b0.height;
            const target = document.elementFromPoint(cx, cy);
            if (!target) { continue; }
            const init = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true, button: 0 };
            target.dispatchEvent(new PointerEvent('pointerdown', init));
            document.dispatchEvent(new PointerEvent('pointerup', init));
            await new Promise((r) => setTimeout(r, 150));
        }
        if (a.clicks.length) { await new Promise((r) => setTimeout(r, 200)); }

        const br = box.getBoundingClientRect();
        let maxOverflow = 0, worst = '';
        const bad = [];
        const fonts = [];
        box.querySelectorAll('*').forEach((e) => {
            for (let i = 0; i < e.attributes.length; i++) {
                const at = e.attributes[i];
                if (!/^(d|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|points|transform|font-size|stroke-width|viewBox|offset)$/.test(at.name)) { continue; }
                if (/NaN|Infinity|undefined/.test(at.value)) { bad.push(e.tagName + '[' + at.name + '="' + at.value + '"]'); }
            }
            if (e.tagName === 'text') {
                const f = parseFloat(window.getComputedStyle(e).fontSize);
                if (f > 0) { fonts.push(f); }
            }
            const g = e.getBoundingClientRect();
            if (!g.width || !g.height) { return; }
            let scrollable = false;
            let anc = e.parentElement;
            while (anc && anc !== box) {
                const st = window.getComputedStyle(anc);
                if (/auto|scroll/.test(st.overflowY) || /auto|scroll/.test(st.overflowX)) { scrollable = true; break; }
                anc = anc.parentElement;
            }
            if (scrollable) { return; }
            const ov = Math.max(g.right - br.right, g.bottom - br.bottom, br.left - g.left, br.top - g.top);
            if (ov > maxOverflow) { maxOverflow = ov; worst = e.tagName + '.' + (e.getAttribute('class') || '').split(' ')[0]; }
        });

        return {
            painted: box.querySelectorAll('*').length,
            svgCount: box.querySelectorAll('svg').length,
            textLen: (box.textContent || '').trim().length,
            text: (box.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
            // Every tooltip in full: the text above is cut short, and a test
            // checking a computed share reads it from the tooltip.
            tips: Array.prototype.map.call(box.querySelectorAll('title'), (n) => n.textContent),
            // Every drawn SVG label in full, one per <text>: a fit equation or
            // a stats card sits past where the cut-short text ends.
            labels: Array.prototype.map.call(box.querySelectorAll('svg text'), (n) => n.textContent).slice(0, 400),
            // Table cells in full, a row per <tr>: a test checking a computed
            // cell reads it here rather than from the cut-short text.
            rows: Array.prototype.slice.call(box.querySelectorAll('tr'), 0, 400).map((tr) =>
                Array.prototype.map.call(tr.children, (td) => td.textContent.replace(/\s+/g, ' ').trim())),
            footer: Array.prototype.map.call(box.querySelectorAll('.pvx-footer'), (n) => n.textContent.replace(/\s+/g, ' ').trim()).join(' '),
            badAttrs: bad.slice(0, 5),
            maxOverflow: Math.round(maxOverflow),
            worstOverflow: worst,
            minFont: fonts.length ? Math.min.apply(null, fonts) : null
        };
    }, {
        typeName, w: W, h: H, dark: flag('dark'), empty: flag('empty'), bad: flag('bad'),
        count: parseInt(opt('count', 8), 10),
        points: parseInt(opt('points', 140), 10),
        hours: parseFloat(opt('hours', 8)),
        mockProfile, overrides,
        clicks: String(opt('clicks', '')).split(';').filter(Boolean).map((c) => c.split(',').map(Number)),
        payload: opt('payload', '') ? fs.readFileSync(opt('payload'), 'utf8') : ''
    }).catch((e) => ({ fatal: 'evaluate: ' + e.message }));

    await p.screenshot({ path: OUT, clip: { x: 0, y: 0, width: W, height: H } });
    await browser.close();
    server.close();

    if (flag('json')) {
        console.log(JSON.stringify({ typeName, size: W + 'x' + H, errors, report, out: OUT }, null, 2));
        process.exit(report.fatal || errors.length ? 1 : 0);
    }

    const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
    console.log('');
    console.log('  ' + typeName + D + '  ' + W + 'x' + H +
        (flag('dark') ? ' dark' : '') + (flag('empty') ? ' empty' : '') +
        (flag('bad') ? ' bad-quality' : '') + '  mock:' + mockProfile + X);
    if (report.fatal) { console.log('  ' + R + 'FATAL  ' + report.fatal + X); }
    errors.forEach((e) => console.log('  ' + R + 'error  ' + e.slice(0, 200) + X));
    if (!report.fatal) {
        if (report.badAttrs.length) { console.log('  ' + R + 'bad attrs  ' + report.badAttrs.join(', ') + X); }
        if (report.maxOverflow > 8) { console.log('  ' + Y + 'clipped  ' + report.maxOverflow + 'px (' + report.worstOverflow + ')' + X); }
        if (report.minFont !== null && report.minFont < 5) { console.log('  ' + Y + 'tiny text  ' + report.minFont.toFixed(1) + 'px' + X); }
        console.log('  ' + D + report.painted + ' nodes, ' + report.svgCount + ' svg, text: "' + report.text.slice(0, 120) + '"' + X);
        if (!report.badAttrs.length && report.maxOverflow <= 8 && !errors.length) {
            console.log('  ' + G + 'clean' + X);
        }
    }
    console.log('  ' + D + '-> ' + OUT + X);
    console.log('');
    process.exit(report.fatal || errors.length || (report.badAttrs || []).length ? 1 : 0);
});

// Kick it off. The error handler above re-listens on a new port if this one is taken.
server.listen(PORT);
