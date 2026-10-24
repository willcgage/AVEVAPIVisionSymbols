# Deploying and configuring PVX on a PI Vision server

Deployment is a file copy. There is nothing to register, compile, or write to a
database, and no PI Vision setting to change. If you can copy a folder onto the
web server and recycle the app pool, you can deploy this.

It happens in three phases, and it is worth knowing up front that most
installations only need the first two:

| Phase | What it does | Who needs it |
|---|---|---|
| **1 · Install** | Copy `ext` onto each PI Vision web server | Everyone |
| **2 · Confirm** | Check the symbols appear and draw | Everyone |
| **3 · Configure PI Web API** | Edit one file, per server | Only if you use the five PI Web API symbols |

Twenty-eight of the thirty-three symbols work the moment phase 1 finishes. Phase 3
exists only for `pvxEventGantt`, `pvxEventAnalytics`, `pvxAssetTree`,
`pvxManualEntry` and `pvxEntryTable` — and for `pvxAnnunciator` if you turn on
shared acknowledgement. Skip it otherwise; nothing else in the library reads
those settings.

---

## Checklist

For the person doing this on the day. Each line is expanded below.

```
[ ] Elevated access to every PI Vision web server
[ ] Artifact in hand: PvxSymbols-<ver>.msi, or pvx-symbols-<ver>.zip
[ ] SHA256 checked against SHA256SUMS.txt from the release
[ ] --- if building from source instead of using a release ---
[ ] npm run verify passes on the build machine        (594 render checks)
[ ] npm run package produces dist/pvx-symbols-<ver>.zip
[ ] --- install, route A (MSI) ---
[ ] msiexec /i PvxSymbols-<ver>.msi /qn /l*v pvx-install.log
[ ] Log reviewed for "Installation success"
[ ] --- or route B (zip) ---
[ ] Zip copied to server 1 and extracted
[ ] .\Deploy-PvxSymbols.ps1 -WhatIf reviewed
[ ] .\Deploy-PvxSymbols.ps1 run
[ ] --- both routes ---
[ ] App pool recycled  +  Ctrl+F5 in the browser
[ ] PVX symbols visible at the bottom of the palette in edit mode
[ ] One symbol placed on a scratch display and drawing real data
[ ] --- only if using PI Web API symbols ---
[ ] ext\piwebapi-check.html opened ON THE SERVER, in a browser, as a normal user
[ ] Result is a full pass, not a partial pass  (see the warning below)
[ ] libraries\pvx-config.js edited with baseUrl and auth
[ ] Re-run the diagnostic; one PI Web API symbol placed and drawing
[ ] --- repeat every step above on every other web server ---
```

---

## What gets deployed

Only the contents of `dist/ext`. Everything under `src/`, `dev/`, `tools/` and
`node_modules/` stays on the build machine.

```
<PI Vision install>\Scripts\app\editor\symbols\ext\
    sym-pvxRadialGauge.js
    sym-pvxRadialGauge-template.html
    sym-pvxRadialGauge-config.html
    sym-pvxRadialGauge.css
    …one set of four per symbol, 33 symbols…

    piwebapi-check.html          the connectivity diagnostic (phase 3)

    icons\
        pvxRadialGauge.svg
        …one per symbol…

    libraries\
        pvx-core.js              shared runtime — NOT optional
        pvx-config.js            YOUR site settings — never overwritten
```

The default PI Vision install path is `C:\Program Files\PIPC\PIVision`. On a
machine where it was installed elsewhere, substitute that path everywhere below
and pass `-PIVisionPath` to the script.

Two files in `libraries` deserve attention:

- **`pvx-core.js` is not optional.** PI Vision loads every `.js` under
  `libraries` before the symbol files, and every PVX symbol depends on it. A
  deployment missing it produces an empty palette.
- **`pvx-config.js` is yours.** It ships blank and is the only file the deploy
  script refuses to overwrite. Everything else is generated from source and
  replaced on every deployment.

`piwebapi-check.html` ships *inside* `ext` deliberately — it has to run from the
PI Vision origin to reproduce what a symbol actually faces. Opened from a file
path or another host it tests a different origin and gives you a confidently
wrong answer.

