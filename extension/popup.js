// =============================================================================
// CIMEA Helper Pro — popup logic (readable, un-obfuscated).
//
// The extension is gated: automation controls are only shown once the user has
// logged into the server. The password is sent to the server for login and is
// never stored; only the returned session token is kept (by the background).
//
// Sensitive fields (card + Telegram token) are saved to chrome.storage.local
// and never leave the device.
// =============================================================================
document.addEventListener("DOMContentLoaded", () => {
  const CFG = (typeof CIMEA_CONFIG !== "undefined") ? CIMEA_CONFIG : {};
  const $ = (id) => document.getElementById(id);

  const els = {
    // auth
    serverBase: $("serverBase"),
    loginEmail: $("loginEmail"),
    loginPassword: $("loginPassword"),
    loginBtn: $("loginBtn"),
    loginStatus: $("loginStatus"),
    loginView: $("login-view"),
    accountView: $("account-view"),
    accountEmail: $("accountEmail"),
    logoutBtn: $("logoutBtn"),
    tool: $("tool"),
    // settings
    autoFill: $("autoFillToggle"),
    fastNav: $("fastNavToggle"),
    autoRetry: $("autoRetryToggle"),
    soundAlert: $("soundAlertToggle"),
    speed: $("speedController"),
    analyticsConsent: $("analyticsConsentToggle"),
    tgToken: $("tgToken"),
    tgChatId: $("tgChatId"),
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
  function showLoggedIn(email) {
    els.loginView.style.display = "none";
    els.accountView.style.display = "block";
    els.tool.style.display = "block";
    els.accountEmail.textContent = email || "";
  }
  function showLoggedOut() {
    els.loginView.style.display = "block";
    els.accountView.style.display = "none";
    els.tool.style.display = "none";
  }

  send({ type: "authStatus" }).then((s) => {
    els.serverBase.value = s.serverBase || CFG.DEFAULT_SERVER_BASE || "";
    if (s.loggedIn) showLoggedIn(s.email); else showLoggedOut();
  });

  // ---- Login --------------------------------------------------------------
  els.loginBtn.addEventListener("click", async () => {
    const base = (els.serverBase.value || "").trim().replace(/\/+$/, "");
    const email = els.loginEmail.value.trim();
    const password = els.loginPassword.value;
    if (!base) { els.loginStatus.textContent = t("status_enter_server"); return; }
    if (!email || !password) { els.loginStatus.textContent = t("status_enter_creds"); return; }

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
    els.loginStatus.textContent = t("status_signing_in");
    const r = await send({ type: "authLogin", email, password });
    els.loginBtn.disabled = false;
    els.loginPassword.value = "";
    if (r.ok) {
      els.loginStatus.textContent = "";
      showLoggedIn(r.email || email);
    } else {
      const err = String(r.error || "");
      els.loginStatus.textContent =
        err === "no_server" ? t("status_set_server")
        : err === "network" ? t("status_network")
        : /too many/i.test(err) ? t("status_too_many")
        : t("status_login_failed");
    }
  });

  els.logoutBtn.addEventListener("click", async () => {
    await send({ type: "authLogout" });
    showLoggedOut();
  });

  // ---- Settings load ------------------------------------------------------
  const STORAGE_KEYS = [
    "autoFill", "fastNav", "autoRetry", "soundAlert", "speed",
    "analyticsConsent",
    "tgToken", "tgChatId",
    "cardName", "cardNum", "cardExp", "cardCvc",
    "totalRetries"
  ];
  chrome.storage.local.get(STORAGE_KEYS, (s) => {
    els.autoFill.checked = s.autoFill !== false;
    els.fastNav.checked = s.fastNav !== false;
    els.autoRetry.checked = s.autoRetry !== false;
    els.soundAlert.checked = s.soundAlert !== false;
    els.speed.value = s.speed || "1000";
    els.analyticsConsent.checked = s.analyticsConsent !== false;
    els.tgToken.value = s.tgToken || "";
    els.tgChatId.value = s.tgChatId || "";
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
      autoFill: els.autoFill.checked,
      fastNav: els.fastNav.checked,
      autoRetry: els.autoRetry.checked,
      soundAlert: els.soundAlert.checked,
      speed: els.speed.value,
      analyticsConsent: els.analyticsConsent.checked,
      tgToken: els.tgToken.value.trim(),
      tgChatId: els.tgChatId.value.trim(),
      cardName: els.cardName.value.trim(),
      cardNum: els.cardNum.value.replace(/\s+/g, ""),
      cardExp: els.cardExp.value.trim(),
      cardCvc: els.cardCvc.value.trim()
    });
  }
  [
    els.autoFill, els.fastNav, els.autoRetry, els.soundAlert, els.speed,
    els.analyticsConsent, els.tgToken, els.tgChatId,
    els.cardName, els.cardNum, els.cardExp, els.cardCvc
  ].forEach((el) => {
    el.addEventListener("change", persist);
    if (el.tagName === "INPUT" && el.type !== "checkbox") el.addEventListener("blur", persist);
  });

  // ---- Telegram test ------------------------------------------------------
  els.serverBase.addEventListener("blur", () => {
    const base = (els.serverBase.value || "").trim().replace(/\/+$/, "");
    if (base) chrome.storage.local.set({ serverBase: base });
  });

  $("testTgBtn").addEventListener("click", () => {
    const btn = $("testTgBtn");
    const token = els.tgToken.value.trim();
    const chatId = els.tgChatId.value.trim();
    if (!token || !chatId) { flash(btn, t("flash_enter_tg")); return; }
    persist();
    rememberOriginal(btn);
    btn.textContent = t("flash_sending");
    send({ type: "testTelegram", token, chatId }).then((r) => flash(btn, r && r.ok ? t("flash_sent") : t("flash_failed")));
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
          autoFill: els.autoFill.checked,
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

  let originals = new WeakMap();
  function rememberOriginal(btn) { if (!originals.has(btn)) originals.set(btn, btn.innerHTML); }
  function flash(btn, tempText) {
    rememberOriginal(btn);
    btn.textContent = tempText;
    setTimeout(() => { btn.innerHTML = originals.get(btn); }, 1800);
  }
});
