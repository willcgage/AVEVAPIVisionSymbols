#!/usr/bin/env node
/* ============================================================================
 * PVX alarm test — the Exception Banner and the Annunciator with a deadband,
 * the banner's History mode, and the Alarm Tone.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-alarms.js
 *
 * Two halves:
 *
 *   rules    PVX.thresholds in plain Node: a deadband is read as units or a
 *            percentage, holds a band only on the way down, and excursions
 *            from recorded values start, end, escalate and stay open where
 *            they should; with an in-limits band, bands below it rank as
 *            exceptions too and hold on the way up; AF limit traits become
 *            five bands; the Alarm Tone's episodes sound, silence, resound
 *            on a worse band and end on clearing.
 *   symbols  the BUILT symbols in real Chromium: a value just under a limit
 *            keeps its band with a deadband and leaves it without; the
 *            Annunciator does not return a tile inside the deadband; History
 *            reads recorded values from a mock PI Web API and lists each
 *            excursion, newest first, saying what it could not read; a
 *            value under a low limit is listed, from typed bands or from each
 *            attribute's AF limit traits on the mock, with the limit quoted; the
 *            Alarm Tone, with Web Audio stubbed, arms on a click, sounds,
 *            silences, sounds again for a new alarm, and goes quiet when the
 *            shared acknowledgement record (read only) says so.
 *
 * History is proven against this mock only, not yet a server.
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
const PORT = 31802;

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

const BANDS = '0:#2f9e5f:Normal, 70:#d99024:High, 90:#c8452f:Critical';
// Limits on both sides: in limits from 60 to 90.
const LOW = '0:#d99024:Low, 60:#2f9e5f:Normal, 90:#c8452f:High';

/* --------------------------------------------------------- mock PI Web API */

// Recorded values a minute apart, ending ten minutes ago, so the display's
// default eight hours holds them all.
const NOW = Date.now();
const at = (i, n) => new Date(NOW - (n - i) * 60000 - 600000).toISOString();
const TEMP = [50, 75, 80, 72, 68, 95, 91, 60];
const FLOW = [85, 86, 50, 92];
const REC = [70, 58, 52, 65];
const RECORDED = {
    // Under its Lo limit of 60 for two values, then back.
    'A:level': REC.map((v, i) => ({ Timestamp: at(i, REC.length), Value: v, Good: true })),
    'A:temp': TEMP.map((v, i) => ({ Timestamp: at(i, TEMP.length), Value: v, Good: true })),
    // In alarm from the first value, out, then in again to the end.
    'P:flow': FLOW.map((v, i) => ({ Timestamp: at(i, FLOW.length), Value: v, Good: true }))
};
// The shared acknowledgement record an Annunciator keeps; the Alarm Tone
// only reads it.
const ACKS = {};
const STREAMS = {
    'attributes:\\\\afsrv\\db\\control room|ack': 'A:ack',
    'attributes:\\\\afsrv\\db\\k-301|temperature': 'A:temp',
    'points:\\\\pisrv\\flow': 'P:flow',
    'attributes:\\\\afsrv\\db\\tank 1|level': 'A:level',
    'attributes:\\\\afsrv\\db\\tank 1|pressure': 'A:press',
    'attributes:\\\\afsrv\\db\\tank 1|nolimits': 'A:none'
};
// AF limit traits by attribute WebId: a level with a low limit only, a
// pressure that must stay between 20 and 40, and an attribute with none.
const TRAITS = { 'A:level': { Lo: 60 }, 'A:press': { Lo: 20, Hi: 40 }, 'A:none': {} };

let requests = [];

