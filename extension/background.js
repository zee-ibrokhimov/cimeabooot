// =============================================================================
// CIMEA Helper Pro — background service worker
//
// This is the ONLY place in the extension that sends data to your server.
// - Login/session is handled here; the automation is gated on a valid session.
// - Analytics enforces a strict field allowlist so sensitive data (card number,
//   CVC, cardholder name) can never be transmitted.
// =============================================================================

importScripts("config.js");

const CFG = CIMEA_CONFIG;

// -----------------------------------------------------------------------------
// Small promise wrappers around chrome.storage so we can use async/await and
// avoid "Extension context invalidated" crashes after a reload.
// -----------------------------------------------------------------------------
function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    } catch (_) {
      resolve({});
    }
  });
}
function storageSet(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

// -----------------------------------------------------------------------------
// Fast Load: block heavy, non-essential resources (images, fonts, media) on the
// CIMEA pages so each reload is quicker. CSS/JS/XHR are left alone so the app
// still renders and the bot's clicks work. The Nexi payment page is NOT touched
// (payment UI must render fully).
// -----------------------------------------------------------------------------
const FASTLOAD_RULE_ID = 1001;
async function applyFastLoad(enabled) {
  try {
    if (!chrome.declarativeNetRequest) return;
    if (enabled) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [FASTLOAD_RULE_ID],
        addRules: [{
          id: FASTLOAD_RULE_ID,
          priority: 1,
          action: { type: "block" },
          condition: {
            initiatorDomains: ["cimea-diplome.it"],
            resourceTypes: ["image", "font", "media"]
          }
        }]
      });
    } else {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [FASTLOAD_RULE_ID] });
    }
  } catch (e) {
    console.warn("[CIMEA] fastLoad rule error:", e && e.message);
  }
}
async function initFastLoad() {
  const { fastLoad } = await storageGet(["fastLoad"]);
  await applyFastLoad(fastLoad !== false); // default on
}
initFastLoad();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.fastLoad) {
    applyFastLoad(changes.fastLoad.newValue !== false);
  }
});

// -----------------------------------------------------------------------------
// Server + authentication.
// The extension is gated: automation and analytics only work while the user has
// a valid session token issued by your server.
//
// The session token is kept in chrome.storage.session (NOT local): it is not
// written to disk and is not exposed to content scripts, so the CIMEA/Nexi page
// context can never read it. The password is never persisted at all.
// -----------------------------------------------------------------------------
function sessionGet(keys) {
  return new Promise((resolve) => {
    try { chrome.storage.session.get(keys, (r) => resolve(r || {})); }
    catch (_) { resolve({}); }
  });
}
function sessionSet(obj) {
  return new Promise((resolve) => {
    try { chrome.storage.session.set(obj, () => resolve()); }
    catch (_) { resolve(); }
  });
}
async function clearSession() {
  await sessionSet({ authToken: "", authVerifiedAt: 0 });
}

async function getServerBase() {
  const { serverBase } = await storageGet(["serverBase"]);
  return (serverBase || CFG.DEFAULT_SERVER_BASE || "").trim().replace(/\/+$/, "");
}

// Exchange a Telegram-issued access code (+ this browser's device id) for a
// rotating session token. The code is stored in storage.local (so it survives
// restarts and we can silently re-activate); the session token stays in
// storage.session (off disk). The code is device-bound server-side.
async function authActivate(code) {
  const base = await getServerBase();
  if (!base) return { ok: false, error: "no_server" };
  const clientId = await getClientId();
  try {
    const res = await fetch(base + "/api/auth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, clientId }),
      credentials: "omit"
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) {
      await storageSet({ accessCode: code });
      await sessionSet({ authToken: data.token, authVerifiedAt: Date.now() });
      return { ok: true };
    }
    return { ok: false, error: data.error || "invalid" };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "network" };
  }
}

// Silently exchange the stored code for a fresh session (on startup / after a
// session expires). True if we now hold a valid session.
async function reactivateFromCode() {
  const { accessCode } = await storageGet(["accessCode"]);
  if (!accessCode) return false;
  return !!(await authActivate(accessCode)).ok;
}

async function verifyAuth() {
  const base = await getServerBase();
  if (!base) return false;
  const { authToken } = await sessionGet(["authToken"]);
  // No live session -> try to (re)activate from the stored code.
  if (!authToken) return await reactivateFromCode();
  try {
    const res = await fetch(base + "/api/auth/verify", {
      method: "POST",
      headers: { "Authorization": "Bearer " + authToken },
      credentials: "omit"
    });
    if (res.ok) {
      await sessionSet({ authVerifiedAt: Date.now() });
      return true;
    }
    // Definitive deny -> this session is dead. Clear it and try to re-activate
    // from the code: if the account is still valid we get a rotated session; if
    // the account was disabled the re-activation also fails (-> not authorized).
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      await clearSession();
      return await reactivateFromCode();
    }
    return false; // transient network / 5xx
  } catch (_) {
    return false;
  }
}

