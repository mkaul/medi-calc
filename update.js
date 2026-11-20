// Shared "check for update" control, used by every page in this app
// (index.html, blutbild.html, plan.html, data.html, medicalc.html, ...).
//
// Philosophy: the app is offline-by-default (see sw.js — same-origin
// requests are served cache-first, no network involved) and never silently
// probes for a network connection or nags the user about available updates.
// The ONLY thing that ever goes online is this explicit "Update" button.
//
// Browsers also check sw.js on their own during navigation. Such an update
// is installed but WAITS (sw.js has no skipWaiting() in install) until the
// user taps Update — the button then reads "Update installieren (bereit)"
// and activates it without any network round-trip — or until every tab of
// the app has been closed.

// Ask once per page load for durable storage: without it Safari evicts all
// data of a site that wasn't used for 7 days (not for Home-Screen apps),
// and any browser may evict "best-effort" storage under disk pressure.
(function () {
  'use strict';
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted()
      .then(persisted => persisted || navigator.storage.persist())
      .catch(() => {});
  }
})();

// Populates #app-version (if present on this page) from manifest.json's
// "version" field — a single source of truth kept in sync with sw.js's
// APP_VERSION at deploy time, instead of 4 separate hardcoded strings that
// can silently drift out of sync. manifest.json is precached, so this
// resolves instantly offline too — no network round-trip in practice.
(function () {
  'use strict';
  const el = document.getElementById('app-version');
  if (!el) return;
  fetch('manifest.json')
    .then(r => r.json())
    .then(m => { if (m.version) el.textContent = 'v' + m.version; })
    .catch(() => {}); // leave whatever was there (or nothing) on failure
})();

(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;

  // Reload once the new service worker has taken control (after skipWaiting)
  // — but not on the very first visit, where the worker merely claims a page
  // that was never controlled (no version switch, nothing to reload).
  const hadController = !!navigator.serviceWorker.controller;
  let updateRequested = false;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if ((hadController || updateRequested) && !reloading) { reloading = true; location.reload(); }
  });

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
  }

  // Resolves once `worker` reaches the 'installed' state, or rejects after
  // timeoutMs. Attached directly to the worker object THIS update() call
  // produced — no separate, independently-registered listener to fall out
  // of sync with.
  function waitForInstalled(worker, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (worker.state === 'installed' || worker.state === 'activated') { resolve(); return; }
      const timer = setTimeout(() => {
        worker.removeEventListener('statechange', onChange);
        reject(new Error('install-timeout'));
      }, timeoutMs);
      function onChange() {
        if (worker.state === 'installed' || worker.state === 'activated') {
          clearTimeout(timer);
          worker.removeEventListener('statechange', onChange);
          resolve();
        } else if (worker.state === 'redundant') { // install failed (e.g. a precache file 404'd)
          clearTimeout(timer);
          worker.removeEventListener('statechange', onChange);
          reject(new Error('install-failed'));
        }
      }
      worker.addEventListener('statechange', onChange);
    });
  }

  function applyWaitingWorker(worker) {
    updateRequested = true;
    worker.postMessage('skipWaiting');
  }

  const STATE_CLASSES = ['hbm-update-current', 'hbm-update-offline'];

  function setButtonLabel(btn, label, revertAfterMs, stateClass) {
    if (!btn) return;
    btn.textContent = label;
    btn.classList.remove(...STATE_CLASSES);
    if (stateClass) btn.classList.add(stateClass);
    if (revertAfterMs) {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = btn.dataset.defaultLabel || '🔄 Update';
        btn.classList.remove(...STATE_CLASSES);
      }, revertAfterMs);
    }
  }

  async function checkForUpdate() {
    const btn = document.getElementById('btn-update');
    if (btn) {
      if (!btn.dataset.defaultLabel) btn.dataset.defaultLabel = btn.textContent;
      btn.disabled = true;
      setButtonLabel(btn, '⏳ Prüfe …');
    }
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) throw new Error('no-registration');

      // A version the browser already found and installed on its own is
      // waiting — activate it right away, no network needed.
      if (reg.waiting) { applyWaitingWorker(reg.waiting); return; }

      // The actual network check. If this alone doesn't respond within 10s
      // (e.g. genuinely offline), give up cleanly — unless the browser has
      // already started installing a new version meanwhile (found by this
      // call or by its own background check): then wait for that below.
      try {
        await withTimeout(reg.update(), 10000);
      } catch (err) {
        if (!reg.installing) throw err;
      }

      // Already fully installed and waiting (either from this call finishing
      // fast, or left over from an earlier passive/background check) — just
      // activate it, no separate listener needed.
      if (reg.waiting) { applyWaitingWorker(reg.waiting); return; }

      // A new version is being installed (fetching + caching every precached
      // file with cache-bypass — can legitimately take a while). Wait on the
      // actual worker object this update() call produced.
      const installing = reg.installing;
      if (installing) {
        setButtonLabel(btn, '⏳ Installiere …');
        await waitForInstalled(installing, 30000);
        applyWaitingWorker(reg.waiting || installing);
        return;
      }

      // reg.update() completed and found nothing new.
      setButtonLabel(btn, '✓ Aktuell', 2200, 'hbm-update-current');
    } catch (err) {
      // Note: if an install was already in progress when we gave up here, it
      // keeps running in the background regardless — the worker will simply
      // sit in reg.waiting until the next "Update" click (caught by the
      // reg.waiting check above) or the app is fully closed and reopened.
      console.warn('Update-Prüfung fehlgeschlagen:', err);
      setButtonLabel(btn, failureLabel(err), 4000, 'hbm-update-offline');
    }
  }

  // Every failure used to read "✕ Offline" — also an install that failed
  // because a precache file 404'd, or an install that was merely slow.
  // Only call it "Offline" when the browser itself says so.
  function failureLabel(err) {
    if (!navigator.onLine) return '✕ Offline';
    switch (err && err.message) {
      case 'install-failed': return '✕ Installation fehlgeschlagen';
      case 'install-timeout': return '⏳ Installation läuft noch';
      case 'timeout': return '✕ Server antwortet nicht';
      case 'no-registration': return '✕ Kein Service Worker';
    }
    // reg.update() rejects with a TypeError when sw.js can't be fetched
    // (no connection, captive portal, 404, wrong MIME type, ...).
    return err && err.name === 'TypeError' ? '✕ Server nicht erreichbar' : '✕ Update fehlgeschlagen';
  }

  function wire() {
    const btn = document.getElementById('btn-update');
    if (!btn) return;
    btn.addEventListener('click', checkForUpdate);
    // Passive hint, no network involved: an update is already installed.
    navigator.serviceWorker.getRegistration().then(reg => {
      if (reg && reg.waiting && !btn.disabled) {
        btn.dataset.defaultLabel = '⬆️ Update installieren (bereit)';
        btn.textContent = btn.dataset.defaultLabel;
      }
    }).catch(() => {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
