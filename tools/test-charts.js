#!/usr/bin/env node
/* ============================================================================
 * PVX charts test — Wind Rose, XY bubble, Variability by time, Control Chart, Gas
 * Triangle, Target & Forecast, Rate of Change and more, against
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
 *               of the target; the change against the range's average and
 *               a typed caption in place of "vs plan".
 *   period cmp  change from the median of the older periods and from the
 *               period before, absolute and percent, against hand figures;
 *               a calendar-month fold names its periods by month; a second
 *               source draws its own current period.
 *   sparkline   sources in pairs put the second beside the first, and an
 *               unpaired last source says so; a statistic of the row's own
 *               trend; headings worked out from the range and the attribute
 *               names, or typed; none of it by default.
 *   multi gauge a value that is not a number gets no pointer, a value off
 *               the scale is pinned and named, and sources past the limit
 *               are counted; the readout names each value.
 *   combo chart  moving averages by count and by time, log ends and ticks,
 *               a fit's slope per hour, state bands' runs, a range with no
 *               next source, values a log scale leaves out, panels that fall
 *               back to one plot; two clicks place the rulers and the table
 *               gives the trace's value at both, the change, a time-weighted
 *               average halfway along a ramp, and its slope.
 *   target &   actual and target now pair the step in force, not the next;
 *   forecast   the gap and its share of target; the forecast's end against
 *               the target then, and the crossing when a step jumps over
 *               it; the forecast error over actual samples inside it; roles
 *               picked out of order give the same answers; tolerance in
 *               units and percent; sources with no role, half a range and
 *               text values are said; look-ahead says what it needs.
 *   rate of chg  a ramp sampled unevenly reads its one slope by window, fit
 *               and samples, per minute and per hour; a climb passes a
 *               rise limit for its length between samples, and for less
 *               through a window, which peaks at the climb's end (trailing)
 *               or middle (centered); a fall limit is typed positive; no
 *               rate across a bad value or a gap past the limit, and both
 *               are counted; the last value holds to the end of the range;
 *               a new time range is charted in full, a range that misses
 *               the values gives way to them, and a week-long range still
 *               catches a ten-minute climb.
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
function probe(typeName, data, config, clicks, payload2) {
    const file = path.join(os.tmpdir(), 'pvx-charts-' + process.pid + '-' + (seq++) + '.json');
    fs.writeFileSync(file, JSON.stringify({ Data: data }));
    // data null: the probe's own mock, for shapes (Table) built from it.
    const args = [path.join(__dirname, 'probe.js'), typeName, '--w', '520', '--h', '340', '--json',
        '--out', file.replace(/\.json$/, '.png')].concat(data === null ? ['--count', '3'] : ['--payload', file]);
    if (config) { args.push('--config', config); }
    if (clicks) { args.push('--clicks', clicks); }
    if (payload2) { args.push('--payload2', payload2); }
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
    return { tips: r.tips || [], footer: r.footer || '', text: r.text || '', labels: r.labels || [], rows: r.rows || [], errors: (json.errors || []).concat(r.fatal ? [r.fatal] : []) };
}

/** probe() with a second update of its own: the display's time range changed. */
function probe2(typeName, data, data2, config) {
    const file2 = path.join(os.tmpdir(), 'pvx-charts-' + process.pid + '-' + (seq++) + '-2.json');
    fs.writeFileSync(file2, JSON.stringify({ Data: data2 }));
    return probe(typeName, data, config, null, file2);
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
    const avgD = kpi('DeltaBasis=average;DeltaMode=absolute;Decimals=1');
    check('compared with the range\'s time-weighted average: 40 against 17.5', /\+22\.5 vs average/.test(avgD.text), avgD.text.slice(0, 60));
    const cap = kpi('DeltaBasis=average;DeltaMode=absolute;Decimals=1;DeltaCaption=vs 7-day avg');
    check('...with a typed caption in its place', /\+22\.5 vs 7-day avg/.test(cap.text) && !/vs average/.test(cap.text), cap.text.slice(0, 60));
    const wk = kpi('DeltaBasis=window;DeltaLookback=1;DeltaMode=absolute;Decimals=1;DeltaCaption=vs last week');
    check('earlier in the range, over the full range: from the first value, captioned', /\+30\.0 vs last week/.test(wk.text), wk.text.slice(0, 60));
    const bare = kpi('DeltaMode=absolute;Decimals=1');
    check('by default the change has no caption', !/ vs /.test(bare.text), bare.text.slice(0, 60));
    const errs = [].concat(tw.errors, tot.errors, sd.errors, pg.errors, on.errors, prog.errors, none.errors,
        avgD.errors, cap.errors, wk.errors, bare.errors);
    check('no page errors', errs.length === 0, errs);
}

function multiSparkline() {
    console.log('');
    console.log(C.bold + 'Multi Sparkline, second value and headings' + C.reset);
    const all = [];
    const ranged = (label, units, pts) => Object.assign(series(label, units, pts), {
        StartTime: new Date(T0).toISOString(), EndTime: new Date(T0 + 120 * MIN).toISOString()
    });
    // Sources in pairs: each pump's flow, then its power. The fifth
    // has no partner.
    const data = [
        ranged('P1|Flow', 'm3/h', [[0, 10], [60, 11], [120, 12]]), ranged('P1|Power', 'kW', [[0, 0.4], [120, 0.5]]),
        ranged('P2|Flow', 'm3/h', [[0, 30], [60, 28], [120, 25]]), ranged('P2|Power', 'kW', [[0, 0.8], [120, 0.9]]),
        ranged('P3|Flow', 'm3/h', [[0, 3], [120, 3.5]])
    ];
    const pairs = probe('pvxSparkline', data, 'Decimals=1;SecondValue=source;ShowColumnHeaders=true');
    all.push(pairs);
    const rowTips = pairs.tips.filter((t) => /: .*\n/.test(t));
    check('sources in pairs: three rows, the second of each pair beside the first',
        rowTips.length === 3 && rowTips[0] === 'P1|Flow: 12.0 m3/h\nP1|Power: 0.5 kW' && rowTips[1] === 'P2|Flow: 25.0 m3/h\nP2|Power: 0.9 kW', rowTips);
    check('...and a source with no partner says so', rowTips[2] === 'P3|Flow: 3.5 m3/h\nNo paired data source', rowTips[2]);
    check('headings worked out: the time range over the trend, the shared attribute names over the values',
        /Last 2 h/.test(pairs.text) && /Flow/.test(pairs.text.replace(/P\d\|Flow/g, '')) && /Power/.test(pairs.text.replace(/P\d\|Power/g, '')), pairs.text);
    const typed = probe('pvxSparkline', data, 'SecondValue=source;ShowColumnHeaders=true;NameHeader=Pump;TrendHeader=Trend;ValueHeader=Rate;SecondHeader=Load');
    all.push(typed);
    check('typed headings are used as typed', ['Pump', 'Trend', 'Rate', 'Load'].every((h) => typed.text.indexOf(h) !== -1) &&
        !/Last 2 h/.test(typed.text), typed.text);

    const one = [ranged('Flow', 't/h', [[0, 1], [60, 9], [120, 4]])];
    const mx = probe('pvxSparkline', one, 'Decimals=1;SecondValue=max');
    const ch = probe('pvxSparkline', one, 'Decimals=1;SecondValue=change;ShowColumnHeaders=true');
    all.push(mx, ch);
    check('a statistic of the row\'s own trend: the maximum', mx.tips.some((t) => t === 'Flow: 4.0 t/h\nMax: 9.0 t/h'), mx.tips);
    check('...the change over the range, signed, headed by its name', ch.tips.some((t) => t === 'Flow: 4.0 t/h\nChange: +3.0 t/h') &&
        /Change/.test(ch.text), [ch.tips, ch.text]);
    const plain = probe('pvxSparkline', data, 'Decimals=1');
    all.push(plain);
    check('by default: one row per source, no second column, no headings',
        plain.tips.filter((t) => /^P\d\|\w+: /.test(t)).length === 5 && !plain.tips.some((t) => /: .*\n/.test(t)) && !/Last 2 h/.test(plain.text),
        plain.tips);
    const errs = [].concat.apply([], all.map((r) => r.errors));
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

function loadSymbol(name) {
    const vm = require('vm');
    let def = null;
    const win = {
        PIVisualization: {
            deriveVisualizationFromBase: function () {},
            Extensibility: { Enums: { DatasourceBehaviors: { Multiple: 'Multiple' } } }
        },
        PVX: { register: function (pv, d) { def = d; } }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'symbols', name, 'symbol.js'), 'utf8'), { window: win });
    return def.visObjectType;
}

