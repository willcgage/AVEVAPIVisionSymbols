# PVX expansion roadmap

Candidate symbols beyond the shipped library, with the reasoning behind each.

> **Tiers 1 and 2 are complete, and tier 3 is closed by decision.** Fourteen
> tier-1 symbols (v1.1, v1.2), the PI Web API layer and the first symbol on it
> (v1.3), the remaining five PI Web API symbols plus shared acknowledgement
> (v1.4), and `pvxSlideshow` (v1.5). The library is at **30 symbols**.
>
> The other four tier-3 candidates were deliberately not built — see the
> reasoning in the tier 3 table. Nothing on this plan is outstanding.
>
> **Two symbols were added after the plan closed**, from a gap analysis rather
> than from this document: `pvxOperatingMap` and `pvxDataHealth`. See
> [After the plan](#after-the-plan). The library is at **32 symbols**.

## On originality

This roadmap was informed by surveying what the commercial PI Vision symbol
market sells — chiefly [Software Athlete's Vision Library+](https://www.software-athlete.com/pages/pi-vision-custom-widgets-collection)
(42 symbols) and the individual symbols on
[Cedric Canguilhem's store](https://cedriccanguilhem.gumroad.com/l/all-custom-symbols) —
alongside AVEVA's own documentation for what PI Vision 2025 ships natively.

What that survey provides is a **map of what plant staff repeatedly ask for**.
That is the useful part, and it is not anyone's property. Neither are the chart
types: box plots (Tukey, 1970), Sankey diagrams (1898), Pareto charts,
histograms with Cp/Cpk, radar plots and the Duval triangle (IEC 60599) are
published, decades-old, standard techniques.

What *is* theirs is their source code, their specific visual designs, their
icons and their branding. None of it has been read, and none of it is
obtainable — Vision Library+ ships obfuscated to paying customers. Every symbol
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
band shaded, excursions coloured, and a time-in-band percentage in the corner.

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

Nested rectangles sized by one statistic and coloured by another, grouped by a
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
coordinates, each bound to a data source and rendered as a coloured marker with
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
| 21 | **pvxTimePicker** | not building | Calendar plus a PI-time expression field. PI Vision's own time control already does this competently, and `pvxNavPanel` covers presets. A third way to set the time range is a way to disagree with the other two. |
| 22 | **pvxSlideshow** | **done** (v1.5) | Rotates a control-room screen through a list of displays with a pause-on-interaction timer. The subtlety is that navigating destroys the symbol, so the same config goes on every display in the rotation and each copy works out where it is. |
| 23 | **pvxWebView** | not building | An iframe for a work instruction, camera feed or report. Blocked by the target's `X-Frame-Options` more often than not, and when it does work it is a browser feature rather than a PI Vision one. Low value for the support burden it would generate. |
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
