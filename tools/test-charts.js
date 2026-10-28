#!/usr/bin/env node
/* ============================================================================
 * PVX charts test — Wind Rose, XY bubble, Variability by time, Control Chart, Gas
 * Triangle, against
 * data whose right answer is known.
 * ----------------------------------------------------------------------------
 *   node tools/test-charts.js
 *
 * verify.js proves these render without faults on mock data, which would
 * still pass if every share were wrong. This feeds each symbol a small
 * hand-built payload through tools/probe.js (real Chromium, straight from
 * src/) and reads the computed numbers back out of the tooltips and footer:
 *
 *   wind rose   350° and 10° both land in the north sector (wrap at north);
 *               shares are weighted by time held, not by sample count; a gap
 *               longer than the limit is not credited to the direction before
 *               it, and the footer says how much was left out; calm is
 *               reported, not drawn; "blows to" turns the rose round.
 *   bubble      the third source's value reaches each point's tooltip and
 *               the footer's size range; a pair with no size value is counted.
 *   histogram   bars by time held give each value its duration, and the P50
 *               marker follows time, not sample count.
 *   flow        a fixed link ("=4.5") draws, is named as typed, and a fixed
 *               value that is not a number is malformed rather than zero.
 *   box plot    by hour: one box per local hour with the right members; the
 *               overlay steps with the source's mean in each hour, carrying
 *               the last value into an hour with none; as a plain overlay a
 *               source is not drawn as a box, and the footer says so.
 *   control     I-MR and X-bar R limits match the hand calculation; a point
 *               past a fixed limit and a run are flagged by rule number;
 *               limits and spec read from data sources use their latest
 *               value; a custom trend length reaches the tooltip text.
 *   kpi card    time-weighted average, total over time, standard deviation
 *               and percent good match the hand calculation; a typed target
 *               within its tolerance reads On target; progress is the share
 *               of the target.
 *   period cmp  change from the median of the older periods and from the
 *               period before, absolute and percent, against hand figures;
 *               a calendar-month fold names its periods by month; a second
 *               source draws its own current period.
 *   multi gauge a value that is not a number gets no pointer, a value off
 *               the scale is pinned and named, and sources past the limit
 *               are counted; the readout names each value.
 *   gas triangle the zone rules agree with the drawn outlines at every
 *               point of a fine grid, and with the zone boundaries IEC 60599
 *               tabulates; sources are matched to gases by name in any
 *               order; the minimum total withholds the zone; a negative or
 *               non-numeric reading is counted, not plotted.
 *
 * Requires the dev dependency `playwright`. Set PVX_CHROMIUM to use a
 * pre-installed browser.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', bold: '\x1b[1m' };
let failures = 0;
let passes = 0;

function check(name, ok, detail) {
    if (ok) { passes += 1; console.log('  ' + C.green + 'ok  ' + C.reset + name); return; }
    failures += 1;
    console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + name + (detail !== undefined ? C.dim + '  got ' + JSON.stringify(detail) + C.reset : ''));
}

const T0 = Date.parse('2026-10-20T00:00:00Z');
const MIN = 60000;

/** One TimeSeries data source from [minutesAfterT0, value] pairs. */
function series(label, units, pts) {
    return {
        Label: label, Units: units, Path: '\\\\AF\\Test|' + label, IsGood: true,
        Value: pts.map((p) => ({ Time: new Date(T0 + p[0] * MIN).toISOString(), Value: p[1] }))
    };
}

let seq = 0;
function probe(typeName, data, config) {
    const file = path.join(os.tmpdir(), 'pvx-charts-' + process.pid + '-' + (seq++) + '.json');
    fs.writeFileSync(file, JSON.stringify({ Data: data }));
    // data null: the probe's own mock, for shapes (Table) built from it.
    const args = [path.join(__dirname, 'probe.js'), typeName, '--w', '520', '--h', '340', '--json',
        '--out', file.replace(/\.json$/, '.png')].concat(data === null ? ['--count', '3'] : ['--payload', file]);
    if (config) { args.push('--config', config); }
    let out;
    try {
        // Boxes by time bucket in local time; pin it so the answers below
        // hold on any workstation.
        out = execFileSync(process.execPath, args, { encoding: 'utf8', env: Object.assign({}, process.env, { TZ: 'UTC' }) });
    } catch (e) {
        // probe exits 1 on page errors but still prints its report.
        out = e.stdout || '';
    }
    const json = JSON.parse(out.slice(out.indexOf('{')));
    const r = json.report || {};
    return { tips: r.tips || [], footer: r.footer || '', text: r.text || '', errors: (json.errors || []).concat(r.fatal ? [r.fatal] : []) };
}

