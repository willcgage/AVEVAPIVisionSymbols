#!/usr/bin/env node
/* ============================================================================
 * PVX per-attribute settings test — Data Health's instrument ranges and
 * update overrides chosen as rows instead of typed as a grammar string.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-tags.js
 *
 * Two halves:
 *
 *   rules    PVX.tags in plain Node: both grammars round-trip, rows write the
 *            string a saved display depends on, bad rows are flagged and left
 *            out, and the labels a symbol shows are offered.
 *   pane     the BUILT Data Health pane in real Chromium: one row per entry,
 *            the attribute list offers the symbol's labels, editing a row
 *            rewrites the stored key and the symbol's verdict, Edit as text
 *            round-trips, and Fill from PI reads spans from a mock PI Web API
 *            (AF Minimum/Maximum limit traits, else PI point Zero/Span).
 *
 * The PI Web API lookup is proven against this mock only, not yet a server.
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
const CORE = path.join(ROOT, 'dist', 'ext', 'libraries', 'pvx', 'pvx-core.js');
const PORT = 31799;

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

/* --------------------------------------------------------- mock PI Web API */

const BASE = 'http://127.0.0.1:' + PORT + '/piwebapi';
// K-301 Vibration has AF limit traits; Suction Pressure has none, so its
// span comes from the PI point behind it; Pump 1 Amps has neither; Status
// sits on a digital point, whose Zero/Span count states and must not be used.
const ATTRS = {
    '\\\\afsrv\\db\\k-301|vibration 1x': { Name: 'Vibration 1X', WebId: 'A:vib', Links: { Point: BASE + '/points/P:vib' } },
    '\\\\afsrv\\db\\k-301|suction pressure': { Name: 'Suction Pressure', WebId: 'A:suct', Links: { Point: BASE + '/points/P:suct' } },
    '\\\\afsrv\\db\\k-301|status': { Name: 'Status', WebId: 'A:stat', Links: { Point: BASE + '/points/P:stat' } },
    '\\\\afsrv\\db\\pump 1|amps': { Name: 'Amps', WebId: 'A:amps', Links: {} }
};
const TRAITS = { 'A:vib': { Minimum: 'T:vibmin', Maximum: 'T:vibmax' } };
const VALUES = { 'T:vibmin': 0, 'T:vibmax': 20 };
const POINTS = {
    'P:vib': { Name: 'K301.VIB', WebId: 'P:vib', PointType: 'Float32', zero: 0, span: 50 },
    'P:suct': { Name: 'K301.SUCT', WebId: 'P:suct', PointType: 'Float32', zero: -5, span: 155.1 },
    'P:stat': { Name: 'K301.STAT', WebId: 'P:stat', PointType: 'Digital', zero: 0, span: 4 },
    'P:flow': { Name: 'FLOW', WebId: 'P:flow', PointType: 'Float64', zero: 0.1, span: 0.2 }
};
const POINT_PATHS = { '\\\\pisrv\\flow': 'P:flow' };

let requests = [];

function api(req, res, url) {
    const u = new URL(url, 'http://x');
    const q = u.searchParams;
    const rel = decodeURIComponent(u.pathname).replace(/^\/piwebapi\/?/, '');
    requests.push(rel + (q.toString() ? '?' + q.toString() : ''));
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = (q.get('path') || '').toLowerCase();
    if (rel === 'attributes' && ATTRS[p]) { return send(200, ATTRS[p]); }
    if (rel === 'points' && POINT_PATHS[p]) { return send(200, POINTS[POINT_PATHS[p]]); }
    let m = /^attributes\/([^/]+)\/attributes$/.exec(rel);
    if (m) {
        const t = (TRAITS[m[1]] || {})[q.get('trait')];
        return send(200, { Items: t ? [{ Name: q.get('trait'), WebId: t }] : [] });
    }
    m = /^streams\/([^/]+)\/value$/.exec(rel);
    if (m && VALUES[m[1]] !== undefined) { return send(200, { Timestamp: '2026-10-26T00:00:00Z', Value: VALUES[m[1]], Good: true }); }
    m = /^points\/([^/]+)$/.exec(rel);
    if (m && POINTS[m[1]]) { return send(200, POINTS[m[1]]); }
    m = /^points\/([^/]+)\/attributes\/(zero|span)$/.exec(rel);
    if (m && POINTS[m[1]]) { return send(200, { Name: m[2], Value: POINTS[m[1]][m[2]] }); }
    send(404, { Errors: ['Not found: ' + rel + ' ' + (q.get('path') || '')] });
}

