#!/usr/bin/env node
/* ============================================================================
 * tools/test-overlay.js: the options every symbol has (PVX.overlay)
 * ----------------------------------------------------------------------------
 * Save button (PNG, SVG, CSV), stale badge, hide when there is no data, and
 * dropping the asset name from labels (DropAssetName, for collections). Each
 * is off by default, so the first checks are that a symbol with the defaults
 * gets no overlay at all. The rest mount real symbols in Chromium, click the
 * button, and read back the files the browser saves.
 *
 * Also pvxReplay, the control that drives the display's time from the same
 * address these options read: play, pause on an outside change, exit.
 *
 *   node tools/test-overlay.js
 *
 * Expected output: a line per check and "All N overlay checks passed".
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SYMBOLS = ['pvxHistoryTable', 'pvxRadialGauge', 'pvxKpiCard', 'pvxSparkline', 'pvxReplay'];
const C = { green: '\u001b[32m', red: '\u001b[31m', dim: '\u001b[2m', bold: '\u001b[1m', reset: '\u001b[0m' };

let passes = 0, failures = 0;
function check(name, ok, detail) {
    if (ok) { passes += 1; console.log('  ' + C.green + 'ok  ' + C.reset + name); return; }
    failures += 1;
    console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + name + (detail !== undefined ? C.dim + '  got ' + JSON.stringify(detail) + C.reset : ''));
}

const read = (p) => fs.readFileSync(p, 'utf8');

function page() {
    const css = [read(path.join(ROOT, 'src', 'shared', 'base.css'))]
        .concat(SYMBOLS.map((s) => read(path.join(ROOT, 'src', 'symbols', s, 'styles.css')))).join('\n');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<style>html,body{margin:0;padding:0;background:#fff} .box{position:relative;width:360px;height:220px;margin:10px}
${css}</style></head><body>
<script src="/dev/vendor/angular.min.js"></script>
<script src="/dev/pv-mock.js"></script>
<script src="/src/shared/pvx-core.js"></script>
<script>window.PVX.api.configure({ autoDiscover: false });</script>
${SYMBOLS.map((s) => '<script src="/src/symbols/' + s + '/symbol.js"></script>').join('\n')}
<script>
window.mounted = {};
window.mount = async function (id, typeName, overrides, payload) {
    const def = window.PVMock.get(typeName);
    const injector = angular.injector(['ng']);
    const scope = injector.get('$rootScope').$new(true);
    scope.config = def.getDefaultConfig();
    Object.keys(overrides || {}).forEach((k) => { scope.config[k] = overrides[k]; });
    scope.runtimeData = { isEditMode: false };
    scope.symbol = { Name: typeName };
    const tpl = await fetch('/src/symbols/' + typeName + '/template.html').then((r) => r.text());
    const box = document.createElement('div');
    box.className = 'box';
    box.id = id;
    document.body.appendChild(box);
    const host = document.createElement('div');
    host.style.cssText = 'width:100%;height:100%';
    box.appendChild(host);
    const el = angular.element(host).append(injector.get('$compile')(tpl)(scope));
    const vis = new def.visObjectType();
    vis.init(scope, el);
    if (payload !== undefined) { vis.onDataUpdate(payload); }
    vis.onResize(360, 220);
    scope.$applyAsync();
    window.mounted[id] = { vis: vis, scope: scope };
    await new Promise((r) => setTimeout(r, 150));
};
</script></body></html>`;
}

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page()); return; }
    const target = path.normalize(path.join(ROOT, rel));
    if (!target.startsWith(ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(target)] || 'text/plain') + '; charset=utf-8' });
    fs.createReadStream(target).pipe(res);
});

const MIN = 60000;
function ts(label, units, pts, good) {
    return { Label: label, Units: units, Path: '\\\\AF\\T|' + label, IsGood: good !== false,
        Value: pts.map((p) => ({ Time: new Date(p[0]).toISOString(), Value: p[1] })) };
}

/** Click the save button, then a menu item, and return the saved file. */
async function save(p, id, kind) {
    await p.hover('#' + id + ' .pvx');
    await p.click('#' + id + ' .pvx-overlay-btn');
    const [dl] = await Promise.all([
        p.waitForEvent('download', { timeout: 8000 }),
        p.click('#' + id + ' .pvx-overlay-item[data-kind="' + kind + '"]')
    ]);
    const file = await dl.path();
    return { name: dl.suggestedFilename(), bytes: fs.readFileSync(file) };
}

