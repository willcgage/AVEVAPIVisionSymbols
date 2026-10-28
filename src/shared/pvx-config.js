/* ============================================================================
 * pvx-config.js — PER-SITE deployment settings
 * ----------------------------------------------------------------------------
 * Deployed to: <PIVision>\Scripts\app\editor\symbols\ext\libraries\pvx\pvx-config.js
 *
 * THIS FILE IS YOURS. Everything else in the library is generated from source
 * and overwritten on every deployment; this one is not. Deploy-PvxSymbols.ps1
 * skips it if it already exists on the server and the MSI never overwrites or
 * removes it, so your settings survive an upgrade. Keep a copy in your own
 * configuration management anyway.
 *
 * Upgrading from 1.6.0 or earlier, this file used to live one folder up, in
 * ext\libraries\. Both installers move it here for you. If you are editing a
 * copy carried over from then, replace everything outside the settings block
 * with this version: the old wrapper ignored the settings whenever PI Vision
 * happened to load this file before pvx-core.js.
 *
 * Most of this concerns only the symbols that talk to PI Web API — Event
 * Frames, AF browsing and manual data entry — plus pvxAnnunciator if SharedAck
 * is turned on. The rest run entirely on PI Vision's own data pipeline and
 * need nothing here. The one exception is the optional site theme at the end,
 * which every symbol follows.
 *
 * If baseUrl is left blank, those symbols look for PI Web API on this PI
 * Vision server itself, at https://<this server>/piwebapi, once per page. Where
 * PI Web API is installed alongside PI Vision that is all the setup there is.
 * Where nothing answers there, they show a clear "PI Web API is not
 * configured" state naming the address they tried, instead of failing
 * obscurely. Set autoDiscover: false below to skip the look and keep the
 * blank-means-off behaviour of 1.12.0 and earlier.
 * ==========================================================================*/
