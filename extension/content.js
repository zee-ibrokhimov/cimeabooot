// =============================================================================
// CIMEA Helper Pro — content script (runs on cimea-diplome.it and nexi.it)
//
// Automation only. This script NEVER sends analytics itself: it asks the
// background worker to record known events. Card details are read from local
// storage and typed into the payment form on this device only.
// =============================================================================
(() => {
  "use strict";

  // Run only in the top frame. Never inside sub-frames/iframes — this avoids
  // duplicate drawers, redundant automation, and (critically) prevents the
  // card auto-fill from ever operating on an untrusted embedded frame.
  if (window.top !== window) return;

  const CFG = (typeof CIMEA_CONFIG !== "undefined") ? CIMEA_CONFIG : {};
  let lang = (typeof cimeaDefaultLang === "function") ? cimeaDefaultLang() : "en";
  const t = (key) => (typeof cimeaT === "function") ? cimeaT(key, lang) : key;
  let actionDelay = 1000;
  let procedure = "ordinary"; // "ordinary" | "urgency" — chosen on the PROCESSING TIME step
  let isNavigating = false;
  let isPaused = true;          // wait for the user to start
  let lastActionAt = Date.now(); // last time the bot acted — drives the stuck-load watchdog
  // Route every "action started" through here so the watchdog sees progress.
  function setNavigating(v) { isNavigating = v; if (v) lastActionAt = Date.now(); }
  let sessionId = null;
  let runStartedAt = 0;
  let audioCtx = null;          // single reused AudioContext
  let nexiBeeper = null;        // beeper interval id (so we can clear it)
  let observerActive = false;
  let authOk = false;           // last known authorization while running
  let lastAuthCheck = 0;        // when we last re-checked with the background
  let authChecking = false;
  let captchaAlerted = false;   // so we alert about a CAPTCHA only once
  let blockAlerted = false;     // so we alert about a rate-limit only once
  let loginAlerted = false;     // so we alert about session-expiry only once
  let failAlerted = false;      // so we alert about a failed payment only once
  let procWarned = false;       // so we warn about a missing procedure card only once

  // Layer 3: detection phrases + DOM selectors come from the server "playbook"
  // (fetched via the background with a valid session), NOT from local config.
  // Without a playbook the automation refuses to run (no recipe to execute).
  let PLAYBOOK = null;
  let DETECT = {};
  let SEL = {};
  const RE = {}; // compiled regexes from the playbook
  const hasAny = (text, list) => Array.isArray(list) && list.some((p) => p && text.includes(p));

  function applyPlaybook(pb) {
    PLAYBOOK = pb;
    DETECT = (pb && pb.detect) || {};
    SEL = (pb && pb.selectors) || {};
    RE.urgency = SEL.urgency_re ? new RegExp(SEL.urgency_re) : null;
    RE.ordinary = SEL.ordinary_re ? new RegExp(SEL.ordinary_re) : null;
    RE.keepalive = SEL.keepalive_re ? new RegExp(SEL.keepalive_re, "i") : null;
    RE.captchaIframe = SEL.captcha_iframe_re ? new RegExp(SEL.captcha_iframe_re, "i") : null;
  }

  // Ask the background for the (session-gated) playbook and apply it. Resolves
  // true only if we now hold a usable recipe.
  function loadPlaybook() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "getPlaybook" }, (r) => {
          void chrome.runtime.lastError;
          if (r && r.ok && r.playbook && r.playbook.selectors) {
            applyPlaybook(r.playbook);
            resolve(true);
          } else {
            resolve(false);
          }
        });
      } catch (_) { resolve(false); }
    });
  }

  // Ready = a valid session AND a loaded playbook. Both are required to run.
  async function ensureReady(live) {
    const ok = await checkAuthorized(live);
    if (!ok) return { ok: false, reason: "auth" };
    const pb = await loadPlaybook();
    if (!pb) return { ok: false, reason: "playbook" };
    return { ok: true };
  }

  // Read the page text WITHOUT the extension's own drawer — otherwise the bot's
  // own log lines (e.g. "No availability") would match DETECT on the next tick
  // and trap it in a self-poisoning loop. Hide/read/restore is synchronous, so
  // there is no visible flicker.
  function getPageText() {
    const drawer = document.getElementById("cimea-helper-drawer");
    let prev;
    if (drawer) { prev = drawer.style.display; drawer.style.display = "none"; }
    const text = (document.body.innerText || "").toLowerCase();
    if (drawer) drawer.style.display = prev;
    return text;
  }

  // Small +/- jitter on delays so the click cadence isn't perfectly robotic —
  // this helps avoid rate-limit / anti-bot detection while staying fast.
  const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));
  const settle = () => jitter(actionDelay);
  // On a server 5xx / daily-limit bounce, retry fast (but capped for sanity).
  const retryDelay = () => jitter(Math.min(actionDelay, 800));
  // "System busy / try again" notice: retry immediately. The reload itself is
  // paced by page-load time, so this ~200ms floor is effectively instant; it
  // just prevents a zero-delay tight loop. NOTE: retrying this hard against a
  // congested server raises the odds of a temporary block — raise this value if
  // you start getting rate-limited.
  const busyRetryDelay = () => jitter(200);

  // ---------------------------------------------------------------------------
  // Safe messaging: swallow "Extension context invalidated" after a reload.
  // ---------------------------------------------------------------------------
  function safeSendMessage(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (_) { /* context gone; ignore */ }
  }
  function track(event, meta = {}) {
    safeSendMessage({ type: "track", event, meta: { ...meta, sessionId } });
  }
  // Ask the background to show a desktop notification (works even when this tab
  // is in the background and throttled).
  function notify(title, body) {
    safeSendMessage({ type: "notify", title, body });
  }
  function newSessionId() {
    return (self.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : "s_" + Math.random().toString(36).slice(2);
  }

  // Ask the background whether the user has a valid session. Automation is
  // blocked unless this resolves true.
  function checkAuthorized(live) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: live ? "verifyNow" : "isAuthorized" }, (r) => {
          void chrome.runtime.lastError;
          resolve(!!(r && r.ok));
        });
      } catch (_) { resolve(false); }
    });
  }

  // Called when a run starts/resumes: mark authorized and reset the timer.
  function markAuthorized() {
    authOk = true;
    lastAuthCheck = Date.now();
    captchaAlerted = false; // a fresh run can re-alert if a CAPTCHA reappears
    blockAlerted = false;
    loginAlerted = false;
    failAlerted = false;
    procWarned = false;
    // Re-arm the cross-tab "payment succeeded elsewhere" broadcast for this run.
    try { chrome.storage.local.set({ successAlertSent: false, paymentSucceeded: false }); } catch (_) { /* ignore */ }
  }

  // Pause automation to wait for the user (e.g. a CAPTCHA to solve) and reflect
  // it in the drawer, without tearing down the observer — the user resumes with
  // the drawer's Resume button once they've handled it.
  //
  // NOTE: this is a THIS-TAB pause only. It must NOT clear the shared
  // automationActive flag, or it would disarm auto-resume for every other tab in
  // a multi-tab run. The in-memory isPaused keeps this tab from acting.
  function pauseForAlert(logKey) {
    isPaused = true;
    stopBeeper();
    const btn = document.getElementById("cimea-pause-btn");
    const dot = document.getElementById("cimea-status-indicator");
    if (btn) btn.innerText = t("d_resume");
    if (dot) { dot.style.background = "#ef4444"; dot.style.boxShadow = "0 0 8px #ef4444"; }
    logToDrawer(t(logKey));
  }

  // Fully stop automation because the session is no longer valid.
  function hardStopAuth() {
    authOk = false;
    isPaused = true;
    try { chrome.storage.local.set({ automationActive: false }); } catch (_) { /* ignore */ }
    stopObserver();
    stopBeeper();
    logToDrawer(t("d_session_ended"));
  }

  // Throttled mid-run re-authorization so a revoked/disabled user is stopped
  // during a run, not only at start. Non-blocking: it updates authOk, and
  // checkPageState refuses to act while authOk is false.
  function maybeRecheckAuth() {
    if (isPaused || authChecking) return;
    if (Date.now() - lastAuthCheck < CFG.AUTH_RECHECK_MS) return;
    authChecking = true;
    checkAuthorized(true).then((ok) => { // live server verify, not the cached answer
      authChecking = false;
      lastAuthCheck = Date.now();
      if (!ok) hardStopAuth();
    });
  }

  // ---------------------------------------------------------------------------
  // Settings sync
  // ---------------------------------------------------------------------------
  chrome.storage.local.get(["speed", "automationActive", "lang", "procedure"], (res) => {
    if (res.lang) lang = res.lang;
    if (res.procedure) procedure = res.procedure;
    if (res.speed) actionDelay = parseInt(res.speed, 10) || 1000;
    if (res.automationActive) {
      // Only auto-resume if the session is valid AND we have the server recipe.
      ensureReady().then((r) => {
        if (!r.ok) {
          isPaused = true;
          chrome.storage.local.set({ automationActive: false });
          injectDrawer();
          logToDrawer(t(r.reason === "playbook" ? "d_no_playbook" : "d_login_required"));
          return;
        }
        isPaused = false;
        markAuthorized();
        sessionId = newSessionId();
        runStartedAt = Date.now();
        injectDrawer();
        startObserver();
        setTimeout(() => logToDrawer(t("d_resumed_reload")), 500);
      });
    } else {
      isPaused = true;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.lang) {
      lang = changes.lang.newValue || "en";
      // Re-label the drawer's pause/resume button live.
      const b = document.getElementById("cimea-pause-btn");
      if (b) b.innerText = isPaused ? t("d_resume") : t("d_pause");
    }
    if (changes.procedure) procedure = changes.procedure.newValue || "ordinary";
    if (changes.speed) actionDelay = parseInt(changes.speed.newValue, 10) || 1000;
    if (changes.paymentSucceeded && changes.paymentSucceeded.newValue === true) {
      if (!isPaused && isCimea()) {
        const pauseBtn = document.getElementById("cimea-pause-btn");
        if (pauseBtn) pauseBtn.click();
        logToDrawer(t("d_autopaused_other_tab"));
      }
    }
  });

  const isCimea = () => location.hostname.includes("cimea-diplome.it");
  const isNexi = () => location.hostname.includes("nexi.it");

  // ---------------------------------------------------------------------------
  // Session keep-alive (anti-idle). Only clicks genuine "extend session"
  // modals; the synthetic events just keep the front-end idle timer honest.
  // ---------------------------------------------------------------------------
  setInterval(() => {
    if (isPaused || !authOk || !isCimea()) return;
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    const keep = Array.from(document.querySelectorAll("button")).find((btn) => {
      const t = (btn.innerText || "").toLowerCase();
      return RE.keepalive ? RE.keepalive.test(t) : false;
    });
    if (keep && keep.offsetParent !== null && !keep.disabled) {
      keep.click();
      logToDrawer(t("d_extended_session"));
    }
  }, 30000);

  // ---------------------------------------------------------------------------
  // Session auto-refresh — click the DiploMe dashboard's "refresh token" button
  // (icon-only, next to "Session expires in mm:ss") on a randomized 30–50 min
  // cadence so the CIMEA login doesn't expire while waiting for the drop. Also
  // triggerable on demand from the popup. Gated on a loaded playbook (= a valid
  // tool login) and only fires on the CIMEA dashboard.
  // ---------------------------------------------------------------------------
  let refreshTimer = null;
  function nextRefreshDelay() {
    const min = CFG.SESSION_REFRESH_MIN_MS || 30 * 60 * 1000;
    const max = CFG.SESSION_REFRESH_MAX_MS || 50 * 60 * 1000;
    return Math.floor(min + Math.random() * Math.max(0, max - min));
  }
  // Rect-based visibility (unlike offsetParent, this works for position:fixed
  // widgets like the bottom-left "Session expires in" box).
  function refreshBtnVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  // Find the "refresh session" button with several fallbacks so it keeps working
  // even if the exact markup shifts. Primary is the (server-tunable) playbook
  // selector; the rest are resilient heuristics.
  function findRefreshBtn() {
    // 1) Playbook selector.
    if (SEL.session_refresh_btn) {
      try { const b = document.querySelector(SEL.session_refresh_btn); if (b) return b; } catch (_) { /* bad selector */ }
    }
    // 2) A button inside the session-widget container.
    const cont = document.querySelector(".token-refresh, [class*='token-refresh']");
    if (cont) { const b = cont.querySelector("button"); if (b) return b; }
    // 3) A button wrapping a "refresh" icon (handles <use href> and <use xlink:href>).
    for (const u of document.querySelectorAll("use")) {
      const href = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
      if (/refresh/i.test(href)) { const b = u.closest("button"); if (b) return b; }
    }
    // 4) The button nearest the "session expires" countdown text.
    const label = Array.from(document.querySelectorAll("span,div,p"))
      .find((s) => /session expires|expires in|scade|scadr|истека|срок\s*сесс/i.test(s.textContent || ""));
    if (label) {
      let node = label;
      for (let i = 0; i < 6 && node; i++) {
        const b = node.querySelector && node.querySelector("button");
        if (b) return b;
        node = node.parentElement;
      }
    }
    return null;
  }
  // Robust click for framework buttons (Quasar q-btn) that may ignore a bare
  // .click(): fire the full pointer+mouse sequence, then the real click. Only
  // one actual 'click' event is dispatched (via el.click()), so it fires once.
  function robustClick(el) {
    const o = { bubbles: true, cancelable: true, view: window };
    try { el.focus && el.focus(); } catch (_) { /* ignore */ }
    try { el.dispatchEvent(new PointerEvent("pointerdown", o)); } catch (_) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent("mousedown", o)); } catch (_) { /* ignore */ }
    try { el.dispatchEvent(new PointerEvent("pointerup", o)); } catch (_) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent("mouseup", o)); } catch (_) { /* ignore */ }
    try { el.click(); } catch (_) { /* ignore */ }
  }
  function clickSessionRefresh() {
    if (!isCimea() || !PLAYBOOK) return false;
    const btn = findRefreshBtn();
    if (btn && refreshBtnVisible(btn) && !btn.disabled) {
      robustClick(btn);
      if (document.getElementById("cimea-helper-drawer")) logToDrawer(t("d_session_refreshed"));
      return true;
    }
    return false;
  }
  function scheduleAutoRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      clickSessionRefresh();
      scheduleAutoRefresh(); // reschedule with a fresh random delay each time
    }, nextRefreshDelay());
  }

  // ---------------------------------------------------------------------------
  // Drawer UI
  // ---------------------------------------------------------------------------
  function injectDrawer() {
    if (document.getElementById("cimea-helper-drawer")) return;
    const drawer = document.createElement("div");
    drawer.id = "cimea-helper-drawer";
    drawer.style.cssText =
      "position:fixed;bottom:30px;right:30px;width:320px;background:rgba(15,23,42,0.9);" +
      "backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);border-radius:16px;" +
      "color:#f8fafc;z-index:2147483647;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,0.45);" +
      'font-family:"Segoe UI",system-ui,sans-serif;box-sizing:border-box;';
    drawer.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' +
      'border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:10px;">' +
      '<h2 style="font-size:15px;margin:0;display:flex;align-items:center;gap:8px;font-weight:600;">' +
      '<span id="cimea-status-indicator" style="width:10px;height:10px;background:#10b981;' +
      'border-radius:50%;box-shadow:0 0 8px #10b981;"></span>CIMEA Helper Pro</h2>' +
      '<button id="cimea-toggle-btn" style="background:transparent;border:none;color:#94a3b8;' +
      'cursor:pointer;font-size:18px;line-height:1;">−</button></div>' +
      '<div id="cimea-drawer-content">' +
      '<button id="cimea-pause-btn" style="width:100%;padding:8px;margin-bottom:12px;' +
      "background:rgba(239,68,68,0.2);color:#fca5a5;border:1px solid rgba(239,68,68,0.3);" +
      'border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;">' + escapeHtml(isPaused ? t("d_resume") : t("d_pause")) + '</button>' +
      '<div id="cimea-log-container" style="display:flex;flex-direction:column;gap:8px;' +
      'font-size:12px;max-height:250px;overflow-y:auto;padding-right:5px;"></div></div>';
    document.body.appendChild(drawer);

    document.getElementById("cimea-toggle-btn").addEventListener("click", (e) => {
      const content = document.getElementById("cimea-drawer-content");
      const min = content.style.display === "none";
      content.style.display = min ? "block" : "none";
      e.target.innerText = min ? "−" : "+";
    });

    document.getElementById("cimea-pause-btn").addEventListener("click", (e) => {
      // This click is a user gesture — unlock audio so the beep can play.
      unlockAudio();
      const btn = e.target;
      const dot = document.getElementById("cimea-status-indicator");
      const goPaused = () => {
        isPaused = true;
        chrome.storage.local.set({ automationActive: false });
        btn.innerText = t("d_resume");
        btn.style.background = "rgba(16,185,129,0.2)";
        btn.style.color = "#6ee7b7";
        dot.style.background = "#ef4444";
        dot.style.boxShadow = "0 0 8px #ef4444";
        stopBeeper();
      };

      if (!isPaused) {
        // Pausing.
        goPaused();
        track("automation_stopped", { durationMs: runStartedAt ? Date.now() - runStartedAt : null });
        logToDrawer(t("d_paused"));
        return;
      }

      // Resuming — requires a valid session AND the server recipe.
      ensureReady().then((r) => {
        if (!r.ok) {
          logToDrawer(t(r.reason === "playbook" ? "d_no_playbook" : "d_not_logged_in"));
          return;
        }
        isPaused = false;
        markAuthorized();
        chrome.storage.local.set({ automationActive: true });
        btn.innerText = t("d_pause");
        btn.style.background = "rgba(239,68,68,0.2)";
        btn.style.color = "#fca5a5";
        dot.style.background = "#10b981";
        dot.style.boxShadow = "0 0 8px #10b981";
        sessionId = newSessionId();
        runStartedAt = Date.now();
        startObserver(); // re-attach if a previous success disconnected it
        track("automation_started", { step: "resume" });
        logToDrawer(t("d_resumed"));
      });
    });
  }

  function logToDrawer(message) {
    injectDrawer();
    const c = document.getElementById("cimea-log-container");
    if (!c) return;
    const entry = document.createElement("div");
    entry.style.cssText =
      "background:rgba(255,255,255,0.05);padding:10px;border-radius:6px;" +
      "border-left:3px solid " + (isPaused ? "#ef4444" : "#10b981") + ";line-height:1.4;";
    const time = new Date().toLocaleTimeString();
    entry.innerHTML =
      '<span style="color:#94a3b8;font-size:11px;display:block;margin-bottom:4px;">' +
      time + "</span>" + escapeHtml(message);
    c.appendChild(entry);
    while (c.children.length > 20) c.removeChild(c.firstChild);
    c.scrollTop = c.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
  }

  // ---------------------------------------------------------------------------
  // Manual trigger from the popup
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request && request.action === "startAutomation") {
      // Server-gated: never run without a valid session AND the server recipe.
      ensureReady().then((r) => {
        if (!r.ok) {
          isPaused = true;
          chrome.storage.local.set({ automationActive: false });
          injectDrawer();
          logToDrawer(t(r.reason === "playbook" ? "d_no_playbook" : "d_not_logged_in"));
          sendResponse({ status: "unauthorized" });
          return;
        }
        isPaused = false;
        markAuthorized();
        sessionId = newSessionId();
        runStartedAt = Date.now();
        chrome.storage.local.set({ automationActive: true });
        injectDrawer();
        startObserver();
        logToDrawer(t("d_started"));
        track("automation_started", { step: "manual" });
        sendResponse({ status: "success" });
      });
      return true; // async sendResponse
    }

    // Manual "Refresh CIMEA session" from the popup.
    if (request && request.action === "refreshSession") {
      const done = () => {
        const ok = clickSessionRefresh();
        if (ok) scheduleAutoRefresh(); // reset the auto timer after a manual refresh
        sendResponse({ ok });
      };
      if (PLAYBOOK) done();
      else loadPlaybook().then((loaded) => {
        if (loaded) done();
        else sendResponse({ ok: false, reason: "playbook" });
      });
      return true; // async
    }
  });

  // Count a retry attempt (for the popup's stats) and record it.
  function bumpRetries(step) {
    chrome.storage.local.get(["totalRetries"], (r) => {
      const total = (r.totalRetries || 0) + 1;
      chrome.storage.local.set({ totalRetries: total });
      track("save_next_clicked", { step, retries: total });
    });
  }

  // On the PROCESSING TIME step, tick the radio matching the user's choice
  // (Ordinary / Urgency). Returns true if it clicked one this tick, false if the
  // right option is already selected (so the caller proceeds to Save and next).
  function selectProcedure() {
    const wantUrgency = procedure === "urgency";
    // Match the card by its LABEL text (the Urgency card's description also
    // mentions "Ordinary procedure", so match the label span, not the whole card).
    let target = null;
    const cards = Array.from(document.querySelectorAll(SEL.procedure_card));
    for (const c of cards) {
      const lblEl = c.querySelector(SEL.procedure_label);
      const lbl = (lblEl ? lblEl.innerText : "").toLowerCase().trim();
      if (!lbl) continue;
      const isUrg = RE.urgency ? RE.urgency.test(lbl) : false;
      const isOrd = RE.ordinary ? RE.ordinary.test(lbl) : false;
      // Symmetric guard — require the exclusive match on both branches.
      if (wantUrgency ? (isUrg && !isOrd) : (isOrd && !isUrg)) { target = c; break; }
    }
    // Fallback: match the radio input by value (false = ordinary, true = urgency).
    if (!target) {
      const input = document.querySelector(
        SEL.procedure_input + '[value="' + (wantUrgency ? "true" : "false") + '"]'
      );
      if (input) target = input.closest("label") || input;
    }
    if (!target) {
      if (!procWarned) { procWarned = true; logToDrawer(t("d_proc_not_found")); }
      return false;
    }
    // Resolve the card element + the radio input robustly, whether `target` is a
    // card <label> or a bare <input> — so "already selected" is detected either
    // way (avoids re-clicking a checked radio forever).
    const card = (target.closest && target.closest(SEL.procedure_card)) || target;
    const radio = (target.matches && target.matches('input[type="radio"]'))
      ? target
      : (target.querySelector && target.querySelector('input[type="radio"]'));
    const isSelected =
      (card.classList && card.classList.contains(SEL.procedure_card_checked_class)) ||
      (radio && radio.checked);
    if (isSelected) return false; // already the right choice -> proceed to Save
    logToDrawer(t(wantUrgency ? "d_proc_urgency" : "d_proc_ordinary"));
    setNavigating(true);
    (card.click ? card : target).click();
    setTimeout(() => { isNavigating = false; }, settle());
    return true;
  }

  // Navigate back to the homepage to keep hunting (daily-limit / no-availability).
  function goHomeToRetry() {
    setNavigating(true);
    const home = Array.from(document.querySelectorAll("a,div,span,li")).find((el) => {
      const txt = (el.innerText || "").trim().toLowerCase();
      return (SEL.home_text || []).includes(txt);
    });
    if (home) home.click();
    else if (isCimea()) location.hash = "#/";
    else location.reload();
    setTimeout(() => { isNavigating = false; }, settle());
  }

  // ---------------------------------------------------------------------------
  // Main state machine (throttled)
  // ---------------------------------------------------------------------------
  function checkPageState() {
    if (isNavigating || isPaused) return;
    // Re-check authorization periodically; refuse to act while unauthorized so a
    // revoked/disabled user is stopped mid-run (not just at start).
    maybeRecheckAuth();
    if (!authOk || !PLAYBOOK) return; // need auth AND the server recipe
    const pageText = getPageText();
    const hash = location.hash.toLowerCase();

    // CAPTCHA — STOP (reloading wipes it) and alert. Match ONLY the active
    // challenge popup (reCAPTCHA 'bframe' / hCaptcha challenge), which is hidden
    // until a challenge fires — NOT the always-present 'anchor' checkbox widget,
    // which would false-pause on any page that merely loads reCAPTCHA.
    const captchaEl = Array.from(document.querySelectorAll("iframe")).find((f) => {
      if (!(RE.captchaIframe && RE.captchaIframe.test(f.src || ""))) return false;
      const r = f.getBoundingClientRect();
      return f.offsetParent !== null && r.width > 10 && r.height > 10;
    });
    if (captchaEl || hasAny(pageText, DETECT.captcha_text)) {
      if (!captchaAlerted) {
        captchaAlerted = true;
        playSound();
        notify(t("notif_captcha_title"), t("notif_captcha_body"));
        track("error", { errorType: "captcha" });
      }
      pauseForAlert("d_captcha");
      return;
    }

    // Session expired / login page — pause and alert so you can log back in
    // (the extension never stores your CIMEA password). Detect only via the
    // login route or specific "session expired / please log in" wording — NOT a
    // stray password field or a "Login" nav button, which would false-pause.
    const onLoginPage = hash.includes("#/login") || hash.includes("#/signin");
    if (onLoginPage || hasAny(pageText, DETECT.login_required)) {
      if (!loginAlerted) {
        loginAlerted = true;
        playSound();
        notify(t("notif_login_title"), t("notif_login_body"));
        track("error", { errorType: "session_expired" });
      }
      pauseForAlert("d_login");
      return;
    }

    // Rate-limited / blocked — back off (~45s) instead of hammering.
    if (hasAny(pageText, DETECT.blocked)) {
      if (!blockAlerted) {
        blockAlerted = true;
        playSound();
        notify(t("notif_blocked_title"), t("notif_blocked_body"));
        track("error", { errorType: "rate_limited" });
      }
      logToDrawer(t("d_blocked"));
      setNavigating(true);
      setTimeout(() => { isNavigating = false; blockAlerted = false; location.reload(); }, jitter(45000));
      return;
    }

    // Maintenance page — wait ~30s and retry.
    if (hasAny(pageText, DETECT.maintenance)) {
      logToDrawer(t("d_maintenance"));
      track("error", { errorType: "maintenance" });
      setNavigating(true);
      setTimeout(() => { isNavigating = false; location.reload(); }, jitter(30000));
      return;
    }

    // Server 5xx — reload.
    if (hasAny(pageText, DETECT.server_error)) {
      logToDrawer(t("d_server_error"));
      track("server_crash_detected", { errorType: "server_5xx" });
      setNavigating(true);
      setTimeout(() => { isNavigating = false; location.reload(); }, retryDelay());
      return;
    }

    // "System busy — try again" congestion notice — retry immediately.
    if (hasAny(pageText, DETECT.busy)) {
      logToDrawer(t("d_system_busy"));
      bumpRetries("busy_retry");
      setNavigating(true);
      setTimeout(() => { isNavigating = false; location.reload(); }, busyRetryDelay());
      return;
    }

    // No availability — go back and keep hunting.
    if (hasAny(pageText, DETECT.no_availability)) {
      logToDrawer(t("d_no_slots"));
      bumpRetries("no_availability");
      goHomeToRetry();
      return;
    }

    // Payment failed / declined — ONLY on the payment gateway (not the CIMEA
    // request list, where a prior request's "failed" status would false-pause).
    if (isNexi() && hasAny(pageText, DETECT.payment_failed)) {
      if (!failAlerted) {
        failAlerted = true;
        playSound();
        notify(t("notif_fail_title"), t("notif_fail_body"));
        track("error", { errorType: "payment_failed" });
      }
      pauseForAlert("d_payment_failed");
      return;
    }

    // Daily-request limit reached — go home and keep re-attempting (a freed slot
    // may open). Checked at TOP LEVEL so it retries regardless of which page the
    // message shows on.
    if (hasAny(pageText, DETECT.daily_limit)) {
      logToDrawer(t("d_daily_limit"));
      track("daily_limit_hit", { step: "limit" });
      goHomeToRetry();
      return;
    }

    // ---- CIMEA request wizard (multi-step; each step has "Save and next") ----
    if (isCimea()) {
      // PROCESSING TIME step: pick Ordinary or Urgency per the user's setting so
      // the Save-and-next button becomes enabled.
      if (hasAny(pageText, DETECT.processing_time)) {
        const picked = selectProcedure();
        if (picked) return; // clicked a radio this tick
      }
      // Advance the wizard: click "Save and next" whenever it's present + enabled.
      const saveBtn = Array.from(document.querySelectorAll("button")).find((el) => {
        const txt = (el.innerText || "").toLowerCase();
        return (SEL.save_next_text || []).some((s) => txt.includes(s));
      });
      if (saveBtn && !saveBtn.disabled && saveBtn.offsetParent !== null) {
        logToDrawer(t("d_clicking_savenext"));
        setNavigating(true);
        saveBtn.click();
        bumpRetries("payment_page");
        setTimeout(() => { isNavigating = false; }, settle());
        return;
      }
    }

    // Homepage: open the most recent Draft and complete it. This claims the tick
    // (return) so the success/nexi handlers below never run on the request list —
    // where a prior request's status text could otherwise be misread.
    if (hash === "#/" || hash.includes("#/home") ||
        (SEL.my_requests_text && pageText.includes(SEL.my_requests_text) && !hash.includes("#/service") && !hash.includes("#/request"))) {
      handleDraftFlow();
      return;
    }

    // Auto-fill card details (LOCAL ONLY) — ONLY on the Nexi payment gateway.
    // Never on the cimea-diplome.it app, so card data can never be typed into a
    // form on that origin.
    if (isNexi()) maybeFillCard();

    // Nexi payment gateway: alert the user
    if (isNexi() && !nexiBeeper) {
      track("payment_page_reached", { step: "nexi" });
      notify(t("notif_pay_title"), t("notif_pay_body"));
      safeSendMessage({ type: "focusTab" }); // bring this tab to the front
      logToDrawer(t("d_nexi_page"));
      nexiBeeper = setInterval(() => {
        if (isPaused) return; // respect pause; stopBeeper() also clears it
        chrome.storage.local.get(["soundAlert"], (r) => {
          if (r.soundAlert !== false) playSound();
        });
      }, 1500);
      return;
    }

    // Success detection
    if (hasAny(pageText, DETECT.success)) {
      chrome.storage.local.get(["soundAlert", "successAlertSent"], (r) => {
        if (r.soundAlert !== false) playSound();
        if (!r.successAlertSent) { // fire alerts/analytics exactly once per run
          chrome.storage.local.set({
            successAlertSent: true, paymentSucceeded: true, automationActive: false
          });
          track("payment_success", {
            step: "success",
            durationMs: runStartedAt ? Date.now() - runStartedAt : null
          });
          notify(t("notif_success_title"), t("notif_success_body"));
          logToDrawer(t("d_success"));
        }
      });
      // Reflect the stopped state in the drawer so the button reads Resume (not a
      // mislabeled Pause that would misroute the next click).
      const sbtn = document.getElementById("cimea-pause-btn");
      const sdot = document.getElementById("cimea-status-indicator");
      if (sbtn) sbtn.innerText = t("d_resume");
      if (sdot) { sdot.style.background = "#ef4444"; sdot.style.boxShadow = "0 0 8px #ef4444"; }
      isPaused = true;
      stopBeeper();
      stopObserver();
      return;
    }
  }

  function handleDraftFlow() {
    const drafts = Array.from(document.querySelectorAll("span,p,div,button,a")).filter((el) => {
      const t = (el.innerText || "").trim().toLowerCase();
      return (SEL.draft_text || []).includes(t) && el.offsetParent !== null;
    });
    if (drafts.length === 0) return;
    drafts.sort((a, b) => depth(b) - depth(a));
    const badge = drafts[0];

    const completes = Array.from(document.querySelectorAll("button,a,div,span,li,p")).filter((el) => {
      const t = (el.innerText || "").toLowerCase().trim();
      return (SEL.complete_text || []).includes(t) &&
        el.offsetParent !== null && t.length < 30;
    }).sort((a, b) => depth(b) - depth(a));

    if (completes.length > 0) {
      logToDrawer(t("d_clicking_complete"));
      setNavigating(true);
      completes[0].click();
      setTimeout(() => { isNavigating = false; }, settle());
      return;
    }

    // Otherwise open the "…" action menu on the draft card
    let curr = badge, actionBtn = null;
    for (let i = 0; i < 8 && curr; i++) {
      const btns = Array.from(curr.querySelectorAll('button,[role="button"],a'))
        .filter((b) => !badge.contains(b) && !b.contains(badge) && b.offsetParent !== null);
      const dots = btns.find((b) => (b.innerText || "").includes("..."));
      if (dots) { actionBtn = dots; if (i >= 2) break; }
      else if (!actionBtn && btns.length) actionBtn = btns[btns.length - 1];
      curr = curr.parentElement;
    }
    if (actionBtn) {
      logToDrawer(t("d_opening_draft"));
      setNavigating(true);
      actionBtn.click();
      setTimeout(() => { isNavigating = false; }, jitter(900));
    }
  }
  function depth(el) { let d = 0; while (el) { d++; el = el.parentElement; } return d; }

  // ---------------------------------------------------------------------------
  // Card auto-fill — reads locally-stored card data and types it into the
  // gateway form. Nothing about the card is ever sent to the analytics backend.
  // Selectors are constrained to real card fields (no generic input[type=tel]).
  // ---------------------------------------------------------------------------
  function maybeFillCard() {
    if (!SEL.card_number) return;
    const ccInput = document.querySelector(SEL.card_number);
    if (!ccInput || ccInput.hasAttribute("data-cimea-filled")) return;
    chrome.storage.local.get(["cardName", "cardNum", "cardExp", "cardCvc"], (r) => {
      if (!r.cardNum) return;
      logToDrawer(t("d_filling_card"));
      const fill = (selector, val) => {
        const el = document.querySelector(selector);
        if (el && val) {
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      };
      fill(SEL.card_number, r.cardNum);
      fill(SEL.card_name, r.cardName);
      fill(SEL.card_cvc, r.cardCvc);
      fill(SEL.card_exp, r.cardExp);
      ccInput.setAttribute("data-cimea-filled", "true");
    });
  }

  // A single reused AudioContext (Chrome caps live contexts at ~6). unlockAudio
  // is called from a user gesture (the pause/resume click) so autoplay policy
  // lets the beep actually sound.
  function getAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    return audioCtx;
  }
  function unlockAudio() {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }
  function playSound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") { ctx.resume().catch(() => {}); return; }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 1);
      osc.stop(ctx.currentTime + 1);
    } catch (_) { /* ignore */ }
  }
  function stopBeeper() {
    if (nexiBeeper) { clearInterval(nexiBeeper); nexiBeeper = null; }
  }

  // ---------------------------------------------------------------------------
  // Throttled observer: coalesce bursts of mutations into at most one check
  // every 800ms, plus a slow failsafe interval.
  // ---------------------------------------------------------------------------
  let scheduled = false;
  function scheduleCheck() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; checkPageState(); }, CFG.DETECT_THROTTLE_MS || 90);
  }
  const observer = new MutationObserver(scheduleCheck);
  function startObserver() {
    if (observerActive) return;
    observer.observe(document.documentElement, { childList: true, subtree: true });
    observerActive = true;
  }
  function stopObserver() {
    if (!observerActive) return;
    observer.disconnect();
    observerActive = false;
  }
  startObserver();
  // Randomize the first check a little so multiple tabs launched together stagger
  // their first action by a few hundred ms instead of firing in lockstep.
  setTimeout(checkPageState, 400 + Math.floor(Math.random() * 700));
  setInterval(checkPageState, CFG.FAILSAFE_CHECK_MS || 350); // failsafe (survives observer disconnect)

  // Is the page still actively loading? (base document not done, OR a loading
  // spinner is visible.) The watchdog must WAIT in that case — reloading a
  // slow-but-real load just throws it away and restarts it.
  function pageLooksLoading() {
    if (document.readyState !== "complete") return true;
    // In-flight network requests (from inflight.js in the page world) = the app
    // is still fetching = still loading. This is the robust, selector-free signal.
    try {
      if (document.documentElement.getAttribute("data-cimea-inflight") === "1") return true;
    } catch (_) { /* ignore */ }
    // Spinner fallback (belt-and-suspenders; needs the right loading_selector).
    const sel = SEL.loading_selector;
    if (sel) {
      try {
        const el = document.querySelector(sel);
        if (el) { const r = el.getBoundingClientRect(); if (r.width > 1 && r.height > 1) return true; }
      } catch (_) { /* bad selector */ }
    }
    return false;
  }

  // Stuck-load watchdog: reload ONLY when the page is truly stuck — loaded but
  // idle/dead for STUCK_RELOAD_MS. If it's still LOADING (base load or spinner),
  // wait the longer LOADING_MAX_MS before giving up, so a slow-but-real load
  // isn't reloaded (which would just restart it). setNavigating() keeps
  // lastActionAt fresh on every real action. Never runs on Nexi (isCimea guard).
  setInterval(() => {
    if (isPaused || !authOk || !PLAYBOOK || isNavigating || !isCimea()) return;
    const idle = Date.now() - lastActionAt;
    const limit = pageLooksLoading() ? (CFG.LOADING_MAX_MS || 15000) : (CFG.STUCK_RELOAD_MS || 8000);
    if (idle > limit) {
      logToDrawer(t("d_stuck_reload"));
      setNavigating(true); // mark progress + block re-fire until the reload
      setTimeout(() => { isNavigating = false; location.reload(); }, jitter(150));
    }
  }, 1000);

  // Keep the CIMEA session alive whenever the user is logged into the tool —
  // even before automation is started. Gated on the playbook (a valid login).
  if (isCimea()) {
    checkAuthorized().then((ok) => {
      if (!ok) return;
      loadPlaybook().then((loaded) => { if (loaded) scheduleAutoRefresh(); });
    });
  }
})();