function loadCore() {
    const vm = require('vm');
    const win = { navigator: { userAgent: '' }, location: { href: 'http://x/', hash: '' } };
    win.window = win;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'pvx-core.js'), 'utf8'),
        { window: win, document: {}, navigator: win.navigator, setTimeout, clearTimeout, console });
    return win.PVX;
}

function crossProfile() {
    console.log('');
    console.log(C.bold + 'Cross profile: order, map, 2-sigma' + C.reset);
    const vis = loadSymbol('pvxCrossProfile');
    const o = vis.order(['Gauge 10', 'Gauge 9', 'Edge', 'Gauge 1.5'], 'number');
    check('by number: 1.5, 9, 10, then the name with none', o.order.join() === '3,1,0,2' && o.unnumbered === 1, o);
    check('as listed: unchanged', vis.order(['b', 'a'], 'source').order.join() === '0,1');

    // Three positions, four intervals of 10 over 0..40.
    const cols = [
        { points: [{ t: 1, v: 10 }, { t: 3, v: 20 }, { t: 25, v: 30 }] },
        { points: [{ t: -5, v: 7 }, { t: 35, v: 9 }] },
        { points: [{ t: 2, v: 'I/O Timeout' }] }
    ];
    const g = vis.grid(cols, 4, 0, 40);
    check('a cell is the average of its interval', g.cells[0][0] === 15 && g.cells[2][0] === 30, g.cells);
    check('an empty interval holds the last value, from before the range too',
        g.cells[1][0] === 15 && g.cells[0][1] === 7 && g.cells[3][1] === 9, g.cells.map((r) => r.join('/')));
    check('a position with no numbers is a blank column, named, its text counted out',
        g.empty.join() === '2' && g.cells[0][2] === null && g.excluded === 1, g);
    const sm = vis.summary(vis.grid([{ points: [{ t: 0, v: 1 }] }, { points: [{ t: 0, v: 3 }] }, { points: [{ t: 0, v: 5 }] }], 2, 0, 10));
    check('2-sigma across the current profile', sm.cd && sm.cd.mean === 3 && sm.cd.sd === 2, sm.cd);
    check('a position that never moves has no spread along time', sm.mdSd === 0, sm.mdSd);

    const run = probe('pvxCrossProfile', null);
    check('the mock sheet: both 2-sigma figures in the footer', /Across, now: 2σ/.test(run.footer) && /Along, each position: 2σ/.test(run.footer), run.footer);
    check('a tooltip per position, with its spread', run.tips.some((t) => /^CD Gauge 1 Basis Weight: now .*2 sigma over time$/.test(t)), run.tips.slice(0, 2));
    check('no page errors', run.errors.length === 0, run.errors);
}

function spectrum() {
    console.log('');
    console.log(C.bold + 'Spectrum: FFT, peaks, bands' + C.reset);
    const S = loadCore().stats;
    const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);
    // 8 h of uneven samples: 4 at a 20 min period (on a bin), 1.5 at 7 min.
    const pts = [];
    for (let t = 0, k = 0; t <= 8 * 3600000; t += 10000 + (k++ % 7) * 1000) {
        pts.push({ t: t, v: 50 + 4 * Math.sin(2 * Math.PI * t / 1200000) + 1.5 * Math.sin(2 * Math.PI * t / 420000) });
    }
    const r = S.spectrum(pts, { n: 1024 });
    const pk = S.spectrumPeaks(r.freq, r.amp, 2);
    check('the 20 minute cycle is found, at its amplitude in the tag\'s units',
        pk.length === 2 && near(1 / pk[0].freq, 1200, 1) && near(pk[0].amp, 4, 0.02), pk);
    check('...and the 7 minute one, between bins, close to its amplitude',
        near(1 / pk[1].freq, 420, 2) && pk[1].amp > 1.35 && pk[1].amp < 1.55, pk[1]);
    check('the level is removed, not shown as a cycle', r.amp[0] < 0.05, r.amp[0]);
    const rect = S.spectrum(pts, { n: 1024, window: 'rect' });
    check('without a window the on-bin cycle still reads true', near(S.spectrumPeaks(rect.freq, rect.amp, 1)[0].amp, 4, 0.02));
    const withText = pts.slice(0, 50).concat([{ t: 9e9, v: 'Shutdown' }]);
    check('values that are not numbers are counted out', S.spectrum(withText, {}).excluded === 1);
    check('a size is rounded up to a power of two', S.spectrum(pts, { n: 600 }).n === 1024);
    check('fewer than four values: no spectrum', S.spectrum(pts.slice(0, 3), {}) === null);
    const re = [1, 0, 0, 0, 0, 0, 0, 0], im = [0, 0, 0, 0, 0, 0, 0, 0];
    S.fft(re, im);
    check('an impulse transforms to a flat spectrum', re.every((v) => near(v, 1)) && im.every((v) => near(v, 0)));

    const vis = loadSymbol('pvxSpectrum');
    const b = vis.parseBands('2..4 : 1.5 : Loop hunting\n0.5-1, 1 to 2::Free, 5..3, junk');
    check('bands: low..high : limit : label, with - or to', b.bands.length === 3 && b.bands[0].limit === 1.5 &&
        b.bands[0].label === 'Loop hunting' && b.bands[1].limit === null && b.bands[2].label === 'Free', b);
    check('bands it cannot read are kept for the footer', b.bad.join('|') === '5..3|junk', b.bad);
    check('periods read in a sensible unit', vis.periodText(1200) === '20.0 min' && vis.periodText(30) === '30.0 s' &&
        vis.periodText(14400) === '4.00 h');

    const def = probe('pvxSpectrum', null);
    check('the mock loop: a peak labelled 20 minutes, and the grid said in the footer',
        def.text.indexOf('20.0 min') !== -1 && /resampled to 1024/.test(def.footer), def.footer);
    const over = probe('pvxSpectrum', null, 'Bands=0.03..0.07 : 3 : Loop hunting, 0.12..0.16 : 2 : Recycle, bad');
    check('a band over its limit is named in the footer, one under it is not',
        /Over limit: Loop hunting 3\.9\d > 3/.test(over.footer) && !/Recycle \d/.test(over.footer), over.footer);
    check('...and a band it cannot read is named', /Band not read: bad/.test(over.footer), over.footer);
    const errs = [].concat(def.errors, over.errors);
    check('no page errors', errs.length === 0, errs);
}

