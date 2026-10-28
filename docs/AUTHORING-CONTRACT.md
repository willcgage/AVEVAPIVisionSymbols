# PVX symbol authoring contract

Every symbol in this library MUST follow this contract. Deviations break the
build validator in `tools/build.js`.

## Files

Each symbol lives in `src/symbols/<typeName>/` and contains exactly:

```
symbol.js       # implementation (IIFE, ES5 style)
template.html   # presentation markup (AngularJS 1.x)
config.html     # configuration pane markup
styles.css      # symbol-specific CSS
icon.svg        # 512x512 viewBox, transparent background
```

The build copies these to `dist/ext/sym-<typeName>.js`, `-template.html`,
`-config.html`, `.css` and `dist/ext/icons/<typeName>.svg`: the layout AVEVA's
guide describes. 1.7.0 tried a subfolder of `ext` and PI Vision served nothing
from it. `PVX.register` fills in `templateUrl`, `configTemplateUrl` and
`iconUrl`; leave them unset rather than spelling out a path.

## Hard rules

1. **ES5 only.** `var`, `function`, no arrow functions, no `let`/`const`, no
   template literals, no `class`, no optional chaining, no spread. PI Vision
   hosts symbols inside its AngularJS 1.x app; this keeps us portable across
   every supported release and browser.
2. **No external libraries.** No jQuery calls, no D3, no Chart.js. Everything
   is built on `window.PVX` (`src/shared/pvx-core.js`) and raw SVG/DOM.
3. **Never touch `window.PVX` at definition time.** Only inside `init()` and
   the callbacks it wires up. (Library load order is guaranteed before render,
   not before file evaluation.)
4. **Register via `window.PVX.register(PV, definition)`** — never call
   `PV.symbolCatalog.register` directly. The wrapper supplies `iconUrl`,
   `templateUrl`, `configTemplateUrl` and `loadConfig` and traps errors so one
   bad symbol cannot take down the library.
5. **Use `PVX.bootstrap(this, scope, elem, hooks)`** for lifecycle wiring.
   Do not assign `this.onDataUpdate` / `onResize` / `onConfigChange` /
   `onDestroy` by hand.
6. **Config defaults come from `PVX.config.base({...})`** so every symbol
   inherits `Theme`, `Transparent`, `Thresholds`, `Decimals`, `AccentColor`,
   `CornerRadius`, etc.
7. **Theme from `ctx.theme`** (light/dark auto-detected). Never hardcode
   `#fff` or `#000` in rendering code. `styles.css` may declare CSS custom
   property fallbacks, which the symbol overwrites at runtime by writing
   them on `ctx.node`. That is the template's `.pvx` root, never `elem`:
   PI Vision's `elem` is a wrapper around the template, and a property set
   there loses to the root's own fallback. Every template's outermost element
   carries the `pvx` class for this reason.
8. **All CSS selectors are namespaced** under the symbol's own root class
   (e.g. `.pvx-heatmap ...`). Shared `.pvx-*` base classes come from
   `src/shared/base.css`, which the build prepends automatically — do not
   duplicate them.
9. **Every rendering path must survive null/empty data.** Render an empty
   state, never throw.
10. **`typeName` must equal the folder name** and be unique.

## Skeleton

```js
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxThing',
        displayName: 'PVX Thing',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format Thing',
        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                Columns: ['Value'],
                Height: 200,
                Width: 320
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;
        scope.pvx = { /* fields the template binds to */ };

        var rows = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-thing-body',
            onData: function (d) { rows = PVX.data.rows(d, ['Value']); },
            render: function (c) { /* pure render from rows + c.config + c.theme */ }
        });

        return ctx;
    };

    window.PVX.register(PV, definition);
}(window.PIVisualization));
```

## Angular digest

`PVX.bootstrap` renders inside `requestAnimationFrame`, which is outside
Angular's digest. If the render function writes to `scope.pvx.*` for template
bindings, end the render with the guarded digest used in `pvxKpiCard`:

```js
if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
    try { scope.$digest(); } catch (e) { /* already digesting */ }
}
```

Symbols that draw only into SVG (no scope bindings) do not need it.

## PVX API you will use

