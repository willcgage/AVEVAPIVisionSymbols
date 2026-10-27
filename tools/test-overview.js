#!/usr/bin/env node
/* ============================================================================
 * PVX overview test — the pieces an overview display is built from, against
 * a mock AF database behind a mock PI Web API.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-overview.js
 *
 * Built for the PI Vision Overview Build Guide: drill-down to the element,
 * the Navigation Panel's hierarchy strip, the Asset Table, the Event
 * Timeline scoped to the current asset, and the text size control.
 *
 *   rules    plain Node, against the BUILT core: element paths split the way
 *            PI Vision's asset= parameter wants them, the text scale clamps,
 *            and the Asset Table, an alarm-capable symbol, takes no limits it
 *            was not given.
 *   page     the BUILT symbols in real Chromium on a mock PI Web API: which
 *            requests each symbol makes, what it shows, where a click goes,
 *            and what it says when PI Web API is missing or the asset is not
 *            there. The mock answers batch requests the way PI Web API does,
 *            so a symbol that ignores a failed sub-request shows up here.
 *
 * Requires the dev dependency `playwright` for the second half. Set
 * PVX_CHROMIUM to use a pre-installed browser.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'dist', 'ext');
const CORE = path.join(EXT, 'libraries', 'pvx', 'pvx-core.js');
const PORT = 31797;

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', bold: '\x1b[1m' };
let failures = 0;
let passes = 0;

function check(name, ok, detail) {
    if (ok) { passes += 1; console.log('  ' + C.green + 'ok  ' + C.reset + name); return; }
    failures += 1;
    console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + name + (detail !== undefined ? C.dim + '  got ' + JSON.stringify(detail) + C.reset : ''));
}

if (!fs.existsSync(CORE)) {
    console.error('dist/ext/libraries/pvx/pvx-core.js not found. Run: node tools/build.js');
    process.exit(1);
}

/* ------------------------------------------------------------------ rules */

function loadBuilt(typeNames) {
    const win = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise };
    win.window = win;
    vm.createContext(win);
    const run = (file) => vm.runInContext(fs.readFileSync(file, 'utf8'), win, { filename: path.basename(file) });
    run(path.join(ROOT, 'dev', 'pv-mock.js'));
    run(CORE);
    typeNames.forEach((t) => run(path.join(EXT, 'sym-' + t + '.js')));
    return win;
}

function rules() {
    console.log('');
    console.log(C.bold + 'Overview rules' + C.reset);
    const win = loadBuilt(['pvxAssetTable']);
    const nav = win.PVX.nav;

    check('assetOf: an AF attribute gives its element',
        nav.assetOf('af:\\\\srv\\db\\Area\\K-301|Discharge Pressure?abc') === '\\\\srv\\db\\Area\\K-301');
    check('assetOf: a child attribute still gives the element',
        nav.assetOf('\\\\srv\\db\\K-301|Seal|Pressure') === '\\\\srv\\db\\K-301');
    check('assetOf: a PI point has no element', nav.assetOf('pi:\\\\PISRV01\\SINUSOID?1') === '');
    check('parentOf: one level up', nav.parentOf('\\\\srv\\db\\Area\\K-301') === '\\\\srv\\db\\Area');
    check('parentOf: nothing above a top-level element', nav.parentOf('\\\\srv\\db\\Area') === '');
    const segs = nav.segments('\\\\srv\\db\\Area\\Station 1\\K-301');
    check('segments: prefix is server and database', segs.prefix === '\\\\srv\\db\\', segs.prefix);
    check('segments: elements from the top down',
        JSON.stringify(segs.elements) === JSON.stringify(['Area', 'Station 1', 'K-301']), segs.elements);

    const text = win.PVX.text;
    check('text scale: 100 is 1', text.scaleOf({ TextScale: '100' }) === 1);
    check('text scale: 150 is 1.5', text.scaleOf({ TextScale: '150' }) === 1.5);
    check('text scale: missing or junk is 1', text.scaleOf({}) === 1 && text.scaleOf({ TextScale: 'big' }) === 1);
    check('text scale: clamped to 50%..300%', text.scaleOf({ TextScale: '10' }) === 0.5 && text.scaleOf({ TextScale: '900' }) === 3);
    check('every symbol defaults to 100%', win.PVX.config.base({}).TextScale === '100');

    const def = win.PVMock.get('pvxAssetTable');
    check('asset table: registered', !!def);
    check('asset table: defaults to no bands', def.getDefaultConfig().Thresholds === '');
    check('asset table: a saved placeholder is cleared on load',
        def.loadConfig({ Thresholds: win.PVX.thresholds.DEFAULT }).Thresholds === '');
}