/** The tooltip of the wedge for one direction word, e.g. 'from N ('. */
function tipFor(res, prefix) {
    return res.tips.filter((t) => t.indexOf(prefix) === 0).join(' | ');
}

function windRose() {
    console.log('');
    console.log(C.bold + 'Wind rose' + C.reset);
    const all = [];

    // 350° for an hour, 10° for an hour, then 180°. The last sample has no
    // successor and holds for the median hold, an hour: N 2 h of 3, S 1 h.
    const wrap = probe('pvxWindRose', [
        series('Dir', '°', [[0, 350], [60, 10], [120, 180]]),
        series('Speed', 'm/s', [[0, 5], [60, 5], [120, 5]])
    ]);
    all.push(wrap);
    check('350° and 10° share the north sector', /from N \(/.test(tipFor(wrap, 'from N (')) && /67% of the time/.test(tipFor(wrap, 'from N (')), tipFor(wrap, 'from N ('));
    check('...and nothing lands in NNW or NNE', !tipFor(wrap, 'from NNW') && !tipFor(wrap, 'from NNE'), wrap.tips);
    check('south holds the remaining third', /33% of the time/.test(tipFor(wrap, 'from S (')), tipFor(wrap, 'from S ('));
    check('the speed band is named from its range', /4–6 m\/s/.test(tipFor(wrap, 'from N (')), tipFor(wrap, 'from N ('));
    check('footer gives the time covered', /3\.0 h covered/.test(wrap.footer), wrap.footer);

    // Ten samples a minute apart from the east, then the west for an hour.
    // Counting samples would make east 10 of 12; by time west is 61 of 71.
    const dense = [];
    for (let m = 0; m < 10; m++) { dense.push([m, 90]); }
    dense.push([10, 270], [70, 270]);
    const weighted = probe('pvxWindRose', [
        series('Dir', '°', dense),
        series('Speed', 'm/s', dense.map((p) => [p[0], 3]))
    ], 'MaxPairGapSeconds=0');
    all.push(weighted);
    check('shares are weighted by time, not sample count', /86% of the time/.test(tipFor(weighted, 'from W (')), tipFor(weighted, 'from W ('));
    check('...east is the minority', /14% of the time/.test(tipFor(weighted, 'from E (')), tipFor(weighted, 'from E ('));

    // Same data with a 10-minute limit: the hour before the last sample is
    // a gap, and 50 minutes of it must not be credited to the west. West is
    // then 10 min plus the last sample's median hold of 1, east 10: 11 of 21.
    const gapped = probe('pvxWindRose', [
        series('Dir', '°', dense),
        series('Speed', 'm/s', dense.map((p) => [p[0], 3]))
    ], 'MaxPairGapSeconds=600');
    all.push(gapped);
    check('a gap is not credited to the direction before it', /52% of the time/.test(tipFor(gapped, 'from W (')), tipFor(gapped, 'from W ('));
    check('...and the footer says how much was left out', /in data gaps not counted/.test(gapped.footer), gapped.footer);

    // Half the time below the calm limit: reported, not drawn.
    const calm = probe('pvxWindRose', [
        series('Dir', '°', [[0, 90], [60, 90], [120, 90], [180, 90]]),
        series('Speed', 'm/s', [[0, 0.2], [60, 0.3], [120, 4], [180, 4]])
    ], 'CalmBelow=0.5');
    all.push(calm);
    check('calm time is in the footer', /calm 50%/.test(calm.footer), calm.footer);
    check('...and the sector shares are of all the time, calm included', /50% of the time/.test(tipFor(calm, 'from E (')), tipFor(calm, 'from E ('));

    const to = probe('pvxWindRose', [
        series('Dir', '°', [[0, 0], [60, 0]]),
        series('Speed', 'm/s', [[0, 5], [60, 5]])
    ], 'DirectionIs=to');
    all.push(to);
    check('"blows to" turns a northerly round to the south', !!tipFor(to, 'toward S (') && !tipFor(to, 'toward N ('), to.tips);

    // An "I/O Timeout" in the direction for the middle hour: that hour is
    // reported, not credited to the direction before it.
    const outage = probe('pvxWindRose', [
        series('Dir', '°', [[0, 90], [60, 'I/O Timeout'], [120, 90], [180, 90]]),
        series('Speed', 'm/s', [[0, 3], [60, 3], [120, 3], [180, 3]])
    ]);
    all.push(outage);
    check('a bad value ends the hold before it', /3\.0 h covered/.test(outage.footer) && /1\.0 h of bad or unpaired values not counted/.test(outage.footer), outage.footer);
    check('...and the good time is all east', /100% of the time/.test(tipFor(outage, 'from E (')), tipFor(outage, 'from E ('));

    // Direction alone is a direction histogram, no legend bands.
    const alone = probe('pvxWindRose', [series('Dir', '°', [[0, 45], [60, 45], [120, 225]])]);
    all.push(alone);
    check('direction alone still draws', /67% of the time/.test(tipFor(alone, 'from NE (')), alone.tips);

    const errs = [].concat.apply([], all.map((r) => r.errors));
    check('no page errors', errs.length === 0, errs);
}

function bubble() {
    console.log('');
    console.log(C.bold + 'XY Scatter bubble mode' + C.reset);
    const xs = [], ys = [], zs = [];
    for (let m = 0; m < 10; m++) { xs.push([m, m]); ys.push([m, 2 * m]); }
    // The size tag starts five minutes late: five pairs have no size value.
    for (let m = 5; m < 10; m++) { zs.push([m, m * 10]); }
    const data = [series('Load', 'MW', xs), series('Flow', 't/h', ys), series('Temp', 'degC', zs)];

    const on = probe('pvxXYScatter', data, 'BubbleMode=true');
    check('the size value is in each point tooltip', on.tips.some((t) => /Temp: 90(\.0+)? degC/.test(t)), on.tips.slice(0, 3));
    check('the footer gives the size range', /size: Temp 50–90 degC/.test(on.footer), on.footer);
    check('pairs with no size value are counted', /5 without a size value/.test(on.footer), on.footer);
    check('...and not drawn', on.tips.filter((t) => /^Load:/.test(t)).length === 5, on.tips.length);

    const off = probe('pvxXYScatter', data);
    check('bubble mode off: third source ignored and said so', /1 extra source ignored/.test(off.footer), off.footer);
    check('bubble mode off: every pair drawn', off.tips.filter((t) => /^Load:/.test(t)).length === 10, off.tips.length);

    const errs = [].concat(on.errors, off.errors);
    check('no page errors', errs.length === 0, errs);
}

/** A source of values one minute apart, from minute 0. */
function evenly(label, units, vals) {
    return series(label, units, vals.map((v, i) => [i, v]));
}

function histogramByTime() {
    console.log('');
    console.log(C.bold + 'Distribution by time held' + C.reset);
    // Eleven samples of 10, a minute apart, then 20 held for an hour (its
    // successor) plus the last sample's median hold of a minute: 10 holds
    // 11 minutes of 72, 20 holds 61. By samples 10 is 11 of 13.
    const pts = [];
    for (let m = 0; m <= 10; m++) { pts.push([m, 10]); }
    pts.push([11, 20], [71, 20]);
    const data = [series('Level', '%', pts)];
    const cfg = 'Bins=2;RangeMin=10;RangeMax=20;Quantiles=50;ShowNormalCurve=false';
    const t = probe('pvxHistogram', data, cfg + ';Weighting=time');
    const bar = (lo) => t.tips.filter((x) => new RegExp('^' + lo + '(\\.0+)? – ').test(x)).join(' | ');
    check('time-held bars give each value its time', /1h 1m of 1h 12m/.test(bar('15')) && /11m of 1h 12m/.test(bar('10')), [bar('10'), bar('15')]);
    check('...and P50 is the value held half the time', t.tips.some((x) => /^P50 20(\.0+)?\b/.test(x) && /of the time/.test(x)), t.tips.filter((x) => /^P50/.test(x)));
    check('...and the footer says what is weighted', /bars weighted by time held; statistics per sample/.test(t.footer), t.footer);
    const n = probe('pvxHistogram', data, cfg);
    check('by samples P50 is the median sample', n.tips.some((x) => /^P50 10(\.0+)?\b/.test(x)), n.tips.filter((x) => /^P50/.test(x)));
    check('...and the bars count samples', /11 of 13 samples/.test(n.tips.join(' | ')), n.tips.slice(0, 3));
    const errs = [].concat(t.errors, n.errors);
    check('no page errors', errs.length === 0, errs);
}

function sankeyFixed() {
    console.log('');
    console.log(C.bold + 'Flow with a fixed link' + C.reset);
    const links = 'Feed > Reactor : 1 | Reactor > Product : 2 | Reactor > Losses : =4.5 | X > Y : =abc';
    const r = probe('pvxSankey', null, 'Links=' + links);
    const fixed = r.tips.filter((t) => t.indexOf('Reactor → Losses') === 0).join(' | ');
    check('a fixed link draws with its typed value', /— 4\.50?\b/.test(fixed), fixed);
    check('...and its tooltip says it is not measured', /typed in Links, not measured/.test(fixed), fixed);
    check('...and the footer counts it', /1 fixed flow, not measured/.test(r.footer), r.footer);
    check('a fixed value that is not a number is malformed, not zero', /Malformed link: X > Y/.test(r.footer), r.footer);
    check('no page errors', r.errors.length === 0, r.errors);
}

function boxByTime() {
    console.log('');
    console.log(C.bold + 'Variability by time' + C.reset);
    // Hour 0 holds 1..5 (median 3), hour 1 holds 10..50 (median 30), hour 2
    // holds 7 alone. The setpoint is 5 then 7 in hour 0 (mean 6), 20 in hour
    // 1, and records nothing in hour 2, so it carries 20 forward.
    const w = series('Weight', 'g', [[0, 1], [10, 2], [20, 3], [30, 4], [40, 5],
        [60, 10], [70, 20], [80, 30], [90, 40], [100, 50], [130, 7]]);
    const sp = series('Setpoint', 'g', [[0, 5], [30, 7], [60, 20]]);
    const r = probe('pvxBoxPlot', [w, sp], 'GroupBy=hour;GroupSource=1;OverlaySource=2;OverlayLabel=SP');
    const box = (h) => r.tips.filter((t) => t.indexOf('Weight · ') === 0 && t.indexOf(h + ' to ') !== -1).join(' | ');
    check('one box per hour, named by its hour', /00:00 to 01:00/.test(box('00:00')) && /01:00 to 02:00/.test(box('01:00')), r.tips.slice(0, 3));
    check('...holding that hour\'s values', /n = 5/.test(box('00:00')) && /median 3(\.0+)? g/.test(box('00:00')) && /median 30(\.0+)? g/.test(box('01:00')), [box('00:00'), box('01:00')]);
    check('an hour with one value is a tick, not a box', /n = 1\b/.test(box('02:00')), box('02:00'));
    const ov = r.tips.filter((t) => t.indexOf('SP\n') === 0).join('');
    check('the overlay is the mean of the source in each hour', /00:00: 6(\.0+)?\b/.test(ov) && /01:00: 20(\.0+)?\b/.test(ov), ov);
    check('...and carries the last value into an hour with none', /02:00: 20(\.0+)?\b/.test(ov), ov);
    check('the footer counts boxes', /3 boxes/.test(r.footer), r.footer);

    const flat = probe('pvxBoxPlot', [w, sp], 'OverlaySource=2');
    check('by source, the overlay source is not a box', flat.tips.every((t) => !(t.indexOf('Setpoint') === 0 && /n = /.test(t))), flat.tips.map((t) => t.split('\n')[0]));
    check('...and the footer says where it went', /source 2 drawn as the overlay line/.test(flat.footer), flat.footer);
    const typed = probe('pvxBoxPlot', [w], 'OverlayValue=12.5;OverlayLabel=Limit');
    check('a typed overlay draws as one line', typed.tips.some((t) => /^Limit\n12\.5/.test(t)), typed.tips.filter((t) => /^Limit/.test(t)));

    const errs = [].concat(r.errors, flat.errors, typed.errors);
    check('no page errors', errs.length === 0, errs);
}

function controlChart() {
    console.log('');
    console.log(C.bold + 'Control Chart' + C.reset);
    const all = [];
    const v = [10, 12, 9, 11, 10, 8, 12, 11, 9, 11];

    // Mean 10.3; moving ranges sum to 19 over 9, so sigma = 2.1111 / 1.128
    // = 1.8716 and the limits sit 5.6147 either side.
    const imr = probe('pvxControlChart', [evenly('Weight', 'g', v)], 'SampleMode=recorded;Decimals=3');
    all.push(imr);
    check('I-MR centre line is the mean', /CL 10\.300/.test(imr.text), imr.text.slice(0, 80));
    check('I-MR limits use the average moving range / d2', /UCL 15\.915/.test(imr.text) && /LCL 4\.685/.test(imr.text), imr.text.slice(0, 80));
    check('...and the footer gives that sigma', /σ 1\.872/.test(imr.footer), imr.footer);
    check('a stable window breaks no rule', /No rule broken over 10 points/.test(imr.footer), imr.footer);

    // Subgroups of 2: means 11, 10, 9, 11.5 (centre 10.375); ranges average
    // 1.75, sigma 1.75 / 1.128 = 1.5514, limits 3 x 1.5514 / sqrt 2 = 3.2911.
    const xbar = probe('pvxControlChart', [evenly('Weight', 'g', [10, 12, 9, 11, 10, 8, 12, 11])],
        'SampleMode=recorded;Decimals=3;ChartType=xbarr;SubgroupSize=2');
    all.push(xbar);
    check('X-bar R centre is the mean of subgroup means', /CL 10\.375/.test(xbar.text), xbar.text.slice(0, 80));
    check('X-bar R limits use R-bar / d2 over root n', /UCL 13\.666/.test(xbar.text) && /LCL 7\.084/.test(xbar.text), xbar.text.slice(0, 80));
    check('...and the footer names the subgroup size', /X̄-R n=2/.test(xbar.footer), xbar.footer);

    // Fixed limits 10 +- 3 (sigma 1). Points 2..10 sit above 10, nine in a
    // row (rule 2 at the ninth); the last is past the UCL (rule 1). Its jump
    // of 2.4 is inside the MR limit the typed sigma implies (3.69); the
    // window's own ranges, about 0.6, would have flagged it as well.
    const run = [9, 10.5, 11, 11.5, 11, 11.2, 11.4, 11.1, 11.3, 11.6, 14];
    const fixed = probe('pvxControlChart', [evenly('Weight', 'g', run)],
        'SampleMode=recorded;Decimals=1;LimitSource=fixed;FixedCenter=10;FixedUCL=13;FixedLCL=7');
    all.push(fixed);
    const last = fixed.tips.filter((t) => /Value: 14\.0/.test(t)).join(' | ');
    check('a point past a fixed limit is rule 1', /Rule 1: a point beyond the control limits/.test(last), last);
    check('...a ninth point on one side is rule 2, with its length', /Rule 2: 9 points in a row/.test(fixed.tips.join(' | ')), fixed.tips);
    check('...the footer says the limits were fixed', /fixed limits/.test(fixed.footer), fixed.footer);
    const only1 = probe('pvxControlChart', [evenly('Weight', 'g', run)],
        'SampleMode=recorded;LimitSource=fixed;FixedCenter=10;FixedUCL=13;FixedLCL=7;RuleSet=limits');
    all.push(only1);
    check('limits only: one point, counted in the singular', /1 point breaks a rule: 1× rule 1/.test(only1.footer), only1.footer);

    // Centre and UCL from sources 3 and 2, LCL mirrored. Source 2 moves from
    // 12 to 13: the latest value is the limit.
    const fromSrc = probe('pvxControlChart', [
        evenly('Weight', 'g', v),
        series('UCL', 'g', [[0, 12], [9, 13]]),
        series('CL', 'g', [[0, 10], [9, 10]])
    ], 'SampleMode=recorded;Decimals=1;LimitSource=sources;CenterSource=3;UclSource=2;LclSource=0');
    all.push(fromSrc);
    check('limits from sources use the latest value', /UCL 13\.0/.test(fromSrc.text) && /CL 10\.0/.test(fromSrc.text), fromSrc.text.slice(0, 80));
    check('...a missing LCL mirrors the UCL', /LCL 7\.0/.test(fromSrc.text), fromSrc.text.slice(0, 80));
    check('...and the footer says where they came from', /limits from data sources/.test(fromSrc.footer), fromSrc.footer);

    // Spec from a source overrides the typed one: USL 13 from source 2,
    // typed 99. Cpk = (13 - 10.3) / (3 x 1.8716) = 0.48.
    const spec = probe('pvxControlChart', [
        evenly('Weight', 'g', v),
        series('USL', 'g', [[0, 13], [9, 13]])
    ], 'SampleMode=recorded;USL=99;UslSource=2');
    all.push(spec);
    check('a spec limit from a source overrides the typed one', /Cpk 0\.48/.test(spec.footer), spec.footer);
    check('...and the footer says so', /spec from data sources/.test(spec.footer), spec.footer);

    // A custom trend length of 4: four rising points are flagged, and the
    // tooltip names four, not the default six.
    const trend = probe('pvxControlChart', [evenly('Weight', 'g', [10, 9, 10, 11, 12, 10, 9, 10])],
        'SampleMode=recorded;LimitSource=fixed;FixedCenter=10;FixedUCL=16;FixedLCL=4;RuleSet=custom;CustomRules=3;TrendLength=4');
    all.push(trend);
    check('a custom trend length is applied and named', /Rule 3: 4 points steadily rising or falling/.test(trend.tips.join(' | ')), trend.tips);
    check('...and flags only the end of the run', /1 point breaks a rule: 1× rule 3/.test(trend.footer), trend.footer);

    const errs = [].concat.apply([], all.map((r) => r.errors));
    check('no page errors', errs.length === 0, errs);
}

/** The Gas Triangle's own rules and outlines, loaded from src/ without a browser. */
function loadGasTriangle() {
    const vm = require('vm');
    let def = null;
    const win = {
        PIVisualization: {
            deriveVisualizationFromBase: function () {},
            Extensibility: { Enums: { DatasourceBehaviors: { Multiple: 'Multiple' } } }
        },
        PVX: { register: function (pv, d) { def = d; } }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'symbols', 'pvxGasTriangle', 'symbol.js'), 'utf8'), { window: win });
    return def.visObjectType;
}

