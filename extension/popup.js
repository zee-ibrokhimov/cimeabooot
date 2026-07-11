// =============================================================================
// CIMEA Helper Pro — popup logic (readable, un-obfuscated).
//
// The extension is gated: automation controls are only shown once the user has
// logged into the server. The password is sent to the server for login and is
// never stored; only the returned session token is kept (by the background).
//
// Card fields are saved to chrome.storage.local and never leave the device.
// =============================================================================
document.addEventListener("DOMContentLoaded", () => {
  const CFG = (typeof CIMEA_CONFIG !== "undefined") ? CIMEA_CONFIG : {};
  const $ = (id) => document.getElementById(id);

  const els = {
    // auth
    serverBase: $("serverBase"),
    accessCode: $("accessCode"),
    loginBtn: $("loginBtn"),
    loginStatus: $("loginStatus"),
    loginView: $("login-view"),
    accountView: $("account-view"),
    accountEmail: $("accountEmail"),
    logoutBtn: $("logoutBtn"),
    tool: $("tool"),
    // settings
    fastNav: $("fastNavToggle"),
    autoRetry: $("autoRetryToggle"),
    soundAlert: $("soundAlertToggle"),
    fastLoad: $("fastLoadToggle"),
    speed: $("speedController"),
    tabCount: $("tabCount"),
    analyticsConsent: $("analyticsConsentToggle"),
    cardName: $("cardName"),
    cardNum: $("cardNum"),
    cardExp: $("cardExp"),
    cardCvc: $("cardCvc"),
    statRetries: $("stat-retries"),
    statTime: $("stat-time")
  };

  const send = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || {}); }); }
    catch (_) { resolve({}); }
  });

  // ---- Language / i18n ----------------------------------------------------
  let currentLang = (typeof cimeaDefaultLang === "function") ? cimeaDefaultLang() : "en";
  const t = (key) => (typeof cimeaT === "function") ? cimeaT(key, currentLang) : key;

  function applyLang(lang) {
    currentLang = (lang === "ru") ? "ru" : "en";
    document.documentElement.lang = currentLang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    $("lang-en").classList.toggle("active", currentLang === "en");
    $("lang-ru").classList.toggle("active", currentLang === "ru");
    // Drop remembered button markup so flash() restores the newly-translated text.
    originals = new WeakMap();
  }

  function setLang(lang) {
    applyLang(lang);
    chrome.storage.local.set({ lang: currentLang });
  }
  $("lang-en").addEventListener("click", () => setLang("en"));
  $("lang-ru").addEventListener("click", () => setLang("ru"));

  chrome.storage.local.get(["lang"], (s) => applyLang(s.lang || currentLang));

  // ---- Auth view state ----------------------------------------------------
  function showLoggedIn() {
    els.loginView.style.display = "none";
    els.accountView.style.display = "block";
    els.tool.style.display = "block";
    els.accountEmail.textContent = t("account_activated");
  }
  function showLoggedOut() {
    els.loginView.style.display = "block";
    els.accountView.style.display = "none";
    els.tool.style.display = "none";
  }
  // Standalone/personal mode: no server, no login — just show the tool.
  function showStandalone() {
    const auth = document.getElementById("auth-section");
    if (auth) auth.style.display = "none";
    els.tool.style.display = "block";
    const sub = document.querySelector(".subtitle");
    if (sub) sub.textContent = t("subtitle_standalone");
  }

  send({ type: "authStatus" }).then((s) => {
    els.serverBase.value = s.serverBase || CFG.DEFAULT_SERVER_BASE || "";
    if (s.requireLogin === false) showStandalone();
    else if (s.loggedIn) showLoggedIn();
    else showLoggedOut();
  });

  // ---- Activate (Telegram access code) ------------------------------------
  els.loginBtn.addEventListener("click", async () => {
    const base = (els.serverBase.value || "").trim().replace(/\/+$/, "");
    const code = els.accessCode.value.trim();
    if (!base) { els.loginStatus.textContent = t("status_enter_server"); return; }
    if (!code) { els.loginStatus.textContent = t("status_enter_code"); return; }

    let origin;
    try { origin = new URL(base).origin + "/*"; }
    catch { els.loginStatus.textContent = t("status_invalid_url"); return; }

    // Persist the base and request host permission for it (user gesture).
    await new Promise((res) => chrome.storage.local.set({ serverBase: base }, res));
    const granted = await new Promise((resolve) => {
      try { chrome.permissions.request({ origins: [origin] }, (g) => { void chrome.runtime.lastError; resolve(!!g); }); }
      catch (_) { resolve(false); }
    });
    if (!granted) { els.loginStatus.textContent = t("status_allow_domain"); return; }

    els.loginBtn.disabled = true;
    els.loginStatus.textContent = t("status_activating");
    const r = await send({ type: "authActivate", code });
    els.loginBtn.disabled = false;
    if (r.ok) {
      els.loginStatus.textContent = "";
      els.accessCode.value = "";
      showLoggedIn();
    } else {
      const err = String(r.error || "");
      els.loginStatus.textContent =
        err === "no_server" ? t("status_set_server")
        : err === "network" ? t("status_network")
        : /too many/i.test(err) ? t("status_too_many")
        : err === "bound" ? t("status_bound")
        : t("status_code_invalid");
    }
  });

  els.logoutBtn.addEventListener("click", async () => {
    await send({ type: "authLogout" });
    showLoggedOut();
  });

  // ---- Settings load ------------------------------------------------------
  const STORAGE_KEYS = [
    "fastNav", "autoRetry", "soundAlert", "fastLoad", "speed", "tabCount",
    "analyticsConsent",
    "cardName", "cardNum", "cardExp", "cardCvc",
    "totalRetries"
  ];
  chrome.storage.local.get(STORAGE_KEYS, (s) => {
    els.fastNav.checked = s.fastNav !== false;
    els.autoRetry.checked = s.autoRetry !== false;
    els.soundAlert.checked = s.soundAlert !== false;
    els.fastLoad.checked = s.fastLoad !== false;
    els.speed.value = s.speed || "1000";
    els.tabCount.value = s.tabCount || "3";
    els.analyticsConsent.checked = s.analyticsConsent !== false;
    els.cardName.value = s.cardName || "";
    els.cardNum.value = s.cardNum || "";
    els.cardExp.value = s.cardExp || "";
    els.cardCvc.value = s.cardCvc || "";

    const retries = s.totalRetries || 0;
    els.statRetries.textContent = retries;
    const secs = retries * 4;
    els.statTime.textContent = secs >= 60
      ? Math.floor(secs / 60) + "m " + (secs % 60) + "s"
      : secs + "s";
  });

  // ---- Persist on change --------------------------------------------------
  function persist() {
    chrome.storage.local.set({
      fastNav: els.fastNav.checked,
      autoRetry: els.autoRetry.checked,
      soundAlert: els.soundAlert.checked,
      fastLoad: els.fastLoad.checked,
      speed: els.speed.value,
      tabCount: els.tabCount.value,
      analyticsConsent: els.analyticsConsent.checked,
      cardName: els.cardName.value.trim(),
      cardNum: els.cardNum.value.replace(/\s+/g, ""),
      cardExp: els.cardExp.value.trim(),
      cardCvc: els.cardCvc.value.trim()
    });
  }
  [
    els.fastNav, els.autoRetry, els.soundAlert, els.fastLoad, els.speed, els.tabCount,
    els.analyticsConsent,
    els.cardName, els.cardNum, els.cardExp, els.cardCvc
  ].forEach((el) => {
    el.addEventListener("change", persist);
    if (el.tagName === "INPUT" && el.type !== "checkbox") el.addEventListener("blur", persist);
  });

  // ---- Persist the server URL on blur -------------------------------------
  els.serverBase.addEventListener("blur", () => {
    const base = (els.serverBase.value || "").trim().replace(/\/+$/, "");
    if (base) chrome.storage.local.set({ serverBase: base });
  });

  // ---- Wipe card data -----------------------------------------------------
  $("clearCardBtn").addEventListener("click", () => {
    chrome.storage.local.remove(["cardName", "cardNum", "cardExp", "cardCvc"], () => {
      els.cardName.value = els.cardNum.value = els.cardExp.value = els.cardCvc.value = "";
      flash($("clearCardBtn"), t("flash_wiped"));
    });
  });

  // ---- Start automation ---------------------------------------------------
  $("startBtn").addEventListener("click", () => {
    persist();
    const btn = $("startBtn");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, {
        action: "startAutomation",
        settings: {
          fastNav: els.fastNav.checked,
          autoRetry: els.autoRetry.checked,
          soundAlert: els.soundAlert.checked
        }
      }, (resp) => {
        if (chrome.runtime.lastError) flash(btn, t("flash_open_site"));
        else if (resp && resp.status === "unauthorized") flash(btn, t("flash_session_expired"));
        else flash(btn, t("flash_active"));
      });
    });
  });

  // ---- Multi-tab launcher -------------------------------------------------
  // Clones the current CIMEA tab N times, opening each ~300ms apart (plus a
  // little jitter) so their automation starts are staggered. Each new tab
  // auto-starts on load because automationActive is set. Runs on the user's own
  // machine / single session — no proxies, no scaling.
  $("launchTabsBtn").addEventListener("click", () => {
    const btn = $("launchTabsBtn");
    const n = Math.max(2, Math.min(5, parseInt(els.tabCount.value, 10) || 3));
    persist();
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const cur = tabs[0];
      if (!cur || !/cimea-diplome\.it/.test(cur.url || "")) {
        flash(btn, t("flash_open_site"));
        return;
      }
      // Gate on a valid session before arming the shared auto-start flag, same
      // as the Start / Resume paths.
      const auth = await send({ type: "isAuthorized" });
      if (!auth.ok) { flash(btn, t("flash_session_expired")); return; }
      // Arm auto-start so freshly-opened tabs begin on load.
      chrome.storage.local.set({ automationActive: true });
      // Start the current tab immediately.
      chrome.tabs.sendMessage(cur.id, {
        action: "startAutomation",
        settings: {
          fastNav: els.fastNav.checked,
          autoRetry: els.autoRetry.checked,
          soundAlert: els.soundAlert.checked
        }
      }, () => { void chrome.runtime.lastError; });
      // Open the rest in the background, synchronously (so they all open even if
      // the popup closes). Each tab jitters its own first action, so their starts
      // are still staggered by a few hundred ms.
      for (let i = 1; i < n; i++) {
        try { chrome.tabs.create({ url: cur.url, active: false }); } catch (_) { /* ignore */ }
      }
      flash(btn, t("flash_launched"));
    });
  });

  let originals = new WeakMap();
  function rememberOriginal(btn) { if (!originals.has(btn)) originals.set(btn, btn.innerHTML); }
  function flash(btn, tempText) {
    rememberOriginal(btn);
    btn.textContent = tempText;
    setTimeout(() => { btn.innerHTML = originals.get(btn); }, 1800);
  }
});