| Namespace | Members |
|---|---|
| `PVX.util` | `num, isNum, clamp, def, debounce, uid, node, find, escapeHtml` |
| `PVX.fmt` | `number, compact, percent, group, autoDecimals, time, ago, duration, tick, toDate` |
| `PVX.color` | `categorical[], status{}, sequential[], diverging[], toRgb, toHex, rgba, mix, ramp, luminance, contrastRatio, readable` |
| `PVX.theme` | `isDark(elem), tokens(config, elem)` → `{dark, surface, surfaceAlt, border, text, textMuted, grid, axis, track, shadow, status, categorical}` |
| `PVX.thresholds` | `DEFAULT, parse, stringify, evaluate, colorFor, bands, bind` (`bind` wired by `bootstrap`) |
| `PVX.scale` | `linear(d0,d1,r0,r1), niceDomain, tickStep, ticks` |
| `PVX.svg` | `el, clear, text, polar, arc, annulus, roundRect, line, stepLine, area` |
| `PVX.data` | `single, series, stateSeries, stateRuns, rows, statValue, trend, stats` |
| `PVX.stats` | `linreg, sma, percentile, delta, sorted, mean, stddev, quartiles, histogram, normalPdf, normalCdf, capability` |
| `PVX.nav` | `url, go, parseHash, buildHash, setTimeRange, currentAsset` |
| `PVX.layout` | `renderer, fitFont` |
| `PVX.config` | `base, upgrade, numberOpts, TABLE_STATS, statKey, statLabel, statColumns, syncStatColumns` |
| `PVX.sources` | `name, rules, remap, bind` (wired by `bootstrap`; symbols declare `sourceRemap`) |

## Config pane markup

Wrap in `<div class="c-config-content pvx-cfg">`. Group settings with
`.pvx-cfg-group` + `.pvx-cfg-legend`. Rows use `.pvx-cfg-row` (label + control)
or `.pvx-cfg-stack` (label above a full-width control). Explain non-obvious
settings with `.pvx-cfg-hint`. Bind everything with `ng-model="config.X"`.

Keep the root `<div class="c-config-content pvx-cfg">` on the first line, on
its own. The build injects the shared **Data sources** list
(`src/shared/config-sources.html`) straight after it, and fails a pane whose
first line does not match rather than ship that symbol without it. Do not
build a data source list of your own.

Threshold bands are edited with the shared band editor
(`src/shared/config-bands.html`): one row per band with a limit, a colour
picker and a label, plus Add band and an *Edit as text* fallback. Put the
marker on its own line where the control goes, under a `.pvx-cfg-label`:

```html
<div class="pvx-cfg-stack">
    <div class="pvx-cfg-label">Threshold bands</div>
    <!-- pvx:bands -->
</div>
```

The editor writes `config.Thresholds` as the usual grammar string, so saved
displays and `PVX.thresholds.parse` are unaffected. The build fails a pane that
binds `config.Thresholds` to a control of its own.

Another key in the same grammar gets the same rows with
`<!-- pvx:bands key=LimitBands -->`, and the symbol names the key in its
bootstrap hooks, `bandKeys: ['LimitBands']`, so `PVX.bootstrap` binds an editor
for it at `runtimeData.pvxBandsFor.LimitBands`. The build fails a marker whose
key `symbol.js` does not pass, and a pane that binds `LimitBands` itself.

## Text size

Every format pane gets a **Text size** select after the Data sources list
(`src/shared/config-text.html`, injected by the build), stored as
`config.TextScale`, a percentage string. `PVX.bootstrap` applies it as CSS
`zoom` on the `.pvx` root before measuring the host, so `ctx.width` and
`ctx.height` are already the smaller box the symbol lays out in, and what it
draws comes out larger and still fits. A symbol needs nothing for this, but it
must not undo it: lay out from `ctx.width` / `ctx.height`, never write
`zoom`, `width` or `height` on the root, and never map pointer coordinates
from `getBoundingClientRect` without dividing by `ctx.fontScale`.

## Save button, stale badge, hide when no data

Every format pane also gets **Saving and data state**
(`src/shared/config-common.html`): `ExportMenu`, `StaleBadgeMinutes` and
`HideWhenNoData`, in `config.base` and all off. `PVX.overlay` applies them
after each render, on an element it appends to the `.pvx` root, so a symbol
needs nothing for them. The rules a symbol must keep:

- Draw into the host, never over the root's top-right corner with something
  that must stay clickable: the save button sits there.
