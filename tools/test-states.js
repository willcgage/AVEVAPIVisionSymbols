#!/usr/bin/env node
/* ============================================================================
 * PVX state map test — digital state maps chosen from a list in a format
 * pane instead of typed as a grammar string.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-states.js
 *
 * Two halves:
 *
 *   rules    PVX.states in plain Node: the three grammars round-trip, rows
 *            write the string a saved display depends on, live data yields
 *            its states, and a source's digital set is found through a mock
 *            PI Web API for a PI point and for an AF attribute.
 *   pane     the BUILT format panes in real Chromium: one row per state, the
 *            state list offers the digital set, live states and mapped ones,
 *            choosing, severity, colour, label, add, remove and typing a
 *            state rewrite the stored key, Edit as text round-trips, and a
 *            site with no PI Web API still gets a usable list.
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
const PORT = 31798;

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
const SETS = {
    'ws:PISRV': [{ Name: 'MotorState', WebId: 'E:MotorState' }, { Name: 'Modes', WebId: 'E:Modes' }],
    'E:MotorState': ['Running', 'Stopped', 'Tripped', 'Maintenance'],
    'E:Modes': ['Auto', 'Manual'],
    'E:AFAlarm': ['Normal', 'Hi', 'HiHi']
};
const POINTS = {
    '\\\\pisrv\\pump1.state': { Name: 'PUMP1.STATE', PointType: 'Digital', DigitalSetName: 'MotorState',
        Links: { DataServer: BASE + '/dataservers/ws:PISRV' } },
    '\\\\pisrv\\sinusoid': { Name: 'SINUSOID', PointType: 'Float32', DigitalSetName: '',
        Links: { DataServer: BASE + '/dataservers/ws:PISRV' } }
};
const ATTRS = {
    '\\\\afsrv\\db\\tank 1|alarm': { Name: 'Alarm', Type: 'EnumerationValue', TypeQualifier: 'AFAlarm',
        Links: { EnumerationValues: BASE + '/enumerationsets/E:AFAlarm/enumerationvalues' } },
    '\\\\afsrv\\db\\tank 1|motor': { Name: 'Motor', Type: 'Int32', TypeQualifier: '',
        Links: { Point: BASE + '/points/P:pump1' } }
};

let requests = [];

function api(req, res, url) {
    const u = new URL(url, 'http://x');
    const q = u.searchParams;
    const rel = decodeURIComponent(u.pathname).replace(/^\/piwebapi\/?/, '');
    requests.push(rel + (q.toString() ? '?' + q.toString() : ''));
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = (q.get('path') || '').toLowerCase();
    if (rel === 'points' && POINTS[p]) { return send(200, POINTS[p]); }
    if (rel === 'points/P:pump1') { return send(200, POINTS['\\\\pisrv\\pump1.state']); }
    if (rel === 'attributes' && ATTRS[p]) { return send(200, ATTRS[p]); }
    let m = /^dataservers\/([^/]+)\/enumerationsets$/.exec(rel);
    if (m && SETS[m[1]]) { return send(200, { Items: SETS[m[1]] }); }
    m = /^enumerationsets\/([^/]+)\/enumerationvalues$/.exec(rel);
    if (m && SETS[m[1]]) { return send(200, { Items: SETS[m[1]].map((n, i) => ({ Name: n, Value: i })) }); }
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
    console.log(C.bold + 'PVX.states rules' + C.reset);
    const PVX = loadCore();
    const S = PVX.states;

    const map = 'Running:#2f9e5f, Stopped:#8a8f96, Fault:#c8452f:Tripped: see log';
    const pm = S.parse(map, 'map');
    check('map: state, colour, label (label may hold colons)',
        pm.length === 3 && pm[2].state === 'Fault' && pm[2].color === '#c8452f' && pm[2].label === 'Tripped: see log', pm);
    check('map round-trips', S.stringify(pm, 'map') === map, S.stringify(pm, 'map'));
    check('colors round-trips', S.stringify(S.parse('Running:#2f9e5f, Stop:red', 'colors'), 'colors') === 'Running:#2f9e5f, Stop:red');
    check('list: any separator reads, commas write',
        S.stringify(S.parse('Running\nOn; Open,Auto', 'list'), 'list') === 'Running, On, Open, Auto');
    check('severity is recovered from a palette colour', S.severityOf('#C8452F') === 'Alarm' && S.severityOf('#123456') === '');

    check('seenIn: Table rows give their non-numeric values',
        S.seenIn({ Rows: [{ Value: 'Running' }, { Value: '12.5' }, { Value: 'Stopped' }, { Value: 'running' }] }).join() === 'Running,Stopped');
    check('seenIn: TimeSeries samples and {Name} states',
        S.seenIn({ Data: [{ Values: [{ Value: 'Auto' }, { Value: { Name: 'Manual', Value: 1 } }, { Value: 3 }] }] }).join() === 'Auto,Manual');
    check('sourcePath strips the scheme and the id', S.sourcePath('pi:\\\\srv\\TAG?12') === '\\\\srv\\TAG');

    // Editor against a fake scope: rows write the stored string.
    const scope = { config: { StateMap: map }, symbol: { DataSources: [] } };
    const mod = S.bind(scope);
    check('bind publishes on runtimeData', scope.runtimeData.pvxStates === mod);
    const ed = mod.use('StateMap', 'map');
    ed.sync(scope.config.StateMap);
    check('one row per entry, severity filled in', ed.rows.length === 3 && ed.rows[0].severity === 'Normal', ed.rows);
    ed.rows[1].severity = 'Warning';
    ed.setSeverity(ed.rows[1], scope.config);
    check('a severity writes its colour', /Stopped:#d99024/.test(scope.config.StateMap), scope.config.StateMap);
    ed.rows[0].label = 'Up, running';
    ed.commit(scope.config);
    check('separators in a label are replaced, not split on', /Running:#2f9e5f:Up running,/.test(scope.config.StateMap), scope.config.StateMap);
    ed.rows[1].state = '';
    ed.commit(scope.config);
    check('a row with no state is left out but kept, flagged',
        ed.rows.length === 3 && ed.hasInvalid() && !/Stopped/.test(scope.config.StateMap), scope.config.StateMap);
    ed.rows[1].state = 'fault';
    ed.commit(scope.config);
    check('a duplicate state is flagged', ed.hasDuplicate());
    check('the editor does not reload what it wrote', ed.sync(scope.config.StateMap) && ed.rows.length === 3);
    ed.sync('A:#000000');
    check('a string changed elsewhere comes back as rows', ed.rows.length === 1 && ed.rows[0].state === 'A');

    mod.observe({ Rows: [{ Value: 'Running' }, { Value: 'Idle' }] });
    check('live states are offered', ed.options().map((o) => o.name + '/' + o.group).join() ===
        'Running/Seen in live data,Idle/Seen in live data,A/Already in this list', ed.options());
    check('options are the same array until something changes', ed.options() === ed.options());

    // bands: a digital state placed in a threshold band.
    const T = PVX.thresholds.parse('0:#2f9e5f:Normal, 70:#d99024:High, 90:#c8452f:Critical');
    check('bands round-trips', S.stringify(S.parse('ALARM:Critical, WARN:1', 'bands'), 'bands') === 'ALARM:Critical, WARN:1');
    check('bandOf: by label, case-insensitive', S.bandOf('critical', T) === 2);
    check('bandOf: by index when no label matches', S.bandOf('1', T) === 1);
    check('bandOf: neither is -1', S.bandOf('Severe', T) === -1 && S.bandOf('7', T) === -1);
    const bm = S.bandMap('ALARM:Critical, Warn:High, Odd:Nope', T);
    check('bandMap: lower-cased states, unresolved left out',
        bm.alarm === 2 && bm.warn === 1 && bm.odd === undefined, bm);
    check('text: a {Name} state reads as its name', S.text({ Name: 'ALARM', Value: 1 }) === 'ALARM' && S.text(null) === '');

    const scope3 = { config: { Thresholds: '0:#2f9e5f:Normal, 70:#d99024:High, 90:#c8452f:Critical', StateBands: 'ALARM:Critical' },
                     symbol: { DataSources: [] } };
    const ed3 = S.bind(scope3).use('StateBands', 'bands');
    ed3.sync(scope3.config.StateBands);
    const bo = ed3.bandOptions(scope3.config.Thresholds);
    check('band options come from Thresholds, stored by label',
        bo.map((b) => b.value).join() === 'Normal,High,Critical' && bo[2].text === 'Critical', bo);
    check('band options are the same array until Thresholds changes', ed3.bandOptions(scope3.config.Thresholds) === bo);
    ed3.add(scope3.config);
    check('a new state starts in the worst band', /, :Critical$|^ALARM:Critical$/.test(scope3.config.StateBands) &&
        ed3.rows[1].band === 'Critical', ed3.rows[1]);
    ed3.rows[1].state = 'TRIP';
    ed3.rows[1].band = 'High';
    ed3.commit(scope3.config);
    check('rows write State:band', scope3.config.StateBands === 'ALARM:Critical, TRIP:High', scope3.config.StateBands);
    check('a band that exists is not flagged', !ed3.unknownBand(scope3.config.Thresholds));
    check('a band removed from Thresholds is flagged', ed3.unknownBand('0:#2f9e5f:Normal, 90:#c8452f:Critical'));

}

/** Runs in the browser: the digital set lookup against the mock. */
async function lookups(base) {
    const S = window.PVX.states;
    window.PVX.api.configure({ baseUrl: base, auth: 'anonymous' });
    const why = (e) => (e && e.pvxError && e.pvxError.message) || (e && e.message) || 'rejected';
    const out = {};
    out.pt = await S.lookupSet('pi:\\\\PISRV\\PUMP1.STATE?1');
    out.num = await S.lookupSet('pi:\\\\PISRV\\SINUSOID?2');
    out.en = await S.lookupSet('af:\\\\AFSRV\\DB\\Tank 1|Alarm?3');
    out.viaPoint = await S.lookupSet('af:\\\\AFSRV\\DB\\Tank 1|Motor?4');
    out.missing = await S.lookupSet('pi:\\\\PISRV\\MISSING?5').then(() => '', why);

    const scope = { config: { StateMap: '' }, symbol: { DataSources: ['pi:\\\\PISRV\\PUMP1.STATE?1', 'pi:\\\\PISRV\\MISSING?2'] } };
    const mod = S.bind(scope);
    const ed = mod.use('StateMap', 'map');
    await mod.load();
    await new Promise((r) => setTimeout(r, 50));
    out.firstGroup = ed.options()[0].group;
    out.note = mod.note;
    ed.add(scope.config);
    ed.add(scope.config);
    out.added = scope.config.StateMap;
    return out;
}

