#!/usr/bin/env node
/* ============================================================================
 * PVX afpick test — finding AF objects the way PI Vision's Search Criteria
 * pane does, instead of typing their paths.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-afpick.js
 *
 * Two halves:
 *
 *   rules    PVX.afpick in plain Node: path splitting, the search root, the
 *            name filter, the AFSearch query, sorting, and the line each list
 *            grammar appends. These decide what is SEARCHED and what is
 *            SAVED, so a mistake here is a filter that silently matches the
 *            wrong assets or a display that loads with a wrong path.
 *   pane     the BUILT format panes in real Chromium against a mock PI Web
 *            API: every criterion reaches the request it should, attribute
 *            filters go through elements/search, Root and Up move the search
 *            root, Use writes a plain path into the bound config key, a list
 *            field gets a line in its own grammar, and every failure (a root
 *            outside the database, one that does not exist, a PI Web API
 *            without elements/search, an unconfigured site) is said aloud.
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
const PORT = 31795;

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

function loadCore() {
    const win = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(fs.readFileSync(CORE, 'utf8'), win, { filename: 'pvx-core.js' });
    return win.PVX;
}

function rules() {
    console.log('');
    console.log(C.bold + 'PVX.afpick rules' + C.reset);
    const A = loadCore().afpick;

    check('typeOf: server / database / element / attribute / root',
        [A.typeOf('\\\\S'), A.typeOf('\\\\S\\DB'), A.typeOf('\\\\S\\DB\\E'), A.typeOf('\\\\S\\DB\\E|a'), A.typeOf('')].join() ===
        'server,database,element,attribute,root');
    check('parent of a child attribute drops one attribute', A.parent('\\\\S\\DB\\E|a|b') === '\\\\S\\DB\\E|a', A.parent('\\\\S\\DB\\E|a|b'));
    check('parent of an attribute is its element', A.parent('\\\\S\\DB\\E|a') === '\\\\S\\DB\\E', A.parent('\\\\S\\DB\\E|a'));
    check('spaces inside names survive', A.parent('\\\\S\\Prod DB\\Site A\\Pump 1') === '\\\\S\\Prod DB\\Site A');

    const DB = '\\\\S\\Prod';
    check('relRoot: a full path inside the database becomes relative',
        A.relRoot('\\\\S\\Prod\\Area 2\\Line 1', DB) === 'Area 2\\Line 1', A.relRoot('\\\\S\\Prod\\Area 2\\Line 1', DB));
    check('relRoot: the database itself is no root at all', A.relRoot('\\\\s\\prod\\', DB) === '');
    check('relRoot: a relative root is kept, leading and trailing slashes dropped',
        A.relRoot(' \\Area 2\\ ', DB) === 'Area 2', A.relRoot(' \\Area 2\\ ', DB));
    check('relRoot: a path in another database is refused, not searched', A.relRoot('\\\\S\\Lab\\X', DB) === null);
    check('relRoot: a database whose name starts the same is still another database',
        A.relRoot('\\\\S\\Production\\X', DB) === null);

    check('nameFilter: plain text means "contains", as in PI Vision', A.nameFilter(' comp ') === '*comp*');
    check('nameFilter: a typed wildcard is taken as typed', A.nameFilter('Comp?2*') === 'Comp?2*');
    check('nameFilter: empty stays empty, so no filter is sent', A.nameFilter('  ') === '');
    check('quote: an apostrophe switches to double quotes', A.quote("Bob's") === '"Bob\'s"' && A.quote('x') === "'x'");

    const q = A.searchQuery({ rootRel: 'Area 2', descendants: false, name: 'comp', template: 'Compressor', category: 'Rotating',
        attrs: [{ name: 'Status', op: '=', value: 'Running' }, { name: 'Discharge Pressure', op: '>=', value: ' 50 ' },
                { name: '', op: '=', value: 'x' }, { name: 'Tag', op: '<', value: '1e3' }] });
    check('searchQuery: every criterion, numbers bare, strings quoted, nameless filters left out',
        q === "Root:'Area 2' AllDescendants:false Name:'*comp*' Template:'Compressor' Category:'Rotating' " +
              "'|Status':'Running' '|Discharge Pressure':>=50 '|Tag':<1e3", q);
    check('searchQuery: whole database with descendants is no Root and no AllDescendants',
        A.searchQuery({ rootRel: '', descendants: true, name: '', attrs: [{ name: 'S', op: '<>', value: 'Off' }] }) === "'|S':<>'Off'");
    check('searchQuery: an unknown operator falls back to equals',
        A.searchQuery({ descendants: true, attrs: [{ name: 'S', op: 'LIKE', value: 'x' }] }) === "'|S':'x'");

    const items = () => [{ name: 'b2', template: 'Pump' }, { name: 'A1', template: 'Valve' }, { name: 'a3', template: 'Pump' }];
    check('sortItems: by name ignores case', A.sortItems(items(), 'name', 'asc').map((i) => i.name).join() === 'A1,a3,b2');
    check('sortItems: descending', A.sortItems(items(), 'name', 'desc').map((i) => i.name).join() === 'b2,a3,A1');
    check('sortItems: by asset type, then name', A.sortItems(items(), 'template', 'asc').map((i) => i.name).join() === 'a3,b2,A1');

    const it = { name: 'Charge', path: '\\\\S\\DB\\R1|Charge' };
    check('plain field: the pick is the path, nothing else',
        A.compose('', it, 'old', {}).value === '\\\\S\\DB\\R1|Charge');
    check('entryRow: under ElementPath it is written bare',
        A.compose('entryRow', it, '', { ElementPath: '\\\\S\\DB\\R1' }).value === 'Charge');
    check('entryRow: elsewhere it is written in full',
        A.compose('entryRow', it, 'Temp', { ElementPath: '\\\\S\\DB\\R2' }).value === 'Temp\n\\\\S\\DB\\R1|Charge');
    check('entryRow: ElementPath match ignores case',
        A.compose('entryRow', it, '', { ElementPath: '\\\\s\\db\\r1' }).value === 'Charge');
    const dup = A.compose('entryRow', it, 'Charge | Catalyst | kg\nCharge', { ElementPath: '\\\\S\\DB\\R1' });
    check('a line already present is not added twice', dup.added === false && dup.value === 'Charge | Catalyst | kg\nCharge', dup);
    const el = { name: 'Boiler 3', path: '\\\\S\\DB\\Boiler 3' };
    check('navItem: asset mode is "Label | path"',
        A.compose('navItem', el, '', { Mode: 'asset' }).value === 'Boiler 3 | \\\\S\\DB\\Boiler 3');
    check('navItem: custom mode puts the path in asset=',
        A.compose('navItem', el, 'A | 1', { Mode: 'custom' }).value === 'A | 1\nBoiler 3 |  | asset=\\\\S\\DB\\Boiler 3');
}

/* --------------------------------------------------------- mock PI Web API */