/* ------------------------------------------------------------------ rules */

function loadCore() {
    const win = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(fs.readFileSync(CORE, 'utf8'), win, { filename: 'pvx-core.js' });
    return win.PVX;
}

function rules() {
    console.log('');
    console.log(C.bold + 'PVX.tags rules' + C.reset);
    const PVX = loadCore();
    const T = PVX.tags;

    const r = T.parse('K-301 Vibration 1X: 0..20\nSuction: -5 .. 1.5e2, Area: West|Flow: 10..0, junk, Bad: 5', 'range');
    check('range: label, low, high; one per line or comma separated', r.length === 5 &&
        r[0].label === 'K-301 Vibration 1X' && r[0].lo === 0 && r[0].hi === 20 && r[0].valid, r[0]);
    check('range: negatives, spaces and exponents read', r[1].lo === -5 && r[1].hi === 150, r[1]);
    check('range: the LAST colon splits, so a label may hold one', r[2].label === 'Area: West|Flow' && r[2].valid, r[2]);
    check('range: written order is kept (the symbol takes min and max)', r[2].lo === 10 && r[2].hi === 0, r[2]);
    check('range: an entry with no value, or a lone number, is kept but invalid',
        !r[3].valid && r[3].label === 'junk' && !r[4].valid, [r[3], r[4]]);
    check('range: stringify writes what parse reads',
        T.stringify(r.filter((e) => e.valid), 'range') === 'K-301 Vibration 1X: 0..20, Suction: -5..150, Area: West|Flow: 10..0');

    const m = T.parse('Lab Density: 1440, Daily Total: 0, Odd: -3, Gone:', 'minutes');
    check('minutes: a number of minutes, 0 allowed', m[0].minutes === 1440 && m[1].minutes === 0 && m[1].valid, m);
    check('minutes: negative or missing is invalid', !m[2].valid && !m[3].valid, m);
    check('minutes round-trips', T.stringify(m.slice(0, 2), 'minutes') === 'Lab Density: 1440, Daily Total: 0');

    check('labelsIn: TimeSeries labels in source order',
        T.labelsIn({ Data: [{ Label: 'A' }, { Label: ' B ' }, {}] }).join('/') === 'A/B/');

    const scope = { config: { Ranges: 'Pump 1|Amps: 0..80' }, symbol: { DataSources: [] } };
    const mod = T.bind(scope);
    check('bind publishes on runtimeData', scope.runtimeData.pvxTags === mod);
    const ed = mod.use('Ranges', 'range');
    ed.sync(scope.config.Ranges);
    check('one row per entry', ed.rows.length === 1 && ed.rows[0].hi === 80, ed.rows);
    mod.observe({ Data: [{ Label: 'Pump 1|Amps' }, { Label: 'Pump 1|Flow' }] });
    check('the symbol\'s labels are offered first',
        ed.options().map((o) => o.name + '/' + o.group).join() === 'Pump 1|Amps/Attributes on this symbol,Pump 1|Flow/Attributes on this symbol',
        ed.options());
    check('options are the same array until something changes', ed.options() === ed.options());
    ed.add(scope.config);
    check('Add takes the next label without a row, and waits for its span',
        ed.rows[1].label === 'Pump 1|Flow' && ed.rows[1].invalid && scope.config.Ranges === 'Pump 1|Amps: 0..80', ed.rows[1]);
    ed.rows[1].lo = 0; ed.rows[1].hi = 400;
    ed.commit(scope.config);
    check('a complete row is written', scope.config.Ranges === 'Pump 1|Amps: 0..80, Pump 1|Flow: 0..400', scope.config.Ranges);
    ed.rows[0].label = 'Pump 1, Amps';
    ed.commit(scope.config);
    check('a label with a comma is flagged and not written', ed.hasSeparator() && scope.config.Ranges === 'Pump 1|Flow: 0..400',
        scope.config.Ranges);
    ed.rows[0].label = 'pump 1|flow';
    ed.commit(scope.config);
    check('a label listed twice is flagged', ed.hasDuplicate());
    ed.rows[0].label = 'Old Tag';
    ed.commit(scope.config);
    check('a label the symbol does not show is flagged and grouped apart', ed.hasUnknown() &&
        ed.options().some((o) => o.name === 'Old Tag' && o.group === 'Not on this symbol'));
    check('the editor does not reload what it wrote', ed.sync(scope.config.Ranges) && ed.rows.length === 2);
    ed.sync('X: 1..2');
    check('a string changed elsewhere comes back as rows', ed.rows.length === 1 && ed.rows[0].label === 'X');

    const ov = mod.use('UpdateOverrides', 'minutes');
    ov.sync('');
    ov.add(scope.config);
    check('a new override starts at 0 minutes (excluded)', scope.config.UpdateOverrides === 'Pump 1|Amps: 0', scope.config.UpdateOverrides);
    check('each key has its own editor', mod.use('Ranges', 'range') === ed && ov !== ed);
}

