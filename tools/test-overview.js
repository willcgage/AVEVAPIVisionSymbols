#!/usr/bin/env node
/* ============================================================================
 * PVX overview test — the pieces an overview display is built from, against
 * a mock AF database behind a mock PI Web API.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-overview.js
 *
 * Built for the PI Vision Overview Build Guide: drill-down to the element,
 * the Navigation Panel's hierarchy strip, the Asset Table, the Event
 * Timeline scoped to the current asset, and the text size control. Also
 * the Event List: its columns, filter, sort, groups and totals, and where
 * a click on a row goes. And Period Comparison's runs from event frames:
 * the query, the three alignments, golden runs and their tolerance. And the
 * Asset Rollup: its search, the one batch of values, cards per group with
 * Others, colour from a target or bands, and every asset left out named. The
 * quick trend any symbol can open, and the Lookup Table's AF table. Also the
 * clicks that move the display's time range (a heatmap cell, an event bar)
 * and the Navigation Panel's icons, tooltips and {value} addresses. And the
 * Display Menu: nesting, drop-downs and where they open, the current display
 * marked, keys, collapsing, the side menu, a menu from an AF attribute of the
 * display's asset, and the kiosk and toolbar switches surviving navigation.
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

    // PI time, as the Time Range symbol resolves it to step a range.
    const NOW = Date.parse('2026-10-20T12:34:56Z');
    const mid = new Date(NOW); mid.setHours(0, 0, 0, 0);
    const pt = (s) => nav.parseTime(s, NOW);
    check('time: * is now, *-8h eight hours before', pt('*') === NOW && pt('*-8h') === NOW - 8 * 3600000);
    check('time: t and today are local midnight, y the one before',
        pt('t') === mid.getTime() && pt('today') === mid.getTime() && pt('y') === mid.getTime() - 86400000);
    check('time: offsets chain, with spaces and long units', pt('t + 6h - 30min') === mid.getTime() + 5.5 * 3600000);
    check('time: a bare offset is relative to now', pt('-15m') === NOW - 900000);
    const mo = new Date(NOW); mo.setMonth(mo.getMonth() - 1);
    check('time: a month is a calendar month', pt('*-1mo') === mo.getTime());
    check('time: an ISO stamp is itself', pt('2026-10-01T06:00:00Z') === Date.parse('2026-10-01T06:00:00Z'));
    check('time: what it cannot read is null, not a guess',
        [' ', '5', 'today5', '*-8q', 'next week', '*-'].every((x) => pt(x) === null), [' ', '5', 'today5', '*-8q', 'next week', '*-'].map(pt));

    // Site theme from pvx-config.js: tokens, palette and status in place,
    // a bad colour ignored without losing the rest, a symbol's own colours
    // still winning, and none of it left behind when the theme is removed.
    const PVX = win.PVX;
    const pal0 = PVX.color.categorical.slice();
    const warned = [];
    const warn0 = win.console.warn;
    win.console = Object.assign({}, console, { warn: (m) => warned.push(m) });
    PVX.api.configure({ theme: {
        palette: ['#00539b', 'not a colour', '#f7a800'],
        status: { alarm: '#aa0000', loud: '#ff00ff' },
        light: { surface: '#fafafa', text: '#101010', glow: '#fff' },
        dark: { surface: '#111418' },
        container: { radius: 3, border: '1px solid #ccc; } body { display:none' }
    } });
    win.console.warn = warn0;
    const lt = PVX.theme.tokens({ Theme: 'light' });
    const dk = PVX.theme.tokens({ Theme: 'dark' });
    check('site theme: light tokens from pvx-config.js', lt.surface === '#fafafa' && lt.text === '#101010', lt);
    check('site theme: dark tokens kept apart', dk.surface === '#111418' && dk.text === '#e8ecf1', dk);
    check('site theme: a symbol\'s own background still wins', PVX.theme.tokens({ Theme: 'light', BackgroundColor: '#123456' }).surface === '#123456');
    check('site theme: palette replaced in place, bad entry dropped',
        JSON.stringify(PVX.color.categorical) === JSON.stringify(['#00539b', '#f7a800']) && lt.categorical === PVX.color.categorical, PVX.color.categorical);
    check('site theme: status merged', PVX.color.status.alarm === '#aa0000' && PVX.color.status.normal === '#2f9e5f', PVX.color.status);
    check('site theme: each bad entry is named in the console',
        warned.length === 4 && warned.every((w) => /^\[PVX\] pvx-config\.js theme: .* ignored\.$/.test(w)), warned);
    check('site theme: a container value that would break out of its rule is refused',
        /border-radius: 3px/.test(PVX.theme.siteCss) && !/display:none/.test(PVX.theme.siteCss), PVX.theme.siteCss);
    PVX.api.configure({ theme: null });
    check('site theme: removing it restores the built-ins',
        JSON.stringify(PVX.color.categorical) === JSON.stringify(pal0) && PVX.color.status.alarm === '#c8452f' &&
        PVX.theme.tokens({ Theme: 'light' }).surface === '#ffffff');

    eventListRules();
    assetRollupRules();
    lookupRules();
    displayMenuRules();
    geoRules();

    const def = win.PVMock.get('pvxAssetTable');
    check('asset table: registered', !!def);
    check('asset table: defaults to no bands', def.getDefaultConfig().Thresholds === '');
    check('asset table: a saved placeholder is cleared on load',
        def.loadConfig({ Thresholds: win.PVX.thresholds.DEFAULT }).Thresholds === '');
}

function geoRules() {
    console.log('');
    console.log(C.bold + 'Geo View rules' + C.reset);
    const win = loadBuilt(['pvxGeoView']);
    const G = win.PVX.geo;
    const near = (a, b, e) => Math.abs(a - b) < (e || 1e-6);
    const c0 = G.project(0, 0, 0);
    check('geo: 0,0 is the middle of the one tile at zoom 0', near(c0.x, 128) && near(c0.y, 128), c0);
    const lon = G.project(51.5, -0.12, 10);
    const back = G.unproject(lon.x, lon.y, 10);
    check('geo: project then unproject gives the place back', near(back.lat, 51.5, 1e-9) && near(back.lon, -0.12, 1e-9), back);
    check('geo: a zoom level doubles the world', near(G.project(51.5, -0.12, 11).x, lon.x * 2, 1e-6));
    check('geo: tile addresses wrap east-west, and {s} takes a subdomain',
        G.tileUrl('https://{s}.t/{z}/{x}/{y}.png', 2, -1, 1, 'abc') === 'https://b.t/2/3/1.png' && G.tileUrl('/t/{z}/{x}/{y}', 2, 4, 0, '') === '/t/2/0/0',
        G.tileUrl('https://{s}.t/{z}/{x}/{y}.png', 2, -1, 1, 'abc'));
    const pts = [{ lat: 51.50, lon: -0.12 }, { lat: 51.52, lon: -0.09 }];
    const f = G.fit(pts, 520, 340, 24, 18);
    const e = G.extent(pts, f.z);
    const e1 = G.extent(pts, f.z + 1);
    check('geo: fit takes the deepest zoom where both fit', e.x1 - e.x0 <= 472 && e.y1 - e.y0 <= 292 && (e1.x1 - e1.x0 > 472 || e1.y1 - e1.y0 > 292), f);
    check('geo: one place alone gets a close view, no closer than allowed', G.fit([pts[0]], 520, 340, 24, 12).z === 12 && G.fit([pts[0]], 520, 340, 24, 18).z === 14);
    const L = G.parseLocations('Pump 1 | 51.5 | -0.12\nPump 2 | 51.6, -0.10\n# comment\nNowhere | 95 | 0\nOops');
    check('geo: locations in either form, and the lines that do not read kept', L.list.length === 2 && L.list[1].lat === 51.6 && L.bad.length === 2, L);
    check('geo: no tile server unless the site names one', G.site() === null);
    win.PVX.api.configure({ map: { tileUrl: '/tiles/{z}/{x}/{y}.png', maxZoom: 30 } });
    check('geo: ...and its zoom kept in range', G.site() && G.site().maxZoom === 22, G.site());
    win.PVX.api.configure({ map: { tileUrl: '/tiles/no-placeholders.png' } });
    check('geo: a tile address without {z}, {x} and {y} is no tile server', G.site() === null);
    const vis = win.PVMock.get('pvxGeoView').visObjectType;
    const rows = [{ label: 'Flow', path: 'af:\\\\AF\\DB\\Site\\Pump 1|Flow?x' }, { label: 'Level', path: 'af:\\\\AF\\DB\\Site\\Tank 2|Level?x' },
        { label: 'Speed', path: 'af:\\\\AF\\DB\\Site\\Fan|Speed?x' }, { label: 'PI point', path: 'pi:\\\\PI\\sinusoid?y' }];
    const m = vis.matchLocations(rows, [{ key: 'FLOW', lat: 1, lon: 1 }, { key: 'tank 2', lat: 2, lon: 2 }, { key: '\\\\AF\\DB\\Site\\Fan', lat: 3, lon: 3 }],
        win.PVX.nav.assetOf);
    check('geo: matched by label, element name or element path; a PI point by its label only',
        m[0].lat === 1 && m[1].lat === 2 && m[2].lat === 3 && m[3] === null, m);
}

function displayMenuRules() {
    console.log('');
    console.log(C.bold + 'Display Menu rules' + C.reset);
    const win = loadBuilt(['pvxDisplayMenu']);
    const vis = win.PVMock.get('pvxDisplayMenu').visObjectType;
    const icons = win.PVX.icons.paths;
    const m = vis.parseMenu([
        '[home] Overview -- The plant | 101',
        'Units',
        '    Unit 1 | 201',
        '\tUnit 2 | 202 | asset=X; tab=new',
        '        Detail | 203',
        '    ---',
        '    ---',
        '    Web | https://intranet/x',
        '    ---',
        'Nowhere',
        '# a comment',
        'Arrows',
        '> Deep | 401',
        '>> Deeper | 402',
        '[nosuch] Odd | 501'
    ].join('\n'), icons);
    const names = (list) => list.map((i) => i.sep ? '---' : i.label);
    check('menu: top level, a line with no target and nothing under it left out',
        JSON.stringify(names(m.items)) === '["Overview","Units","Arrows","[nosuch] Odd"]' && m.dropped === 1, names(m.items));
    check('menu: an icon and a tooltip come off the label', m.items[0].icon === 'home' && m.items[0].tip === 'The plant');
    const units = m.items[1];
    check('menu: indentation nests, a tab is four spaces; doubled and trailing separators go',
        JSON.stringify(names(units.children)) === '["Unit 1","Unit 2","---","Web"]', names(units.children));
    check('menu: deeper still, under the line above', units.children[1].children[0].label === 'Detail' && units.children[1].children[0].id === '1.1.0');
    check('menu: options, and a web page told from a display',
        units.children[1].opts.asset === 'X' && units.children[1].opts.tab === 'new' && units.children[3].kind === 'web' && units.children[0].kind === 'display');
    check('menu: > marks a level too', m.items[2].children[0].label === 'Deep' && m.items[2].children[0].children[0].label === 'Deeper');
    check('menu: display keys ignore the slug and the address around them',
        vis.displayKey('203') === '203' && vis.displayKey('203/Some-Name') === '203' &&
        vis.displayKey('https://h/PIVision/#/Displays/203/Other?asset=x') === '203');
    check('menu: the current display and every menu above it', JSON.stringify(vis.activePath(m.items, '203')) === '["1","1.1","1.1.0"]',
        vis.activePath(m.items, '203'));
    const nav = win.PVX.nav;
    win.location = { href: 'http://h/PIVision/#/Displays/1/A?hidetoolbar&mode=kiosk&starttime=*-8h' };
    check('menu: hidden PI Vision chrome stays hidden on the next display',
        nav.url({ display: '2' }) === 'http://h/PIVision/#/Displays/2?starttime=*-8h&mode=kiosk&hidetoolbar', nav.url({ display: '2' }));
}

function eventListRules() {
    const win = loadBuilt(['pvxEventList']);
    const V = win.PVMock.get('pvxEventList').visObjectType;
    const cols = V.parseColumns('name, Reason Code, asset, NAME, ; duration');
    check('event list: columns in order, an unknown word is an attribute, a repeat is dropped',
        JSON.stringify(cols.map((c) => c.key)) === JSON.stringify(['name', 'attr:reason code', 'element', 'duration']) &&
        cols[1].label === 'Reason Code', cols.map((c) => c.key));
    check('event list: a blank column list is the default one', V.parseColumns('  ').length === 5);
    check('event list: the group attribute is read even when not shown',
        JSON.stringify(V.attributeNames(cols, { GroupBy: 'attribute', GroupAttribute: 'Shift' })) === JSON.stringify(['Reason Code', 'Shift']));
    check('event list: overlapping time is counted once in the union',
        V.unionMs([{ from: 0, to: 10 }, { from: 5, to: 20 }, { from: 30, to: 40 }]) === 30);

    const ev = (name, start, end, rc) => ({ name, template: 'D', start, end, open: end === null, elName: '',
        attrs: rc === undefined ? {} : { 'reason code': { value: rc, units: '' } } });
    const evs = [ev('a', 0, 10, 'Trip'), ev('b', 20, 50), ev('c', 5, 25, 'Mech'), ev('d', 60, null, 'Mech')];
    const base = { cols, filter: '', sortKey: 'start', desc: true, groupBy: 'none', now: 100,
        textOf: (e, c) => (c.kind === 'name' ? e.name : '') };
    let L = V.buildList(evs, base);
    check('event list: newest first by default', L.groups[0].rows.map((e) => e.name).join('') === 'dbca');
    check('event list: an active event is timed to now', L.durMs === 10 + 30 + 20 + 40 && L.open === 1, L.durMs);
    L = V.buildList(evs, Object.assign({}, base, { sortKey: 'attr:reason code', desc: true }));
    check('event list: a blank value sorts last either way', L.groups[0].rows[3].name === 'b', L.groups[0].rows.map((e) => e.name));
    L = V.buildList(evs, Object.assign({}, base, { sortKey: 'attr:reason code', desc: false }));
    check('event list: ... ascending too', L.groups[0].rows[3].name === 'b', L.groups[0].rows.map((e) => e.name));
    L = V.buildList(evs, Object.assign({}, base, { filter: ' C ' }));
    check('event list: the filter matches shown text, without case', L.shown === 1 && L.hidden === 3);
    L = V.buildList(evs, Object.assign({}, base, { groupBy: 'attribute', groupAttribute: 'Reason Code' }));
    check('event list: groups alphabetical, unassigned last',
        L.groups.map((g) => g.label + g.count).join(',') === 'Mech2,Trip1,(unassigned)1', L.groups.map((g) => g.label));
    check('event list: a group\'s duration and union', L.groups[0].durMs === 60 && L.groups[0].union === 60);
    L = V.buildList(evs, Object.assign({}, base, { openOnly: true }));
    check('event list: only active events', L.shown === 1 && L.closedHidden === 3);
}

function assetRollupRules() {
    const win = loadBuilt(['pvxAssetRollup']);
    const V = win.PVMock.get('pvxAssetRollup').visObjectType;
    const row = (value, group, good) => ({ value, group, good: good !== false });
    const rows = [row(10, 'A'), row(20, 'A'), row(30, 'B'), row('Running', 'B'), row(null, 'C'), row(5, 'D', false), row(40, '')];
    let a = V.aggregate(rows, 'sum');
    check('rollup: a sum leaves out no value, bad quality and text, and counts them', a.v === 100 && a.used === 4 && a.skipped === 3, a);
    a = V.aggregate(rows, 'avg');
    check('rollup: an average over the values that went in', a.v === 25, a);
    a = V.aggregate(rows, 'median');
    check('rollup: an even median is the mean of the middle two', a.v === 25, a);
    a = V.aggregate([row(2), row(4), row(4), row(4), row(5), row(5), row(7), row(9)], 'stddev');
    check('rollup: the sample standard deviation', Math.abs(a.v - 2.138) < 0.001, a);
    check('rollup: one value has no standard deviation', V.aggregate([row(3)], 'stddev').v === null);
    check('rollup: counting assets needs no value', V.aggregate(rows, 'count').v === 7);
    a = V.aggregate([row({}.x), row('running'), row(1), row('Stopped'), row('Fault')], 'count', 'Running, 1');
    check('rollup: count when, any of a list, a name without case and a number by value', a.v === 2 && a.used === 4 && a.skipped === 1, a);
    check('rollup: distinct values without case',
        V.aggregate([row('Running'), row('running'), row('Fault'), row(null)], 'countDistinct').v === 2);

    const o = { groupBy: 'attribute', kind: 'avg', topN: 2, others: true, all: true, sortBy: 'value', desc: true };
    let b = V.buildCards(rows, o);
    check('rollup: All first, then the largest groups, Others, unassigned never ahead of a value',
        b.cards.map((c) => c.label).join(',') === 'All,B,A,Others (3)', b.cards.map((c) => c.label + '=' + c.v));
    check('rollup: Others is worked out from its own assets, not from the cards',
        b.cards[3].v === 40 && b.cards[3].n === 3 && b.cards[3].others === true, b.cards[3]);
    b = V.buildCards(rows, Object.assign({}, o, { others: false, all: false, topN: 10 }));
    check('rollup: blank groups are one unassigned card, last',
        b.cards.map((c) => c.label).join(',') === 'B,A,C,D,(unassigned)',
        b.cards.map((c) => c.label + '=' + c.v));
    b = V.buildCards(rows, Object.assign({}, o, { others: false, all: false, topN: 1 }));
    check('rollup: without Others the hidden groups are counted', b.cards.length === 1 && b.folded === 4, b);
    b = V.buildCards(rows, Object.assign({}, o, { sortBy: 'name', desc: false, all: false, topN: 10 }));
    check('rollup: by name', b.cards.map((c) => c.label).join(',') === 'A,B,C,D,(unassigned)', b.cards.map((c) => c.label));
    b = V.buildCards(rows, { groupBy: 'none', kind: 'max', topN: 8 });
    check('rollup: no grouping is one card', b.cards.length === 1 && b.cards[0].v === 40 && b.cards[0].label === '');
    check('rollup: defaults colour nothing', win.PVMock.get('pvxAssetRollup').getDefaultConfig().Thresholds === '' &&
        win.PVMock.get('pvxAssetRollup').getDefaultConfig().Target === '');
}

function lookupRules() {
    const win = loadBuilt(['pvxLookupTable']);
    const V = win.PVMock.get('pvxLookupTable').visObjectType;
    let rf = V.parseRowFilter('Unit = {asset}\nWidth >= 1200\nLine in A, B\nProduct contains foil\nName != x\n# a note\nnonsense');
    check('lookup: row conditions read, a note skipped, a bad line named',
        JSON.stringify(rf.rules.map((r) => r.col + r.op + r.value)) === JSON.stringify(['Unit={asset}', 'Width>=1200', 'LineinA, B', 'Productcontainsfoil', 'Name<>x']) &&
        JSON.stringify(rf.errors) === '["nonsense"]', [rf.rules, rf.errors]);
    check('lookup: numbers compare as numbers', V.test('900', { op: '<', value: '1000' }) && !V.test('900', { op: '>', value: '1000' }));
    check('lookup: text without case, and {asset} filled in', V.test('k-301', { op: '=', value: '{asset}' }, { asset: 'K-301' }));
    check('lookup: in and starts', V.test('B', { op: 'in', value: 'a, b' }) && V.test('Foil 20', { op: 'starts', value: 'foil' }));
    const pc = V.parseColumns('grade, MaxWidth | Max (mm), Nope, GRADE', ['Grade', 'Unit', 'MaxWidth']);
    check('lookup: columns matched without case, a header, a repeat dropped, an unknown one returned',
        pc.cols.map((c) => c.name + '/' + c.label).join(',') === 'Grade/Grade,MaxWidth/Max (mm)' && pc.missing.join() === 'Nope', pc);
    check('lookup: blank columns is every column', V.parseColumns('', ['A', 'B']).cols.length === 2);
    const rows = [{ G: 'b', N: 10, U: 'x' }, { G: 'a', N: 2, U: '' }, { G: 'c', N: '', U: 'x' }, { G: 'd', N: 7, U: 'y' }];
    let b = V.buildTable(rows, { sortCol: 'N', desc: true, max: 0 });
    check('lookup: sort numbers, blank last', b.groups[0].rows.map((r) => r.G).join('') === 'bdac', b.groups[0].rows.map((r) => r.G));
    b = V.buildTable(rows, { sortCol: 'N', desc: false, max: 2 });
    check('lookup: ascending, then capped and counted', b.groups[0].rows.map((r) => r.G).join('') === 'ad' && b.capped === 2 && b.shown === 2, b);
    b = V.buildTable(rows, { rules: [{ col: 'U', op: '=', value: 'x' }], groupCol: 'G', max: 0 });
    check('lookup: a rule leaves rows out and counts them', b.ruled === 2 && b.shown === 2, b);
    b = V.buildTable(rows, { groupCol: 'U', max: 0 });
    check('lookup: groups in order, blank last', b.groups.map((g) => g.label + g.rows.length).join(',') === 'x2,y1,(blank)1', b.groups.map((g) => g.label));
    b = V.buildTable(rows, { filter: 'D', textOf: (r) => r.G, max: 0 });
    check('lookup: the filter box', b.shown === 1 && b.hidden === 3);
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
    [S1, 'Station', { 'Navigation Menu': ['Overview | 101\nDetails | 102', ''],
        'Display Menu': ['Station | 110\nCompressors\n    K-301 | 111\n    K-302 | 112', ''] }],
    [K301, 'Compressor', { 'Discharge Pressure': [1081, 'psig'], 'Vibration': [3.9, 'mils'], 'Status': [{ Name: 'Running', Value: 1 }, ''],
        'Latitude': [51.5, ''], 'Longitude': [-0.12, ''] }],
    [K302, 'Compressor', { 'Discharge Pressure': [1169, 'psig'], 'Vibration': [6.2, 'mils'], 'Status': [{ Name: 'Fault', Value: 3 }, ''],
        'Latitude': ['51.52', ''], 'Longitude': ['-0.09', ''] }],
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
FRAMES[S1] = [{ Name: 'Station 1 ESD test', StartTime: iso(400), EndTime: iso(390), self: 'ef4', template: 'Test' }];
// "K-303 start" overlaps "K-302 high vibration" by five minutes, and
// "K-303 surge" has not ended: PI's year-9999 sentinel.
FRAMES[K303] = [{ Name: 'K-303 start', StartTime: iso(100), EndTime: iso(85), self: 'ef5' },
    { Name: 'K-303 surge', StartTime: iso(45), EndTime: '9999-12-31T23:59:59Z', self: 'ef6' }];
// Each frame's primary referenced element: the first one listing it.
const PRIMARY = {};
Object.keys(FRAMES).forEach((k) => FRAMES[k].forEach((f) => { if (!PRIMARY[f.self]) { PRIMARY[f.self] = k; } }));
// Event frame attribute values, [value, units].
const EF_ATTRS = {
    ef1: { 'Reason Code': ['Trip', ''], 'Lost Production': [12.5, 't'] },
    ef2: { 'Reason Code': ['Mechanical', ''], 'Lost Production': [4, 't'] },
    ef3: { 'Reason Code': ['Mechanical', ''] },
    ef6: { 'Lost Production': [{ Name: 'Bad Input', Value: 307 }, ''] }
};

// The AF table the Lookup Table reads: grades per unit, with a date each took effect.
const TABLE = {
    Columns: { Grade: 'String', Unit: 'String', MinWidth: 'Double', MaxWidth: 'Double', Effective: 'DateTime' },
    Rows: [
        { Grade: 'A-100', Unit: 'K-301', MinWidth: 1000, MaxWidth: 1180, Effective: iso(60) },
        { Grade: 'B-200', Unit: 'K-302', MinWidth: 1100, MaxWidth: 1260, Effective: iso(3000) },
        { Grade: 'C-300', Unit: 'K-301', MinWidth: 900, MaxWidth: 1050, Effective: iso(5000) },
        { Grade: 'D-400', Unit: '', MinWidth: 1200, MaxWidth: 1400, Effective: iso(30) }
    ]
};

// AF limit traits, by attribute path.
const TRAITS = {};
TRAITS[K301 + '|Discharge Pressure'] = { Hi: 1150, Lo: 1000, Target: 1080, HiHi: 1200, LoLo: 950 };

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
let tileHits = [];

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
    let m = /^attributes\/([^/]+)\/attributes$/.exec(rel);
    if (m && q.get('trait')) {
        const a = byWebId[m[1]];
        if (!a || a.kind !== 'attribute') { return notFound; }
        const tv = (TRAITS[a.path] || {})[q.get('trait')];
        return { status: 200, body: { Items: tv === undefined ? [] : [{ WebId: wid('t', a.path + '|' + q.get('trait')) }] } };
    }
    m = /^streams\/Wt:(.+)\|(\w+)\/value$/.exec(rel);
    if (m) {
        const tv = (TRAITS[m[1]] || {})[m[2]];
        return tv === undefined ? notFound : { status: 200, body: { Timestamp: iso(1), Value: tv, Good: true } };
    }
    // AF tables: one in the database, read whole, as PI Web API returns them.
    let mt = /^assetdatabases\/([^/]+)\/tables$/.exec(rel);
    if (mt) {
        return byWebId[mt[1]] ? { status: 200, body: { Items: [{ Name: 'Grade Specifications', WebId: 'Wt:grades' }, { Name: 'Shift Roster', WebId: 'Wt:roster' }] } } : notFound;
    }
    mt = /^tables\/([^/]+)\/data$/.exec(rel);
    if (mt) {
        return mt[1] === 'Wt:grades' ? { status: 200, body: TABLE } : notFound;
    }
    if (rel === 'points' && q.get('path')) {
        return q.get('path').toLowerCase() === '\\\\pisrv\\sinusoid'
            ? { status: 200, body: { Name: 'SINUSOID', WebId: 'Wp:SINUSOID' } } : notFound;
    }
    // Plot values for the quick trend: 60 values over the last 8 hours around
    // the attribute's value, whatever the range asked (the request is checked).
    m = /^streams\/([^/]+)\/plot$/.exec(rel);
    if (m) {
        const a = byWebId[m[1]];
        const [v, units] = m[1] === 'Wp:SINUSOID' ? [50, ''] : (a && a.kind === 'attribute' ? a.element.attrs[a.name] : [null, null]);
        if (v === null) { return notFound; }
        const items = [];
        for (let i = 0; i < 60; i++) {
            const val = typeof v === 'object' ? v : v * (1 + 0.02 * Math.sin(i / 5));
            items.push({ Timestamp: iso(480 - i * 8), Value: val, Good: i !== 7, UnitsAbbreviation: units });
        }
        return { status: 200, body: { Items: items } };
    }
    // Recorded values for a symbol's own time range: daily over the last
    // 150 days, as many as maxCount allows, the newest 777 so it is told
    // apart from what the pipeline sent.
    m = /^streams\/([^/]+)\/recorded$/.exec(rel);
    if (m && byWebId[m[1]] && byWebId[m[1]].kind === 'attribute') {
        const n = Math.min(150, max);
        const items = [];
        for (let i = 0; i < n; i++) { items.push({ Timestamp: iso((n - 1 - i) * 1440 + 1), Value: i === n - 1 ? 777 : 1000 + i, Good: true }); }
        return { status: 200, body: { Items: items } };
    }
    m = /^streams\/([^/]+)\/value$/.exec(rel);
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
            if (q.get('nameFilter')) {
                const re = new RegExp('^' + q.get('nameFilter').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
                list = list.filter((p) => re.test(nameOf(p)));
            }
            return { status: 200, body: { Items: list.slice(0, max).map(elementOut) } };
        }
        // The database holds each frame once, however many elements it references.
        const frames0 = m[1] === 'elements' ? (FRAMES[o.path] || [])
            : Object.keys(FRAMES).reduce((all, k) => all.concat(FRAMES[k].filter((f) => PRIMARY[f.self] === k)), []);
        const tpl = q.get('templateName');
        const frames = frames0.filter((f) => !tpl || (f.template || 'Downtime').toLowerCase() === tpl.toLowerCase());
        const wantPrimary = /PrimaryReferencedElement/.test(q.get('selectedFields') || '');
        return { status: 200, body: { Items: frames.slice(0, max).map((f) => {
            const links = { Self: 'http://x/piwebapi/eventframes/' + f.self };
            if (wantPrimary) { links.PrimaryReferencedElement = 'http://x/piwebapi/elements/' + wid('e', PRIMARY[f.self]); }
            return { Name: f.Name, StartTime: f.StartTime, EndTime: f.EndTime, TemplateName: f.template || 'Downtime', Links: links };
        }) } };
    }
    m = /^elements\/([^/]+)$/.exec(rel);
    if (m) {
        const o = byWebId[m[1]];
        return o && o.kind === 'element' ? { status: 200, body: { Name: nameOf(o.path), Path: o.path } } : notFound;
    }
    m = /^streamsets\/([^/]+)\/value$/.exec(rel);
    if (m && byWebId[m[1]] && byWebId[m[1]].kind === 'element') {
        // An element's attributes, as one stream set: what the Asset Rollup reads.
        const attrs = byWebId[m[1]].attrs;
        const want = (q.get('nameFilter') || '').toLowerCase();
        return { status: 200, body: { Items: Object.keys(attrs).filter((a) => !want || a.toLowerCase() === want).map((a) => ({
            Name: a, Value: { Timestamp: iso(1), Value: attrs[a][0], UnitsAbbreviation: attrs[a][1], Good: true } })) } };
    }
    if (m && /^ef\d+$/.test(m[1])) {
        const attrs = EF_ATTRS[m[1]] || {};
        const want = (q.get('nameFilter') || '').toLowerCase();
        return { status: 200, body: { Items: Object.keys(attrs).filter((a) => !want || a.toLowerCase() === want).map((a) => ({
            Name: a, Value: { Timestamp: iso(1), Value: attrs[a][0], UnitsAbbreviation: attrs[a][1], Good: typeof attrs[a][0] !== 'object' } })) } };
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
            // Map tiles for the Geo View: a 1x1 PNG, the address recorded.
            if (req.url.indexOf('/tiles/') === 0) {
                tileHits.push(req.url);
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
                return;
            }
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
    // The Geo View's tile server, as pvx-config.js would name it.
    window.PVX.api.configure({ map: a.map || null });
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
    if (a.payload && vis.onDataUpdate) {
        vis.onDataUpdate(a.payload);
    } else if (a.data !== false && vis.onDataUpdate) {
        vis.onDataUpdate({ Value: a.value === undefined ? 1 : a.value, Label: 'Name', Path: a.source || 'af:\\\\AF\\Gathering\\Station 1|Name', IsGood: true,
            Rows: a.rows || undefined });
    }
    if (vis.onResize) { vis.onResize(640, 240); }
    window.__vis = vis;
    window.__scope = scope;
}

/** The Event List against the mock AF database. */
async function eventList(open, texts, hash, settle) {
    const pg = eventList.pg;
    const EL = { DatabasePath: DB, StartTime: '*-1d',
        Columns: 'name, element, start, end, duration, Reason Code, Lost Production' };
    const names = () => texts('#box tbody tr[data-pvx-i] td:first-child');
    const foot = async () => ((await texts('#box .pvx-evl-footer'))[0] || '').replace(/\s+/g, ' ');

    await open('pvxEventList', { asset: '', config: EL });
    let rows = await names();
    check('event list: one row per event, newest first',
        JSON.stringify(rows) === JSON.stringify(['K-303 surge', 'K-302 high vibration', 'K-303 start', 'Seal leak', 'K-301 trip', 'Station 1 ESD test']), rows);
    const efAsk = requests.filter((r) => /^GET assetdatabases\/Wd:[^?]*\/eventframes\?/.test(r));
    check('event list: one event query, with the fields it shows and the primary element',
        efAsk.length === 1 && /selectedFields=Items.Name;Items.StartTime;Items.EndTime;Items.TemplateName;Items.Links.Self;Items.Links.PrimaryReferencedElement/.test(efAsk[0]) &&
        /searchMode=Overlapped/.test(efAsk[0]) && /maxCount=501/.test(efAsk[0]), efAsk);
    check('event list: element names and attribute values in one batch',
        requests.filter((r) => r === 'POST batch').length === 1 &&
        requests.filter((r) => /^batch: GET elements\/We:/.test(r)).length === 4 &&
        requests.filter((r) => /^batch: GET streamsets\/ef\d\/value/.test(r)).length === 6 &&
        !requests.some((r) => /^batch: GET streamsets.*nameFilter/.test(r)), requests);
    const first = await texts('#box tbody tr[data-pvx-i="0"] td');
    check('event list: an active event says so and is marked',
        first[1] === 'K-303' && first[3] === 'active' && (await pg.$$('#box tr.pvx-evl-open')).length === 1, first);
    check('event list: the asset is the element\'s name', (await texts('#box tbody tr[data-pvx-i="3"] td'))[1] === 'K-301');
    const heads = await texts('#box th');
    check('event list: units shared by a column go in its header', heads[6] === 'Lost Production (t)', heads);
    const trip = await texts('#box tbody tr[data-pvx-i="4"] td');
    check('event list: attribute values in their columns', trip[5] === 'Trip' && trip[6] === '12.5', trip);
    check('event list: a digital state shows its name, marked as bad quality',
        first[6] === 'Bad Input' && (await pg.$$('#box tr[data-pvx-i="0"] td.pvx-evl-bad')).length === 1, first);
    let f = await foot();
    check('event list: count, listed duration and active count', /6 events · 2h \d+m listed · 1 active/.test(f), f);
    check('event list: says where active events are timed to, and the overlap it counts twice',
        /active events timed to now/.test(f) && /events overlap: 5m of the total is counted twice/.test(f), f);
    const total = await texts('#box tr.pvx-evl-grand td');
    check('event list: a total row with the count', total[0] === 'Total · 6 events', total);

    await pg.fill('#box .pvx-evl-filter', 'seal');
    await settle();
    rows = await names();
    f = await foot();
    check('event list: typing filters the rows', JSON.stringify(rows) === JSON.stringify(['Seal leak']) && /1 of 6 match "seal"/.test(f), [rows, f]);
    await pg.fill('#box .pvx-evl-filter', 'mech');
    await settle();
    check('event list: the filter reads attribute columns too', (await names()).length === 2, await names());
    await pg.fill('#box .pvx-evl-filter', '');
    await settle();

    await pg.click('#box th[data-pvx-sort="duration"]');
    await settle();
    rows = await names();
    check('event list: a heading click sorts, longest first',
        rows[0] === 'Seal leak' && rows[1] === 'K-303 surge' && rows[5] === 'Station 1 ESD test', rows);
    await pg.click('#box th[data-pvx-sort="duration"]');
    await settle();
    check('event list: a second click reverses', (await names())[0] === 'Station 1 ESD test', await names());
    await pg.click('#box th[data-pvx-sort="name"]');
    await settle();
    check('event list: a text column sorts A to Z first', (await names())[0] === 'K-301 trip', await names());

    await open('pvxEventList', { asset: '', config: Object.assign({}, EL, { GroupBy: 'attribute', GroupAttribute: 'Reason Code', AttributeTotals: 'sum' }) });
    const groups = await texts('#box tr.pvx-evl-group td');
    check('event list: grouped by an attribute, alphabetical, unassigned last',
        JSON.stringify(groups) === JSON.stringify(['Mechanical2', 'Trip1', '(unassigned)3']), groups);
    const subs = await texts('#box tr.pvx-evl-total:not(.pvx-evl-grand) td:first-child');
    check('event list: a subtotal per group', subs.length === 3 && subs[0] === 'Subtotal · 2 events', subs);
    const grand = await texts('#box tr.pvx-evl-grand td');
    check('event list: an attribute column totals its numbers only', grand[6] === '16.5', grand);

    await open('pvxEventList', { asset: '', config: Object.assign({}, EL, { Columns: 'name, start, Reason Code' }) });
    check('event list: with one attribute the batch names it, and no element is looked up',
        requests.some((r) => /^batch: GET streamsets\/ef1\/value\?.*nameFilter=Reason Code/.test(r)) &&
        !requests.some((r) => /^batch: GET elements\//.test(r)) &&
        !requests.some((r) => /PrimaryReferencedElement/.test(r)), requests);

    await open('pvxEventList', { asset: '', config: Object.assign({}, EL, { Columns: 'name, Shift' }) });
    f = await foot();
    check('event list: an attribute no event has is named', /no event has "Shift"/.test(f), f);

    await open('pvxEventList', { asset: '', config: Object.assign({}, EL, { MaxEvents: 2 }) });
    f = await foot();
    check('event list: a capped read says so', (await names()).length === 2 && /only the first 2 events read/.test(f), f);

    await open('pvxEventList', { asset: '', config: Object.assign({}, EL, { OpenOnly: true }) });
    f = await foot();
    check('event list: only active events, the rest counted', (await names()).length === 1 && /5 ended, not shown/.test(f), f);

    await open('pvxEventList', { asset: K302, config: Object.assign({}, EL, { AssetScope: 'asset' }) });
    rows = await names();
    check('event list: the display\'s asset only',
        JSON.stringify(rows) === JSON.stringify(['K-302 high vibration', 'Seal leak']) &&
        requests.some((r) => /^GET elements\/We:.*K-302\/eventframes\?/.test(r)), [rows, requests]);

    await open('pvxEventList', { asset: '', config: Object.assign({}, EL, { ClickAction: 'time' }) });
    await pg.click('#box tbody tr[data-pvx-i="3"]');
    let h = await hash();
    check('event list: a row sets this display to the event',
        /^#\/Displays\/101\/Overview\?/.test(h) && /starttime=\d{4}-/.test(h) && /endtime=\d{4}-/.test(h), h);

    await open('pvxEventList', { asset: '', config: Object.assign({}, EL, { ClickAction: 'asset' }) });
    await pg.click('#box tbody tr[data-pvx-i="3"]');
    h = await hash();
    check('event list: a row shows its asset, keeping the display', h === '#/Displays/101/Overview?asset=' + K301, h);

    await open('pvxEventList', { asset: '', config: Object.assign({}, EL, { ClickAction: 'navigate', NavigateTarget: '205' }) });
    await pg.click('#box tbody tr[data-pvx-i="1"]');
    h = await hash();
    check('event list: a row opens another display at its time and asset',
        /^#\/Displays\/205\?/.test(h) && h.indexOf('asset=' + K302) !== -1 && /starttime=\d{4}-/.test(h), h);

    await open('pvxEventList', { asset: '', config: EL, configured: false });
    const msg = await pg.$eval('#box', (n) => n.textContent);
    check('event list: unconfigured says what to do', /PI Web API is not configured/.test(msg) && /piwebapi-check\.html/.test(msg), msg.slice(0, 200));
}

/**
 * One minute samples over eight hours: zero between events, and inside each
 * Downtime run 100 plus the minutes since it started, so every run lies on
 * the same line when they are lined up at their start. "K-302 high
 * vibration" runs 20 higher: the bad batch.
 */
function runPayload() {
    const seen = {};
    const runs = [];
    Object.keys(FRAMES).forEach((k) => FRAMES[k].forEach((f) => {
        if (seen[f.self] || f.template) { return; }
        seen[f.self] = true;
        const e = Date.parse(f.EndTime);
        runs.push({ name: f.Name, s: Date.parse(f.StartTime), e: e > Date.UTC(9000, 0, 1) ? Infinity : e });
    }));
    const end = Date.now();
    const vals = [];
    for (let m = 480; m >= 0; m--) {
        const t = end - m * 60000;
        const r = runs.find((x) => t >= x.s && t <= x.e);
        const v = r ? 100 + (t - r.s) / 60000 + (r.name === 'K-302 high vibration' ? 20 : 0) : 0;
        vals.push({ Time: new Date(t).toISOString(), Value: v });
    }
    return { Data: [{ Label: 'Pressure', Units: 'psig', Path: 'af:' + K301 + '|Discharge Pressure?x', IsGood: true, Values: vals }] };
}

/** Period Comparison with runs from event frames. */
async function eventRuns(open, settle) {
    const pg = eventList.pg;
    const RUNS = { PeriodMode: 'events', EventTemplate: 'Downtime', ShowStats: true };
    const body = () => pg.$eval('#box', (n) => n.textContent);
    const labels = () => pg.$$eval('#box svg text', (ns) => ns.map((n) => n.textContent));
    const go = async (cfg, extra) => {
        await open('pvxPeriodOverlay', Object.assign({ asset: '', config: Object.assign({}, RUNS, cfg), payload: runPayload() }, extra || {}));
        await settle();
    };

    await go({ ColorMode: 'palette' });
    const ask = requests.filter((r) => /eventframes/.test(r));
    check('runs: one event frame query over the data\'s window, template and the three fields',
        ask.length === 1 && /^GET assetdatabases\/Wd:[^?]*\/eventframes\?/.test(ask[0]) && /templateName=Downtime/.test(ask[0]) &&
        /selectedFields=Items.Name;Items.StartTime;Items.EndTime(&|$)/.test(ask[0]) && /searchMode=Overlapped/.test(ask[0]), ask);
    let b = await body();
    let l = await labels();
    check('runs: five runs, the database from the data source', /5 runs · aligned at the start/.test(b) &&
        b.indexOf('database ' + DB + ' from this symbol\'s data source') !== -1, b.slice(-300));
    check('runs: the legend names each run', l.indexOf('K-303 surge') !== -1 && l.indexOf('K-301 trip') !== -1, l);
    check('runs: the axis is time since the start', l.indexOf('0') !== -1 && b.indexOf('Since the start') !== -1, l);
    check('runs: says the current run is still active', /the current run is still active/.test(b), b.slice(-300));

    await go({ GoldenEvents: 'seal leak, K-301 TRIP', GoldenTolerance: '5%' });
    b = await body();
    l = await labels();
    check('runs: two golden runs, matched without case, are the reference',
        l.indexOf('golden (2)') !== -1 && l.indexOf('±5%') !== -1 && l.indexOf('2 golden runs') !== -1, l);
    check('runs: the current run on the golden line is 100% in tolerance',
        l.indexOf('In tolerance') !== -1 && l.indexOf('100%') !== -1, l);

    await go({ GoldenEvents: 'K-302*', GoldenTolerance: '5%' });
    l = await labels();
    check('runs: against a bad batch the current run leaves the band',
        l.indexOf('In tolerance') !== -1 && l.indexOf('100%') === -1 && l.indexOf('0%') !== -1, l);

    await go({ GoldenEvents: 'Batch 9', GoldenTolerance: '5%' });
    b = await body();
    check('runs: a golden name that matches nothing is said', /no run matches the golden runs "Batch 9"/.test(b), b.slice(-300));

    await go({ GoldenEvents: 'Seal leak', GoldenTolerance: 'lots' });
    b = await body();
    check('runs: a tolerance it cannot read is said, and 5% used', /tolerance "lots" not read, 5% used/.test(b), b.slice(-300));

    await go({ GoldenEvents: 'Seal leak', GoldenTolerance: '2s' });
    b = await body();
    check('runs: standard deviations need two golden runs', /needs two golden runs/.test(b), b.slice(-300));

    await go({ EventAlign: 'normalized' });
    l = await labels();
    b = await body();
    check('runs: 0 to 100% of each run', l.indexOf('0%') !== -1 && l.indexOf('100%') !== -1 && /0 to 100% of each run/.test(b), l);

    await go({ EventAlign: 'end' });
    l = await labels();
    check('runs: at the end, the axis counts back to 0', l[l.length - 1] !== undefined && l.some((x) => /^-\d/.test(x)) && /aligned at the end/.test(await body()), l);

    await go({ MaxPeriods: 2, GoldenEvents: 'K-301 trip' });
    b = await body();
    check('runs: a golden run is kept past the limit, the others counted',
        /3 runs/.test(b) && /2 older runs not shown/.test(b), b.slice(0, 400));

    await go({ EventScope: 'asset' }, { asset: K302 });
    check('runs: the display\'s asset only', requests.some((r) => /^GET elements\/We:.*K-302\/eventframes\?/.test(r)), requests);

    await go({}, { configured: false });
    b = await body();
    check('runs: no PI Web API says so', /PI Web API is not configured/.test(b), b.slice(0, 200));

    await open('pvxPeriodOverlay', { asset: '', config: { PeriodMode: 'day' }, payload: runPayload() });
    check('runs: the clock periods ask PI Web API nothing', !requests.some((r) => /piwebapi|eventframes|assetdatabases/.test(r)), requests);
}

/** The Asset Rollup against the mock AF database. */
async function assetRollup(open, settle, hash) {
    const pg = eventList.pg;
    const go = async (cfg, extra) => {
        await open('pvxAssetRollup', Object.assign({ asset: S1, config: cfg }, extra || {}));
        await settle();
    };
    const cards = () => pg.$$eval('#box .pvx-arl-card', (ns) => ns.map((n) => ({
        label: (n.querySelector('.pvx-arl-label') || {}).textContent || '',
        value: n.querySelector('.pvx-arl-value').textContent, sub: n.querySelector('.pvx-arl-sub').textContent,
        colour: n.style.borderLeftColor })));
    const note = () => pg.$eval('#box', (n) => (n.querySelector('.pvx-arl-note') || {}).textContent || '');
    const body = () => pg.$eval('#box', (n) => n.textContent);

    await go({});
    let c = await cards();
    check('rollup: no attribute counts the assets under the display\'s asset',
        c.length === 1 && c[0].value === '3' && /Asset count/.test(await body()), c);
    check('rollup: one search, all the way down, and no value reads',
        requests.some((r) => /^GET elements\/We:.*Station 1\/elements\?.*searchFullHierarchy=true/.test(r)) &&
        !requests.some((r) => /streamsets/.test(r)), requests);
    check('rollup: the footer says where it looked', /3 assets under Station 1/.test(await note()), await note());

    await go({ SearchTemplate: 'Compressor', Attribute: 'Discharge Pressure' });
    c = await cards();
    check('rollup: a total with its units', c.length === 1 && /^2,?250\s*psig$/.test(c[0].value) && c[0].sub === '2 of 2 assets', c);
    check('rollup: the template goes to PI Web API, and each value is one sub-request of one batch',
        requests.some((r) => /^GET elements\/We:.*Station 1\/elements\?.*templateName=Compressor/.test(r)) &&
        requests.filter((r) => r === 'POST batch').length === 1 &&
        requests.filter((r) => /^batch: GET streamsets\/We:.*\/value\?nameFilter=Discharge Pressure/.test(r)).length === 2, requests);
    check('rollup: the default title names the roll-up', /Total · Discharge Pressure/.test(await body()), await body());

    await go({ Attribute: 'Discharge Pressure' });
    check('rollup: an asset without the attribute is counted, not hidden',
        /1 without "Discharge Pressure"/.test(await note()) && (await cards())[0].sub === '2 of 3 assets', await note());

    const DBW = { SearchRoot: DB, SearchTemplate: 'Compressor', Attribute: 'Discharge Pressure', Aggregate: 'avg', GroupBy: 'parent' };
    await go(DBW, { asset: '' });
    c = await cards();
    check('rollup: a database is a search root', requests.some((r) => r === 'GET assetdatabases?path=' + DB + '&selectedFields=WebId;Name;Path') &&
        requests.some((r) => /^GET assetdatabases\/Wd:[^/]*\/elements\?/.test(r)), requests.slice(0, 4));
    check('rollup: a card per parent, All first, largest first',
        c.map((x) => x.label).join(',') === 'All,Station 1,Station 2' && /^1,?067/.test(c[0].value) && /^1,?125/.test(c[1].value) && /^950/.test(c[2].value),
        c);

    await go(Object.assign({}, DBW, { TopN: 1 }), { asset: '' });
    c = await cards();
    check('rollup: past Most cards the rest is one Others card',
        c.map((x) => x.label).join(',') === 'All,Station 1,Others (1)' && /^950/.test(c[2].value), c);
    await go(Object.assign({}, DBW, { TopN: 1, ShowOthers: false, ShowAll: false }), { asset: '' });
    check('rollup: ... or the footer says how many are hidden', (await cards()).length === 1 && /1 more group not shown/.test(await note()), await note());

    await go(Object.assign({}, DBW, { Target: '1000', TargetDirection: 'higher' }), { asset: '' });
    c = await cards();
    check('rollup: a target colours each card good or bad',
        c[1].colour === 'rgb(47, 158, 95)' && c[2].colour === 'rgb(200, 69, 47)', c.map((x) => x.colour));
    await go(Object.assign({}, DBW, { Target: '1000', Thresholds: '0:#3b82c4:Low, 1100:#d99024:High' }), { asset: '' });
    c = await cards();
    check('rollup: bands win over the target', c[1].colour === 'rgb(217, 144, 36)' && c[2].colour === 'rgb(59, 130, 196)', c.map((x) => x.colour));
    await go(DBW, { asset: '' });
    c = await cards();
    check('rollup: no target and no bands, no status colour', c.every((x) => x.colour === ''), c.map((x) => x.colour));

    await go({ SearchRoot: DB, SearchTemplate: 'Compressor', Attribute: 'Status', Aggregate: 'count', CountWhen: 'running, Stopped' }, { asset: '' });
    c = await cards();
    check('rollup: count when, by digital state name', c.length === 1 && c[0].value === '2' && /Running, Stopped|running, Stopped/.test(await body()), c);

    await go({ SearchRoot: DB, SearchTemplate: 'Compressor', Attribute: 'Discharge Pressure', GroupBy: 'attribute', GroupAttribute: 'Status',
        ShowAll: false, SortBy: 'name', SortDescending: false }, { asset: '' });
    c = await cards();
    check('rollup: a card per value of another attribute, read in the same batch',
        c.map((x) => x.label).join(',') === 'Fault,Running,Stopped' && /^1,?169/.test(c[0].value) &&
        requests.filter((r) => /^batch: GET streamsets/.test(r)).length === 6, c.map((x) => x.label + '=' + x.value));

    await go({ SearchNameFilter: 'K-*', Attribute: 'Vibration', Aggregate: 'max' });
    c = await cards();
    check('rollup: the name filter goes to PI Web API', c[0].value.indexOf('6.2') === 0 && /2 assets under/.test(await note()) &&
        requests.some((r) => /nameFilter=K-\*/.test(r)), [c, requests.slice(0, 3)]);

    await go(Object.assign({}, DBW, { ClickAction: 'asset' }), { asset: '' });
    await pg.click('#box .pvx-arl-card:has-text("Station 2")');
    check('rollup: a parent card opens that asset', (await hash()).indexOf('asset=' + S2) !== -1, await hash());

    await go({ Attribute: 'Discharge Pressure' }, { configured: false });
    check('rollup: says so when PI Web API is not configured', /PI Web API is not configured/.test(await body()), await body());
    await go({ SearchRoot: DB + '\\Nowhere' }, { asset: '' });
    check('rollup: a root that is not there is named', /There is no AF element at ".*Nowhere"/.test(await body()), await body());
}

/** The quick trend any symbol can open, against the mock AF database. */
async function quickTrend(open, settle) {
    const pg = eventList.pg;
    const src = (p) => 'af:' + p + '?x';
    const DP1 = K301 + '|Discharge Pressure';
    const go = async (cfg, extra) => {
        await open('pvxKpiCard', Object.assign({ asset: '', config: cfg, source: src(DP1) }, extra || {}));
        await settle();
    };
    const panel = () => pg.evaluate(() => {
        const p = document.querySelector('.pvx-qt');
        if (!p) { return null; }
        return { chips: Array.from(p.querySelectorAll('.pvx-qt-name')).map((n) => n.textContent),
            lines: p.querySelectorAll('.pvx-qt-line').length, foot: p.querySelector('.pvx-qt-foot').textContent,
            text: p.textContent, left: p.style.left, top: p.style.top };
    });
    const plotAsks = () => requests.filter((r) => /\/plot\?/.test(r));

    await go({});
    check('trend: no button unless asked', !(await pg.$('#box .pvx-overlay-trend')), await pg.$$eval('#box .pvx-overlay', (n) => n.length));
    await go({ QuickTrend: true });
    check('trend: the button asks nothing until pressed', !requests.some((r) => /plot|attributes\?path/.test(r)), requests);
    await pg.click('#box .pvx-overlay-trend');
    await settle();
    let p = await panel();
    check('trend: opens a panel with the symbol\'s source', p && p.chips.join('|') === 'K-301 · Discharge Pressure' && p.lines === 1, p);
    check('trend: one WebId and one plot request over the display\'s range',
        requests.some((r) => r === 'GET attributes?path=' + DP1 + '&selectedFields=WebId') &&
        plotAsks().length === 1 && /startTime=\*-8h&endTime=\*&intervals=\d+&selectedFields=Items.Timestamp;Items.Value;Items.Good;Items.UnitsAbbreviation/.test(plotAsks()[0]),
        requests);
    check('trend: units and the bad value in the footer', /psig/.test(p.foot) && /1 bad value left out/.test(p.foot), p.foot);

    await pg.evaluate((s) => window.PVX.trend.open([s]), src(K302 + '|Discharge Pressure'));
    await settle();
    p = await panel();
    check('trend: another symbol\'s source joins the open trend, on one axis', p.lines === 2 && !/units differ/.test(p.foot), p);
    const again = await pg.evaluate((s) => window.PVX.trend.open([s]), src(DP1));
    await settle();
    check('trend: a source already on it is not added twice', again.added === 0 && again.already === 1 && /already on this trend/.test((await panel()).foot), again);
    await pg.evaluate((s) => window.PVX.trend.open(s), [src(K301 + '|Vibration'), src(K301 + '|Status'), 'pi:\\\\PISRV\\SINUSOID?1']);
    await settle();
    p = await panel();
    check('trend: mixed units put each trace on its own scale, said in the footer', p.lines === 4 && /units differ: each trace on its own scale/.test(p.foot), p.foot);
    check('trend: a digital source is named, not drawn', /K-301 · Status: states or text, not drawn/.test(p.foot), p.foot);
    check('trend: a PI point is found by points?path', requests.some((r) => r === 'GET points?path=\\\\PISRV\\SINUSOID&selectedFields=WebId'), requests);

    await pg.hover('.pvx-qt-plot', { position: { x: 200, y: 60 } });
    p = await panel();
    check('trend: the pointer reads every trace at its time', /K-301 · Discharge Pressure 1,?\d{3}/.test(p.foot) && /SINUSOID \d/.test(p.foot), p.foot);

    requests = [];
    await pg.selectOption('.pvx-qt-range', '*-1d');
    await settle();
    check('trend: a range from the panel asks again for it', plotAsks().length === 5 && plotAsks().every((r) => /startTime=\*-1d&endTime=\*/.test(r)) &&
        !requests.some((r) => /attributes\?path/.test(r)), requests);

    await pg.click('.pvx-qt-chip:has-text("Vibration") .pvx-qt-remove');
    p = await panel();
    check('trend: a source can be taken off', p.chips.length === 4 && p.chips.indexOf('K-301 · Vibration') === -1, p.chips);

    const box = await pg.$eval('.pvx-qt-title', (n) => { const r = n.getBoundingClientRect(); return { x: r.left + 5, y: r.top + 5 }; });
    await pg.mouse.move(box.x, box.y);
    await pg.mouse.down();
    await pg.mouse.move(box.x - 120, box.y + 80, { steps: 4 });
    await pg.mouse.up();
    const p2 = await panel();
    check('trend: the header drags the panel', parseFloat(p2.left) === parseFloat(p.left) - 120 && parseFloat(p2.top) === parseFloat(p.top) + 80, [p.left, p.top, p2.left, p2.top]);

    await pg.focus('.pvx-qt');
    await pg.keyboard.press('Escape');
    check('trend: Escape closes it', (await panel()) === null);

    await pg.evaluate(() => { location.hash = '#/Displays/101/Overview?starttime=*-2h&endtime=*-1h'; });
    await pg.evaluate((s) => window.PVX.trend.open([s]), src(DP1));
    await settle();
    check('trend: follows the display\'s range from the address', /startTime=\*-2h&endTime=\*-1h/.test(plotAsks().pop() || ''), plotAsks());
    await pg.evaluate(() => window.PVX.trend.close());

    await pg.evaluate((s) => window.PVX.trend.open([s]), src(K301 + '|Nowhere'));
    await settle();
    p = await panel();
    check('trend: a source PI Web API does not know is named', /Nothing to draw/.test(p.text) && /K-301 · Nowhere: Not found/.test(p.text), p.text);
    await pg.evaluate(() => window.PVX.trend.close());

    await go({ QuickTrend: true }, { configured: false });
    await pg.click('#box .pvx-overlay-trend');
    await settle();
    p = await panel();
    check('trend: says so when PI Web API is not configured', p && /PI Web API is not configured/.test(p.text), p && p.text);
    await pg.evaluate(() => window.PVX.trend.close());
}

/** The Lookup Table against the mock AF table. */
async function lookupTable(open, settle, hash) {
    const pg = eventList.pg;
    const go = async (cfg, extra) => {
        await open('pvxLookupTable', Object.assign({ asset: '', config: Object.assign({ TableName: 'grade specifications' }, cfg) }, extra || {}));
        await settle();
    };
    const view = () => pg.evaluate(() => ({
        heads: Array.from(document.querySelectorAll('#box .pvx-lkt-table th')).map((n) => n.textContent),
        rows: Array.from(document.querySelectorAll('#box .pvx-lkt-table tbody tr[data-pvx-i]')).map((r) => Array.from(r.children).map((c) => c.textContent)),
        groups: Array.from(document.querySelectorAll('#box .pvx-lkt-group')).map((n) => n.textContent),
        note: (document.querySelector('#box .pvx-lkt-note') || {}).textContent || '',
        text: document.getElementById('box').textContent }));

    await go({ TableName: '' });
    check('lookup: says when no table is chosen', /No table chosen/.test((await view()).text));
    await go({});
    let v = await view();
    check('lookup: the table, every column in its order, the database from the data source',
        v.heads.join('|') === 'Grade|Unit|MinWidth|MaxWidth|Effective' && v.rows.length === 4 && v.rows[0][0] === 'A-100' &&
        /database .*Gathering from this symbol's data source/.test(v.note), v);
    check('lookup: the database, its table list, then the rows', requests.some((r) => /^GET assetdatabases\?path=/.test(r)) &&
        requests.some((r) => /^GET assetdatabases\/Wd:.*\/tables\?selectedFields=Items.WebId;Items.Name/.test(r)) &&
        requests.some((r) => r === 'GET tables/Wt:grades/data'), requests);
    check('lookup: numbers right-aligned', await pg.$eval('#box .pvx-lkt-table th:nth-child(3)', (n) => n.className.indexOf('pvx-lkt-right') !== -1));

    await go({ TableName: 'Grades' });
    check('lookup: a wrong name lists the tables there', /No table "Grades"/.test((await view()).text) && /Grade Specifications, Shift Roster/.test((await view()).text));

    await go({ Columns: 'grade, MaxWidth | Max (mm), Nope' });
    v = await view();
    check('lookup: chosen columns and headers, an unknown one named', v.heads.join('|') === 'Grade|Max (mm)' && /no column "Nope"/.test(v.note), v);

    await go({ RowFilter: 'Unit = {asset}' }, { asset: K301 });
    v = await view();
    check('lookup: {asset} shows this unit\'s rows', v.rows.map((r) => r[0]).join() === 'A-100,C-300' && /2 left out by the row conditions/.test(v.note), v);
    await go({ RowFilter: 'MaxWidth >= 1200\nwhat' });
    v = await view();
    check('lookup: a number condition, and a line it cannot read named', v.rows.map((r) => r[0]).join() === 'B-200,D-400' && /row condition not read: "what"/.test(v.note), v);

    await pg.click('#box .pvx-lkt-table th:nth-child(4)');
    await settle();
    v = await view();
    check('lookup: a heading click sorts, numbers largest first', v.rows.map((r) => r[0]).join() === 'D-400,B-200', v.rows);

    await go({ GroupBy: 'unit', SortBy: 'Grade', SortDescending: true });
    v = await view();
    check('lookup: groups by a column, blank last, sorted inside', v.groups.join('|') === 'K-3012|K-3021|(blank)1' && v.rows[0][0] === 'C-300', v);

    await go({ TimeColumn: 'Effective' }, { asset: '' });
    await pg.evaluate(() => { location.hash = '#/Displays/101/Overview?starttime=*-1d&endtime=*'; });
    await pg.waitForTimeout(1300);
    v = await view();
    check('lookup: only rows dated in the display\'s range', v.rows.map((r) => r[0]).join() === 'A-100,D-400' && /2 dated outside this time range/.test(v.note), v);

    await go({ ColorColumn: 'MaxWidth', Thresholds: '0:#2f9e5f:Normal, 1250:#c8452f:Wide' });
    const sh = await pg.$$eval('#box .pvx-lkt-table tbody tr td:nth-child(4)', (ns) => ns.map((n) => n.style.boxShadow));
    check('lookup: one column coloured by bands', /rgb\(47, 158, 95\)/.test(sh[0]) && /rgb\(200, 69, 47\)/.test(sh[1]) &&
        !(await pg.$eval('#box .pvx-lkt-table tbody tr td:nth-child(3)', (n) => n.style.boxShadow)), sh);

    await go({ ClickAction: 'navigate', NavigateTarget: '42/Grade-{Grade}' });
    await pg.click('#box .pvx-lkt-table tbody tr[data-pvx-i="1"]');
    check('lookup: a row opens a display named from its cells', /^#\/Displays\/42\/Grade-B-200/.test(await hash()), await hash());

    await go({}, { configured: false });
    check('lookup: says so when PI Web API is not configured', /PI Web API is not configured/.test((await view()).text));
}

/** A time-series symbol's own time range, read from the mock PI Web API. */
async function ownRange(open, settle) {
    const pg = eventList.pg;
    const DP1 = K301 + '|Discharge Pressure';
    const payload = { Data: [{ Label: 'Discharge Pressure', Units: 'psig', Path: 'af:' + DP1, IsGood: true,
        Value: [{ Time: iso(10), Value: 1075 }, { Time: iso(5), Value: 1081 }] }] };
    const go = async (cfg, extra) => {
        await open('pvxKpiCard', Object.assign({ asset: '', config: cfg, payload, source: 'af:' + DP1 + '?x' }, extra || {}));
        await settle();
    };
    const seen = () => pg.evaluate(() => {
        const b = document.querySelector('#box .pvx-overlay-range');
        return { value: (document.querySelector('#box .pvx-kpi-value') || {}).textContent || '',
            badge: b && b.style.display !== 'none' ? b.textContent : '', title: b ? b.title : '', warn: !!(b && /warn/.test(b.className)) };
    });
    const recorded = () => requests.filter((r) => /\/recorded\?/.test(r));

    await go({});
    let v = await seen();
    check('own range: off by default, the pipeline\'s value, nothing asked, no badge',
        /1,?081/.test(v.value) && !recorded().length && v.badge === '', [v, requests]);
    await go({ OwnTimeRange: true, OwnStart: '*-30d' });
    v = await seen();
    check('own range: recorded values over the symbol\'s range replace the pipeline\'s',
        /777/.test(v.value) && recorded().length === 1 &&
        /^GET streams\/Wa:.*Discharge Pressure\/recorded\?startTime=\*-30d&endTime=\*&maxCount=10000&selectedFields=Items.Timestamp;Items.Value;Items.Good$/.test(recorded()[0]),
        [v, recorded()]);
    check('own range: a badge names it', v.badge === 'Last 30 days' && /not the display's time range/.test(v.title), v);
    await pg.evaluate((p) => { window.__vis.onDataUpdate(p); }, payload);
    await settle();
    v = await seen();
    check('own range: a pipeline update keeps the range and does not read again', /777/.test(v.value) && recorded().length === 1, [v, recorded()]);
    await pg.evaluate(() => { window.__scope.config.OwnStart = '*-7d'; window.__vis.onConfigChange(window.__scope.config, {}); });
    await settle();
    check('own range: a new range in the pane reads again', recorded().length === 2 && /startTime=\*-7d/.test(recorded()[1]) &&
        (await seen()).badge === 'Last 7 days', recorded());

    await go({ OwnTimeRange: true, OwnStart: '*-30d', OwnMaxValues: 100 });
    v = await seen();
    check('own range: a source that hit the limit is said', v.warn && /Only the first 100 values read for: .*Discharge Pressure/.test(v.title), v);

    await go({ OwnTimeRange: true, OwnStart: '*-30d' }, { source: 'af:' + K301 + '|Nowhere?x' });
    v = await seen();
    check('own range: a source PI Web API does not know is named, not drawn from the display', v.warn && /Not read: .*Nowhere/.test(v.title), v);

    await go({ OwnTimeRange: true, OwnStart: 'y', OwnEnd: 't' }, { configured: false });
    v = await seen();
    check('own range: without PI Web API the display\'s data, and the badge says so',
        /1,?081/.test(v.value) && v.badge === 'Yesterday (not in force)' && v.warn, v);
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
        eventList.pg = pg;
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
        await open('pvxEventGantt', { asset: K301, config: Object.assign({}, EG, { ClickAction: 'time' }) });
        // Dispatched, not clicked: a bar's box includes its label, which
        // lets clicks through, so its centre can fall on bare SVG.
        await pg.$eval('#box [data-pvx-i="0"]', (n) => n.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        let zoomed = await hash();
        check('timeline: a bar can set this display to the event',
            /^#\/Displays\/101\/Overview\?/.test(zoomed) && /starttime=\d{4}-/.test(zoomed) && /endtime=\d{4}-/.test(zoomed), zoomed);

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

        await eventList(open, texts, hash, settle);
        await eventRuns(open, settle);
        await assetRollup(open, settle, hash);
        await quickTrend(open, settle);
        await lookupTable(open, settle, hash);
        await ownRange(open, settle);

        /* ---- Asset Navigator --------------------------------------------- *
         * Nothing configured: PI Web API beside PI Vision, the database the
         * dropped attribute lives in. Then the ways it used to sit on
         * "Loading the AF hierarchy..." for good on a live server.          */
        const TREE = { DatabasePath: '', RootElementPath: '', Height: 240, Width: 640 };
        await open('pvxAssetTree', { asset: '', config: TREE, configured: 'auto' });
        await settle();
        body = await pg.$eval('#box', (n) => n.textContent);
        check('tree auto: the hierarchy loads with no setup', /Station 1/.test(body) && /Station 2/.test(body), body.slice(0, 200));

        // PI Web API answers an unknown path with 404, which used to surface
        // as "Not found. Check the path and the WebID." with no path at all.
        await open('pvxAssetTree', { asset: '', config: TREE, configured: 'auto', source: 'af:\\\\AF\\Nowhere\\Unit|Name?x' });
        await settle();
        body = await pg.$eval('#box', (n) => n.textContent);
        check('tree: a database that is not there is named, with where it came from',
            /Root did not resolve/.test(body) && body.indexOf('no AF database at "\\\\AF\\Nowhere"') !== -1 &&
            body.indexOf('came from this symbol\'s data source') !== -1, body.slice(0, 300));
        check('tree: ...and the address asked', body.indexOf('Asked: ') !== -1 &&
            body.indexOf('assetdatabases?path=\\\\AF\\Nowhere') !== -1, body.slice(0, 400));

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

        /* ---- Asset Navigator: list, drop-down, a value per row ------------ */
        const VAL = Object.assign({}, TREE, { Layout: 'list', ValueAttribute: 'Status', StateMap: 'Running:#2f9e5f, Fault:#c8452f' });
        // A fresh page: the last checks left this one with a stale core.
        await pg.goto('about:blank');
        await open('pvxAssetTree', { asset: '', config: VAL, configured: 'auto' });
        await settle();
        await settle();
        let vrows = await pg.$$eval('#box .pvx-tree-row', (ns) => ns.map((n) => ({
            name: n.querySelector('.pvx-tree-name').textContent,
            value: (n.querySelector('.pvx-tree-value') || {}).textContent,
            vtitle: (n.querySelector('.pvx-tree-value') || {}).title,
            dot: (n.querySelector('.pvx-tree-dot') || { style: {} }).style.background,
            twisty: !!n.querySelector('.pvx-tree-twisty-on') })));
        const vr = (name) => vrows.find((r) => r.name === name) || {};
        check('tree list: every element in one flat list, no twisties',
            ['Station 1', 'K-301', 'K-302', 'Tank 1', 'Station 2', 'K-303'].every((n) => !!vr(n).name) && vrows.every((r) => !r.twisty),
            vrows.map((r) => r.name));
        check('tree list: ...from a search of the whole hierarchy, not level by level',
            requests.some((r) => /elements\?searchFullHierarchy=true/.test(r)) &&
            !requests.some((r) => /\/elements\?selectedFields/.test(r)), requests.slice(0, 6));
        check('tree values: a digital state with its colour', vr('K-301').value === 'Running' && /47, 158, 95|2f9e5f/.test(vr('K-301').dot), vr('K-301'));
        check('tree values: a state not in the map gets no colour', vr('K-303').value === 'Stopped' && !vr('K-303').dot, vr('K-303'));
        check('tree values: an element without the attribute shows a dash and says why',
            vr('Tank 1').value === '\u2014' && /no attribute "Status"/.test(vr('Tank 1').vtitle), vr('Tank 1'));
        check('tree values: read in batches', requests.filter((r) => r === 'POST batch').length === 2,
            requests.filter((r) => /batch/.test(r)).length);

        await open('pvxAssetTree', { asset: K302, config: Object.assign({}, TREE, { Layout: 'dropdown', ValueAttribute: 'Vibration', ValueBands: '0:#2f9e5f, 5:#c8452f' }), configured: 'auto' });
        await settle();
        await settle();
        let dd = await pg.evaluate(() => {
            const sel = document.querySelector('#box select.pvx-tree-dd-select');
            return sel ? { picked: sel.options[sel.selectedIndex].textContent.trim(), n: sel.options.length,
                value: (document.querySelector('#box .pvx-tree-value') || {}).textContent,
                dot: (document.querySelector('#box .pvx-tree-dot') || { style: {} }).style.background } : null;
        });
        check('tree drop-down: on the display\'s asset', dd && dd.picked === 'K-302' && dd.n === 7, dd);
        check('tree drop-down: its value coloured by the bands', dd && /^6\.20? mils$/.test(dd.value) && /200, 69, 47|c8452f/.test(dd.dot), dd);
        await pg.selectOption('#box select.pvx-tree-dd-select', { label: '\u00a0\u00a0\u00a0K-303' });
        await settle();
        check('tree drop-down: choosing one switches the asset', (await hash()).indexOf('asset=' + K303) !== -1, await hash());

        /* ---- Navigation Panel: icons, tooltips, {value} ------------------ */
        const ITEMS = '[home] Overview -- Plant overview | 101\n[bogus] Odd | 102\nDetails | {value}';
        await open('pvxNavPanel', { config: { Mode: 'display', Items: ITEMS, KeepAsset: false, KeepTime: false }, value: '777' });
        const btns = await pg.$$eval('#box .pvx-nav-btn', (ns) => ns.map((n) => ({
            text: n.textContent.trim(), title: n.title, icon: !!n.querySelector('svg.pvx-nav-icon') })));
        check('nav: [home] draws an icon and leaves the label', btns[0] && btns[0].icon && btns[0].text === 'Overview', btns[0]);
        check('nav: text after -- is the tooltip', btns[0] && btns[0].title === 'Plant overview', btns[0]);
        check('nav: an unknown icon name stays in the label', btns[1] && !btns[1].icon && btns[1].text === '[bogus] Odd', btns[1]);
        check('nav: a {value} tooltip names the resolved address', btns[2] && /777/.test(btns[2].title), btns[2]);
        await pg.click('#box .pvx-nav-btn:has-text("Details")');
        check('nav: {value} takes the data source\'s value', /^#\/Displays\/777\b/.test(await hash()), await hash());

        /* ---- Heatmap: a cell sets the time range ------------------------ */
        const T = Date.parse('2026-10-20T00:00:00Z');
        const heatPts = [];
        for (let m = 0; m < 180; m += 10) { heatPts.push({ Time: new Date(T + m * 60000).toISOString(), Value: m }); }
        await open('pvxHeatmap', { config: { Mode: 'matrix', BucketCount: 3, ClickAction: 'time' },
            payload: { Data: [{ Label: 'Flow', Units: 't/h', Path: '\\\\AF\\T|Flow', IsGood: true, Value: heatPts }] } });
        await pg.click('#box rect.pvx-heat-cell-link[data-pvx-i="1"]');
        const cell = await hash();
        check('heatmap: a cell sets the display to its own slice',
            cell.indexOf('starttime=2026-10-20T00:56:40.000Z') !== -1 && cell.indexOf('endtime=2026-10-20T01:53:20.000Z') !== -1, cell);
        await open('pvxHeatmap', { config: { Mode: 'matrix', BucketCount: 3 },
            payload: { Data: [{ Label: 'Flow', Units: 't/h', Path: '\\\\AF\\T|Flow', IsGood: true, Value: heatPts }] } });
        const before = await hash();
        await pg.click('#box rect.pvx-heat-cell');
        check('heatmap: with clicks off a cell does nothing', (await hash()) === before, await hash());

        /* ---- Time Range: presets, stepping, typed expressions ------------ */
        await open('pvxTimeRange', { config: {} });
        await pg.click('#box .pvx-trange-preset:has-text("8 hours")');
        await settle();
        let h = await hash();
        check('time range: a preset sets the display time', h.indexOf('starttime=*-8h') !== -1 && h.indexOf('endtime=*') !== -1, h);
        let tr = await pg.evaluate(() => ({
            on: Array.from(document.querySelectorAll('#box .pvx-trange-on')).map((n) => n.textContent),
            fwd: document.querySelector('#box [data-pvx-act="fwd"]').disabled,
            read: document.querySelector('#box .pvx-trange-readout').textContent }));
        check('time range: ...is shown as in force', JSON.stringify(tr.on) === '["8 hours"]' && /^8 hours: .* \(8 h\)$/.test(tr.read), tr);
        check('time range: forward is off at the present', tr.fwd === true, tr);
        const t0 = Date.now();
        await pg.click('#box [data-pvx-act="back"]');
        await settle();
        h = await hash();
        const sm = /starttime=([^&]+)/.exec(h);
        const em = /endtime=([^&]+)/.exec(h);
        const s1 = sm ? Date.parse(sm[1]) : NaN;
        const e1 = em ? Date.parse(em[1]) : NaN;
        check('time range: back steps by the span, as fixed times',
            e1 - s1 === 8 * 3600000 && Math.abs(e1 - (t0 - 8 * 3600000)) < 10000, h);
        await pg.click('#box [data-pvx-act="fwd"]');
        await settle();
        h = await hash();
        check('time range: forward to the present goes back to a relative range',
            /starttime=\*-28800s/.test(h) && /endtime=\*(&|$)/.test(h), h);

        await open('pvxTimeRange', { config: { CustomInput: 'text', PresetStyle: 'dropdown' } });
        const before2 = await hash();
        await pg.fill('#box .pvx-trange-input >> nth=0', '*-2q');
        await settle();
        let trMsg = await pg.$eval('#box .pvx-trange-msg', (n) => n.textContent);
        check('time range: a typed expression is checked as it is typed', /"\*-2q" is not a time/.test(trMsg), trMsg);
        await pg.click('#box .pvx-trange-apply');
        await settle();
        check('time range: ...and a bad one never reaches the display', (await hash()) === before2, await hash());
        await pg.fill('#box .pvx-trange-input >> nth=0', 't-2h');
        await pg.fill('#box .pvx-trange-input >> nth=1', 't+6h');
        await pg.press('#box .pvx-trange-input >> nth=1', 'Enter');
        await settle();
        h = await hash();
        check('time range: Enter applies the expressions as typed', h.indexOf('starttime=t-2h') !== -1 && h.indexOf('endtime=t+6h') !== -1, h);
        await pg.selectOption('#box .pvx-trange-select', '4');
        await settle();
        h = await hash();
        check('time range: the drop-down applies a preset', h.indexOf('starttime=*-7d') !== -1, h);

        await open('pvxTimeRange', { config: { Presets: '8 hours | *-8h | *\nbroken line' } });
        trMsg = await pg.$eval('#box .pvx-trange-msg', (n) => n.textContent);
        check('time range: a malformed preset line is named', /Preset line 2 ignored/.test(trMsg), trMsg);
        tr = await pg.evaluate(() => document.querySelector('#box [data-pvx-act="back"]').title);
        check('time range: with no range in the address, stepping says why', /own default range/.test(tr), tr);

        /* ---- Embedded Page ----------------------------------------------- *
         * A fresh page each time: a frame left loading from the last one
         * keeps the network busy, and goto waits for it to go quiet.        */
        await pg.goto('about:blank');
        await open('pvxEmbeddedPage', { asset: K301, config: { Url: '101' } });
        await pg.evaluate(() => { location.hash = location.hash + '&starttime=*-2h&endtime=*'; });
        await settle();
        let emb = await pg.evaluate(() => {
            const f = document.querySelector('#box iframe.pvx-embed-iframe');
            return { src: f ? decodeURIComponent(f.getAttribute('src')) : '', note: (document.querySelector('#box .pvx-embed-note') || {}).textContent || '',
                title: document.querySelector('#box .pvx-embed-title').textContent,
                open: (document.querySelector('#box a.pvx-embed-tool') || {}).href || '' };
        });
        check('embedded: a display id opens that display on this server, in kiosk mode',
            /#\/Displays\/101\?/.test(emb.src) && /mode=kiosk/.test(emb.src) && emb.title === 'PI Vision display 101', emb);
        check('embedded: ...carrying this display\'s asset and time', emb.src.indexOf('asset=' + K301) !== -1 && /starttime=\*-2h/.test(emb.src), emb.src);
        check('embedded: ...with no warning, since it is the same site', emb.note === '', emb.note);
        check('embedded: Open in a new tab leaves out kiosk mode', emb.open && !/mode=kiosk/.test(decodeURIComponent(emb.open)), emb.open);

        await pg.goto('about:blank');
        await open('pvxEmbeddedPage', { config: { Url: 'http://127.0.0.1:1/report' } });
        emb = await pg.$eval('#box .pvx-embed-note', (n) => n.textContent);
        check('embedded: another site is flagged as possibly refusing', /Another site/.test(emb) && /new tab/.test(emb), emb);

        await pg.goto('about:blank');
        await open('pvxEmbeddedPage', { config: { Url: 'javascript:alert(1)' } });
        emb = await pg.evaluate(() => ({ note: document.querySelector('#box .pvx-embed-note').textContent,
            frames: document.querySelectorAll('#box iframe').length }));
        check('embedded: a non-web address is refused and named', /"javascript:" is refused/.test(emb.note) && emb.frames === 0, emb);

        await pg.goto('about:blank');
        await open('pvxEmbeddedPage', { config: { UrlSource: 'source' }, value: '' });
        emb = await pg.$eval('#box .pvx-embed-note', (n) => n.textContent);
        check('embedded: an address from the data source waits for it', /Waiting for the data source/.test(emb), emb);

        await pg.goto('about:blank');
        await open('pvxEmbeddedPage', { config: { Url: '101' } });
        await pg.evaluate(() => { window.__scope.runtimeData.isEditMode = true; window.__vis.onConfigChange(window.__scope.config, {}); });
        await settle();
        emb = await pg.evaluate(() => !!document.querySelector('#box .pvx-embed-shield'));
        check('embedded: in the editor a shield keeps the symbol selectable', emb === true, emb);

        /* ---- Combo Chart: event frames behind the traces ------------------ */
        const comboPts = [];
        for (let m = 360; m >= 0; m -= 10) { comboPts.push({ Time: iso(m), Value: 100 + m / 10 }); }
        const comboData = { Data: [{ Label: 'Discharge Pressure', Units: 'psig', Path: 'af:' + K301 + '|Discharge Pressure', IsGood: true, Value: comboPts }] };
        await open('pvxComboChart', { config: { ShowEvents: true }, payload: comboData });
        await settle();
        let combo = await pg.evaluate(() => ({
            rects: Array.from(document.querySelectorAll('#box rect.pvx-combo-event')).map((r) => r.querySelector('title').textContent),
            note: (document.querySelector('#box .pvx-combo-note') || {}).textContent || '' }));
        check('combo: the asset\'s event frames are shaded', combo.rects.length === 2 &&
            /^K-301 trip \(Downtime\)/.test(combo.rects[0]) && /^Seal leak/.test(combo.rects[1]), combo);
        check('combo: ...asked for that element only',
            requests.some((r) => /^GET elements\/We:.*K-301\/eventframes\?.*searchMode=Overlapped/.test(r)), requests);
        check('combo: ...and counted in the footer', /2 events/.test(combo.note), combo.note);
        const efAsks = requests.filter((r) => /eventframes/.test(r)).length;
        await pg.evaluate((d) => window.__vis.onDataUpdate(d), comboData);
        await settle();
        check('combo: a data update in the same window does not ask again',
            requests.filter((r) => /eventframes/.test(r)).length === efAsks, requests.filter((r) => /eventframes/.test(r)));

        await open('pvxComboChart', { config: { ShowEvents: true, EventScope: 'database', EventMax: 3 }, payload: comboData });
        await settle();
        combo = await pg.evaluate(() => (document.querySelector('#box .pvx-combo-note') || {}).textContent || '');
        check('combo: a capped database search says so', /the first 3 only/.test(combo), combo);

        await open('pvxComboChart', { config: { ShowEvents: true, EventClick: 'time' }, payload: comboData });
        await settle();
        await pg.evaluate(() => document.querySelector('#box rect.pvx-combo-event').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        let ch = await hash();
        check('combo: clicking an event shows it, with a margin',
            /starttime=20\d\d-/.test(ch) && /endtime=20\d\d-/.test(ch), ch);

        await open('pvxComboChart', { config: { ShowEvents: true }, payload: comboData, configured: false });
        await settle();
        combo = await pg.evaluate(() => ({ note: (document.querySelector('#box .pvx-combo-note') || {}).textContent || '',
            lines: document.querySelectorAll('#box path').length }));
        check('combo: with no PI Web API the traces still draw and the footer says why',
            /events: /.test(combo.note) && /piwebapi-check\.html/.test(combo.note) && combo.lines > 0, combo);

        await open('pvxComboChart', { config: {}, payload: comboData });
        await settle();
        check('combo: events off by default, nothing asked', !requests.some((r) => /eventframes/.test(r)), requests);

        /* ---- settings kept in AF ----------------------------------------- */
        const spcPts = [];
        for (let m = 120; m >= 0; m -= 2) { spcPts.push({ Time: iso(m), Value: 1080 + ((m * 7) % 23) - 11 }); }
        const spcData = { Data: [{ Label: 'Discharge Pressure', Units: 'psig', Path: 'af:' + K301 + '|Discharge Pressure', IsGood: true, Value: spcPts }] };
        const spcSrc = 'af:' + K301 + '|Discharge Pressure?x';
        await open('pvxControlChart', { config: { LimitSource: 'af', SpecFromAf: true, ChartType: 'imr' }, payload: spcData, source: spcSrc });
        await settle();
        let spc = await pg.evaluate(() => document.getElementById('box').textContent);
        check('control chart: limits from the attribute\'s Hi/Lo traits, Target as the centre',
            /UCL 1,?150/.test(spc) && /LCL 1,?000/.test(spc) && /CL 1,?080/.test(spc), spc.slice(0, 300));
        check('control chart: ...and the spec from LoLo/HiHi, said in the footer',
            /limits from AF Hi\/Lo\/Target/.test(spc) && /LSL, USL, target from AF/.test(spc), spc.slice(-300));
        await open('pvxControlChart', { config: { LimitSource: 'af', AfUclTrait: 'Maximum' }, payload: spcData, source: spcSrc });
        await settle();
        spc = await pg.evaluate(() => document.getElementById('box').textContent);
        check('control chart: a trait the attribute lacks is named', /no Maximum limit trait in AF/.test(spc), spc.slice(0, 300));

        await open('pvxKpiCard', { config: { PlanFrom: 'af', DeltaBasis: 'plan', Statistic: 'last' }, payload: spcData, source: spcSrc });
        await settle();
        const kpi = await pg.evaluate(() => document.getElementById('box').textContent);
        check('kpi: the plan is the attribute\'s Target in AF', /vs plan/.test(kpi) && !/Target from AF/.test(kpi), kpi);

        await open('pvxNavPanel', { config: { Mode: 'display', ItemsFrom: 'af', ItemsAttribute: S1 + '|Navigation Menu', KeepAsset: false, KeepTime: false } });
        await settle();
        let navAf = await texts('#box .pvx-nav-btn');
        check('nav: the menu comes from the AF attribute', JSON.stringify(navAf) === '["Overview","Details"]', navAf);
        await open('pvxNavPanel', { config: { Mode: 'display', ItemsFrom: 'af', ItemsAttribute: S1 + '|Nowhere' } });
        await settle();
        navAf = await pg.evaluate(() => ({ btns: Array.from(document.querySelectorAll('#box .pvx-nav-btn')).map((n) => n.textContent.trim()),
            note: (document.querySelector('#box .pvx-nav-note') || {}).title || '' }));
        check('nav: a missing menu attribute falls back to the typed buttons and says why',
            navAf.btns.length === 4 && /Menu from AF: .*Nowhere/.test(navAf.note), navAf);

        /* ---- Display Menu ------------------------------------------------ */
        const MENU = '[home] Overview | 101\nUnits\n    Unit 1 | 201\n    More\n        Detail | 203\n    ---\n    ' +
            'Web | https://intranet.example/x\nReports | 301 | keeptime=no; start=*-7d';
        const openMenu = async (hash, config, extra) => {
            requests = [];
            await pg.goto('http://127.0.0.1:' + PORT + '/page/pvxDisplayMenu#' + hash, { waitUntil: 'networkidle' });
            await pg.evaluate(() => { window.__opened = []; window.open = (u, t) => { window.__opened.push([u, t]); return null; }; });
            await pg.evaluate(mount, Object.assign({ typeName: 'pvxDisplayMenu', config: Object.assign({ Items: MENU, Collapse: 'never' }, config) }, extra || {}));
            await settle();
        };
        const tops = () => texts('#box .pvx-dmenu-items > button');
        const pops = () => pg.$$eval('.pvx-dmenu-layer .pvx-dmenu-pop', (ps) => ps.map((p) =>
            Array.from(p.children).map((n) => n.tagName === 'BUTTON' ? n.textContent.trim() : '---')));

        await openMenu('/Displays/203/Detail?asset=' + encodeURIComponent(K301) + '&starttime=*-2h&endtime=*', {});
        let mt = await tops();
        check('menu: the top level as a bar', JSON.stringify(mt) === '["Overview","Units","Reports"]', mt);
        let act = await pg.$$eval('#box [data-active]', (ns) => ns.map((n) => n.textContent.trim() + ':' + n.getAttribute('data-active')));
        check('menu: the menu holding the current display is marked', JSON.stringify(act) === '["Units:parent"]', act);
        check('menu: nothing open, nothing on the page', (await pops()).length === 0);
        await pg.click('#box button:has-text("Units")');
        let mp = await pops();
        check('menu: a click opens its drop-down, on the page, separator kept', JSON.stringify(mp) === '[["Unit 1","More","---","Web"]]', mp);
        await pg.click('.pvx-dmenu-layer button:has-text("More")');
        mp = await pops();
        check('menu: a deeper menu opens beside it', JSON.stringify(mp) === '[["Unit 1","More","---","Web"],["Detail"]]', mp);
        act = await pg.$$eval('.pvx-dmenu-layer [data-active]', (ns) => ns.map((n) => n.textContent.trim() + ':' + n.getAttribute('data-active')));
        check('menu: ...the current display marked in it', JSON.stringify(act) === '["More:parent","Detail:item"]', act);
        const geo = await pg.$$eval('.pvx-dmenu-layer .pvx-dmenu-pop', (ps) => ps.map((p) => p.getBoundingClientRect()).map((r) => [Math.round(r.left), Math.round(r.right), Math.round(r.top)]));
        check('menu: ...to the right of the first', geo.length === 2 && geo[1][0] >= geo[0][1] - 2, geo);
        await pg.keyboard.press('Escape');
        check('menu: Escape closes every menu', (await pops()).length === 0);
        await pg.click('#box button:has-text("Units")');
        await pg.mouse.click(900, 500);
        check('menu: a click elsewhere closes them', (await pops()).length === 0);

        await pg.click('#box button:has-text("Units")');
        await pg.click('.pvx-dmenu-layer button:has-text("Unit 1")');
        check('menu: an entry opens its display, keeping asset and time',
            (await hash()) === '#/Displays/201?asset=' + K301 + '&starttime=*-2h&endtime=*', await hash());
        check('menu: ...and the menus close', (await pops()).length === 0);

        await openMenu('/Displays/101/A?asset=' + encodeURIComponent(K301) + '&starttime=*-2h&endtime=*', {});
        await pg.click('#box button:has-text("Reports")');
        check('menu: an entry\'s own options win: no time kept, its own start', (await hash()) === '#/Displays/301?asset=' + K301 + '&starttime=*-7d', await hash());
        await openMenu('/Displays/101/A', {});
        await pg.click('#box button:has-text("Units")');
        await pg.click('.pvx-dmenu-layer button:has-text("Web")');
        const opened = await pg.evaluate(() => window.__opened);
        check('menu: a web page opens in a new tab', JSON.stringify(opened) === '[["https://intranet.example/x","_blank"]]', opened);

        await openMenu('/Displays/101/A', { SubmenuOpen: 'hover' });
        await pg.hover('#box button:has-text("Units")');
        await settle();
        mp = await pops();
        check('menu: pointing opens a drop-down when set to', JSON.stringify(mp) === '[["Unit 1","More","---","Web"]]', mp);
        await pg.mouse.move(900, 500);
        await pg.waitForTimeout(600);
        check('menu: ...and moving away closes it', (await pops()).length === 0);

        await openMenu('/Displays/101/A', {});
        await pg.evaluate(() => { window.__scope.runtimeData.isEditMode = true; });
        await pg.click('#box button:has-text("Overview")');
        check('menu: nothing navigates while the display is edited', (await hash()) === '#/Displays/101/A', await hash());
        await pg.click('#box button:has-text("Units")');
        check('menu: ...though the menus still open', (await pops()).length === 1);

        await pg.focus('#box button:has-text("Units")');
        await pg.keyboard.press('Escape');
        await openMenu('/Displays/101/A', {});
        await pg.focus('#box button:has-text("Units")');
        await pg.keyboard.press('ArrowDown');
        await settle();
        let focused = await pg.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
        check('menu: ArrowDown opens a menu and moves into it', focused === 'Unit 1', focused);
        await pg.keyboard.press('ArrowDown');
        await pg.keyboard.press('ArrowRight');
        await settle();
        focused = await pg.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
        check('menu: ...ArrowRight opens the next level', focused === 'Detail', focused);

        await openMenu('/Displays/203/A', { Collapse: 'always', MenuLabel: 'Go to' });
        mt = await tops();
        check('menu: collapsed to one button', JSON.stringify(mt) === '[]' && JSON.stringify(await texts('#box .pvx-dmenu-burger')) === '["Go to"]', mt);
        await pg.click('#box .pvx-dmenu-burger');
        mp = await pops();
        check('menu: it opens the whole menu, the way to the current display already open',
            JSON.stringify(mp) === '[["Overview","Units","Unit 1","More","Detail","---","Web","Reports"]]', mp);
        await pg.click('.pvx-dmenu-layer button:has-text("More")');
        mp = await pops();
        check('menu: ...an entry in it folds in place', JSON.stringify(mp) === '[["Overview","Units","Unit 1","More","---","Web","Reports"]]', mp);

        const many = Array.from({ length: 14 }, (_, i) => 'Area number ' + (i + 1) + ' | ' + (500 + i)).join('\n');
        await openMenu('/Displays/101/A', { Items: many, Collapse: 'narrow' });
        check('menu: too many for the bar, it collapses', (await tops()).length === 0 && (await texts('#box .pvx-dmenu-burger')).length === 1);
        await openMenu('/Displays/101/A', { Items: many, Collapse: 'never' });
        check('menu: ...unless told never to', (await tops()).length === 14);

        await openMenu('/Displays/203/A', { Layout: 'side' });
        mt = await texts('#box .pvx-dmenu-items > button');
        check('menu: a side menu, open down to the current display', JSON.stringify(mt) === '["Overview","Units","Unit 1","More","Detail","Web","Reports"]', mt);
        await pg.click('#box button:has-text("Units")');
        mt = await texts('#box .pvx-dmenu-items > button');
        check('menu: ...an entry folds in place, with no drop-down', JSON.stringify(mt) === '["Overview","Units","Reports"]' && (await pops()).length === 0, mt);

        await openMenu('/Displays/101/A', { Items: MENU + '\nNot yet' });
        let mnote = await texts('#box .pvx-dmenu-note');
        check('menu: a line that goes nowhere is left out and said', mnote.length === 1 && /1 line has no address and nothing under it/.test(mnote[0]), mnote);

        await openMenu('/Displays/101/A?asset=' + encodeURIComponent(S1), { ItemsFrom: 'af', ItemsAttribute: '|Display Menu' });
        await settle();
        mt = await tops();
        check('menu: from an attribute of the display\'s asset', JSON.stringify(mt) === '["Station","Compressors"]', mt);
        check('menu: ...read by its path under that asset', requests.some((r) => r.indexOf('GET attributes?path=' + S1 + '|Display Menu') === 0), requests);
        await openMenu('/Displays/101/A?asset=' + encodeURIComponent(S2), { ItemsFrom: 'af', ItemsAttribute: '|Display Menu' });
        await settle();
        mnote = await texts('#box .pvx-dmenu-note');
        check('menu: an asset without one keeps the typed menu and says why',
            JSON.stringify(await tops()) === '["Overview","Units","Reports"]' && /Menu from AF/.test(mnote.join()), mnote);

        await openMenu('/Displays/101/A?starttime=*-1h', { ShowKioskToggle: true, ShowToolbarToggle: true, ShowBack: true });
        const tools = await pg.$$eval('#box .pvx-dmenu-tool', (ns) => ns.map((n) => n.getAttribute('data-tool') + ':' + (n.getAttribute('aria-pressed') || '')));
        check('menu: back, then the switches, showing what is on', JSON.stringify(tools) === '["back:","kiosk:false","hidetoolbar:false"]', tools);
        // The switch loads the page again: wait for the new one, not the old.
        const reloadBy = async (sel) => {
            await pg.evaluate(() => { window.__before = 1; });
            await pg.click(sel);
            await pg.waitForFunction(() => !window.__before && window.PVX && window.PVMock && document.readyState === 'complete');
        };
        await reloadBy('#box [data-tool="hidetoolbar"]');
        check('menu: the toolbar switch adds hidetoolbar and loads the display again', (await hash()) === '#/Displays/101/A?starttime=*-1h&hidetoolbar', await hash());
        await pg.evaluate(mount, { typeName: 'pvxDisplayMenu', config: { Items: MENU, Collapse: 'never', ShowKioskToggle: true, ShowToolbarToggle: true } });
        await settle();
        check('menu: ...and shows it as on', await pg.$eval('#box [data-tool="hidetoolbar"]', (n) => n.getAttribute('aria-pressed')) === 'true');
        await pg.click('#box button:has-text("Overview")');
        check('menu: moving on keeps the toolbar hidden', (await hash()) === '#/Displays/101?starttime=*-1h&hidetoolbar', await hash());
        await reloadBy('#box [data-tool="kiosk"]');
        check('menu: the kiosk switch adds mode=kiosk', (await hash()) === '#/Displays/101?starttime=*-1h&hidetoolbar&mode=kiosk', await hash());

        await openMenu('/Displays/101/A', { LogoUrl: '/nowhere/logo.png' });
        await pg.waitForTimeout(300);
        mnote = await texts('#box .pvx-dmenu-note');
        check('menu: a logo that does not load is said', /logo at "\/nowhere\/logo.png" did not load/.test(mnote.join()), mnote);
        await openMenu('/Displays/101/A', { LogoUrl: '/tiles/logo.png', LogoTarget: '101' });
        await pg.waitForTimeout(300);
        check('menu: a logo that loads, as a link, with nothing to say',
            (await texts('#box .pvx-dmenu-note')).length === 0 && (await pg.$$('#box button.pvx-dmenu-logo img')).length === 1);

        /* ---- Geo View ---------------------------------------------------- */
        const GROWS = [[K301, 'Running'], [K302, 'Fault'], [K303, 'Stopped']].map((r) => ({
            Label: r[0].slice(r[0].lastIndexOf('\\') + 1) + ' Status', Path: 'af:' + r[0] + '|Status?x', Value: r[1], IsGood: true }));
        const GEO = { StateMap: 'Running:#2f9e5f, Fault:#c8452f' };
        const TILES = { tileUrl: '/tiles/{z}/{x}/{y}.png', attribution: 'Test tiles' };
        const geoState = () => pg.evaluate(() => ({
            marks: Array.from(document.querySelectorAll('#box .pvx-geo-mark circle')).map((c) => [c.getAttribute('fill'), +c.getAttribute('cx'), +c.getAttribute('cy')]),
            tiles: Array.from(document.querySelectorAll('#box img.pvx-geo-tile')).map((i) => i.getAttribute('src')),
            note: (document.querySelector('#box .pvx-geo-note') || {}).textContent || '',
            grid: document.querySelectorAll('#box .pvx-geo-grid line').length,
            attr: (document.querySelector('#box .pvx-geo-attr') || {}).textContent || ''
        }));
        tileHits = [];
        await open('pvxGeoView', { payload: { Rows: GROWS }, config: GEO, map: TILES });
        await settle();
        let gs = await geoState();
        check('geo: a marker per asset with a place, coloured by its state',
            JSON.stringify(gs.marks.map((m) => m[0])) === '["#2f9e5f","#c8452f"]', gs.marks);
        check('geo: places read from each element\'s Latitude and Longitude',
            requests.some((r) => r.indexOf('GET attributes?path=' + K301 + '|Latitude') === 0) &&
            requests.some((r) => r.indexOf('GET attributes?path=' + K302 + '|Longitude') === 0), requests);
        check('geo: the one without is named in the footer', /1 with no location: K-303 Status/.test(gs.note), gs.note);
        check('geo: north is up and east is right', gs.marks[1][1] > gs.marks[0][1] && gs.marks[1][2] < gs.marks[0][2], gs.marks);
        check('geo: tiles from the site\'s server, with its credit', gs.tiles.length > 0 && tileHits.length > 0 &&
            gs.tiles.every((t) => /^\/tiles\/\d+\/\d+\/\d+\.png$/.test(t)) && gs.attr === 'Test tiles', gs);
        const zOf = (t) => +t.split('/')[2];
        const z0 = zOf(gs.tiles[0]);
        await pg.click('#box [data-act="in"]');
        gs = await geoState();
        check('geo: + zooms in one level', gs.tiles.every((t) => zOf(t) === z0 + 1), [z0, gs.tiles]);
        const gBefore = gs.marks[0];
        const gBox = await pg.$eval('#box .pvx-geo-map', (n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top }; });
        await pg.mouse.move(gBox.x + 40, gBox.y + 40);
        await pg.mouse.down();
        await pg.mouse.move(gBox.x + 100, gBox.y + 70, { steps: 4 });
        await pg.mouse.up();
        gs = await geoState();
        check('geo: a drag moves the map with the pointer', Math.abs(gs.marks[0][1] - gBefore[1] - 60) < 1.5 && Math.abs(gs.marks[0][2] - gBefore[2] - 30) < 1.5,
            [gBefore, gs.marks[0]]);
        await pg.click('#box [data-act="fit"]');
        gs = await geoState();
        check('geo: the frame button fits every marker again', gs.tiles.every((t) => zOf(t) === z0), gs.tiles);

        await open('pvxGeoView', { asset: S1, payload: { Rows: GROWS }, config: Object.assign({ ClickAction: 'display', ClickDisplay: '205' }, GEO), map: TILES });
        await settle();
        await pg.click('#box .pvx-geo-mark:nth-of-type(2) circle', { force: true });
        check('geo: a click on a marker opens the display for its asset', (await hash()) === '#/Displays/205?asset=' + K302, await hash());

        await open('pvxGeoView', { payload: { Rows: GROWS }, config: GEO });
        await settle();
        gs = await geoState();
        check('geo: without a tile server, a grid, no tiles, and the footer says how to add the map',
            gs.tiles.length === 0 && gs.grid > 0 && /name a tile server as map.tileUrl in pvx-config.js/.test(gs.note), gs);
        await open('pvxGeoView', { payload: { Rows: GROWS }, config: GEO, configured: false });
        await settle();
        gs = await geoState();
        check('geo: without PI Web API, no markers and the reason', gs.marks.length === 0 && /locations from AF: /.test(gs.note), gs.note);
        await open('pvxGeoView', { payload: { Rows: GROWS }, config: Object.assign({ LocationFrom: 'list', Locations: 'K-303 | 51.45 | -0.2\nTypo | 99 | 0' }, GEO), configured: false });
        await settle();
        gs = await geoState();
        check('geo: a typed list needs no PI Web API, matched by element name', gs.marks.length === 1 && gs.marks[0][0] !== '#2f9e5f', gs);
        check('geo: ...and its line that does not read is named', /1 location line does not read: Typo \| 99 \| 0/.test(gs.note), gs.note);

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