/* ------------------------------------------------------------ mock AF ---- */

const DB = '\\\\AF\\Gathering';
const S1 = DB + '\\Station 1';
const S2 = DB + '\\Station 2';
const K301 = S1 + '\\K-301';
const K302 = S1 + '\\K-302';
const TANK = S1 + '\\Tank 1';
const K303 = S2 + '\\K-303';

// [path, template, attributes {name: [value, units]}]
const ELEMENTS = [
    [S1, 'Station', {}],
    [K301, 'Compressor', { 'Discharge Pressure': [1081, 'psig'], 'Vibration': [3.9, 'mils'], 'Status': [{ Name: 'Running', Value: 1 }, ''] }],
    [K302, 'Compressor', { 'Discharge Pressure': [1169, 'psig'], 'Vibration': [6.2, 'mils'], 'Status': [{ Name: 'Fault', Value: 3 }, ''] }],
    [TANK, 'Tank', { 'Level': [62, '%'] }],
    [S2, 'Station', {}],
    [K303, 'Compressor', { 'Discharge Pressure': [950, 'psig'], 'Status': [{ Name: 'Stopped', Value: 2 }, ''] }]
];

const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
// Event frames by the element that references them. "Seal leak" references
// both compressors, so a tree search finds it twice and must keep it once.
const FRAMES = {};
FRAMES[K301] = [{ Name: 'K-301 trip', StartTime: iso(300), EndTime: iso(280), self: 'ef1' },
    { Name: 'Seal leak', StartTime: iso(200), EndTime: iso(150), self: 'ef2' }];
FRAMES[K302] = [{ Name: 'Seal leak', StartTime: iso(200), EndTime: iso(150), self: 'ef2' },
    { Name: 'K-302 high vibration', StartTime: iso(90), EndTime: iso(60), self: 'ef3' }];
FRAMES[S1] = [{ Name: 'Station 1 ESD test', StartTime: iso(400), EndTime: iso(390), self: 'ef4' }];
FRAMES[K303] = [{ Name: 'K-303 start', StartTime: iso(100), EndTime: iso(95), self: 'ef5' }];

const wid = (kind, p) => 'W' + kind + ':' + p;
const byWebId = {};
const byPath = {};
byWebId[wid('d', DB)] = { kind: 'database', path: DB };
ELEMENTS.forEach(([p, template, attrs]) => {
    const o = { kind: 'element', path: p, template, attrs };
    byWebId[wid('e', p)] = o;
    byPath[p.toLowerCase()] = o;
    Object.keys(attrs).forEach((a) => {
        byWebId[wid('a', p + '|' + a)] = { kind: 'attribute', path: p + '|' + a, element: o, name: a };
    });
});
const nameOf = (p) => p.split('\\').filter(Boolean).pop();
const parent = (p) => p.slice(0, p.lastIndexOf('\\'));
const childrenOf = (p, deep) => ELEMENTS.map((e) => e[0]).filter((c) => (deep
    ? c.toLowerCase().indexOf(p.toLowerCase() + '\\') === 0
    : parent(c).toLowerCase() === p.toLowerCase()));
const elementOut = (p) => ({ Name: nameOf(p), Path: p, WebId: wid('e', p), TemplateName: byPath[p.toLowerCase()].template });

let requests = [];