---

## Air-gapped sites — what has to be downloaded separately

**On the PI Vision server: nothing.** There is no runtime, no framework, no font
and no CDN to obtain. The deployed folder is plain static files that PI Vision
serves like any other part of its own `Scripts` tree, and no PVX symbol fetches
anything it was not given. A server with no route to the internet runs the full
library.

Specifically, the deployed `ext` folder contains no `@font-face`, no `@import`,
no `url()` in any stylesheet, and no `<script src>`, `<link>` or `<img>`
pointing anywhere outside itself. Text renders in Segoe UI with system
fallbacks — the font Windows already has. The only absolute URLs anywhere in the
build are the `http://www.w3.org/2000/svg` XML namespace (an identifier, never
fetched) and `piwebapi01.corp.example` placeholders in comments and input
hints.

Audit it yourself rather than taking this on trust. From the extracted `ext`
folder, three checks — each with the output you should expect, because "no
output" is only reassuring if you know what a clean result looks like:

```powershell
# 1. Absolute URLs, ignoring the XML namespace and documentation placeholders
Get-ChildItem -Recurse -Include *.js,*.css,*.html |
    Select-String -Pattern 'https?://' |
    Where-Object { $_.Line -notmatch 'w3\.org|corp\.example' }
```
> Expect **2 lines**, both in `pvxNavPanel` — a URL-format example in a code
> comment and a sample button definition in the help text. Neither is fetched.

```powershell
# 2. External assets pulled in by stylesheets
Get-ChildItem -Recurse -Include *.css |
    Select-String -Pattern '@import|@font-face|url\([^#]'
```
> Expect **nothing**. (`url(#…)` is excluded deliberately: those are
> same-document SVG fragment references — gradients and clip paths — and never
> leave the page.)

```powershell
# 3. Anything markup pulls in
Get-ChildItem -Recurse -Include *.html |
    Select-String -Pattern '<script[^>]+src=|<link|<img|<iframe|<object|<embed'
```
> Expect **3 lines**, all in `piwebapi-check.html`: two `<script src>` tags
> pointing at `libraries/` in the same folder, and an inline `data:` favicon
> that exists purely to stop the browser requesting one.

### The two things that can introduce an external dependency

Both are configuration choices, not library behaviour:

- **`pvxSitePlan`'s `ImageUrl`.** Host the drawing on the PI Vision server and
  reference it with a relative or internal URL. The symbol draws a labelled
  placeholder grid if the image 404s, so a wrong URL degrades visibly rather
  than silently.
- **`pvxNavPanel` external link targets.** If a button points at an internet
  URL, it will not open. Internal ones are fine.

`pvxMap` would have been a third, which is exactly why it was not built — see
the roadmap.

### On the build machine

Only if you intend to build from source. If you are deploying the supplied
`pvx-symbols-<version>.zip`, skip this entirely: the zip is the finished
artefact and needs nothing installed anywhere.

| Need | Required for | Notes |
|---|---|---|
| **Node.js ≥ 14** | `build`, `package`, `docgen`, `preview` | One installer from nodejs.org, transferred in. Nothing else. |
| `npm install` | *not* required for the above | The build tooling is zero-dependency — it uses only `fs`, `path`, `http` and `vm` from Node's standard library. |
| **`playwright` npm package** | `verify`, `probe`, `test:api` only | The only dependency in the project, and it is a dev dependency. |
| A Chromium-based browser | same | Playwright normally downloads its own (~150 MB). |

So an air-gapped build machine with nothing but a Node installer can already do
this:

```bash
node tools/build.js --clean --package    # produces the deployable zip
node tools/docgen.js                     # regenerates the option reference
node tools/serve.js                      # offline preview harness on :8777
```

That is verified, not assumed — those three run with `node_modules` deleted.

**Getting verification working offline** takes two more steps. `npm run verify`
is the pre-deployment gate, so it is worth the effort:

1. Bring the `playwright` package in through your internal registry or an
   `npm pack` tarball, with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` set so the
   install does not try to fetch a browser.
2. Point it at a browser the machine already has. Every Windows Server has
   Edge, which is Chromium:

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm install
$env:PVX_CHROMIUM = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm run verify
```