function inPolygon(pt, poly) {
    // Ternary to a plane: x = C2H4 + CH4/2, y = CH4. Insideness survives the
    // shear, so this is enough to test against.
    const X = (p) => p[1] + p[0] / 2, Y = (p) => p[0];
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = X(poly[i]), yi = Y(poly[i]), xj = X(poly[j]), yj = Y(poly[j]);
        if ((yi > Y(pt)) !== (yj > Y(pt)) && X(pt) < (xj - xi) * (Y(pt) - yi) / (yj - yi) + xi) { inside = !inside; }
    }
    return inside;
}

function kpiCard() {
    console.log('');
    console.log(C.bold + 'KPI card' + C.reset);
    // 10, 10, 40 an hour apart, then a bad value. By trapezoid: 2100
    // value-minutes over 120 minutes, so a time-weighted average of 17.5,
    // where the samples average 20; a total of 35 for a rate per hour.
    const pts = [[0, 10], [60, 10], [120, 40], [180, 'Bad Input']];
    const kpi = (cfg) => probe('pvxKpiCard', [series('Feed', 't/h', pts)], 'ShowLabel=false;' + cfg);
    const tw = kpi('Statistic=twavg;Decimals=2');
    check('time-weighted average', /17\.50/.test(tw.text), tw.text.slice(0, 40));
    const av = kpi('Statistic=avg;Decimals=2');
    check('...where the samples average 20', /20\.00/.test(av.text), av.text.slice(0, 40));
    const tot = kpi('Statistic=total;TotalPer=h;Decimals=1');
    check('total over time integrates the rate, in t', /35\.0\s*t\b/.test(tot.text) && !/t\/h/.test(tot.text.slice(0, 20)), tot.text.slice(0, 40));
    const sd = kpi('Statistic=stdev;Decimals=2');
    check('standard deviation', /17\.32/.test(sd.text), sd.text.slice(0, 40));
    const pg = kpi('Statistic=pctgood;Decimals=0');
    check('percent good counts the bad sample', /75\s*% good/.test(pg.text), pg.text.slice(0, 40));
    const on = kpi('Statistic=avg;PlanFrom=fixed;TargetValue=21;DeltaBasis=plan;TargetTolerance=5%');
    check('within the tolerance reads On target', /On target/.test(on.text), on.text.slice(0, 60));
    const off = kpi('Statistic=avg;PlanFrom=fixed;TargetValue=21;DeltaBasis=plan;TargetTolerance=0.5');
    check('...outside it the change is shown', /-4\.8% vs plan/.test(off.text) && !/On target/.test(off.text), off.text.slice(0, 60));
    const prog = kpi('Statistic=avg;PlanFrom=fixed;TargetValue=40;ProgressStyle=bar');
    check('progress is the share of the target', /\b50%/.test(prog.text), prog.text.slice(0, 60));
    const none = kpi('PlanFrom=fixed;ProgressStyle=ring');
    check('progress with no target says so', /No target value set/.test(none.text), none.text.slice(0, 80));
    const errs = [].concat(tw.errors, tot.errors, sd.errors, pg.errors, on.errors, prog.errors, none.errors);
    check('no page errors', errs.length === 0, errs);
}

