/* ============================================================================
 * pvx-config.js — PER-SITE deployment settings
 * ----------------------------------------------------------------------------
 * Deployed to: <PIVision>\Scripts\app\editor\symbols\ext\libraries\pvx-config.js
 *
 * THIS FILE IS YOURS. Everything else in the library is generated from source
 * and overwritten on every deployment; this one is not. Deploy-PvxSymbols.ps1
 * skips it if it already exists on the server, so your settings survive an
 * upgrade. Keep a copy in your own configuration management anyway.
 *
 * Only the five symbols that talk to PI Web API care about any of this — Event
 * Frames, AF browsing and manual data entry — plus pvxAnnunciator if SharedAck
 * is turned on. The other twenty-five symbols run entirely on PI Vision's own
 * data pipeline and need nothing here.
 *
 * If baseUrl is left blank, those symbols show a clear "PI Web API is not
 * configured" state instead of failing obscurely. That is the intended default:
 * a library deployed without this file being edited does nothing surprising.
 * ==========================================================================*/
(function (root) {
    'use strict';

    if (!root.PVX || !root.PVX.api) {
        // pvx-core.js has not loaded. PI Vision loads libraries alphabetically,
        // so pvx-config sorts after pvx-core and this should not happen — but if
        // it ever does, say so loudly rather than failing silently at render.
        if (root.console) {
            root.console.error('[PVX] pvx-config.js loaded before pvx-core.js — PI Web API settings ignored.');
        }
        return;
    }

    root.PVX.api.configure({

        /* -- Where PI Web API lives ---------------------------------------- *
         * The full base URL including /piwebapi, no trailing slash.
         * Must be reachable FROM THE BROWSER, not just from the PI Vision
         * server — that distinction catches people out.
         *
         *   'https://piwebapi01.corp.example/piwebapi'
         *
         * The hostname must match the certificate, or every call fails on a
         * TLS error that looks like a CORS problem.
         */
        baseUrl: '',

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

    });

    /* -- Optional: default AF database for the Event Frame symbols ---------- *
     * Saves setting it on every symbol. A symbol's own config still wins.
     *
     *   root.PVX.api.defaults = {
     *       databasePath: '\\\\AFSERVER01\\Production',
     *       eventFrameTemplate: 'Downtime'
     *   };
     */

}(window));