`PVX_CHROMIUM` is honoured by `verify.js`, `probe.js` and `test-api.js`. Note
that it removes the *browser download*, not the package — `require('playwright')`
still needs the module present.

If you cannot get the package in at all, build and package on the air-gapped
machine and run `npm run verify` somewhere with connectivity on the same commit.
The build output is deterministic from source, so a verify pass elsewhere is
evidence about the same artefact.

---

## Phase 1 — Install

Two supported routes. They install identical files; pick by how your site
deploys software.

| | **MSI** | **Zip + PowerShell** |
|---|---|---|
| Deploy by SCCM / Intune / GPO | Yes | No |
| Silent, scriptable | Yes | Yes |
| Appears in Add/Remove Programs | Yes | No |
| Uninstall | Yes | Delete the folder |
| Repair after a PI Vision upgrade | `msiexec /fa` | Redeploy |
| Needs change control approval first | Usually | Often not |

The MSI is the better answer where the plant has a software deployment system.
The zip exists because a folder copy sometimes clears approval on the same day
an installer would not.

### Route A — MSI

From an **elevated** PowerShell on each PI Vision web server:

```powershell
# Default install location, with a log
msiexec /i PvxSymbols-1.6.0.msi /qn /l*v pvx-install.log

# PI Vision installed somewhere else
msiexec /i PvxSymbols-1.6.0.msi PIVISIONPATH="D:\Program Files\PIPC\PIVision" /qn
```

`PIVISIONPATH` is the only property. It defaults to
`C:\Program Files\PIPC\PIVision` and is marked `Secure` so it survives
elevation — pass it exactly as above, without a trailing backslash.

Upgrading is the same command with the new MSI; Windows Installer removes the
previous version first. Rolling back is `msiexec /x` followed by installing the
older MSI.

**`libraries\pvx-config.js` is protected at the installer level.** Its component
is marked `NeverOverwrite` so an upgrade cannot replace your PI Web API
settings, and `Permanent` so an uninstall cannot delete them. The trade-off is
that a full uninstall leaves that one file behind; remove it by hand if you
want the folder gone entirely.

**After a PI Vision upgrade, repair rather than reinstall.** A PI Vision upgrade
replaces the `Scripts` tree and takes the `ext` folder with it. Windows
Installer still believes the product is installed, so:

```powershell
msiexec /fa PvxSymbols-1.6.0.msi /qn      # /fa = reinstall all files regardless of version
```

Uninstall:

```powershell
msiexec /x PvxSymbols-1.6.0.msi /qn
# or by name:
Get-Package 'PVX Symbol Library for PI Vision' | Uninstall-Package
```

Then recycle the app pool and hard-refresh, exactly as below.

### Route B — Zip and PowerShell script

#### On the build machine

```bash
npm install           # first time only; the tooling is dev-only
npm run verify        # gate: 594 render checks must pass
npm run package       # produces dist/pvx-symbols-<version>.zip
```

Do not skip `verify`. It renders every symbol in real Chromium across three
sizes, three data scenarios and both themes, and fails on thrown exceptions,
console errors, `NaN` in SVG geometry, blank renders and clipped content. It
takes under a minute and it is the only thing standing between a bad build and
a control-room display.

#### On the PI Vision web server

Copy the zip across, extract it somewhere temporary, then from an **elevated
PowerShell** in the extracted folder:

```powershell
.\Deploy-PvxSymbols.ps1 -WhatIf     # dry run: shows exactly what it would copy
.\Deploy-PvxSymbols.ps1             # do it
```

Non-default install location:

```powershell
.\Deploy-PvxSymbols.ps1 -PIVisionPath 'D:\Program Files\PIPC\PIVision'
```

The script creates `ext`, `ext\icons` and `ext\libraries` if needed, backs up
any existing `ext` folder to `ext-backup-<timestamp>`, copies the files, and
prints what it preserved. It is safe to run repeatedly.

Then:

1. **Recycle the PI Vision application pool**, or run `iisreset`.
2. **Hard-refresh the browser — Ctrl+F5.** PI Vision caches symbol files
   aggressively and a normal refresh serves you the old ones. This is the
   single most common reason a correct deployment looks broken.

