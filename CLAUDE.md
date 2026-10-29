# CLAUDE.md — working notes for Claude Code

PVX: 51 custom symbols for AVEVA PI Vision, a zero-dependency build toolchain,
and an MSI installer generated from the build output. **v1.15.1**, released from
the public repo at <https://github.com/willcgage/AVEVAPIVisionSymbols> with an
MSI and a manual-copy zip attached (a release only exists once Will pushes its
tag). CI and the release workflow are green, and
both have actually run — that sentence was here for a while before it was
true.

Read `docs/CONTRIBUTING.md` for the human-facing version. This file is the
short, sharp list of things that will waste your time if you do not know them.

---

## Commands

```bash
node tools/build.js --clean          # src/ -> dist/ext, runs the validator
node tools/verify.js                 # 918 render checks — the gate, and slow
node tools/test-api.js               # PI Web API layer vs 6 broken mocks
node tools/test-sources.js           # data source removal, band + trace editors: rules + built pane
node tools/test-afpick.js            # AF search pane: rules + built panes vs a mock AF database
node tools/test-states.js            # digital state map editor: rules + built panes vs mock digital sets
node tools/test-tags.js              # Data Health range/override rows + Fill from PI vs a mock PI Web API
node tools/test-limits.js            # alarm symbols with no limits set raise nothing
node tools/test-overview.js          # (--rules, --only analytics|afsearch|filters|writes|forecast) nav hierarchy, Asset Table, scoped Event Timeline, Event Analytics, AF search as rows, shared filters, writes from the Asset Table and Event List, Event List, runs from event frames, Asset Rollup, quick trend, Lookup Table, own time range, Target & Forecast look-ahead, text zoom vs a mock AF
node tools/test-charts.js            # chart, gauge, KPI, History Table, Spectrum, Cross Profile, Combo Chart, Target & Forecast numbers vs known answers (--only <section>)
node tools/test-overlay.js           # save button (PNG/SVG/CSV), stale badge, hide when no data (quick trend: test-overview)
node tools/test-alarms.js            # alarm deadband, Banner History, Alarm Tone vs a mock PI Web API
node tools/test-entry.js             # entry controls, momentary button, Shift Log form layout, options, paste/CSV, time-slot grid vs a mock PI Web API
node tools/docgen.js                 # regenerate docs/SYMBOL-REFERENCE.md
node tools/wix.js                    # generate the WiX installer source
node tools/verify-msi.js             # read a built MSI's tables and assert them
tools/test-installer.ps1             # Windows, elevated: real install/upgrade/uninstall
node tools/check-text.js             # no raw control bytes anywhere in the repo
node tools/probe.js <symbol> [...]   # render ONE symbol — the inner loop
```

**Use the probe while iterating, not verify.** Verify renders 51 symbols 18
ways: measured at ~12 minutes on a Windows workstation, and the CI job wrapping
it takes ~9 on Linux. Budget for that rather than the "couple of minutes" this
file used to claim.

```bash
node tools/probe.js pvxHistogram --w 900 --h 480 --config "LSL=100;USL=140"
node tools/probe.js pvxComboChart --dark --config "TraceSpec=1:bar,2:line:right"
node tools/probe.js pvxSlideshow --hash "/Displays/101/Overview"
node tools/probe.js pvxComboChart --config "Rulers=true" --clicks "0.3,0.5;0.8,0.5"
```

Config pairs split on **`;`**, not `,` — values contain commas.

**Playwright usually needs a browser path.** Not only in sandboxes: it is
needed anywhere the Chromium build the pinned Playwright asks for is not the
one sitting in the cache, which is the normal case on a workstation that has
accumulated builds from other projects.

```bash
# Linux
PVX_CHROMIUM=/opt/pw-browsers/chromium-<build>/chrome-linux/chrome node tools/verify.js
# Windows — note chrome-win64, and .exe
$env:PVX_CHROMIUM="$env:LOCALAPPDATA\ms-playwright\chromium-<build>\chrome-win64\chrome.exe"
```

Honoured by `verify.js`, `probe.js`, `test-api.js`, `test-sources.js`, `test-afpick.js`, `test-states.js`, `test-tags.js`, `test-limits.js`, `test-overview.js`, `test-charts.js`, `test-overlay.js`, `test-alarms.js` and `test-entry.js`. Without it you get
"Executable doesn't exist" — do **not** run `npx playwright install` to fix it,
just point the variable at a build you already have.