// One AF server with two databases, a small plant with asset types,
// categories and attribute values, and a Data Archive. WebIDs are the path
// with a prefix, which keeps the mock honest: an object nobody looked up
// first cannot be asked for.
const P = '\\\\AFSRV\\Production';
const TREE = [
    ['server', '\\\\AFSRV'],
    ['database', P],
    ['database', '\\\\AFSRV\\Lab'],
    ['element', P + '\\Site A', 'Site', []],
    ['element', P + '\\Site A\\Reactor1', 'Reactor', ['Process'], { Status: 'Running', Temp: 80 }],
    ['element', P + '\\Site A\\Reactor2', 'Reactor', ['Process'], { Status: 'Idle', Temp: 40 }],
    ['element', P + '\\Site B', 'Site', []],
    ['element', P + '\\Site B\\Reactor3', 'Reactor', ['Process'], { Status: 'Running', Temp: 95 }],
    ['element', P + '\\Cooling', 'Pump', ['Utility']],
    ['attribute', P + '\\Site A\\Reactor1|Catalyst Charge'],
    ['attribute', P + '\\Site A\\Reactor1|Status'],
    ['attribute', P + '\\Site A\\Reactor1|Temp'],
    ['attribute', P + '\\Site A\\Reactor1|Temp|Setpoint'],
    ['dataserver', '\\\\PISRV'],
    ['point', '\\\\PISRV\\SINUSOID'],
    ['point', '\\\\PISRV\\CDT158']
];
const TEMPLATES = { Pump: [], Reactor: ['Catalyst Charge', 'Status', 'Temp'], Site: [] };
const CATEGORIES = ['Process', 'Utility'];