function xyUpgrades() {
    console.log('');
    console.log(C.bold + 'XY Scatter: several Y, gate, polynomial, polygon' + C.reset);
    const S = loadCore().stats;
    const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-6) * Math.max(1, Math.abs(b));

    // Exact quadratic around x = 1000..1100, where raw normal equations of a
    // cubic lose every digit: the fit must still recover it.
    const q = [];
    for (let x = 1000; x <= 1100; x += 5) { q.push({ x: x, y: 2 * x * x - 3 * x + 5 }); }
    const f2 = S.polyfit(q, 2);
    check('quadratic recovered from x near 1000', f2 && near(f2.coef[2], 2, 1e-6) && near(f2.coef[1], -3, 1e-3) && near(f2.r2, 1, 1e-9), f2 && f2.coef);
    const c = [];
    for (let x = -5; x <= 5; x += 0.5) { c.push({ x: x, y: 0.5 * x * x * x - x + 1 }); }
    const f3 = S.polyfit(c, 3);
    check('cubic recovered', f3 && near(f3.coef[3], 0.5) && near(f3.coef[1], -1) && near(f3.coef[0], 1) && near(S.polyval(f3.coef, 2), 4 - 2 + 1), f3 && f3.coef);
    check('too few points for the degree: no fit', S.polyfit([{ x: 1, y: 1 }, { x: 2, y: 3 }], 2) === null);
    const L = [[0, 0], [10, 0], [10, 10], [5, 4], [0, 10]];   // concave
    check('inside a concave polygon, and outside its notch',
        S.inPolygon(2, 2, L) && !S.inPolygon(5, 8, L) && !S.inPolygon(11, 5, L), [S.inPolygon(2, 2, L), S.inPolygon(5, 8, L)]);

    const xs = [], ya = [], yb = [], gate = [];
    for (let m = 0; m < 10; m++) { xs.push([m, m]); ya.push([m, 2 * m]); yb.push([m, 20 - m]); gate.push([m, m < 4 ? 0 : 100]); }
    const data = [series('Load', 'MW', xs), series('Flow', 't/h', ya), series('Head', 'm', yb), series('Speed', 'rpm', gate)];
    const dots = (r) => r.tips.filter((t) => /^Load:/.test(t));

    const def = probe('pvxXYScatter', data);
    check('defaults: one Y, as before, others said to be ignored', dots(def).length === 10 && /2 extra sources ignored/.test(def.footer), def.footer);

    const all = probe('pvxXYScatter', data, 'YSources=all');
    check('every source after X: each pair drawn, named by its own series',
        dots(all).length === 30 && dots(all).some((t) => /\nHead: 15/.test(t)) && dots(all).some((t) => /\nSpeed: 100/.test(t)), dots(all).length);
    check('...and nothing said to be ignored', !/ignored/.test(all.footer), all.footer);

    const gated = probe('pvxXYScatter', data, 'YSources=all;GateSource=4;GateMin=50');
    check('a gate keeps only the points while it is in range, and is not plotted',
        dots(gated).length === 12 && !dots(gated).some((t) => /\nSpeed:/.test(t)), dots(gated).length);
    check('...and says so, with the count left out', /only while Speed ≥ 50/.test(gated.footer) && /8 outside the gate/.test(gated.footer), gated.footer);

    const poly = probe('pvxXYScatter', data, 'ShowEnvelope=true;EnvelopeShape=polygon;EnvelopePolygon=-1,-1 | 5.5,-1 | 5.5,12 | -1,12');
    check('polygon envelope: points outside counted', /4 outside the envelope/.test(poly.footer), poly.footer);
    const badPoly = probe('pvxXYScatter', data, 'ShowEnvelope=true;EnvelopeShape=polygon;EnvelopePolygon=1,1 | two,3');
    check('...a corner it cannot read is named', /1 envelope corner not read/.test(badPoly.footer) && /at least three/.test(badPoly.footer), badPoly.footer);

    const fit = probe('pvxXYScatter', [series('X', '', xs.map((p) => [p[0], p[1]])), series('Y', '', xs.map((p) => [p[0], p[1] * p[1]]))], 'FitType=poly2');
    const fitLabels = fit.labels.join(' | ');
    check('quadratic fit: equation without rounding residue, and R²', /y = 1(\.0+)?x²( \||$)/.test(fitLabels) && /R² = 1\.0000/.test(fitLabels), fitLabels.slice(0, 160));

    const errs = [].concat(def.errors, all.errors, gated.errors, poly.errors, badPoly.errors, fit.errors);
    check('no page errors', errs.length === 0, errs);
}

