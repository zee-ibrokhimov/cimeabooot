// =============================================================================
// CIMEA Helper Pro — central configuration
// Loaded by both the background service worker (via importScripts) and the
// content script. Edit DEFAULT_SERVER_BASE once, or set it in the popup.
// =============================================================================

var CIMEA_CONFIG = {
  // -------------------------------------------------------------------------
  // Login is ALWAYS required — there is no off-switch. Automation only runs
  // with a valid session issued by your server (enforced in background.js).
  // This used to be a REQUIRE_LOGIN flag; it was removed so nobody can flip one
  // line to disable the gate.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Your server base URL. Baked in so users don't type it.
  //   Derived endpoints:  <base>/api/auth/code , <base>/api/track , ...
  // -------------------------------------------------------------------------
  DEFAULT_SERVER_BASE: "https://cimea.zeehub.xyz",

  // Telegram bot the "Request a login code" button opens so users can get their
  // access code (owner approves it there). Just the bot's public @handle link.
  TELEGRAM_BOT_URL: "https://t.me/cimearadarbot",

  // Whether anonymous analytics is ON by default (user can toggle in popup).
  DEFAULT_ANALYTICS_CONSENT: true,

  // Re-verify the login with the server at most this often (ms). Between checks
  // a cached "authorized" answer is used so we don't hammer the server.
  AUTH_VERIFY_TTL_MS: 5 * 60 * 1000,

  // How long a previously-good token is honored when the server can't be
  // reached (transient failure grace), as a multiple of the TTL above.
  AUTH_GRACE_MULT: 2,

  // While automation is running, re-check authorization at least this often so
  // a revoked/disabled user is stopped mid-run (not only at start).
  AUTH_RECHECK_MS: 60 * 1000,

  // -------------------------------------------------------------------------
  // PAGE DETECTION + DOM SELECTORS moved to the server (Layer 3). The extension
  // fetches them from <base>/api/playbook with a valid session and caches them
  // per run. They are deliberately NOT here, so an offline/edited copy has no
  // recipe to run, and only logged-in users get updates when CIMEA changes.
  // -------------------------------------------------------------------------

  // How long a fetched playbook is reused before refetching (ms). One fetch per
  // run/window, not per action — so this adds no per-click latency.
  PLAYBOOK_TTL_MS: 10 * 60 * 1000,

  // -------------------------------------------------------------------------
  // PRIVACY ALLOWLIST — the ONLY fields that may ever leave the device.
  // The analytics sender rejects anything not on this list. Card details,
  // CVC and cardholder name are deliberately absent and can never be
  // transmitted.
  // -------------------------------------------------------------------------
  ANALYTICS_ALLOWED_FIELDS: [
    "event",       // event name (see ANALYTICS_ALLOWED_EVENTS)
    "clientId",    // random anonymous id generated locally
    "sessionId",   // random id for one automation run
    "extVersion",  // extension version string
    "step",        // coarse page step, e.g. "payment_page"
    "retries",     // number of retry clicks this run
    "durationMs",  // run duration
    "errorType",   // coarse error label, e.g. "server_502"
    "ts"           // ISO timestamp
  ],

  // Only these event names are accepted (client + server both enforce this).
  ANALYTICS_ALLOWED_EVENTS: [
    "extension_installed",
    "automation_started",
    "automation_stopped",
    "payment_page_reached",
    "save_next_clicked",
    "daily_limit_hit",
    "server_crash_detected",
    "payment_success",
    "error"
  ],

  // Defense-in-depth: if any key or meta value matches these patterns the
  // whole analytics event is dropped and logged. Belt-and-suspenders on top
  // of the allowlist above.
  SENSITIVE_KEY_PATTERNS: [
    /card/i, /cvc/i, /cvv/i, /\bpan\b/i, /expir/i, /holder/i,
    /token/i, /chat/i, /secret/i, /password/i, /passwd/i, /\bpin\b/i
  ],

  // Keys that hold sensitive data in chrome.storage.local. Listed here purely
  // so the analytics module can assert it never reads them.
  SENSITIVE_STORAGE_KEYS: [
    "cardName", "cardNum", "cardExp", "cardCvc"
  ]
};

// Make available in a service-worker (importScripts) context too.
if (typeof self !== "undefined") {
  self.CIMEA_CONFIG = CIMEA_CONFIG;
}