/** One PI Web API request -> {status, body}. Shared by GET and batch. */
function route(method, url, via) {
    const u = new URL(url, 'http://x');
    const q = u.searchParams;
    const rel = decodeURIComponent(u.pathname).replace(/^\/piwebapi\/?/, '');
    requests.push((via || '') + method + ' ' + rel + (q.toString() ? '?' + decodeURIComponent(q.toString().replace(/\+/g, ' ')) : ''));
    const max = parseInt(q.get('maxCount') || '1000', 10);
    const notFound = { status: 404, body: { Errors: ['Not found: ' + (q.get('path') || rel)] } };

    // The service root, which is what discovery asks for on the PI Vision origin.
    if (rel === '') { return { status: 200, body: { Links: { Self: '/piwebapi' } } }; }
    if (rel === 'assetdatabases' && q.get('path')) {
        return q.get('path').toLowerCase() === DB.toLowerCase()
            ? { status: 200, body: { Name: 'Gathering', Path: DB, WebId: wid('d', DB) } } : notFound;
    }
    if (rel === 'elements' && q.get('path')) {
        const o = byPath[q.get('path').toLowerCase()];
        return o ? { status: 200, body: elementOut(o.path) } : notFound;
    }
    if (rel === 'attributes' && q.get('path')) {
        const p = q.get('path');
        const bar = p.indexOf('|');
        const o = byPath[p.slice(0, bar).toLowerCase()];
        const name = o && Object.keys(o.attrs).find((a) => a.toLowerCase() === p.slice(bar + 1).toLowerCase());
        return name ? { status: 200, body: { Name: name, WebId: wid('a', o.path + '|' + name) } } : notFound;
    }
    let m = /^streams\/([^/]+)\/value$/.exec(rel);
    if (m) {
        const a = byWebId[m[1]];
        if (!a || a.kind !== 'attribute') { return notFound; }
        const [v, units] = a.element.attrs[a.name];
        return { status: 200, body: { Timestamp: iso(1), Value: v, UnitsAbbreviation: units, Good: true } };
    }
    m = /^(elements|assetdatabases)\/([^/]+)\/(elements|eventframes)$/.exec(rel);
    if (m) {
        const o = byWebId[m[2]];
        if (!o) { return notFound; }
        if (m[3] === 'elements') {
            let list = childrenOf(o.path, q.get('searchFullHierarchy') === 'true');
            if (q.get('templateName')) { list = list.filter((p) => byPath[p.toLowerCase()].template === q.get('templateName')); }
            return { status: 200, body: { Items: list.slice(0, max).map(elementOut) } };
        }
        const frames = m[1] === 'elements' ? (FRAMES[o.path] || [])
            : Object.keys(FRAMES).reduce((all, k) => all.concat(FRAMES[k]), []);
        return { status: 200, body: { Items: frames.slice(0, max).map((f) => ({
            Name: f.Name, StartTime: f.StartTime, EndTime: f.EndTime, TemplateName: 'Downtime',
            Links: { Self: 'http://x/piwebapi/eventframes/' + f.self } })) } };
    }
    return { status: 404, body: { Errors: ['No mock for ' + method + ' ' + rel] } };
}

function api(req, res) {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && /\/piwebapi\/batch/.test(req.url)) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            requests.push('POST batch');
            const asks = JSON.parse(raw || '{}');
            const out = {};
            Object.keys(asks).forEach((id) => {
                const r = route(asks[id].Method || 'GET', asks[id].Resource, 'batch: ');
                out[id] = { Status: r.status, Headers: {}, Content: r.body };
            });
            send(207, out);
        });
        return;
    }
    const r = route(req.method, req.url);
    send(r.status, r.body);
}

/* ------------------------------------------------------------------- page */

