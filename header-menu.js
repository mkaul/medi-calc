// Shared hamburger menu (☰), used by blutbild.html/plan.html/data.html/medicalc.html.
// Consolidates what used to be scattered across every page: per-page nav
// pills, the "Update" button, and (on blutbild.html only) the cross-app ZIP
// export/import/reset controls — into one consistent place, reachable
// identically from any page.
//
// Self-contained on purpose (own injected CSS, no shared stylesheet
// dependency): plan.html/data.html/medicalc.html happen to already share one
// CSS variable naming convention (--surface/--border/--text/--muted/--accent/
// --red), which this picks up automatically via var(--name, fallback); on
// blutbild.html (different variable names, its own style.css) the hardcoded
// fallbacks apply instead — either way the menu looks the same everywhere,
// which is the point: it's shared app chrome, not per-page themed content.
//
// Usage (place the script tag + call BEFORE the page's own big inline
// <script> that wires up its own buttons — see "page-specific slot" below):
//   <div id="hbm-root"></div>                  <!-- in the header -->
//   <div id="hbm-page-slot" hidden>...</div>    <!-- optional, page-specific items -->
//   <script src="header-menu.js"></script>
//   <script>createHeaderMenu({ current: 'data', onlineStatus: false });</script>
(function () {
  'use strict';

  // Apps from the configuration (config-system.js → pages, minus
  // config-user.js → hiddenPages).
  const PAGES = [
    { key: 'start', href: 'index.html', label: 'Start' },
    ...((window.APP_CONFIG && window.APP_CONFIG.pages) || []),
  ];

  function injectStyles() {
    if (document.getElementById('hbm-styles')) return;
    const style = document.createElement('style');
    style.id = 'hbm-styles';
    style.textContent = `
      /* In an iOS standalone PWA (black-translucent status bar + viewport-fit=cover)
         the web content extends under the status bar / Dynamic Island, so the header —
         and with it the absolutely-positioned hamburger below — would sit under the
         island and be untappable. Push the whole header down by the top safe-area inset
         (env() resolves to 0 in a normal browser tab, so no change there). body is a
         flex column here, so this margin does not collapse. */
      header { position: relative; padding-right: clamp(4.25rem, 8vw, 5.5rem); margin-top: env(safe-area-inset-top, 0px); }
      /* Reserved only on pages that actually get the home icon below (added
         via JS as a class on <header> itself) — the start page doesn't get
         one (it IS home), so it must not lose this space for nothing. */
      header.hbm-has-home { padding-left: clamp(3.25rem, 7vw, 4rem); }
      .hbm-home {
        position: absolute; top: 0.75rem; left: 0.75rem; z-index: 20;
        background: transparent; border: 1px solid var(--border, #2a3450);
        color: var(--text, #e2e8f0); border-radius: 8px; width: 40px; height: 40px;
        font-size: 1.1rem; cursor: pointer; display: inline-flex; align-items: center;
        justify-content: center; transition: border-color 0.15s, background 0.15s;
        text-decoration: none;
      }
      .hbm-home:hover { border-color: var(--accent, #4f9cf9); background: rgba(255,255,255,0.04); }
      .hbm-wrap {
        position: absolute; top: 0.75rem; right: 0.75rem; z-index: 20;
        display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem;
        width: fit-content;
      }
      .hbm-version-pill {
        display: inline-flex; align-items: center; padding: 0.28rem 0.6rem;
        border: 1px solid var(--border, #2a3450); border-radius: 999px;
        background: rgba(255,255,255,0.04); color: var(--muted, #64748b);
        font-size: 0.72rem; line-height: 1; white-space: nowrap;
      }
      .hbm-toggle {
        background: transparent; border: 1px solid var(--border, #2a3450);
        color: var(--text, #e2e8f0); border-radius: 8px; width: 40px; height: 40px;
        font-size: 1.1rem; cursor: pointer; display: inline-flex; align-items: center;
        justify-content: center; transition: border-color 0.15s, background 0.15s;
        font-family: inherit;
      }
      .hbm-config-status { font-size: 0.75rem; color: var(--muted, #64748b); padding: 0.1rem 0.75rem 0.35rem; }
      .hbm-toggle:hover { border-color: var(--accent, #4f9cf9); background: rgba(255,255,255,0.04); }
      .hbm-panel {
        position: absolute; top: calc(100% + 8px); right: 0; width: min(300px, calc(100vw - 1.5rem));
        max-width: calc(100vw - 1.5rem); max-height: 80vh; overflow-y: auto;
        background: var(--surface, #141929); border: 1px solid var(--border, #2a3450);
        border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.45);
        padding: 0.5rem; z-index: 9999;
      }
      .hbm-panel[hidden] { display: none; }
      .hbm-section { padding: 0.5rem 0.25rem; }
      .hbm-section + .hbm-section { border-top: 1px solid var(--border, #2a3450); }
      .hbm-section-title {
        font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
        color: var(--muted, #64748b); padding: 0.25rem 0.5rem 0.4rem;
      }
      .hbm-item {
        display: flex; align-items: center; gap: 0.5rem; width: 100%; box-sizing: border-box;
        background: transparent; border: none; text-align: left; color: var(--text, #e2e8f0);
        font: inherit; font-size: 0.85rem; padding: 0.55rem 0.6rem; border-radius: 8px;
        cursor: pointer; text-decoration: none;
      }
      .hbm-item:hover { background: rgba(255,255,255,0.06); }
      .hbm-item-current { color: var(--accent, #4f9cf9); font-weight: 600; cursor: default; }
      .hbm-item-current:hover { background: transparent; }
      .hbm-item-danger { color: var(--red, #ef4444); }
      .hbm-item-danger:hover { background: rgba(239,68,68,0.1); }
      .hbm-info-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.4rem 0.6rem 0.5rem; }
      .hbm-version { font-size: 0.75rem; color: var(--muted, #64748b); }
      /* Update-check status colours (set via update.js). Live inside the panel,
         which is the same usable width on every screen, so the "aktuell" mark
         is visible on narrow screens too. */
      .hbm-item.hbm-update-current { color: #34d399; font-weight: 600; }
      .hbm-item.hbm-update-offline { color: #f87171; font-weight: 600; }
      @media (max-width: 720px) {
        .hbm-version-pill { display: none; }
      }
    `;
    document.head.appendChild(style);
  }

  function el(tag, props) {
    const e = document.createElement(tag);
    if (props) Object.assign(e, props);
    return e;
  }

  function createHeaderMenu(opts) {
    opts = opts || {};
    injectStyles();

    const root = document.getElementById(opts.root || 'hbm-root');
    if (!root) return null;

    // Home icon, top-left, mirroring the ☰ menu at top-right — always visible
    // as the very first thing on the page so the start screen (app picker)
    // is never more than one tap away. Skipped on the start page itself,
    // which is already home.
    if (opts.current !== 'start') {
      const headerEl = root.closest('header');
      if (headerEl) headerEl.classList.add('hbm-has-home');
      const home = el('a', {
        className: 'hbm-home', href: 'index.html',
        title: 'Zur Startseite', textContent: '🏠',
      });
      home.setAttribute('aria-label', 'Zur Startseite');
      root.appendChild(home);
    }

    const wrap = el('div', { className: 'hbm-wrap' });

    const versionBadge = el('span', { className: 'hbm-version-pill' });
    versionBadge.textContent = 'v' + (opts.version || '');

    if (!opts.version) {
      fetch('manifest.json')
        .then(r => r.json())
        .then(m => {
          if (m.version) versionBadge.textContent = 'v' + m.version;
        })
        .catch(() => {});
    }

    const toggle = el('button', {
      type: 'button', id: 'hbm-toggle', className: 'hbm-toggle',
      title: 'Menü', textContent: '☰',
    });
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');

    const panel = el('div', { id: 'hbm-panel', className: 'hbm-panel' });
    panel.hidden = true;

    // ── Navigation ──────────────────────────────────────────────────────
    const navSection = el('div', { className: 'hbm-section' });
    navSection.appendChild(el('div', { className: 'hbm-section-title', textContent: 'Seiten' }));
    PAGES.forEach(p => {
      const isCurrent = p.key === opts.current;
      const a = el('a', {
        className: 'hbm-item' + (isCurrent ? ' hbm-item-current' : ''),
        href: p.href, textContent: p.label,
      });
      if (isCurrent) a.setAttribute('aria-current', 'page');
      navSection.appendChild(a);
    });
    const ekgLink = el('a', {
      className: 'hbm-item', href: 'EKG.html', textContent: 'QT-Simulator ↗',
      title: 'Interaktiver Simulator zur QT-Messmethodik — kein Datenimport, dient nur der Veranschaulichung.',
    });
    if (!window.APP_CONFIG || window.APP_CONFIG.isTabEnabled('qt')) navSection.appendChild(ekgLink);
    panel.appendChild(navSection);

    // ── Page-specific items (optional) ──────────────────────────────────
    // Provided declaratively by the host page as a plain (not <template> —
    // order-independent regardless of when this script runs) hidden
    // container; its children keep whatever ids/listeners the page already
    // wired up, we just relocate and reveal them.
    const pageSlot = document.getElementById('hbm-page-slot');
    if (pageSlot && pageSlot.children.length > 0) {
      const pageSection = el('div', { className: 'hbm-section' });
      pageSection.appendChild(el('div', { className: 'hbm-section-title', textContent: 'Diese Seite' }));
      pageSlot.hidden = false;
      pageSlot.removeAttribute('style');
      pageSlot.className = '';
      pageSection.appendChild(pageSlot);
      panel.appendChild(pageSection);
    }

    // ── Daten (alle 4 Apps) ──────────────────────────────────────────────
    const dataSection = el('div', { className: 'hbm-section' });
    dataSection.appendChild(el('div', { className: 'hbm-section-title', textContent: 'Daten (alle Apps)' }));
    dataSection.appendChild(el('button', {
      type: 'button', id: 'btn-bulk-export', className: 'hbm-item', textContent: '⬇ Alle Daten exportieren (ZIP)',
      title: 'Packt den aktuellen Stand aller vier Apps (Blutbild, Zeitreihen, Medikamente, MediCalc) in eine ZIP-Datei, z.B. um sie in einen iCloud-Drive-Ordner zu legen.',
    }));
    dataSection.appendChild(el('button', {
      type: 'button', id: 'btn-bulk-import', className: 'hbm-item', textContent: '⬆ Alle Daten importieren (ZIP)',
      title: 'Liest eine zuvor exportierte ZIP-Datei (z.B. aus iCloud Drive) und gleicht sie mit dem aktuellen Stand ab — ergänzt/aktualisiert, gelöscht wird nur, was auf dem anderen Gerät bewusst gelöscht wurde; alles nach Bestätigung.',
    }));
    dataSection.appendChild(el('input', { type: 'file', id: 'bulk-import-input', accept: '.zip,application/zip', style: 'display:none' }));
    panel.appendChild(dataSection);

    // ── Konfiguration ────────────────────────────────────────────────────
    // Persönliche Einstellungen (config-user.js). Auf einer Installation ohne
    // eigene Dateien (z.B. GitHub Pages) wird sie hier eingelesen und nur auf
    // diesem Gerät gespeichert — siehe config.js.
    if (window.APP_CONFIG) panel.appendChild(buildConfigSection());

    // ── Gefahrenzone ─────────────────────────────────────────────────────
    const dangerSection = el('div', { className: 'hbm-section' });
    dangerSection.appendChild(el('div', { className: 'hbm-section-title', textContent: 'Gefahrenzone' }));
    dangerSection.appendChild(el('button', {
      type: 'button', id: 'btn-reset-all', className: 'hbm-item hbm-item-danger', textContent: '🗑 Alles zurücksetzen',
      title: 'Löscht unwiderruflich alle Daten aller vier Apps (Blutbild, Zeitreihen, Medikamente, MediCalc) und setzt die App in den Anfangszustand zurück.',
    }));
    panel.appendChild(dangerSection);

    // ── Info ─────────────────────────────────────────────────────────────
    const infoSection = el('div', { className: 'hbm-section' });
    const infoRow = el('div', { className: 'hbm-info-row' });
    infoRow.appendChild(el('span', { id: 'app-version', className: 'hbm-version' }));
    if (opts.onlineStatus) {
      infoRow.appendChild(el('span', { id: 'online-status', title: 'Verbindungsstatus', textContent: '🟢' }));
    }
    infoSection.appendChild(infoRow);
    infoSection.appendChild(el('button', {
      type: 'button', id: 'btn-update', className: 'hbm-item', textContent: '🔄 Update',
      title: 'Die App läuft standardmäßig komplett offline aus dem Cache. Erst hier wird kurz online gegangen, um nach einer neuen Version zu suchen.',
    }));
    panel.appendChild(infoSection);

    wrap.appendChild(versionBadge);
    wrap.appendChild(toggle);
    wrap.appendChild(panel);
    root.appendChild(wrap);

    function open() { panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); }
    function close() { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      if (panel.hidden) open(); else close();
    });
    document.addEventListener('click', e => {
      if (!panel.hidden && !wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !panel.hidden) close();
    });
    // Close after any nav link / action button inside the panel — so it
    // doesn't sit open over the new page, file picker, or confirm dialog
    // that follows. Delegated (not per-item), so it also covers whatever
    // page-specific buttons were relocated into hbm-page-slot above.
    panel.addEventListener('click', e => {
      // Keep the menu open for the update check so its inline status feedback
      // ("⏳ Prüfe …" / "✓ Aktuell" / "✕ Offline", set in update.js) stays
      // visible — closing the panel would hide the button's own label change,
      // making an up-to-date click look like it did nothing. When a newer
      // version IS found the app reloads anyway, so the open panel is moot.
      // Every other link/button still closes the menu.
      if (e.target.closest('#btn-update')) return;
      if (e.target.closest('a,button')) close();
    });

    return { open, close };
  }

  function buildConfigSection() {
    const cfg = window.APP_CONFIG;
    const section = el('div', { className: 'hbm-section' });
    section.appendChild(el('div', { className: 'hbm-section-title', textContent: 'Konfiguration' }));
    const fmt = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('de-DE'); };
    const status = cfg.source === 'import'
      ? `Importiert${cfg.importedFrom ? ' aus ' + cfg.importedFrom : ''}${cfg.importedAt ? ' am ' + fmt(cfg.importedAt) : ''}`
      : cfg.source === 'file' ? 'Aus config-user.js' : 'Keine (allgemeine Standardwerte)';
    section.appendChild(el('div', { className: 'hbm-config-status', textContent: status }));

    const input = el('input', { type: 'file', accept: '.js,.json,application/json,text/javascript', style: 'display:none' });
    const loadBtn = el('button', {
      type: 'button', className: 'hbm-item', textContent: '⚙ Nutzerkonfiguration laden',
      title: 'Liest eine config-user.js oder config-user.json (Vorlage: config-user.example.js) und speichert sie auf diesem Gerät. Hat Vorrang vor einer config-user.js auf dem Server.',
    });
    loadBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      try {
        const config = cfg.parseUserConfig(await file.text(), { allowJs: true });
        const scripts = Array.isArray(config.privateScripts) ? config.privateScripts.length : 0;
        const msg = `Nutzerkonfiguration aus „${file.name}“ auf diesem Gerät übernehmen?\n\n`
          + 'Sie gilt sofort für alle Seiten (Neuladen). Gespeicherte Daten bleiben unverändert; Startdaten (seed) greifen nur bei leerer Datenbank.'
          + (scripts ? `\n\nHinweis: ${scripts} private Modul-Skript(e) werden nur geladen, wenn die Dateien auf diesem Server liegen.` : '');
        if (!confirm(msg)) return;
        cfg.saveImportedUserConfig(config, file.name);
        location.reload();
      } catch (err) {
        alert('Nutzerkonfiguration konnte nicht gelesen werden:\n' + err.message);
      }
    });
    section.appendChild(loadBtn);
    section.appendChild(input);

    if (cfg.source === 'import') {
      const clearBtn = el('button', {
        type: 'button', className: 'hbm-item', textContent: '✕ Importierte Konfiguration entfernen',
        title: cfg.hasUserFile ? 'Danach gilt wieder die config-user.js auf dem Server.' : 'Danach gelten wieder die allgemeinen Standardwerte.',
      });
      clearBtn.addEventListener('click', () => {
        if (!confirm('Importierte Nutzerkonfiguration auf diesem Gerät entfernen?\n\nGespeicherte Daten bleiben unverändert.')) return;
        cfg.clearImportedUserConfig();
        location.reload();
      });
      section.appendChild(clearBtn);
    }
    return section;
  }

  window.createHeaderMenu = createHeaderMenu;
})();
