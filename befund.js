// Medizinischer Befundbericht (KI-Medizinanalyse) — standalone page.
// Reads the same OCR-scanned blood values blutbild.html stores in IndexedDB
// (via blood-data.js), plus data.html's Zeitreihen (Blutdruck/Strahlung/
// Ereignisse and whatever modules contribute), and sends a user-selected subset to a selectable
// LLM provider (Anthropic Claude or DeepSeek — see PROVIDERS below) for a
// written Befundbericht. Moved out of blutbild.html so it's reachable
// directly from the start screen. The analyse cache itself lives in
// BlutbildDB's `metadata` store, same as before — bulk-import.js already
// reads/writes it independently of which page renders the UI.
(function () {
  'use strict';

  const { initDB, loadFilesFromStorage, computeGroupedData } = window.BloodData;

  const DOM = {
    btnAnalyse: document.getElementById('btn-analyse'),
    btnAnalyseLabel: document.getElementById('btn-analyse-label'),
    // The single key field always holds the key of whichever provider is
    // selected in #ai-provider — swapped by applyProviderToControls().
    apiKeyInput: document.getElementById('ai-api-key'),
    aiProviderSelect: document.getElementById('ai-provider'),
    aiModelSelect: document.getElementById('ai-model'),
    analyseContext: document.getElementById('analyse-context'),
    analyseSystemPrompt: document.getElementById('analyse-system-prompt'),
    analyseResult: document.getElementById('analyse-result'),
    analyseResultBody: document.querySelector('#analyse-result .analyse-result-body'),
    analyseResultTitle: document.getElementById('analyse-result-title'),
    analyseResultShare: document.getElementById('btn-analyse-share'),
    toastNotification: document.getElementById('toast-notification'),
    toastText: document.getElementById('toast-text'),
  };

  const state = {
    groupedData: {}, // Blutbild marker -> chronological value series
    files: [], // raw file records backing groupedData — see computeDataFingerprint
    lastMarkdown: '', // raw Markdown of the last rendered analyse result (copy-to-clipboard source)
    providerId: 'claude', // active PROVIDERS entry, restored from localStorage in init()
  };

  // --- SYSTEM PROMPT ─────────────────────────────────────────────────────────
  // Editable via #analyse-system-prompt; the last input is persisted in the
  // 'analyse' metadata record (field systemPrompt) so bulk-import.js exports
  // it alongside context/result. SYSTEM_PROMPT_PLACEHOLDER is substituted with
  // the labels of the datasets chosen in the selection modal.
  const SYSTEM_PROMPT_PLACEHOLDER = '{{datenquellen}}';
  // Default from the configuration (config-system.js → befund, specialties
  // and/or the whole prompt overridable in config-user.js).
  const DEFAULT_SYSTEM_PROMPT = window.APP_CONFIG.befund.systemPrompt;

  // --- PROVIDER ABSTRACTION ────────────────────────────────────────────────
  // Each entry bundles everything that differs between Anthropic's Messages
  // API and DeepSeek's OpenAI-compatible Chat Completions API: endpoint, auth
  // header, request-body shape, stream-delta shape and per-model token
  // ceiling. runAiAnalysis() below only talks to this config, so a third
  // provider costs exactly one entry here.
  //
  // Things that actually differ and would break a naive swap:
  //  - Claude takes the system prompt as a top-level `system` field; the
  //    OpenAI-compatible shape expects it as a message with role 'system'.
  //  - Claude streams {type:'content_block_delta',delta:{text}} and closes
  //    with a `message_stop` event; DeepSeek streams
  //    {choices:[{delta:{content}}]} and closes with a literal `data: [DONE]`
  //    sentinel that is not JSON and must be filtered out (see the SSE loop).
  //  - max_tokens ceilings are per model. Sending more than a model's
  //    documented maximum is an HTTP 400, not a silent trim. The values here
  //    are deliberately conservative; verify against the provider's current
  //    docs before raising them.
  const PROVIDERS = {
    claude: {
      id: 'claude',
      label: 'Claude (Anthropic)',
      shortLabel: 'Claude',
      // localStorage key kept as-is so users who already saved a Claude key
      // keep it — no migration needed despite the renamed DOM id.
      storageKey: 'claude-api-key',
      endpoint: 'https://api.anthropic.com/v1/messages',
      models: [
        // Both run adaptive thinking by default; thinking tokens count against
        // max_tokens, hence the larger budget. Thinking deltas are skipped by
        // extractDelta() and only shown live via extractReasoning() below.
        // Documented output ceiling is 128K for both.
        { id: 'claude-opus-5', label: 'Claude Opus 5', maxTokens: 32768 },
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', maxTokens: 32768 },
      ],
      buildRequest({ apiKey, model, systemPrompt, userMessage, maxTokens }) {
        return {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            // Anthropic refuses browser-originated calls unless this opt-in
            // is set. DeepSeek has no equivalent flag — its CORS preflight
            // already allows `authorization` + `content-type` (verified).
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: {
            model,
            max_tokens: maxTokens,
            stream: true,
            // Thinking display defaults to "omitted" on these models: the
            // thinking phase then streams empty blocks and the page sits
            // silent until the first answer token. "summarized" streams a
            // readable summary that runAiAnalysis() shows as live progress
            // (it is never part of the saved report).
            thinking: { type: 'adaptive', display: 'summarized' },
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
          },
        };
      },
      extractDelta(event) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          return event.delta.text || null;
        }
        return null;
      },
      extractReasoning(event) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
          return event.delta.thinking || null;
        }
        return null;
      },
      showReasoningText: true,
    },

    deepseek: {
      id: 'deepseek',
      label: 'DeepSeek',
      shortLabel: 'DeepSeek',
      storageKey: 'deepseek-api-key',
      endpoint: 'https://api.deepseek.com/chat/completions',
      models: [
        // Current flagship, served as DeepSeek-V4.1-Flash (docs list the id as
        // `deepseek-flash`; the legacy `deepseek-v4-flash` name is still
        // accepted and routed to Flash, but no longer the primary id).
        // Thinking mode is ON by default for this model, so reasoning_content
        // streams before the first answer token — see extractReasoning() below.
        // Its documented output ceiling is 384K, which makes this budget
        // comfortable even with the chain-of-thought counted against it.
        { id: 'deepseek-flash', label: 'DeepSeek Flash (V4.1)', maxTokens: 32768 },
        // Same 1M context / 384K output ceiling as Flash.
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', maxTokens: 32768 },
        // `deepseek-chat` and `deepseek-reasoner` were dropped: they no longer
        // appear in the current docs, and sending a retired id is an HTTP 400.
      ],
      buildRequest({ apiKey, model, systemPrompt, userMessage, maxTokens }) {
        return {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: {
            model,
            max_tokens: maxTokens,
            stream: true,
            // The system prompt is a regular message here, not a top-level
            // field as in the Anthropic shape.
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
          },
        };
      },
      extractDelta(event) {
        // Thinking-mode models stream their chain-of-thought in
        // `delta.reasoning_content` and only the answer in `delta.content`.
        // We render the answer only — extractReasoning() below just switches
        // the waiting indicator to "Modell denkt nach" (showReasoningText is
        // off: DeepSeek's raw chain-of-thought is long and unpolished, so the
        // user only sees the animated dots until the answer starts).
        return event.choices?.[0]?.delta?.content || null;
      },
      extractReasoning(event) {
        return event.choices?.[0]?.delta?.reasoning_content || null;
      },
    },
  };

  // --- SMALL SHARED HELPERS (kept local — see bulk-import.js's file header
  // for why light duplication across self-contained pages is the norm here) ---

  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- MINIMAL MARKDOWN -> HTML RENDERER ──────────────────────────────────
  // Claude's Befundbericht responses use plain, common Markdown (headings,
  // lists, bold/italic, tables, blockquotes). No external Markdown library
  // is loaded (this app is offline-first and dependency-free by design —
  // see sw.js's precache list), so a small hand-rolled block/inline parser
  // covers the subset the system prompt actually produces.

  function renderInlineMarkdown(text) {
    let out = escapeHTML(text);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/\b_(.+?)_\b/g, '<em>$1</em>');
    return out;
  }

  function splitTableRow(line) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length && cells[0] === '') cells.shift();
    if (cells.length && cells.at(-1) === '') cells.pop();
    return cells;
  }

  function isTableSeparatorRow(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  }

  function markdownToHtml(markdown) {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const n = lines.length;
    let html = '';
    let i = 0;

    while (i < n) {
      const line = lines[i];

      if (/^\s*$/.test(line)) { i++; continue; }

      if (/^\s*```/.test(line)) {
        const codeLines = [];
        i++;
        while (i < n && !/^\s*```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
        i++;
        html += `<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        html += `<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`;
        i++;
        continue;
      }

      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        html += '<hr>';
        i++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (i < n && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html += `<blockquote>${markdownToHtml(quoteLines.join('\n'))}</blockquote>`;
        continue;
      }

      if (line.includes('|') && i + 1 < n && isTableSeparatorRow(lines[i + 1])) {
        const headerCells = splitTableRow(line);
        i += 2;
        const rows = [];
        while (i < n && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        html += '<table><thead><tr>'
          + headerCells.map(c => `<th>${renderInlineMarkdown(c)}</th>`).join('')
          + '</tr></thead><tbody>'
          + rows.map(cells => '<tr>' + cells.map(c => `<td>${renderInlineMarkdown(c)}</td>`).join('') + '</tr>').join('')
          + '</tbody></table>';
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < n && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i++;
        }
        html += '<ul>' + items.map(it => `<li>${renderInlineMarkdown(it)}</li>`).join('') + '</ul>';
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < n && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          i++;
        }
        html += '<ol>' + items.map(it => `<li>${renderInlineMarkdown(it)}</li>`).join('') + '</ol>';
        continue;
      }

      const paraLines = [];
      while (
        i < n && !/^\s*$/.test(lines[i]) &&
        !/^\s*```/.test(lines[i]) &&
        !/^#{1,6}\s+/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+[.)]\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        // Stop before a table header row even without a preceding blank
        // line — Claude's Markdown often runs a lead-in sentence straight
        // into a table. Without this, the header/separator/data rows all
        // get absorbed into this paragraph and their "|" render as literal
        // text instead of a table.
        !(lines[i].includes('|') && i + 1 < n && isTableSeparatorRow(lines[i + 1]))
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length) {
        html += `<p>${renderInlineMarkdown(paraLines.join(' '))}</p>`;
      } else {
        i++; // safety net against infinite loops on unrecognised lines
      }
    }

    return html;
  }

  let toastTimeout;
  function showToast(message, type = 'info') {
    clearTimeout(toastTimeout);
    DOM.toastText.textContent = message;
    DOM.toastNotification.className = 'toast show';
    if (type === 'success') {
      DOM.toastNotification.classList.add('toast-success');
      DOM.toastNotification.querySelector('.toast-icon').textContent = '✓';
    } else if (type === 'error') {
      DOM.toastNotification.classList.add('toast-error');
      DOM.toastNotification.querySelector('.toast-icon').textContent = '✕';
    } else {
      DOM.toastNotification.querySelector('.toast-icon').textContent = 'ℹ️';
    }
    toastTimeout = setTimeout(() => { DOM.toastNotification.className = 'toast'; }, 4000);
  }

  // --- ANALYSE CACHE (IndexedDB, BlutbildDB.metadata) ────────────────────────

  // Fingerprints the raw scanned files (name + content), not the derived
  // groupedData shape. Deliberately independent of MEDICAL_ABBR/parsing
  // logic in blood-data.js: tweaking a reference range, splitting a marker
  // into absolute/percent variants, or adding a new recognized abbreviation
  // changes what computeGroupedData() produces for the *same* underlying
  // files — fingerprinting that derived shape would flag a cached analysis
  // as stale purely because our interpretation of the data changed, even
  // though the actual blood values didn't. Fingerprinting the source files
  // instead means "stale" only ever means "the underlying data changed".
  // Uses ocrText itself, not lastModified: that timestamp isn't preserved
  // through bulk-import.js's export/import (re-imported files get a fresh
  // Date.now() lastModified), so keying on it flagged re-imported analyses
  // as stale even when no blood values had actually changed.
  function computeDataFingerprint(files) {
    return files
      .filter(f => f.status === 'success')
      .map(f => `${f.name}:${f.ocrText || ''}`)
      .sort()
      .join('|');
  }

  async function saveAnalyseCache(context, result, origin) {
    try {
      const db = await initDB();
      const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').put({
        key: 'analyse',
        context,
        result,
        systemPrompt: DOM.analyseSystemPrompt.value,
        // Which provider/model produced this — lets restoreAnalyseUI() credit
        // the right one even after the user switches providers. Absent on
        // entries written before this existed; readers must tolerate that.
        providerId: origin?.providerId || '',
        providerLabel: origin?.providerLabel || '',
        modelId: origin?.modelId || '',
        modelLabel: origin?.modelLabel || '',
        fingerprint: computeDataFingerprint(state.files),
        timestamp: new Date().toISOString(),
      });
      return new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
    } catch (e) {
      console.warn('Could not save analyse cache:', e);
    }
  }

  // Persists only the system prompt, merging into the existing 'analyse'
  // record so a stored context/result survives — saveAnalyseCache() replaces
  // the whole record, this must not.
  async function saveSystemPrompt(systemPrompt) {
    try {
      const db = await initDB();
      const tx = db.transaction('metadata', 'readwrite');
      const store = tx.objectStore('metadata');
      const req = store.get('analyse');
      req.onsuccess = () => {
        store.put({ ...(req.result || { key: 'analyse' }), systemPrompt });
      };
      return new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
    } catch (e) {
      console.warn('Could not save system prompt:', e);
    }
  }

  let systemPromptSaveTimer = null;
  function scheduleSystemPromptSave() {
    clearTimeout(systemPromptSaveTimer);
    systemPromptSaveTimer = setTimeout(() => saveSystemPrompt(DOM.analyseSystemPrompt.value), 400);
  }

  // Empty field = default prompt, so clearing the textarea is the way back.
  function getSystemPromptTemplate() {
    return DOM.analyseSystemPrompt.value.trim() ? DOM.analyseSystemPrompt.value : DEFAULT_SYSTEM_PROMPT;
  }

  async function loadAnalyseCache() {
    try {
      const db = await initDB();
      const tx = db.transaction('metadata', 'readonly');
      const req = tx.objectStore('metadata').get('analyse');
      return new Promise((r, j) => {
        req.onsuccess = () => r(req.result || null);
        req.onerror = () => j(req.error);
      });
    } catch (e) {
      console.warn('Could not load analyse cache:', e);
      return null;
    }
  }

  function ensureAnalyseResultStructure() {
    let body = DOM.analyseResult.querySelector('.analyse-result-body');
    if (body) {
      DOM.analyseResultBody = body;
      DOM.analyseResultTitle = DOM.analyseResult.querySelector('.analyse-result-title');
      return body;
    }

    DOM.analyseResult.innerHTML = `
      <div class="analyse-result-toolbar">
        <span class="analyse-result-title" id="analyse-result-title">Analyse-Ergebnis</span>
        <button id="btn-analyse-share" class="analyse-result-share" type="button" title="Markdown-Inhalt in die Zwischenablage kopieren" aria-label="Markdown-Inhalt kopieren">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>
      <div class="analyse-result-body"></div>`;
    DOM.analyseResultShare = document.getElementById('btn-analyse-share');
    DOM.analyseResultShare.addEventListener('click', copyAnalyseMarkdown);
    DOM.analyseResultBody = DOM.analyseResult.querySelector('.analyse-result-body');
    DOM.analyseResultTitle = DOM.analyseResult.querySelector('.analyse-result-title');
    return DOM.analyseResultBody;
  }

  // Shown in the result toolbar so a restored cache entry still credits the
  // provider that actually produced it — which is generally *not* the one
  // selected in the dropdown after a later switch. Falls back to the bare
  // title for legacy cache entries written before providers existed.
  function setAnalyseResultTitle(originLabel) {
    ensureAnalyseResultStructure();
    if (!DOM.analyseResultTitle) return;
    DOM.analyseResultTitle.textContent = originLabel
      ? `Analyse-Ergebnis · ${originLabel}`
      : 'Analyse-Ergebnis';
  }

  function renderAnalyseResult(result, isStale = false, originLabel = '') {
    state.lastMarkdown = result || '';

    if (!result) {
      DOM.analyseResult.style.display = 'none';
      DOM.analyseResult.classList.remove('stale');
      ensureAnalyseResultStructure().innerHTML = '';
      setAnalyseResultTitle('');
      return;
    }

    ensureAnalyseResultStructure();
    DOM.analyseResult.style.display = 'flex';
    DOM.analyseResult.classList.toggle('stale', isStale);
    setAnalyseResultTitle(originLabel);

    const staleBannerHTML = isStale
      ? '<div class="analyse-stale-banner">⚠️ Diese Analyse basiert auf älteren Blutwerten – bitte neu analysieren.</div>'
      : '';
    DOM.analyseResultBody.innerHTML = `${staleBannerHTML}<div class="analyse-html-content">${markdownToHtml(result)}</div>`;
  }

  async function copyAnalyseMarkdown() {
    const markdown = state.lastMarkdown.trim();
    if (!markdown) {
      showToast('Noch kein Analyse-Text vorhanden.', 'info');
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
        showToast('Markdown-Inhalt in die Zwischenablage kopiert.', 'success');
        return;
      }
    } catch (err) {
      console.warn('Could not copy markdown analyse to clipboard:', err);
    }

    showToast('Kopieren in die Zwischenablage wurde nicht unterstützt.', 'error');
  }

  async function restoreAnalyseUI() {
    const cache = await loadAnalyseCache();
    DOM.analyseSystemPrompt.value = cache?.systemPrompt?.trim() ? cache.systemPrompt : DEFAULT_SYSTEM_PROMPT;
    if (!cache) return;
    if (cache.context) DOM.analyseContext.value = cache.context;
    if (cache.result) {
      const isStale = cache.fingerprint !== computeDataFingerprint(state.files);
      // Build the label from the stored fields rather than the live dropdown:
      // the analysis may well have been run under the other provider.
      const originLabel = cache.providerLabel
        ? [cache.providerLabel, cache.modelLabel].filter(Boolean).join(' · ')
        : '';
      renderAnalyseResult(cache.result, isStale, originLabel);
    }
  }

  // --- READ-ONLY ACCESS TO data.html's ZEITREIHEN DB (for the KI-Analyse
  // dataset picker below) — same origin, so directly reachable from here.
  // Mirrors data.html's/bulk-import.js's own minimal schema knowledge; see
  // bulk-import.js's file header for why this duplication is intentional.
  async function getTimeseriesRecord(key) {
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('medical-timeseries-v1', 1);
        req.onupgradeneeded = e => {
          if (!e.target.result.objectStoreNames.contains('store')) {
            e.target.result.createObjectStore('store', { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const record = await new Promise((resolve, reject) => {
        const req = db.transaction('store', 'readonly').objectStore('store').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return record;
    } catch (e) {
      console.warn('Zeitreihen-Datensatz konnte nicht gelesen werden:', key, e);
      return null;
    }
  }

  // --- KI-ANALYSE (provider-agnostic) ──────────────────────────────────────

  const SETTINGS_KEY_PROVIDER = 'befund-ai-provider';
  const settingsKeyModel = providerId => `befund-ai-model-${providerId}`;

  function currentProvider() {
    return PROVIDERS[state.providerId] || PROVIDERS.claude;
  }

  // Short label used in the result toolbar and the completion toast:
  // "DeepSeek · DeepSeek Flash (V4.1)".
  function originLabelFor(provider, model) {
    return [provider.shortLabel, model?.label].filter(Boolean).join(' · ');
  }

  function loadProviderId() {
    const saved = localStorage.getItem(SETTINGS_KEY_PROVIDER);
    return PROVIDERS[saved] ? saved : 'claude';
  }

  function loadModelId(provider) {
    const saved = localStorage.getItem(settingsKeyModel(provider.id));
    return provider.models.some(m => m.id === saved) ? saved : provider.models[0].id;
  }

  function currentModel(provider) {
    const id = DOM.aiModelSelect?.value;
    return provider.models.find(m => m.id === id) || provider.models[0];
  }

  // The single API-key input always holds the key of the *currently selected*
  // provider, so switching providers has to flush the old value first and
  // load the new one afterwards.
  function persistCurrentKey() {
    const provider = currentProvider();
    if (!DOM.apiKeyInput) return;
    localStorage.setItem(provider.storageKey, DOM.apiKeyInput.value.trim());
  }

  function updateAnalyseButtonState() {
    const hasKey = DOM.apiKeyInput?.value.trim().length > 0;
    DOM.btnAnalyse.disabled = !hasKey || Object.keys(state.groupedData).length === 0;
  }

  function applyProviderToControls() {
    const provider = currentProvider();

    if (DOM.aiProviderSelect) {
      // befund.html ships an empty <select> — fill it from PROVIDERS the first
      // time round, then just sync the selected value on later calls so a
      // provider switch doesn't rebuild (and reset) the list.
      if (DOM.aiProviderSelect.options.length === 0) {
        Object.values(PROVIDERS).forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.label;
          DOM.aiProviderSelect.appendChild(opt);
        });
      }
      DOM.aiProviderSelect.value = provider.id;
    }

    if (DOM.aiModelSelect) {
      DOM.aiModelSelect.innerHTML = '';
      provider.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        DOM.aiModelSelect.appendChild(opt);
      });
      DOM.aiModelSelect.value = loadModelId(provider);
    }

    if (DOM.apiKeyInput) {
      DOM.apiKeyInput.value = localStorage.getItem(provider.storageKey) || '';
      DOM.apiKeyInput.placeholder = `${provider.shortLabel}-API-Schlüssel`;
    }

    if (DOM.btnAnalyseLabel) {
      DOM.btnAnalyseLabel.textContent = `Mit ${provider.shortLabel} analysieren`;
    }

    updateAnalyseButtonState();
  }

  // Wires the selects that befund.html ships. Runs once; guarded via a dataset
  // flag so a re-entrant init() can't attach duplicate change listeners.
  function bindProviderControls() {
    if (!DOM.aiProviderSelect || DOM.aiProviderSelect.dataset.bound) return;
    DOM.aiProviderSelect.dataset.bound = 'true';

    DOM.aiProviderSelect.addEventListener('change', () => {
      // Persist *before* switching state.providerId — persistCurrentKey()
      // resolves the provider it is saving for via currentProvider().
      persistCurrentKey();
      state.providerId = DOM.aiProviderSelect.value;
      localStorage.setItem(SETTINGS_KEY_PROVIDER, state.providerId);
      applyProviderToControls();
    });

    DOM.aiModelSelect?.addEventListener('change', () => {
      localStorage.setItem(settingsKeyModel(currentProvider().id), DOM.aiModelSelect.value);
    });
  }

  const HTTP_ERROR_HINTS = {
    401: 'API-Schlüssel ungültig oder nicht übermittelt.',
    402: 'Guthaben beim Anbieter aufgebraucht.',
    429: 'Rate-Limit des Anbieters erreicht — bitte kurz warten.',
  };

  // DeepSeek answers a missing/invalid key with a *plain-text* body
  // ("Authentication Fails (governor)"), not the OpenAI-style
  // {"error":{"message":…}} JSON. Reading the body as text first and only then
  // attempting JSON.parse keeps that message visible instead of collapsing to
  // a generic "HTTP 401".
  async function describeHttpError(response) {
    let detail = '';
    try {
      const raw = (await response.text()).trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          detail = parsed.error?.message || parsed.message || raw;
        } catch {
          detail = raw; // plain-text body — see comment above
        }
      }
    } catch {
      // body unreadable — fall back to the status line below
    }

    if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;
    const hint = HTTP_ERROR_HINTS[response.status];
    return [hint, detail || `HTTP ${response.status}`].filter(Boolean).join(' ');
  }

  // Collects every dataset available for the KI-Analyse, each with a
  // human-readable count and a build() that produces its JSON payload —
  // only lazily called for whichever datasets the user actually keeps
  // checked in the selection modal below. Empty/absent datasets are left
  // out entirely rather than shown unchecked, so the modal never lists a
  // category with nothing to send.
  async function gatherAnalysisDatasets() {
    const datasets = [];

    const markerCount = Object.keys(state.groupedData).length;
    if (markerCount > 0) {
      const pointCount = Object.values(state.groupedData).reduce((n, pts) => n + pts.length, 0);
      datasets.push({
        key: 'blutbild',
        label: 'Blutbild (Blutwert-Zeitreihen)',
        countLabel: `${pointCount} Messwert(e), ${markerCount} Parameter`,
        build: () => {
          const p = {};
          Object.keys(state.groupedData).forEach(marker => {
            p[marker] = state.groupedData[marker].map(pt => ({ datum: pt.date, wert: pt.value }));
          });
          return p;
        },
      });
    }

    const bp = await getTimeseriesRecord('bp');
    if (bp && Array.isArray(bp.value) && bp.value.length > 0) {
      datasets.push({
        key: 'bp',
        label: 'Blutdruck',
        countLabel: `${bp.value.length} Messung(en)`,
        build: () => bp.value,
      });
    }

    const radiation = await getTimeseriesRecord('radiation');
    if (radiation && radiation.value && Object.keys(radiation.value).length > 0) {
      const n = Object.keys(radiation.value).length;
      datasets.push({
        key: 'radiation',
        label: 'Strahlenbelastung',
        countLabel: `${n} Eintrag/Einträge`,
        build: () => radiation.value,
      });
    }

    const events = await getTimeseriesRecord('events');
    if (events && Array.isArray(events.value) && events.value.length > 0) {
      datasets.push({
        key: 'events',
        label: 'Therapie-Ereignisse (Medikation)',
        countLabel: `${events.value.length} Ereignis(se)`,
        build: () => events.value,
      });
    }

    // Datasets contributed by modules (config-user.js → privateScripts):
    // each module's befund.datasets(getRecord) returns entries shaped like
    // the ones above. A failing module must not block the analysis.
    for (const mod of window.MediModules.with('befund')) {
      try {
        const extra = await mod.befund.datasets(getTimeseriesRecord);
        (extra || []).forEach(ds => datasets.push(ds));
      } catch (err) {
        console.warn(`Befund: Modul ${mod.id} fehlgeschlagen`, err);
      }
    }

    return datasets;
  }

  // Self-contained modal (mirrors the inline-styled dark-card modals already
  // used by bulk-import.js's import-preview/reset-confirm dialogs) — lets
  // the user pick which of the available datasets actually get sent to the
  // provider's API before anything leaves the device. Resolves with a Set of
  // selected keys, or null if cancelled.
  function renderAnalysisSelectionModal(datasets, providerLabel) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,8,15,0.75);display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

      const card = document.createElement('div');
      card.style.cssText = 'background:#141929;border:1px solid #2a3450;border-radius:12px;max-width:480px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);';

      const header = document.createElement('div');
      header.style.cssText = 'padding:1.25rem 1.5rem 0.75rem;border-bottom:1px solid #2a3450;';
      header.innerHTML = '<h2 style="margin:0;font-size:1.1rem;color:#e2e8f0;">Daten für KI-Analyse auswählen</h2>'
        + `<p style="margin:0.35rem 0 0;font-size:0.8rem;color:#64748b;">Nur die angehakten Daten werden an die ${escapeHTML(providerLabel)}-API gesendet.</p>`;

      const body = document.createElement('div');
      body.style.cssText = 'padding:0.5rem 1.5rem;overflow-y:auto;flex:1;';

      const checkboxes = datasets.map(ds => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:0.7rem;padding:0.55rem 0;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.style.cssText = 'width:16px;height:16px;accent-color:#3b82f6;flex-shrink:0;';
        const text = document.createElement('span');
        text.style.cssText = 'font-size:0.88rem;color:#e2e8f0;line-height:1.4;';
        text.innerHTML = `${escapeHTML(ds.label)}<br><span style="font-size:0.75rem;color:#64748b;">${escapeHTML(ds.countLabel)}</span>`;
        row.appendChild(cb);
        row.appendChild(text);
        body.appendChild(row);
        return { key: ds.key, cb };
      });

      const footer = document.createElement('div');
      footer.style.cssText = 'padding:1rem 1.5rem;display:flex;gap:0.6rem;justify-content:flex-end;border-top:1px solid #2a3450;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Abbrechen';
      cancelBtn.style.cssText = 'background:transparent;color:#94a3b8;border:1px solid #2a3450;border-radius:6px;padding:0.5rem 1rem;font-size:0.85rem;cursor:pointer;font-family:inherit;';
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = 'Analysieren';
      confirmBtn.style.cssText = 'background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:0.5rem 1.1rem;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit;';

      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);
      card.appendChild(header);
      card.appendChild(body);
      card.appendChild(footer);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      function finish(result) { overlay.remove(); resolve(result); }
      cancelBtn.addEventListener('click', () => finish(null));
      confirmBtn.addEventListener('click', () => {
        const selected = new Set(checkboxes.filter(c => c.cb.checked).map(c => c.key));
        if (selected.size === 0) { showToast('Bitte mindestens einen Datensatz auswählen.', 'error'); return; }
        finish(selected);
      });
      overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
    });
  }

  async function runAiAnalysis() {
    const provider = currentProvider();
    const model = currentModel(provider);

    const apiKey = DOM.apiKeyInput.value.trim();
    if (!apiKey) {
      showToast(`Bitte ${provider.shortLabel}-API-Schlüssel eingeben.`, 'error');
      return;
    }
    if (Object.keys(state.groupedData).length === 0) {
      showToast('Keine Blutwert-Zeitreihen vorhanden. Bitte erst OCR-Scan durchführen.', 'error');
      return;
    }

    const datasets = await gatherAnalysisDatasets();
    const selectedKeys = await renderAnalysisSelectionModal(datasets, provider.shortLabel);
    if (!selectedKeys) return; // cancelled — nothing sent

    const selectedDatasets = datasets.filter(ds => selectedKeys.has(ds.key));
    const payload = {};
    selectedDatasets.forEach(ds => { payload[ds.key] = ds.build(); });
    const datasetLabels = selectedDatasets.map(ds => ds.label).join(', ');

    const systemPrompt = getSystemPromptTemplate().split(SYSTEM_PROMPT_PLACEHOLDER).join(datasetLabels);

    const contextText = DOM.analyseContext.value.trim();
    const contextSection = contextText ? `\n\nPatientenkontext:\n${contextText}` : '';
    const userMessage = `${contextSection}\n\nHier sind die ausgewählten medizinischen Zeitreihendaten als JSON (${datasetLabels}):${JSON.stringify(payload, null, 2)}\n\nBitte erstelle einen ausführlichen medizinischen Befundbericht.`;

    DOM.analyseResult.style.display = 'flex';
    DOM.analyseResult.classList.remove('stale');
    const analyseBody = ensureAnalyseResultStructure();
    analyseBody.querySelector('.analyse-stale-banner')?.remove();
    DOM.analyseResult.classList.add('streaming');
    // Credit the running provider immediately, before the first token lands.
    setAnalyseResultTitle(originLabelFor(provider, model));
    DOM.btnAnalyse.disabled = true;

    let resultText = '';
    let reasoningText = '';
    let streaming = true;
    let renderScheduled = false;
    let reasoningSeen = false;

    // Waiting indicator until the first answer token: status line with
    // animated dots + elapsed seconds, and (Claude only) the live thinking
    // summary. Built once and updated via textContent — re-assigning
    // innerHTML on every thinking delta would restart the dot animation.
    analyseBody.innerHTML = `
      <div class="analyse-wait">
        <div class="analyse-wait-status"><span class="analyse-wait-label">Verbinde mit ${escapeHTML(provider.shortLabel)}</span><span class="analyse-dots" aria-hidden="true">......</span> <span class="analyse-wait-time"></span></div>
        <div class="analyse-wait-reasoning"></div>
      </div>`;
    const waitLabel = analyseBody.querySelector('.analyse-wait-label');
    const waitTime = analyseBody.querySelector('.analyse-wait-time');
    const waitReasoning = analyseBody.querySelector('.analyse-wait-reasoning');
    const startedAt = Date.now();
    const waitTimer = setInterval(() => {
      waitTime.textContent = `(${Math.round((Date.now() - startedAt) / 1000)} s)`;
    }, 1000);
    const stopWaitTimer = () => clearInterval(waitTimer);

    function scheduleStreamRender() {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        if (!streaming) return;
        if (!resultText) {
          waitLabel.textContent = reasoningSeen ? 'Modell denkt nach' : 'Analyse läuft';
          if (provider.showReasoningText && reasoningText) {
            // Only the tail — the summary can grow long, and the newest part
            // is what tells the user what the model is working on right now.
            waitReasoning.textContent = reasoningText.length > 600
              ? '… ' + reasoningText.slice(-600)
              : reasoningText;
          }
          return;
        }
        stopWaitTimer();
        analyseBody.innerHTML = `<div class="analyse-html-content">${markdownToHtml(resultText)}</div><span class="analyse-cursor"></span>`;
      });
    }

    try {
      const { headers, body } = provider.buildRequest({
        apiKey,
        model: model.id,
        systemPrompt,
        userMessage,
        maxTokens: model.maxTokens,
      });

      const response = await fetch(provider.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(await describeHttpError(response));
      }
      scheduleStreamRender(); // headers arrived: "Verbinde …" → "Analyse läuft"

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          // Tolerate both "data: {...}" and "data:{...}".
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;

          // OpenAI-compatible streams (DeepSeek) terminate with a literal
          // [DONE] sentinel that is not JSON. Without this check every
          // analysis would log a spurious "Malformed SSE frame" at the end.
          if (data === '[DONE]') { streamDone = true; break; }

          let event;
          try {
            event = JSON.parse(data);
          } catch {
            console.error(`Malformed SSE frame (${provider.id}):`, data);
            continue; // skip malformed SSE frames
          }

          // Both providers can signal a mid-stream failure as an error frame;
          // throwing here reaches the catch block below.
          if (event.error) {
            throw new Error(event.error.message || `Stream-Fehler (${provider.label})`);
          }

          const reasoning = provider.extractReasoning?.(event);
          if (reasoning) {
            reasoningSeen = true;
            reasoningText += reasoning;
            scheduleStreamRender();
          }

          const delta = provider.extractDelta(event);
          if (delta) {
            resultText += delta;
            scheduleStreamRender();
          }
        }
      }

      streaming = false;
      stopWaitTimer();
      DOM.analyseResult.classList.remove('streaming');
      if (!resultText.trim()) {
        throw new Error('Der Anbieter hat keine Antwort geliefert (leerer Stream).');
      }

      const origin = {
        providerId: provider.id,
        providerLabel: provider.shortLabel,
        modelId: model.id,
        modelLabel: model.label,
      };

      renderAnalyseResult(resultText, false, originLabelFor(provider, model));
      await saveAnalyseCache(contextText, resultText, origin);
      showToast(`KI-Analyse abgeschlossen (${provider.shortLabel}).`, 'success');

    } catch (err) {
      streaming = false;
      stopWaitTimer();
      DOM.analyseResult.classList.remove('streaming');
      console.error(`KI-Analyse fehlgeschlagen (${provider.id}):`, err);
      ensureAnalyseResultStructure();
      DOM.analyseResult.style.display = 'flex';
      DOM.analyseResultBody.innerHTML = `<span style="color: var(--danger);">Fehler bei der KI-Analyse: ${escapeHTML(err.message)}</span>`;
      showToast(`Analysefehler: ${err.message}`, 'error');
    } finally {
      updateAnalyseButtonState();
    }
  }

  // --- INIT ---

  DOM.btnAnalyse.addEventListener('click', runAiAnalysis);
  DOM.analyseResultShare.addEventListener('click', copyAnalyseMarkdown);
  DOM.analyseSystemPrompt.addEventListener('input', scheduleSystemPromptSave);
  DOM.apiKeyInput.addEventListener('input', () => {
    persistCurrentKey();
    updateAnalyseButtonState();
  });

  function init() {
    state.providerId = loadProviderId();
    bindProviderControls();
    applyProviderToControls();

    loadFilesFromStorage().then(files => {
      state.files = files;
      state.groupedData = computeGroupedData(files);
      updateAnalyseButtonState();
      restoreAnalyseUI();
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