`tools/verify-msi.js` needs `msiinfo` and the `.wxs` is compiled on Linux by
`wixl`. These are **two packages** on Ubuntu 24.04 — it split them, and
msitools no longer carries wixl:

```bash
apt-get install -y msitools wixl
```

---

## Hard constraints

`tools/build.js` enforces these; it will fail the build rather than let them
through. Do not try to work around the validator.

- **ES5 only.** No `let`, `const`, arrow functions, template literals, spread,
  classes, `for...of`. PI Vision 2019 must load this. Promises are fine — a
  runtime API, not syntax.
- **No third-party code, ever, in anything that ships.** See `NOTICE.md`.
- **No raw control characters in source.** Use the `\uXXXX` escape, never the
  literal byte. A literal NUL makes the file register as binary: grep skips it,
  git stops treating it as text, and a text-mode transfer can corrupt it. It
  reached a shipped file once and two documents *describing the problem*
  afterwards, so it is now checked two ways: `build.js` for symbol sources and
  `tools/check-text.js` for every tracked text file, wired into CI.
- **CSS must be namespaced** to the symbol's own class.
- **A color input commits on close:** `ng-model-options="{ updateOn: 'change' }"`.
  Without it every step of a drag is its own undo entry in PI Vision; a
  tester's undo history filled with 255 grays from one background pick.
- **Nothing is dropped silently.** If a symbol excludes a data source — negative
  value in a treemap, non-numeric in a chart — it must say so in the footer.

## Do not edit

| Path | Why |
|---|---|
| `dist/**` | Generated. Gitignored. Edit `src/`. |
| `docs/SYMBOL-REFERENCE.md` | Generated by `docgen.js`; CI fails on drift. |
| `dist/installer/*.wxs`, `components.json` | Generated by `wix.js`. |
| `dist/Deploy-PvxSymbols.ps1` | Copied by `build.js` from `src/tools/Deploy-PvxSymbols.ps1` — edit that, in ASCII only. |

## Never change

**`PVX_NAMESPACE` and `UPGRADE_CODE` in `tools/wix.js`.** Every MSI component
GUID is UUIDv5-derived from the namespace plus the file's path. Windows
Installer identifies components by GUID, not path — change these and the next
upgrade installs a file, then deletes it, on every server in the field. There is
no recovery except uninstalling by hand everywhere. `docs/RELEASING.md` has the
full explanation.

**`ext/libraries/pvx/pvx-config.js` is the site's file, not ours.** The deploy script
skips it, and its MSI component is `Permanent` + `NeverOverwrite`. If you rename
it, `wix.js` fails the build deliberately rather than ship an installer that
silently destroys a site's PI Web API settings on upgrade.

---

## Architecture in five lines

- Install layout: symbol files and the diagnostic directly in `ext/`, icons
  in `ext/icons/`, runtime and site settings in `ext/libraries/pvx/`. The
  layout AVEVA's guide describes, and the only one proven on a server. `verify-msi.js` fails the build if a file
  drifts either way.
- `src/shared/pvx-core.js` → `ext/libraries/pvx/pvx-core.js`. Namespaces: `util`,
  `fmt`, `color`, `theme`, `thresholds`, `scale`, `svg`, `data`, `stats`, `nav`,
  `layout`, `config`, `api`, `ack`, `download`. Symbols contain only what makes them differ.
- `PVX.register(PV, def)` — never `PV.symbolCatalog.register` directly.
- `PVX.bootstrap()` wires the lifecycle into one coalesced render frame.
- Symbols get data through PI Vision's pipeline. Ten reach PI Web API via
  `PVX.api` for their main job and ten more for an option that is off by
  default, configured once per site in `pvx-config.js`. A blank `baseUrl`
  means "ask `/piwebapi` on PI Vision's own origin, once per page"
  (`api.discover`; `autoDiscover: false` restores blank-means-off). A symbol's
  refresh waits on `PVX.api.discovering()` before deciding it is unconfigured.
  PI Vision's own AF connection is not reachable from display code; do not
  build on `/PIVision/Services`. A blank `DatabasePath` falls back to
  `PVX.nav.defaultDatabase` (data source, display asset, site `databasePath`),
  never saved into config. Proven against mocks only.
