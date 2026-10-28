#!/usr/bin/env node
/* ============================================================================
 * PVX entry test: the controls Manual Entry and the Shift Log write with.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-entry.js
 *
 * Two halves:
 *
 *   rules    PVX.entry in plain Node: a stepper click rounds to its step and
 *            stays inside the limits, a Shift Log control field is read (or
 *            refused, saying why), choices split and carry captions.
 *   symbols  the BUILT symbols in real Chromium against a mock PI Web API
 *            that records every write: Manual Entry with each control
 *            (stepper, slider, switch, buttons, a value button, a momentary
 *            one that writes back, also when the display closes or the
 *            write-back fails), and the Shift Log's sections, form layout and
 *            per-row controls, where untouched controls write nothing and a
 *            row with a control it cannot read is never written. Then the
 *            Shift Log's options (required, warn, prefill), soft limits, the
 *            questionable flag, the existing-value rule (insert, protect),
 *            paste and CSV import, and the time-slot grid, against the
 *            mock's recorded values.
 *
 * Proven against this mock only, not yet a server.
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
const PORT = 31804;

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

// Attribute path (lower case) -> [WebId, current value]. A digital state is
// the {Name, Value} shape PI Web API sends.
const state = (name) => ({ Name: name, Value: 0, IsSystem: false });
const ATTRS = {
    '\\\\afsrv\\db\\unit1|setpoint': ['A:sp', 3],
    '\\\\afsrv\\db\\unit1|level': ['A:level', 40],
    '\\\\afsrv\\db\\unit1|enabled': ['A:enabled', false],
    '\\\\afsrv\\db\\unit1|pump state': ['A:pstate', state('Stopped')],
    '\\\\afsrv\\db\\unit1|mode': ['A:mode', state('Normal')],
    '\\\\afsrv\\db\\unit1|start': ['A:start', 0],
    '\\\\afsrv\\db\\unit1|reset fails': ['A:rfail', 0],
    '\\\\afsrv\\db\\unit1|p1 running': ['A:p1run', false],
    '\\\\afsrv\\db\\unit1|p1 mode': ['A:p1mode', state('Auto')],
    '\\\\afsrv\\db\\unit1|tank level': ['A:tlevel', 30],
    '\\\\afsrv\\db\\unit1|tank setpoint': ['A:tsp', 20],
    '\\\\afsrv\\db\\unit1|grade': ['A:grade', 1],
    '\\\\afsrv\\db\\unit1|notes': ['A:notes', ''],
    '\\\\afsrv\\db\\unit1|bad': ['A:bad', 1],
    '\\\\afsrv\\db\\unit1|flow': ['A:flow', 5]
};
const DIGITAL = { 'A:pstate': 1, 'A:mode': 1, 'A:p1mode': 1 };
const VALUES = {};
const NAMES = {};
// Every symbol starts from these values, whatever the one before wrote.
function resetValues() { Object.keys(ATTRS).forEach((p) => { VALUES[ATTRS[p][0]] = ATTRS[p][1]; }); }
Object.keys(ATTRS).forEach((p) => { NAMES[ATTRS[p][0]] = p.split('|')[1].replace(/\b\w/g, (c) => c.toUpperCase()); });
resetValues();

let writes = [];
// Values at a time of their own: [webId] -> [{ts (ISO), value}], what the
// recorded and recorded-at-time reads answer from. Writes with a time land
// here; the read of the grid's slots, and the protect check, read it.
let HISTORY = {};

function lookup(pathText) {
    const a = ATTRS[String(pathText || '').toLowerCase()];
    return a ? { WebId: a[0], Name: NAMES[a[0]], DefaultUnitsName: '' } : null;
}

function valueOf(id) {
    return { Timestamp: new Date().toISOString(), Value: VALUES[id], Good: true };
}

/** Recorded values over a range, and the value at an exact time. */
function history(rel, q) {
    let m = /^streams\/([^/]+)\/recorded$/.exec(rel);
    if (m) {
        const a = Date.parse(q.get('startTime')), b = Date.parse(q.get('endTime'));
        return { Items: (HISTORY[m[1]] || []).filter((x) => Date.parse(x.ts) >= a && Date.parse(x.ts) <= b)
            .map((x) => ({ Timestamp: x.ts, Value: x.value, Good: true })) };
    }
    m = /^streams\/([^/]+)\/recordedattime$/.exec(rel);
    if (m) {
        const hit = (HISTORY[m[1]] || []).find((x) => Date.parse(x.ts) === Date.parse(q.get('time')));
        return hit ? { Timestamp: hit.ts, Value: hit.value, Good: true }
            : { Timestamp: q.get('time'), Value: { Name: 'No Data', Value: 248, IsSystem: true }, Good: false };
    }
    return null;
}