function api(req, res, url) {
    const u = new URL(url, 'http://x');
    const q = u.searchParams;
    const rel = decodeURIComponent(u.pathname).replace(/^\/piwebapi\/?/, '');
    requests.push((req.method !== 'GET' ? req.method + ' ' : '') + rel + (q.toString() ? '?' + q.toString() : ''));
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const id = STREAMS[rel + ':' + (q.get('path') || '').toLowerCase()];
    if (id) { return send(200, { WebId: id }); }
    const tr = /^attributes\/([^/]+)\/attributes$/.exec(rel);
    if (tr && q.get('trait')) {
        const v = (TRAITS[tr[1]] || {})[q.get('trait')];
        return send(200, { Items: v === undefined ? [] : [{ WebId: 'T:' + tr[1] + ':' + q.get('trait') }] });
    }
    const tv = /^streams\/T:(.+):(\w+)\/value$/.exec(rel);
    if (tv) { return send(200, { Timestamp: new Date().toISOString(), Value: TRAITS[tv[1]][tv[2]], Good: true }); }
    if (rel === 'streams/A:ack/value') { return send(200, { Timestamp: new Date().toISOString(), Value: JSON.stringify(ACKS), Good: true }); }
    const m = /^streams\/([^/]+)\/recorded$/.exec(rel);
    if (m && RECORDED[m[1]]) { return send(200, { Items: RECORDED[m[1]] }); }
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
    console.log(C.bold + 'Deadband and excursion rules' + C.reset);
    const T = loadCore().thresholds;
    const bands = T.parse(BANDS);

    check('blank and zero mean no deadband', T.parseDeadband('') === null && T.parseDeadband('0') === null);
    const u = T.parseDeadband(' 2.5 '), p = T.parseDeadband('2%');
    check('units and percent are read', u.amount === 2.5 && !u.percent && p.amount === 2 && p.percent, [u, p]);
    check('a deadband it cannot read is flagged, not ignored', T.parseDeadband('two').bad && T.parseDeadband('-1').bad);
    check('percent is of the limit', T.deadbandAt(p, 90) === 1.8 && T.deadbandAt(u, 90) === 2.5);

    const db = T.parseDeadband('5');
    check('rising is immediate', T.hold(91, bands, 2, 1, db) === 2);
    check('falling inside the deadband keeps the band', T.hold(86, bands, 1, 2, db) === 2);
    check('falling past it leaves', T.hold(84, bands, 1, 2, db) === 1);
    check('a fall through two bands stops at the first it is still within', T.hold(66, bands, 0, 2, db) === 1);
    check('no deadband, no hold', T.hold(86, bands, 1, 2, null) === 1);
    check('a digital state is never held', T.hold(null, bands, 0, 2, db) === 0);

    const pts = (vals, good) => vals.map((v, i) => ({ t: i * 60000, v: v, raw: v, good: !good || good[i] }));
    const plain = T.excursions(pts(TEMP), bands, { minBand: 1 });
    check('without a deadband, 68 ends the first excursion', plain.length === 2 &&
        plain[0].start === 60000 && plain[0].end === 240000 && plain[0].sev === 1 && plain[1].sev === 2, plain);
    const held = T.excursions(pts(TEMP), bands, { minBand: 1, deadband: db });
    check('with 5 of deadband it is one excursion, at its worst band, with its peak',
        held.length === 1 && held[0].start === 60000 && held[0].end === 420000 && held[0].sev === 2 &&
        held[0].firstSev === 1 && held[0].peak === 95, held);
    const open = T.excursions(pts([95, 96, 50, 92]), bands, { minBand: 1 });
    check('in alarm at the first value: marked as starting earlier', open[0].openStart && !open[1].openStart, open);
    check('in alarm at the last value: no end', open[1].end === null, open[1]);
    const bad = T.excursions(pts([50, 95, 20, 50], [true, true, false, true]), bands, { minBand: 1 });
    check('a bad value neither ends nor starts anything', bad.length === 1 && bad[0].end === 180000, bad);
    const sm = { alarm: 2 };
    const dig = T.excursions([{ t: 0, v: null, raw: 'Normal' }, { t: 1, v: null, raw: 'ALARM' }, { t: 2, v: null, raw: 'Normal' }],
        bands, { minBand: 1, stateBands: sm });
    check('a digital state mapped to a band makes an excursion', dig.length === 1 && dig[0].sev === 2 && dig[0].end === 2, dig);

    console.log('');
    console.log(C.bold + 'Limits on both sides' + C.reset);
    const two = T.parse(LOW);
    check('rising only: a band is ranked by its index', T.rank(2, -1) === 2 && T.rank(0, -1) === 0);
    check('with an in-limits band: ranked by distance, below or above', T.rank(0, 1) === 1 && T.rank(2, 1) === 1 && T.rank(1, 1) === 0);
    check('under the in-limits band is the lowest band, even under its own limit',
        T.bandOf(55, two, 1) === 0 && T.bandOf(-3, two, 1) === 0 && T.bandOf(70, two, 1) === 1 && T.bandOf(95, two, 1) === 2);
    check('rising only, under the first limit is no band, as before', T.bandOf(-3, two, -1) === -1);
    const lim0 = T.limitOf(two, 0, 1), lim2 = T.limitOf(two, 2, 1);
    check('the limit crossed: a low band ends at the next limit, a high band starts at its own',
        lim0.value === 60 && lim0.below && lim2.value === 90 && !lim2.below, [lim0, lim2]);
    const db2 = T.parseDeadband('5');
    check('rising out of a low band inside the deadband keeps it', T.hold(62, two, 1, 0, db2, 1) === 0);
    check('...and past it leaves', T.hold(70, two, 1, 0, db2, 1) === 1);
    check('falling into a low band is immediate', T.hold(58, two, 0, 1, db2, 1) === 0);
    check('a high band still holds on the way down', T.hold(87, two, 1, 2, db2, 1) === 2 && T.hold(84, two, 1, 2, db2, 1) === 1);
    const lowEx = T.excursions(pts(REC), two, { minBand: 1, normal: 1 });
    check('a dip under the low limit is one excursion, its peak the lowest value',
        lowEx.length === 1 && lowEx[0].sev === 0 && lowEx[0].low && lowEx[0].peak === 52 &&
        lowEx[0].start === 60000 && lowEx[0].end === 180000, lowEx);
    check('rising only, the dip is never what is flagged', T.excursions(pts(REC), two, { minBand: 1 }).every((x) => x.sev >= 1));

    const af = T.fromLimits({ Lo: 10, Hi: 20 });
    check('AF Lo and Hi become five bands, Normal in the middle',
        af.length === 5 && af.map((b) => b.label).join() === 'LoLo,Lo,Normal,Hi,HiHi' &&
        T.bandOf(5, af, 2) === 1 && T.bandOf(15, af, 2) === 2 && T.bandOf(25, af, 2) === 3, af);
    const af2 = T.fromLimits({ LoLo: 5, Lo: 10 });
    check('LoLo is reached under it, and with no high limits nothing above alarms',
        T.bandOf(3, af2, 2) === 0 && T.bandOf(7, af2, 2) === 1 && T.bandOf(1e9, af2, 2) === 2);
    check('an attribute with none of the four has no bands', T.fromLimits({ LoLo: null, Target: 5 }) === null);
    check('limits out of order are refused', T.fromLimits({ Lo: 30, Hi: 20 }).bad === true);
}