/** Runs in the browser: the span lookup against the mock. */
async function lookups(base) {
    const T = window.PVX.tags;
    window.PVX.api.configure({ baseUrl: base, auth: 'anonymous' });
    const why = (e) => (e && e.pvxError && e.pvxError.message) || (e && e.message) || 'rejected';
    const out = {};
    out.traits = await T.lookupSpan('af:\\\\AFSRV\\DB\\K-301|Vibration 1X?1');
    out.viaPoint = await T.lookupSpan('af:\\\\AFSRV\\DB\\K-301|Suction Pressure?2');
    out.digital = await T.lookupSpan('af:\\\\AFSRV\\DB\\K-301|Status?3');
    out.none = await T.lookupSpan('af:\\\\AFSRV\\DB\\Pump 1|Amps?4');
    out.pi = await T.lookupSpan('pi:\\\\PISRV\\FLOW?5');
    out.missing = await T.lookupSpan('pi:\\\\PISRV\\MISSING?6').then(() => '', why);
    out.again = await T.lookupSpan('af:\\\\AFSRV\\DB\\K-301|Vibration 1X?1');
    return out;
}

async function lookupChecks(page) {
    console.log('');
    console.log(C.bold + 'Span lookup (mock PI Web API)' + C.reset);
    await page.goto('http://127.0.0.1:' + PORT + '/page/pvxDataHealth', { waitUntil: 'networkidle' });
    requests = [];
    const r = await page.evaluate(lookups, 'http://127.0.0.1:' + PORT + '/piwebapi');
    check('AF attribute: Minimum/Maximum limit traits win over the point',
        r.traits && r.traits.lo === 0 && r.traits.hi === 20 && /AF/.test(r.traits.from), r.traits);
    check('AF attribute with no traits: its PI point Zero..Zero+Span',
        r.viaPoint && r.viaPoint.lo === -5 && r.viaPoint.hi === 150.1 && /Zero\/Span/.test(r.viaPoint.from), r.viaPoint);
    check('a digital point gives no span', r.digital === null, r.digital);
    check('no traits and no point: no span', r.none === null, r.none);
    check('PI point: Zero+Span without float noise', r.pi && r.pi.lo === 0.1 && r.pi.hi === 0.3, r.pi);
    check('a source PI Web API cannot find rejects, with a reason', !!r.missing, r.missing);
    check('a span is read once per page',
        requests.filter((q) => /^attributes\?path=.*Vibration/i.test(q)).length === 1, requests);
}

/* ------------------------------------------------------------------- pane */

function pageHtml(typeName) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
</head><body><div id="box" style="width:440px;height:300px"></div><div id="pane" style="width:260px"></div>
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
            if (req.url.indexOf('/piwebapi') === 0) { api(req, res, req.url); return; }
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

/** Runs in the browser: mount symbol + pane, feed one data update. */
async function mount(a) {
    window.PVX.api.configure({ baseUrl: a.configured === false ? '' : location.origin + '/piwebapi', auth: 'anonymous' });
    const def = window.PVMock.get(a.typeName);
    const injector = angular.injector(['ng']);
    const $compile = injector.get('$compile');
    const scope = injector.get('$rootScope').$new(true);
    scope.config = def.getDefaultConfig();
    Object.keys(a.config || {}).forEach((k) => { scope.config[k] = a.config[k]; });
    scope.runtimeData = { isEditMode: true };
    scope.symbol = { Name: a.typeName, DataSources: a.sources };
    const tpl = await fetch('/dist/ext/sym-' + a.typeName + '-template.html').then((r) => r.text());
    const host = document.createElement('div');
    host.style.cssText = 'width:100%;height:100%';
    document.getElementById('box').appendChild(host);
    const el = angular.element(host).append($compile(tpl)(scope));
    const vis = new def.visObjectType();
    vis.init(scope, el, undefined);
    // Fresh events up to now on every tag, so only the range check can fire.
    const now = Date.now();
    const series = (label, v) => ({ Label: label, Path: label, Value: [0, 1, 2, 3].map((i) => ({
        Time: new Date(now - (3 - i) * 60000).toISOString(), Value: v + i * 0.5 })) });
    vis.onDataUpdate({ EndTime: new Date(now).toISOString(), Data: a.labels.map((l, i) => series(l, a.values[i])) });
    const cfg = await fetch('/dist/ext/sym-' + a.typeName + '-config.html').then((r) => r.text());
    angular.element(document.getElementById('pane')).append($compile(cfg)(scope));
    scope.$digest();
    window.__scope = scope;
    window.__vis = vis;
}