function historyTable() {
    console.log('');
    console.log(C.bold + 'History table' + C.reset);
    const vis = loadSymbol('pvxHistoryTable');
    const H = 3600000;
    const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

    const iv = vis.parseInterval;
    check('intervals parse: 1h, 15 min, 2d, 1mo',
        iv('1h').ms === H && iv('15 min').ms === 15 * MIN && iv('2d').ms === 2 * 24 * H && iv('1mo').unit === 'mo',
        [iv('1h'), iv('15 min'), iv('2d'), iv('1mo')]);
    check('a nonsense or zero interval is refused', iv('abc') === null && iv('0h') === null && iv('') === null);

    // Local time throughout: rows fall on the viewer's clock.
    const L = (y, mo, d, h, mi) => new Date(y, mo, d, h || 0, mi || 0).getTime();
    const hrs = (list) => list.map((t) => new Date(t).getHours());
    const from = L(2026, 9, 20, 0, 30);
    check('hourly rows fall on the hour inside the window',
        JSON.stringify(hrs(vis.boundaries(from, from + 3 * H, iv('1h')))) === '[1,2,3]',
        hrs(vis.boundaries(from, from + 3 * H, iv('1h'))));
    const seven = vis.boundaries(L(2026, 9, 20), L(2026, 9, 21, 23, 59), iv('7h'));
    check('a 7-hour step starts again at midnight', JSON.stringify(hrs(seven)) === '[0,7,14,21,0,7,14,21]', hrs(seven));
    const wk = vis.boundaries(L(2026, 9, 21), L(2026, 10, 10), iv('1w'));
    check('weeks start on Monday', wk.length === 3 && wk.every((t) => new Date(t).getDay() === 1),
        wk.map((t) => new Date(t).toString().slice(0, 10)));
    const mo = vis.boundaries(L(2026, 9, 15), L(2027, 0, 10), iv('1mo'));
    check('months start on the 1st, across a year end',
        mo.length === 3 && mo.every((t) => new Date(t).getDate() === 1) && new Date(mo[2]).getFullYear() === 2027,
        mo.map((t) => new Date(t).toString().slice(0, 15)));

    const P = (pairs) => pairs.map((p) => ({ t: p[0] * MIN, v: typeof p[1] === 'number' ? p[1] : null, state: String(p[1]), good: p[2] !== false }));
    const ramp = P([[0, 0], [60, 60]]);
    check('linear between samples', near(vis.valueAt(ramp, 30 * MIN, false).v, 30));
    check('step holds the earlier sample', near(vis.valueAt(ramp, 30 * MIN, true).v, 0));
    check('no value before the first sample', vis.valueAt(ramp, -1, false) === null);
    check('the last value holds after it', near(vis.valueAt(ramp, 90 * MIN, false).v, 60));
    const withText = P([[0, 5], [10, 'I/O Timeout'], [20, 7]]);
    check('a state that is not a number holds as text', vis.valueAt(withText, 15 * MIN, false).text === 'I/O Timeout');
    check('a line does not run into a state', near(vis.valueAt(withText, 5 * MIN, false).v, 5));

    const S = (pts, s, e, stat, step) => vis.summarize(pts, s * MIN, e * MIN, stat, { step: step, per: 'h' });
    check('ramp 0..60 over an hour: time-weighted average 30', near(S(ramp, 0, 60, 'twavg').v, 30));
    check('...minimum 0, maximum 60, range 60, change 60',
        near(S(ramp, 0, 60, 'min').v, 0) && near(S(ramp, 0, 60, 'max').v, 60) &&
        near(S(ramp, 0, 60, 'range').v, 60) && near(S(ramp, 0, 60, 'delta').v, 60));
    check('...total of a rate per hour over one hour is 30', near(S(ramp, 0, 60, 'total').v, 30));
    check('...count takes the sample at the start, not the one that ends it', S(ramp, 0, 60, 'count').v === 1);
    const steps = P([[0, 10], [30, 20], [60, 30]]);
    check('step: average 15 over [0,60)', near(S(steps, 0, 60, 'twavg', true).v, 15));
    check('step: the sample at the end belongs to the next interval', near(S(steps, 0, 60, 'max', true).v, 20));
    const sparse = P([[0, 0], [120, 120]]);
    check('an interval with no sample inside still has edges: 60..120, average 90',
        near(S(sparse, 60, 120, 'twavg').v, 90) && near(S(sparse, 60, 120, 'min').v, 60) && near(S(sparse, 60, 120, 'max').v, 120));
    const late = P([[30, 10], [90, 10]]);
    check('before the first sample counts for nothing', near(S(late, 0, 60, 'twavg').v, 10) && S(late, 0, 60, 'start').v === null);
    const dirty = P([[0, 10], [20, 'Shutdown'], [40, 10]]);
    const sd = S(dirty, 0, 60, 'twavg');
    check('a state is left out of a statistic and counted', near(sd.v, 10) && sd.skipped === 1, sd);
    check('totals row: avg, sum, min, max over numbers only',
        vis.aggregate([1, 2, null, 3], 'avg') === 2 && vis.aggregate([1, 2, 3], 'sum') === 6 &&
        vis.aggregate([4, 1, 9], 'min') === 1 && vis.aggregate([4, 1, 9], 'max') === 9 && vis.aggregate([null], 'avg') === null);

    const D = loadCore().download;
    check('CSV: quotes, formula guard, negative numbers stay numbers',
        D.csvText([['a,b', '=1+2', -5, '-5', 'say "x"', null, '@x']]) === '"a,b",\'=1+2,-5,-5,"say ""x""",,\'@x\r\n',
        D.csvText([['a,b', '=1+2', -5, '-5', 'say "x"', null, '@x']]));
    check('CSV file name: nothing Windows refuses', D.fileName('Line 3: shift/report?', 'csv') === 'Line 3 shift report.csv',
        D.fileName('Line 3: shift/report?', 'csv'));

    // Rendered. probe pins TZ=UTC, and T0 is midnight UTC.
    const flow = series('Flow', 't/h', [[0, 100], [30, 110], [60, 120], [120, 100], [180, 90]]);
    const pump = series('Pump', '', [[0, 'Running'], [90, 'Stopped'], [150, 'Running']]);
    const body = (res) => res.rows.slice(1).map((r) => r.join('|'));

    const interp = probe('pvxHistoryTable', [flow, pump], 'Mode=interpolated;Interval=1h;NewestFirst=false');
    check('interpolated: a row each hour, line for the number, state held for the tag',
        JSON.stringify(body(interp)) === JSON.stringify(['Oct 20 00:00|100.0|Running', 'Oct 20 01:00|120.0|Running',
            'Oct 20 02:00|100.0|Stopped', 'Oct 20 03:00|90.0|Running']), body(interp));

    const total = probe('pvxHistoryTable', [flow, pump], 'Mode=summary;Statistic=total;TotalPer=h;Interval=1h;Totals=auto;NewestFirst=false');
    check('summary total: 110, 110, 95 t and a summed totals row',
        JSON.stringify(body(total).map((r) => r.split('|').slice(1, 2).join())) === JSON.stringify(['110.0', '110.0', '95.0', '315.0']),
        body(total));
    check('...the header carries the totalled units', /Flow ?t$/.test((total.rows[0] || [])[1] || ''), total.rows[0]);
    check('...the totals row is named for what it is', /^Total\|/.test(body(total)[3] || ''), body(total)[3]);
    check('...a digital tag is said to have no total', /Sources with no numbers have no total/.test(total.footer), total.footer);

    const rec = probe('pvxHistoryTable', [flow, pump], 'Mode=recorded;NewestFirst=true');
    check('recorded: one row per archived time, newest first, blank where a source has none',
        body(rec).length === 7 && /^Oct 20 03:00:00\|90\.0\|$/.test(body(rec)[0]) && /\|\|Stopped$/.test(body(rec)[3]), body(rec));

    const capped = probe('pvxHistoryTable', [flow, pump], 'Mode=recorded;MaxRows=3');
    check('past Most rows the footer says how many were kept', body(capped).length === 3 && /newest 3 of 7/.test(capped.footer), capped.footer);

    const long = series('Level', '%', [[0, 10], [1500, 20], [2900, 30]]);
    const grouped = probe('pvxHistoryTable', [long], 'Mode=interpolated;Interval=12h;GroupBy=day;Totals=max;NewestFirst=false');
    const labels = grouped.rows.filter((r) => r.length === 1).map((r) => r[0]);
    check('grouped by day: a header row per day', JSON.stringify(labels) === JSON.stringify(['Tue Oct 20, 2026', 'Wed Oct 21, 2026', 'Thu Oct 22, 2026']), labels);
    check('...and a maximum per day plus one over all', grouped.rows.filter((r) => /Maximum/.test(r[0] || '')).length === 4,
        grouped.rows.map((r) => r.join('|')));

    const errs = [].concat(interp.errors, total.errors, rec.errors, capped.errors, grouped.errors);
    check('no page errors', errs.length === 0, errs);
}