function multiGauge() {
    console.log('');
    console.log(C.bold + 'Multi-pointer gauge' + C.reset);
    const file = path.join(os.tmpdir(), 'pvx-charts-' + process.pid + '-mg.json');
    const row = (label, v) => ({ Label: label, Units: '°C', Path: '\\\\AF\\Pump|' + label, IsGood: true, Value: v, Summary: [{ Value: v }] });
    fs.writeFileSync(file, JSON.stringify({ Rows: [row('Bearing 1', 62), row('Bearing 2', 'Comm Fail'), row('Bearing 3', 140), row('Bearing 4', 40)] }));
    const run = (cfg) => {
        const args = [path.join(__dirname, 'probe.js'), 'pvxMultiGauge', '--w', '320', '--h', '320', '--json', '--payload', file,
            '--out', file.replace(/\.json$/, '.png'), '--config', cfg];
        let out;
        try { out = execFileSync(process.execPath, args, { encoding: 'utf8' }); } catch (e) { out = e.stdout || ''; }
        const json = JSON.parse(out.slice(out.indexOf('{')));
        const r = json.report || {};
        return { tips: r.tips || [], footer: r.footer || '', text: r.text || '', errors: (json.errors || []).concat(r.fatal ? [r.fatal] : []) };
    };
    const g = run('MinValue=0;MaxValue=100;MaxPointers=3');
    check('a value that is not a number has no pointer, and the footer says so', /1 not numeric, no pointer/.test(g.footer), g.footer);
    check('a value off the scale is pinned and named', /1 outside the scale, pinned to the end/.test(g.footer) && g.tips.some((t) => /Bearing 3: 140.*outside the scale/.test(t)), [g.footer, g.tips]);
    check('sources past the limit are counted', /1 more sources not shown/.test(g.footer), g.footer);
    check('the readout names each value', /Bearing 1\s*62(\.0+)?\s*°C/.test(g.text) && /Comm Fail/.test(g.text), g.text.slice(0, 120));
    check('one pointer per numeric source', g.tips.filter((t) => /^Bearing/.test(t)).length === 2, g.tips);
    const a = run('ScaleMode=auto;Shape=linear;PointerStyle=bar');
    check('a scale from the values takes them all in, and says so', /scale 20 to 160 from the values/.test(a.footer) && !/outside the scale/.test(a.footer), a.footer);
    check('no page errors', g.errors.concat(a.errors).length === 0, g.errors.concat(a.errors));
}