function api(req, res, url, body) {
    const u = new URL(url, 'http://x');
    const q = u.searchParams;
    const rel = decodeURIComponent(u.pathname).replace(/^\/piwebapi\/?/, '');
    const send = (code, b) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
    if (rel === 'attributes') {
        const a = lookup(q.get('path'));
        return a ? send(200, a) : send(404, { Errors: ['No attribute at ' + q.get('path')] });
    }
    if (req.method === 'POST' && rel === 'batch') {
        const reqs = JSON.parse(body || '{}');
        const out = {};
        Object.keys(reqs).forEach((k) => {
            const ru = new URL(reqs[k].Resource);
            const rr = decodeURIComponent(ru.pathname).replace(/^\/piwebapi\/?/, '');
            if (rr === 'attributes') {
                const a = lookup(ru.searchParams.get('path'));
                out[k] = a ? { Status: 200, Content: a } : { Status: 404, Content: { Errors: ['not found'] } };
                return;
            }
            const g = history(rr, ru.searchParams);
            out[k] = g ? { Status: 200, Content: g } : { Status: 404, Content: { Errors: ['No mock for ' + rr] } };
        });
        return send(207, out);
    }
    if (rel === 'system/userinfo') { return send(200, { IdentityType: 'WindowsIdentity', Name: 'PLANT\\jdoe', IsAuthenticated: true }); }
    if (rel === 'streamsets/value') {
        return send(200, { Items: q.getAll('webId').map((id) => ({ WebId: id, Value: valueOf(id) })) });
    }
    const m = /^streams\/([^/]+)\/value$/.exec(rel);
    if (m && req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        writes.push({ id: m[1], value: b.Value, ts: b.Timestamp, questionable: b.Questionable === true, option: q.get('updateOption') || '' });
        if (b.Timestamp && b.Timestamp !== '*') {
            const h = HISTORY[m[1]] = HISTORY[m[1]] || [];
            const at = h.findIndex((x) => x.ts === b.Timestamp);
            // PI Web API's own rule for a value already at that time.
            if (at === -1 || q.get('updateOption') === 'Insert') { h.push({ ts: b.Timestamp, value: b.Value }); }
            else if (q.get('updateOption') !== 'NoReplace') { h[at].value = b.Value; }
            return send(202);
        }
        if (m[1] === 'A:rfail' && b.Value === 0) { return send(400, { Errors: ['The value could not be written.'] }); }
        VALUES[m[1]] = DIGITAL[m[1]] ? state(b.Value) : b.Value;
        return send(202);
    }
    if (m) { return send(200, valueOf(m[1])); }
    send(404, { Errors: ['Not found: ' + rel] });
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
    console.log(C.bold + 'Entry rules' + C.reset);
    const E = loadCore().entry;
    let v = 0;
    for (let i = 0; i < 10; i++) { v = E.step(String(v), '0.1', 1, null, null, null); }
    check('ten clicks of 0.1 make 1, not 0.9999999999999999', v === 1, v);
    check('a stepper starts from the value now when the box is empty', E.step('', '0.5', 1, 0, 10, 3) === 3.5);
    check('...from the minimum when there is no value now', E.step('', '1', 1, 2, 10, null) === 3);
    check('it stops at the maximum and the minimum', E.step('9.8', '0.5', 1, 0, 10, null) === 10 && E.step('0.2', '0.5', -1, 0, 10, null) === 0);
    check('a blank step is 1', E.step('4', '', -1, null, null, null) === 3);

    check('blank is a number box', E.parse('').kind === 'number' && !E.parse('').error);
    const sw = E.parse('switch');
    check('a bare switch is False/True, marked plain', sw.kind === 'switch' && sw.plain &&
        sw.choices.map((c) => c.value).join() === 'False,True', sw);
    const sw2 = E.parse('switch:0=Off/1=On');
    check('switch positions carry captions', !sw2.plain && sw2.choices[1].value === '1' && sw2.choices[1].label === 'On', sw2);
    check('a switch with three positions is refused', /exactly two/.test(E.parse('switch:A/B/C').error));
    const b = E.parse('buttons:Low, Normal ,High wide');
    check('buttons split on / or , and "wide" is read anywhere', b.kind === 'buttons' && b.wide &&
        b.choices.map((c) => c.value).join() === 'Low,Normal,High', b);
    check('buttons with no choices say how to give them', /buttons:Low\/Normal\/High/.test(E.parse('buttons').error));
    check('a stepper step must be a positive number', /not a positive number/.test(E.parse('stepper:-2').error) &&
        E.parse('stepper:0.25').step === '0.25');
    check('an unknown control is named', /control "dial" is not one of/.test(E.parse('dial').error));
    check('numeric choices are told apart from state names',
        E.numericChoices(E.choices('1=A/2=B')) && !E.numericChoices(E.choices('Auto/2')));
    check('values match ignoring case and number spelling', E.same('true', 'True') && E.same('1.0', 1) && !E.same('1', '10'));
}

/* ---------------------------------------------------------------- symbols */