function comboChart() {
    console.log('');
    console.log(C.bold + 'Combo chart: averages, fit, log scale, ranges, states, panels, rulers' + C.reset);
    const vis = loadSymbol('pvxComboChart');

    const spec = vis.parseTraceSpec('1:line:ma20:fit, 2:range, 3:states, 4:line:ma1h');
    check('the grammar reads ma20, ma1h, fit, range and states',
        spec[0].ma === '20' && spec[0].fit === true && spec[1].type === 'range' && spec[2].type === 'states' && spec[3].ma === '1h', spec);
    check('...and writes them back as read', vis.stringifyTraceSpec(spec) === '1:line:ma20:fit, 2:range, 3:states, 4:line:ma1h',
        vis.stringifyTraceSpec(spec));
    check('a moving average is a count or a time, nothing else',
        vis.parseMa('20').count === 20 && vis.parseMa('1h').ms === 3600000 && vis.parseMa('30m').ms === 1800000 &&
        vis.parseMa('0') === null && vis.parseMa('abc') === null && vis.parseMa('2x') === null);
    const pts = [[0, 10], [1, 20], [2, 30], [3, 40]].map((p) => ({ t: p[0] * MIN, v: p[1] }));
    const by2 = vis.movingAverage(pts, { count: 2 }).map((p) => p.v);
    check('by count: the mean of the last two', JSON.stringify(by2) === '[10,15,25,35]', by2);
    const byTime = vis.movingAverage(pts, { ms: 2 * MIN }).map((p) => p.v);
    check('by time: every sample in the last two minutes', JSON.stringify(byTime) === '[10,15,20,30]', byTime);
    check('log ends snap out to 1, 2 or 5: 60..120 is 50..200',
        vis.logSnap(60, false) === 50 && vis.logSnap(120, true) === 200 && vis.logSnap(0.03, false) === 0.02 && vis.logSnap(100, true) === 100);
    check('log ticks: 1, 2, 5 between few decades, decades only over many',
        vis.logTicks(50, 200).join() === '50,100,200' && vis.logTicks(1, 1e6).join() === '1,10,100,1000,10000,100000,1000000',
        [vis.logTicks(50, 200), vis.logTicks(1, 1e6)]);
    const ramp = [{ t: 0, v: 0 }, { t: 60 * MIN, v: 60 }];
    check('value at a time: a line interpolates, a step holds',
        vis.valueAt(ramp, 30 * MIN, false).v === 30 && vis.valueAt(ramp, 30 * MIN, true).v === 0 && vis.valueAt(ramp, -1, false) === null);

    // Rendered. probe pins TZ=UTC, and T0 is midnight UTC. Flow climbs one
    // klb/h a minute, so a value read anywhere equals its minutes past T0.
    const flow = series('Flow', 'klb/h', [[0, 0], [30, 30], [60, 60], [90, 90], [120, 120]]);
    const top = series('Flow max', 'klb/h', [[0, 10], [60, 70], [120, 130]]);
    const pump = series('Pump', '', [[0, 'Running'], [60, 'Stopped'], [90, 'Running']]);

    const fit = probe('pvxComboChart', [flow, pump], 'TraceSpec=1:line:ma2:fit, 2:states;StateColors=Running:#2f9e5f, Stopped:#c8452f');
    const fitTip = fit.tips.filter((t) => /trend/.test(t)).join();
    check('a fit gives its slope per hour and R²', /Flow: trend \+60(\.0+)? klb\/h per hour, R² 1\.00/.test(fitTip), fitTip);
    check('a moving average names its window', fit.tips.some((t) => /Flow: moving average over 2 samples/.test(t)), fit.tips);
    const stateTips = fit.tips.filter((t) => /^Pump: /.test(t));
    check('state bands: one span per run, with its state and length',
        stateTips.length === 3 && /^Pump: Running\n/.test(stateTips[0]) && /1h/.test(stateTips[0]) &&
        /^Pump: Stopped\n/.test(stateTips[1]) && /30m/.test(stateTips[1]), stateTips);

    const range = probe('pvxComboChart', [flow, top], 'TraceSpec=1:range');
    check('a range shades to the next source and names both', range.tips.some((t) => /Flow – Flow max/.test(t)) ||
        range.text.indexOf('Flow – Flow max') !== -1, range.text);
    const alone = probe('pvxComboChart', [flow, top], 'TraceSpec=2:range');
    check('...a range with no next source is a line, and says so', /trace 2 is a range but has no next source/.test(alone.footer), alone.footer);

    const neg = series('Signal', '', [[0, -5], [10, 0], [20, 60], [30, 120]]);
    const log = probe('pvxComboChart', [neg], 'LeftScale=log');
    check('log scale: values at or below 0 are counted, not drawn', /2 values at or below 0 not drawn on the log scale/.test(log.footer), log.footer);
    check('...and the axis runs 50 to 200', ['50', '100', '200'].every((l) => log.labels.indexOf(l) !== -1), log.labels);

    const panels = probe('pvxComboChart', [flow, series('Speed', 'rpm', [[0, 1000], [120, 3000]])], 'Panels=separate');
    check('separate panels: each trace is labelled with its own units',
        panels.labels.indexOf('Flow (klb/h)') !== -1 && panels.labels.indexOf('Speed (rpm)') !== -1, panels.labels);
    const short = probe('pvxComboChart', Array.from({ length: 12 }, (_, i) => Object.assign({}, flow, { Label: 'F' + i })),
        'Panels=separate;ShowLegend=false');
    check('...too short for one each, they share and say so', /too short for 12 separate panels/.test(short.footer), short.footer);

    // Rulers: two clicks across the plot, then read the table under it.
    // A sample every 10 minutes, so several fall between the rulers.
    const dense = series('Flow', 'klb/h', Array.from({ length: 13 }, (_, i) => [i * 10, i * 10]));
    const rul = probe('pvxComboChart', [dense, pump], 'TraceSpec=2:states;Rulers=true;Decimals=2', '0.3,0.5;0.8,0.5');
    const head = rul.rows[0] || [];
    const body = rul.rows.slice(1);
    const tr = body.find((r) => r[0] === 'Time') || [];
    const fr = body.find((r) => /^Flow/.test(r[0])) || [];
    const pr = body.find((r) => /^Pump/.test(r[0])) || [];
    const num = (s) => parseFloat(String(s).replace(/[^0-9.+-]/g, ''));
    const minutesOf = (txt) => { const m = /(\d\d):(\d\d):(\d\d)/.exec(txt || ''); return m ? (+m[1]) * 60 + (+m[2]) + (+m[3]) / 60 : NaN; };
    const a = num(fr[1]), b = num(fr[2]);
    check('rulers: the table has every column once both are placed',
        head.join('|') === 'Source|A|B|Change|Min|Max|Avg|Std dev|Count|Trend', head);
    check('...a first row gives both times and the span between', /^Oct 20 /.test(tr[1] || '') && /^Oct 20 /.test(tr[2] || '') && /\d/.test(tr[3] || ''), tr);
    check('...the value at A and B is the trace at those times', Math.abs(a - minutesOf(tr[1])) < 0.05 && Math.abs(b - minutesOf(tr[2])) < 0.05,
        [fr, tr]);
    check('...change is B minus A', Math.abs(num(fr[3]) - (b - a)) < 0.02, fr);
    check('...the average is time-weighted: halfway for a ramp', Math.abs(num(fr[6]) - (a + b) / 2) < 0.05, fr);
    const inside = Array.from({ length: 13 }, (_, i) => i * 10).filter((m) => m >= a && m <= b);
    check('...min, max and count are of the samples between', num(fr[4]) === inside[0] && num(fr[5]) === inside[inside.length - 1] &&
        num(fr[8]) === inside.length, [fr, inside]);
    check('...the trend is the ramp\'s 60 an hour', /^\+60(\.0+)? klb\/h per hour$/.test(fr[9] || ''), fr);
    check('...a state source shows its state at each ruler', /Running|Stopped/.test(pr[1] || '') && /Running|Stopped/.test(pr[2] || ''), pr);

    const errs = [].concat(fit.errors, range.errors, alone.errors, log.errors, panels.errors, short.errors, rul.errors);
    check('no page errors', errs.length === 0, errs);
}