// Cached authorization: fresh session within the TTL, else verify/re-activate.
async function isAuthorized() {
  if (!CFG.REQUIRE_LOGIN) return true; // standalone/personal mode — no gate
  const { authToken, authVerifiedAt } = await sessionGet(["authToken", "authVerifiedAt"]);
  if (authToken && authVerifiedAt && (Date.now() - authVerifiedAt) < CFG.AUTH_VERIFY_TTL_MS) return true;
  if (await verifyAuth()) return true;
  // Grace window on transient failures only.
  const { authToken: stillHave } = await sessionGet(["authToken"]);
  const graceMs = CFG.AUTH_VERIFY_TTL_MS * (CFG.AUTH_GRACE_MULT || 2);
  return !!(stillHave && authVerifiedAt && (Date.now() - authVerifiedAt) < graceMs);
}

// Like isAuthorized() but ALWAYS hits the server (no TTL cache) so the mid-run
// recheck catches revocation promptly. Still honors the transient-failure grace.
async function isAuthorizedLive() {
  if (!CFG.REQUIRE_LOGIN) return true;
  const { authVerifiedAt } = await sessionGet(["authVerifiedAt"]);
  if (await verifyAuth()) return true;
  const { authToken: stillHave } = await sessionGet(["authToken"]);
  const graceMs = CFG.AUTH_VERIFY_TTL_MS * (CFG.AUTH_GRACE_MULT || 2);
  return !!(stillHave && authVerifiedAt && (Date.now() - authVerifiedAt) < graceMs);
}

async function authLogout() {
  const base = await getServerBase();
  const { authToken } = await sessionGet(["authToken"]);
  if (base && authToken) {
    try {
      await fetch(base + "/api/auth/logout", {
        method: "POST",
        headers: { "Authorization": "Bearer " + authToken },
        credentials: "omit"
      });
    } catch (_) { /* ignore */ }
  }
  await clearSession();
  await storageSet({ accessCode: "", automationActive: false });
}

async function authStatus() {
  const { accessCode } = await storageGet(["accessCode"]);
  const base = await getServerBase();
  return {
    requireLogin: !!CFG.REQUIRE_LOGIN,
    loggedIn: !!accessCode, // the code is the persistent credential
    serverBase: base
  };
}

// -----------------------------------------------------------------------------
// Anonymous client id — a random UUID stored locally. Lets the dashboard count
// unique users without any personal data.
// -----------------------------------------------------------------------------
async function getClientId() {
  const { clientId } = await storageGet(["clientId"]);
  if (clientId) return clientId;
  const id = (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await storageSet({ clientId: id });
  return id;
}

// -----------------------------------------------------------------------------
// THE analytics choke-point.
// `meta` may only contain: step, retries, durationMs, errorType, sessionId.
// Everything else is ignored. The final payload is rebuilt from the allowlist,
// then re-scanned for sensitive patterns before it is allowed to leave.
// -----------------------------------------------------------------------------
async function sendAnalytics(event, meta = {}) {
  try {
    if (!CFG.ANALYTICS_ALLOWED_EVENTS.includes(event)) {
      console.warn("[CIMEA] analytics: rejected unknown event:", event);
      return;
    }

    const base = await getServerBase();

    // Usage analytics is always shared with the owner (no user opt-out) — it's
    // how the owner sees who's using each code + powers sharing detection. Still
    // gated on a server + a valid session (nothing to send in standalone mode).
    if (!base) return;
    if (!(await isAuthorized())) return;
    const { authToken: token } = await sessionGet(["authToken"]);
    if (!token) return;

    const clientId = await getClientId();

    // Rebuild the payload from the allowlist ONLY. Note that card/token keys
    // are not present here and there is no code path that reads them.
    const safeMeta = {
      step: typeof meta.step === "string" ? meta.step.slice(0, 40) : null,
      retries: Number.isFinite(meta.retries) ? meta.retries : null,
      durationMs: Number.isFinite(meta.durationMs) ? meta.durationMs : null,
      errorType: typeof meta.errorType === "string" ? meta.errorType.slice(0, 40) : null,
      sessionId: typeof meta.sessionId === "string" ? meta.sessionId.slice(0, 40) : null
    };

    const payload = {
      event,
      clientId,
      sessionId: safeMeta.sessionId,
      extVersion: chrome.runtime.getManifest().version,
      step: safeMeta.step,
      retries: safeMeta.retries,
      durationMs: safeMeta.durationMs,
      errorType: safeMeta.errorType,
      ts: new Date().toISOString()
    };

    // Enforce the allowlist: drop any stray keys.
    for (const key of Object.keys(payload)) {
      if (!CFG.ANALYTICS_ALLOWED_FIELDS.includes(key)) delete payload[key];
    }

    // Defense in depth: refuse to send if any key OR string value looks secret.
    if (!isPayloadSafe(payload)) {
      console.error("[CIMEA] analytics: blocked a payload that looked sensitive.");
      return;
    }

    await fetch(base + "/api/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify(payload),
      // We never send cookies to the endpoint; auth is via the Bearer token.
      credentials: "omit",
      keepalive: true
    }).catch((e) => console.warn("[CIMEA] analytics network error:", e.message));
  } catch (e) {
    console.warn("[CIMEA] analytics error:", e && e.message);
  }
}

