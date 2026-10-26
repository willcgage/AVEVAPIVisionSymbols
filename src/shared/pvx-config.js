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
 * Only the five symbols that talk to PI Web API care about any of this — Event
 * Frames, AF browsing and manual data entry — plus pvxAnnunciator if SharedAck
 * is turned on. The other twenty-five symbols run entirely on PI Vision's own
 * data pipeline and need nothing here.
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
        maxBatchSize: 50        // sub-requests per /batch call

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