/* One data source from [minutes from now, value] pairs, with the window PI
 * Vision names on each item. Target & Forecast lays its axis out from that
 * window and splits past from future at the browser's clock, so these
 * payloads are built around the moment the test runs. */
function aroundNow(n0, label, units, pts, startMin, endMin) {
    return {
        Label: label, Units: units, Path: '\\\\AF\\Line 2|' + label, IsGood: true,
        StartTime: new Date(n0 + startMin * MIN).toISOString(), EndTime: new Date(n0 + endMin * MIN).toISOString(),
        Value: pts.map((p) => ({ Time: new Date(n0 + p[0] * MIN).toISOString(), Value: p[1] }))
    };
}

function targetForecast() {
    console.log('');
    console.log(C.bold + 'Target & Forecast' + C.reset);
    const all = [];
    // A minute ahead, so "now" in the browser falls between the last actual
    // and the forecast's next sample however long the probe takes to start.
    const n0 = Date.now() + 60000;
    const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
    const tip = (res, prefix) => res.tips.filter((t) => t.indexOf(prefix) === 0).join(' | ');
    const S = (label, pts) => aroundNow(n0, label, 't/h', pts, -120, 60);
    // Actual ramps 100 to 120 up to now; the plan steps 100, 115, then 140
    // half an hour ahead; the forecast runs 112, 118, 136 an hour apart.
    const actual = S('Output', [[-120, 100], [-90, 105], [-60, 110], [-30, 115], [0, 120]]);
    const plan = S('Plan', [[-120, 100], [-30, 115], [30, 140]]);
    const fcst = S('Forecast', [[-60, 112], [0, 118], [60, 136]]);
    const low = S('P10', [[-60, 110], [0, 115], [60, 128]]);
    const high = S('P90', [[-60, 114], [0, 121], [60, 144]]);
    const base = 'Decimals=1;ShowLabel=false';

    const r = probe('pvxTargetForecast', [actual, plan, fcst], base);
    all.push(r);
    check('actual now is the latest actual', /^Actual: 120\.0 t\/h at /.test(tip(r, 'Actual: ')), tip(r, 'Actual: '));
    check('target now is the step in force then, not the next one', /^Target: 115\.0 t\/h$/.test(tip(r, 'Target: ')), tip(r, 'Target: '));
    check('the gap is actual minus target, with its share of target',
        tip(r, 'Gap: ') === 'Gap: Actual minus Target = +5.0 t/h (+4.3% of target)', tip(r, 'Gap: '));
    check('the forecast ends at its last value, against the target in force then',
        /^Forecast at its end: 136\.0 t\/h at .*; −4\.0 t\/h against the target then/.test(tip(r, 'Forecast at its end')), tip(r, 'Forecast at its end'));
    check('...and crosses the target when the target steps over it, not between samples',
        new RegExp('crosses the target at \\w+ \\d+ ' + clock(n0 + 30 * MIN) + '$').test(tip(r, 'Forecast at its end')), tip(r, 'Forecast at its end'));
    check('forecast error: mean absolute and bias over the actual samples inside the forecast',
        tip(r, 'Forecast error') === 'Forecast error so far: mean absolute 1.3 t/h, bias 0.0 t/h (forecast minus actual) over 3 samples',
        tip(r, 'Forecast error'));
    const ahead = r.tips.filter((t) => /Forecast: 1[23]\d\.\d t\/h/.test(t) && /Target: 140\.0 t\/h/.test(t) && !/Actual:/.test(t));
    check('readings after now give the forecast and the target ahead, and no actual', ahead.length > 0, r.tips.slice(0, 4));
    check('...with the gap there marked as the forecast\'s', ahead.every((t) => /Gap: [+−]\d+\.\d t\/h \(forecast\)$/.test(t)), ahead.slice(0, 2));
    check('nothing in the footer when every source has a role', r.footer === '', r.footer);

    const tol = probe('pvxTargetForecast', [actual, plan, fcst], base + ';ToleranceMode=units;Tolerance=3');
    all.push(tol);
    check('a gap beyond the tolerance is out of it', /, out of tolerance$/.test(tip(tol, 'Gap: ')), tip(tol, 'Gap: '));
    const tolPct = probe('pvxTargetForecast', [actual, plan, fcst], base + ';ToleranceMode=percent;Tolerance=5');
    all.push(tolPct);
    check('...and a percent tolerance is of the target (5% of 115 covers 5)', /, in tolerance$/.test(tip(tolPct, 'Gap: ')) &&
        /± 5\.8 t\/h/.test(tip(tolPct, 'Target: ')), [tip(tolPct, 'Gap: '), tip(tolPct, 'Target: ')]);

    // The same sources in another order, each role picked by number, and a
    // range from two more: the answers must not move.
    const picked = probe('pvxTargetForecast', [fcst, high, actual, low, plan],
        base + ';ActualSource=3;TargetSource=5;ForecastSource=1;ForecastLowSource=4;ForecastHighSource=2');
    all.push(picked);
    check('roles picked by number give the same answers', tip(picked, 'Gap: ') === tip(r, 'Gap: ') &&
        tip(picked, 'Forecast at its end') === tip(r, 'Forecast at its end'), [tip(picked, 'Gap: '), tip(picked, 'Forecast at its end')]);
    check('...the forecast range reaches the readings', picked.tips.some((t) => /Forecast range: \d+\.\d to \d+\.\d t\/h/.test(t)), picked.tips.slice(0, 3));
    check('...and the legend', picked.text.indexOf('Forecast range') !== -1, picked.text.slice(0, 200));

    const extra = probe('pvxTargetForecast', [actual, plan, fcst, S('Ambient', [[-60, 20], [0, 21]])], base);
    all.push(extra);
    check('a source given no role is counted, not ignored', /1 data source given no role/.test(extra.footer), extra.footer);
    const lone = probe('pvxTargetForecast', [actual, plan, fcst, low], base + ';ForecastLowSource=4');
    all.push(lone);
    check('a range with one edge is not drawn, and the footer says why', /needs both a low and a high source/.test(lone.footer) &&
        !lone.tips.some((t) => /Forecast range/.test(t)), lone.footer);

    const text = S('Output', [[-120, 100], [-90, 'Calc Failed'], [-60, 110], [-30, 115], [0, 120]]);
    const bad = probe('pvxTargetForecast', [text, plan, fcst], base);
    all.push(bad);
    check('a non-numeric actual is counted', /1 non-numeric value left out/.test(bad.footer), bad.footer);

    const fixed = probe('pvxTargetForecast', [actual, fcst], base + ';TargetMode=fixed;TargetValue=110');
    all.push(fixed);
    check('a fixed target: the second source is then the forecast',
        tip(fixed, 'Gap: ') === 'Gap: Actual minus Target = +10.0 t/h (+9.1% of target)' && /^Forecast at its end: 136\.0/.test(tip(fixed, 'Forecast at its end')),
        [tip(fixed, 'Gap: '), tip(fixed, 'Forecast at its end')]);
    const unset = probe('pvxTargetForecast', [actual, fcst], base + ';TargetMode=fixed');
    all.push(unset);
    check('...and with no value typed, says so rather than inventing one', /no target value set/.test(unset.footer) &&
        /no target/.test(tip(unset, 'Gap: ')), [unset.footer, tip(unset, 'Gap: ')]);

    const named = probe('pvxTargetForecast', [actual, plan, fcst], base + ';TargetLabel=Plan;ForecastLabel=Outlook;GapMode=percent');
    all.push(named);
    check('typed words replace the role names in tiles and readings', /^Gap: Actual minus Plan = \+5\.0 t\/h/.test(tip(named, 'Gap: ')) &&
        named.tips.some((t) => /Outlook: /.test(t)) && named.text.indexOf('Plan') !== -1, tip(named, 'Gap: '));
    check('...and the gap can lead in percent', /\+4\.3%/.test(named.text), named.text.slice(0, 160));

    const la = probe('pvxTargetForecast', [actual, plan, fcst], base + ';LookAhead=8h');
    all.push(la);
    check('look-ahead without PI Web API says what it needs', /look-ahead 8h needs PI Web API/.test(la.footer), la.footer);
    const laBad = probe('pvxTargetForecast', [actual, plan, fcst], base + ';LookAhead=soon');
    all.push(laBad);
    check('...a look-ahead that is not a length is named', /look-ahead soon is not a length of time/.test(laBad.footer), laBad.footer);
    const old = (label, pts) => aroundNow(n0 - 2 * 86400000, label, 't/h', pts, -120, 0);
    const past = probe('pvxTargetForecast', [old('Output', [[-120, 100], [0, 120]]), old('Plan', [[-120, 110]]), old('Forecast', [[-60, 112], [0, 118]])],
        base + ';LookAhead=8h');
    all.push(past);
    check('...and on a display that ends before now it stands down and says so', /look-ahead 8h is off: the display ends before now/.test(past.footer), past.footer);

    const errs = [].concat.apply([], all.map((x) => x.errors));
    check('no page errors', errs.length === 0, errs);
}