function periodChange() {
    console.log('');
    console.log(C.bold + 'Period comparison' + C.reset);
    // Three days folded by day: 10 all day, then 20, then 30 until noon.
    // The median of the older two is 15, so today is +15 (+100%); against
    // the day before it is +10 (+50%). The older days sit at -5 and +5.
    const pts = [];
    for (let h = 0; h < 60; h++) { pts.push([h * 60, h < 24 ? 10 : h < 48 ? 20 : 30]); }
    const run = (cfg, extra) => probe('pvxPeriodOverlay', [series('Feed', 't/h', pts)].concat(extra || []),
        'PeriodMode=day;AlignTo=clock;Decimals=1;' + cfg);
    const med = run('ShowAs=delta;Baseline=median');
    check('change from the median: today departs the older days by 10', /Max departure\s*\+10\.0 t\/h/.test(med.text), med.text.slice(0, 200));
    check('...and the footer names the baseline', /change from the median of the older periods/.test(med.footer), med.footer);
    const pct = run('ShowAs=pctdelta;Baseline=median');
    check('% change: today is 100% over a baseline the older days are 33% either side of', /Max departure\s*\+66\.7 %/.test(pct.text), pct.text.slice(0, 200));
    const prev = run('ShowAs=delta;Baseline=previous');
    check('change from the period before', /change from the period before/.test(prev.footer), prev.footer);
    check('...the axis says change, in the units', /Change \(t\/h\)/.test(prev.text), prev.text.slice(0, 200));
    const two = run('ShowAs=pctdelta', [series('Feed B', 'kg/s', pts.map((p) => [p[0], p[1] * 2]))]);
    check('a second source is drawn and named in the legend', /Feed B/.test(two.text) && /Feed, /.test(two.text), two.text.slice(0, 200));
    // Daily samples across September and October folded by calendar month:
    // the current period is October, named by month, on a day-of-month axis.
    const days = [];
    for (let d = 0; d < 50; d++) { days.push([(-38 + d) * 1440, 5 + (d % 7)]); }
    const mon = probe('pvxPeriodOverlay', [series('Feed', 't/h', days)], 'PeriodMode=month;LegendLabels=date;ColorMode=palette');
    check('a calendar-month fold names its periods by month', /Oct 2026/.test(mon.text) && /Sep 2026/.test(mon.text), mon.text.slice(0, 200));
    check('...on a day-of-month axis', /Day of month/.test(mon.text) && /day 1(?!\d)/.test(mon.text), mon.text.slice(0, 300));
    const errs = [].concat(med.errors, pct.errors, prev.errors, two.errors, mon.errors);
    check('no page errors', errs.length === 0, errs);
}

