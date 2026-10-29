# PVX expansion roadmap

Candidate symbols beyond the shipped library, with the reasoning behind each.

> **Tiers 1 and 2 are complete, and tier 3 is closed by decision.** Fourteen
> tier-1 symbols (v1.1, v1.2), the PI Web API layer and the first symbol on it
> (v1.3), the remaining five PI Web API symbols plus shared acknowledgement
> (v1.4), and `pvxSlideshow` (v1.5). After v1.5, a comparison against
> Grafana's and Honeycomb's chart types added
> `pvxCompare` and two modes on existing symbols (density on `pvxHeatmap`,
> parent/child hierarchy on `pvxEventGantt`).
>
> The other four tier-3 candidates were deliberately not built — see the
> reasoning in the tier 3 table. Nothing on this plan is outstanding.
>
> **Two symbols were added after the plan closed**, from a gap analysis rather
> than from this document: `pvxOperatingMap` and `pvxDataHealth`. See
> [After the plan](#after-the-plan). The library is at **51 symbols**.

## On originality

This roadmap was informed by surveying what the commercial PI Vision symbol
market sells, alongside AVEVA's own documentation for what PI Vision 2025
ships natively.

What that survey provides is a **map of what plant staff repeatedly ask for**.
That is the useful part, and it is not anyone's property. Neither are the chart
types: box plots (Tukey, 1970), Sankey diagrams (1898), Pareto charts,
histograms with Cp/Cpk, radar plots and the Duval triangle (IEC 60599) are
published, decades-old, standard techniques.

What *is* proprietary is a vendor's source code, specific visual designs,
icons and branding. None of it has been read, and none of it is obtainable —
the commercial libraries ship obfuscated to paying customers. Every symbol
below is specified here from first principles against
[AVEVA's public extensibility API](https://github.com/AVEVA/AVEVA-Samples-PI-System/blob/main/docs/PI-Vision-Extensibility-Docs/PI%20Vision%20Extensibility%20Guide.md)
and is implemented the same way every shipped symbol was.

Two practical notes. First, if a commercial product already solves a problem
well and the licence is affordable, buying it is often the right call. That
argument used to point at `pvxEventGantt`, on the grounds that the hard part is
the PI Web API plumbing rather than the chart — and that was true right up until
the plumbing was built and tested in v1.3. The reasoning stands even though this
particular example no longer does: weigh it again for anything where the
integration dwarfs the visualisation. Second, do not distribute a PVX symbol
that is a visual clone of a specific commercial one. Solve the problem; do not
copy the answer.

---

## What PI Vision already does natively

Do not rebuild these. PI Vision 2025 ships: Value, Trend, Radial/Horizontal/
Vertical Gauge, Bar, Time Series Table, **XY Plot**, **Events Table**,
**Asset Comparison Table**, Collections, plus shapes, text, images and video.

PVX already extends five of those (gauge, bar, XY plot with regression,
table-driven status, and now the trend via the combo chart). Anything below
that overlaps a native symbol has to justify itself on capability, not on
looks.

---

## Tier 1 — pure DataShape, no server prerequisites

These need nothing but the existing PVX architecture. They drop straight into
`src/symbols/`, build with `npm run build`, and pass `npm run verify` the same
way the current ten do.

| # | Symbol | Data shape | Effort | Status | Why it earns its place |
|---|---|---|---|---|---|
| 1 | **pvxComboChart** | TimeSeries, multiple | L | **done** | The single most-requested thing PI Vision cannot do. |
| 2 | **pvxStateDuration** | TimeSeries, multiple | M | **done** | Downtime accounting with no Event Frames required. |
| 3 | **pvxHistogram** | TimeSeries, single/multi | M | **done** | Turns a chart into a capability study. |
| 4 | **pvxBoxPlot** | TimeSeries, multiple | M | **done** | "Which of my twelve identical pumps is misbehaving." |
| 5 | **pvxProfile** | Table, multiple | M | **done** | Values along a physical axis, not a time axis. |
| 6 | **pvxDeviation** | TimeSeries, multiple | M | **done** | Time-in-band against setpoint. |
| 7 | **pvxPeriodOverlay** | TimeSeries, single | M | **done** | Today vs yesterday vs the golden batch. |
| 8 | **pvxWaterfall** | Table, multiple | S | **done** | Mass and energy balance, loss accounting. |
| 9 | **pvxRadar** | Table, multiple | S | **done** | Asset fingerprint against a reference profile. |
| 10 | **pvxAnnunciator** | Table, multiple | M | **done** | Latching alarm tiles that survive the excursion. |
| 11 | **pvxTreemap** | Table, multiple | M | **done** | Hierarchical magnitude across a large tag set. |
| 12 | **pvxDonut** | Table, multiple | S | **done** | Low analytic value, high management demand. |
| 13 | **pvxSitePlan** | Table, multiple | M | **done** | Live values pinned to a plant drawing. |
| 14 | **pvxSankey** | Table, multiple | L | **done** | Flow and loss pathways. Topology comes from config. |

### 1. pvxComboChart — multi-type overlay chart

Bars, lines, stepped digital states and shaded limit bands sharing one time
axis, with per-trace type assignment and an optional secondary Y axis.

The native trend draws every trace the same way on one scale. A process
engineer wants production as bars, efficiency as a line on a right-hand axis,
the operating limit as a shaded band, and the run/stop state as a stepped strip
along the bottom — all in one frame, so the eye can correlate them.

Per-trace configuration is the design problem: PI Vision hands the symbol an
ordered list of data sources, so the config pane needs a compact per-index
grammar. Something like `1:bar:left, 2:line:right, 3:band:left#d99024` in the
same spirit as the existing threshold spec.

### 2. pvxStateDuration — time-in-state bars

A horizontal stacked bar per tag showing how long it spent in each digital
state across the display window, with percentage run time and state-change
count.

This is the downtime view most sites actually need, and it needs no Event
Frames, no PI Web API and no AF templates — just digital tags and
`DataQueryMode: 'ModeEvents'`, which returns the actual state transitions
rather than an interpolated sample grid. Availability, number of starts and
mean run length all fall out of the same data.

### 3. pvxHistogram — distribution with capability

Binned frequency with a configurable bin count or width, an optional fitted
normal curve, and optional LSL/USL spec limits driving **Cp, Cpk, Ppk** and
percent-out-of-spec.

Without the spec limits this is a nice-to-have. With them it is a quality tool:
it answers "is this process centred and capable" rather than "what did it do".
That is the version worth building.

### 4. pvxBoxPlot — variability comparison

Quartiles, median, whiskers (1.5×IQR or 5th/95th percentile, configurable),
outlier dots and an optional mean diamond, one box per tag.

`PVX.stats.percentile` already exists, so the statistics are done. The value is
in the comparison: twenty identical assets side by side, and the one with the
wide box or the long upper whisker is the one to go and look at.

### 5. pvxPeriodOverlay — period-over-period comparison

Folds the display's time range into N equal periods and overlays them on a
common relative-time axis — today over yesterday over the day before — with an
optional min/max envelope built from the older periods.

**Design constraint worth knowing up front:** a custom symbol only receives the
display's own time window. It cannot issue its own query for "the same shift
last week" without PI Web API. So the symbol folds a long window rather than
fetching several short ones: set the display to 7 days and it draws seven daily
traces. That is a real limitation, and it is also perfectly usable — the
"golden batch envelope" pattern falls straight out of it.

### 6. pvxProfile — spatial profile

Values plotted along a physical axis rather than time: kiln zone temperatures,
distillation column trays, bearing positions along a shaft, cell voltages
across a stack.

Ordering comes from the data-source order or from a numeric token parsed out of
the tag name. Adds a configurable limit envelope and — the part that makes it
diagnostic rather than decorative — a faded "shadow" profile from earlier in
the window, so drift is visible as a shape change.

### 7. pvxWaterfall — sequential contribution

Floating bars showing how a starting value becomes an ending value through
positive and negative steps, with a running total.

Natural fit for mass and energy balances, yield loss accounting, and
production-vs-plan bridges. Small and well-defined; a good first contribution
if someone else on the team wants to learn the symbol API.

### 8. pvxRadar — multi-variable fingerprint

Three or more normalised axes with the current values as a filled polygon, and
optionally a reference "known good" polygon behind it from config or from a
second set of data sources.

Each axis needs its own min/max because the variables have different units —
that scaling config is most of the work.

### 9. pvxDeviation — deviation from target

Percent or absolute deviation from a setpoint over time, with the acceptable
band shaded, excursions colored, and a time-in-band percentage in the corner.

Reframes a trend around the question control engineers actually ask, which is
not "what was the value" but "how much of the shift was it where it should be".

### 10. pvxAnnunciator — latching alarm panel

A tile panel where a tile lights on excursion and **stays lit until
acknowledged**, with a first-out indicator and a change counter.

The existing `pvxStatusGrid` and `pvxAlarmBanner` both show current state, so a
brief excursion between refresh cycles is invisible. Latching is what makes a
panel trustworthy for an operator who looked away.

Honest limitation: acknowledgement state would be session-scoped, held in the
symbol instance, so it resets when the display is reopened and is not shared
between operators. Real shared acknowledgement needs somewhere to write it —
see Tier 2.

### 11. pvxTreemap — hierarchical magnitude

Nested rectangles sized by one statistic and colored by another, grouped by a
delimiter in the AF path or tag name.

Scales to hundreds of tags in one symbol, which is where `pvxPareto` runs out
of vertical room. Squarified layout is a well-published algorithm.

### 12. pvxDonut — contribution mix

A donut with the total in the centre, smallest slices rolled into "Other", and
a legend with values and percentages.

Analytically weaker than a ranked bar in almost every case — a fact worth
noting in the config pane hint — but management asks for it, and the alternative
is someone pasting a screenshot into Excel.

### 13. pvxSitePlan — hotspots on a drawing

A background image (site plan, P&ID, equipment photo) with configurable hotspot
coordinates, each bound to a data source and rendered as a colored marker with
its value, and optionally clickable to drill down.

This is the offline-friendly answer to a geographic map symbol. Most plants are
air-gapped and cannot reach a map tile provider, and for a single site a scaled
plant drawing is more useful than a satellite view anyway. Hotspots are
configured as `x%,y% | label`, so the same symbol works on any image.

### 14. pvxSankey — flow and loss

Weighted flows between nodes, sized by value, with losses branching off.

The honest difficulty: the PI System has no graph structure to read, so the
topology has to be authored in the config — `Feed > Reactor | 1` style link
definitions referencing data-source indices. That makes it powerful for a
fixed, well-understood process and awkward for anything ad hoc. Layout
(node ranking plus crossing minimisation) is the bulk of the work.

### Considered and deprioritised

**pvxFFT** — technically possible, but PI Vision's `ModePlotValues` returns a
display-optimised decimation, not a uniformly sampled signal. A trustworthy FFT
needs even sampling at a known rate, which means `ModeRecordedValues` over a
short window and client-side resampling, and it only works at all if the tag is
stored with little or no compression. Worth building only against a specific
asset where you can verify the sampling first. Anyone doing serious vibration
work already has a dedicated system.

**pvxDuval** — the ternary plot with IEC 60599 fault zones is well-specified and
not difficult. Purely a question of whether you have dissolved-gas monitoring on
power transformers. If you do, say so and it is a half-day of work.

**pvxValue** — a "better Value symbol" with click-to-trend overlaps
`pvxKpiCard` almost entirely. Better to add a click-to-trend option to the KPI
card than to add a twelfth symbol.

---

## Tier 2 — needs PI Web API

This is a genuine architectural step, not just more symbols. It opens Event
Frames, AF hierarchy browsing and write-back, none of which reach a symbol
through PI Vision's DataShape mechanism.

**How it works — built in v1.3.** AVEVA's own
[PI World lab](https://osicdn.blob.core.windows.net/learningcontent/pdfs/2019%20PI%20World%20Building%20a%20Manual%20Data%20Entry%20Symbol%20In%20PI%20Vision.pdf)
shows the shape of it: a symbol injects `$http` and calls PI Web API, reading
the base URL from `PV.ClientSettings.PIWebAPIUrl`.

PVX does the same thing through `PVX.api`, with two deliberate departures:

1. **The base URL comes from `libraries/pvx-config.js`, not from
   `PV.ClientSettings`.** That setting is not something AVEVA documents as a
   public contract, so building the whole tier on it would mean the library
   breaks on an upgrade for reasons no one can diagnose. An explicit config file
   is duller and cannot be taken away — and it is what the commercial products
   do too.
2. **Authentication is one pluggable strategy in the core, not `$http` calls
   scattered through symbols.** Kerberos, OIDC bearer and Basic are selected per
   site. No symbol knows which is live, so changing it later touches one file
   rather than every symbol that talks to the server.

Full configuration: **[PI-WEB-API.md](PI-WEB-API.md)**.

**Prerequisites, all on the server side:**

- PI Web API installed and reachable from the browser, not just from the PI Vision server.
- Kerberos or Basic authentication configured on the PI Web API AF database.
- CORS configured if PI Web API is on a different host than PI Vision: `CorsOrigins` set to the PI Vision URLs, `CorsSupportsCredentials` true, and `CorsMethods` covering the verbs you use.
- Requests carry the signed-in user's identity, so **PI/AF security is the access control**. For any write-back symbol, confirm who has write access to those attributes before deploying it — that is a security decision, not a display decision.

Sensible order:

| # | Symbol | Status | Why |
|---|---|---|---|
| — | **`PVX.api` + `pvx-config.js`** | **done** | Not a symbol: the pluggable PI Web API client every symbol below depends on. Kerberos / OIDC bearer / Basic, chosen once per site. |
| — | **`ext/piwebapi-check.html`** | **done** | Not a symbol: the connectivity diagnostic that tells a site which configuration actually works before anyone commits to one. |
| — | **`PVX.ack`** | **done** | Not a symbol: the shared-acknowledgement store behind `pvxAckStore`, wired into `pvxAnnunciator` as its `SharedAck` option. |
| 15 | **pvxEventGantt** | **done** | Event Frames as timeline swimlanes. The native Events Table is a list; a Gantt shows overlap, clustering and pattern — which is the whole point of looking at events. |
| 16 | **pvxEventAnalytics** | **done** | Pareto and duration statistics over Event Frames by template or attribute. The downtime accounting a native list cannot do. |
| 17 | **pvxManualEntry** | **done** | Write a value to an attribute or PI point from the display. Consistently the #1 seller in this market, because the alternative is a spreadsheet and a retype. |
| 18 | **pvxEntryTable** | **done** | Multi-row shift-log capture — the same thing at rounds scale. |
| 19 | **pvxAssetTree** | **done** | Browse the live AF hierarchy and set the display's asset context. `pvxNavPanel` only offers a static configured list. |
| 20 | **pvxAckStore** | **done** | Shipped as `PVX.ack` plus `pvxAnnunciator`'s `SharedAck` option rather than as a symbol of its own — acknowledgement is a property of the annunciator, and a separate palette entry would have been a thing to place on a display that draws nothing. |

That advice — build one read-only symbol first to prove the path — was taken.
`pvxEventGantt` shipped in v1.3 and is exercised against a mock PI Web API that
is deliberately misconfigured six different ways. What is *not* yet proven is
your specific network: run `ext/piwebapi-check.html` on a PI Vision server to
settle that, and see **[PI-WEB-API.md](PI-WEB-API.md)** for the configuration.

---

## Tier 3 — utility and control-room

Only the slideshow was built. The other four were considered and declined, and
the reasons are recorded here so nobody re-proposes them without new
information.

| # | Symbol | Status | Notes |
|---|---|---|---|
| 21 | **pvxTimePicker** | built later as `pvxTimeRange` (see *After the plan*) | Calendar plus a PI-time expression field. PI Vision's own time control already does this competently, and `pvxNavPanel` covers presets. A third way to set the time range is a way to disagree with the other two. |
| 22 | **pvxSlideshow** | **done** (v1.5) | Rotates a control-room screen through a list of displays with a pause-on-interaction timer. The subtlety is that navigating destroys the symbol, so the same config goes on every display in the rotation and each copy works out where it is. |
| 23 | **pvxWebView** | built later as `pvxEmbeddedPage` (see *After the plan*) | An iframe for a work instruction, camera feed or report. Blocked by the target's `X-Frame-Options` more often than not, and when it does work it is a browser feature rather than a PI Vision one. Low value for the support burden it would generate. |
| 24 | **pvxAlarmSound** | not building | Browsers block autoplay until someone interacts with the page, so it needs a click after every reload — on exactly the unattended kiosk nobody is standing at. And in a control room the DCS annunciator is the right layer. The idea is sound; the platform is wrong for it. |
| 25 | **pvxMap** | not building | Needs a tile provider most plant networks cannot reach. `pvxSitePlan` (#13) already covers the single-site case better and needs no external service. Revisit only if you have a genuine multi-site geographic need and network access to match. |

---

## What has shipped

**v1.1** added the six analytics symbols: combo chart, time-in-state, histogram
with capability, box plot, spatial profile, deviation from target.

**v1.2** closed out tier 1 with the remaining eight: annunciator, waterfall,
radar, period overlay, treemap, donut, site plan, Sankey.

What those two rounds added to the shared core, and therefore to anything built
after them:

- `PVX.stats.quartiles / histogram / capability / normalPdf / normalCdf /
  stddev / mean` — one implementation of the statistics, so the histogram and
  the box plot cannot disagree about what a quartile is.
- `PVX.data.stateSeries / stateRuns` — digital tags survive normalisation
  (`data.series` discards non-numeric samples by design) and collapse into
  clipped runs with per-state totals.
- `PVX.config.TABLE_STATS / statKey / statLabel / statColumns /
  syncStatColumns` and `PVX.data.statValue` — the positional `Summary` contract
  in one place. Seven Table-shape symbols depend on it; without it, seven
  copies of the same subtle bug.
- `PVX.fmt.duration` — bare durations, distinct from "time since".
- `tools/probe.js` — renders one symbol straight from `src/` at any size with
  any config override, on its own port. The inner development loop.
- An `@mock digital` header tag, so the harness and the verifier feed a state
  symbol realistic transitions rather than a numeric signal it could never
  receive in the field.

**v1.3** built the tier-2 foundation and the first symbol on it:

- **`PVX.api`** — one PI Web API client with swappable authentication
  (Kerberos/IWA, OIDC bearer, Basic, anonymous), batched requests via
  `/batch`, a short shared GET cache, and errors that carry a specific cause
  plus a "what to check" line instead of "failed to fetch". Authentication is a
  property of the deployment, not of a chart, so no symbol knows which strategy
  is live and changing it later touches one file.
- **`libraries/pvx-config.js`** — the per-site settings file, and the only file
  in the library `Deploy-PvxSymbols.ps1` refuses to overwrite.
- **`ext/piwebapi-check.html`** — the connectivity diagnostic. It ships inside
  the ext folder because it has to run from the PI Vision origin to reproduce
  the conditions a symbol faces; opened from anywhere else it would test a
  different origin and answer confidently wrong.
- **`pvxEventGantt`** — Event Frames as swimlanes, proving the layer end to end.
- **`tools/test-api.js`** — the layer is tested against a mock PI Web API
  deliberately misconfigured six ways (no CORS, wildcard CORS, a 401 preflight,
  auth required, forbidden, healthy) and each is asserted to be diagnosed
  correctly.
- **[PI-WEB-API.md](PI-WEB-API.md)** — the setup guide, written from AVEVA's own
  guidance.

**v1.4** completed tier 2:

- **`pvxEventAnalytics`** — downtime accounting. Durations are clipped to the
  window, overlapping events within a group are merged before summing, and the
  footer discloses when merging changed the total and how many open events were
  counted to now. A downtime figure that double-counts ends up in a report.
- **`pvxAssetTree`** — lazy-loaded AF hierarchy with keyboard navigation, which
  sets the display's asset context so every other symbol follows.
- **`pvxManualEntry`** and **`pvxEntryTable`** — write-back, with validation
  before sending, a confirm step, the control disabled while in flight, and
  per-row outcome reporting.
- **`PVX.ack`** — shared acknowledgement, wired into `pvxAnnunciator` as
  `SharedAck`. Off by default, since it needs an AF attribute a site must
  provision.
- **`PVX.api.readValue / readValues / writeValues`** to support the above.

**v1.5** added `pvxSlideshow` and closed tier 3 by decision rather than by
building it out. The slideshow's real design problem is that navigating away
destroys the symbol, so a naive implementation rotates once and stops: the same
configuration goes on every display in the rotation, and each copy reads the URL
to work out where it is and what comes next. Pause is held in `sessionStorage`
so it survives the navigation, and rotation is suspended entirely while
`runtimeData.isEditMode` is true — a display that navigates away under an
engineer mid-edit is a symbol nobody places twice.

Six defects the visual review and the api tests caught that the automated
render gate could not, all fixed at the root so they cannot recur:

1. `PVX.theme.isDark` was sampling a symbol's own painted background instead of
   its surroundings, so the first frame could latch the light palette on a dark
   display. It now probes from the parent element.
2. Glyph-width estimation was replaced with `getComputedTextLength` measurement
   anywhere a panel or label has to contain its own text. The estimate was
   generous in the test harness font and tight in Segoe UI, which is what PI
   Vision actually ships — so panels fit in development and spilled in review.
3. `PVX.util.node` returned nothing when a template began with an HTML comment,
   because jqLite index 0 was then a comment node. Two symbols rendered
   silently blank.
4. A host wrapped in `ng-if` was captured once at init and then drawn into
   after Angular had destroyed and recreated it — wrong node, wrong size.
5. The build validator's comment-stripper does not understand regular-expression
   literals, so it had been silently skipping regions of `pvx-core.js` rather
   than checking them. False negatives only, now documented, with library files
   exempted structurally instead of by matching on message text.

6. Shared acknowledgement lost an acknowledgement every time two operators
   acknowledged different alarms at once. Read-merge-write is not enough without
   a compare-and-swap, which PI Web API does not offer. Writes now verify
   afterwards and retry if clobbered — found by a test written before the code
   was believed, not after it was doubted.

And one finding that came out of testing the api layer rather than a symbol: a
**partial pass** — anonymous requests succeeding while credentialed ones fail —
is more dangerous than an outright failure, because it looks like success.
Configuring `auth: 'anonymous'` on the strength of it would stop PI Web API
identifying users, making every symbol one identity and manual data entry
unattributable. The diagnostic now names that case explicitly.

## After the plan

In October 2026 the owner asked what the library was still missing, and the
answer was not more analytics. The thirty symbols cover reporting and analysis
well; what they lacked was the operator layer of an ISA-101 style display, and
any way of telling a dead tag from a quiet one. Two symbols were built from that
review, on the owner's explicit go-ahead — the "let usage decide" rule below was
weighed and set aside for these two, not forgotten.

| Symbol | Data shape | Why it earns its place |
|---|---|---|
| **pvxOperatingMap** | TimeSeries, X + Y + optional curve string | A compressor map lives in a vendor PDF, so surge margin gets checked by eye. Draws surge, control, speed and stonewall lines from a curve spec and puts the live point on it with a trail. The spec can be an AF string attribute, so the map follows asset swapping. |
| **pvxDataHealth** | TimeSeries, many, `ModeEvents` | The commonest way a display lies is a dead tag. Lists only the bad, out-of-range, stale and flatlined ones. Helps the PI Web API deployment too, by showing which tags are actually reporting. |

Both are pure DataShape and need no PI Web API. Two things they cannot do from
PI Vision's data pipeline, recorded so nobody rediscovers them:

- **Questionable and Substituted** are not passed to symbols, only good/bad, so
  `pvxDataHealth` cannot show them without going through `PVX.api`.
- **Stale versus steady** cannot be told apart from archived events alone. A
  healthy tag holding steady archives once per CompMax, so the stale limit has
  to sit above it, or the tag needs an entry in `UpdateOverrides`. This should
  be checked against a real server before the distinction is trusted.

Other candidates from the same review — a read-only loop faceplate, ISA-101
normalized analog bars, an SPC control chart — were left for usage to decide.

Later the same month the owner had an overview display build guide reviewed
against the library, and asked for what it was missing. One symbol came of
it, plus features on existing ones (KPI Card plan source and status edge,
Navigation Panel hierarchy mode, Ranked Bar click-through, Event Timeline
scoped to the current asset, Combo Chart dashed traces, a text size control
on every symbol):

| Symbol | Data shape | Why it earns its place |
|---|---|---|
| **pvxAssetTable** | Table, many; or PI Web API | The overview table of units by attribute that PI Vision's own table cannot pivot: per-cell limits, a worst-cell status dot, a row that opens the unit's display. In search mode it lists the elements under the current asset, so an asset swap to an area with more units gets more rows. |

A check of fourteen common chart types against the library (spiral, funnel,
bubble, polar, pyramid, doughnut, chord, concentric, wind rose, timeline and
their stacked variants) found doughnut and timeline covered and most of the
rest answered better by an existing symbol. Two additions came of it:

| Symbol | Data shape | Why it earns its place |
|---|---|---|
| **pvxWindRose** | TimeSeries, direction + speed | Dispersion, odour and drift questions are direction questions, and a trend of a 0-360 tag cannot answer them. Stacked polar bars of time share by direction and speed band; also covers plain polar and percent-stacked polar. |
| *bubble mode on pvxXYScatter* | TimeSeries, third source | A third tag sets each point's area, paired by time like X. |

Spiral charts, funnel, pyramid and chord were declined: each restates a
question that pvxPeriodOverlay, pvxHeatmap, pvxWaterfall or pvxSankey already
answers in a form that is easier to read values from.

A feature-level comparison with a commercial widget library (read option by
option from its public documentation) produced a build
order of 37 items, ranked from easiest to hardest, with pipeline-only work
before work that needs PI Web API and anything that writes last. Every item
adds options and keeps the current defaults, so a saved display looks the
same after an upgrade, and nothing where PVX is already ahead (AF-shared
acknowledgement, flatline detection, Cp/Cpk on the histogram, the Sankey
balance check, PI Vision 2019 support) is replaced to match it. New
symbols take PVX names of their own.

Done so far, in order:

| # | Change | What it adds |
|---|---|---|
| 1 | **pvxControlChart**, new | pvxHistogram answers "is this process capable"; a control chart answers "is it still the same process", which needs time order. I-MR, X̄-R and X̄-S, Nelson and Western Electric rules with configurable run lengths, limits from the window, a baseline, typed values or data sources, Cpk from within-subgroup sigma beside Ppk from overall sigma. |
| 2 | pvxBoxPlot | One box per hour, shift, day or week of one source, with an overlay line for a setpoint or limit (typed, or from a data source). |
| 3 | pvxHeatmap, pvxEventGantt, pvxNavPanel | Clicking a cell or a bar sets the display time to it; navigation buttons take an icon, a tooltip, and an address from the data source's value. |
| 4 | pvxDonut, pvxHistogram, pvxSankey, pvxHeatmap | Half donut; time-weighted histogram with quantile markers; fixed flows typed into the Sankey links; one color scale per heatmap row. |
| 5 | Site theme | A palette, status colors, surface and text colors, a font and a card style set once in `pvx-config.js` for every symbol on the server. |
| 6 | **pvxTimeRange**, new | Presets, a From / To pair, stepping by the span, and Now. Reverses the earlier decision against `pvxTimePicker`, on the owner's call to build every item: a time control placed on the display itself, with the site's own presets and an expression checked before it is applied. |
| 7 | **pvxEmbeddedPage**, new | A page in a frame with a reload timer. Reverses the decision against `pvxWebView` by meeting its objection head on: PI Vision displays always load, and for any other site the symbol names the possibility that it refused framing and offers it in a new tab. |
| 8 | pvxComboChart | AF event frames shaded behind the traces, named along the top, colored by template; a click can show the event. Off by default. |
| 9 | pvxAssetTree | A flat list and a drop-down layout beside the tree, and an attribute's value on every row with a dot colored by threshold bands or digital state. |
| 10 | Settings kept in AF | `PVX.af` reads AF limit traits and string attributes. The Control Chart can take its control limits (Hi/Lo, Target as centre) and its spec (LoLo/HiHi) from the charted attribute's traits; the KPI Card's plan can be the attribute's Target; the Navigation Panel's buttons can come from one AF string attribute shared by every display. Each re-reads once a minute and names what is missing. |
| 11 | **pvxGasTriangle**, new | Duval's Triangle 1 from IEC 60599 for dissolved gas analysis: methane, ethylene and acetylene as shares of their total, plotted in the seven fault zones with a fading trail over the time range and the zone named in the footer. Gases are matched to sources by name; a minimum total withholds the diagnosis when the levels are too low to mean anything. The zone rules are tested against the drawn outlines at 20,100 points. |
| 12 | pvxKpiCard | A typed target beside data source 2 and AF; a tolerance within which the change reads On target with no arrow; progress toward the plan as a bar or ring, measured from a chosen zero; time-weighted average, total over time for a rate, standard deviation and percent good as headline or footer statistics; the timestamp as a date, a time with seconds, or an age. |
| 13 | pvxRadialGauge, pvxBarIndicator, **pvxMultiGauge**, new | Both gauges can dim every band but the value's, put major ticks and labels on the band limits, draw minor ticks and run the scale the other way; the bar adds a thermometer style. Several pointers on one scale is a new symbol rather than an option: the two gauges keep PI Vision's Gauge data shape, single-source, which is what lets them follow the scale PI Vision derives from an attribute, and changing that would put every saved gauge at risk. PVX Multi-Pointer Gauge takes several sources on the Table shape the library's other multi-source symbols already use, as needles, markers or rings on a dial or markers or bars on a bar. |
| 14 | pvxPeriodOverlay | Each period as its change, or percent change, from a baseline at the same point in the period (the median of the older periods, or the period before), around a zero line; calendar months as a period, on a day-of-month axis; and further data sources, each drawing its current period on the same axis in its own color, against its own baseline when change is shown. The symbol took one source until now; a display saved with one draws as before. |
| 15 | **pvxHistoryTable**, new | A row per time and a column per data source, from recorded values: the value at clock-aligned times (linear or held), a statistic per interval (time-weighted, as PI's own summaries are, so an interval with no sample still has edges), or every archived value. Grouping by day, week or month, a totals row that suits the statistic, threshold colors, and a CSV button that saves the rows shown, made in the browser by a new `PVX.download`. Values that are not numbers are shown as text and counted out of statistics. |
| 16 | Every symbol | Three options in every format pane, all off: a save button for the symbol as a PNG image, its drawing as SVG, or its data as CSV, made in the browser; a Stale badge when the newest value is older than a set number of minutes, left off while the display looks at the past; and hiding the symbol while none of its sources has a good value. Built once in `PVX.overlay`, so no symbol opts in. |
| 17 | **pvxReplay**, new | Plays history back through the whole display: a window of set length slides over a chosen stretch a step at a time, by the same address change as the Time Range symbol, so every symbol follows and Back undoes a step. Play, pause, step, jump to either end, a slider, keyboard keys, and a loop; it pauses itself when the time is changed any other way, and Exit returns to the range shown before. One second between steps is the least, because each step reloads the display. |
| 18 | **pvxXYScatter** | Every source after X can be plotted against it, each in its own color with its own fit, instead of the second alone; a gate source keeps only the points taken while it is in a range (a pump running, a unit on line) and is not plotted; a fit of degree 2 or 3 beside the straight line, solved on scaled X so process values near 1500 keep their digits; and an envelope drawn as any polygon, with the points outside it counted. The defaults draw the chart as before. |
| 19 | **pvxAlarmBanner**, **pvxAnnunciator** | A deadband on both, in units or as a percentage of the limit: a band is entered at once and left only that far below its limit, so a value sitting on a limit no longer raises and clears on every update. A History mode on the Exception Banner lists each excursion in the display's time range, newest first, with its start, end (or active), duration, worst band and peak, from each source's recorded values read through PI Web API and run through the same bands, state map and deadband. A start before the range is marked as such, and a source it cannot read is named. |
| 20 | **pvxAlarmTone**, new | A tone made with the browser's Web Audio API when a source goes into alarm, by the same bands, state map and deadband as the other alarm symbols: five tones, another for the highest band if wanted, a volume and a repeat. Browsers allow sound only after a click, so it asks for one and arms on it. A click silences this screen only; with shared acknowledgement on it reads the Annunciator's AF record, read only, so an acknowledgement anywhere silences every screen. Rising to a worse band sounds again. No sound files, so no web.config change. |
| 21 | **pvxSpectrum**, new | Which cycles are in a tag and how big each is: recorded values resampled onto an even grid (the footer says how many values made it), the level or slope removed, a Hann, Hamming or Blackman window, and an FFT, with amplitude in the tag's own units or in decibels. Frequency in Hz, per minute or per hour, chosen by the data unless set, on a linear or log axis. The largest peaks are marked with frequency and period; bands with an optional limit turn red and are named in the footer when anything in them is larger. The save button writes the spectrum as CSV. |
| 22 | **pvxCrossProfile**, new | One data source per position across a sheet, web, kiln or stack: a map of position against time, newest at the top, each cell the average of its interval and colored by its distance from a target (or by value); under it the current profile, the average profile and a band of two standard deviations over time at each position. The footer gives the 2-sigma across the current profile and the average 2-sigma along time at one position. Positions in listed order or by the number in each name. `pvxProfile` keeps the one-moment profile with limits; this adds the time it lacks. |
| 23 | **pvxEventList**, new | One row per event frame, read only, from PI Web API: name, asset, template, start, end, duration and any event attributes, in the columns and order set in the pane. Rows can be filtered by typing, sorted by any heading, and grouped by template, asset or an attribute value, with a subtotal per group and a total; attribute columns can total their numbers. A click shows the event's time range or its asset on this display, or opens another display at both. Each row keeps the event's whole duration, so the total is the sum of the rows and the footer says how much of it overlapping events count twice; Event Analytics still merges and clips for a downtime figure. |
| 24 | **pvxPeriodOverlay** | Runs from event frames: with the period set to *Runs from event frames*, each batch, campaign or start-up in the display's time range is one trace, cut from the first source's values at its start and end. Runs line up at their start, at their end, or stretched to 0..100% of their own length. Runs named as golden (names, with wildcards) are always shown, and their average with a tolerance of a percentage, a fixed amount or standard deviations replaces the envelope; the current run is measured against it. Only the event frames come from PI Web API; the values are the pipeline's, so a run that began before the time range is drawn from where it starts and counted in the footer. The clock periods are unchanged. |
| 25 | **pvxAssetRollup**, new | One number across many assets, from an AF search through PI Web API: the elements under the display's asset (or a Search root, or the source's element; a database works too), of one template and name filter, all the way down or one level. One attribute is read from each in a single batch, and a count (optionally of chosen values, such as `Running, Starting`), total, average, minimum, maximum, median, sample standard deviation or count of distinct values is taken. Cards split by template, parent element or another attribute's value, sorted by value or name, the first N kept and the rest folded into an Others card that is worked out from its own assets, with an optional first card over every asset. Threshold bands or a target color the cards, neither set by default. A parent card can open that asset. Assets without the attribute, bad quality, text where a number is needed, mixed units, hidden groups and a capped search are each said in the footer. |
| 26 | Every symbol, **Quick trend** | A fourth option in every format pane, off by default: a button that opens a floating panel trending the symbol's data sources, dragged by its header and resized from its corner. The same button on another symbol adds its sources to the open panel (up to eight, never the same one twice), and each can be taken off again. The range is the display's own, following it, or the last hour, 8 hours, day, week or month; a live range re-reads every minute. One axis when the units agree, else each trace on its own scale, said in the footer with each range; the pointer reads every trace at its time. History is PI Web API plot values, one request per source sized to the panel, asked only when the button is pressed: PI Vision's pipeline cannot add sources at run time. Bad values, states and text are counted, not drawn, and a source PI Web API does not know is named. |
| 27 | **pvxLookupTable**, new | An AF table on a display, read only, through PI Web API (`tables/{webId}/data`), static or linked to an outside source: AF does the linking. The table is found by name in the database's Library, and a wrong name lists the tables there. Columns chosen, ordered and renamed (`Name | Header`); a filter box, a sort on any heading, groups by a column; row conditions, one per line (`= <> < <= > >=`, `contains`, `starts`, `in A, B`), where `{asset}` is the display's asset's name; rows limited to the display's time range by a date column; one column colored by threshold bands; a row click shows the asset in an asset column or opens a display whose name takes `{Column}` values; CSV. Re-read on a timer (default five minutes); the time range and asset only re-filter. Every row and column left out is counted or named in the footer. Writing to a table is not part of this item. |
| 28 | Every time-series symbol, **own time range** | Off by default. On, the symbol shows a range of its own (`*-30d`, `y` to `t`, a date) whatever the display is set to, with a badge saying so ("Last 30 days", "Yesterday"). PI Vision cannot send a custom symbol another range, so the bootstrap swaps the pipeline's values for PI Web API recorded values over that range before the symbol sees them: the nineteen time-series symbols get it with no code of their own, keep the names PI Vision sends, and see each source's start and end set to the range. Read again while the range ends at now (every minute by default), not on every update; at most 10,000 values per source, and the badge warns when a source hit that or could not be read. Without PI Web API the symbol keeps the display's range and the badge says the setting is not in force. |
| 29 | **pvxManualEntry**, **pvxEntryTable** (Shift Log) | Controls for entry, shared by both through a new `PVX.entry`: a stepper (− and + by a set step, rounded to it and kept inside the limits), a slider (between the minimum and maximum), a switch (True/False, 0/1, or two digital states, with captions), a button per choice, and on Manual Entry a value button that writes one value, which with a write-back value and a delay is a momentary button (1, then 0 two seconds later). A switch or a row of buttons shows the value PI holds until somebody picks; a pick not yet written is outlined. Manual Entry can write as soon as a switch, button, slider or dropdown is used, still through the confirmation. The momentary write-back is sent once with no confirmation of its own, holds the button until it has gone, is sent at once if the display closes in between, and when it fails says what the attribute may still hold. The Shift Log takes a control as a fifth field per row (`switch`, `buttons:Auto/Manual/Off`, `slider:5`, `stepper:0.5`, `select:1=A/2=B`, `text`, with `wide` for a full row), `[Name]` lines as sections, and a form layout of columns that drops a column when the symbol is too narrow for it. Choices that are all numbers are written as numbers, other choices as state names, a plain switch as a Boolean. An untouched slider writes nothing, and a row whose control cannot be read is marked and never written. Defaults draw both symbols as before. |
| 30 | **pvxComboChart** | A digital tag drawn as shaded bands behind the traces, one lane per tag, colored by state (`StateColors`, edited as rows), with each run's state and length on hover. A range type that shades between a source and the next one, for a minimum and maximum pair. Per trace, a moving average over a count of values or a time (`ma20`, `ma1h`) and a straight-line fit with its slope per hour and R² on hover. One panel per trace (`Panels`), each with its own scale over one time axis, falling back to a shared plot with a note when the symbol is too short. Logarithmic left and right scales, ending on a 1, 2 or 5 and counting the values at or below zero they leave out. Two rulers placed by clicking and moved by dragging, with a table under the chart: both times and the span, then per trace the value at each, the change, and the minimum, maximum, time-weighted average, standard deviation, count and trend between them. The legend already showed the latest value (`ShowValues`), and still does, now also for state bands. Defaults draw the chart as before. |
| 31 | **pvxDisplayMenu** (new) | The site's display tree as a menu: a bar with nested drop-downs (opened by a click or by pointing), or a side menu whose entries fold open in place, nested by indenting the lines of one text field. Entries open a display (keeping or setting the asset and time) or a web page, take an icon and a tooltip, and the current display is marked along with every menu above it. A logo (a link if wanted), a back button, and switches for kiosk mode and PI Vision's toolbar, time bar and side bar, which now stay set as any PVX navigation moves between displays. It collapses to a menu button when the entries do not fit, or always. The menu can be kept in an AF string attribute, one for the site or, written as `|Attribute`, one per asset. Arrow keys and Escape work through the menus. Drop-downs are drawn on the page, so they open over the rest of the display. The icons moved to `PVX.icons`, shared with the Navigation Panel, which gains the new ones. |
| 32 | **pvxGeoView** (new) | Assets on a map, one marker per data source, colored by digital state (`StateMap`, as rows) or by threshold band, with a legend, names, values and a tooltip of each. A marker is placed from its element's Latitude and Longitude attributes in AF (names are settings; read through PI Web API once a minute) or from a typed list matched by label, element name or path; every source without a place is named in the footer with the reason, and so is a list line that does not read. The map is Web Mercator tiles from a server the site names once as `map.tileUrl` in `pvx-config.js` and from nowhere else; without one, a latitude and longitude grid and a footer saying how to add the map. Starts fitted to every marker or at a fixed place and zoom; drag to pan, the wheel or + and − to zoom, a button to fit again, none of which act while the display is edited. A click on a marker can show its asset or open a display for it. The projection is `PVX.geo`. |
| 33 | **pvxEventAnalytics** | An analytics engine over the event frames it already fetched. The ranked figure can be the sum, mean, median, lowest, highest or standard deviation of any numeric event attribute (lost production, scrap), in its own units; an event with no number for it is counted in the footer, never taken as zero. A second dimension (`SplitBy`) stacks each bar by another attribute, template, asset or period, as counts or to 100%, with a legend. Groups and splits can be days, weeks, months or days of the week: every period in the window in date order, empty ones included, an event's time split at midnight and its count kept where it started. A click can drill down two more levels (`DrillBy`, `DrillBy2`) with a trail back, from the same events and no new query. Two new charts: a pivot of groups by split values with row, column and grand totals and shading, and KPI cards with a total. Targets per group (`Group \| 4h`, `* \|` for the rest) put a mark on each bar, target and Δ columns in the table, a verdict on each card, and can color the bars. Totals are computed from the events (a true mean, time covered once), and a table can show them as a row. Defaults draw the chart as before. |
| 34 | **pvxPareto**, **pvxTreemap**, **pvxRadar**, **pvxComboChart** | An AF search as the rows (`SourceMode: search`, `PVX.afsource`): the elements under a root (the display's asset, else `SearchRoot`, else the data source's), of a template and name, searched once, with the attributes named in the pane read in one batch per refresh, as values, a statistic over the range (summary) or plot values. A fourteenth compressor appears without the display being edited. A badge on the symbol says how many assets were found and names any without an attribute, a search cut short at `SearchMax`, or a failed read. The Ranked Bar ranks the first attribute and names the rest as not used; the Treemap sizes by the first and colors by the second, paired by asset, and gains *Parent asset in AF* grouping and a drill into a group with a trail back; the Fingerprint draws one outline per asset over the attributes as axes (three or more), or the assets as axes (one or two), up to `MaxShapes`, with a missing attribute a dent at the centre and counted; the Combo Chart draws a trace per asset. Defaults keep the data sources. Mock-proven only. |
| 35 | **PVX.filter**: pvxAssetTable, pvxPareto, pvxEventList | Shared filters between symbols on one display. A click set to *Filter the symbols beside it* publishes the row's, bar's or event's asset to a channel on the page (`FilterChannel`, blank is `main`); a symbol with `FilterObey` shows only that asset and what is under it, says how many rows it hid, and wears a badge naming the filter that clears it on click. The picked row is marked, and a second click clears it. A link can preselect one with `filter=` (or `filter.<channel>=`) and asset paths. The display's own asset is untouched. Nothing is stored; a reload starts unfiltered. Defaults are off. Mock-proven only. |
| 36 | **pvxEntryTable** | Data entry upgrades to the Shift Log. A sixth row field takes options: `required` (the sheet is not sent while it is blank), `warn lo:hi` (a soft range), `prefill last`, `prefill user` (the viewer's name from PI Web API's `system/userinfo`) or `prefill <text>`. `LimitMode: soft` lets a value outside min:max through after the confirmation names it; any warned value forces the confirmation. `ExistingValues` sets PI Web API's `updateOption` (replace, the default and what was always sent, insert, or protect, which first reads the value at that exact time and keeps it). `AllowQuestionable` puts a box on each row that writes PI's questionable flag. `PasteRows` fills the rows from a block pasted from a spreadsheet (down the rows, or by a row's name in the first cell), and `ShowImport` reads a CSV of `name,value,time` lines; nothing is written until submit and anything not placed is said. `Layout: slots` is a grid of readings by time slot (`SlotStart`, `SlotInterval`, `SlotCount`): each cell shows what PI holds in that slot, writes at the slot's time, and the slots stay put while anything is typed. Defaults leave saved sheets unchanged. Mock-proven only. |
| 37 | **pvxAssetTable**, **pvxEventList**, `PVX.writer` | Writes from symbols whose job is reading, through one shared panel (`PVX.writer`) with the Shift Log's rule: the value, the stream and the time are stated in full and confirmed, there is no undo, and PI Web API's own reason is shown when it refuses. The Asset Table's `EditMode` (off; `EditColumns` names the columns, blank is all) writes a clicked cell at the current time, checked as a number, a True/False choice or text by what the cell holds, to the stream found from the search or by `attributes?path=` for a data source, then reads it back. The Event List's `EventActions` (off) puts Ack (only where PI says the event can be and is not yet), Note (the event's annotations, and a box to add one) and, for the attributes in `EditAttributes`, Edit at the end of each row, and reads the list again after each; a new `ack` column says who acknowledged and when. A 403 now quotes PI Web API's own words. Proven against a mock PI Web API only (`test-overview --only writes`, 24 checks). |

That completes the 37 items of the comparison.

### Actual, target and forecast

On 2026-10-29 the owner asked which chart best tracks actual against target
against a forecast, and then for one built for it. The Combo Chart can draw the
three traces, but it cannot say what matters about them, and nothing in the
library drew past "now".

| Symbol | What it adds |
|---|---|
| **pvxTargetForecast**, new | The actual solid, the target as steps (a plan or setpoint holds until changed) with an optional tolerance in units or percent, and the forecast dashed, fainter before now and full after, with an optional range from two more sources (P10 and P90). The time after now is shaded and the now line drawn. Tiles give the actual and target at the latest actual value, the gap (in units or percent, in or out of tolerance), the forecast's last value against the target then and the first time it crosses the target (a step that jumps over the forecast counts, at the step), and the forecast error so far: mean absolute difference and bias over the actual samples inside the forecast. Roles are picked by name or taken in order; sources with no role are counted. The target can be a source, a typed value or the actual's AF Target trait. PI Vision sends nothing after the display's end, so a forecast past now needs a display ending in the future (`*+8h`) or `LookAhead`, which reads the forecast, its range and a target source from the display's end through PI Web API, once a minute, and stands down on a display that ends before now. Mock-proven only. |

## What next

Nothing on this plan is outstanding. Thirty symbols; tiers 1 and 2 built, tier 3
closed by decision.

**The next step is deployment, not development.** Everything in tier 2 is
verified against mocks that were deliberately misconfigured six ways — a good
proxy, and not the same as your network. In order:

1. Run `ext/piwebapi-check.html` on a PI Vision server, signed in as a normal
   user. Settle which authentication actually works.
2. Put the result into `libraries/pvx-config.js` on **every** PI Vision server.
   The ext folder is not replicated between nodes.
3. Deploy the read-only symbols first. `pvxEventGantt` is the one to watch,
   because it exercises the whole PI Web API path without being able to write.
4. Only then `pvxManualEntry`, and read the write-access section of
   [PI-WEB-API.md](PI-WEB-API.md) first. PI and AF security are the access
   control; that is a conversation with whoever owns AF security, not a display
   decision.

**Then let usage decide what comes next.** Thirty symbols is a large palette to
introduce at once. Which ones people actually place on displays is better
information than this document has ever had — and a symbol nobody places is
worse than one that was never written, because it still has to be maintained.

If something is missing after that, it will be a specific gap with a specific
display behind it, which is a far better brief than any of the entries above
started from.