function rateOfChange() {
    console.log('');
    console.log(C.bold + 'Rate of Change' + C.reset);
    const all = [];
    // Minutes after T0 in a tooltip's first line, "Oct 20 01:05:00".
    const minuteOf = (tip) => {
        const m = /^\w+ \d+ (\d\d):(\d\d):(\d\d)/.exec(tip);
        return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 60 : null;
    };

    // A ramp of 2 a minute, sampled unevenly the way a compressed tag is:
    // seven minutes, then 53, then one. Every window method must read 2.
    const ramp = [[0, 0], [7, 14], [60, 120], [61, 122], [120, 240]];
    const win = probe('pvxRateOfChange', [series('Temp', 'degC', ramp)], 'Decimals=2');
    all.push(win);
    check('a ramp reads its slope whatever the sample spacing', /Steady \+2\.00 degC\/min/.test(win.footer) && !/fall/.test(win.footer), win.footer);
    check('...the title carries the rate units', /Temp rate of change \(degC\/min\)/.test(win.text), win.text.slice(0, 80));
    check('...the caption names the window', /change over 10 min/.test(win.text), win.text.slice(0, 80));
    check('...the first window has no rate, and the footer says so', /no rate in the first 10 min/.test(win.footer) &&
        Math.min.apply(null, win.tips.map(minuteOf).filter((m) => m !== null)) >= 9.5, win.footer);
    const perHour = probe('pvxRateOfChange', [series('Temp', 'degC', ramp)], 'Decimals=1;RateUnit=h');
    all.push(perHour);
    check('per hour: 120 degC/h', /Steady \+120\.0 degC\/h/.test(perHour.footer), perHour.footer);
    const fit = probe('pvxRateOfChange', [series('Temp', 'degC', ramp)], 'Decimals=2;Method=fit');
    all.push(fit);
    check('a fitted line over the window reads the same slope', /Steady \+2\.00 degC\/min/.test(fit.footer), fit.footer);
    const raw = probe('pvxRateOfChange', [series('Temp', 'degC', ramp)], 'Decimals=2;Method=samples');
    all.push(raw);
    check('between samples: the same, and no lost first window', /Steady \+2\.00/.test(raw.footer) && !/no rate in the first/.test(raw.footer), raw.footer);

    // Flat, a climb of 5 a minute for ten minutes, flat. Between samples it
    // is 5 for exactly 10 min; over a 10-minute window it is a triangle that
    // peaks at 5 when the window covers the whole climb, and stays above 4
    // for 4 minutes of it.
    const step = [[0, 0], [60, 0], [70, 50], [120, 50]];
    const sharp = probe('pvxRateOfChange', [series('Level', 'in', step)], 'Decimals=1;Method=samples;RiseLimit=4');
    all.push(sharp);
    check('past a rise limit for as long as the climb lasts', /over the rise limit 10m/.test(sharp.footer) && !/times/.test(sharp.footer), sharp.footer);
    const at65 = sharp.tips.filter((tp) => Math.abs(minuteOf(tp) - 65) < 0.5).join(' | ');
    check('...and the tooltip says so', /Rate: \+5\.0 in\/min {2}over the rise limit/.test(at65), at65);
    const smooth = probe('pvxRateOfChange', [series('Level', 'in', step)], 'Decimals=1;RiseLimit=4');
    all.push(smooth);
    check('a window smooths it: peak 5 at the end of the climb, 4 min past the limit', /Max rise \+5\.0 in\/min at 10\/20 01:10/.test(smooth.footer) &&
        /over the rise limit 4m/.test(smooth.footer), smooth.footer);
    const mid = probe('pvxRateOfChange', [series('Level', 'in', step)], 'Decimals=1;WindowAlign=centered');
    all.push(mid);
    check('centered: the peak sits mid-climb, without the lag', /Max rise \+5\.0 in\/min at 10\/20 01:05/.test(mid.footer) &&
        /no rate in the first and last 5 min/.test(mid.footer), mid.footer);
    const fall = probe('pvxRateOfChange', [series('Level', 'in', [[0, 50], [60, 50], [70, 0], [120, 0]])],
        'Decimals=1;Method=samples;FallLimit=4;RiseLimit=4');
    all.push(fall);
    check('a fall limit is typed positive and caught below zero', /past the fall limit 10m/.test(fall.footer) && /Max fall -5\.0/.test(fall.footer) && !/rise \+/.test(fall.footer), fall.footer);
    const ok = probe('pvxRateOfChange', [series('Level', 'in', step)], 'Decimals=1;Method=samples;RiseLimit=6;RiseWarn=4');
    all.push(ok);
    check('inside the limit, past the warning: said, not flagged', /Within the rate limits, past a warning for 10m/.test(ok.footer), ok.footer);
    const none = probe('pvxRateOfChange', [series('Level', 'in', step)], 'Method=samples');
    all.push(none);
    check('no limits: the footer says none are set', /No rate limits set/.test(none.footer), none.footer);

    // A bad value ends the trace: no window may reach across it.
    const broken = probe('pvxRateOfChange', [series('Temp', 'degC', [[0, 0], [30, 60], [40, 'I/O Timeout'], [50, 100], [120, 240]])], 'Decimals=2');
    all.push(broken);
    const across = broken.tips.map(minuteOf).filter((m) => m !== null && m > 31 && m < 59);
    check('no rate across a bad value', across.length === 0, across);
    check('...the footer counts it', /1 bad or non-numeric value: no rate across it/.test(broken.footer), broken.footer);
    check('...and either side of it still reads 2 a minute', /Steady \+2\.00/.test(broken.footer), broken.footer);

    // A gap limit breaks a scanned tag's trace where its feed stopped.
    const gap = probe('pvxRateOfChange', [series('Flow', 'gpm', [[0, 0], [10, 10], [50, 50], [60, 60], [70, 70]])],
        'Method=samples;MaxGapMinutes=20');
    all.push(gap);
    check('a gap past the limit is counted', /1 gap over 20m/.test(gap.footer), gap.footer);
    check('...and nothing is drawn across it', gap.tips.map(minuteOf).filter((m) => m !== null && m > 10.5 && m < 49.5).length === 0, gap.tips.map(minuteOf));

    // The last value holds to the end of the range, as PI Vision draws it.
    const held = series('Temp', 'degC', [[0, 0], [30, 30]]);
    held.StartTime = new Date(T0).toISOString();
    held.EndTime = new Date(T0 + 60 * MIN).toISOString();
    const hold = probe('pvxRateOfChange', [held], 'Decimals=2');
    all.push(hold);
    check('the last value holds to the end: the latest rate is zero', /latest 0\.00 degC\/min/.test(hold.footer), hold.footer);
    check('...and the net rate is the change over the range', /net \+0\.50 degC\/min/.test(hold.footer), hold.footer);

    // Two sources: the steepest is named.
    const two = probe('pvxRateOfChange', [series('A', 'degC', ramp), series('B', 'degC', [[0, 0], [120, 600]])], 'Decimals=1');
    all.push(two);
    check('several sources: the steepest rise is named', /Max rise \+5\.0 degC\/min \(B\)/.test(two.footer), two.footer);

    // The display's time range changes: the second update is a longer range
    // with a climb near its end. The chart must follow it, not the first.
    const ranged = (label, units, pts, fromMin, toMin) => Object.assign(series(label, units, pts), {
        StartTime: new Date(T0 + fromMin * MIN).toISOString(), EndTime: new Date(T0 + toMin * MIN).toISOString()
    });
    const before = ranged('Level', 'in', [[0, 0], [120, 0]], 0, 120);
    const after = ranged('Level', 'in', [[0, 0], [400, 0], [410, 50], [480, 50]], 0, 480);
    const moved = probe2('pvxRateOfChange', [before], [after], 'Decimals=1;Method=samples');
    all.push(moved);
    const latest = Math.max.apply(null, moved.tips.map(minuteOf).filter((m) => m !== null));
    check('a new time range is charted in full', latest > 470, latest);
    check('...with the new values', /Max rise \+5\.0 in\/min at 10\/20 06:40/.test(moved.footer), moved.footer);
    // A range that misses the values (left over, or misread) gives way to them.
    const stale = ranged('Level', 'in', [[600, 0], [660, 0], [670, 50], [720, 50]], 0, 120);
    const kept = probe2('pvxRateOfChange', [before], [stale], 'Decimals=1;Method=samples');
    all.push(kept);
    const keptMins = kept.tips.map(minuteOf).filter((m) => m !== null);
    check('a range that misses every value is not used', Math.min.apply(null, keptMins) >= 599 && Math.max.apply(null, keptMins) > 700, [Math.min.apply(null, keptMins), Math.max.apply(null, keptMins)]);
    check('...and the values are charted', /Max rise \+5\.0 in\/min at 10\/20 11:00/.test(kept.footer), kept.footer);

    // Seven days at the default 240 points would put them 42 min apart and
    // step over a 10-minute climb; the grid follows the window instead.
    const week = [[0, 0], [5000, 0], [5010, 50], [10080, 50]];
    const wk = probe('pvxRateOfChange', [ranged('Level', 'in', week, 0, 10080)], 'Decimals=1');
    all.push(wk);
    check('a long range still catches a short climb at its full rate', /Max rise \+5\.0 in\/min/.test(wk.footer), wk.footer);

    const thin = probe('pvxRateOfChange', [series('Temp', 'degC', [[0, 1]])]);
    all.push(thin);
    check('one value: not enough data, said in the symbol', /Not enough data/.test(thin.text), thin.text);

    const errs = [].concat.apply([], all.map((r) => r.errors));
    check('no page errors', errs.length === 0, errs);
}

(() => {
    // `--only spectrum` runs one section, for the inner loop; CI runs all.
    const sections = { windRose, bubble, histogramByTime, sankeyFixed, boxByTime, controlChart, gasTriangle,
        kpiCard, multiSparkline, multiGauge, periodChange, historyTable, xyUpgrades, spectrum, crossProfile, comboChart, targetForecast, rateOfChange };
    const only = process.argv[process.argv.indexOf('--only') + 1];
    try {
        Object.keys(sections).forEach((k) => {
            if (process.argv.indexOf('--only') === -1 || k === only) { sections[k](); }
        });
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
