# PVX — extended symbol library for AVEVA PI Vision

[![CI](https://github.com/willcgage/AVEVAPIVisionSymbols/actions/workflows/ci.yml/badge.svg)](https://github.com/willcgage/AVEVAPIVisionSymbols/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Forty-eight production-ready custom symbols that fill the gaps in PI Vision's stock
palette: analytics charts, KPI and status panels, navigation controls, Event
Frame analysis and manual data entry. Plus the build, preview and
verification tooling to keep adding more.

Thirty-one of them run entirely on PI Vision's own data pipeline — no PI Web
API, no server-side prerequisites beyond copying a folder. Ten reach further
(Event Frames, the AF hierarchy, writing values back) and need PI Web API, and
nine more use it for an optional extra; see
**[docs/PI-WEB-API.md](docs/PI-WEB-API.md)**.

Works with PI Vision 2019 through 2025 — the symbol extensibility model
(`Scripts\app\editor\symbols\ext`, AngularJS 1.x, `PV.symbolCatalog.register`)
has been stable across that whole range, and every symbol here is written to it
in ES5 with no third-party libraries.

---

## The symbols

### Charts and analytics

| | Symbol | What it's for |
|---|---|---|
| ![](src/symbols/pvxComboChart/icon.svg) | **PVX Combo Chart** | Bars, lines, areas, steps and scatter on one time axis with an independent right-hand scale and shaded limit bands, and optionally the asset's AF event frames shaded behind the traces (PI Web API). Digital tags as state bands, min-to-max ranges, moving averages and trend lines, one panel per trace, log scales, and two rulers with statistics between them. Traces can come from an AF search, one per asset. The native trend draws every trace the same way; this does not. |
| ![](src/symbols/pvxHistogram/icon.svg) | **PVX Distribution** | Frequency histogram with a fitted normal curve, spec limits, and **Cp / Cpk / expected ppm**. A capability study, not just a chart. |
| ![](src/symbols/pvxSpectrum/icon.svg) | **PVX Spectrum** | Which cycles are in a tag and how big each is: a loop hunting every twenty minutes, a recycle rippling every seven. An FFT of recorded values resampled evenly, with the largest peaks marked by frequency and period, and bands that turn red when a peak in them passes a limit. |
| ![](src/symbols/pvxControlChart/icon.svg) | **PVX Control Chart** | Shewhart I-MR, X̄-R or X̄-S chart with Nelson or Western Electric run rules, each flagged point naming the rule it broke. Limits from the window, a baseline, typed values or data sources; Cpk and Ppk against spec limits; a distribution strip beside the plot. |
| ![](src/symbols/pvxBoxPlot/icon.svg) | **PVX Variability** | Quartiles, whiskers and outliers, one box per tag. Twenty identical assets side by side — the wide box is the one to go and look at. |
| ![](src/symbols/pvxDeviation/icon.svg) | **PVX Deviation from Target** | Deviation from setpoint with the tolerance band shaded, excursions coloured by direction, and time-in-band, excursion count and longest excursion computed from real sample intervals. |
| ![](src/symbols/pvxWaterfall/icon.svg) | **PVX Waterfall** | Floating bars bridging a start value to an end value through signed steps, with connectors and running subtotals. Mass and energy balances, yield-loss accounting. |
| ![](src/symbols/pvxPeriodOverlay/icon.svg) | **PVX Period Comparison** | Folds the window into N periods overlaid on a common relative-time axis, with a min/max envelope from the older ones. Today over yesterday over the golden batch. Hours, shifts, days, weeks or calendar months; values, or change and percent change from a baseline; further tags draw their current period alongside. Or runs from AF event frames (batches, campaigns; PI Web API), lined up at their start, their end or 0 to 100% of each run, measured against the average of the golden runs with a tolerance band. |
| ![](src/symbols/pvxTreemap/icon.svg) | **PVX Treemap** | Squarified rectangles sized by one statistic and coloured by another. Size shows who is big, colour shows who is in trouble; the tile that is both is the one to look at. Tiles can come from an AF search, grouped by parent asset, with a drill into a group. |
| ![](src/symbols/pvxSankey/icon.svg) | **PVX Flow** | Weighted ribbons between nodes with per-node balance checking — where inflow and outflow disagree, you have a leak, a bad meter or a missing tag. |
| ![](src/symbols/pvxRadar/icon.svg) | **PVX Fingerprint** | Normalised multi-axis polygon over a reference profile. Shape recognition: does this asset still look like it used to. From an AF search, one outline per asset to compare a fleet. |
| ![](src/symbols/pvxDonut/icon.svg) | **PVX Contribution** | Share of a total with the total in the hole. The config pane is honest that a ranked bar reads better for magnitude. |
| ![](src/symbols/pvxProfile/icon.svg) | **PVX Spatial Profile** | Values along a *physical* axis — kiln zones, column trays, cell voltages — with a limit envelope and a faded "shadow" profile so drift shows as a change of shape. |
| ![](src/symbols/pvxCrossProfile/icon.svg) | **PVX Cross Profile** | A measurement at many positions across a sheet over time: a map of position against time coloured by distance from target, so a streak or a drifting edge shows at once, with the current and average profile and each position's 2-sigma band under it. |
| ![](src/symbols/pvxOperatingMap/icon.svg) | **PVX Operating Map** | The live operating point on a compressor or pump map: surge line, control line, speed lines and stonewall, a fading trail showing direction of travel, and surge margin as a number. The curves can live on the AF element, so the map follows asset swapping. |
| ![](src/symbols/pvxRadialGauge/icon.svg) | **PVX Radial Gauge** | Threshold-banded dial. Configurable sweep from a shallow arc to a full ring, needle or progress arc, target marker; optionally the value's band highlighted, ticks on the band limits, minor ticks, and an inverted scale. |
| ![](src/symbols/pvxBarIndicator/icon.svg) | **PVX Bar Indicator** | Horizontal or vertical level bar. Solid, gradient, segmented or thermometer; threshold bands on the track; target marker; optionally the value's band highlighted, ticks on the band limits, minor ticks, and an inverted scale. |
| ![](src/symbols/pvxMultiGauge/icon.svg) | **PVX Multi-Pointer Gauge** | Several values on one scale, as a dial (needles, markers or rings) or a bar (markers or side-by-side bars), each in its own colour with a readout row. A value that is not a number or is off the scale is named, not dropped. |
| ![](src/symbols/pvxSparkline/icon.svg) | **PVX Multi Sparkline** | One dense row per tag — name, micro-trend, current value. Twenty tags at a glance, which the stock trend cannot do. |
| ![](src/symbols/pvxCompare/icon.svg) | **PVX Condition Compare** | Splits the time range by a rule on one tag ("yield < 92%") and ranks every other tag by how differently it behaves while the rule holds, with paired histograms per tag. What is different about the bad hours, without the trip to Excel. |
| ![](src/symbols/pvxXYScatter/icon.svg) | **PVX XY Scatter** | Correlation of one tag against another with least-squares regression, R², time-coloured points and an operating-envelope box. A bubble mode lets a third tag set each point's size. Optionally several Y tags at once, a gate tag that keeps only points taken while it is in range, a quadratic or cubic fit, and a polygon envelope. |
| ![](src/symbols/pvxWindRose/icon.svg) | **PVX Wind Rose** | Direction against speed as stacked polar bars: where the wind blows from and how hard, weighted by time rather than sample count. Bars in percent of time, hours, or 100% per direction; with speed bands off it is a plain polar bar chart. |
| ![](src/symbols/pvxGasTriangle/icon.svg) | **PVX Gas Triangle** | Duval's Triangle 1 (IEC 60599) for transformer oil: methane, ethylene and acetylene as shares of their total, in the seven fault zones, with a fading trail over the time range and the zone named. Gases are matched to sources by name; below a minimum total the zone is not named. |
| ![](src/symbols/pvxHeatmap/icon.svg) | **PVX Heatmap** | Hour-of-day × day calendar, tag × time-bucket matrix, or value × time density weighted by time spent. Makes diurnal and shift patterns obvious, and shows a hunting valve as two bands where a trend shows a smear. |
| ![](src/symbols/pvxPareto/icon.svg) | **PVX Ranked Bar** | Sorted bars with an optional cumulative Pareto line. "Which five assets drive 80% of the loss." A bar can open the asset's display. The bars can come from an AF search, so a new asset appears without editing the display. Bars can filter, and follow filters from, the symbols beside it. |

### KPI and status

| | Symbol | What it's for |
|---|---|---|
| ![](src/symbols/pvxAnnunciator/icon.svg) | **PVX Annunciator** | Latching alarm tiles with the ISA-18.2 ringback state, so an excursion that starts and clears between two refreshes is still there when someone looks. First-out marking for cascades, and an optional deadband so a value sitting on a limit does not ring the tile again and again. |
| ![](src/symbols/pvxSitePlan/icon.svg) | **PVX Site Plan** | Live values pinned to a plant drawing by percentage coordinates. The offline answer to a map symbol — no tile provider required. |
| ![](src/symbols/pvxStateDuration/icon.svg) | **PVX Time in State** | Time-in-state timeline or stacked bar per digital tag, with uptime percentage and transition count. Downtime accounting with no Event Frames, no AF templates and no PI Web API. |
| ![](src/symbols/pvxKpiCard/icon.svg) | **PVX KPI Card** | Headline number (latest, averages plain or time-weighted, a rate totalled over time, spread, percent good), delta against earlier in the range or against a plan from a source, AF or typed in, with a tolerance that reads On target, a progress bar or ring toward the plan, inline sparkline with the plan line, footer statistics, and an edge coloured by the headline's band. |
| ![](src/symbols/pvxAssetTable/icon.svg) | **PVX Asset Table** | One row per asset, one column per attribute, each cell coloured by its own limits or state map, a status dot for the worst cell, and the row opening the unit's display with that unit as the asset. Rows come from the data sources, or from the elements under the current asset so an area with more units gets more rows. A click can filter the symbols beside it to that asset, and it can follow such a filter. Optionally, cells write back: a click opens the value, the write is confirmed in full, and PI Web API's reason is shown if it refuses. |
| ![](src/symbols/pvxStatusGrid/icon.svg) | **PVX Status Grid** | Responsive tile grid coloured by thresholds or by a digital state map. Four tile styles, optional drill-down. |
| ![](src/symbols/pvxAlarmBanner/icon.svg) | **PVX Exception Banner** | Shows only the tags currently outside limits, worst first, with dwell time. List, ticker or summary mode, an optional deadband, and a History mode that lists past excursions in the time range (start, end, duration, peak) from recorded values. |
| ![](src/symbols/pvxAlarmTone/icon.svg) | **PVX Alarm Tone** | Sounds a tone made in the browser when a tag goes into alarm, repeating until it is silenced or clears; five tones, one for the highest band if wanted, and a deadband. Silences on this screen with a click, or on every screen when the alarm is acknowledged on an Annunciator that shares acknowledgements through AF. No sound files and no server change. |
| ![](src/symbols/pvxDataHealth/icon.svg) | **PVX Data Health** | Lists only the tags that can't be trusted right now: bad, out of instrument range, stale, or flatlined. The healthy rest are a count in the footer, so nothing is silently dropped. |
| ![](src/symbols/pvxHistoryTable/icon.svg) | **PVX History Table** | A row per time and a column per tag: the value on the hour (or every 15 minutes, or at midnight), a statistic per interval (time-weighted average, minimum, maximum, total, change, count), or every archived value. Grouped by day, week or month with totals, cells coloured by threshold, and a CSV button that saves the rows shown. |

### Event Frames, AF and data entry · needs PI Web API

| | Symbol | What it's for |
|---|---|---|
| ![](src/symbols/pvxEventGantt/icon.svg) | **PVX Event Timeline** | Event Frames as swimlanes per asset, stacked where they overlap, with open events drawn to the edge rather than faked as finished. The native Events Table is a list; this shows pattern and clustering. A hierarchy mode nests child frames under their parents (batch, unit procedure, phase) and flags the steps that ran longer than typical. Can show only the events of the display's current asset, or of it and everything under it. |
| ![](src/symbols/pvxEventAnalytics/icon.svg) | **PVX Event Analytics** | Which reason code costs the most hours. Durations are clipped to the window and overlapping events merged before summing — and the footer says when merging changed the total, because a downtime figure that double-counts ends up in a report. Also sums and means of any event attribute, a second dimension as stacked bars or a pivot, days, weeks and months, click to drill down, KPI cards, and targets per group. |
| ![](src/symbols/pvxEventList/icon.svg) | **PVX Event List** | One row per event frame: name, asset, template, start, end, duration and any event attributes (Reason Code, Operator). A filter box, a sort on any heading, groups with subtotals and a total. A click shows the event's time range or asset, or opens another display at both. Each row is the event as recorded, so where events overlap the footer says how much the total counts twice. A click can filter the symbols beside it to that asset, and it can follow such a filter. Optionally, each row can acknowledge the event, read and add comments, and edit named event attributes, each confirmed first. |
| ![](src/symbols/pvxAssetRollup/icon.svg) | **PVX Asset Rollup** | One number across many assets: how many compressors are running, the total rate of every well under an area, the average efficiency per template. The assets come from an AF search under the display's asset, so a unit added in AF is counted without a display edit. Count, total, average, minimum, maximum, median, standard deviation or distinct values, one card per template, parent or attribute value, the largest first and the rest in an Others card worked out from its own assets. Assets without the attribute, bad values and text are counted in the footer. |
| ![](src/symbols/pvxLookupTable/icon.svg) | **PVX Lookup Table** | An AF table on a display, read only: grade specifications, shift rosters, product codes, static or linked to an outside database. Choose and rename columns; filter by typing, sort by any heading, group by a column; keep only the rows that meet conditions such as `Unit = {asset}`, so one shared display shows each unit's rows, or that are dated in the display's time range. One column can be coloured by threshold bands, and a row can open a display named from its cells. |
| ![](src/symbols/pvxAssetTree/icon.svg) | **PVX Asset Navigator** | Browses the live AF hierarchy and sets the display's asset context, so a unit added in AF appears without editing a display. Lazy-loaded, keyboard navigable. Also a flat list or a drop-down for a display header, and a value per row with a status colour. |
| ![](src/symbols/pvxManualEntry/icon.svg) | **PVX Manual Entry** | Writes one value to an attribute or PI point, with range validation before sending and a confirm step before committing. Typed, or with a stepper, slider, switch, a button per choice, or a value button that can write back after a delay (momentary). |
| ![](src/symbols/pvxEntryTable/icon.svg) | **PVX Shift Log** | The same at operator-rounds scale: several attributes, one form, one submit — reporting per row, so three saved and one refused reads as exactly that. A list or a form in columns, with sections and a control per row. Rows can be required, warn outside a soft range, or start prefilled; a block pasted from a spreadsheet or a CSV file fills them; a grid layout takes readings by time slot. |

### Navigation

| | Symbol | What it's for |
|---|---|---|
| ![](src/symbols/pvxGeoView/icon.svg) | **PVX Geo View** | Assets on a map, one marker per data source, coloured by digital state or by threshold band, placed from each element's Latitude and Longitude in AF (PI Web API) or from a typed list. Map tiles come only from a tile server the site names in `pvx-config.js`; without one, a latitude and longitude grid. Drag, zoom, and click a marker to open its asset. |
| ![](src/symbols/pvxDisplayMenu/icon.svg) | **PVX Display Menu** | The site's display tree as a menu bar with nested drop-downs, or a side menu that opens in place: icons, a logo, a back button, switches for kiosk mode and PI Vision's toolbar, time bar and side bar, and a menu button when space runs out. One menu can be kept in an AF attribute, or one per asset. |
| ![](src/symbols/pvxNavPanel/icon.svg) | **PVX Navigation Panel** | Button bar that jumps between displays, swaps the asset context, or sets the time range. A hierarchy mode builds Up, a breadcrumb and the siblings from the current asset, opening each level's own display. |
| ![](src/symbols/pvxSlideshow/icon.svg) | **PVX Display Slideshow** | Rotates a control-room screen through a list of displays. The same config goes on every display in the rotation and each copy works out where it is — pause survives the navigation, and it never rotates while someone is editing the display. |
| ![](src/symbols/pvxTimeRange/icon.svg) | **PVX Time Range** | Presets, a From / To pair (calendar, or PI time expressions checked as they are typed), step back and forward by the span shown, and Now. Sets the display's time by its address, so the browser's Back button undoes it. |
| ![](src/symbols/pvxReplay/icon.svg) | **PVX Replay** | Plays a stretch of history back through the whole display: a window of set length slides from start to end a step at a time, and every symbol follows it. Play, pause, step, a position slider and keyboard keys; pauses itself when the time is changed any other way, and Exit returns to the range shown before. Nothing is saved with the display. |
| ![](src/symbols/pvxEmbeddedPage/icon.svg) | **PVX Embedded Page** | Another PI Vision display, a work instruction or a report in a frame, reloaded on a timer. A display follows this one's asset and time. A page from another site that refuses framing shows blank, and the symbol says so instead of leaving it a mystery, with Open in a new tab beside it. |

Full option reference: **[docs/SYMBOL-REFERENCE.md](docs/SYMBOL-REFERENCE.md)** (generated from the code).

---

## Quick start

Grab the latest [release](https://github.com/willcgage/AVEVAPIVisionSymbols/releases)
— `PvxSymbols-<version>.msi` if you deploy software with an installer, or
`pvx-symbols-<version>.zip` if you copy files. Check it against
`SHA256SUMS.txt`, then on each PI Vision web server, elevated:

```powershell
msiexec /i PvxSymbols-1.15.0.msi /qn /l*v pvx-install.log
```

Or build it yourself:

```bash
npm install          # only needed for the preview/verify tooling
npm run package      # builds dist/ext and zips it
npm run installer    # additionally generates the WiX installer source
```

Install the MSI on the PI Vision server, or copy `dist/ext` there with the
generated `dist/Deploy-PvxSymbols.ps1`, then recycle the app pool and
hard-refresh the browser. Both use the layout AVEVA's extensibility guide
describes: symbol files directly in `ext`, icons in `ext\icons`, and the shared
runtime and site settings in `ext\libraries\pvx`. Both take the
drive and PIPC folder PI Vision is installed in (`INSTALLDRIVE` / `PIPCFOLDER`,
or `-Drive` / `-PIPCFolder`), defaulting to `PIHOME64`. The PVX symbols appear at the bottom of the symbol palette in display
edit mode; pick one and drag an attribute onto the display to place it (any
attribute for the fourteen that take their settings from the format pane alone). That is the whole installation for forty of the fifty.

Dropped the wrong attribute on a symbol? Open its format pane: every PVX
symbol lists its data sources at the top, with **Remove** on each row (click
Remove, then Confirm). Settings that refer to sources by number, such as a
Combo Chart trace spec or a Sankey link, are renumbered to match and the pane
says what changed. A symbol always keeps at least one source. Below the list,
**Text size** scales everything the symbol draws from 70% to 200%, and the
symbol lays itself out again for the larger text rather than overflowing.
Under **Saving and data state**, every symbol can also show a save button
(the symbol as a PNG, its drawing as SVG, its data as CSV, all made in the
browser), a **Stale** badge when its newest value is older than a number of
minutes, and hide itself while none of its sources has a good value. A
**Quick trend** button trends the symbol's sources in a panel that can be
dragged and resized, and the same button on another symbol adds its sources
to that panel; it reads history from PI Web API, and only when pressed. All
four are off until set. A time-series symbol can also keep a **time range of
its own** (the last 30 days beside a display on the last hour, say), read
from PI Web API and named in a badge on the symbol; off, it follows the
display as before.

The other five, and the Asset Table's and Navigation Panel's optional AF
lookups, need one more step: run `ext/piwebapi-check.html` on the server
to find out which PI Web API configuration your network actually permits, then
put the answer in `ext/libraries/pvx/pvx-config.js`.

Full walkthrough — install, confirm, configure, upgrade, roll back, troubleshoot:
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

### Preview without a server

```bash
npm run preview      # http://localhost:8777
```

Opens an offline harness that loads the *built* symbols, feeds them synthetic
plant data, and lets you resize each one, toggle dark mode, open its real
configuration pane, and simulate empty and bad-quality payloads. Nothing here
talks to PI Vision — it is a faithful stand-in for the host, so it is the
fastest way to iterate before touching the server.

---

## Repository layout

```
src/
  shared/
    pvx-core.js        shared runtime -> ext/libraries/pvx/pvx-core.js
    pvx-config.js      site settings template -> ext/libraries/pvx/pvx-config.js
    base.css           base styles, prepended to every symbol stylesheet
  symbols/<typeName>/
    symbol.js  template.html  config.html  styles.css  icon.svg
  tools/
    Deploy-PvxSymbols.ps1   the manual-copy deploy script (copied to dist/)
    piwebapi-check.html     the PI Web API diagnostic -> ext/
tools/
  build.js             src -> dist/ext, with validation
  verify.js            renders every symbol in headless Chromium and checks it
  docgen.js            regenerates docs/SYMBOL-REFERENCE.md from the sources
  serve.js             static server for the preview harness
  probe.js             render one symbol from src/ at any size — the inner loop
dev/
  harness.html         offline preview app
  pv-mock.js           PI Vision host stub + synthetic data generator
dist/                  build output — this is what you deploy
docs/                  reference, deployment, authoring guide, roadmap
```

### npm scripts

| Command | Does |
|---|---|
| `npm run build` | Builds `dist/ext` and validates every symbol |
| `npm run package` | Clean build plus `dist/pvx-symbols-<version>.zip` |
| `npm run watch` | Rebuilds on save |
| `npm run preview` | Serves the offline harness |
| `npm run verify` | Builds, then renders all symbols in headless Chromium |
| `npm run verify:shots` | Same, plus PNGs in `dist/screenshots/` |
| `node tools/probe.js <symbol>` | Render one symbol from `src/` at any size with any config override, and screenshot it — the inner development loop |
| `npm run test:api` | Exercises the PI Web API layer against a mock that is deliberately misconfigured — no CORS, wildcard CORS, a 401 preflight — and asserts each is diagnosed correctly, plus that writes are never cached, retried or coalesced |
| `node tools/docgen.js` | Regenerate `docs/SYMBOL-REFERENCE.md` from the sources |
| `node tools/wix.js` | Generate the WiX installer source from `dist/ext`, with deterministic component GUIDs |
| `node tools/verify-msi.js` | Read a built MSI's own tables and assert it installs what it claims |
| `tools/test-installer.ps1` | On Windows, elevated: install, upgrade from 1.6.0 and uninstall the MSI and the deploy script for real against fake PI Vision trees — CI runs it on every pull request |

---

## How it holds together

**One shared runtime.** `pvx-core.js` deploys to `ext/libraries/pvx`, inside
the folder PI Vision loads before the symbol files. It carries the formatting,
colour, threshold, scale, SVG, data-normalisation, statistics and navigation
helpers, so a symbol file contains only what makes that symbol different.

**One lifecycle.** `PVX.bootstrap()` wires `onDataUpdate` / `onConfigChange` /
`onResize` / `onDestroy` to a single render function, coalesced into one
animation frame. A symbol never renders three times for one update, and never
paints into a stale DOM node.

**One threshold grammar.** `0:#2f9e5f:Normal, 70:#d99024:High, 90:#c8452f:Critical`
means the same thing in every symbol, so an engineering standard can be pasted
across a whole display set. The format pane edits it as one row per band
(limit, colour picker, label) and keeps the string underneath, with an *Edit
as text* switch for pasting. Digital state maps and combo-chart trace specs use
the same shape of string, for the same reason.

**One statistics implementation.** Quartiles, histogram binning (Freedman-
Diaconis), capability indices and the normal CDF live in `PVX.stats`, so the
histogram and the box plot cannot disagree about what a quartile is.

**One statistic-column contract.** PI Vision returns `Summary` cells
*positionally*, matching `config.Columns` — if the operator's chosen aggregate
and that array drift apart, a symbol silently charts the wrong number with no
error. `PVX.config.syncStatColumns()` is the single place that can be wrong,
and the seven Table-shape symbols all go through it.

**Nothing is dropped silently.** Negative values in a treemap, a donut or a
Sankey cannot be drawn as an area or a ribbon. Every symbol that excludes a
source names it in the footer — a display that quietly omits a tag is worse
than one that refuses to draw.

**Authentication is a property of the deployment, not of a chart.** `PVX.api`
holds one PI Web API client with swappable auth — Kerberos, OIDC bearer, Basic
— configured once per site in `ext/libraries/pvx/pvx-config.js`. No symbol knows which
is in use, so changing it later touches one file. Failures carry a specific
cause and a "what to check" line rather than "failed to fetch".

**Writes are treated as irreversible, because they are.** `PVX.api` never
caches, retries or batches a write. Symbols confirm with a human first, validate
before sending rather than after, disable the control while a write is in
flight, and report every row's outcome separately — a shift log where three rows
saved and one was refused shows exactly that.

**Light and dark, automatically.** Symbols sample the rendered background of
their ancestors rather than sniffing PI Vision's theme class names, which move
between releases. Set `Theme` to force one or the other.

**PI Vision's data shapes, normalised.** `PVX.data.single/series/rows/trend`
absorb the payload differences between releases so symbol code only ever deals
with one predictable structure. PI Vision sends labels, units and paths only on
some updates; `PVX.bootstrap` carries them across the rest, per data source.

### Verification

`npm run verify` renders each symbol in real Chromium across 3 sizes × 3 data
scenarios (live, empty, bad-quality) × light and dark — 900 checks — and fails
on thrown exceptions, console errors, `NaN`/`undefined` in SVG geometry, blank
renders, unreadable text, content clipped out of reach, and a placeholder name
("Series 1", "Row 1") left showing after an update that carried no labels. That is the gate to
run before any deployment.

### Adding a symbol

Read **[docs/AUTHORING-CONTRACT.md](docs/AUTHORING-CONTRACT.md)**, copy
`src/symbols/pvxRadialGauge` (the reference implementation), rename it, and
build. The build validator enforces the contract — ES5 only, namespaced CSS,
correct registration, matching `typeName`.

Iterate with the probe rather than the full verify:

```bash
node tools/probe.js pvxHistogram --w 900 --h 480 --config "LSL=100;USL=140"
node tools/probe.js pvxComboChart --dark --config "TraceSpec=1:bar,2:line:right"
node tools/probe.js pvxSlideshow --hash "/Displays/101/Overview"
```

It renders straight from `src/`, so there is no build round-trip, and it picks
its own port — several can run at once.

Where the plan landed: **[docs/ROADMAP.md](docs/ROADMAP.md)**, or **[docs/roadmap.html](docs/roadmap.html)** for a filterable view — 30 roadmap symbols shipped, 3 foundation pieces, and 4 candidates that were declined with the reason on each. `pvxCompare`, `pvxOperatingMap` and `pvxDataHealth` came afterwards, from a gap analysis and a comparison with Grafana and Honeycomb, `pvxAssetTable` from a review against an overview display build guide, `pvxWindRose` from a check of fourteen chart types against the library, and `pvxControlChart`, `pvxTimeRange`, `pvxEmbeddedPage`, `pvxGasTriangle`, `pvxMultiGauge`, `pvxHistoryTable`, `pvxReplay`, `pvxAlarmTone`, `pvxSpectrum`, `pvxCrossProfile` and `pvxEventList` from a feature-level comparison with a commercial widget library.

---

## Licence and third-party code

MIT. No third-party JavaScript is bundled or required at runtime. AngularJS is
vendored under `dev/vendor/` for the offline preview harness only and is never
deployed to the server.

A PI Vision licence does not grant rights to the third-party libraries PI
Vision itself ships — notably Kendo UI. Nothing here uses them.
