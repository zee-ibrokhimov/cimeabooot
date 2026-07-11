// =============================================================================
// CIMEA Helper Pro — background service worker
//
// This is the ONLY place in the extension that sends data to your server.
// - Login/session is handled here; the automation is gated on a valid session.
// - Analytics enforces a strict field allowlist so sensitive data (card number,
//   CVC, cardholder name, Telegram token) can never be transmitted.
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
async function clearAuth() {
  await sessionSet({ authToken: "", authEmail: "", authVerifiedAt: 0 });
}

async function getServerBase() {
  const { serverBase } = await storageGet(["serverBase"]);
  return (serverBase || CFG.DEFAULT_SERVER_BASE || "").trim().replace(/\/+$/, "");
}

async function authLogin(email, password) {
  const base = await getServerBase();
  if (!base) return { ok: false, error: "no_server" };
  try {
    const res = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      credentials: "omit"
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) {
      await sessionSet({
        authToken: data.token,
        authEmail: data.email || email,
        authVerifiedAt: Date.now()
      });
      return { ok: true, email: data.email || email };
    }
    return { ok: false, error: data.error || "invalid" };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "network" };
  }
}

async function verifyAuth() {
  const base = await getServerBase();
  const { authToken } = await sessionGet(["authToken"]);
  if (!base || !authToken) return false;
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
    // Any definitive auth denial (401 unauthenticated, 403 disabled/forbidden,
    // etc.) means the session is dead — clear it. Only network / 5xx errors are
    // treated as "unknown" so we don't wipe a good token on a transient blip.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      await clearAuth();
      return false;
    }
    return false;
  } catch (_) {
    return false;
  }
}

// Cached authorization: true if we have a token verified within the TTL,
// otherwise re-verify with the server.
async function isAuthorized() {
  const { authToken, authVerifiedAt } = await sessionGet(["authToken", "authVerifiedAt"]);
  if (!authToken) return false;
  const fresh = authVerifiedAt && (Date.now() - authVerifiedAt) < CFG.AUTH_VERIFY_TTL_MS;
  if (fresh) return true;
  const ok = await verifyAuth();
  if (ok) return true;
  // Grace window on transient failures only (verifyAuth clears the token on a
  // real denial, so if it's gone we return false here).
  const { authToken: stillHave } = await sessionGet(["authToken"]);
  const graceMs = CFG.AUTH_VERIFY_TTL_MS * (CFG.AUTH_GRACE_MULT || 2);
  if (stillHave && authVerifiedAt && (Date.now() - authVerifiedAt) < graceMs) {
    return true;
  }
  return false;
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
  await clearAuth();
  await storageSet({ automationActive: false });
}

async function authStatus() {
  const { authToken, authEmail } = await sessionGet(["authToken", "authEmail"]);
  const base = await getServerBase();
  return { loggedIn: !!authToken, email: authEmail || "", serverBase: base };
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

    const consent = (await storageGet(["analyticsConsent"])).analyticsConsent !== false; // default on
    const base = await getServerBase();

    // Send nothing unless: analytics on, server configured, and a still-valid
    // session (revoked sessions stop emitting, not just fail server-side).
    if (!consent || !base) return;
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
    "autoFill", "fastNav", "autoRetry", "soundAlert",
    "speed", "analyticsConsent", "serverBase"
  ]);

  const defaults = {
    autoFill: existing.autoFill ?? true,
    fastNav: existing.fastNav ?? true,
    autoRetry: existing.autoRetry ?? true,
    soundAlert: existing.soundAlert ?? true,
    speed: existing.speed ?? "1000",
    analyticsConsent: existing.analyticsConsent ?? CFG.DEFAULT_ANALYTICS_CONSENT,
    serverBase: existing.serverBase ?? CFG.DEFAULT_SERVER_BASE
  };
  await storageSet(defaults);
  await getClientId();
  // Note: install is recorded server-side on the user's first login, since
  // events require a valid session token.
});

// -----------------------------------------------------------------------------
// Telegram notifications — the user's OWN bot/chat. This talks only to
// api.telegram.org and is completely separate from the analytics path. The
// token/chat id live in local storage and are read only here, never by
// sendAnalytics().
// -----------------------------------------------------------------------------
async function sendTelegram(text, override) {
  const stored = await storageGet(["tgToken", "tgChatId"]);
  const token = (override && override.token) || stored.tgToken;
  const chatId = (override && override.chatId) || stored.tgChatId;
  if (!token || !chatId) return { ok: false, error: "not_configured" };
  try {
    const res = await fetch(
      "https://api.telegram.org/bot" + encodeURIComponent(token) + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        credentials: "omit"
      }
    );
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
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
  if (request && request.type === "authLogin") {
    authLogin(String(request.email || ""), String(request.password || ""))
      .then((r) => sendResponse(r));
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

  if (request && request.type === "notifyTelegram") {
    sendTelegram(String(request.text || "")).then((r) => sendResponse(r));
    return true; // async
  }

  if (request && request.type === "testTelegram") {
    sendTelegram(
      "✅ CIMEA Helper Pro connected successfully!",
      { token: request.token, chatId: request.chatId }
    ).then((r) => sendResponse(r));
    return true; // async
  }
});