- Every format pane opens with a **Data sources** list (`src/shared/config-sources.html`,
  injected by `build.js`) whose Remove splices `symbol.DataSources` and
  renumbers the keys a symbol lists in `sourceRemap`. It reaches the pane
  through `scope.runtimeData`; proven live on a server in 1.8.0 (list, Remove,
  and the removal surviving save and reload).
- A field that takes an AF path gets a **Search** pane from a marker after its
  input, `<!-- pvx:afpicker key=DatabasePath kind=database -->` (optional
  `start=<key>`, `append=entryRow|navItem`), expanded by `build.js` from
  `src/shared/config-afpicker.html`. It copies PI Vision's own Search
  Criteria pane (Database, Search Root, Return All Descendants, Asset Name,
  Asset Type + attribute value filters, Asset Category, Number of Results,
  Sort, Refresh) because Will asked for the baseline experience, not a text
  box. `PVX.afpick` uses the element collection endpoints, and switches to
  `elements/search` (AFSearch query) only when an attribute filter is set,
  saying so if that endpoint is missing. The pick is written as a plain path
  by the pane's own ng-click, so saved displays are unaffected. Proven
  against a mock AF database, not yet on a server; the AFSearch syntax is
  the least certain part.
- Four symbols (Ranked Bar, Treemap, Fingerprint, Combo Chart) can take
  their rows from an **AF search** instead of their data sources:
  `<!-- pvx:afsearch -->` in `config.html` → `src/shared/config-afsearch.html`,
  `PVX.afsource.defaults(...)` around `getDefaultConfig` (build.js requires
  it), and `PVX.afsource` in the bootstrap swaps the update for rows shaped
  as PI Vision's (`Rows` or `Data`), each with `asset`, `assetPath`,
  `attribute` and `parent`. A symbol pairs attributes by `assetPath` via
  `PVX.afsource.split`, never by position. Mock-proven only.
- **Shared filters** (`PVX.filter`): a set of asset paths on a named
  channel, kept on the page, not in PI Vision's asset context. The Asset
  Table, Ranked Bar and Event List publish (`ClickAction: 'filter'`) and
  obey (`FilterObey`); `<!-- pvx:filter -->` → `src/shared/config-filter.html`
  needs `PVX.filter.defaults(...)`. A match is the asset or anything under
  it. The overlay shows the badge that clears it. Mock-proven only.
- **Writes from reading symbols** (`PVX.writer.panel`): the Asset Table's
  `EditMode` (a cell) and the Event List's `EventActions` (Ack, Note, Edit on
  an event frame) share one panel: edit, a confirmation that states the value
  and target in full, then PI Web API's answer. Only changed fields are sent.
  All off by default. Mock-proven only (`test-overview --only writes`).
- Every symbol has four options from `config.base`, all off: `ExportMenu`
  (save as PNG, SVG or CSV), `StaleBadgeMinutes`, `HideWhenNoData`,
  `QuickTrend` (`src/shared/config-common.html`, applied by `PVX.overlay`
  after each render). The quick trend is `PVX.trend`: one floating panel per
  page on `document.body`, plot values from PI Web API per source, a second
  symbol's button adds to it. Time-series symbols also have `OwnTimeRange`
  (`OwnStart`, `OwnEnd`, ...): `PVX.ownrange`, in the bootstrap, swaps the
  pipeline's values for PI Web API recorded values over that range before
  the symbol sees them, keeps the pipeline's labels, and sets each item's
  StartTime/EndTime to the range. Unset PI Web API falls back to the
  display's data, with the badge saying so. Mock-proven only (`test-overview`). `pvxDataHealth` has its own `StaleMinutes`; do not merge them.
  The PNG goes through an SVG foreignObject; proven in Chromium only.
- One threshold grammar everywhere:
  `0:#2f9e5f:Normal, 70:#d99024:High, 90:#c8452f:Critical`. Panes edit it as
  rows (`<!-- pvx:bands -->` → `src/shared/config-bands.html`, state on
  `scope.runtimeData.pvxBands`); the stored value is still that string.
  Combo Chart's `LimitBands` uses the same rows via `key=LimitBands` plus
  `bandKeys` in its bootstrap hooks, and its `TraceSpec` is rows too, one per
  data source, from an editor in its own `symbol.js` (`runtimeData.pvxTraces`).