function loadSymbol(name) {
    let def = null;
    const win = {
        PIVisualization: {
            deriveVisualizationFromBase: function () {},
            Extensibility: { Enums: { DatasourceBehaviors: { Multiple: 'Multiple' } } }
        },
        PVX: { register: function (pv, d) { def = d; } }
    };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'dist', 'ext', 'sym-' + name + '.js'), 'utf8'), { window: win });
    return def.visObjectType;
}

function toneRules() {
    console.log('');
    console.log(C.bold + 'Alarm Tone episodes' + C.reset);
    const adv = loadSymbol('pvxAlarmTone').advance;
    const eps = {};
    const it = (sev, known) => [{ key: 'T1', sev: sev, inAlarm: sev >= 1, known: known !== false }];
    let r = adv(eps, it(0), 1000, { seeded: false });
    check('quiet: nothing sounds', r.sounding.length === 0);
    r = adv(eps, it(1), 2000, { seeded: true });
    check('a new alarm sounds', r.sounding.join() === 'T1' && eps.T1.start === 2000 && !eps.T1.fromSeed);
    r = adv(eps, it(1), 3000, { seeded: true, silenceAll: true });
    check('Silence quiets it', r.sounding.length === 0 && eps.T1.silenced);
    r = adv(eps, it(1, false), 3500, { seeded: true });
    check('a bad value keeps it as it was', r.sounding.length === 0 && !!eps.T1);
    r = adv(eps, it(2), 4000, { seeded: true });
    check('rising to a worse band sounds again', r.sounding.join() === 'T1');
    r = adv(eps, it(2), 4500, { seeded: true, resound: false, silenceAll: true });
    r = adv(eps, it(0), 5000, { seeded: true });
    check('clearing ends the episode', r.sounding.length === 0 && !eps.T1);
    r = adv(eps, it(1), 6000, { seeded: true, shared: { T1: { at: 5500 } } });
    check('an acknowledgement older than the alarm does not silence it', r.sounding.join() === 'T1');
    r = adv(eps, it(1), 7000, { seeded: true, shared: { T1: { at: 6500 } } });
    check('one made after it began does', r.sounding.length === 0);
    const e2 = {};
    r = adv(e2, it(2), 1000, { seeded: false, shared: { T1: { at: 10 } } });
    check('a standing alarm takes any acknowledgement on record', r.sounding.length === 0 && e2.T1.fromSeed);
    const e3 = {};
    r = adv(e3, it(2), 1000, { seeded: false, standing: false });
    check('standing alarms can be left quiet', r.sounding.length === 0);
    r = adv(e3, [], 2000, { seeded: true });
    check('a source taken off the symbol takes its episode with it', !e3.T1);
}