async function lookupChecks(page) {
    console.log('');
    console.log(C.bold + 'Digital state set lookup (mock PI Web API)' + C.reset);
    await page.goto('http://127.0.0.1:' + PORT + '/page/pvxStatusGrid', { waitUntil: 'networkidle' });
    requests = [];
    const r = await page.evaluate(lookups, location0() + '/piwebapi');
    check('PI point: set found by name on its Data Archive',
        r.pt.set === 'MotorState' && r.pt.states.join() === 'Running,Stopped,Tripped,Maintenance', r.pt);
    check('a numeric point has no set', r.num.set === '' && r.num.states.length === 0, r.num);
    check('AF enumeration attribute: its own set', r.en.set === 'AFAlarm' && r.en.states.join() === 'Normal,Hi,HiHi', r.en);
    check('AF attribute on a digital PI point: the point\'s set', r.viaPoint.set === 'MotorState', r.viaPoint);
    check('a source PI Web API cannot find rejects, with a reason', !!r.missing, r.missing);
    check('a set is read once per page',
        requests.filter((q) => /^points\?path=.*PUMP1/i.test(q)).length === 1, requests);
    check('the list leads with the digital set', r.firstGroup === 'Digital state set MotorState', r.firstGroup);
    check('a source that failed is named in the note', /MISSING/.test(r.note), r.note);
    check('Add takes the next unmapped state', r.added === 'Running:#2f9e5f, Stopped:#2f9e5f', r.added);
}