- Digital state maps (`StateMap`, `StateColors`, `UptimeStates`, and the
  alarm symbols' `StateBands`, which puts a state in a threshold band) are rows too:
  `<!-- pvx:states key=StateMap kind=map|colors|list|bands -->` →
  `src/shared/config-states.html`, state on `scope.runtimeData.pvxStates`.
  The state list comes from each source's digital set via `PVX.api` (proven
  against a mock only), live data, and the map itself; the stored value keeps
  its grammar.
- Per-attribute settings (`pvxDataHealth`'s `Ranges` and `UpdateOverrides`,
  `Label: lo..hi` / `Label: minutes`) are rows too:
  `<!-- pvx:tags key=Ranges kind=range|minutes -->` →
  `src/shared/config-tags.html`, state on `scope.runtimeData.pvxTags`. The
  attribute is chosen from the labels the symbol shows; the symbol reads the
  string with `PVX.tags.parse`, the pane's own parser. **Fill from PI** reads
  AF Minimum/Maximum limit traits, else the PI point's Zero/Span, once, in the
  pane (mock-proven only); the symbol itself never calls PI Web API.

---

## Traps already paid for

Each of these cost real debugging time. Do not rediscover them.

- **jqLite index 0 may be a comment node.** A template starting with an HTML
  comment made two symbols render blank. `util.node/nodes/find` scan for the
  first *element* node — use them, never `elem[0]`.
- **Re-resolve the host every frame.** `ng-if` swaps the DOM node out; a host
  captured at init paints into a detached element at the wrong size.
- **PI Vision's `elem` is a wrapper, not the template root.** Theme tokens
  written as inline `--pvx-*` properties on it lost to the fallbacks each
  `styles.css` declares on the `.pvx-*` root, so Transparent, dark theme and
  BackgroundColor did nothing on a live server in 1.8.0 while the harness,
  which passed the bare template, looked fine. `PVX.bootstrap` resolves
  `ctx.node` to the `.pvx` root; the harnesses mount templates inside a
  wrapper, and `verify.js` fails any `--pvx-*` written above the root.
- **PI Vision sends `Label`, `Units` and `Path` only now and then.** Most
  updates carry values alone, so normalizing each one on its own showed
  "Series 1" between metadata updates and the real name on the next: every
  label flickered on a live server in 1.11.0, 22 symbols at once. The mock
  sent metadata every time, which hid it. `PVX.bootstrap` now runs every
  update through `PVX.data.metaCarry` (keyed by data source, so a removal
  cannot pass a name to the neighbour); the mock strips metadata after the
  first update, and `verify.js` fails a placeholder name. Never read labels
  from a raw update without going through the bootstrap.
- **An exception out of `init()` costs the symbol its right-click menu.** On a
  live server in 1.13.0 the Asset Navigator sat on "Loading the AF
  hierarchy…" and right-click offered only Configure Display. An `init` that
  threw explains both (PI Vision had the template but not its own wiring);
  that is the reading, not yet confirmed from a console. `PVX.register` now wraps
  every `init` (`guardInit`), shows the error on the symbol, and refuses to
  start a symbol whose build stamp (`PVX.symbolBuild`, written by `build.js`)
  differs from `PVX.version` — a cached core from another release is the
  likeliest cause. `build.js` fails if `PVX.version` and `package.json`
  disagree, since a mismatch would switch every symbol off. There is no
  per-symbol PI Web API setting any more: `BaseUrlOverride` moved the base
  for the whole page and was removed in 1.14.0.
- **One server, two names, is two sites to a browser.** On the first live
  test of 1.14.0, `pvx-config.js` said `https://dalpivisiont01/piwebapi`
  while the display was opened by another name for the same machine; every
  request went cross-origin and failed as "CORS" on a server with no CORS to
  configure, while the check page, opened by the short name, passed.
  `api.base()` now asks under the page's own name when the configured host
  differs only past its first DNS label (`api.sameServerByAnotherName`).
  A blank `baseUrl` avoids the question entirely; recommend it.