const byId = {};
const byPath = {};
const all = TREE.map(([type, p, template, cats, values]) => {
    const name = p.split(/[\\|]/).filter(Boolean).pop();
    const o = { type, Path: p, Name: name, WebId: 'W' + type[0] + ':' + p, template: template || '', cats: cats || [], values: values || {} };
    byId[o.WebId] = o;
    byPath[type + '|' + p.toLowerCase()] = o;
    return o;
});
const parentOf = (o) => {
    const p = o.Path;
    const cut = Math.max(p.lastIndexOf('|'), p.lastIndexOf('\\'));
    return p.slice(0, cut);
};
const kids = (o, type, deep) => all.filter((c) => c.type === type && (deep
    ? c.Path.toLowerCase().indexOf(o.Path.toLowerCase() + '\\') === 0
    : parentOf(c).toLowerCase() === o.Path.toLowerCase()));
// PI Web API's HasChildren means child elements on an element, child
// attributes on an attribute — never "has attributes".
const out = (o) => ({ Name: o.Name, Path: o.Path, WebId: o.WebId, TemplateName: o.template, CategoryNames: o.cats,
    HasChildren: kids(o, o.type === 'attribute' ? 'attribute' : 'element', false).length > 0 });
const like = (name, filter) => {
    if (!filter) { return true; }
    const re = new RegExp('^' + filter.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\?/g, '.') + '$', 'i');
    return re.test(name);
};
const unq = (t) => (/^['"]/.test(t) ? t.slice(1, -1) : t);

/** The AFSearch subset the pane writes, read back as a strict server would. */
function afSearch(db, query) {
    const crit = { descendants: true, attrs: [] };
    const re = /('[^']*'|"[^"]*"|[^\s:'"]+):(<=|>=|<>|<|>)?('[^']*'|"[^"]*"|\S+)/g;
    let m;
    // Anything left over is syntax the pane should not be writing.
    if (query.replace(re, '').trim()) { return null; }
    re.lastIndex = 0;
    while ((m = re.exec(query))) {
        const key = unq(m[1]);
        const val = unq(m[3]);
        if (key[0] === '|') { crit.attrs.push({ name: key.slice(1), op: m[2] || '=', value: val, numeric: !/^['"]/.test(m[3]) }); continue; }
        if (key === 'Root') { crit.root = val; } else if (key === 'AllDescendants') { crit.descendants = val !== 'false'; } else if (key === 'Name') { crit.name = val; } else if (key === 'Template') { crit.template = val; } else if (key === 'Category') { crit.category = val; } else { return null; }
    }
    let base = db;
    if (crit.root) {
        base = byPath['element|' + (db.Path + '\\' + crit.root).toLowerCase()];
        if (!base) { return []; }
    }
    const cmp = { '=': (a, b) => a === b, '<>': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
    return kids(base, 'element', crit.descendants).filter((o) => like(o.Name, crit.name) &&
        (!crit.template || o.template === crit.template) &&
        (!crit.category || o.cats.indexOf(crit.category) !== -1) &&
        crit.attrs.every((f) => {
            if (!(f.name in o.values)) { return false; }
            const v = o.values[f.name];
            return f.numeric ? cmp[f.op](Number(v), Number(f.value)) : cmp[f.op](String(v).toLowerCase(), f.value.toLowerCase());
        }));
}

let requests = [];
let noSearch = false;
let dbListDown = false;   // PI Web API cannot reach AF as the user: 502 on every database list

function api(req, res, url) {
    const u = new URL(url, 'http://x');
    const q = u.searchParams;
    const rel = decodeURIComponent(u.pathname).replace(/^\/piwebapi\/?/, '');
    requests.push(rel + (q.toString() ? '?' + decodeURIComponent(q.toString().replace(/\+/g, ' ')) : ''));
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const max = parseInt(q.get('maxCount') || '1000', 10);
    const items = (list) => send(200, { Items: list.slice(0, max).map(out) });
    const named = (list) => send(200, { Items: list.map((n) => (typeof n === 'string' ? { Name: n } : n)) });

    // The service root, which is what discovery asks for on the PI Vision origin.
    if (rel === '') { return send(200, { Links: { Self: '/piwebapi', AssetServers: '/piwebapi/assetservers' } }); }
    const byPathEp = { assetservers: 'server', dataservers: 'dataserver', assetdatabases: 'database', elements: 'element', attributes: 'attribute' };
    if (byPathEp[rel] && q.get('path')) {
        const o = byPath[byPathEp[rel] + '|' + q.get('path').toLowerCase()];
        return o ? send(200, out(o)) : send(404, { Errors: ['Not found: ' + q.get('path')] });
    }
    if (rel === 'assetservers') { return items(all.filter((o) => o.type === 'server')); }
    if (dbListDown && /^assetservers\/[^/]+\/assetdatabases$/.test(rel)) {
        return send(502, { Errors: ['Cannot connect to AF server AFSRV.'] });
    }
    if (rel === 'dataservers') { return items(all.filter((o) => o.type === 'dataserver')); }
    if (rel === 'elements/search') {
        if (noSearch) { return send(404, { Errors: ['No such endpoint'] }); }
        const db = byId[q.get('databaseWebId')];
        const hits = db && afSearch(db, q.get('query') || '');
        return hits ? items(hits) : send(400, { Errors: ['Bad query: ' + q.get('query')] });
    }
    const t = /^elementtemplates\/Wt:(.+)\/attributetemplates$/.exec(rel);
    if (t && TEMPLATES[t[1]]) { return named(TEMPLATES[t[1]]); }
    const m = /^(\w+)\/([^/]+)\/(\w+)$/.exec(rel);
    if (m && byId[m[2]]) {
        const o = byId[m[2]];
        if (m[3] === 'elementtemplates') {
            return named(o.Path === P ? Object.keys(TEMPLATES).map((n) => ({ Name: n, WebId: 'Wt:' + n })) : []);
        }
        if (m[3] === 'elementcategories') { return named(o.Path === P ? CATEGORIES : []); }
        const want = { assetdatabases: 'database', elements: 'element', attributes: 'attribute', points: 'point' }[m[3]];
        const deep = q.get('searchFullHierarchy') === 'true';
        let list = kids(o, want, deep).filter((c) => like(c.Name, q.get('nameFilter')) &&
            (!q.get('templateName') || c.template === q.get('templateName')) &&
            (!q.get('categoryName') || c.cats.indexOf(q.get('categoryName')) !== -1));
        list.sort((a, b) => (a.Name < b.Name ? -1 : 1));
        if (q.get('sortOrder') === 'Descending') { list.reverse(); }
        return items(list);
    }
    send(404, { Errors: ['No mock for ' + rel] });
}

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

/** Runs in the browser: mount symbol + pane, PI Web API pointed at the mock. */
async function mount(a) {
    window.PVX.api.configure({ baseUrl: a.configured === false || a.configured === 'auto' ? '' : location.origin + '/piwebapi',
        autoDiscover: a.configured !== false, auth: 'anonymous' });
    // Count requests in flight, so a test can wait for a chain of them
    // (lists, then a search) rather than guess how long it takes.
    const get = window.PVX.api.get;
    window.__inflight = 0;
    window.PVX.api.get = function () {
        window.__inflight += 1;
        const done = () => { window.__inflight -= 1; };
        const p = get.apply(this, arguments);
        p.then(done, done);
        return p;
    };
    const def = window.PVMock.get(a.typeName);
    const injector = angular.injector(['ng']);
    const $compile = injector.get('$compile');
    const scope = injector.get('$rootScope').$new(true);
    scope.config = def.getDefaultConfig();
    Object.keys(a.config || {}).forEach((k) => { scope.config[k] = a.config[k]; });
    scope.runtimeData = { isEditMode: true };
    scope.symbol = { Name: a.typeName, DataSources: a.sources || ['pi:\\\\srv\\SINUSOID?c'] };
    const tpl = await fetch('/dist/ext/sym-' + a.typeName + '-template.html').then((r) => r.text());
    const el = $compile(tpl)(scope);
    angular.element(document.getElementById('box')).append(el);
    const cfg = await fetch('/dist/ext/sym-' + a.typeName + '-config.html').then((r) => r.text());
    angular.element(document.getElementById('pane')).append($compile(cfg)(scope));
    new def.visObjectType().init(scope, el, undefined);
    scope.$digest();
    window.__scope = scope;
}

async function pane() {
    console.log('');
    console.log(C.bold + 'AF search criteria pane (built panes)' + C.reset);
    const { chromium } = require('playwright');
    const server = await serve();
    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launchOpts.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launchOpts);
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const open = async (typeName, config, configured, sources) => {
            await page.goto('http://127.0.0.1:' + PORT + '/page/' + typeName, { waitUntil: 'networkidle' });
            await page.evaluate(mount, { typeName, config, configured, sources });
        };
        const cfg = (k) => page.evaluate((key) => window.__scope.config[key], k);
        const panel = page.locator('.pvx-cfg-af-panel');
        const settle = async () => {
            await page.waitForTimeout(40);
            await page.waitForFunction(() => {
                const s = window.__scope.runtimeData.pvxAf;
                return s && !s.busy && window.__inflight === 0;
            });
            await page.waitForTimeout(40);
        };
        const names = async () => (await panel.locator('.pvx-cfg-af-name').allTextContents()).map((x) => x.trim());
        // By the name itself, so 'Site A' is not "Reactor1 in Site A".
        const exact = (name) => new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( in .*)?\\s*$');
        const row = (name) => panel.locator('.pvx-cfg-af-row').filter({ has: page.locator('.pvx-cfg-af-name', { hasText: exact(name) }) }).first();
        const field = (label) => panel.locator('label.pvx-cfg-af-field', { hasText: label });
        const pick = async (label, option) => { await field(label).locator('select').first().selectOption({ label: option }); await settle(); };
        const refresh = async () => { await panel.locator('.pvx-cfg-af-refresh').click(); await settle(); };
        const msg = async () => ((await panel.locator('.pvx-cfg-af-msg').count()) ? (await panel.locator('.pvx-cfg-af-msg').textContent()) : '') || '';
        const note = async () => (await panel.locator('.pvx-cfg-hint').allTextContents()).join(' ');
        const last = (re) => requests.filter((r) => re.test(r)).pop() || '';
        const options = async (label) => (await field(label).locator('select option').allTextContents()).map((x) => x.trim());

        // --- Asset Tree: a database, then an element inside it ---
        await open('pvxAssetTree', { DatabasePath: '', RootElementPath: '' });
        const toggle = page.locator('.pvx-cfg-af-toggle');
        check('one Search button per AF path field', await toggle.count() === 2, await toggle.count());
        check('nothing is requested until Search is pressed', !requests.some((r) => /^assetservers/.test(r)), requests);

        // Every database list failing is a fault reaching AF, not an empty
        // AF: the pane must say why, not "none this account can read".
        dbListDown = true;
        await toggle.nth(0).click();
        await settle();
        check('when no database list answers, the pane says none could be listed',
            /No AF database could be listed/.test(await msg()), await msg());
        check('...names the server, Kerberos delegation, and PI Web API\'s own words',
            /databases on AFSRV could not be listed/.test(await note()) && /Kerberos delegation/.test(await note()) &&
            /PI Web API said: Cannot connect to AF server AFSRV/.test(await note()), await note());
        await toggle.nth(0).click();
        await settle();
        dbListDown = false;

        await toggle.nth(0).click();
        await settle();
        check('the pane is headed Search Criteria, as PI Vision\'s is',
            (await panel.locator('.pvx-cfg-af-title').textContent()).trim() === 'Search Criteria');
        check('Database lists every database on the AF server', (await options('Database')).join() === 'Lab,Production', await options('Database'));
        check('a database field shows no asset criteria', await field('Asset Name').count() === 0 && await field('Search Root').count() === 0);
        await pick('Database', 'Lab');
        await panel.locator('button', { hasText: 'Use this database' }).click();
        check('Use writes the plain database path into the bound key', await cfg('DatabasePath') === '\\\\AFSRV\\Lab', await cfg('DatabasePath'));
        check('...shows it in the text box', await page.inputValue('#pvxat-db') === '\\\\AFSRV\\Lab');
        check('...and closes the pane', await panel.count() === 0);

        await page.fill('#pvxat-db', P);
        await toggle.nth(1).click();
        await settle();
        check('an element field opens on the database already chosen',
            await field('Database').locator('select option:checked').textContent() === 'Production');
        check('...and lists its top level at once, by name', (await names()).join() === 'Cooling,Site A,Site B', await names());
        check('Asset Type lists the database\'s element templates', (await options('Asset Type')).join() === 'Any,Pump,Reactor,Site', await options('Asset Type'));
        check('Asset Category lists its categories', (await options('Asset Category')).join() === 'Any,Process,Utility', await options('Asset Category'));
        check('a result shows its asset type', (await row('Cooling').locator('.pvx-cfg-af-type').textContent()).trim() === 'Pump');

        await field('Asset Name').locator('input').fill('reac');
        await refresh();
        check('a name below the top level is not found without Return All Descendants', (await names()).length === 0, await names());
        check('...and the pane says nothing matched', /Nothing matches/.test(await note()), await note());
        await panel.locator('label', { hasText: 'Return All Descendants' }).locator('input').check();
        await refresh();
        check('with descendants: every match, and where each lives',
            (await names()).join() === 'Reactor1 in Site A,Reactor2 in Site A,Reactor3 in Site B', await names());
        check('...as one server-side request with the criteria as parameters',
            /searchFullHierarchy=true/.test(last(/\/elements\?/)) && /nameFilter=\*reac\*/.test(last(/\/elements\?/)), last(/\/elements\?/));

        await field('Asset Name').locator('input').fill('');
        await pick('Asset Type', 'Reactor');
        await panel.locator('label', { hasText: 'Descending' }).locator('input').check();
        await refresh();
        check('Asset Type and Descending narrow and order the list',
            (await names()).map((n) => n.split(' ')[0]).join() === 'Reactor3,Reactor2,Reactor1', await names());
        check('...through templateName and sortOrder', /templateName=Reactor/.test(last(/\/elements\?/)) &&
            /sortOrder=Descending/.test(last(/\/elements\?/)), last(/\/elements\?/));

        await panel.locator('button', { hasText: '+ Attribute filter' }).click();
        const filter = panel.locator('.pvx-cfg-af-filter').first();
        check('an attribute filter offers the asset type\'s attributes',
            (await filter.locator('select').first().locator('option').allTextContents()).join() === 'Attribute…,Catalyst Charge,Status,Temp');
        await filter.locator('select').first().selectOption({ label: 'Status' });
        await filter.locator('input').fill('Running');
        await refresh();
        check('Status = Running finds only the running reactors',
            (await names()).map((n) => n.split(' ')[0]).join() === 'Reactor3,Reactor1', await names());
        const sq = last(/^elements\/search/);
        check('...through elements/search, with the criteria as an AFSearch query',
            /databaseWebId=Wd:/.test(sq) && /query=Template:'Reactor' '\|Status':'Running'/.test(sq), sq);
        await filter.locator('select').nth(1).selectOption('>=');
        await filter.locator('select').first().selectOption({ label: 'Temp' });
        await filter.locator('input').fill('90');
        await refresh();
        check('Temp >= 90 compares numbers, not text', (await names()).map((n) => n.split(' ')[0]).join() === 'Reactor3', await names());
        await panel.locator('button', { hasText: '+ Attribute filter' }).click();
        await refresh();
        check('a filter with no attribute chosen is left out, and the pane says so',
            /1 attribute filter has no attribute chosen/.test(await note()) && (await names()).length === 1, await note());
        await panel.locator('.pvx-cfg-af-filter').nth(1).locator('button').click();

        noSearch = true;
        await refresh();
        check('a PI Web API without elements/search says so instead of ignoring the filters',
            /no elements\/search endpoint/.test(await msg()) && (await names()).length === 0, await msg());
        noSearch = false;
        await panel.locator('.pvx-cfg-af-filter').first().locator('button').click();
        await pick('Asset Type', 'Any');
        await panel.locator('label', { hasText: 'Ascending' }).locator('input').check();
        await refresh();

        await row('Site A').locator('button', { hasText: 'Root' }).click();
        await settle();
        check('Root makes an element the Search Root', await field('Search Root').locator('input').inputValue() === 'Site A');
        check('...and searches below it', (await names()).map((n) => n.split(' ')[0]).join() === 'Reactor1,Reactor2', await names());
        check('a leaf element offers no Root', await row('Reactor1').locator('button', { hasText: 'Root' }).count() === 0);
        await panel.locator('button', { hasText: 'Up' }).click();
        await settle();
        check('Up returns to the level above', await field('Search Root').locator('input').inputValue() === '' &&
            (await names()).length === 6, await names());

        await pick('Asset Category', 'Utility');
        await refresh();
        check('Asset Category narrows by category', (await names()).join() === 'Cooling', await names());
        await pick('Asset Category', 'Any');
        await field('Number of Results').locator('input').fill('2');
        await refresh();
        check('Number of Results caps the list and says there are more',
            (await names()).length === 2 && /Showing the first 2/.test(await note()), await note());
        await field('Number of Results').locator('input').fill('100');

        await panel.locator('.pvx-cfg-af-inline select').selectOption({ label: 'Asset Type' });
        await refresh();
        check('Sort by Asset Type groups by template, then name',
            (await panel.locator('.pvx-cfg-af-type').allTextContents()).map((x) => x.trim()).join() === 'Pump,Reactor,Reactor,Reactor,Site,Site');

        await field('Search Root').locator('input').fill('Nowhere');
        await refresh();
        check('a Search Root that does not exist is named', /Nowhere could not be found/.test(await msg()), await msg());
        await field('Search Root').locator('input').fill('\\\\AFSRV\\Lab\\Bench');
        await refresh();
        check('a Search Root in another database is refused, not searched', /is not in \\\\AFSRV\\Production/.test(await msg()), await msg());
        await field('Search Root').locator('input').fill('\\\\AFSRV\\Production\\Site B');
        await refresh();
        check('a full path for the Search Root is accepted', (await names()).map((n) => n.split(' ')[0]).join() === 'Reactor3', await names());

        await row('Reactor3').locator('button', { hasText: 'Use' }).click();
        check('the picked element is stored as its full path', await cfg('RootElementPath') === P + '\\Site B\\Reactor3', await cfg('RootElementPath'));
        check('...and the pane closes', await panel.count() === 0);
        await toggle.nth(1).click();
        await settle();
        check('reopening starts at the current value\'s parent, with the value listed',
            await field('Search Root').locator('input').inputValue() === 'Site B' && (await names()).join() === 'Reactor3', await names());
        await toggle.nth(1).click();

        await page.fill('#pvxat-db', '\\\\AFSRV\\Typo');
        await page.fill('#pvxat-root', '');
        await toggle.nth(1).click();
        await settle();
        check('a database PI Web API does not list is named', /AFSRV\\Typo is not a database PI Web API lists/.test(await note()), await note());
        await toggle.nth(1).click();

        // --- Entry Table: rows appended in the sheet's own grammar ---
        await open('pvxEntryTable', { ElementPath: P + '\\Site A\\Reactor1', Rows: '' });
        await page.locator('.pvx-cfg-af-toggle').nth(1).click();
        await settle();
        check('a rows field opens on the element path\'s attributes',
            (await names()).join() === 'Catalyst Charge,Status,Temp', await names());
        await row('Catalyst Charge').locator('button', { hasText: 'Add' }).click();
        check('a row under the element path is added bare', await cfg('Rows') === 'Catalyst Charge', await cfg('Rows'));
        check('the pane stays open for the next row', await panel.count() === 1);
        await row('Catalyst Charge').locator('button', { hasText: 'Add' }).click();
        check('the same row is refused a second time, and the pane says so',
            await cfg('Rows') === 'Catalyst Charge' && /already in the list/.test(await msg()));
        await row('Temp').locator('.pvx-cfg-af-name').click();
        await settle();
        await row('Setpoint').locator('button', { hasText: 'Add' }).click();
        check('a child attribute keeps its own pipe', await cfg('Rows') === 'Catalyst Charge\nTemp|Setpoint', await cfg('Rows'));
        await panel.locator('button', { hasText: 'Back' }).click();
        await settle();
        check('Back from a child attribute returns to its element', (await names()).join() === 'Catalyst Charge,Status,Temp', await names());
        await panel.locator('button', { hasText: 'Back' }).click();
        await settle();
        check('...and Back again returns to the search results', (await names()).map((n) => n.split(' ')[0]).join() === 'Reactor1,Reactor2', await names());

        // --- Manual Entry: a PI point is a valid pick too ---
        await open('pvxManualEntry', { AttributePath: '' });
        await page.locator('.pvx-cfg-af-toggle').click();
        await settle();
        check('an attribute field also offers PI points', (await options('Database')).join() === 'Lab,Production,PI points on PISRV', await options('Database'));
        await pick('Database', 'PI points on PISRV');
        check('a Data Archive hides the AF-only criteria',
            await field('Search Root').count() === 0 && await field('Asset Type').count() === 0 && await field('Point Name').count() === 1);
        check('...and lists its points', (await names()).join() === 'CDT158,SINUSOID', await names());
        await field('Point Name').locator('input').fill('sinu');
        await field('Point Name').locator('input').press('Enter');
        await settle();
        check('Enter in a criterion runs the search', (await names()).join() === 'SINUSOID', await names());
        await row('SINUSOID').locator('button', { hasText: 'Use' }).click();
        check('a point is stored as \\\\server\\tag', await cfg('AttributePath') === '\\\\PISRV\\SINUSOID', await cfg('AttributePath'));

        await page.fill('#pvxme-path', P + '\\Site A\\Reactor1|Temp');
        await page.locator('.pvx-cfg-af-toggle').click();
        await settle();
        check('an attribute field reopens on its own element\'s attributes',
            /Reactor1/.test(await panel.locator('.pvx-cfg-af-head').first().textContent()) &&
            (await names()).join() === 'Catalyst Charge,Status,Temp', await names());

        // --- Nav Panel: only where an item takes an asset ---
        await open('pvxNavPanel', { Mode: 'display', Items: '' });
        check('no Search in display mode, where a line needs a display id first',
            await page.locator('.pvx-cfg-af-toggle').count() === 0);
        await page.evaluate(() => { window.__scope.config.Mode = 'asset'; window.__scope.$digest(); });
        await page.locator('.pvx-cfg-af-toggle').click();
        await settle();
        await pick('Database', 'Production');
        await row('Cooling').locator('button', { hasText: 'Add' }).click();
        check('asset mode adds "Label | path"', await cfg('Items') === 'Cooling | ' + P + '\\Cooling', await cfg('Items'));

        // --- Nothing in pvx-config.js, PI Web API beside PI Vision, and an
        //     attribute dropped on the symbol: no setup typed anywhere ---
        const SRC = ['af:' + P + '\\Site A\\Reactor1|Temp?g'];
        requests = [];
        await open('pvxAssetTree', { DatabasePath: '', RootElementPath: '' }, 'auto', SRC);
        await page.waitForFunction(() => /Reactor|Site A/.test(document.getElementById('box').textContent));
        check('auto: the tree finds PI Web API on its own server and opens the data source\'s database',
            /Site A/.test(await page.textContent('#box')) && requests.indexOf('') !== -1, requests.slice(0, 4));
        check('...and says where the database came from', /from this symbol.s data source/.test(await page.textContent('#box')),
            await page.textContent('#box'));
        check('...without writing it into the saved config', await cfg('DatabasePath') === '');
        await page.locator('.pvx-cfg-af-toggle').nth(0).click();
        await settle();
        check('auto: a database field\'s Search opens on the data source\'s database',
            await field('Database').locator('select option:checked').textContent() === 'Production');
        await page.locator('.pvx-cfg-af-toggle').nth(0).click();
        await page.locator('.pvx-cfg-af-toggle').nth(1).click();
        await settle();
        check('auto: an element field opens beside the data source\'s element',
            (await names()).indexOf('Reactor1') !== -1, await names());

        // --- A site that has not configured PI Web API ---
        await open('pvxEventGantt', { DatabasePath: '' }, false);
        await page.locator('.pvx-cfg-af-toggle').click();
        await settle();
        check('unconfigured: the pane names the file to fix', /pvx-config\.js/.test(await msg()), await msg());
        check('...and the text box still takes a typed path', await page.isEditable('#pvxeg-db'));

        if (process.env.PVX_AF_SHOT) {
            await open('pvxAssetTree', { DatabasePath: P, RootElementPath: '' });
            await page.locator('.pvx-cfg-af-toggle').nth(1).click();
            await settle();
            await pick('Asset Type', 'Reactor');
            await panel.locator('label', { hasText: 'Return All Descendants' }).locator('input').check();
            await panel.locator('button', { hasText: '+ Attribute filter' }).click();
            await panel.locator('.pvx-cfg-af-filter select').first().selectOption({ label: 'Status' });
            await panel.locator('.pvx-cfg-af-filter input').fill('Running');
            await refresh();
            await panel.screenshot({ path: process.env.PVX_AF_SHOT });
        }

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
        console.error(C.red + 'test-afpick crashed: ' + (e.stack || e.message) + C.reset);
    }
    console.log('');
    console.log((failures ? C.red + C.bold + failures + ' failed' : C.green + C.bold + 'all ' + passes + ' passed') + C.reset);
    process.exit(failures ? 1 : 0);
})();
