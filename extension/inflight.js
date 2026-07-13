// =============================================================================
// inflight.js — runs in the PAGE (MAIN) world at document_start on CIMEA pages.
//
// It counts in-flight fetch()/XHR requests and reflects "is anything loading?"
// to a DOM attribute (data-cimea-inflight on <html>). The content script (which
// runs in the isolated world and can't see the page's fetch) reads that attr so
// the stuck-load watchdog knows to WAIT while the page is still loading instead
// of reloading (which would just restart the load).
//
// Wrapping is done defensively: original behavior + promise identity preserved,
// all errors swallowed, and toString() spoofed to look native so it doesn't add
// an obvious automation fingerprint.
// =============================================================================
(() => {
  "use strict";
  if (window.top !== window) return; // top frame only

  var n = 0;
  function reflect() {
    try { document.documentElement.setAttribute("data-cimea-inflight", n > 0 ? "1" : "0"); } catch (e) { /* ignore */ }
  }
  function dec() { if (n > 0) n--; reflect(); }
  reflect();

  // ---- wrap fetch -----------------------------------------------------------
  try {
    var of = window.fetch;
    if (typeof of === "function") {
      var wf = function () {
        n++; reflect();
        var p;
        try { p = of.apply(this, arguments); }
        catch (e) { dec(); throw e; }
        try {
          if (p && typeof p.then === "function") p.then(dec, dec); // settle either way
          else dec();
        } catch (e) { dec(); }
        return p; // return the ORIGINAL promise unchanged
      };
      try { wf.toString = function () { return "function fetch() { [native code] }"; }; } catch (e) { /* ignore */ }
      window.fetch = wf;
    }
  } catch (e) { /* ignore */ }

  // ---- wrap XMLHttpRequest.send ---------------------------------------------
  try {
    var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && typeof XP.send === "function") {
      var os = XP.send;
      var ws = function () {
        var counted = false;
        var done = function () { if (counted) { counted = false; dec(); } };
        try { n++; counted = true; reflect(); this.addEventListener("loadend", done); } catch (e) { /* ignore */ }
        return os.apply(this, arguments);
      };
      try { ws.toString = function () { return "function send() { [native code] }"; }; } catch (e) { /* ignore */ }
      XP.send = ws;
    }
  } catch (e) { /* ignore */ }
})();