- **PI Web API's AF server list proves nothing about reaching AF.**
  `assetservers` is answered from PI Web API's own Known Servers Table. On the
  first live server where every check passed, every `assetdatabases` list came
  back 502: PI Web API could not connect onward to AF as the user (Kerberos
  delegation for its service account, the reading, not yet confirmed). The check
  page now lists each server's databases, `classifyError` names 502 as
  `backend`, and messages quote PI Web API's own `Errors` text.
- **`theme.isDark` must probe from `parentElement`.** Sampling the symbol's own
  background reads its output, not its context, and latches dark mode on.
- **Measure text with `getComputedTextLength`.** Glyph-width estimates were
  generous in the test font and tight in Segoe UI, which is what PI Vision
  ships — panels overflowed only on real servers.
- **PI Vision returns `Summary` cells positionally**, matching `config.Columns`.
  `PVX.config.syncStatColumns()` is the single place that can be wrong; the
  seven Table-shape symbols all go through it.
- **`path.dirname` does not split backslashes off Windows.** This flattened
  every installer subfolder into the root. `tools/wix.js` computes nesting on
  POSIX paths and only uses backslashes for display.
- **`msiinfo export` emits CRLF.** Split on `/\r?\n/` or every string comparison
  silently fails.
- **Windows Installer SQL has no `LIKE`.** `OpenView` rejects the whole
  statement with `OpenView,Sql` rather than matching nothing, so a query that
  uses it never runs at all. Nor can you match a file by its plain name: the
  `File` table stores `SHORTNAME|Long Name`. Find a component by the GUID in
  `dist/installer/components.json`, which `wix.js` writes beside the `.wxs`.
- **`secrets` is not a context a step's `if:` can see.** Naming it there does
  not evaluate to empty — it makes the workflow file invalid, and every run
  fails at startup in 0s with no jobs and the file path where the workflow name
  should be. Lift the secret to the job's `env:`, which a step `if:` *can* see;
  a step's own `env:` does not exist yet when its `if:` is evaluated.
- **Windows has no `zip`.** The release builds the MSI on a Windows runner, so
  anything shelling out to `zip` there produces nothing. `build.js` tries
  `Compress-Archive` first on win32.
- **A PowerShell wildcard that matches nothing is silent.** `Copy-Item foo*.zip`
  raises no error even under `ErrorActionPreference = Stop`; only a literal path
  throws. This is how v1.5.0 first published without its zip while every step
  reported success. Resolve with `Get-ChildItem` and fail on an empty result.
- **The validator's comment-stripper does not understand regex literals.** Known
  limitation, false negatives only. Libraries are exempted structurally with
  `{isLibrary:true}`, not by post-hoc string splicing.
- **`wixl` compiles a subset of WiX and crashes on the rest** — no
  `DirectorySearch`, component `<Condition>`, `RemoveFile`, `CopyFile` or UI,
  and it drops `Secure`, `Permanent` and `NeverOverwrite` silently. Everything
  it cannot take is wrapped in `<?if $(var.PvxFull) = 1 ?>`; pass
  `-D PvxFull=0` to wixl and `-dPvxFull=1 -ext WixUIExtension` to candle (and
  the extension to light). The behaviour is only proven by the
  `installer-windows` CI job, which installs for real.
- **Windows Installer forgets command-line properties.** An uninstall, repair
  or upgrade re-resolves `PIVISIONPATH` from scratch, so a custom drive would
  silently revert to the default. The MSI records the folder in
  `HKLM\SOFTWARE\PVX\PI Vision Symbols` and reads it back; do
  not remove that without replacing it.
- **The MSI must stay x64 (`-a x64` / `-arch x64`, `Win64="yes"`).** In a
  32-bit package Windows Installer redirects components aimed at
  `C:\Program Files` to `Program Files (x86)` while AppSearch still probes the
  real path — 1.6.0's default install silently landed where PI Vision never
  looks.
- **PI Vision serves nothing of ours from a subfolder of `ext`.** 1.7.0 put
  everything but the runtime in `ext/pvx/`. On the first live server the
  symbols did not register; with the scripts moved up, the icons and templates
  still did not appear, though `iconUrl` and `templateUrl` pointed at them
  explicitly. Only `ext/libraries` may have subfolders (AVEVA's guide says so,
  for libraries only). Prove any layout change on a real server first.
- **`DatasourceBehaviors.None` hides a symbol from the palette.** AVEVA's
  guide calls those static symbols and PI Vision leaves them out of the
  selector, so seven PVX symbols were unplaceable until they took one ignored
  `Single` data source with `DataShape: 'Value'`. Never declare `None`.