function gasTriangle() {
    console.log('');
    console.log(C.bold + 'Gas triangle' + C.reset);
    const vis = loadGasTriangle();
    const classify = vis.classify, ZONES = vis.ZONES;

    // Every point of a 0.5% grid, offset so none sits on a boundary: the
    // outline that contains it must be the zone the rules give, and exactly
    // one outline may contain it.
    let bad = [], n = 0;
    for (let a = 0.2; a < 100; a += 0.5) {
        for (let b = 0.15; a + b < 100; b += 0.5) {
            const c = 100 - a - b, pt = [a, b, c];
            const holders = ZONES.filter((z) => inPolygon(pt, z.pts)).map((z) => z.code);
            n++;
            if (holders.length !== 1 || holders[0] !== classify(a, b, c)) {
                if (bad.length < 5) { bad.push(pt.map((v) => v.toFixed(2)).join('/') + ' drawn ' + holders.join('+') + ' rule ' + classify(a, b, c)); }
                else { bad.push(''); }
            }
        }
    }
    check('outlines and rules agree at all ' + n + ' grid points', bad.length === 0, bad.slice(0, 5));
    check('each zone code sits inside its own zone',
        ZONES.every((z) => !z.label || classify(z.label[0], z.label[1], z.label[2]) === z.code),
        ZONES.filter((z) => z.label && classify(z.label[0], z.label[1], z.label[2]) !== z.code).map((z) => z.code));

    // Boundaries as IEC 60599 tabulates them for Triangle 1.
    const cases = [
        [[98, 1, 1], 'PD'], [[97.9, 1.1, 1], 'T1'],
        [[85, 12, 3], 'T1'], [[70, 26, 4], 'DT'], [[70, 27, 3], 'T2'],
        [[40, 51, 9], 'T3'], [[30, 50, 20], 'DT'], [[30, 55, 15], 'DT'],
        [[60, 22, 18], 'D1'], [[60, 23, 17], 'D2'], [[40, 40, 20], 'DT'], [[35, 39, 26], 'D2'],
        [[20, 50, 30], 'D2'], [[50, 45, 5], 'DT'], [[51, 49, 0], 'T2'], [[48, 50, 2], 'T3']
    ];
    const wrong = cases.filter((x) => classify(x[0][0], x[0][1], x[0][2]) !== x[1])
        .map((x) => x[0].join('/') + ' gave ' + classify(x[0][0], x[0][1], x[0][2]) + ', want ' + x[1]);
    check('IEC 60599 boundary cases (' + cases.length + ')', wrong.length === 0, wrong);

    // Sources named in reverse order: acetylene, ethylene, methane. 50/30/20
    // ppm of CH4/C2H4/C2H2 is 50%/30%/20%: C2H2 >= 13 and C2H4 in 23..40, D2.
    const named = probe('pvxGasTriangle', [
        series('T-1 Acetylene', 'ppm', [[0, 2], [60, 20]]),
        series('T-1 Ethylene', 'ppm', [[0, 40], [60, 30]]),
        series('T-1 Methane', 'ppm', [[0, 58], [60, 50]]),
        series('T-1 Hydrogen', 'ppm', [[0, 10], [60, 10]])
    ]);
    check('gases matched by name in any order', /^D2 · Discharges of high energy/.test(named.footer), named.footer);
    check('...the footer gives the shares', /CH4 50% · C2H4 30% · C2H2 20%/.test(named.footer), named.footer);
    check('...and counts the extra source', /1 extra source ignored/.test(named.footer), named.footer);
    check('...and does not claim the order was assumed', !/gases by order/.test(named.footer), named.footer);
    check('the point tooltip has ppm, share and zone', named.tips.some((t) => /CH4: 50(\.0+)? ppm \(50\.0%\)/.test(t) && /D2: Discharges of high energy/.test(t)), named.tips.filter((t) => /ppm/.test(t)));
    check('the trail has a point per instant', named.tips.filter((t) => /ppm/.test(t)).length === 2, named.tips.length);

    const unnamed = probe('pvxGasTriangle', [
        series('A', 'ppm', [[0, 90]]), series('B', 'ppm', [[0, 10]]), series('C', 'ppm', [[0, 0]])
    ]);
    check('unnamed sources are taken in order, and the footer says so', /^T1 · /.test(unnamed.footer) && /gases by order/.test(unnamed.footer), unnamed.footer);

    const low = probe('pvxGasTriangle', [
        series('Methane', 'ppm', [[0, 5]]), series('Ethylene', 'ppm', [[0, 3]]), series('Acetylene', 'ppm', [[0, 2]])
    ], 'MinTotalPpm=50');
    check('below the minimum total the zone is not named', /Below 50 ppm: zone not named/.test(low.footer) && !/D2 · /.test(low.footer), low.footer);

    const dirty = probe('pvxGasTriangle', [
        series('Methane', 'ppm', [[0, 50], [60, -3], [120, 'Calc Failed'], [180, 50]]),
        series('Ethylene', 'ppm', [[0, 30]]), series('Acetylene', 'ppm', [[0, 20]])
    ]);
    check('a negative reading is counted, not plotted', /1 with a negative ppm not plotted/.test(dirty.footer), dirty.footer);
    check('a non-numeric reading is counted, not plotted', /1 bad or non-numeric not plotted/.test(dirty.footer), dirty.footer);
    check('...and the good points still plot', dirty.tips.filter((t) => /ppm/.test(t)).length === 2, dirty.tips.length);

    const errs = [].concat(named.errors, unnamed.errors, low.errors, dirty.errors);
    check('no page errors', errs.length === 0, errs);
}

(() => {
    try {
        windRose();
        bubble();
        histogramByTime();
        sankeyFixed();
        boxByTime();
        controlChart();
        gasTriangle();
        kpiCard();
        multiGauge();
        periodChange();
    } catch (e) {
        failures += 1;
        console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + (e.stack || e.message));
    }
    console.log('');
    if (failures) {
        console.log(C.red + C.bold + failures + ' failed' + C.reset + C.dim + ', ' + passes + ' passed' + C.reset);
        process.exit(1);
    }
    console.log(C.green + C.bold + 'All ' + passes + ' chart checks passed' + C.reset);
})();