async function pane() {
    const { chromium } = require('playwright');
    const server = await serve();
    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launchOpts.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launchOpts);
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const cfg = (k) => page.evaluate((key) => window.__scope.config[key], k);
        // PI Vision calls onConfigChange after a pane edit; the harness has to.
        const flagged = async () => {
            await page.evaluate(() => window.__vis.onConfigChange(window.__scope.config));
            await page.waitForTimeout(80);
            return page.evaluate(() => Array.prototype.map.call(
                document.querySelectorAll('#box .pvx-health-row'), (r) => r.textContent.replace(/\s+/g, ' ').trim()));
        };

        await lookupChecks(page);
        console.log('');
        console.log(C.bold + 'Data Health pane (built)' + C.reset);

        const labels = ['K-301|Vibration 1X', 'K-301|Suction Pressure', 'K-301|Status', 'Pump 1|Amps'];
        const sources = ['af:\\\\AFSRV\\DB\\K-301|Vibration 1X?1', 'af:\\\\AFSRV\\DB\\K-301|Suction Pressure?2',
            'af:\\\\AFSRV\\DB\\K-301|Status?3', 'af:\\\\AFSRV\\DB\\Pump 1|Amps?4'];
        requests = [];
        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxDataHealth', { waitUntil: 'networkidle' });
        await page.evaluate(mount, { typeName: 'pvxDataHealth', sources, labels, values: [25, 40, 1, 30],
            config: { Ranges: 'Pump 1|Amps: 0..80', UpdateOverrides: 'Lab Density: 1440' } });
        await page.waitForTimeout(80);

        const ranges = page.locator('.pvx-cfg-tags-range .pvx-cfg-tg-row');
        const overs = page.locator('.pvx-cfg-tags-minutes .pvx-cfg-tg-row');
        check('no grammar text boxes by default',
            await page.locator('textarea[ng-model="config.Ranges"], textarea[ng-model="config.UpdateOverrides"]').count() === 0);
        check('nothing is asked of PI Web API until Fill from PI is pressed', requests.length === 0, requests);
        check('one row per saved entry in each editor', await ranges.count() === 1 && await overs.count() === 1,
            [await ranges.count(), await overs.count()]);
        const sel = ranges.nth(0).locator('select.pvx-cfg-tg-label');
        check('the attribute is a list, showing the saved label', await sel.count() === 1 &&
            await sel.evaluate((s) => s.options[s.selectedIndex].text) === 'Pump 1|Amps');
        const groups = await sel.evaluate((s) => Array.prototype.map.call(s.querySelectorAll('optgroup'),
            (g) => g.label + ':' + Array.prototype.map.call(g.children, (o) => o.text).join('/')));
        check('the list offers the labels the symbol shows', groups[0] ===
            'Attributes on this symbol:K-301|Vibration 1X/K-301|Suction Pressure/K-301|Status/Pump 1|Amps', groups);
        check('an override for a tag not on the symbol is shown apart, and flagged',
            await overs.nth(0).locator('optgroup[label="Not on this symbol"]').count() === 1 &&
            /Not on this symbol/.test(await page.locator('.pvx-cfg-tags-minutes').textContent()));
        check('Low and High show the saved span', await ranges.nth(0).locator('.pvx-cfg-tg-lo').inputValue() === '0' &&
            await ranges.nth(0).locator('.pvx-cfg-tg-hi').inputValue() === '80');
        check('the symbol finds nothing out of range yet', !(await flagged()).some((t) => /Out of range/.test(t)), await flagged());

        await ranges.nth(0).locator('.pvx-cfg-tg-hi').fill('20');
        check('editing High rewrites Ranges', await cfg('Ranges') === 'Pump 1|Amps: 0..20', await cfg('Ranges'));
        await page.waitForTimeout(80);
        check('...and the symbol flags the tag above its span',
            (await flagged()).some((t) => /Pump 1\|Amps/.test(t) && /Above span 0/.test(t)), await flagged());

        await page.locator('.pvx-cfg-tags-minutes').locator('select.pvx-cfg-tg-label').selectOption({ label: 'K-301|Status' });
        await overs.nth(0).locator('.pvx-cfg-tg-min').fill('0');
        check('choosing an attribute and minutes rewrites UpdateOverrides', await cfg('UpdateOverrides') === 'K-301|Status: 0',
            await cfg('UpdateOverrides'));
        check('0 minutes says the tag is not checked', /not checked/.test(await overs.nth(0).textContent()));

        await page.locator('.pvx-cfg-tags-minutes').locator('..').locator('.pvx-cfg-band-add').click();
        check('Add attribute takes the next label without a row', await cfg('UpdateOverrides') ===
            'K-301|Status: 0, K-301|Vibration 1X: 0', await cfg('UpdateOverrides'));
        await overs.nth(1).locator('.pvx-cfg-band-x').click();
        check('the x removes that row', await overs.count() === 1 && await cfg('UpdateOverrides') === 'K-301|Status: 0');

        await page.locator('.pvx-cfg-tg-fill').click();
        await page.waitForFunction(() => !window.__scope.runtimeData.pvxTags.busy);
        await page.waitForTimeout(50);
        check('Fill from PI adds spans for attributes without a row, leaving the saved row alone',
            await cfg('Ranges') === 'Pump 1|Amps: 0..20, K-301|Vibration 1X: 0..20, K-301|Suction Pressure: -5..150.1',
            await cfg('Ranges'));
        const note = await page.locator('.pvx-cfg-tags-range .pvx-cfg-hint').allTextContents().then((t) => t.join(' '));
        check('the note says where each span came from and which have none',
            /Added 2 from PI/.test(note) && /AF Minimum\/Maximum limits/.test(note) && /Zero\/Span/.test(note) &&
            /K-301\|Status/.test(note) && /left as they are/.test(note), note);
        check('Fill from PI asked nothing for the row already set',
            !requests.some((q) => /Pump 1\|Amps/i.test(q)), requests);
        await page.waitForTimeout(80);
        check('the filled span takes effect: 25 is above Vibration 1X\'s 0..20',
            (await flagged()).some((t) => /Vibration 1X/.test(t) && /Above span/.test(t)), await flagged());

        await page.locator('.pvx-cfg-tags-range').locator('button', { hasText: 'Edit as text' }).click();
        const box = page.locator('textarea[ng-model="config.Ranges"]');
        check('Edit as text shows the grammar', await box.count() === 1 && await box.inputValue() === await cfg('Ranges'));
        await box.fill('K-301|Suction Pressure: 0..30');
        await page.locator('button', { hasText: 'Back to fields' }).click();
        check('text edits come back as rows', await ranges.count() === 1 &&
            await ranges.nth(0).locator('.pvx-cfg-tg-hi').inputValue() === '30', await ranges.count());

        // A site with no PI Web API: the rows still work, and Fill says why it cannot.
        requests = [];
        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxDataHealth', { waitUntil: 'networkidle' });
        await page.evaluate(mount, { typeName: 'pvxDataHealth', sources, labels, values: [1, 1, 1, 1], config: {}, configured: false });
        await page.waitForTimeout(50);
        await page.locator('.pvx-cfg-tg-fill').click();
        await page.waitForTimeout(50);
        check('without PI Web API, Fill from PI says so and asks nothing',
            requests.length === 0 && /not set up for this site/.test(await page.locator('.pvx-cfg-tags-range').textContent()), requests);

        check('no page errors', errors.length === 0, errors);
    } finally {
        await browser.close();
        server.close();
    }
}

(async () => {
    try {
        rules();
        await pane();
    } catch (e) {
        failures += 1;
        console.error(C.red + 'test-tags crashed: ' + (e.stack || e.message) + C.reset);
    }
    console.log('');
    console.log((failures ? C.red + C.bold + failures + ' failed' : C.green + C.bold + 'all ' + passes + ' passed') + C.reset);
    process.exit(failures ? 1 : 0);
})();