- **`pvx-config` sorts before `pvx-core`.** 1.6.0's config assumed the opposite
  and dropped its settings when loaded first. The template now queues its
  settings on `PVX.pendingSiteSettings` and the core applies them; keep both
  halves if either file changes.
- **Do not `pkill -f` a pattern that matches your own shell.** Use
  `fuser -k <port>/tcp`. `test-api.js` and `verify.js` can leave ports held; if
  either hangs, clear the port and retry rather than assuming a code fault.

---

## Where things stand

The roadmap is **closed by decision**, not abandoned: tiers 1 and 2 shipped,
`pvxSlideshow` was the one tier-3 item worth building, and four candidates were
declined with reasons recorded on each card in `docs/roadmap.html`
(`pvxTimePicker`, `pvxWebView`, `pvxAlarmSound`, `pvxMap`). Two symbols were
added afterwards from a gap analysis, on the owner's request: `pvxOperatingMap`
and `pvxDataHealth` (`docs/ROADMAP.md`, *After the plan*), then `pvxAssetTable`
from a review against Will's overview display build guide, then `pvxWindRose`
(and a bubble mode on `pvxXYScatter`) from a check of fourteen chart types;
spiral, funnel, pyramid and chord were declined in `docs/ROADMAP.md`. Do not "finish
tier 3" — that is a resolved question, not an open task.

**One later list: a feature comparison, now complete.** Will asked for all 37
items of a feature-level comparison with a commercial widget library, built easiest
first, including the four tier-3 candidates declined above (they come back
under PVX names: `pvxTimeRange`, `pvxEmbeddedPage`, `pvxAlarmTone`,
`pvxGeoView`). All 37 are done (`docs/ROADMAP.md`, *After the plan*). Two
rules from him: never name a symbol after one of the other library's, never
name that library in the repo, and never drop a PVX behaviour that is already
ahead of it to match it; upgrades only add
options, with defaults that leave saved displays unchanged. `PVX.nav.parseTime`
resolves PI time expressions for anything that steps or replays a range;
`PVX.af.traits` / `PVX.af.text` / `PVX.af.watcher` read settings kept in AF
(limit traits, a menu in a string attribute), at most once a minute per value.

**One more on request: `pvxTargetForecast`** (Will, 2026-10-29), actual vs
target vs forecast on one axis. PI Vision sends nothing after the display's
end, so the forecast past now comes from a display ending in the future, or
from its `LookAhead` option, which reads recorded values from the display's end
through PI Web API (`PVX.api.webIdByPath`). Mock-proven only
(`test-charts --only targetForecast`, `test-overview --only forecast`).

**The release pipeline is proven.** Tagging works end to end: the gate re-runs
the full verification on the tagged commit, the MSI is built with the official
WiX toolset on Windows, and the `Permanent` + `NeverOverwrite` bits protecting
a site's `pvx-config.js` are asserted against the shipping MSI — the one check
the Linux `wixl` job structurally cannot make. `docs/RELEASING.md` is accurate;
follow it exactly, and note the tag must be annotated.

**The next step is deployment, not development.** Nothing has run against a real
PI Web API yet; it is verified against mocks deliberately misconfigured six
ways, which is a good proxy and not the same thing. The order is:
`ext/piwebapi-check.html` on a PI Vision server → `ext/libraries/pvx/pvx-config.js` on
*every* server → read-only `pvxEventGantt` on one display → only then anything
that writes.

If asked to add a symbol: copy `src/symbols/pvxRadialGauge`, read
`docs/AUTHORING-CONTRACT.md` first — it is binding. Nothing needs registering by
hand; the build discovers symbols from the directory and `wix.js` regenerates
the installer source.

## House style for this repo

Comments explain **why**, not what — the reasoning that is not recoverable from
the code, especially where a naive implementation would be wrong. Error messages
name a cause and a thing to check, never "failed to fetch". Documentation states
the expected output of a check, because "no output" only reassures a reader who
knows what clean looks like.

Verify claims before making them. Several documentation errors in this project's
history were confident sentences that were true a version earlier — for example
"nothing in this library makes network calls of its own", which stopped being
true when the PI Web API symbols landed.
