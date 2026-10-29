# Connecting PVX to PI Web API

Most of the library needs none of this. Forty-one of the fifty-one symbols run
entirely on PI Vision's own data pipeline. Only the ten that reach things PI
Vision cannot hand a display — Event Frames, the AF hierarchy, AF tables, writing values
back, an asset's place in AF — need it: `pvxGeoView` (unless its locations are typed in), `pvxEventGantt`, `pvxEventAnalytics`, `pvxEventList`, `pvxAssetTree`,
`pvxAssetTable`, `pvxAssetRollup`, `pvxLookupTable`, `pvxManualEntry` and `pvxEntryTable`. Of the rest,
ten more use it only for an option you turn on: event frames on `pvxComboChart`, look-ahead past the display's end and a target from AF on `pvxTargetForecast`, limits from AF on `pvxControlChart`, a target from AF on `pvxKpiCard`, a menu from AF on `pvxNavPanel` and on `pvxDisplayMenu`, shared acknowledgement on `pvxAnnunciator` and reading it on `pvxAlarmTone`, History mode on `pvxAlarmBanner`, which reads recorded values, and runs from event frames on `pvxPeriodOverlay`. Any symbol's **Quick trend** button, also off until set, reads its sources' history from PI Web API when pressed, and a time-series symbol set to its **own time range** reads recorded values for it.

---

## What AVEVA recommends, and what that means for us

Three things from AVEVA's own guidance shape the design:

**Kerberos with constrained delegation is the recommended arrangement.**
AVEVA's PI Vision security guidance calls for constrained delegation between
the PI Vision application servers, Data Archive and AF, with Negotiate/NTLM as
a fallback and Basic over TLS permitted for mobile clients. So `iwa` is PVX's
default authentication strategy.

**Cross-origin is the arrangement AVEVA documents.** Their guidance tells you
to set PI Web API's `CorsOrigins` to the explicit PI Vision hostname URLs
"not just the asterisk" — which only matters if PI Web API is on a different
origin from PI Vision. Your current layout, PI Web API on its own server, is
the normal one. You do not need to move it.

**OIDC is supported on both sides, but not as one continuous token.** PI Web
API's Admin Utility offers "OpenId Connect / Bearer" registered against an AIM
server. PI Vision also authenticates users via OIDC — but it talks to its own
backends using a dedicated Process Identity, and does not hand the signed-in
user's token to display code. A symbol therefore cannot borrow PI Vision's
session; if you want bearer auth, the token has to come from somewhere you
control. See *Bearer tokens* below.

### A correction worth recording

Co-installing PI Web API on the PI Vision server is **not** a reliable way to
get same-origin. PI Web API is self-hosted rather than IIS-hosted and wants
port 443, which PI Vision's IIS site already has; the usual resolution is to
move PI Web API to another port — and **a different port is a different origin
to the browser**. You would still be doing CORS, having gained nothing and
spent an installation. Only a reverse proxy under the PI Vision site genuinely
produces same-origin, and that adds an identity hop of its own.

Verify the port behaviour on your own build before acting on this either way.

---

## Before configuring anything, measure

Deploy the library, then open this on the PI Vision server, in a browser,
signed in as a normal user:

```
https://<pivision-server>/Scripts/app/editor/symbols/ext/piwebapi-check.html
```

It runs exactly what a symbol runs, from exactly where a symbol runs, and tells
you which configuration actually works rather than which one should. It reads
only — nothing there writes to PI.

It ships inside the `ext` folder deliberately. Opened from a file path or
another host it would be testing a different origin, and would give you a
confidently wrong answer.

### The result to watch for

The dangerous outcome is not failure, it is a **partial pass**: anonymous
succeeds while credentialed requests fail. Cross-origin that means either
`Access-Control-Allow-Origin` is `*` (browsers refuse a wildcard once
credentials are attached — exactly why AVEVA says to list explicit origins) or
`CorsSupportsCredentials` is false.

It matters more than an outright failure because it looks like success. If you
configured `auth: 'anonymous'` on the strength of it, PI Web API would stop
identifying your users: every symbol would act as one identity, PI and AF
security could no longer distinguish who did what, and manual data entry would
be unattributable. The diagnostic calls this out by name rather than reporting
a cheerful "connected".