#### Copying by hand instead

If execution policy blocks the script, merge `dist\ext` into
`…\Scripts\app\editor\symbols\ext`, preserving the `icons` and `libraries`
subfolders.

**If you copy by hand onto a server that already has PVX, exclude
`libraries\pvx-config.js`** — a blanket copy overwrites your site settings with
a blank file, and the PI Web API symbols will all revert to "not configured"
after what looked like a routine upgrade.

---

## Phase 2 — Confirm it worked

Do not stop at "the files are there". Two checks, in this order:

**The palette.** Open any display, switch to edit mode, scroll to the bottom of
the symbol palette. Thirty-three PVX symbols, each with its own icon. If they are
absent, go to *Troubleshooting* — do not proceed.

**One real symbol.** On a scratch display, drop a **PVX Radial Gauge** onto the
canvas and attach any analog attribute. It should draw a dial with the current
value within one refresh. This proves the whole path — registration, template
resolution, the shared runtime, the data pipeline — in about fifteen seconds,
and it fails loudly rather than subtly if any part of it is wrong.

That is the entire installation for twenty-eight of the thirty-three symbols.

---

## Phase 3 — Configure PI Web API

Only needed for the five symbols that reach things PI Vision cannot hand a
display: Event Frames, the AF hierarchy, and writing values back.

Full background, including what AVEVA recommends and why, is in
**[PI-WEB-API.md](PI-WEB-API.md)**. This is the procedure.

### Step 1 — Measure before you configure

Open this **on the PI Vision server, in a browser, signed in as a normal user**:

```
https://<pivision-server>/Scripts/app/editor/symbols/ext/piwebapi-check.html
```

Enter your PI Web API base URL and run it. It executes exactly what a symbol
executes, from exactly where a symbol executes, and reports which configuration
actually works rather than which one should. It reads only — nothing there
writes to PI.