/* ---------------------------------------------------------------- symbols */

function pageHtml(typeName) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
</head><body><div id="box" style="width:520px;height:300px"></div>
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

/** Runs in the browser: mount a Table-shape symbol with the given config. */
async function mount(a) {
    window.PVX.api.configure({ baseUrl: a.configured === false ? '' : location.origin + '/piwebapi',
        autoDiscover: false, auth: 'anonymous' });
    const def = window.PVMock.get(a.typeName);
    const injector = angular.injector(['ng']);
    const $compile = injector.get('$compile');
    const scope = injector.get('$rootScope').$new(true);
    scope.config = def.getDefaultConfig();
    Object.keys(a.config || {}).forEach((k) => { scope.config[k] = a.config[k]; });
    scope.runtimeData = {};
    scope.symbol = { Name: a.typeName, DataSources: a.paths };
    const tpl = await fetch('/dist/ext/sym-' + a.typeName + '-template.html').then((r) => r.text());
    const host = document.createElement('div');
    host.style.cssText = 'width:100%;height:100%';
    document.getElementById('box').appendChild(host);
    const el = angular.element(host).append($compile(tpl)(scope));
    const vis = new def.visObjectType();
    vis.init(scope, el, undefined);
    window.__scope = scope;
    window.__vis = vis;
    window.__feed = (values) => vis.onDataUpdate({ Rows: values.map((v, i) => ({
        Label: a.labels[i], Path: a.paths[i], Units: 'degC', Value: v, Time: new Date().toISOString(), IsGood: true })) });
}

