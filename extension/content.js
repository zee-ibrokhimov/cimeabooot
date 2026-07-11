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
  let isNavigating = false;
  let isPaused = true;          // wait for the user to start
  let sessionId = null;
  let runStartedAt = 0;
  let audioCtx = null;          // single reused AudioContext
  let nexiBeeper = null;        // beeper interval id (so we can clear it)
  let observerActive = false;
  let authOk = false;           // last known authorization while running
  let lastAuthCheck = 0;        // when we last re-checked with the background
  let authChecking = false;

  // Small +/- jitter on delays so the click cadence isn't perfectly robotic —
  // this helps avoid rate-limit / anti-bot detection while staying fast.
  const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));
  const settle = () => jitter(actionDelay);
  // On a server 5xx / daily-limit bounce, retry fast (but capped for sanity).
  const retryDelay = () => jitter(Math.min(actionDelay, 1500));

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
  function newSessionId() {
    return (self.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : "s_" + Math.random().toString(36).slice(2);
  }

  // Ask the background whether the user has a valid session. Automation is
  // blocked unless this resolves true.
  function checkAuthorized() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "isAuthorized" }, (r) => {
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
    checkAuthorized().then((ok) => {
      authChecking = false;
      lastAuthCheck = Date.now();
      if (!ok) hardStopAuth();
    });
  }

  // ---------------------------------------------------------------------------
  // Settings sync
  // ---------------------------------------------------------------------------
  chrome.storage.local.get(["speed", "automationActive", "lang"], (res) => {
    if (res.lang) lang = res.lang;
    if (res.speed) actionDelay = parseInt(res.speed, 10) || 1000;
    if (res.automationActive) {
      // Only auto-resume if the session is still valid.
      checkAuthorized().then((ok) => {
        if (!ok) {
          isPaused = true;
          chrome.storage.local.set({ automationActive: false });
          injectDrawer();
          logToDrawer(t("d_login_required"));
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
      return /stay logged in|extend|prolunga|mantieni|continue/.test(t);
    });
    if (keep && keep.offsetParent !== null && !keep.disabled) {
      keep.click();
      logToDrawer(t("d_extended_session"));
    }
  }, 30000);

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

      // Resuming — requires a valid session.
      checkAuthorized().then((ok) => {
        if (!ok) {
          logToDrawer(t("d_not_logged_in"));
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
      // Server-gated: never run without a valid session.
      checkAuthorized().then((ok) => {
        if (!ok) {
          isPaused = true;
          chrome.storage.local.set({ automationActive: false });
          injectDrawer();
          logToDrawer(t("d_not_logged_in"));
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
  });

  // ---------------------------------------------------------------------------
  // Main state machine (throttled)
  // ---------------------------------------------------------------------------
  function checkPageState() {
    if (isNavigating || isPaused) return;
    // Re-check authorization periodically; refuse to act while unauthorized so a
    // revoked/disabled user is stopped mid-run (not just at start).
    maybeRecheckAuth();
    if (!authOk) return;
    const pageText = (document.body.innerText || "").toLowerCase();
    const hash = location.hash.toLowerCase();

    // Server crash recovery
    if (/(502 bad gateway|504 gateway time-out|503 service unavailable|service unavailable|internal server error)/.test(pageText)) {
      logToDrawer(t("d_server_error"));
      track("server_crash_detected", { errorType: "server_5xx" });
      isNavigating = true;
      setTimeout(() => location.reload(), retryDelay());
      return;
    }

    // Payment / service page
    if (hash.includes("#/service") || hash.includes("#/request") ||
        pageText.includes("billing address") || pageText.includes("purchase a service")) {

      if (/the maximum limit of daily requests has been reached|il limite massimo di richieste giornaliere/.test(pageText)) {
        logToDrawer(t("d_daily_limit"));
        track("daily_limit_hit", { step: "service" });
        isNavigating = true;
        const home = Array.from(document.querySelectorAll("a,div,span,li")).find((el) => {
          const t = (el.innerText || "").trim().toLowerCase();
          return t === "homepage" || t === "home";
        });
        if (home) home.click(); else location.hash = "#/";
        setTimeout(() => { isNavigating = false; }, settle());
        return;
      }

      const saveBtn = Array.from(document.querySelectorAll("button")).find((el) => {
        const t = (el.innerText || "").toLowerCase();
        return t.includes("save and next") || t.includes("salva e continua");
      });
      if (saveBtn && !saveBtn.disabled && saveBtn.offsetParent !== null) {
        logToDrawer(t("d_clicking_savenext"));
        isNavigating = true;
        saveBtn.click();
        chrome.storage.local.get(["totalRetries"], (r) => {
          const total = (r.totalRetries || 0) + 1;
          chrome.storage.local.set({ totalRetries: total });
          track("save_next_clicked", { step: "payment_page", retries: total });
        });
        setTimeout(() => { isNavigating = false; }, settle());
        return;
      }
    }

    // Homepage: open the most recent Draft and complete it
    if (hash === "#/" || hash.includes("#/home") || pageText.includes("my requests")) {
      handleDraftFlow();
    }

    // Auto-fill card details (LOCAL ONLY) — ONLY on the Nexi payment gateway.
    // Never on the cimea-diplome.it app, so card data can never be typed into a
    // form on that origin.
    if (isNexi()) maybeFillCard();

    // Nexi payment gateway: alert the user
    if (isNexi() && !nexiBeeper) {
      track("payment_page_reached", { step: "nexi" });
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
    if (/payment successful|pagamento riuscito|payment completed/.test(pageText)) {
      chrome.storage.local.get(["soundAlert", "successAlertSent"], (r) => {
        if (r.soundAlert !== false) playSound();
        if (!r.successAlertSent) {
          safeSendMessage({ type: "notifyTelegram", text: "🎉 CIMEA payment was SUCCESSFUL!" });
          chrome.storage.local.set({
            successAlertSent: true, paymentSucceeded: true, automationActive: false
          });
        }
      });
      track("payment_success", {
        step: "success",
        durationMs: runStartedAt ? Date.now() - runStartedAt : null
      });
      logToDrawer(t("d_success"));
      isPaused = true;
      stopBeeper();
      stopObserver();
    }
  }

  function handleDraftFlow() {
    const drafts = Array.from(document.querySelectorAll("span,p,div,button,a")).filter((el) => {
      const t = (el.innerText || "").trim().toLowerCase();
      return (t === "draft" || t === "bozza") && el.offsetParent !== null;
    });
    if (drafts.length === 0) return;
    drafts.sort((a, b) => depth(b) - depth(a));
    const badge = drafts[0];

    const completes = Array.from(document.querySelectorAll("button,a,div,span,li,p")).filter((el) => {
      const t = (el.innerText || "").toLowerCase().trim();
      return (t === "complete" || t === "completa" || t === "complete request" || t === "completa richiesta") &&
        el.offsetParent !== null && t.length < 30;
    }).sort((a, b) => depth(b) - depth(a));

    if (completes.length > 0) {
      logToDrawer(t("d_clicking_complete"));
      isNavigating = true;
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
      isNavigating = true;
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
    const ccInput = document.querySelector(
      'input[name="cardnumber"],input[autocomplete="cc-number"],input[name="pan"]'
    );
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
      fill('input[name="cardnumber"],input[autocomplete="cc-number"],input[name="pan"]', r.cardNum);
      fill('input[autocomplete="cc-name"],input[name="cardholderName"]', r.cardName);
      fill('input[autocomplete="cc-csc"],input[name="cvc"],input[name="cvv"]', r.cardCvc);
      fill('input[autocomplete="cc-exp"],input[name="exp-date"],input[name="expiry"]', r.cardExp);
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
    setTimeout(() => { scheduled = false; checkPageState(); }, 200);
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
  setTimeout(checkPageState, 500);
  setInterval(checkPageState, 1000); // failsafe (survives observer disconnect)
})();