> **Watch for a partial pass, not just a failure.**
> The dangerous result is *anonymous succeeds while credentialed requests fail*.
> Cross-origin that means either `Access-Control-Allow-Origin` is `*` (browsers
> refuse a wildcard once credentials are attached) or `CorsSupportsCredentials`
> is false.
>
> It matters more than an outright failure because it looks like success. If you
> set `auth: 'anonymous'` on the strength of it, PI Web API stops identifying
> your users: every symbol acts as one identity, PI and AF security can no
> longer distinguish who did what, and manual data entry becomes
> unattributable. **Do not ship that.** Fix the CORS configuration instead —
> the settings table is in [PI-WEB-API.md](PI-WEB-API.md#pi-web-api-configuration).

### Step 2 — Write the settings

Edit, on the server:

```
<PI Vision>\Scripts\app\editor\symbols\ext\libraries\pvx-config.js
```

The shipped file is entirely comments around one call. The minimum is two
lines:

```js
root.PVX.api.configure({
    baseUrl: 'https://piwebapi01.corp.example/piwebapi',
    auth: 'iwa'
});
```

`iwa` is Kerberos/Negotiate and is AVEVA's recommended arrangement. `bearer`,
`basic` and `anonymous` are the alternatives; each is documented inline in the
file itself, with its trade-offs.

Optionally set a default AF database there too, so it does not have to be typed
into every symbol:

```js
root.PVX.api.defaults = {
    databasePath: '\\\\AFSERVER01\\Production',
    eventFrameTemplate: 'Downtime'
};
```

Recycle the app pool and hard-refresh again.

### Step 3 — Confirm

Re-run the diagnostic — it should now pass on the URL you configured. Then place
**PVX Event Timeline** on a scratch display, point it at an AF database with
Event Frames in the display's time window, and confirm it draws.

Use a read-only symbol for this. Do not make `pvxManualEntry` the first thing
you prove, and do not prove it against production attributes.

### Before enabling the write-back symbols

`pvxManualEntry`, `pvxEntryTable` and shared acknowledgement write to PI. Those
writes carry the signed-in user's identity, so a user can write exactly what
their AF and Data Archive mappings already permit.

**That makes it a security review, not a display decision.** Confirm who holds
write access to the attributes in question before putting the symbol on a
display, and never combine writes with `auth: 'anonymous'` — the writes become
unattributable.

---

## Multi-server and load-balanced installations

PI Vision does not replicate the `ext` folder between web servers. Deploy to
**every** node, or operators will see symbols appear and disappear depending on
which server they land on. Behind a load balancer, a fault that looks
intermittent is almost always one node with a stale or missing deployment.

The safe way is to run the script on each node, because it preserves
`pvx-config.js` and takes a backup:

```powershell
# Extract the package to the same local path on each node first — the script
# copies from its own folder, so it has to be alongside the ext directory.
'PIVIS01','PIVIS02' | ForEach-Object {
    Invoke-Command -ComputerName $_ -ScriptBlock {
        & 'C:\Deploy\pvx\Deploy-PvxSymbols.ps1'
    }
}
```

If you push files over an admin share instead, **exclude the site settings
file** — or every upgrade silently blanks it on every node. `robocopy` does this
in one flag and is on every Windows server:

```powershell
'PIVIS01','PIVIS02' | ForEach-Object {
    robocopy .\ext "\\$_\C$\Program Files\PIPC\PIVision\Scripts\app\editor\symbols\ext" `
        /E /XF pvx-config.js
}
```

`/E` copies subdirectories including empty ones; `/XF pvx-config.js` excludes
the one file you must not overwrite. Note that this takes no backup — the deploy
script does, which is why it is the better option where you can run it.

Keep `pvx-config.js` in your own configuration management regardless. It is the
one file that cannot be regenerated from this repository.

---

## Configuration notes that are not obvious

Every symbol's options are documented in
**[SYMBOL-REFERENCE.md](SYMBOL-REFERENCE.md)**. Three need setup that does not
happen inside a single symbol's configuration pane.

**`pvxSlideshow` is configured on every display in the rotation, not on one.**
Navigating away destroys the symbol, so there is no loop running anywhere. Put
the *same* symbol with the *same* display list on each display in the list; each
copy reads the URL to work out where it is and where to go next. Miss one
display and the rotation stops there. Pause is held in `sessionStorage`, so it
survives the navigation it exists to interrupt, and the timer does not run while
a display is in edit mode.

**`pvxSitePlan` needs its background drawing hosted somewhere the browser can
reach.** Put the image on the PI Vision server and reference it by URL.
Hotspots are placed in percentage coordinates, so the layout can be configured
before the drawing exists — the symbol shows a placeholder grid until then.

**`pvxAnnunciator` acknowledgement is session-scoped unless you turn on
`SharedAck`.** Shared acknowledgement writes to an AF attribute and therefore
needs phase 3 plus write access. Left off, each operator's acknowledgements are
their own and vanish when the browser session ends.

---

## Upgrading

Same procedure as phase 1. Notes:

- The script backs up the previous `ext` folder, so a bad upgrade is one folder
  rename away from being undone.
- **`pvx-config.js` is preserved**, so phase 3 does not have to be repeated.
  The script prints `(kept existing site settings)` when it skips it — if you do
  not see that line on a server that was already configured, stop and check.
- Displays already saved with a PVX symbol keep working. Every symbol has a
  `loadConfig` that fills options added by a newer version with their defaults,
  so an old saved configuration is upgraded in place rather than rejected.
- Re-run `npm run verify` before every upgrade.
- **Do not** edit files directly in `ext` on the server — the next deployment
  overwrites them and the change is invisible to source control.
  `pvx-config.js` is the deliberate exception.

---

## Rolling back

```powershell
$ext = 'C:\Program Files\PIPC\PIVision\Scripts\app\editor\symbols\ext'
Copy-Item "$ext\libraries\pvx-config.js" "$env:TEMP\pvx-config.js" -Force
Remove-Item $ext -Recurse -Force
Rename-Item "$ext-backup-<timestamp>" $ext
iisreset
```

The first line is not decoration: if the backup predates your PI Web API
configuration, restoring it reverts the settings too.

Displays that used a symbol which no longer exists show an error placeholder in
that symbol's position; the rest of the display renders normally. Nothing is
lost — restoring the folder restores the symbols.

---

## Removing a single symbol

Delete its four files (`sym-<name>.js`, `-template.html`, `-config.html`,
`.css`) plus `icons\<name>.svg`, and recycle the app pool. Leave both files in
`libraries` in place as long as any PVX symbol remains.

---

## Troubleshooting

**The symbols do not appear in the palette.**
Check `libraries\pvx-core.js` exists. Open the browser console on a display and
look for `[PVX]` messages — the registration wrapper logs the symbol name when a
definition fails to register. Then hard-refresh; a stale cached `sym-*.js` is by
far the most common cause.

**A symbol appears but renders blank.**
Confirm you copied the `-template.html` file alongside the `.js`. PI Vision
resolves the template by filename convention; a missing template gives an empty
box with no console error.

**Icons are missing from the palette.**
The `icons` subfolder was not copied, or the web server is not configured to
serve `.svg`. PI Vision falls back to a generic icon — cosmetic only.

**The configuration pane is empty.**
The `-config.html` file is missing. The symbol still works with its defaults.

**A symbol says "PI Web API is not configured".**
Expected until phase 3 is done, and expected *per server*. Check
`libraries\pvx-config.js` on **the server that browser actually reached** —
behind a load balancer this is the usual cause of a fault that appears
intermittent. If `baseUrl` is set there, run `ext\piwebapi-check.html` on that
same server.

**A PI Web API symbol shows a specific error — cors-or-network, unauthorized,
forbidden, bad-json, timeout.**
Each names a cause and a thing to check rather than "failed to fetch". The full
table is in [PI-WEB-API.md](PI-WEB-API.md#troubleshooting). Reproduce it in the
diagnostic first — it separates reachability from authentication from
permission, and those three have different owners.

**The console shows "pvx-config.js loaded before pvx-core.js".**
PI Vision loads `libraries` alphabetically and `pvx-config` sorts after
`pvx-core`, so this should not happen. If it does, something else in
`libraries` is interfering with load order.

**Everything worked, then stopped after a PI Vision upgrade.**
A PI Vision upgrade replaces the `Scripts` tree, which removes `ext` —
*including your `pvx-config.js`*. Redeploy and restore that file. This is
expected behaviour and the reason `dist/` is reproducible from source: treat the
server copy as disposable, and keep `pvx-config.js` somewhere that is not the
server.

**Symbols render but show no data.**
A data-source problem, not a symbol problem: check the attribute is attached,
the display's time range is sensible, and the tag actually has data in that
window. Symbols with bad-quality data draw a small red dot in the corner and dim
the affected row.

**The slideshow advances once and stops.**
The display it landed on does not have the symbol on it. Every display in the
rotation needs its own copy — see *Configuration notes* above.

---

## Security notes

- **Twenty-eight of the thirty-three symbols make no network calls of their own.** They
  render only the data PI Vision hands them and have no server-side
  prerequisites beyond the file copy.
- **Five symbols call PI Web API**, and only after `pvx-config.js` gives them a
  `baseUrl`. Requests carry the signed-in user's identity under the configured
  strategy, so **PI and AF security remain the access control** — PVX adds no
  permission model of its own and cannot grant access a user does not already
  have.
- **Writes are never cached, retried or batched.** A write is not idempotent
  from an operator's point of view, and quietly repeating one is how a wrong
  number reaches the historian. Symbols validate before sending, confirm with a
  human, and report each row's outcome separately.
- **`pvx-config.js` is served to the browser.** Do not put a secret in it.
  `basicCredentials` exists for development and puts a credential in a file on a
  web server; for production use `iwa`, or `bearer` with a `getToken` that
  fetches from an endpoint requiring the user's own session.
- All data-derived text is written with `textContent` or escaped, so a tag name
  containing markup cannot inject HTML into a display.
- The navigation symbols drive navigation through PI Vision's own URL contract
  (`#/Displays/<id>?asset=…&starttime=…`), not through private internal APIs.
  External `http(s)` targets open with `rel=noopener` semantics.
- No third-party JavaScript is deployed to the server.