function pageHtml(typeName) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<style>body{margin:0;font-family:sans-serif}</style>
</head><body><div id="box" style="width:640px;height:240px;position:relative"></div>
<script src="/dev/vendor/angular.min.js"></script>
<script src="/dev/pv-mock.js"></script>
<script src="/dist/ext/libraries/pvx/pvx-core.js"></script>
<link rel="stylesheet" href="/dist/ext/sym-${typeName}.css">
<script src="/dist/ext/sym-${typeName}.js"></script>
</body></html>`;
}

function serve() {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            if (req.url.indexOf('/piwebapi') === 0) { api(req, res); return; }
            const rel = decodeURIComponent(req.url.split('?')[0]);
            const m = /^\/page\/(\w+)$/.exec(rel);
            if (m) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(pageHtml(m[1]));
                return;
            }
            const target = path.normalize(path.join(ROOT, rel));
            if (!target.startsWith(ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
                res.writeHead(404).end('not found');
                return;
            }
            const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(target)] || 'text/plain';
            res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
            fs.createReadStream(target).pipe(res);
        });
        s.listen(PORT, () => resolve(s));
    });
}

/** Runs in the browser: mount one symbol, PI Web API pointed at the mock. */
async function mount(a) {
    window.PVX.api.configure({ baseUrl: a.configured === false || a.configured === 'auto' ? '' : location.origin + '/piwebapi',
        autoDiscover: a.configured !== false, auth: 'anonymous', timeoutMs: a.timeoutMs || 20000 });
    window.PVX.api.clearCache();
    // A load that never settles, whatever the reason: the symbol must say so.
    if (a.hang) { window.PVX.api.get = () => new Promise(() => {}); }
    // A runtime from an older release: 1.12.0's core had no defaultDatabase.
    if (a.staleCore) { delete window.PVX.nav.defaultDatabase; }
    if (a.coreVersion) { window.PVX.version = a.coreVersion; }
    const def = window.PVMock.get(a.typeName);
    const injector = angular.injector(['ng']);
    const $compile = injector.get('$compile');
    const scope = injector.get('$rootScope').$new(true);
    scope.config = def.getDefaultConfig();
    Object.keys(a.config || {}).forEach((k) => { scope.config[k] = a.config[k]; });
    scope.runtimeData = { isEditMode: false };
    scope.symbol = { Name: a.typeName, DataSources: [a.source || 'af:\\\\AF\\Gathering\\Station 1|Name?x'] };
    const tpl = await fetch('/dist/ext/sym-' + a.typeName + '-template.html').then((r) => r.text());
    const box = document.getElementById('box');
    box.innerHTML = '';
    // PI Vision's elem is a wrapper around the template, never the root.
    const wrap = angular.element('<div style="width:100%;height:100%"></div>');
    wrap.append($compile(tpl)(scope));
    angular.element(box).append(wrap);
    const vis = new def.visObjectType();
    try { vis.init(scope, wrap, undefined); } catch (e) { window.__initThrew = e.message; }
    scope.$digest();
    if (a.data !== false && vis.onDataUpdate) {
        vis.onDataUpdate({ Value: 1, Label: 'Name', Path: a.source || 'af:\\\\AF\\Gathering\\Station 1|Name', IsGood: true,
            Rows: a.rows || undefined });
    }
    if (vis.onResize) { vis.onResize(640, 240); }
    window.__vis = vis;
    window.__scope = scope;
}

async function page() {
    console.log('');
    console.log(C.bold + 'Overview symbols on a mock PI Web API (built files)' + C.reset);
    const { chromium } = require('playwright');
    const server = await serve();
    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launchOpts.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launchOpts);
    try {
        const pg = await browser.newPage();
        const errors = [];
        pg.on('pageerror', (e) => errors.push(e.message));
        const hashFor = (asset, display) => '#/Displays/' + (display || 101) + '/Overview' +
            (asset ? '?asset=' + encodeURIComponent(asset) : '');
        const open = async (typeName, opts) => {
            requests = [];
            await pg.goto('http://127.0.0.1:' + PORT + '/page/' + typeName + hashFor(opts.asset), { waitUntil: 'networkidle' });
            await pg.evaluate(mount, Object.assign({ typeName }, opts));
            await settle();
        };
        // Long enough for a chain of requests and the render after it.
        const settle = () => pg.waitForTimeout(450);
        const hash = () => pg.evaluate(() => decodeURIComponent(location.hash));
        const texts = (sel) => pg.$$eval(sel, (ns) => ns.map((n) => n.textContent.trim()));

        /* ---- Navigation Panel, hierarchy mode -------------------------- */
        const NAV = { Mode: 'hierarchy', Layout: 'wrap', FullWidth: false };
        await open('pvxNavPanel', { asset: K301, config: NAV });
        let labels = await texts('.pvx-nav-body > *');
        check('nav: Up, breadcrumb, then the compressor siblings',
            JSON.stringify(labels) === JSON.stringify(['↑ Up', '|', 'Station 1', '›', 'K-301', '|', 'K-301', 'K-302']), labels);
        check('nav: siblings of the same template only (no Tank 1)', labels.indexOf('Tank 1') === -1);
        check('nav: siblings come from the parent\'s children',
            requests.some((r) => /^GET elements\/We:.*Station 1\/elements\?.*selectedFields=Items.Name;Items.Path;Items.TemplateName/.test(r)), requests);
        let active = await texts('.pvx-nav-btn-active');
        check('nav: the current asset is the active crumb and sibling', JSON.stringify(active) === JSON.stringify(['K-301', 'K-301']), active);

        await pg.click('.pvx-nav-btn-sibling:has-text("K-302")');
        check('nav: a sibling switches the asset and keeps the display', (await hash()) === '#/Displays/101/Overview?asset=' + K302, await hash());
        await pg.waitForTimeout(1300);
        active = await texts('.pvx-nav-btn-active');
        check('nav: follows the asset change without a reload', active.indexOf('K-302') !== -1 && active.indexOf('K-301') === -1, active);

        await open('pvxNavPanel', { asset: K301, config: Object.assign({}, NAV, { LevelDisplays: '1 | 150\n* | 205' }) });
        await pg.click('.pvx-nav-btn-up');
        check('nav: Up goes to the parent, on that level\'s display', (await hash()) === '#/Displays/150?asset=' + S1, await hash());

        await open('pvxNavPanel', { asset: K301, config: Object.assign({}, NAV, { LevelDisplays: '1 | 150\n* | 205' }) });
        await pg.click('.pvx-nav-btn-sibling:has-text("K-302")');
        check('nav: "*" covers a level without a line of its own', /^#\/Displays\/205\?/.test(await hash()), await hash());

        await open('pvxNavPanel', { asset: K301, config: Object.assign({}, NAV, { SiblingsSameTemplate: false }) });
        labels = await texts('.pvx-nav-btn-sibling');
        check('nav: every sibling when the template filter is off', JSON.stringify(labels) === JSON.stringify(['K-301', 'K-302', 'Tank 1']), labels);

        await open('pvxNavPanel', { asset: S1, config: NAV });
        labels = await texts('.pvx-nav-btn-sibling');
        check('nav: a top-level element\'s siblings are the database\'s elements',
            JSON.stringify(labels) === JSON.stringify(['Station 1', 'Station 2']), labels);
        check('nav: ...asked of the database, not an element',
            requests.some((r) => /^GET assetdatabases\/Wd:.*\/elements\?/.test(r)), requests);
        check('nav: Up is disabled at the top', await pg.$eval('.pvx-nav-btn-up', (b) => b.disabled));

        await open('pvxNavPanel', { asset: S1, config: Object.assign({}, NAV, { ShowSiblings: false, ShowChildren: true }) });
        labels = await texts('.pvx-nav-btn-child');
        check('nav: children of the current asset', JSON.stringify(labels) === JSON.stringify(['K-301', 'K-302', 'Tank 1']), labels);

        await open('pvxNavPanel', { asset: K301, config: Object.assign({}, NAV, { TopLevel: 2 }) });
        labels = await texts('.pvx-nav-btn-crumb');
        check('nav: TopLevel hides the levels above it', JSON.stringify(labels) === JSON.stringify(['K-301']), labels);
        check('nav: ...and Up stops there', await pg.$eval('.pvx-nav-btn-up', (b) => b.disabled));

        await open('pvxNavPanel', { asset: K301, config: Object.assign({}, NAV, { MaxSiblings: 1 }) });
        labels = await texts('.pvx-nav-note');
        check('nav: more siblings than allowed is said, not hidden', labels.some((l) => /First 1 siblings/.test(l)), labels);

        await open('pvxNavPanel', { asset: S1 + '\\Gone\\K-399', config: NAV });
        labels = await texts('.pvx-nav-note');
        check('nav: a missing asset says why there are no siblings', labels.some((l) => /No siblings/.test(l)), labels);
        const tip = await pg.$eval('.pvx-nav-note', (n) => n.title);
        check('nav: ...with the cause in the tooltip', /no AF element/.test(tip), tip);

        await open('pvxNavPanel', { asset: K301, config: NAV, configured: false });
        labels = await texts('.pvx-nav-body > *');
        check('nav: without PI Web API, Up and the breadcrumb still work',
            labels.indexOf('↑ Up') === 0 && labels.indexOf('K-301') !== -1, labels);
        check('nav: ...and it says what is missing', labels.some((l) => /need PI Web API/.test(l)), labels);

        await open('pvxNavPanel', { asset: '', config: NAV, source: 'af:\\\\AF\\Gathering\\Station 2\\K-303|Status?x' });
        labels = await texts('.pvx-nav-btn-crumb');
        check('nav: with no URL asset, the data source\'s element is the start',
            JSON.stringify(labels) === JSON.stringify(['Station 2', 'K-303']), labels);

        /* ---- Asset Table, search mode ---------------------------------- */
        const COLS = 'Discharge Pressure | Disch | 0:#2f9e5f:Normal, 1100:#c8452f:High\nVibration | Vib\nStatus | | states | label';
        const AT = { RowSource: 'search', ColumnSpec: COLS, SearchTemplate: 'Compressor', CellStyle: 'fill' };
        await open('pvxAssetTable', { asset: S1, config: AT });
        let rows = await texts('.pvx-atable-name');
        check('table: one row per compressor under the asset', JSON.stringify(rows) === JSON.stringify(['K-301', 'K-302']), rows);
        let heads = await texts('th');
        check('table: headers from the column list', JSON.stringify(heads) === JSON.stringify(['', 'Asset', 'Disch', 'Vib', 'Status']), heads);
        let cells = await texts('.pvx-atable-cell');
        check('table: values with units, states as their names',
            /^1,081(\.0+)? psig$/.test(cells[0]) && /^3\.90? mils$/.test(cells[1]) && cells[2] === 'Running' &&
            /^1,169(\.0+)? psig$/.test(cells[3]) && cells[5] === 'Fault', cells);
        const fills = await pg.$$eval('.pvx-atable-cell', (ns) => ns.map((n) => n.style.backgroundColor));
        check('table: a column\'s own bands colour it', fills[0] === 'rgb(47, 158, 95)' && fills[3] === 'rgb(200, 69, 47)', fills);
        check('table: no bands, no colour', fills[1] === '' && fills[4] === '', fills);
        check('table: states coloured by the state map', fills[5] === 'rgb(200, 69, 47)', fills);
        const dots = await pg.$$eval('.pvx-atable-statusdot', (ns) => ns.map((n) => n.title));
        check('table: the status dot names the worst cell', /^Status: Fault$|^Disch: High$/.test(dots[1]), dots);
        check('table: elements searched under the asset with the template',
            requests.some((r) => /^GET elements\/We:.*Station 1\/elements\?.*templateName=Compressor/.test(r)), requests);
        check('table: attributes and values read in batches, not one request per cell',
            requests.filter((r) => r === 'POST batch').length === 2 &&
            !requests.some((r) => /^GET (attributes|streams)/.test(r)), requests);

        await open('pvxAssetTable', { asset: S2, config: AT });
        cells = await texts('.pvx-atable-cell');
        check('table: an element without an attribute shows a dash',
            /^950(\.0+)? psig$/.test(cells[0]) && cells[1] === '\u2014' && cells[2] === 'Stopped', cells);
        const missTip = await pg.$$eval('.pvx-atable-cell', (ns) => ns[1].title);
        check('table: ...and its tooltip says which attribute is missing', /K-303 has no Vibration attribute/.test(missTip), missTip);

        await open('pvxAssetTable', { asset: S1, config: Object.assign({}, AT, { SearchTemplate: '' }) });
        rows = await texts('.pvx-atable-name');
        check('table: without a template every child is a row', JSON.stringify(rows) === JSON.stringify(['K-301', 'K-302', 'Tank 1']), rows);

        await open('pvxAssetTable', { asset: S1, config: Object.assign({}, AT, { MaxRows: 1 }) });
        const foot = (await texts('.pvx-atable-footer'))[0];
        check('table: more elements than Most rows is said in the footer', /First 1 elements/.test(foot), foot);

        await open('pvxAssetTable', { asset: S1, config: Object.assign({}, AT, { SortBy: 'worst' }) });
        rows = await texts('.pvx-atable-name');
        check('table: worst status first', JSON.stringify(rows) === JSON.stringify(['K-302', 'K-301']), rows);

        await open('pvxAssetTable', { asset: S1, config: Object.assign({}, AT, { ClickAction: 'navigate', NavigateTarget: '300' }) });
        await pg.click('.pvx-atable-row:has-text("K-302")');
        check('table: a row opens the target display with that element', (await hash()) === '#/Displays/300?asset=' + K302, await hash());

        await open('pvxAssetTable', { asset: S1, config: AT });
        await pg.evaluate((h) => { location.hash = h; }, hashFor(S2));
        await pg.waitForTimeout(1600);
        rows = await texts('.pvx-atable-name');
        check('table: follows an asset swap to an area with other units', JSON.stringify(rows) === JSON.stringify(['K-303']), rows);

        await open('pvxAssetTable', { asset: S1, config: Object.assign({}, AT, { ColumnSpec: '' }) });
        let msg = (await texts('.pvx-atable-message'))[0] || '';
        check('table: search mode with no columns says what to list', /List the attributes/.test(msg), msg);

        await open('pvxAssetTable', { asset: S1 + '\\Nowhere', config: AT });
        msg = (await texts('.pvx-atable-message'))[0] || '';
        check('table: a missing root is named', /no AF element at/.test(msg) && /Search root/.test(msg), msg);

        await open('pvxAssetTable', { asset: S1, config: AT, configured: false });
        msg = (await texts('.pvx-atable-message'))[0] || '';
        check('table: unconfigured names pvx-config.js and the check page',
            /pvx-config\.js/.test(msg) && /piwebapi-check\.html/.test(msg), msg);

        /* ---- Asset Table, data sources --------------------------------- */
        const row = (p, v, u) => ({ Label: p, Path: p, Value: v, Units: u || '', IsGood: true, Summary: [{ Value: v }] });
        await open('pvxAssetTable', { asset: '', config: { RowSource: 'sources' }, rows: [
            row('af:\\\\AF\\Gathering\\Station 1\\K-301|Discharge Pressure?a', 1081, 'psig'),
            row('af:\\\\AF\\Gathering\\Station 2\\K-301|Discharge Pressure?b', 990, 'psig'),
            row('af:\\\\AF\\Gathering\\Station 1\\K-301|Vibration?c', 3.9, 'mils'),
            row('pi:\\\\PISRV01\\SINUSOID?d', 50)
        ] });
        rows = await texts('.pvx-atable-name');
        check('table: two elements with one name show their parents',
            JSON.stringify(rows) === JSON.stringify(['Station 1 › K-301', 'Station 2 › K-301']), rows);
        const foot2 = (await texts('.pvx-atable-footer'))[0];
        check('table: a PI point is named, not dropped', /1 PI point source not shown/.test(foot2), foot2);
        check('table: no PI Web API request in data source mode', requests.filter((r) => !/^GET (dist|dev)/.test(r)).length === 0, requests);

        /* ---- Event Timeline scoped to the asset ------------------------ */
        const EG = { DatabasePath: DB, AssetScope: 'asset', StartOffset: '*-1d' };
        await open('pvxEventGantt', { asset: K301, config: EG });
        let body = await pg.$eval('#box', (n) => n.textContent);
        check('timeline: the asset\'s own events', /K-301 trip/.test(body) && /Seal leak/.test(body) && !/K-302 high/.test(body), body.slice(0, 200));
        check('timeline: asked of the element, not the whole database',
            requests.some((r) => /^GET elements\/We:.*K-301\/eventframes\?/.test(r)) &&
            !requests.some((r) => /^GET assetdatabases\/Wd:[^?]*\/eventframes/.test(r)), requests);

        await open('pvxEventGantt', { asset: S1, config: Object.assign({}, EG, { AssetScope: 'assetTree' }) });
        body = await pg.$eval('#box', (n) => n.textContent);
        check('timeline: the asset and everything under it',
            /Station 1 ESD test/.test(body) && /K-301 trip/.test(body) && /K-302 high vibration/.test(body) && !/K-303/.test(body), body.slice(0, 300));
        const seal = await pg.$$eval('#box title', (ns) => ns.filter((n) => /Seal leak/.test(n.textContent)).length);
        check('timeline: an event on two elements is drawn once', seal === 1, seal);
        check('timeline: the tree is asked in one batch', requests.filter((r) => r === 'POST batch').length >= 1, requests);

        await open('pvxEventGantt', { asset: S1, config: Object.assign({}, EG, { AssetScope: 'assetTree', MaxScopeElements: 1 }) });
        body = await pg.$eval('#box', (n) => n.textContent);
        check('timeline: a capped tree says so', /element/i.test(body) && /(first|cap|limit|more)/i.test(body), body.slice(-200));

        await open('pvxEventGantt', { asset: '', config: EG, source: 'pi:\\\\PISRV01\\SINUSOID?x' });
        body = await pg.$eval('#box', (n) => n.textContent);
        check('timeline: scoped with no asset says what to do', /names no asset/.test(body), body.slice(0, 200));

        /* ---- Event Timeline with nothing configured ---------------------- *
         * No baseUrl, no DatabasePath: PI Web API is found beside PI Vision
         * and the database is the one the dropped attribute lives in.       */
        const BARE = { DatabasePath: '', AssetScope: 'none', StartOffset: '*-1d' };
        await open('pvxEventGantt', { asset: '', config: BARE, configured: 'auto' });
        body = await pg.$eval('#box', (n) => n.textContent);
        check('timeline auto: events from the data source\'s database, with no setup',
            /K-301 trip/.test(body) && /K-303 start/.test(body) &&
            requests.some((r) => r === 'GET assetdatabases?path=' + DB), requests.slice(0, 4));
        check('timeline auto: the footer says where the database came from',
            body.indexOf('database ' + DB + ' from this symbol\'s data source') !== -1, body.slice(-200));

        await open('pvxEventGantt', { asset: K303, config: BARE, configured: 'auto', source: 'pi:\\\\PISRV01\\SINUSOID?x' });
        body = await pg.$eval('#box', (n) => n.textContent);
        check('timeline auto: a PI point source falls back to the display\'s asset',
            /K-303 start/.test(body) && body.indexOf('from the display\'s asset') !== -1, body.slice(-200));

        await open('pvxEventGantt', { asset: '', config: BARE, configured: 'auto', source: 'pi:\\\\PISRV01\\SINUSOID?x' });
        body = await pg.$eval('#box', (n) => n.textContent);
        check('timeline auto: no AF anywhere says how to give it a database',
            /No AF database configured/.test(body) && /Drop an AF attribute/.test(body), body.slice(0, 200));

        await open('pvxEventGantt', { asset: '', config: Object.assign({}, BARE, { DatabasePath: '\\\\AF\\Elsewhere' }), configured: 'auto' });
        body = await pg.$eval('#box', (n) => n.textContent);
        check('timeline auto: a typed database still wins over the data source',
            requests.some((r) => r === 'GET assetdatabases?path=\\\\AF\\Elsewhere') &&
            !requests.some((r) => r === 'GET assetdatabases?path=' + DB), requests.slice(0, 4));

        await open('pvxEventAnalytics', { asset: '', config: { DatabasePath: '', StartTime: '*-1d' }, configured: 'auto' });
        body = await pg.$eval('#box', (n) => n.textContent);
        check('analytics auto: the data source\'s database, said in the footer',
            requests.some((r) => r === 'GET assetdatabases?path=' + DB) &&
            body.indexOf('database ' + DB + ' from this symbol\'s data source') !== -1, body.slice(-200));

        /* ---- Asset Navigator --------------------------------------------- *
         * Nothing configured: PI Web API beside PI Vision, the database the
         * dropped attribute lives in. Then the ways it used to sit on
         * "Loading the AF hierarchy..." for good on a live server.          */
        const TREE = { DatabasePath: '', RootElementPath: '', Height: 240, Width: 640 };
        await open('pvxAssetTree', { asset: '', config: TREE, configured: 'auto' });
        await settle();
        body = await pg.$eval('#box', (n) => n.textContent);
        check('tree auto: the hierarchy loads with no setup', /Station 1/.test(body) && /Station 2/.test(body), body.slice(0, 200));

        await open('pvxAssetTree', { asset: '', config: TREE, hang: true, timeoutMs: 400 });
        body = await pg.$eval('#box', (n) => n.textContent);
        check('tree: loading says what it is waiting on',
            /Loading the AF hierarchy/.test(body) && body.indexOf('Asking PI Web API at ') !== -1 && body.indexOf(DB) !== -1,
            body.slice(0, 200));
        await pg.waitForTimeout(6200);
        body = await pg.$eval('#box', (n) => n.textContent);
        check('tree: a load that never settles stops and names the step',
            /Stopped waiting for PI Web API/.test(body) && /No answer after \d+ s while asking PI Web API/.test(body),
            body.slice(0, 240));

        await open('pvxAssetTree', { asset: '', config: TREE, staleCore: true });
        const fatal = await pg.evaluate(() => ({ threw: window.__initThrew || '',
            text: (document.querySelector('#box .pvx-fatal') || {}).textContent || '' }));
        check('register: a symbol that throws in init does not throw to PI Vision', fatal.threw === '', fatal.threw);
        check('register: ...and says so on the symbol', /could not start/.test(fatal.text) && /\[PVX\]/.test(fatal.text), fatal.text);
        // Its later refreshes hit the same missing function from a timer,
        // where they are only console noise: expected here, so not counted.
        for (let i = errors.length - 1; i >= 0; i--) {
            if (/defaultDatabase is not a function/.test(errors[i])) { errors.splice(i, 1); }
        }

        await open('pvxAssetTree', { asset: '', config: TREE, coreVersion: '1.0.0' });
        const mixed = await pg.evaluate(() => (document.querySelector('#box .pvx-fatal') || {}).textContent || '');
        check('register: files from two releases are named as such',
            /two different releases/.test(mixed) && mixed.indexOf('is 1.0.0') !== -1, mixed);

        /* ---- text size -------------------------------------------------- */
        await open('pvxNavPanel', { asset: K301, config: Object.assign({}, NAV, { TextScale: '150' }) });
        const z = await pg.evaluate(() => {
            const root = document.querySelector('#box .pvx');
            const host = document.querySelector('#box .pvx-nav-body');
            return { zoom: root.style.zoom, w: host.clientWidth, box: document.getElementById('box').clientWidth,
                screen: Math.round(root.getBoundingClientRect().width) };
        });
        check('text: the symbol root is zoomed', z.zoom === '1.5', z);
        check('text: the zoomed root still fills the symbol', Math.abs(z.screen - z.box) <= 1, z);
        check('text: the symbol lays out for a box 1/k as wide', Math.abs(z.w * 1.5 - z.box) <= 12, z);

        await pg.evaluate(() => { window.__scope.config.TextScale = '100'; window.__vis.onConfigChange(window.__scope.config, {}); });
        await settle();
        const z2 = await pg.evaluate(() => document.querySelector('#box .pvx').style.zoom);
        check('text: back to 100% removes the zoom', z2 === '', z2);

        check('no page errors', errors.length === 0, errors);
    } finally {
        await browser.close();
        server.close();
    }
}

(async () => {
    try {
        rules();
        await page();
    } catch (e) {
        failures += 1;
        console.error(C.red + 'test-overview crashed: ' + (e.stack || e.message) + C.reset);
    }
    console.log('');
    console.log((failures ? C.red + C.bold + failures + ' failed' : C.green + C.bold + 'all ' + passes + ' passed') + C.reset);
    process.exit(failures ? 1 : 0);
})();
