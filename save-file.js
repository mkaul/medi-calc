// Shared "hand a file to the user" helper (bulk ZIP export, MediCalc CSV
// export). Defines window.saveFile(blob, fileName) → Promise<'shared' |
// 'downloaded' | 'cancelled'>.
//
//   - Touch devices get the OS share sheet ("In Dateien sichern" → iCloud
//     Drive). Detected by input capability, not user agent: iPadOS reports
//     itself as a Mac, so the old /iPad/ user-agent test missed it.
//   - navigator.share() needs a fresh user gesture. If collecting the data
//     took too long the gesture has expired (NotAllowedError) — then a small
//     dialog asks for one more tap instead of failing.
//   - Everywhere else: plain download. The object URL is revoked only after
//     a delay; revoking right after click() can cancel the download in Safari.
(function () {
  'use strict';

  function prefersShareSheet() {
    return (window.matchMedia && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1;
  }

  async function share(file) {
    try {
      // No `title` alongside `files` — some share targets ("In Dateien
      // sichern") otherwise create a bogus second "Text.txt".
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      throw err;
    }
  }

  // Minimal self-contained modal (inline styles, like bulk-import.js's).
  function askForTap(fileName, file) {
    return new Promise((resolve, reject) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,8,15,0.75);display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
      const card = document.createElement('div');
      card.style.cssText = 'background:#141929;border:1px solid #2a3450;border-radius:12px;max-width:420px;width:100%;padding:1.25rem 1.5rem;box-shadow:0 20px 60px rgba(0,0,0,0.5);color:#e2e8f0;';
      const title = document.createElement('h2');
      title.style.cssText = 'margin:0 0 0.4rem;font-size:1.05rem;';
      title.textContent = 'Datei ist bereit';
      const name = document.createElement('p');
      name.style.cssText = 'margin:0 0 1rem;font-size:0.85rem;color:#94a3b8;overflow-wrap:anywhere;';
      name.textContent = fileName;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:0.6rem;justify-content:flex-end;';
      const cancel = document.createElement('button');
      cancel.textContent = 'Abbrechen';
      cancel.style.cssText = 'background:transparent;color:#94a3b8;border:1px solid #2a3450;border-radius:6px;padding:0.55rem 1rem;font-size:0.9rem;cursor:pointer;font-family:inherit;';
      const ok = document.createElement('button');
      ok.textContent = 'Teilen / Sichern';
      ok.style.cssText = 'background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:0.55rem 1.1rem;font-size:0.9rem;font-weight:600;cursor:pointer;font-family:inherit;';
      row.append(cancel, ok);
      card.append(title, name, row);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      cancel.addEventListener('click', () => { overlay.remove(); resolve('cancelled'); });
      // share() is called synchronously inside this click handler, so it
      // gets the fresh user activation.
      ok.addEventListener('click', () => {
        overlay.remove();
        share(file).then(resolve, reject);
      });
    });
  }

  function download(file, fileName) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return 'downloaded';
  }

  async function saveFile(blob, fileName) {
    const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
    if (prefersShareSheet() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        return await share(file);
      } catch (err) {
        if (err.name !== 'NotAllowedError') throw err;
        return askForTap(fileName, file);
      }
    }
    return download(file, fileName);
  }

  window.saveFile = saveFile;
})();