- Never set `visibility` on the root; hiding uses it.
- The CSV is the raw values PI Vision sent, one row each. A symbol whose own
  table is the better export passes `csv: function (ctx) { return rows; }` in
  its bootstrap hooks (an array of arrays, a header row first), as
  pvxHistoryTable does.
- The PNG copies the root into an SVG `foreignObject` with computed styles
  written in. Anything drawn on a `<canvas>` or loaded from another origin
  will be missing from it.

## Removing a data source

Every symbol's format pane lists its data sources with a Remove button on each
row (two clicks: Remove, then Confirm). `PVX.bootstrap` publishes the list on
`scope.runtimeData.pvxSources`; removal splices `symbol.DataSources` in place.
The last source can never be removed.

If your config addresses sources **by position**, removing source 2 moves
every later source up one, and a config left alone now styles, places or
routes the wrong attribute. Declare those keys on the definition and
`PVX.sources` renumbers them in the same step and tells the operator what
changed:

```js
sourceRemap: { TraceSpec: 'traceSpec' },
```

| Rule | Grammar | Used by |
|---|---|---|
| `index` | one 1-based position; pointing at the removed one falls back to 1 | Histogram `SeriesIndex`, Compare `ConditionSource` |
| `indexAuto` | a position stored as a string, `'0'` meaning automatic; pointing at the removed one goes back to automatic | Deviation `ValueSource`, `TargetSource` |
| `traceSpec` | `"1:bar, 2:line:right"` — entries keyed by a leading index | ComboChart `TraceSpec` |
| `listComma` | one comma-separated entry per source, blanks kept | Radar `AxisLimits` |
| `listBar` | one `\|`-separated entry per source | SitePlan `Hotspots` |
| `numberList` | numbers separated by commas, semicolons or spaces | Profile `Positions` |
| `steps` | 1-based "after step N" set; a subtotal after the removed step stays in place | Waterfall `SubtotalAfter` |
| `links` | `"From > To : N \| ..."`; a link fed by the removed source is removed and named | Sankey `Links` |

A grammar none of these covers needs a new rule in `PVX.sources.rules` and a
case in `tools/test-sources.js`. An unknown rule name is reported in the pane
as "NOT renumbered", never skipped silently.

## Symbols that raise alarms

`PVX.thresholds.DEFAULT` is a placeholder on a 0-100 scale. Colouring an arc
with it is harmless; flagging a point with it is a false alarm, and on a live
server it flagged every point above 70 whatever its units. A symbol that
alarms, latches or lists exceptions therefore declares

```js
limitsRequired: true,
```

on its definition and sets `Thresholds: ''` in `getDefaultConfig`. With no
bands it flags nothing and says, in the symbol, that no limits are set; an
empty list must never read as an all-clear. `PVX.register` clears a saved
placeholder on load so the format pane shows what is in effect.
`tools/test-limits.js` covers the three that do this today: Exception
Banner, Annunciator and Status Grid.

## AF path fields

A config field that takes an AF path must not be type-only. Put a marker on
the line after its input, inside the same `pvx-cfg-stack`, and the build
expands it into a **Search** pane laid out like PI Vision's own Search
Criteria pane (Database, Search Root, Return All Descendants, Asset Name,
Asset Type with attribute value filters, Asset Category, Number of Results,
Sort, Refresh), driven through PI Web API:

```html
<input id="pvxat-db" type="text" ng-model="config.DatabasePath" />
<!-- pvx:afpicker key=DatabasePath kind=database -->
```

| Attribute | Meaning |
|---|---|
| `key` | the config key the pick is written to; must be an `ng-model="config.<key>"` in the same pane |
| `kind` | `database`, `element`, or `attribute` (which also accepts a PI point) |
| `start` | optional: another key whose path the search opens on when this field is empty: a database selects it, an element (for an `attribute` field) opens on its attributes, e.g. `start=DatabasePath` |
| `append` | optional: the field is a list and a pick adds a line in its grammar instead of replacing it: `entryRow` (EntryTable `Rows`), `navItem` (NavPanel `Items`) |