(function (root) {
    'use strict';

    var siteSettings = {

        /* -- Where PI Web API lives ---------------------------------------- *
         * The full base URL including /piwebapi, no trailing slash.
         * Must be reachable FROM THE BROWSER, not just from the PI Vision
         * server — that distinction catches people out.
         *
         *   'https://piwebapi01.corp.example/piwebapi'
         *
         * The hostname must match the certificate, or every call fails on a
         * TLS error that looks like a CORS problem.
         *
         * Leave it blank when PI Web API runs on this PI Vision server: the
         * symbols find it at /piwebapi on the same address PI Vision is
         * opened with, and same-origin requests need no CORS setup at all.
         */
        baseUrl: '',

        /* -- Look on this server when baseUrl is blank ----------------------- *
         * true:  ask https://<this PI Vision server>/piwebapi once per page.
         * false: blank baseUrl means the PI Web API symbols stay switched off.
         */
        autoDiscover: true,

        /* -- AF database for symbols that have none of their own ------------- *
         * Event Timeline, Event Analytics and Asset Tree use, in order: the
         * database in their own format pane; the database of the attribute
         * dropped on them; the database of the display's asset; and then this.
         *
         *   databasePath: '\\\\AFSERVER01\\Production',
         */
        databasePath: '',

        /* -- How to authenticate -------------------------------------------- *
         *   'iwa'        Kerberos / Negotiate. AVEVA's recommended arrangement.
         *                The browser attaches the user's Windows credentials.
         *                Cross-origin, this needs CorsSupportsCredentials=true
         *                on PI Web API and the OPTIONS preflight answered
         *                WITHOUT an auth challenge.
         *
         *   'bearer'     OpenID Connect. PI Web API must be set to
         *                "OpenId Connect / Bearer" in its Admin Utility. Supply
         *                getToken below — the token has to be issued for PI Web
         *                API's audience, and PI Vision's own session token is
         *                not that token.
         *
         *   'basic'      Development only. Puts a credential in a file on a web
         *                server; there is nearly always a better option.
         *
         *   'anonymous'  Only if PI Web API is deliberately open.
         */
        auth: 'iwa',

        /* -- Bearer token supplier ------------------------------------------ *
         * Return a token string, or a Promise of one. Called before every
         * request, so cache and refresh inside your own implementation rather
         * than returning an expired token.
         *
         * PI Vision does not hand the signed-in user's token to display code —
         * with OIDC it authenticates to its backends using its own Process
         * Identity — so this has to come from somewhere you control: a silent
         * PKCE flow against your IdP with PI Web API as the audience, or a
         * token endpoint your platform team exposes.
         *
         *   getToken: function () {
         *       return fetch('/token-broker/piwebapi', { credentials: 'include' })
         *           .then(function (r) { return r.json(); })
         *           .then(function (j) { return j.access_token; });
         *   },
         */
        getToken: null,

        /* -- Basic credentials, development only ---------------------------- */
        basicCredentials: null,

        /* -- Tuning ---------------------------------------------------------- */
        timeoutMs: 20000,
        cacheTtlMs: 30000,      // shared GET cache; a display has many symbols
                                // asking overlapping questions on one refresh
        maxBatchSize: 50,       // sub-requests per /batch call

        /* -- Site theme, optional ------------------------------------------- *
         * A corporate look set once for every PVX symbol on this server,
         * instead of in each symbol's format pane. Every key is optional, and
         * whatever a symbol sets for itself (Theme, Background, Text color)
         * still wins. Colors are hex or rgb()/rgba(); anything else is
         * ignored and named in the browser console as "[PVX] pvx-config.js
         * theme: ... ignored."
         *
         *   theme: {
         *       palette: ['#00539b', '#f7a800', '#5b8f22', '#a4343a', '#6d4c91'],
         *       status:  { normal: '#2e7d32', warning: '#ef8a00', alarm: '#c62828' },
         *       light:   { surface: '#ffffff', text: '#1b1f24', border: '#c9ced4' },
         *       dark:    { surface: '#1e2228', text: '#eef1f4' },
         *       font:    '"Arial", sans-serif',
         *       container: { radius: 4, border: '1px solid #c9ced4', shadow: '0 1px 2px rgba(0,0,0,0.15)' }
         *   },
         *
         * palette    series colors, in order (at least two)
         * status     normal, info, warning, alarm, critical, stale, unknown
         * light/dark surface, surfaceAlt, border, text, textMuted, grid, axis, track
         * container  every symbol's card: corner radius in px, border, shadow
         */
        theme: null,

        /* -- Map tiles for pvxGeoView, optional ----------------------------- *
         * The Geo View draws its map from a tile server named here, and from
         * nowhere else: without one it shows a latitude and longitude grid.
         * Any server of Web Mercator tiles addressed {z}/{x}/{y} will do, such
         * as a GIS server on the site's own network. Each viewer's browser asks
         * it for the tiles, so it must be reachable from there, and its terms
         * of use are the site's to meet.
         *
         *   map: {
         *       tileUrl: 'https://gis.example.com/tiles/{z}/{x}/{y}.png',
         *       attribution: 'Map data (c) Example GIS',
         *       maxZoom: 18,
         *       subdomains: ''          // 'abc' fills {s} in the address
         *   },
         */
        map: null

    };

    /* -- Hand the settings to pvx-core.js, whichever loads first ----------- *
     * Leave this part alone. PI Vision does not promise an order for the files
     * in a libraries folder, and if it goes by name, "pvx-config" sorts BEFORE
     * "pvx-core". The version of this file shipped up to 1.6.0 assumed the
     * opposite and silently dropped its settings when that assumption failed.
     * Now the settings are applied at once if the core is already there, and
     * queued for it to pick up when it loads otherwise.
     */
    var PVX = root.PVX = root.PVX || {};
    if (PVX.api && PVX.api.configure) {
        PVX.api.configure(siteSettings);
    } else {
        (PVX.pendingSiteSettings = PVX.pendingSiteSettings || []).push(siteSettings);
    }

}(window));
