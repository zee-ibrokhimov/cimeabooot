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

  // Auto session-refresh: click CIMEA's "refresh token" button on a RANDOM
  // interval in this range so the login doesn't expire while you wait for the
  // drop. Randomized (not a fixed cadence) to look less robotic.
  SESSION_REFRESH_MIN_MS: 30 * 60 * 1000, // 30 min
  SESSION_REFRESH_MAX_MS: 50 * 60 * 1000, // 50 min

  // Stuck-load watchdog: during the 15:00 rush CIMEA often HANGS (spinner /
  // pending request that never resolves). If the bot is active on a CIMEA page
  // but nothing happens for this long, reload to try a fresh, maybe
  // less-loaded response instead of waiting. Lower = catch hangs sooner but
  // reload more (may abandon a slow-but-real load); tune to taste.
  STUCK_RELOAD_MS: 8 * 1000, // 8s — page loaded but idle/dead

  // While the page is genuinely still loading (base load or a visible spinner),
  // the watchdog WAITS instead of reloading (reloading a slow load just restarts
  // it). It only gives up after this longer grace.
  LOADING_MAX_MS: 15 * 1000, // 15s

  // How fast the bot reacts after CIMEA changes the page. Lower = notices the
  // next step sooner (higher retry rate) at a little more CPU. The per-step wait
  // is mostly CIMEA's server, but this trims the bot's own reaction lag.
  DETECT_THROTTLE_MS: 90,   // debounce after a DOM mutation before re-checking
  FAILSAFE_CHECK_MS: 350,   // periodic re-check even if no mutation fires

  // Scheduled auto-start: how far apart each open tab auto-starts (ms). Tab #0
  // fires at the target time, #1 at +STAGGER_GAP_MS, #2 at +2×, etc., so several
  // tabs/windows don't all refresh in the same instant.
  STAGGER_GAP_MS: 400,

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