The stored value is a plain path string, exactly what typing it would have
produced, and the text box stays editable for a path PI Web API cannot see.
A `database` field shows only the Database dropdown and a Use button; an
`attribute` field also lists each PI Data Archive as a source, where the
pane searches points by name. Attribute value filters go through
`elements/search`; every other criterion is a parameter of the element
collection endpoints, so a PI Web API without that search endpoint loses
only the filters, and the pane says so rather than ignoring them.

The build fails on a marker whose key the pane does not bind, an unknown
kind or grammar, or a malformed marker. A new list grammar needs a case in
`PVX.afpick.compose` and in `tools/test-afpick.js`.

## Digital-state symbols

A symbol that reasons about digital states (time-in-state, latching alarms)
must do two things:

1. Use `PVX.data.stateSeries(d)`, not `PVX.data.series(d)`. The latter exists to
   feed charts and discards every non-numeric sample, which silently empties a
   tag whose values are `Running` / `Stopped`. Collapse the samples into runs
   with `PVX.data.stateRuns(points, fromMs, toMs)`.
2. Set `DataQueryMode: 'ModeEvents'` in `getDefaultConfig()`. PI Vision then
   returns the actual transitions instead of an interpolated sample grid, which
   is what makes duration arithmetic correct rather than approximate.

Declare the mock profile in the file header so the preview harness and the
verifier feed the symbol the right shape of test data:

```js
/* ...
 * @mock digital
 * ...
 */
```

Without that tag both tools send a numeric signal, and a time-in-state symbol
would be "verified" against data it can never receive in the field.

A config key that names digital states is edited with the shared state map
editor (`src/shared/config-states.html`), never a text box. Put a marker on its
own line where the control goes, naming the key and the grammar it holds:

```html
<div class="pvx-cfg-stack">
    <div class="pvx-cfg-label">Digital state map</div>
    <!-- pvx:states key=StateMap kind=map -->
</div>
```

| kind | Stored grammar | Row fields |
|---|---|---|
| `map` | `State:colour[:label]` | state, severity, colour, label |
| `colors` | `State:colour` | state, severity, colour |
| `list` | `State` | state |
| `bands` | `State:band` | state, threshold band (by label, or 0-based index for an unlabelled band) |

`bands` is for symbols whose severity is a threshold band index (the
Exception Banner and Annunciator): a mapped state takes that band's index, so
it filters, sorts, colours and latches like a number in the band. Resolve it
with `PVX.states.bandMap(cfg.StateBands, bands)` and match `PVX.states.text(raw)`.

The state is chosen from a list: the data sources' digital state sets read
through `PVX.api` when the site has configured PI Web API, states seen in the
symbol's live data, and states already in the map, with a button to type one
that is not listed. Severity is a name over `PVX.color.status`; only the colour
is stored. The key keeps its grammar string, so saved displays load unchanged
and the symbol's own parser is untouched. The build fails a pane that binds
`StateMap`, `StateColors`, `UptimeStates`, `StateBands` or a marked key to a control of its
own, and a marker with an unknown kind. A new grammar needs a kind in
`PVX.states` and `tools/build.js`, and a case in `tools/test-states.js`.