---

## PI Web API configuration

In the PI Web API Admin Utility, under the system configuration:

| Setting | Value |
|---|---|
| `CorsOrigins` | Every PI Vision URL users actually type, comma separated, no spaces. Scheme, host and port must match exactly — `https://pivision01` and `https://pivision01.corp.example` are different origins. |
| `CorsSupportsCredentials` | `true` — required for Kerberos or any cookie-based identity |
| `CorsHeaders` | `*` |
| `CorsMethods` | `GET,OPTIONS,POST,PUT,PATCH` |
| `AuthenticationMethods` | `Kerberos` (add `Basic` only if you need it) |

**The preflight must be answered anonymously.** A credentialed cross-origin
request is preceded by an `OPTIONS` request that carries no credentials by
definition. If that gets a 401 challenge, Chrome and Firefox abandon the whole
request and the symbol sees an opaque network error. This is the single most
common reason the integration "just doesn't work".

Also confirm:

- The certificate matches the hostname in `baseUrl`. A name mismatch fails in a
  way that looks like a CORS problem and sends people down the wrong path.
- The browser is willing to send Windows credentials to that host — Local
  Intranet zone, or the equivalent enterprise browser policy.

---

## PVX configuration

One file per PI Vision server:

```
<PIVision>\Scripts\app\editor\symbols\ext\libraries\pvx\pvx-config.js
```

```js
var siteSettings = {
    baseUrl: 'https://piwebapi01.corp.example/piwebapi',
    auth: 'iwa',
    …
```

(Up to 1.6.0 it lived one folder up, in `ext\libraries`; both installers move
it.) **Neither `Deploy-PvxSymbols.ps1` nor the MSI will overwrite this file**
if it already exists on the server. Everything else in the library is generated and replaced on every
deployment; this one is yours. Keep a copy in your own configuration management
regardless.

**It is the only place PI Web API is configured.** Up to 1.13.0 the six
symbols that call PI Web API also had a "PI Web API base URL override" in
their format panes. It was removed in 1.14.0: it moved the address for every
symbol on the page, not just the one it was set on, so two symbols with
different values fought over it. A value saved in an older display is
ignored.

**Deploy it to every PI Vision server.** PI Vision does not replicate the `ext`
folder between nodes, so behind a load balancer a user who lands on the
unconfigured server sees the "not configured" state.

### PI Web API on the PI Vision server itself: nothing to set