async function symbols() {
    const { chromium } = require('playwright');
    const server = await serve();
    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launchOpts.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launchOpts);
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const feed = async (vals) => { await page.evaluate((v) => window.__feed(v), vals); await page.waitForTimeout(90); };
        const bandsShown = () => page.evaluate(() => Array.prototype.map.call(
            document.querySelectorAll('#box .pvx-alarm-row .pvx-alarm-band'), (n) => n.textContent));
        const rows = () => page.evaluate(() => Array.prototype.map.call(
            document.querySelectorAll('#box .pvx-alarm-row'), (n) => n.textContent.replace(/\s+/g, ' ').trim()));
        const footer = () => page.evaluate(() => (document.querySelector('#box .pvx-alarm-footer') || {}).textContent || '');
        const one = { labels: ['K-301|Temperature'], paths: ['af:\\\\AFSRV\\DB\\K-301|Temperature?1'] };
        let r0;

        console.log('');
        console.log(C.bold + 'Exception Banner, live' + C.reset);
        for (const dbv of ['', '5']) {
            await page.goto('http://127.0.0.1:' + PORT + '/page/pvxAlarmBanner', { waitUntil: 'networkidle' });
            await page.evaluate(mount, Object.assign({ typeName: 'pvxAlarmBanner', config: { Thresholds: BANDS, Deadband: dbv } }, one));
            await feed([92]);
            const first = await bandsShown();
            await feed([88]);
            const second = await bandsShown();
            await feed([84]);
            const third = await bandsShown();
            if (!dbv) {
                check('no deadband (the default): 92 Critical, then 88 High', first[0] === 'Critical' && second[0] === 'High',
                    [first, second]);
            } else {
                check('deadband 5: 88 stays Critical, 84 drops to High',
                    first[0] === 'Critical' && second[0] === 'Critical' && third[0] === 'High', [first, second, third]);
            }
        }
        check('nothing is asked of PI Web API outside History', requests.length === 0, requests);
        await page.evaluate(() => { window.__scope.config.Deadband = 'lots'; window.__vis.onConfigChange(window.__scope.config); });
        await feed([84]);
        check('a deadband it cannot read is named in the footer', /Deadband "lots" not read/.test(await footer()), await footer());

        console.log('');
        console.log(C.bold + 'Exception Banner, limits on both sides' + C.reset);
        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxAlarmBanner', { waitUntil: 'networkidle' });
        await page.evaluate(mount, Object.assign({ typeName: 'pvxAlarmBanner',
            config: { Thresholds: LOW, NormalBand: 2, ShowLimit: true } }, one));
        await feed([55]);
        check('in-limits band 2: a value under 60 is listed as Low, with the limit', (await bandsShown())[0] === 'Low < 60',
            await bandsShown());
        await feed([70]);
        check('...and back inside, nothing', (await rows()).length === 0, await rows());
        await feed([95]);
        check('...and over 90 it is High, quoting its own limit', (await bandsShown())[0] === 'High \u2265 90', await bandsShown());
        await page.evaluate(() => { window.__scope.config.NormalBand = 0; window.__vis.onConfigChange(window.__scope.config); });
        await feed([55]);
        check('in-limits band 0 (the default): rising only, Low is not an exception', (await rows()).length === 0, await rows());
        await page.evaluate(() => { window.__scope.config.NormalBand = 7; window.__vis.onConfigChange(window.__scope.config); });
        await feed([55]);
        check('an in-limits band past the last is named in the footer', /In-limits band 7 is past the last band/.test(await footer()),
            await footer());

        const afRows = {
            labels: ['Tank 1|Level', 'Tank 1|Pressure', 'Tank 1|NoLimits', 'FLOW'],
            paths: ['af:\\\\AFSRV\\DB\\Tank 1|Level?1', 'af:\\\\AFSRV\\DB\\Tank 1|Pressure?2',
                'af:\\\\AFSRV\\DB\\Tank 1|NoLimits?3', 'pi:\\\\PISRV\\FLOW?4']
        };
        requests = [];
        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxAlarmBanner', { waitUntil: 'networkidle' });
        await page.evaluate(mount, Object.assign({ typeName: 'pvxAlarmBanner',
            config: { LimitsFrom: 'af', ShowLimit: true } }, afRows));
        await feed([55, 15, 50, 5000]);
        await page.waitForTimeout(300);
        await feed([55, 15, 50, 5000]);
        r0 = await rows();
        check('AF limits: each row against its own traits, both under their Lo',
            r0.length === 2 && r0.some((t) => /Level/.test(t) && /Lo < 60/.test(t)) &&
            r0.some((t) => /Pressure/.test(t) && /Lo < 20/.test(t)), r0);
        check('...and no "No limits set" warning, since the limits are per row', !/No limits set/.test((await page.textContent('#box')) || ''));
        check('the attribute with no traits and the PI point are named in the footer',
            /2 with no AF limits, so never flagged: Tank 1\|NoLimits, FLOW/.test(await footer()), await footer());
        await feed([55, 45, 50, 5000]);
        r0 = await rows();
        check('Pressure over its Hi of 40 is Hi', r0.some((t) => /Pressure/.test(t) && /Hi \u2265 40/.test(t)), r0);
        const asked = requests.filter((q) => /trait=/.test(q)).length;
        await feed([55, 45, 50, 5000]);
        check('traits are not asked again on every update', requests.filter((q) => /trait=/.test(q)).length === asked, requests);

        console.log('');
        console.log(C.bold + 'Exception Banner, History (mock PI Web API)' + C.reset);
        const three = {
            labels: ['K-301|Temperature', 'FLOW', 'Pump 9|Missing'],
            paths: ['af:\\\\AFSRV\\DB\\K-301|Temperature?1', 'pi:\\\\PISRV\\FLOW?2', 'af:\\\\AFSRV\\DB\\Pump 9|Missing?3']
        };
        const history = async (config) => {
            requests = [];
            await page.goto('http://127.0.0.1:' + PORT + '/page/pvxAlarmBanner', { waitUntil: 'networkidle' });
            await page.evaluate(mount, Object.assign({ typeName: 'pvxAlarmBanner',
                config: Object.assign({ Thresholds: BANDS, Mode: 'history', ShowDuration: true }, config) }, three));
            await feed([60, 50, 40]);
            await page.waitForTimeout(250);
            await feed([60, 50, 40]);
        };
        await history({ Deadband: '5' });
        if (process.env.PVX_ALARMS_PNG) { await page.locator('#box').screenshot({ path: process.env.PVX_ALARMS_PNG }); }
        let r = await rows();
        check('one row per excursion: Temperature once (held by the deadband), FLOW twice', r.length === 3 &&
            r.filter((t) => /Temperature/.test(t)).length === 1 && r.filter((t) => /FLOW/.test(t)).length === 2, r);
        check('newest first, and the one still in alarm is active', /FLOW/.test(r[0]) && /active/.test(r[0]), r[0]);
        const temp = r.find((t) => /Temperature/.test(t)) || '';
        check('Temperature: worst band, peak value, and 6m long', /Critical/.test(temp) && /95/.test(temp) && /6m/.test(temp), temp);
        check('an excursion already under way when the range began is marked as such',
            r.some((t) => /FLOW/.test(t) && /≤/.test(t) && /≥ 2m/.test(t)), r);
        check('the source PI Web API does not know is named, not dropped', /1 not read: Pump 9\|Missing/.test(await footer()), await footer());
        check('recorded values asked for once per source', requests.filter((q) => /\/recorded/.test(q)).length === 2, requests);
        check('the pills count excursions by band', await page.evaluate(() =>
            Array.prototype.map.call(document.querySelectorAll('#box .pvx-alarm-pill'), (n) => n.textContent.replace(/\s+/g, '')).join(',')) ===
            '2Critical,1High');

        await history({});
        r = await rows();
        check('without the deadband, 68 ends the first Temperature excursion', r.filter((t) => /Temperature/.test(t)).length === 2, r);

        requests = [];
        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxAlarmBanner', { waitUntil: 'networkidle' });
        await page.evaluate(mount, Object.assign({ typeName: 'pvxAlarmBanner',
            config: { LimitsFrom: 'af', Mode: 'history', ShowLimit: true, ShowDuration: true } },
            { labels: ['Tank 1|Level'], paths: ['af:\\\\AFSRV\\DB\\Tank 1|Level?1'] }));
        await feed([70]);
        await page.waitForTimeout(300);
        await feed([70]);
        await page.waitForTimeout(300);
        r = await rows();
        check('History with AF limits: the dip under Lo is one excursion, showing its lowest value',
            r.length === 1 && /Lo < 60/.test(r[0]) && /52\.0/.test(r[0]), r);

        requests = [];
        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxAlarmBanner', { waitUntil: 'networkidle' });
        await page.evaluate(mount, Object.assign({ typeName: 'pvxAlarmBanner', configured: false,
            config: { Thresholds: BANDS, Mode: 'history' } }, three));
        await feed([60, 50, 40]);
        check('without PI Web API, History says what is needed and asks nothing',
            requests.length === 0 && /History needs PI Web API/.test((await page.textContent('#box')) || ''), requests);

        console.log('');
        console.log(C.bold + 'Annunciator' + C.reset);
        const tileState = () => page.evaluate(() => {
            const n = document.querySelector('#box .pvx-ann-tile');
            return n ? (/pvx-ann-st-([a-z-]+)/.exec(n.className) || [])[1] : '';
        });
        for (const dbv of ['', '5']) {
            await page.goto('http://127.0.0.1:' + PORT + '/page/pvxAnnunciator', { waitUntil: 'networkidle' });
            await page.evaluate(mount, Object.assign({ typeName: 'pvxAnnunciator', config: { Thresholds: BANDS, Deadband: dbv } }, one));
            await feed([50]);
            await feed([75]);
            const a1 = await tileState();
            await feed([68]);
            const a2 = await tileState();
            if (!dbv) {
                check('no deadband: 68 under a limit of 70 returns the tile', a1 === 'alarm-new' && a2 === 'returned', [a1, a2]);
            } else {
                await feed([64]);
                const a3 = await tileState();
                check('deadband 5: 68 is still in alarm, 64 returns', a1 === 'alarm-new' && a2 === 'alarm-new' && a3 === 'returned',
                    [a1, a2, a3]);
            }
        }

        console.log('');
        console.log(C.bold + 'Alarm Tone (Web Audio stubbed)' + C.reset);
        const toneText = () => page.evaluate(() => (document.querySelector('#box .pvx-tone-body') || {}).textContent || '');
        const notes = () => page.evaluate(() => window.__notes);
        const click = async (sel) => { await page.click('#box ' + sel); await page.waitForTimeout(90); };
        await page.addInitScript(() => {
            window.__notes = 0;
            function Param() { this.setValueAtTime = function () {}; this.linearRampToValueAtTime = function () {};
                this.exponentialRampToValueAtTime = function () {}; }
            window.AudioContext = function () {
                this.currentTime = 0; this.destination = {};
                this.resume = function () {}; this.close = function () {};
                this.createOscillator = function () { return { frequency: new Param(), connect: function () {},
                    start: function () { window.__notes += 1; }, stop: function () {} }; };
                this.createGain = function () { return { gain: new Param(), connect: function () {} }; };
            };
        });
        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxAlarmTone', { waitUntil: 'networkidle' });
        await page.evaluate(mount, Object.assign({ typeName: 'pvxAlarmTone', config: { Thresholds: BANDS, Deadband: '5' } }, one));
        await feed([95]);
        check('before a click it asks to be switched on, and makes no sound',
            /Click to turn alarm sound on/.test(await toneText()) && await notes() === 0, await toneText());
        await click('.pvx-tone-btn');
        check('the click arms it, and the standing alarm sounds at once',
            /1 alarm sounding/.test(await toneText()) && await notes() > 0, [await toneText(), await notes()]);
        check('...naming what is sounding', /K-301\|Temperature \(Critical\)/.test(await toneText()), await toneText());
        await click('.pvx-tone-btn');
        const quiet = await notes();
        await feed([92]);
        check('a click silences it on this screen', /Silenced/.test(await toneText()) && await notes() === quiet, await toneText());
        await feed([86]);
        check('inside the deadband it is still the same alarm, still silenced', /Silenced/.test(await toneText()));
        await feed([50]);
        check('clear: armed and quiet', /Alarm sound on/.test(await toneText()), await toneText());
        await feed([75]);
        check('a new alarm sounds again', /1 alarm sounding/.test(await toneText()) && await notes() > quiet, await toneText());
        await click('.pvx-tone-off');
        check('the x turns sound off', /Click to turn alarm sound on/.test(await toneText()), await toneText());

        requests = [];
        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxAlarmTone', { waitUntil: 'networkidle' });
        await page.evaluate(mount, Object.assign({ typeName: 'pvxAlarmTone', config: { Thresholds: BANDS, SharedAck: true,
            AckAttributePath: '\\\\AFSRV\\DB\\Control Room|Ack', AckPollSeconds: 2 } }, one));
        await feed([50]);
        await click('.pvx-tone-btn');
        await feed([95]);
        check('with shared acknowledgement on, a new alarm sounds', /1 alarm sounding/.test(await toneText()), await toneText());
        ACKS[one.paths[0]] = { at: Date.now(), by: 'Panel 1', st: 'ack' };
        await page.waitForTimeout(2600);
        check('an acknowledgement in the shared record silences it', /Silenced/.test(await toneText()), await toneText());
        check('...and the record is only read, never written',
            requests.some((q) => /^streams\/A:ack\/value/.test(q)) && !requests.some((q) => /^(POST|PUT|PATCH)/.test(q)), requests);

        check('no page errors', errors.length === 0, errors);
    } finally {
        await browser.close();
        server.close();
    }
}

(async () => {
    try {
        rules();
        toneRules();
        await symbols();
    } catch (e) {
        failures += 1;
        console.error(C.red + 'test-alarms crashed: ' + (e.stack || e.message) + C.reset);
    }
    console.log('');
    console.log((failures ? C.red + C.bold + failures + ' failed' : C.green + C.bold + 'all ' + passes + ' passed') + C.reset);
    process.exit(failures ? 1 : 0);
})();