function location0() { return 'http://127.0.0.1:' + PORT; }

/* ------------------------------------------------------------------- pane */

function pageHtml(typeName) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
</head><body><div id="box" style="width:320px;height:200px"></div><div id="pane" style="width:260px"></div>
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
    if (a.data) { vis.onDataUpdate(a.data); }
    const cfg = await fetch('/dist/ext/sym-' + a.typeName + '-config.html').then((r) => r.text());
    angular.element(document.getElementById('pane')).append($compile(cfg)(scope));
    scope.$digest();
    window.__scope = scope;
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
        const open = async (typeName, config, sources, data, configured) => {
            requests = [];
            await page.goto('http://127.0.0.1:' + PORT + '/page/' + typeName, { waitUntil: 'networkidle' });
            await page.evaluate(mount, { typeName, config, sources, data, configured });
            await page.waitForFunction(() => !window.__scope.runtimeData.pvxStates.busy);
            await page.waitForTimeout(50);
        };
        const cfg = (k) => page.evaluate((key) => window.__scope.config[key], k);

        await lookupChecks(page);
        console.log('');
        console.log(C.bold + 'State map editor (built panes)' + C.reset);

        // --- Status Grid: map kind, digital set from PI Web API ---
        await open('pvxStatusGrid', { ColorSource: 'stateMap', StateMap: 'Running:#2f9e5f, Tripped:#c8452f:Trip' },
            ['pi:\\\\PISRV\\PUMP1.STATE?1'], { Rows: [{ Label: 'Pump 1', Value: 'Running' }, { Label: 'Pump 2', Value: 'Standby' }] });
        const rows = page.locator('.pvx-cfg-st-row');
        check('one row per mapped state', await rows.count() === 2, await rows.count());
        check('no grammar text box by default', await page.locator('textarea[ng-model="config.StateMap"]').count() === 0);
        const first = rows.nth(0).locator('select.pvx-cfg-st-state');
        check('the state is a list, showing the saved state', await first.count() === 1 &&
            await first.evaluate((s) => s.options[s.selectedIndex].text) === 'Running');
        const groups = await first.evaluate((s) => Array.prototype.map.call(s.querySelectorAll('optgroup'),
            (g) => g.label + ':' + Array.prototype.map.call(g.children, (o) => o.text).join('/')));
        check('the list offers the digital set, then live states',
            groups[0] === 'Digital state set MotorState:Running/Stopped/Tripped/Maintenance' &&
            groups[1] === 'Seen in live data:Standby', groups);
        check('row shows severity, colour and label',
            await rows.nth(1).locator('.pvx-cfg-st-sev').inputValue() === 'Alarm' &&
            await rows.nth(1).locator('input[type="color"]').inputValue() === '#c8452f' &&
            await rows.nth(1).locator('.pvx-cfg-st-label').inputValue() === 'Trip');

        await rows.nth(1).locator('select.pvx-cfg-st-state').selectOption({ label: 'Stopped' });
        check('choosing a state rewrites StateMap', await cfg('StateMap') === 'Running:#2f9e5f, Stopped:#c8452f:Trip', await cfg('StateMap'));
        await rows.nth(1).locator('.pvx-cfg-st-sev').selectOption('Off / stale');
        check('a severity sets the colour', await cfg('StateMap') === 'Running:#2f9e5f, Stopped:#8a8f96:Trip', await cfg('StateMap'));
        await rows.nth(1).locator('.pvx-cfg-st-label').fill('');
        check('an empty label is left out', await cfg('StateMap') === 'Running:#2f9e5f, Stopped:#8a8f96', await cfg('StateMap'));
        await rows.nth(0).locator('input[type="color"]').evaluate((el) => {
            el.value = '#336699';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        check('picking a colour rewrites it, severity goes to Custom',
            /^Running:#336699,/.test(await cfg('StateMap')) && await rows.nth(0).locator('.pvx-cfg-st-sev').inputValue() === '',
            await cfg('StateMap'));

        await page.locator('.pvx-cfg-band-add', { hasText: 'Add state' }).click();
        check('Add state adds the next unmapped state', await rows.count() === 3 && /Tripped:#2f9e5f$/.test(await cfg('StateMap')), await cfg('StateMap'));
        await rows.nth(2).locator('.pvx-cfg-st-type').click();
        await rows.nth(2).locator('input.pvx-cfg-st-state').fill('Fault, Reset');
        check('a typed state is stored, separators replaced', /Fault Reset:#2f9e5f$/.test(await cfg('StateMap')), await cfg('StateMap'));
        await rows.nth(0).locator('.pvx-cfg-band-x').click();
        check('the x removes that state', await rows.count() === 2 && !/Running/.test(await cfg('StateMap')), await cfg('StateMap'));

        await page.locator('button[ng-click="ed.toggleText()"]', { hasText: 'Edit as text' }).click();
        const box = page.locator('textarea[ng-model="config.StateMap"]');
        check('Edit as text shows the grammar', await box.count() === 1 && await box.inputValue() === await cfg('StateMap'), await box.inputValue());
        await box.fill('Running:#2f9e5f, Maintenance:#d99024:Service');
        await page.locator('button[ng-click="ed.toggleText()"]', { hasText: 'Back to fields' }).click();
        check('text edits come back as rows', await rows.count() === 2 &&
            await rows.nth(1).locator('.pvx-cfg-st-label').inputValue() === 'Service', await rows.count());

        // --- State Duration: two editors in one pane, colors + list ---
        await open('pvxStateDuration', { StateColors: 'Running:#2f9e5f, Stopped:#8a8f96', UptimeStates: 'Running, Auto' },
            ['pi:\\\\PISRV\\PUMP1.STATE?1'], null);
        const colorsRows = page.locator('.pvx-cfg-states-colors .pvx-cfg-st-row');
        const listRows = page.locator('.pvx-cfg-states-list .pvx-cfg-st-row');
        check('each key gets its own editor', await colorsRows.count() === 2 && await listRows.count() === 2,
            [await colorsRows.count(), await listRows.count()]);
        check('colours have no label field', await page.locator('.pvx-cfg-states-colors .pvx-cfg-st-label').count() === 0);
        check('a state list has only the state', await page.locator('.pvx-cfg-states-list .pvx-cfg-st-sev, .pvx-cfg-states-list input[type="color"]').count() === 0);
        await listRows.nth(1).locator('select.pvx-cfg-st-state').selectOption({ label: 'Maintenance' });
        check('the list editor writes its own key only',
            await cfg('UptimeStates') === 'Running, Maintenance' && await cfg('StateColors') === 'Running:#2f9e5f, Stopped:#8a8f96',
            [await cfg('UptimeStates'), await cfg('StateColors')]);
        await page.locator('.pvx-cfg-states-colors').locator('..').locator('.pvx-cfg-band-add').click();
        check('Add on the colours editor writes StateColors', await colorsRows.count() === 3 &&
            /, Tripped:#2f9e5f$/.test(await cfg('StateColors')), await cfg('StateColors'));

        // --- Exception Banner: digital states placed in threshold bands ---
        const TH = '0:#2f9e5f:Normal, 70:#d99024:High, 90:#c8452f:Critical';
        await open('pvxAlarmBanner', { Thresholds: TH, StateBands: 'ALARM:Critical' },
            ['pi:\\\\PISRV\\PUMP1.STATE?1'],
            { Rows: [{ Label: 'Pump 1', Path: 'p1', Value: 'ALARM' }, { Label: 'Pump 2', Path: 'p2', Value: 'NORMAL' },
                     { Label: 'Temp', Path: 't', Value: 95 }] });
        const bandRows = page.locator('.pvx-cfg-states-bands .pvx-cfg-st-row');
        check('banner: one row per mapped state', await bandRows.count() === 1, await bandRows.count());
        const bandSel = bandRows.nth(0).locator('.pvx-cfg-st-band');
        check('banner: the band list is the threshold bands',
            (await bandSel.evaluate((s) => Array.prototype.map.call(s.options, (o) => o.text).join('|'))) ===
            'Choose a band|Normal|High|Critical');
        check('banner: no colour or severity on a band row',
            await page.locator('.pvx-cfg-states-bands .pvx-cfg-st-sev, .pvx-cfg-states-bands input[type="color"]').count() === 0);
        await bandSel.selectOption({ label: 'High' });
        check('banner: choosing a band rewrites StateBands', await cfg('StateBands') === 'ALARM:High', await cfg('StateBands'));
        await page.waitForTimeout(80);
        const listed = await page.evaluate(() => Array.prototype.map.call(
            document.querySelectorAll('#box .pvx-alarm-row'), (r) => r.textContent.replace(/\s+/g, ' ').trim()));
        check('banner: a mapped digital state is listed as an exception',
            listed.some((t) => /Pump 1/.test(t) && /ALARM/.test(t)), listed);
        check('banner: an unmapped state is not', !listed.some((t) => /Pump 2/.test(t)), listed);
        await page.locator('.pvx-cfg-states-bands').locator('..').locator('.pvx-cfg-band-add').click();
        check('banner: Add state takes the next listed state, in the worst band',
            await cfg('StateBands') === 'ALARM:High, Running:Critical', await cfg('StateBands'));

        await open('pvxAnnunciator', { Thresholds: '', StateBands: '' }, ['pi:\\\\PISRV\\PUMP1.STATE?1'], null);
        check('annunciator: with no bands the editor says to add them first',
            /Add threshold bands above first/.test(await page.locator('.pvx-cfg-states-bands').textContent()));

        // --- Site Plan with no PI Web API: live states, and typing still works ---
        await open('pvxSitePlan', { ColorMode: 'state', StateMap: '' }, ['pi:\\\\PISRV\\PUMP1.STATE?1'], null, false);
        check('nothing is requested when PI Web API is not set up', requests.length === 0, requests);
        check('the pane says where the list comes from',
            /not set up for this site/.test(await page.locator('.pvx-cfg-states-map .pvx-cfg-hint').allTextContents().then((t) => t.join(' '))));
        await page.locator('.pvx-cfg-band-add', { hasText: 'Add state' }).click();
        const typed = page.locator('.pvx-cfg-st-row input.pvx-cfg-st-state');
        check('with nothing to list, a new row is a text box', await typed.count() === 1);
        await typed.fill('Running');
        check('...and typing writes the map', await cfg('StateMap') === 'Running:#2f9e5f', await cfg('StateMap'));

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
        console.error(C.red + 'test-states crashed: ' + (e.stack || e.message) + C.reset);
    }
    console.log('');
    console.log((failures ? C.red + C.bold + failures + ' failed' : C.green + C.bold + 'all ' + passes + ' passed') + C.reset);
    process.exit(failures ? 1 : 0);
})();
