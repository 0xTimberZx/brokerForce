/* ============================================================
   DebugHub SDK
   Version: 1.0.0
   Usage: Add this script tag BEFORE your app.js, and define
   window.DEBUGHUB_CONFIG = { appName: "Faucet" } before it loads.

   Exposes window.DebugHub with:
     startSession()
     endSession()
     logCheckpoint(name, status)   status: "pass" | "fail"
     logError(functionName, error)
     logPerf(label, durationMs)
     logSecurity(name, status)     status: "pass" | "fail"
   ============================================================ */

(function () {
  "use strict";

  var SDK_VERSION = "1.0.0";
  var MAX_EVENTS = 200;

  var config = window.DEBUGHUB_CONFIG || {};
  var APP_NAME = config.appName || "UnknownApp";
  var STORAGE_KEY = APP_NAME + "_sessions";

  var storageOk = true;
  var currentSession = null; // { id, wallet, chainId, startedAt }

  // ---------- storage helpers ----------

  function testStorage() {
    try {
      var k = "__debughub_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function b64encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function b64decode(str) {
    return decodeURIComponent(escape(atob(str)));
  }

  function loadEvents() {
    if (!storageOk) return [];
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      return JSON.parse(b64decode(raw));
    } catch (e) {
      return [];
    }
  }

  function saveEvents(events) {
    if (!storageOk) return;
    try {
      if (events.length > MAX_EVENTS) {
        events = events.slice(events.length - MAX_EVENTS);
      }
      localStorage.setItem(STORAGE_KEY, b64encode(JSON.stringify(events)));
    } catch (e) {
      storageOk = false;
      warn("Could not write to storage");
    }
  }

  function pushEvent(event) {
    var events = loadEvents();
    events.push(event);
    saveEvents(events);
  }

  // ---------- console feedback (silent unless storage fails) ----------

  function warn(msg) {
    console.warn("\u274C DebugHub: " + msg);
  }

  function ok(msg) {
    console.log("\u2705 DebugHub: " + msg);
  }

  // ---------- wallet / chain detection ----------

  function getWallet() {
    try {
      if (window.ethereum && window.ethereum.selectedAddress) {
        return window.ethereum.selectedAddress;
      }
    } catch (e) {}
    return null;
  }

  function getChainId() {
    try {
      if (window.ethereum && window.ethereum.chainId) {
        return parseInt(window.ethereum.chainId, 16);
      }
    } catch (e) {}
    return null;
  }

  // ---------- session id ----------

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function genSessionId(wallet) {
    var now = new Date();
    var mmss = pad2(now.getMinutes()) + pad2(now.getSeconds());
    var walletPrefix = wallet ? wallet.slice(0, 5) : "0xNNN";
    return APP_NAME.toLowerCase() + "-" + mmss + "-" + walletPrefix;
  }

  // ---------- base event shape ----------

  function baseEvent(type) {
    return {
      type: type,
      sessionId: currentSession ? currentSession.id : null,
      app: APP_NAME,
      sdkVersion: SDK_VERSION,
      wallet: currentSession ? currentSession.wallet : getWallet(),
      chainId: currentSession ? currentSession.chainId : getChainId(),
      timestamp: Date.now()
    };
  }

  // ---------- public API ----------

  function startSession() {
    var wallet = getWallet();
    var chainId = getChainId();

    currentSession = {
      id: genSessionId(wallet),
      wallet: wallet,
      chainId: chainId,
      startedAt: Date.now()
    };

    var evt = baseEvent("session_start");
    pushEvent(evt);

    return currentSession.id;
  }

  function endSession() {
    if (!currentSession) return;
    var evt = baseEvent("session_end");
    pushEvent(evt);
    currentSession = null;
  }

  function logCheckpoint(name, status) {
    if (!currentSession) startSession();
    var evt = baseEvent("checkpoint");
    evt.name = name;
    evt.status = status || "pass"; // "pass" | "fail"
    pushEvent(evt);
  }

  function logError(functionName, error) {
    if (!currentSession) startSession();
    var evt = baseEvent("error");
    evt.function = functionName;

    // Try to pull useful fields off the error object without
    // assuming a specific shape (MetaMask errors vary).
    if (error && typeof error === "object") {
      evt.code = error.code !== undefined ? error.code : null;
      evt.message = error.message || String(error);
    } else {
      evt.code = null;
      evt.message = String(error);
    }
    pushEvent(evt);
  }

  function logPerf(label, durationMs) {
    if (!currentSession) startSession();
    var evt = baseEvent("perf");
    evt.label = label;
    evt.durationMs = durationMs;
    pushEvent(evt);
  }

  function logSecurity(name, status) {
    if (!currentSession) startSession();
    var evt = baseEvent("security");
    evt.name = name;
    evt.status = status || "fail"; // "pass" | "fail"
    pushEvent(evt);
  }

  // ---------- wallet event wiring ----------

  function wireWalletEvents() {
    if (!window.ethereum || !window.ethereum.on) return;

    window.ethereum.on("accountsChanged", function (accounts) {
      // New connection (or switch) = end old session, start new one
      endSession();
      if (accounts && accounts.length > 0) {
        startSession();
      }
    });

    window.ethereum.on("disconnect", function () {
      endSession();
    });
  }

  window.addEventListener("beforeunload", function () {
    endSession();
  });

  // ---------- init ----------

  storageOk = testStorage();
  if (!storageOk) {
    warn("localStorage unavailable - events will not be logged");
  } else {
    ok("ready (" + APP_NAME + ")");
  }

  wireWalletEvents();

  window.DebugHub = {
    startSession: startSession,
    endSession: endSession,
    logCheckpoint: logCheckpoint,
    logError: logError,
    logPerf: logPerf,
    logSecurity: logSecurity
  };
})();