A setting that names one attribute by the label the symbol shows for it
(`pvxDataHealth`'s `Ranges` and `UpdateOverrides`) is edited as rows too, from
the shared editor in `src/shared/config-tags.html`:

```html
<div class="pvx-cfg-stack">
    <div class="pvx-cfg-label">Instrument ranges</div>
    <!-- pvx:tags key=Ranges kind=range -->
</div>
```

| kind | Stored grammar | Row fields |
|---|---|---|
| `range` | `Label: low..high` | attribute, low, high; plus **Fill from PI** |
| `minutes` | `Label: minutes` | attribute, minutes (`0` = not checked) |

The attribute is chosen from the labels in the symbol's live data, so it
matches by construction. Read the key with `PVX.tags.parse(spec, kind)` and
skip entries whose `valid` is false; that is the parser the pane uses, so the
two cannot drift. **Fill from PI** adds a row for each attribute without one,
from its AF `Minimum`/`Maximum` limit traits, else its PI point's Zero and
Span, read once through `PVX.api` in the pane; the symbol never calls PI Web
API for it. The build fails a pane that binds `Ranges`, `UpdateOverrides` or a
marked key to a control of its own, and a marker with an unknown kind. A new
grammar needs a kind in `PVX.tags` and `tools/build.js`, and a case in
`tools/test-tags.js`.

The same tag selects the other profiles in `dev/pv-mock.js`. `@mock health`
breaks some tags in the ways `pvxDataHealth` catches (a feed that stops, a
value that freezes, an "I/O Timeout" in place of a number) — on healthy data
that symbol would only ever be verified against its empty state.
`@mock compressor` sends flow and head on compressor scales plus a curve spec
as a string third source. `@mock wind` sends a direction that wraps through
north and favours one quarter, and a speed that is higher from it. A symbol that needs data of a particular shape to
draw anything meaningful should get a profile of its own rather than be
verified against a generic signal.

## Table symbols that let the operator pick a statistic

PI Vision returns `Summary` cells **positionally**, matching `config.Columns`.
If the chosen statistic and that array drift apart the symbol silently charts
the wrong number — no error, just wrong. Do not hand-roll this. Use:

```js
// in getDefaultConfig
Statistic: 'Value',          // Value|Average|Minimum|Maximum|Range|StdDev|Total
Columns: ['Value'],
SortColumn: 'Value',

// in onData
rows = PVX.data.rows(d, PVX.config.statColumns(scope.config));

// in onConfigChange AND at the top of render — a display saved by an older
// build repairs itself on load instead of charting a stale aggregate
PVX.config.syncStatColumns(cfg);

// reading a value
var v = PVX.data.statValue(row, cfg);
```

`PVX.config.statLabel(cfg)` gives the human-facing name for the header.

## Symbols that talk to PI Web API

Only for what PI Vision's DataShape mechanism cannot reach: Event Frames, the
AF hierarchy, writing values back. Set
`datasourceBehavior: DatasourceBehaviors.Single` with `DataShape: 'Value'` and
ignore the data: the operator drops any attribute to place the symbol. **Never
`DatasourceBehaviors.None`.** PI Vision treats those as static symbols and
leaves them out of the symbol selector, so they cannot be placed at all; seven
PVX symbols shipped that way and were invisible on the first live server.
`onDataUpdate` carries nothing useful, so such a symbol drives its own refresh
timer and must clear it in `onDestroy`. A leaked poller on a kiosk display runs
for weeks.

Every symbol also offers **Background colour** (`config.BackgroundColor`, empty
means follow the theme) beside **Transparent background** in its format pane.
`PVX.theme.resolve` applies it; a new symbol only needs the two rows, copied
from any existing `config.html`.

Never use `XMLHttpRequest` or `$http` directly. Everything goes through
`PVX.api`, because authentication is a property of the deployment and no symbol
should encode it:

| Call | For |
|---|---|
| `PVX.api.get / post / put` | plain requests, relative to the configured base |
| `PVX.api.batch(requests)` | many sub-requests in one round trip — use wherever the request count scales with the number of assets |
| `PVX.api.batchResults(res)` | split a batch response into `ok` / `failed`; report `failedCount` rather than dropping the failures |
| `PVX.api.eventFrames(query)` | Event Frames overlapping a window |
| `PVX.api.elementByPath / attributeByPath` | resolve an AF path |
| `PVX.api.readValue / readValues` | current values, one or many |
| `PVX.api.writeValue / writeValues` | writes — see below |
| `PVX.api.isConfigured()` | render the "not configured" state instead of failing |

Always pass `selectedFields` on list queries. It is the difference between a
few kilobytes and a few megabytes on a large database.

### Failure states are part of the symbol

Every rejection carries `err.pvxError.message` and `err.pvxError.check`. Show
both. "Failed to fetch" tells an operator nothing and sends an engineer to the
wrong place. Handle each of these distinctly:

- not configured — name `ext/libraries/pvx/pvx-config.js` **and** `ext/piwebapi-check.html`
- request failed — the message and the check line
- authenticated but forbidden — PI/AF security, not the symbol
- query succeeded, no results — say so; it is not an error
- more results than the cap — say how many were dropped

### Writes

- Confirm with a human before writing. There is no undo.
- One value per call. `PVX.api` never caches, retries or batches a write, and
  neither should the symbol.
- Report each write's outcome separately. `writeValues` resolves with `ok` and
  `failed` and never rejects, precisely so a partial success shows as one.
- Disable the control while a write is in flight, or an impatient double-click
  writes twice.
- PI and AF security are the access control. The symbol does not decide who may
  write; it surfaces the 403 clearly when they may not.