If `baseUrl` is blank, the symbols look for PI Web API on the PI Vision server
they were loaded from, at `https://<the address PI Vision was opened with>/piwebapi`.
They ask once per page (a `GET` of the service root, which must come back as
PI Web API's JSON with a `Links` object) and remember the answer. Where PI Web
API is installed beside PI Vision (both on port 443, which HTTP.sys allows)
that is the whole configuration, and because the requests are same-origin
there is no CORS to set up: none of the preflight problems above can arise.

PVX cannot use PI Vision's own connection to AF instead. PI Vision reaches AF
from the server through AF SDK and gives display code no supported way in; its
internal `/PIVision/Services` endpoints are undocumented, change between
releases and cannot write values. Same-server discovery is the supported way to
get the same "it just works".

Where nothing answers there, the symbols show the same "PI Web API is not
configured" message as before, naming the address they tried, this file, and
the diagnostic page. Set `autoDiscover: false` to skip the look and keep the
blank-means-off behaviour of 1.12.0 and earlier. An explicit `baseUrl` always
wins.

On a server without PI Web API the browser console shows one 404 for
`/piwebapi/` per page: that is the probe, and it is harmless. Setting
`baseUrl` or `autoDiscover: false` stops it.

Each PI Vision server looks on itself, so behind a load balancer every node
needs its own PI Web API for this to work, or an explicit `baseUrl`.

### AF database: taken from the symbol when left blank

Event Timeline, Event Analytics and Asset Tree need an AF database. When the
database field in the format pane is blank they use, in order:

1. the database of the AF attribute dropped on the symbol, as PI Vision last
   sent it, so an asset swap carries it along;
2. the database of the display's asset (`?asset=` in the URL);
3. `databasePath` in `pvx-config.js`, a site-wide fallback.

The footer says which one is in use ("database \\AF\Production from this
symbol's data source"). Nothing is written into the saved display, so a symbol
keeps following its data source. The **Search** pane of every AF field also
opens on the database and element of the symbol's data source when the field
is empty.

### Bearer tokens

```js
root.PVX.api.configure({
    baseUrl: 'https://piwebapi01.corp.example/piwebapi',
    auth: 'bearer',
    getToken: function () {
        // Return a token, or a Promise of one. Called before every request,
        // so cache and refresh inside your own implementation.
        return fetch('/token-broker/piwebapi', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (j) { return j.access_token; });
    }
});
```

The token must be issued for **PI Web API's audience**. PI Vision's session
token is not that token. Two workable sources:

1. A silent PKCE flow against your IdP with its own client registration for the
   symbol library. Self-contained, but it is a real piece of work — client
   registration, redirect handling, silent renewal — and it lives in this file
   rather than in a symbol.
2. A small token-broker endpoint on the PI Vision server that exchanges the
   user's session for a PI Web API token. Moves the complexity to a place your
   platform team already operates.

Given Kerberos is AVEVA's recommendation and needs no token infrastructure at
all, bearer is worth the effort mainly if you are moving off Windows
authentication entirely.

---

## Write access

`pvxManualEntry` and the other write-back symbols post values to PI. Before
deploying any of them:

- **PI and AF security are the access control.** Requests carry the signed-in
  user's identity, so a user can write exactly what their AF and Data Archive
  mappings already permit. Confirm who that is for the attributes in question.
  This is a security review, not a display decision.
- Anonymous authentication makes writes unattributable. Do not combine them.
- PVX never caches, retries or batches a write. A write is not idempotent from
  an operator's point of view, and quietly repeating one is how a wrong number
  reaches the historian.

---

## Troubleshooting

Every failure surfaces a specific message and a "what to check" line rather
than "failed to fetch", and where PI Web API's reply carries its own `Errors`
text, the message ends with it as *PI Web API said: …*. The codes map as follows.

| What you see | Where to look |
|---|---|
| **not-configured** | `baseUrl` is blank in `ext/libraries/pvx/pvx-config.js` on *this* PI Vision server, and nothing answered at `/piwebapi` on the same server (the message names the address tried) |
| **cors-or-network** | First, whether PI Web API is on this PI Vision server: then leave `baseUrl` blank, so it is asked under the same name as the page. The message names both addresses. Otherwise the preflight: `CorsOrigins`, `CorsSupportsCredentials`, and whether `OPTIONS` is answered without a challenge |
| **network** (same-origin) | Base URL, the service, the certificate name |
| **unauthorized** (401) | Browser willingness to send Windows credentials to that host; or for bearer, the token's audience and expiry |
| **forbidden** (403) | Authenticated but not permitted — AF and Data Archive mappings for this user |
| **bad-json** | A proxy or a login page answered instead of the API. Common when a gateway sits in front and redirects unauthenticated requests |
| **backend** (502) | PI Web API answered but could not connect onward to AF or the Data Archive as the user. With Windows authentication that is Kerberos delegation: PI Web API's service account must be trusted to delegate to the AF and Data Archive servers, as PI Vision's application pool already is. The check page's *AF databases* test shows it; the AF server list alone does not, because PI Web API answers that from its own Known Servers Table |
| **timeout** | PI Web API load, or a query with no `maxCount` |
| **no-token** | `auth: 'bearer'` with no working `getToken` |
| **stalled** (Asset Navigator) | A load that outlived the request timeout without settling. The message names the step and the address; open that address in the same browser |

Two habits that save time:

- **Reproduce in the diagnostic first.** It isolates reachability from
  authentication from permission, and those three have different owners.
- **Check one PI Vision server at a time.** Behind a load balancer an
  intermittent fault is usually one node with a stale or missing
  `pvx-config.js`.