server.listen(0, async () => {
    const port = server.address().port;
    const launch = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launch.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launch);
    const errors = [];
    try {
        const ctxB = await browser.newContext({ acceptDownloads: true, viewport: { width: 900, height: 1400 } });
        const p = await ctxB.newPage();
        p.on('pageerror', (e) => errors.push(e.message));
        p.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); } });
        await p.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle' });

        const now = Date.now();
        const fresh = [ts('Flow', 't/h', [[now - 60 * MIN, 100], [now - 30 * MIN, 110], [now - MIN, 120]]),
            ts('Level', '%', [[now - 60 * MIN, 40], [now - MIN, 'I/O Timeout']])];
        const old = [ts('Flow', 't/h', [[now - 300 * MIN, 100], [now - 200 * MIN, 110]])];

        console.log(C.bold + 'Defaults' + C.reset);
        await p.evaluate((d) => window.mount('def', 'pvxSparkline', {}, { Data: d }), fresh);
        check('with the defaults a symbol has no overlay', await p.$('#def .pvx-overlay') === null);
        const cfg = await p.evaluate(() => window.mounted.def.scope.config);
        check('the three options default off', cfg.ExportMenu === false && cfg.StaleBadgeMinutes === 0 && cfg.HideWhenNoData === false, cfg);

        console.log('');
        console.log(C.bold + 'Save button' + C.reset);
        await p.evaluate((d) => window.mount('tbl', 'pvxHistoryTable', { ExportMenu: true, ShowDownload: false }, { Data: d }), fresh);
        check('ExportMenu adds a button', await p.$('#tbl .pvx-overlay-btn') !== null);
        await p.hover('#tbl .pvx');
        await p.click('#tbl .pvx-overlay-btn');
        const items = await p.$$eval('#tbl .pvx-overlay-item', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.getAttribute('data-kind')));
        check('an HTML symbol offers PNG and CSV, not SVG', JSON.stringify(items) === '["png","csv"]', items);
        await p.click('#tbl .pvx-overlay-btn');

        const csv = await save(p, 'tbl', 'csv');
        const text = csv.bytes.toString('utf8');
        check('CSV: a .csv file named for the symbol', /^pvxHistoryTable \d{4}-\d\d-\d\d \d{4}\.csv$/.test(csv.name), csv.name);
        check('CSV: the table as shown, with a UTF-8 mark for Excel',
            text.charCodeAt(0) === 0xfeff && /^﻿Time,Flow \(t\/h\),Level \(%\)\r\n/.test(text), text.slice(0, 80));

        const png = await save(p, 'tbl', 'png');
        if (process.env.PVX_OVERLAY_PNG) { fs.writeFileSync(process.env.PVX_OVERLAY_PNG, png.bytes); }
        check('PNG: a real PNG of the symbol at twice its size',
            png.bytes.slice(0, 8).toString('hex') === '89504e470d0a1a0a' && png.bytes.readUInt32BE(16) === 720, [png.name, png.bytes.length, png.bytes.readUInt32BE(16)]);

        await p.evaluate(() => window.mount('gauge', 'pvxRadialGauge', { ExportMenu: true }, { Value: 62, Time: new Date().toISOString(), Label: 'Speed', Units: 'rpm', IsGood: true }));
        const svg = await save(p, 'gauge', 'svg');
        const st = svg.bytes.toString('utf8');
        check('SVG: a drawing symbol saves a standalone SVG', /^<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/.test(st) && /<\/svg>$/.test(st), st.slice(0, 120));
        check('...with its styles written in, so it opens outside PI Vision', /style="[^"]*fill:/.test(st));
        const gcsv = (await save(p, 'gauge', 'csv')).bytes.toString('utf8');
        check('CSV of a Value symbol: one row per value', /Source,Units,Time,Value,Quality\r\nSpeed,rpm,[^,]+,62,Good\r\n$/.test(gcsv), gcsv);

        const kcsv = await p.evaluate((d) => window.PVX.download.csvText(window.PVX.overlay.csvRows({ Data: d })), fresh);
        check('generic CSV: every sample, a state kept as text', kcsv.split('\r\n').length === 7 && /Level,%,[^,]+,I\/O Timeout,Good/.test(kcsv), kcsv);
        const rcsv = await p.evaluate(() => window.PVX.overlay.items({ Rows: [{ Label: 'P1', Value: 3, Time: '2026-10-20T00:00:00Z' }] }));
        check('Table-shape rows are read too', rcsv.length === 1 && rcsv[0].raw === 3 && rcsv[0].label === 'P1', rcsv);

        console.log('');
        console.log(C.bold + 'Stale badge' + C.reset);
        await p.evaluate((d) => window.mount('stale', 'pvxSparkline', { StaleBadgeMinutes: 60 }, { Data: d }), old);
        const badge = await p.$eval('#stale .pvx-overlay-stale', (e) => e.offsetParent !== null ? e.textContent : '').catch(() => '');
        check('newest value 200 min old, badge after 60: shown', /^Stale · 3h$/.test(badge), badge);
        check('...and the save button is not, as ExportMenu is off',
            await p.$eval('#stale .pvx-overlay-btn', (e) => getComputedStyle(e).display) === 'none');
        await p.evaluate((d) => window.mount('ok', 'pvxSparkline', { StaleBadgeMinutes: 60 }, { Data: d }), fresh);
        check('newest value a minute old: no badge', await p.$('#ok .pvx-overlay-stale') === null);
        await p.evaluate((d) => window.mount('late', 'pvxSparkline', { StaleBadgeMinutes: 60 }, { Data: d }), fresh);
        await p.evaluate((d) => { window.mounted.late.vis.onDataUpdate({ Data: d }); }, old);
        await p.waitForTimeout(150);
        check('data going stale after it was fresh brings the badge',
            await p.$eval('#late .pvx-overlay-stale', (e) => e.offsetParent !== null).catch(() => false));
        const hist = await p.evaluate(() => {
            location.hash = '#/Displays/1/X?starttime=*-2d&endtime=*-1d';
            return window.PVX.overlay.historical(3600000, Date.now());
        });
        check('a display looking at yesterday is not stale', hist === true);
        await p.evaluate(() => { location.hash = ''; });

        console.log('');
        console.log(C.bold + 'Hide when there is no data' + C.reset);
        const vis = (id) => p.$eval('#' + id + ' .pvx', (e) => getComputedStyle(e).visibility);
        const empty = [{ Label: 'Flow', Units: 't/h', IsGood: false, ErrorDescription: 'No Data', Value: [{ Time: new Date().toISOString(), Value: 'No Data', IsGood: false }] }];
        await p.evaluate((d) => window.mount('hide', 'pvxSparkline', { HideWhenNoData: true }, { Data: d }), empty);
        check('every source bad: hidden', await vis('hide') === 'hidden');
        await p.evaluate((d) => { window.mounted.hide.vis.onDataUpdate({ Data: d }); }, fresh);
        await p.waitForTimeout(150);
        check('data back: shown again', await vis('hide') === 'visible');
        await p.evaluate(() => window.mount('nosrc', 'pvxSparkline', { HideWhenNoData: true }));
        check('before any data arrives it stays', await vis('nosrc') === 'visible');
        await p.evaluate((d) => window.mount('keep', 'pvxSparkline', {}, { Data: d }), empty);
        check('the option off: a symbol with no data still shows', await vis('keep') === 'visible');

        console.log('');
        console.log(C.bold + 'Drop the asset name' + C.reset);
        const unit = await p.evaluate(() => {
            const w = window.PVX.data.withoutAsset;
            return [w('K-302|Compression'), w('K-302|Bearing|Temperature'), w('SINUSOID'), w('|odd'), w('odd|'), w(null),
                window.PVMock.get('pvxSparkline').getDefaultConfig().DropAssetName];
        });
        check('"Element|Attribute" keeps the attribute, a child attribute keeps its parent',
            unit[0] === 'Compression' && unit[1] === 'Bearing|Temperature', unit);
        check('a PI point name, or a label it cannot split, is left as it is',
            unit[2] === 'SINUSOID' && unit[3] === '|odd' && unit[4] === 'odd|' && unit[5] === null, unit);
        check('off by default, so saved displays keep their names', unit[6] === false, unit[6]);
        const assetTs = [ts('K-302|Flow', 't/h', [[now - 60 * MIN, 100], [now - MIN, 120]]), ts('SINUSOID', '', [[now - 60 * MIN, 1], [now - MIN, 2]])];
        assetTs[0].Path = '\\\\AF\\Gathering\\K-302|Flow';
        const shown = (id) => p.$eval('#' + id + ' .pvx', (e) => e.textContent);
        await p.evaluate((d) => window.mount('drop', 'pvxSparkline', { DropAssetName: true }, { Data: d }), assetTs);
        let t = await shown('drop');
        // The tooltip still gives the full AF path, which is how to tell copies apart.
        const named = t.split('\\\\AF\\Gathering\\K-302|Flow').join('');
        check('on: the symbol shows "Flow", not "K-302|Flow"', /Flow/.test(named) && !/K-302\|/.test(named), named.slice(0, 160));
        check('...while its tooltip keeps the full path', t.indexOf('\\\\AF\\Gathering\\K-302|Flow') !== -1);
        check('...and the PI point beside it keeps its name', /SINUSOID/.test(t), t.slice(0, 160));
        const sent = await p.evaluate((d) => d[0].Label, assetTs);
        check('PI Vision\'s own update is not changed', sent === 'K-302|Flow', sent);
        await p.evaluate(() => {
            const m = window.mounted.drop;
            const cfg = Object.assign({}, m.scope.config, { DropAssetName: false });
            m.vis.onConfigChange(cfg, m.scope.config);
        });
        await p.waitForTimeout(150);
        t = await shown('drop');
        check('turned off in the pane: the full name is back without a new update', /K-302\|Flow/.test(t), t.slice(0, 160));
        await p.evaluate(() => window.mount('dropv', 'pvxRadialGauge', { DropAssetName: true },
            { Value: 62, Label: 'K-302|Speed', Units: 'rpm', Path: '\\\\AF\\K-302|Speed', IsGood: true, Time: new Date().toISOString() }));
        t = await shown('dropv');
        check('a Value symbol\'s one name is shortened too', /Speed/.test(t) && !/K-302\|/.test(t), t.slice(0, 160));

        console.log('');
        console.log(C.bold + 'Replay' + C.reset);
        const plan = await p.evaluate(() => {
            const P = window.PVMock.get('pvxReplay').visObjectType.plan;
            const H = 3600000, M = 60000;
            const a = P(0, 24 * H, H, 10 * M);
            const b = P(0, 65 * M, 30 * M, 20 * M);
            const c = P(0, 30 * M, H, 10 * M);
            return { a: [a.count, a.frame(0), a.frame(a.count - 1)], b: [b.count, b.frame(1), b.frame(2)], c: [c.count, c.frame(0)],
                tooMany: P(0, 365 * 24 * H, H, 1000).tooMany > 0, bad: P(10, 5, H, M) === null };
        });
        check('a day in 10-minute steps of a 1-hour window: 139 frames, first and last right',
            plan.a[0] === 139 && plan.a[1].start === 0 && plan.a[1].end === 3600000 && plan.a[2].end === 86400000, plan.a);
        check('a step that does not divide the stretch still ends on its end',
            plan.b[0] === 3 && plan.b[1].end === 50 * MIN && plan.b[2].end === 65 * MIN && plan.b[2].start === 35 * MIN, plan.b);
        check('a window longer than the stretch shows it whole, once', plan.c[0] === 1 && plan.c[1].start === 0 && plan.c[1].end === 30 * MIN, plan.c);
        check('too many steps, or an end before the start, are refused', plan.tooMany && plan.bad, plan);

        await p.evaluate(() => { location.hash = '#/Displays/7/Unit?starttime=*-8h&endtime=*'; });
        await p.evaluate(() => window.mount('rp', 'pvxReplay', { ReplayFrom: '*-3h', ReplayTo: '*', WindowSpan: '1h', Step: '30m', StepSeconds: 1 }));
        const hashOf = () => p.evaluate(() => { const q = window.PVX.nav.parseHash().params; return [q.starttime, q.endtime]; });
        await p.click('#rp .pvx-replay-play');
        await p.waitForTimeout(150);
        const h1 = await hashOf();
        const span1 = Date.parse(h1[1]) - Date.parse(h1[0]);
        check('Play sets the display to the first window', span1 === 3600000 && Math.abs(Date.parse(h1[0]) - (Date.now() - 3 * 3600000)) < 5000, h1);
        await p.waitForTimeout(1150);
        const h2 = await hashOf();
        check('...and a second later moves it one step on', Date.parse(h2[1]) - Date.parse(h1[1]) === 1800000, [h1, h2]);
        const rd = await p.$eval('#rp .pvx-replay-readout', (e) => e.textContent);
        check('the readout names the window and the step', /step 2 of 5$/.test(rd), rd);
        await p.evaluate(() => { location.hash = '#/Displays/7/Unit?starttime=*-2d&endtime=*'; });
        await p.waitForTimeout(1300);
        const h3 = await hashOf();
        const msg = await p.$eval('#rp .pvx-replay-msg', (e) => e.textContent);
        check('a range set elsewhere pauses it and is left alone', h3[0] === '*-2d' && /changed elsewhere/.test(msg), [h3, msg]);
        await p.click('#rp [data-pvx-act="fwd"]');
        await p.waitForTimeout(100);
        await p.click('#rp [data-pvx-act="exit"]');
        await p.waitForTimeout(100);
        const h4 = await hashOf();
        check('Exit returns to the range shown before the replay', h4[0] === '*-2d' && h4[1] === '*', h4);
        await p.evaluate(() => window.mount('rpbad', 'pvxReplay', { WindowSpan: 'an hour' }));
        const bad = await p.$eval('#rpbad .pvx-replay-msg', (e) => e.textContent);
        check('a window it cannot read is named, and Play is off',
            /Window "an hour" is not a length of time/.test(bad) && await p.$eval('#rpbad .pvx-replay-play', (e) => e.disabled), bad);

        check('no page errors', errors.length === 0, errors);
    } catch (e) {
        failures += 1;
        console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + (e.stack || e.message));
    }
    await browser.close();
    server.close();
    console.log('');
    if (failures) {
        console.log(C.red + C.bold + failures + ' failed' + C.reset + C.dim + ', ' + passes + ' passed' + C.reset);
        process.exit(1);
    }
    console.log(C.green + C.bold + 'All ' + passes + ' overlay checks passed' + C.reset);
});