function isPayloadSafe(payload) {
  for (const [key, value] of Object.entries(payload)) {
    for (const rx of CFG.SENSITIVE_KEY_PATTERNS) {
      if (rx.test(key)) return false;
      if (typeof value === "string" && rx.test(value)) return false;
    }
    // Reject anything that looks like a long digit run (e.g. a card number).
    if (typeof value === "string" && /\d{12,}/.test(value.replace(/\s|-/g, ""))) {
      return false;
    }
  }
  return true;
}

// -----------------------------------------------------------------------------
// Install: set sane defaults and (optionally) record an anonymous install event.
// -----------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await storageGet([
    "fastNav", "autoRetry", "soundAlert",
    "speed", "serverBase", "fastLoad", "procedure"
  ]);

  const defaults = {
    fastNav: existing.fastNav ?? true,
    autoRetry: existing.autoRetry ?? true,
    soundAlert: existing.soundAlert ?? true,
    speed: existing.speed ?? "1000",
    serverBase: existing.serverBase ?? CFG.DEFAULT_SERVER_BASE,
    fastLoad: existing.fastLoad ?? true,
    procedure: existing.procedure ?? "ordinary" // "ordinary" | "urgency"
  };
  await storageSet(defaults);
  await getClientId();
  await applyFastLoad(defaults.fastLoad !== false);
  // Note: install is recorded server-side on the user's first login, since
  // events require a valid session token.
});

// -----------------------------------------------------------------------------
// Desktop notification — a system popup so the user knows to act even when the
// tab is in the background (where Chrome throttles it).
// -----------------------------------------------------------------------------
let lastFocusGrab = 0; // throttle multi-tab focus-stealing
function notify(title, message) {
  try {
    chrome.notifications.create("", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title: title || "CIMEA Helper Pro",
      message: message || "",
      priority: 2
    }, () => void chrome.runtime.lastError);
  } catch (_) { /* notifications unavailable */ }
}

// -----------------------------------------------------------------------------
// Messages from the content script / popup.
// Content scripts NEVER send raw analytics; they ask the background to record a
// known event, and the background rebuilds a safe payload from the allowlist.
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request && request.type === "track") {
    sendAnalytics(request.event, request.meta || {}).then(() =>
      sendResponse({ ok: true })
    );
    return true; // async
  }

  // ---- authentication ----
  if (request && request.type === "authActivate") {
    authActivate(String(request.code || "")).then((r) => sendResponse(r));
    return true; // async
  }
  if (request && request.type === "authLogout") {
    authLogout().then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (request && request.type === "authStatus") {
    authStatus().then((r) => sendResponse(r));
    return true; // async
  }
  if (request && request.type === "isAuthorized") {
    isAuthorized().then((ok) => sendResponse({ ok }));
    return true; // async
  }
  if (request && request.type === "verifyNow") {
    isAuthorizedLive().then((ok) => sendResponse({ ok })); // live server re-verify
    return true; // async
  }

  if (request && request.type === "notify") {
    notify(request.title, request.body);
    sendResponse({ ok: true });
    return true;
  }

  // Bring the tab that reached payment to the front. With multi-tab, only the
  // FIRST tab to reach payment grabs focus (within a 30s window) so several tabs
  // arriving together don't thrash focus / yank the user around.
  if (request && request.type === "focusTab" && _sender && _sender.tab) {
    const now = Date.now();
    if (now - lastFocusGrab > 30000) {
      lastFocusGrab = now;
      try {
        chrome.tabs.update(_sender.tab.id, { active: true }, () => void chrome.runtime.lastError);
        if (_sender.tab.windowId != null) {
          chrome.windows.update(_sender.tab.windowId, { focused: true }, () => void chrome.runtime.lastError);
        }
      } catch (_) { /* ignore */ }
    }
    sendResponse({ ok: true });
    return true;
  }
});