function pageHtml(typeName) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
</head><body><div id="box" style="width:520px;height:420px"></div>
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
            if (req.url.indexOf('/piwebapi') === 0) {
                let body = '';
                req.on('data', (c) => { body += c; });
                req.on('end', () => api(req, res, req.url, body));
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

/** Runs in the browser: mount a write-back symbol with the given config. */
async function mount(a) {
    window.PVX.api.configure({ baseUrl: location.origin + '/piwebapi', autoDiscover: false, auth: 'anonymous' });
    const def = window.PVMock.get(a.typeName);
    const injector = angular.injector(['ng']);
    const $compile = injector.get('$compile');
    const scope = injector.get('$rootScope').$new(true);
    scope.config = def.getDefaultConfig();
    Object.keys(a.config || {}).forEach((k) => { scope.config[k] = a.config[k]; });
    scope.runtimeData = {};
    scope.symbol = { Name: a.typeName, DataSources: ['af:\\\\AFSRV\\DB\\Unit1|Anything?1'] };
    const tpl = await fetch('/dist/ext/sym-' + a.typeName + '-template.html').then((r) => r.text());
    const host = document.createElement('div');
    host.style.cssText = 'width:100%;height:100%';
    const box = document.getElementById('box');
    if (a.w) { box.style.width = a.w + 'px'; }
    if (a.h) { box.style.height = a.h + 'px'; }
    box.appendChild(host);
    const el = angular.element(host).append($compile(tpl)(scope));
    const vis = new def.visObjectType();
    vis.init(scope, el, undefined);
    window.__scope = scope;
    window.__vis = vis;
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
        const settle = (ms) => page.waitForTimeout(ms || 250);
        const open = async (typeName, config, size) => {
            await page.goto('http://127.0.0.1:' + PORT + '/page/' + typeName, { waitUntil: 'networkidle' });
            writes = [];
            HISTORY = {};
            resetValues();
            await page.evaluate(mount, Object.assign({ typeName: typeName, config: config }, size || {}));
            await settle(500);
        };
        const text = (sel) => page.evaluate((s) => { const n = document.querySelector('#box ' + s); return n ? n.textContent : null; }, sel);
        const attr = (sel, a) => page.evaluate((x) => { const n = document.querySelector('#box ' + x[0]); return n ? n.getAttribute(x[1]) : null; }, [sel, a]);
        const click = async (sel) => { await page.click('#box ' + sel); await settle(150); };
        const msg = () => text('.pvx-mentry-msg-text');
        const vals = () => writes.map((w) => w.value);
        const slide = async (v) => {
            await page.evaluate((x) => { const r = document.querySelector('#box .pvx-ctl-range'); r.value = x;
                r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }, v);
            await settle(150);
        };
        const ME = { AttributePath: '\\\\AFSRV\\DB\\Unit1|Setpoint' };

        console.log('');
        console.log(C.bold + 'Manual Entry: the field it always had' + C.reset);
        await open('pvxManualEntry', ME);
        check('the default is one number box, as before', await page.evaluate(() =>
            document.querySelectorAll('#box .pvx-mentry-inputwrap input.pvx-mentry-input[type="number"]').length === 1 &&
            document.querySelectorAll('#box .pvx-ctl-step, #box .pvx-ctl-sw, #box .pvx-ctl-opt, #box .pvx-ctl-range').length === 0));
        await page.fill('#box .pvx-mentry-input', '42');
        await click('.pvx-mentry-btn');
        await click('.pvx-mentry-yes');
        check('typed, confirmed, written once', vals().join() === '42' && writes[0].ts === '*', writes);

        console.log('');
        console.log(C.bold + 'Manual Entry: stepper' + C.reset);
        await open('pvxManualEntry', Object.assign({ Control: 'stepper', StepSize: '0.5', MinValue: '0', MaxValue: '10' }, ME));
        const box = () => page.evaluate(() => document.querySelector('#box .pvx-mentry-input').value);
        await click('.pvx-ctl-step[aria-label="Increase"]');
        check('+ starts from the value PI holds (3)', await box() === '3.5', await box());
        for (let i = 0; i < 16; i++) { await page.click('#box .pvx-ctl-step[aria-label="Increase"]'); }
        await settle(100);
        check('...and stops at the maximum', await box() === '10', await box());
        check('clicking writes nothing', writes.length === 0, writes);
        await click('.pvx-ctl-step[aria-label="Decrease"]');
        await click('.pvx-mentry-btn');
        await click('.pvx-mentry-yes');
        check('the button writes what the stepper shows', vals().join() === '9.5', writes);

        console.log('');
        console.log(C.bold + 'Manual Entry: slider' + C.reset);
        await open('pvxManualEntry', { Control: 'slider', StepSize: '5', MinValue: '0', MaxValue: '100',
            AttributePath: '\\\\AFSRV\\DB\\Unit1|Level' });
        check('untouched, it sits at the value now and its readout says so',
            await page.evaluate(() => document.querySelector('#box .pvx-ctl-range').value) === '40' && /40/.test(await text('.pvx-ctl-readout')),
            await text('.pvx-ctl-readout'));
        await click('.pvx-mentry-btn');
        check('Write before moving it asks for a choice and sends nothing', /Choose a value first/.test(await msg()) && !writes.length, await msg());
        await slide('65');
        check('moved: the readout follows, and the pick is outlined as not yet written',
            /65/.test(await text('.pvx-ctl-readout')) && await attr('.pvx-ctl', 'data-pending') === 'yes');
        await click('.pvx-mentry-btn');
        await click('.pvx-mentry-yes');
        await settle(300);
        check('it writes 65 and goes back to showing PI', vals().join() === '65' && await attr('.pvx-ctl', 'data-pending') === 'no', writes);
        await open('pvxManualEntry', Object.assign({ Control: 'slider', MinValue: '0' }, ME));
        check('without a maximum: the field, and a note saying why',
            /needs a minimum and a maximum/.test(await text('.pvx-mentry-note')) &&
            await page.evaluate(() => !!document.querySelector('#box input.pvx-mentry-input[type="number"]')), await text('.pvx-mentry-note'));

        console.log('');
        console.log(C.bold + 'Manual Entry: switch' + C.reset);
        await open('pvxManualEntry', { Control: 'switch', InputType: 'boolean', RequireConfirm: false, WriteOnChange: true,
            SwitchOffLabel: 'Disabled', SwitchOnLabel: 'Enabled', AttributePath: '\\\\AFSRV\\DB\\Unit1|Enabled' });
        check('it shows the value PI holds: off, captioned', await attr('.pvx-ctl-sw', 'aria-checked') === 'false' &&
            await text('.pvx-ctl-cap') === 'Disabled', [await attr('.pvx-ctl-sw', 'aria-checked'), await text('.pvx-ctl-cap')]);
        await click('.pvx-ctl-sw');
        await settle(300);
        check('a flip with write-on-change writes the Boolean true at once', writes.length === 1 && writes[0].value === true, writes);
        check('...and the switch now shows the value read back', await attr('.pvx-ctl-sw', 'aria-checked') === 'true' &&
            await attr('.pvx-ctl', 'data-pending') === 'no');
        await open('pvxManualEntry', { Control: 'switch', InputType: 'digital', DigitalStates: 'Stopped, Running',
            WriteOnChange: true, AttributePath: '\\\\AFSRV\\DB\\Unit1|Pump State' });
        await click('.pvx-ctl-sw');
        check('with confirmation on, the flip asks first and names the state',
            /Running/.test(await text('.pvx-mentry-confirm-text')) && !writes.length, await text('.pvx-mentry-confirm-text'));
        await click('.pvx-mentry-no');
        check('Cancel puts the switch back to what PI holds', await attr('.pvx-ctl-sw', 'aria-checked') === 'false' && !writes.length);
        await click('.pvx-ctl-sw');
        await click('.pvx-mentry-yes');
        check('confirmed: the state name is written', vals().join() === 'Running', writes);
        await open('pvxManualEntry', { Control: 'switch', InputType: 'digital', DigitalStates: 'Low, Normal, High',
            AttributePath: '\\\\AFSRV\\DB\\Unit1|Mode' });
        check('three states cannot be a switch: the dropdown, and why', /exactly two digital states/.test(await text('.pvx-mentry-note')) &&
            await page.evaluate(() => !!document.querySelector('#box select.pvx-mentry-input')));

        console.log('');
        console.log(C.bold + 'Manual Entry: buttons' + C.reset);
        await open('pvxManualEntry', { Control: 'buttons', InputType: 'digital', DigitalStates: 'Low, Normal, High',
            AttributePath: '\\\\AFSRV\\DB\\Unit1|Mode' });
        const pressed = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#box .pvx-ctl-opt'),
            (n) => n.textContent + (n.getAttribute('data-current') === 'yes' ? '*' : '') + (n.getAttribute('aria-pressed') === 'true' ? '+' : '')).join(' '));
        check('a button per state, the one PI holds marked', await pressed() === 'Low Normal* High', await pressed());
        await click('.pvx-ctl-opt:last-child');
        check('a click picks it, without writing', await pressed() === 'Low Normal* High+' && !writes.length, await pressed());
        await click('.pvx-mentry-btn');
        await click('.pvx-mentry-yes');
        await settle(300);
        check('Write sends the state', vals().join() === 'High' && await pressed() === 'Low Normal High*', [writes, await pressed()]);
        await open('pvxManualEntry', Object.assign({ Control: 'buttons', DigitalStates: '0, 50, 100', RequireConfirm: false }, ME));
        await click('.pvx-ctl-opt:nth-child(2)');
        await click('.pvx-mentry-btn');
        check('number choices are written as numbers', writes.length === 1 && writes[0].value === 50, writes);

        console.log('');
        console.log(C.bold + 'Manual Entry: value button and momentary' + C.reset);
        await open('pvxManualEntry', { Control: 'value', PressValue: '1', ResetValue: '0', ResetSeconds: 0.6,
            ButtonLabel: 'Start', AttributePath: '\\\\AFSRV\\DB\\Unit1|Start' });
        check('it says what it writes, and has no field', /Writes 1, then 0 after 0.6 s/.test(await text('.pvx-mentry-press')) &&
            await page.evaluate(() => !document.querySelector('#box .pvx-mentry-inputwrap input:not([type="hidden"])')), await text('.pvx-mentry-press'));
        await click('.pvx-mentry-btn');
        check('the press is confirmed like any write', /Write 1(\.0+)? to Start/.test(await text('.pvx-mentry-confirm-text')) && !writes.length,
            await text('.pvx-mentry-confirm-text'));
        await page.click('#box .pvx-mentry-yes');
        await settle(100);
        check('1 is written and the button is held until the write-back', vals().join() === '1' &&
            await page.evaluate(() => document.querySelector('#box .pvx-mentry-btn').disabled) &&
            /Resetting/.test(await text('.pvx-mentry-btn')), [writes, await text('.pvx-mentry-btn')]);
        await settle(900);
        check('then 0, stamped now, with no second confirmation', vals().join() === '1,0' && writes[1].ts === '*' &&
            /Reset to 0/.test(await msg()), [writes, await msg()]);
        check('...and the button is free again', await page.evaluate(() => !document.querySelector('#box .pvx-mentry-btn').disabled));

        await open('pvxManualEntry', { Control: 'value', PressValue: '1', ResetValue: '0', ResetSeconds: 30, RequireConfirm: false,
            AttributePath: '\\\\AFSRV\\DB\\Unit1|Start' });
        await click('.pvx-mentry-btn');
        await page.evaluate(() => window.__vis.onDestroy());
        await settle(300);
        check('closing the display mid-press sends the write-back at once', vals().join() === '1,0', writes);

        await open('pvxManualEntry', { Control: 'value', PressValue: '1', ResetValue: '0', ResetSeconds: 0.5, RequireConfirm: false,
            AttributePath: '\\\\AFSRV\\DB\\Unit1|Reset Fails' });
        await click('.pvx-mentry-btn');
        await settle(900);
        check('a failed write-back says what the attribute may still hold',
            vals().join() === '1,0' && /Reset to 0 failed/.test(await msg()) && /may still hold 1/.test(await text('.pvx-mentry-msg-detail')),
            [await msg(), await text('.pvx-mentry-msg-detail')]);

        await open('pvxManualEntry', Object.assign({ Control: 'value', PressValue: '12', MaxValue: '10' }, ME));
        await click('.pvx-mentry-btn');
        check('a press value outside the limits is refused before sending', /above the maximum of 10/.test(await msg()) && !writes.length, await msg());
        await open('pvxManualEntry', Object.assign({ Control: 'value' }, ME));
        check('with no value set the symbol says so', /Set the value this button writes/.test(await text('.pvx-mentry-note')));

        console.log('');
        console.log(C.bold + 'Shift Log: sections, controls, form layout' + C.reset);
        const ROWS = [
            '[Pumps]',
            'P1 Running | Pump 1 | | | switch',
            'P1 Mode | Mode | | | buttons:Auto/Manual/Off',
            '[Tank]',
            'Tank Level | Level | % | 0:100 | slider:5',
            'Tank Setpoint | Setpoint | degC | 0:50 | stepper:0.5',
            'Grade | Grade | | | select:1=A/2=B/3=C',
            'Notes | Notes | | | text wide',
            'Bad | Bad | | | dial',
            'Flow | Flow | | | slider'
        ].join('\n');
        await open('pvxEntryTable', { ElementPath: '\\\\AFSRV\\DB\\Unit1', Rows: ROWS }, { w: 560, h: 600 });
        const sections = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#box .pvx-etable-section'), (n) => n.textContent).join());
        check('list: a heading per section', await sections() === 'Pumps,Tank', await sections());
        const rowAttr = (i, a) => page.evaluate((x) => document.querySelectorAll('#box .pvx-etable-rows .pvx-etable-row')[x[0]].getAttribute(x[1]), [i, a]);
        const statuses = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#box .pvx-etable-rows .pvx-etable-row'),
            (n) => n.querySelector('.pvx-etable-c-status').textContent));
        const st = await statuses();
        check('a control it cannot read, and a slider without a range, are marked on their rows', st.length === 8 &&
            st[6] === 'bad control' && st[7] === 'bad control', st);
        check('...with the reason in the tooltip', /control "dial" is not one of/.test(await rowAttr(6, 'title')) &&
            /slider needs a min:max range/.test(await rowAttr(7, 'title')), [await rowAttr(6, 'title'), await rowAttr(7, 'title')]);
        check('untouched controls count as nothing to submit', (await text('.pvx-etable-submit')).trim() === 'Submit readings' &&
            await page.evaluate(() => document.querySelector('#box .pvx-etable-submit').disabled), await text('.pvx-etable-submit'));

        await page.evaluate(() => { window.__scope.config.Layout = 'form'; window.__scope.config.FormColumns = 3;
            window.__vis.onConfigChange(window.__scope.config); });
        await settle(700);
        const grid = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#box .pvx-etable-grid'),
            (g) => g.style.gridTemplateColumns + ':' + g.children.length));
        const g = await grid();
        check('form: a grid per section, with the columns asked for when they fit (3 at 560px)',
            g.length === 2 && /repeat\(3/.test(g[0]) && /:2$/.test(g[0]) && /:6$/.test(g[1]), g);
        check('a wide row takes the full width', await page.evaluate(() => {
            const n = document.querySelectorAll('#box .pvx-etable-rows .pvx-etable-row')[5];
            return n.getAttribute('data-wide') === 'yes' && Math.abs(n.getBoundingClientRect().width -
                n.parentNode.getBoundingClientRect().width) < 2; }));
        await page.evaluate(() => { document.getElementById('box').style.width = '380px'; window.__vis.onResize(380, 600); });
        await settle(500);
        check('narrower, it uses fewer columns', /repeat\(2/.test((await grid())[0]), await grid());
        await page.evaluate(() => { document.getElementById('box').style.width = '560px'; window.__vis.onResize(560, 600); });
        await settle(400);
        if (process.env.PVX_ENTRY_PNG) { await page.locator('#box').screenshot({ path: process.env.PVX_ENTRY_PNG }); }
        check('the switch and the buttons show the values PI holds', await page.evaluate(() =>
            document.querySelector('#box .pvx-ctl-sw').getAttribute('aria-checked') === 'false' &&
            document.querySelector('#box .pvx-ctl-opt[data-current="yes"]').textContent === 'Auto'));

        await click('.pvx-ctl-sw');
        await click('.pvx-ctl-opt:nth-child(2)');
        await slide('55');
        await click('.pvx-ctl-step[aria-label="Increase"]');
        await click('.pvx-ctl-step[aria-label="Increase"]');
        await page.selectOption('#box select.pvx-etable-input', '2');
        await page.fill('#box .pvx-ctl-text input', 'Seal leaking');
        await settle(200);
        check('six picks and entries, counted on the button', /\(6\)/.test(await text('.pvx-etable-submit')), await text('.pvx-etable-submit'));
        check('nothing written before Submit', writes.length === 0, writes);
        await click('.pvx-etable-submit');
        const items = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#box .pvx-etable-confirm-item'),
            (n) => Array.prototype.map.call(n.children, (c) => c.textContent).join(' ')));
        check('the confirmation names each reading with its caption', items.join(' / ').replace(/\.00\b/g, '') ===
            'Pump 1 On / Mode Manual / Level 55 % / Setpoint 21 degC / Grade B / Notes Seal leaking', items);
        await click('.pvx-etable-yes');
        await settle(500);
        const byId = {};
        writes.forEach((w) => { byId[w.id] = w.value; });
        check('each written with its own type: Boolean, state, numbers, a number for a captioned choice, text',
            byId['A:p1run'] === true && byId['A:p1mode'] === 'Manual' && byId['A:tlevel'] === 55 && byId['A:tsp'] === 21 &&
            byId['A:grade'] === 2 && byId['A:notes'] === 'Seal leaking', byId);
        check('the rows with a bad control are not written', writes.length === 6 && !('A:bad' in byId) && !('A:flow' in byId), writes);
        check('picked controls go back to showing PI', await page.evaluate(() =>
            document.querySelector('#box .pvx-ctl-sw').getAttribute('aria-checked') === 'true' &&
            !document.querySelector('#box .pvx-ctl[data-pending="yes"]')));

        await open('pvxEntryTable', { ElementPath: '\\\\AFSRV\\DB\\Unit1', Rows: 'Tank Level | Level | % | 0:100' });
        check('a sheet with no controls is the list it always was', await page.evaluate(() =>
            document.querySelector('#box .pvx-etable-form').getAttribute('data-layout') === 'list' &&
            document.querySelectorAll('#box input.pvx-etable-input[type="number"]').length === 1 &&
            !document.querySelector('#box .pvx-etable-section, #box .pvx-etable-grid')));


        console.log('');
        console.log(C.bold + 'Shift Log: required, soft limits, prefill, questionable, existing values' + C.reset);
        const UNIT = { ElementPath: '\\\\AFSRV\\DB\\Unit1' };
        const OPT_ROWS = [
            'Tank Level | Level | % | 0:100 | | warn 20:80',
            'Tank Setpoint | Setpoint | degC | 0:50 | | required',
            'Notes | Operator | | | text | prefill user',
            'Flow | Flow | | | | prefill last',
            'Bad | Bad | | | | sometimes'
        ].join('\n');
        const boxVal = (i) => page.evaluate((x) => document.querySelectorAll('#box .pvx-etable-rows .pvx-etable-row')[x].querySelector('.pvx-etable-input').value, i);
        const fillRow = async (i, v) => {
            await page.evaluate((x) => { const n = document.querySelectorAll('#box .pvx-etable-rows .pvx-etable-row')[x[0]].querySelector('.pvx-etable-input');
                n.value = x[1]; n.dispatchEvent(new Event('input')); }, [i, v]);
            await settle(100);
        };
        const etMsg = async () => (await text('.pvx-etable-msg-text')) + ' | ' + (await text('.pvx-etable-msg-detail'));
        const confirmItems = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#box .pvx-etable-confirm-item'),
            (n) => Array.prototype.map.call(n.children, (c) => c.textContent).join(' ')));
        await open('pvxEntryTable', Object.assign({ Rows: OPT_ROWS, RequireConfirm: false }, UNIT), { w: 560, h: 520 });
        await settle(300);
        const st2 = await statuses();
        check('an option it cannot read marks the row and keeps it from being written', st2[4] === 'bad option' &&
            /option "sometimes" is not one of/.test(await rowAttr(4, 'title')), [st2, await rowAttr(4, 'title')]);
        check('prefill user is the viewer\'s name from PI Web API, prefill last the value PI holds',
            await boxVal(2) === 'PLANT\\jdoe' && await boxVal(3) === '5' &&
            await page.evaluate(() => document.querySelectorAll('#box .pvx-etable-prefilled').length === 2), [await boxVal(2), await boxVal(3)]);
        check('a required row is marked on its label', /Setpoint \(degC\) \*$/.test(await page.evaluate(() =>
            document.querySelectorAll('#box .pvx-etable-rows .pvx-etable-c-label')[1].textContent)));
        await fillRow(0, '90');
        await click('.pvx-etable-submit');
        check('a blank required row stops the sheet', /cannot be sent/.test(await etMsg()) && /Setpoint is required/.test(await etMsg()) && !writes.length, await etMsg());
        await fillRow(1, '10');
        await click('.pvx-etable-submit');
        const ci = await confirmItems();
        check('a value outside its warn range is confirmed even with confirmation off, and says why',
            /1 is outside the usual range/.test(await text('.pvx-etable-confirm-text')) && ci.some((x) => /^Level 90(\.0+)? % ⚠ above the usual 80$/.test(x)) && !writes.length, ci);
        check('prefilled boxes are written with the rest', ci.some((x) => x === 'Operator PLANT\\jdoe') && ci.some((x) => /^Flow 5/.test(x)), ci);
        await click('.pvx-etable-yes');
        await settle(500);
        const byId2 = {};
        writes.forEach((w) => { byId2[w.id] = w; });
        check('written: the warned value, the required one, the prefills; nothing extra on the request',
            writes.length === 4 && byId2['A:tlevel'].value === 90 && byId2['A:notes'].value === 'PLANT\\jdoe' && byId2['A:flow'].value === 5 &&
            writes.every((w) => !w.questionable && w.option === ''), writes);
        check('after the write the prefill comes back for the next round', await boxVal(2) === 'PLANT\\jdoe', await boxVal(2));

        await open('pvxEntryTable', Object.assign({ Rows: 'Tank Level | Level | % | 0:100' }, UNIT));
        await fillRow(0, '120');
        await click('.pvx-etable-submit');
        check('hard limits by default: outside min:max is refused', /is above 100/.test(await etMsg()) && !(await page.$('#box .pvx-etable-confirm-item')), await etMsg());
        await open('pvxEntryTable', Object.assign({ Rows: 'Tank Level | Level | % | 0:100', LimitMode: 'soft', AllowQuestionable: true, ExistingValues: 'insert' }, UNIT));
        await fillRow(0, '120');
        await page.check('#box .pvx-etable-q-box');
        await click('.pvx-etable-submit');
        check('soft limits: written after the confirmation names the limit', (await confirmItems()).some((x) => /\(questionable\) ⚠ above the limit of 100$/.test(x)), await confirmItems());
        await click('.pvx-etable-yes');
        await settle(400);
        check('questionable and keep-beside go to PI Web API with the write', writes.length === 1 && writes[0].value === 120 &&
            writes[0].questionable === true && writes[0].option === 'Insert', writes);
        check('the questionable box clears with the row', await page.evaluate(() => !document.querySelector('#box .pvx-etable-q-box').checked));

        const AT6 = '2026-10-27 06:00';
        const at6 = new Date(2026, 9, 27, 6, 0).toISOString();
        await open('pvxEntryTable', Object.assign({ Rows: 'Tank Level | Level\nTank Setpoint | Setpoint', ExistingValues: 'protect', TimestampMode: 'custom', RequireConfirm: false }, UNIT));
        HISTORY['A:tlevel'] = [{ ts: at6, value: 44 }];
        await page.fill('#box .pvx-etable-stamp-input', AT6);
        await fillRow(0, '50');
        await fillRow(1, '12');
        await click('.pvx-etable-submit');
        await settle(500);
        check('protect: a value already at that time is kept and not sent', writes.length === 1 && writes[0].id === 'A:tsp' &&
            writes[0].option === 'NoReplace' && writes[0].ts === at6 && HISTORY['A:tlevel'][0].value === 44, writes);
        check('...the row says kept, and the message why', (await statuses())[0] === 'kept' && /1 value was kept: PI already holds a value at that time/.test(await etMsg()),
            [await statuses(), await etMsg()]);

        console.log('');
        console.log(C.bold + 'Shift Log: paste and CSV import' + C.reset);
        const PASTE_ROWS = 'Tank Level | Level | % | 0:100\nTank Setpoint | Setpoint\nFlow | Flow\nP1 Running | Pump 1 | | | switch\nNotes | Notes | | | text';
        await open('pvxEntryTable', Object.assign({ Rows: PASTE_ROWS, PasteRows: true }, UNIT), { w: 560, h: 520 });
        const paste = (i, t) => page.evaluate((x) => {
            const n = document.querySelectorAll('#box .pvx-etable-rows .pvx-etable-row')[x[0]].querySelector('.pvx-etable-input');
            const dt = new DataTransfer(); dt.setData('text/plain', x[1]);
            n.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }, [i, t]);
        await paste(1, '7\n8\n9\n10');
        await settle(150);
        check('a pasted column fills down from the box, and skips a picked control',
            await boxVal(1) === '7' && await boxVal(2) === '8' && await boxVal(4) === '10' && await boxVal(0) === '' &&
            /Pasted 3 values/.test(await etMsg()) && /1 not placed/.test(await etMsg()), [await boxVal(1), await boxVal(2), await boxVal(4), await etMsg()]);
        await paste(4, 'Level\t55\nnotes\tChecked\n');
        await settle(150);
        check('a pasted line that names a row goes to that row', await boxVal(0) === '55' && await boxVal(4) === 'Checked', [await boxVal(0), await boxVal(4)]);
        check('nothing is written by a paste', writes.length === 0);
        await open('pvxEntryTable', Object.assign({ Rows: PASTE_ROWS }, UNIT));
        await paste(1, '7\n8');
        await settle(150);
        check('paste-fill is off by default: an ordinary paste, the rows below untouched', await boxVal(2) === '', await boxVal(2));

        await open('pvxEntryTable', Object.assign({ Rows: PASTE_ROWS, ShowImport: true, TimestampMode: 'perRow' }, UNIT), { w: 560, h: 520 });
        check('the Import CSV button shows only when asked for', await page.evaluate(() => document.querySelector('#box .pvx-etable-import').style.display !== 'none'));
        await page.setInputFiles('#box .pvx-etable-file', { name: 'rounds.csv', mimeType: 'text/csv',
            buffer: Buffer.from('name,value,time\nLevel,61,2026-10-27 06:00\n"Tank Setpoint",11\nMystery,3\nNotes,"Seal, leaking"\n') });
        await settle(300);
        check('CSV import fills rows by label or attribute name, with a quoted comma, and a time into the row\'s time box',
            await boxVal(0) === '61' && await boxVal(1) === '11' && await boxVal(4) === 'Seal, leaking' &&
            await page.evaluate(() => document.querySelector('#box .pvx-etable-rowstamp').value) === '2026-10-27 06:00', [await boxVal(0), await boxVal(1), await boxVal(4)]);
        check('...and names what it could not place', /Imported 3 values from rounds.csv/.test(await etMsg()) && /1 not a row here: Mystery/.test(await etMsg()), await etMsg());
        await open('pvxEntryTable', Object.assign({ Rows: PASTE_ROWS }, UNIT));
        check('no Import button by default', await page.evaluate(() => document.querySelector('#box .pvx-etable-import').style.display === 'none'));

        console.log('');
        console.log(C.bold + 'Shift Log: the time-slot grid' + C.reset);
        const hr = new Date(); hr.setMinutes(0, 0, 0);
        const slot0 = hr.getTime() - 3 * 3600000;
        await open('pvxEntryTable', Object.assign({ Rows: 'Tank Level | Level | % | 0:100\nGrade | Grade | | | select:1=A/2=B', Layout: 'slots',
            SlotStart: '*-3h', SlotInterval: '1h', SlotCount: 5, PasteRows: true }, UNIT), { w: 620, h: 360 });
        HISTORY['A:tlevel'] = [{ ts: new Date(slot0 + 5 * 60000).toISOString(), value: 41 }];
        await page.evaluate(() => { window.__vis.onConfigChange(window.__scope.config); });
        await settle(900);
        const heads6 = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#box .pvx-etable-slot-time'), (n) => n.textContent));
        const pad2 = (x) => (x < 10 ? '0' : '') + x;
        check('a column per slot, on the hour', heads6.length === 5 && heads6[0] === pad2(new Date(slot0).getHours()) + ':00', heads6);
        const cellAt = (r, k, what) => page.evaluate((x) => {
            const td = document.querySelectorAll('#box .pvx-etable-slotrow')[x[0]].querySelectorAll('.pvx-etable-slot')[x[1]];
            return x[2] === 'td' ? td.getAttribute(x[3]) : td.querySelector('input')[x[3]] || td.querySelector('input').getAttribute(x[3]); }, [r, k, what[0], what[1]]);
        check('a slot shows what PI holds in it', await cellAt(0, 0, ['td', 'data-archived']) === 'yes' &&
            /^41/.test(await cellAt(0, 0, ['in', 'placeholder'])) && await cellAt(0, 1, ['td', 'data-archived']) === 'no',
            [await cellAt(0, 0, ['in', 'placeholder'])]);
        check('a slot still to come cannot be filled', await page.evaluate(() =>
            document.querySelectorAll('#box .pvx-etable-slotrow')[0].querySelectorAll('input')[4].disabled));
        await page.evaluate(() => {
            const n = document.querySelectorAll('#box .pvx-etable-slotrow')[0].querySelectorAll('input')[1];
            const dt = new DataTransfer(); dt.setData('text/plain', '33\t34\nB\tA');
            n.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        });
        await settle(150);
        check('a block pasted into the grid fills across the slots and down the rows', /Pasted 4 values/.test(await etMsg()), await etMsg());
        await click('.pvx-etable-submit');
        const ci6 = await confirmItems();
        check('the confirmation names each reading by its slot, a choice by its caption', ci6.length === 4 &&
            new RegExp('^Level · ' + heads6[1] + ' 33(\\.0+)? %$').test(ci6[0]) && ci6.some((x) => x === 'Grade · ' + heads6[2] + ' A'), ci6);
        await click('.pvx-etable-yes');
        await settle(700);
        const g6 = writes.filter((w) => w.id === 'A:grade');
        check('each cell written at its slot\'s own time, a choice as its value', writes.length === 4 &&
            writes.some((w) => w.id === 'A:tlevel' && w.value === 33 && Date.parse(w.ts) === slot0 + 3600000) &&
            g6.some((w) => w.value === 2 && Date.parse(w.ts) === slot0 + 3600000) && g6.some((w) => w.value === 1 && Date.parse(w.ts) === slot0 + 7200000), writes);
        check('a saved cell clears and then shows the value PI now holds', await cellAt(0, 1, ['td', 'data-status']) === 'saved' &&
            !(await cellAt(0, 1, ['in', 'value'])) && /^33/.test(await cellAt(0, 1, ['in', 'placeholder'])),
            [await cellAt(0, 1, ['td', 'data-status']), await cellAt(0, 1, ['in', 'value']), await cellAt(0, 1, ['in', 'placeholder'])]);
        await open('pvxEntryTable', Object.assign({ Rows: 'Tank Level', Layout: 'slots', SlotInterval: 'hourly' }, UNIT));
        check('an interval it cannot read is said', /cannot be laid out/.test(await etMsg()) && /"hourly" is not a duration/.test(await etMsg()), await etMsg());

        check('no page errors', errors.length === 0, errors);
    } finally {
        await browser.close();
        server.close();
    }
}

(async () => {
    try {
        rules();
        await symbols();
    } catch (e) {
        failures += 1;
        console.error(C.red + 'test-entry crashed: ' + (e.stack || e.message) + C.reset);
    }
    console.log('');
    console.log((failures ? C.red + C.bold + failures + ' failed' : C.green + C.bold + 'all ' + passes + ' passed') + C.reset);
    process.exit(failures ? 1 : 0);
})();
