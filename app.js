// Blutbild via OCR — page logic of blutbild.html

(function () {
  'use strict';

  // Shared blood-marker data layer (marker dictionary, OCR-text-to-series
  // parsing, IndexedDB file store) — see blood-data.js, loaded before this
  // script. Also used standalone by radar.html and befund.html.
  const {
    loadFilesFromStorage, deleteFileFromStorage, clearStoredFiles,
    EVENTS, MEDICAL_ABBR, DERIVED_MARKERS, DERIVED_SPECS, calculateTravelRisk,
    extractDateFromFilename, parseMarkerLines, parsePdfBloodLines, computeGroupedData
  } = window.BloodData;

  // Skips files the user has deleted in the meantime: an OCR run, TXT/PDF
  // read or debounced text edit still in flight when ✕ was clicked would
  // otherwise write the record back (and lift its deletion marker).
  const saveFileToStorage = (file, ...args) =>
    file._deleted ? Promise.resolve() : window.BloodData.saveFileToStorage(file, ...args);

  // --- STATE MANAGEMENT ---
  const state = {
    allFiles: [],         // Array of parsed raw File objects
    filteredFiles: [],    // Array of files matching active name pattern & extension rules
    activeIndex: -1,      // Index of currently selected file in filteredFiles
    isScanning: false,    // Block updates and lock inputs when true
    directoryHandle: null, // References showDirectoryPicker handle (if available)
    chartInstances: {},   // Chart.js instances mapped by marker name
    groupedData: {},      // Last computed analytics data: marker -> [{date, value, filename, line}]
    isOnline: navigator.onLine, // Track online/offline status
  };

  function showOfflineNotification() {
    DOM.toastText.textContent = '🔴 Offline – begrenzte Funktionalität (nur gespeicherte Daten sichtbar)';
    DOM.toastNotification.classList.add('show');
    setTimeout(() => DOM.toastNotification.classList.remove('show'), 4500);
  }

  function showOnlineNotification() {
    DOM.toastText.textContent = '🟢 Zurück online – vollständige Funktionalität verfügbar';
    DOM.toastNotification.classList.add('show');
    setTimeout(() => DOM.toastNotification.classList.remove('show'), 3000);
  }

  function updateUIForOnlineStatus() {
    const disabled = !state.isOnline;
    DOM.btnSelectDir.disabled = disabled;
    DOM.btnRunOcr.disabled = disabled || Object.keys(state.groupedData).length === 0;

    // Update online/offline indicator
    const indicator = document.getElementById('online-status');
    if (indicator) {
      indicator.textContent = disabled ? '🔴' : '🟢';
      indicator.title = disabled ? 'Offline – nur gespeicherte Daten' : 'Online – volle Funktionalität';
    }
    document.getElementById('app-version').style.opacity = disabled ? '0.5' : '0.7';
  }

  // --- UI DOM ELEMENTS ---
  const DOM = {
    cdnStatusDot: document.getElementById('cdn-status-dot'),
    cdnStatusText: document.getElementById('cdn-status-text'),
    btnSelectDir: document.getElementById('btn-select-dir'),
    dirPickerFallback: document.getElementById('dir-picker-fallback'),
    dirMethodBadge: document.getElementById('dir-method-badge'),
    filterPattern: document.getElementById('filter-pattern'),
    regexMode: document.getElementById('regex-mode'),
    languageSelect: document.getElementById('language-select'),
    btnRunOcr: document.getElementById('btn-run-ocr'),
    overallProgressPanel: document.getElementById('overall-progress-panel'),
    scanStatusText: document.getElementById('scan-status-text'),
    scanStatusPct: document.getElementById('scan-status-pct'),
    scanProgressBar: document.getElementById('scan-progress-bar'),
    statTotal: document.getElementById('stat-total'),
    statMatching: document.getElementById('stat-matching'),
    statScanned: document.getElementById('stat-scanned'),
    btnClear: document.getElementById('btn-clear'),
    fileListContainer: document.getElementById('file-list-container'),
    sidebarEmptyState: document.getElementById('sidebar-empty-state'),
    viewerHeader: document.getElementById('viewer-header'),
    activeFileName: document.getElementById('active-file-name'),
    activeFilePath: document.getElementById('active-file-path'),
    btnCopyText: document.getElementById('btn-copy-text'),
    btnDownloadText: document.getElementById('btn-download-text'),
    mainPreviewImg: document.getElementById('main-preview-img'),
    viewerEmptyState: document.getElementById('viewer-empty-state'),
    searchResultsInput: document.getElementById('search-results-input'),
    ocrResultsContent: document.getElementById('ocr-results-content'),
    toastNotification: document.getElementById('toast-notification'),
    toastText: document.getElementById('toast-text'),
    chartsContainer: document.getElementById('charts-container'),
    chartsEmptyState: document.getElementById('charts-empty-state'),
    btnAddImage: document.getElementById('btn-add-image'),
    btnAddTxt: document.getElementById('btn-add-txt'),
    btnAddPdf: document.getElementById('btn-add-pdf'),
    imageInput: document.getElementById('image-input'),
    txtInput: document.getElementById('txt-input'),
    pdfInput: document.getElementById('pdf-input'),
    cropCanvas: document.getElementById('crop-canvas'),
    cropToolbar: document.getElementById('crop-toolbar'),
    btnScanFull: document.getElementById('btn-scan-full'),
    btnCropScan: document.getElementById('btn-crop-scan'),
    btnCropReset: document.getElementById('btn-crop-reset'),
    ocrCorrections: document.getElementById('ocr-corrections')
  };

  // Mutable crop state (reset each time a new image is shown)
  const cropState = { dragging: false, startX: 0, startY: 0, endX: 0, endY: 0, hasSelection: false };

  // --- SYSTEM INITIALIZATION ---
  function init() {
    checkCDNStatus();
    setupEventListeners();
    checkDirectoryPickerSupport();
    setupAbbrTooltip();

    // Offline support
    state.isOnline = navigator.onLine;
    updateUIForOnlineStatus();
    window.addEventListener('online', () => {
      state.isOnline = true;
      updateUIForOnlineStatus();
      showOnlineNotification();
    });
    window.addEventListener('offline', () => {
      state.isOnline = false;
      updateUIForOnlineStatus();
      showOfflineNotification();
    });

    // Restore previously scanned data from storage. The therapy events
    // (vertical markers in the trend charts) come from data.html's
    // Zeitreihen and are loaded alongside, before the first chart render.
    Promise.all([loadFilesFromStorage(), window.BloodData.loadEvents()]).then(([storedFiles]) => {
      if (storedFiles.length > 0) {
        state.allFiles = storedFiles.map(f => ({
          name: f.name,
          webkitRelativePath: f.path,
          lastModified: f.lastModified,
          ocrText: f.ocrText,
          status: f.status,
          size: 0,
        }));
        DOM.statTotal.textContent = state.allFiles.length;
        applyFilter();
        DOM.statScanned.textContent = state.filteredFiles.filter(f => f.status === 'success').length;
        updateAnalytics();
        if (!state.isOnline) {
          showToast('📂 Letzte Scans wiederhergestellt (Offline-Modus)');
        }
      }
    });
  }

  function setupAbbrTooltip() {
    const tip = document.getElementById('abbr-tooltip');
    document.addEventListener('mouseover', e => {
      const el = e.target.closest('[data-tooltip]');
      if (!el) return;
      tip.textContent = el.dataset.tooltip;
      tip.style.display = 'block';
    });
    document.addEventListener('mouseout', e => {
      if (!e.target.closest('[data-tooltip]')) return;
      tip.style.display = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (tip.style.display === 'none') return;
      const gap = 12;
      let x = e.clientX + gap;
      let y = e.clientY + gap;
      if (x + 240 > window.innerWidth) x = e.clientX - 240 - gap;
      if (y + tip.offsetHeight > window.innerHeight) y = e.clientY - tip.offsetHeight - gap;
      tip.style.left = x + 'px';
      tip.style.top  = y + 'px';
    });
  }

  // Check if PaddleOCR is loaded from CDN
  function checkCDNStatus() {
    // PaddleOCR will be loaded dynamically in runOCRScanner, so we can't check it here
    // Set a provisional status that will be updated when OCR is actually run
    DOM.cdnStatusDot.style.backgroundColor = 'var(--warning)';
    DOM.cdnStatusDot.style.boxShadow = '0 0 8px var(--warning)';
    DOM.cdnStatusText.textContent = 'PaddleOCR Ready (loading dependencies...)';
    DOM.cdnStatusText.style.color = '#fbbf24';
    
    const setReady = () => {
      DOM.cdnStatusDot.style.backgroundColor = 'var(--success)';
      DOM.cdnStatusDot.style.boxShadow = '0 0 8px var(--success)';
      DOM.cdnStatusText.textContent = 'PaddleOCR Ready';
      DOM.cdnStatusText.style.color = '#34d399';
    };

    // Wait for OpenCV to load and update status
    if (typeof window.waitForOpenCV === 'function') {
      const loader = createOpenCVLoader();
      window.waitForOpenCV().then(() => {
        setReady();
        loader.done();
      }).catch(err => {
        // OpenCV.js failed to load (offline, CDN unreachable, blocked by an
        // extension, ...). Surface it in the status badge instead of leaving
        // an unhandled promise rejection — OCR will still show its own clear
        // error ("OpenCV.js failed to load...") once actually attempted.
        DOM.cdnStatusDot.style.backgroundColor = 'var(--danger)';
        DOM.cdnStatusDot.style.boxShadow = '0 0 8px var(--danger)';
        DOM.cdnStatusText.textContent = 'OpenCV.js nicht verfügbar (offline?)';
        DOM.cdnStatusText.style.color = '#f87171';
        console.warn('OpenCV.js failed to load:', err.message);
        loader.fail();
        // A timeout isn't final: OpenCV may still finish afterwards (slow
        // network, or paused in the debugger past the 30 s limit).
        window.addEventListener('opencv-ready', () => {
          setReady();
          loader.done();
        }, { once: true });
      });
    }
  }

  // Popup while OpenCV.js (~8 MB, WASM compile) is still initialising.
  // Appears only after a short delay, so a fast start from cache doesn't
  // flash it, and counts up to the same 30 s limit as waitForOpenCV().
  // Errors only replace an already visible popup: an immediate failure
  // (offline, blocked) is reported by the status badge alone.
  function createOpenCVLoader() {
    const LIMIT_S = 30;
    const SHOW_DELAY_MS = 1500;
    const el = document.getElementById('opencv-loader');
    if (!el) return { done() {}, fail() {} };

    const icon = document.getElementById('opencv-loader-icon');
    const text = document.getElementById('opencv-loader-text');
    const fill = document.getElementById('opencv-loader-fill');
    const start = Date.now();
    let tickTimer = null;
    let hideTimer = null;
    let visible = false;

    const hide = () => {
      clearInterval(tickTimer);
      clearTimeout(hideTimer);
      el.classList.remove('show');
      visible = false;
    };

    const tick = () => {
      const s = Math.min(LIMIT_S, Math.round((Date.now() - start) / 1000));
      text.textContent = `OpenCV.js wird geladen … ${s} s (max. ${LIMIT_S} s)`;
      fill.style.width = `${(100 * s) / LIMIT_S}%`;
    };

    const showTimer = setTimeout(() => {
      visible = true;
      el.className = 'toast opencv-loader show';
      icon.textContent = '⏳';
      tick();
      tickTimer = setInterval(tick, 1000);
    }, SHOW_DELAY_MS);

    document.getElementById('opencv-loader-close').addEventListener('click', () => {
      clearTimeout(showTimer);
      hide();
    });

    return {
      done() {
        clearTimeout(showTimer);
        if (!visible) return;
        clearInterval(tickTimer);
        el.className = 'toast opencv-loader toast-success show';
        icon.textContent = '✓';
        text.textContent = 'OpenCV.js bereit';
        fill.style.width = '100%';
        hideTimer = setTimeout(hide, 2000);
      },
      fail() {
        clearTimeout(showTimer);
        if (!visible) return;
        clearInterval(tickTimer);
        el.className = 'toast opencv-loader toast-error show';
        icon.textContent = '✕';
        text.textContent = `OpenCV.js nach ${LIMIT_S} s nicht bereit – OCR von Bildern vorerst nicht möglich. Seite neu laden oder weiter warten.`;
      }
    };
  }

  // Detect Directory Picker support
  function checkDirectoryPickerSupport() {
    const isSupported = typeof window.showDirectoryPicker === 'function';
    if (isSupported) {
      DOM.dirMethodBadge.textContent = '⚡ File System Access API supported';
      DOM.dirMethodBadge.style.color = '#60a5fa';
    } else {
      DOM.dirMethodBadge.textContent = '🗂️ Input WebkitDirectory Fallback';
      DOM.dirMethodBadge.style.color = '#fbbf24';
    }
  }

  // Setup UI Listeners
  function setupEventListeners() {
    // Vor dem Drucken: alle Chart.js-Instanzen auf die Print-Containergröße skalieren,
    // damit der Canvas korrekt gerendert wird und nicht über den Container überläuft.
    window.addEventListener('beforeprint', () => {
      Object.values(state.chartInstances).forEach(chart => chart.resize());
    });
    window.addEventListener('afterprint', () => {
      Object.values(state.chartInstances).forEach(chart => chart.resize());
    });

    // Select directory trigger
    DOM.btnSelectDir.addEventListener('click', handleSelectDirectoryClick);
    DOM.dirPickerFallback.addEventListener('change', handleFallbackFileSelection);

    // Filters inputs
    DOM.filterPattern.addEventListener('input', debounce(applyFilter, 250));
    DOM.regexMode.addEventListener('change', applyFilter);

    // Neue Daten via Kamera / Bilddatei
    DOM.btnAddImage.addEventListener('click', () => DOM.imageInput.click());
    DOM.imageInput.addEventListener('change', handleCameraCapture);

    // TXT-Daten importieren
    DOM.btnAddTxt.addEventListener('click', () => DOM.txtInput.click());
    DOM.txtInput.addEventListener('change', handleTxtImport);

    // PDF-Laborberichte importieren
    DOM.btnAddPdf.addEventListener('click', () => DOM.pdfInput.click());
    DOM.pdfInput.addEventListener('change', handlePdfImport);

    // Crop-Ausschnitt Buttons
    DOM.btnScanFull.addEventListener('click', runFullScanFromCrop);
    DOM.btnCropScan.addEventListener('click', runCropOcr);
    DOM.btnCropReset.addEventListener('click', resetCrop);
    setupCropEvents();

    // Action Buttons
    DOM.btnRunOcr.addEventListener('click', runOCRScanner);
    DOM.btnClear.addEventListener('click', clearWorkspace);
    DOM.btnCopyText.addEventListener('click', copyActiveOcrText);
    DOM.btnDownloadText.addEventListener('click', downloadActiveOcrText);

    // Live search highlighter
    DOM.searchResultsInput.addEventListener('input', highlightOcrTextSearch);

    // Live OCR text editor listeners
    DOM.ocrResultsContent.addEventListener('input', handleOcrTextInput);
    DOM.ocrResultsContent.addEventListener('focus', handleOcrTextFocus);

    // Blutbild (alle Daten) als JSON exportieren/importieren — Menüpunkte im hbm-page-slot
    document.getElementById('btn-blutbild-json-export').addEventListener('click', exportBlutbildJSON);
    document.getElementById('btn-blutbild-json-import').addEventListener('click', () => {
      document.getElementById('blutbild-json-import-input').click();
    });
    document.getElementById('blutbild-json-import-input').addEventListener('change', e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) importBlutbildJSON(file);
    });
  }

  // --- FILE DIRECTORY READERS ---

  async function handleSelectDirectoryClick() {
    if (state.isScanning) return;

    if (typeof window.showDirectoryPicker === 'function') {
      try {
        state.directoryHandle = await window.showDirectoryPicker();
        showToast('Scanning directory, please wait...', 'info');
        clearStateData();

        const fileItems = [];
        for await (const entry of getFilesRecursively(state.directoryHandle)) {
          fileItems.push(entry);
        }

        state.allFiles = fileItems;
        processLoadedFiles();
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err);
          showToast(`Error reading directory: ${err.message}`, 'error');
        }
      }
    } else {
      // Fallback
      DOM.dirPickerFallback.click();
    }
  }

  // Recursive Directory Picker parser (Async Generator)
  async function* getFilesRecursively(dirHandle, path = '') {
    for await (const entry of dirHandle.values()) {
      const relativePath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === 'file') {
        const file = await entry.getFile();
        // Attaching relative path for visual layout consistency
        file.relativePath = relativePath;
        yield file;
      } else if (entry.kind === 'directory') {
        yield* getFilesRecursively(entry, relativePath);
      }
    }
  }

  // Fallback Directory Input selector
  function handleFallbackFileSelection(e) {
    if (state.isScanning) return;
    const selectedFiles = Array.from(e.target.files);
    
    if (selectedFiles.length === 0) return;

    showToast('Parsing selected files...', 'info');
    clearStateData();

    state.allFiles = selectedFiles.map(file => {
      // Input webkitRelativePath contains directory names
      file.relativePath = file.webkitRelativePath || file.name;
      return file;
    });

    processLoadedFiles();
  }

  // Clear memory links & internal cache
  function clearStateData() {
    state.filteredFiles.forEach(fileObj => {
      if (fileObj.thumbnail) {
        URL.revokeObjectURL(fileObj.thumbnail);
      }
    });
    state.allFiles = [];
    state.filteredFiles = [];
    state.activeIndex = -1;
    state.directoryHandle = null;
    DOM.dirPickerFallback.value = '';

    // Clear offline storage (both file store and analyse cache — the latter
    // is now only rendered on befund.html, but still lives in the same DB).
    clearStoredFiles().catch(() => {});

    updateViewerPanel();
  }

  // Loads the pdf-parse ESM build from jsDelivr (same lazy CDN-import pattern
  // as PaddleOCR below) and points its worker at the matching browser build.
  async function loadPdfParseModule() {
    const pdfParseMod = await import('https://cdn.jsdelivr.net/npm/pdf-parse@2.4.5/dist/pdf-parse/web/pdf-parse.es.js');
    const PDFParseCtor = pdfParseMod.PDFParse;
    if (!PDFParseCtor) throw new Error('pdf-parse module not found in CDN package');
    PDFParseCtor.setWorker('https://cdn.jsdelivr.net/npm/pdf-parse@2.4.5/dist/pdf-parse/web/pdf.worker.min.mjs');
    return PDFParseCtor;
  }

  // Parses a single PDF file into Blutwert lines and updates fileObj/storage
  // in place. Shared between the immediate auto-read (see autoReadPdfFiles)
  // and the "Run OCR Scanner" re-scan path (runOCRScanner).
  async function parseSinglePdfFile(fileObj, PDFParseCtor) {
    const expectedDate = extractDateFromFilename(fileObj.name);
    const buf = await fileObj.file.arrayBuffer();
    const parser = new PDFParseCtor({ data: new Uint8Array(buf) });
    let pdfText;
    try {
      const result = await parser.getText();
      pdfText = result.text;
    } finally {
      await parser.destroy();
    }

    const { entries, mismatches } = parsePdfBloodLines(pdfText, expectedDate);

    if (mismatches.length > 0) {
      const detail = mismatches.map(m => `${m.key}: Messdatum ${m.measureDate} ≠ Dateiname ${m.expectedDate}`).join('; ');
      console.error(`Messdatum-Abweichung in ${fileObj.name}: ${detail}`);
      showToast(`⚠️ ${fileObj.name}: Messdatum weicht vom Dateinamen ab (${mismatches.length} Zeile(n) übersprungen)`, 'error');
    }

    if (entries.length > 0) {
      const text = entries.map(en => `${en.key} ${en.value}`).join('\n');
      fileObj.ocrText = text;
      fileObj.status = 'success';
      fileObj.progress = 100;
      saveFileToStorage(fileObj.file, text, 'success');
    } else {
      fileObj.status = 'error';
      fileObj.errorMsg = mismatches.length > 0
        ? 'Alle erkannten Blutwerte hatten ein abweichendes Messdatum.'
        : 'Keine erkennbaren Blutwerte im PDF gefunden.';
      saveFileToStorage(fileObj.file, '', 'error').catch(() => {});
    }
  }

  // Parses newly-added PDF files immediately (no OCR needed), mirroring
  // autoReadTextFiles' immediate-read behavior for TXT files below.
  async function autoReadPdfFiles() {
    const pending = state.filteredFiles.filter(
      f => /\.pdf$/i.test(f.name) && f.file instanceof Blob && f.status === 'pending'
    );
    if (pending.length === 0) return;

    let PDFParseCtor;
    try {
      PDFParseCtor = await loadPdfParseModule();
    } catch (err) {
      console.error('Failed to load pdf-parse module:', err);
      pending.forEach(fileObj => {
        fileObj.status = 'error';
        fileObj.errorMsg = 'PDF-Parser konnte nicht geladen werden.';
        updateItemStatusInDOM(fileObj);
      });
      showToast('PDF-Parser konnte nicht geladen werden.', 'error');
      return;
    }

    for (const fileObj of pending) {
      try {
        await parseSinglePdfFile(fileObj, PDFParseCtor);
      } catch (err) {
        console.error(`PDF processing error on file ${fileObj.name}:`, err);
        fileObj.status = 'error';
        fileObj.errorMsg = err.message || 'PDF-Verarbeitung fehlgeschlagen';
      }
      updateItemStatusInDOM(fileObj);
    }

    DOM.statScanned.textContent = state.filteredFiles.filter(f => f.status === 'success').length;
    if (state.activeIndex >= 0) updateViewerPanel();
    updateAnalytics();
  }

  // Automatically read TXT files without requiring the OCR scanner button.
  // Called after applyFilter() whenever new files are loaded.
  async function autoReadTextFiles() {
    const pending = state.filteredFiles.filter(
      f => /\.txt$/i.test(f.name) && f.file instanceof Blob && f.status === 'pending'
    );
    if (pending.length === 0) return;

    for (const fileObj of pending) {
      try {
        const raw = await fileObj.file.text();
        const text = normalizeTxtFormat(raw);
        fileObj.ocrText = text;
        fileObj.status = 'success';
        fileObj.progress = 100;
        saveFileToStorage(fileObj.file, text, 'success');
      } catch (err) {
        console.error(`Auto-read error for ${fileObj.name}:`, err);
        fileObj.status = 'error';
        fileObj.errorMsg = err.message || 'Text-Datei lesen fehlgeschlagen';
      }
      updateItemStatusInDOM(fileObj);
    }

    DOM.statScanned.textContent = state.filteredFiles.filter(f => f.status === 'success').length;
    if (state.activeIndex >= 0) updateViewerPanel();
    updateAnalytics();
  }

  // Trigger filters and initial gallery generation after directories load
  function processLoadedFiles() {
    DOM.statTotal.textContent = state.allFiles.length;
    applyFilter();
    DOM.btnClear.disabled = false;
    showToast(`Successfully parsed ${state.allFiles.length} files.`, 'success');
    autoReadTextFiles();
    autoReadPdfFiles();
  }

  // --- PATTERN FILTER & IMAGE SANITATION ---

  function applyFilter() {
    if (state.allFiles.length === 0) return;

    const patternText = DOM.filterPattern.value.trim() || '*';
    const isRegex = DOM.regexMode.checked;
    let matchRegex;

    try {
      if (isRegex) {
        matchRegex = new RegExp(patternText, 'i');
        DOM.filterPattern.style.borderColor = 'var(--border-color)';
      } else {
        // Convert Wildcard to regular expression
        // Escape special chars except * and ?
        const escaped = patternText
          .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape all regex chars
          .replace(/\*/g, '.*')                 // convert * to .*
          .replace(/\?/g, '.');                 // convert ? to .
        matchRegex = new RegExp(`^${escaped}$`, 'i');
        DOM.filterPattern.style.borderColor = 'var(--border-color)';
      }
    } catch (err) {
      // Mark filter border as red to show broken regex
      DOM.filterPattern.style.borderColor = 'var(--danger)';
      showToast('Warning: Invalid regular expression pattern', 'error');
      return;
    }

    // Supported formats: images (OCR), plain text (direct read), PDF (parsed for blood values)
    const supportedExtensions = /\.(png|jpg|jpeg|webp|bmp|tiff|gif|txt|pdf)$/i;
    const imageExtensions = /\.(png|jpg|jpeg|webp|bmp|tiff|gif)$/i;

    // Release old URLs
    state.filteredFiles.forEach(fileObj => {
      if (fileObj.thumbnail) {
        URL.revokeObjectURL(fileObj.thumbnail);
      }
    });

    let candidates = state.allFiles
      .filter(file => {
        const isSupported = supportedExtensions.test(file.name);
        const matchesPattern = matchRegex.test(file.name);
        return isSupported && matchesPattern;
      })
      .map((file, idx) => {
        const isImage = imageExtensions.test(file.name);
        return {
          id: idx,
          file: file,
          name: file.name,
          relativePath: file.relativePath || file.name,
          sizeFormatted: formatBytes(file.size),
          thumbnail: (isImage && file instanceof Blob) ? URL.createObjectURL(file) : null,
          status: file.status || 'pending',    // preserve status restored from IndexedDB
          progress: 0,
          ocrText: file.ocrText || null,       // preserve ocrText restored from IndexedDB
          errorMsg: null
        };
      });

    // If a TXT and an image share the same date prefix, prefer the TXT (skip OCR)
    const datesWithTxt = new Set(
      candidates
        .filter(f => /\.txt$/i.test(f.name))
        .map(f => extractDateFromFilename(f.name))
        .filter(Boolean)
    );
    if (datesWithTxt.size > 0) {
      candidates = candidates.filter(f => {
        if (/\.txt$/i.test(f.name)) return true;
        const date = extractDateFromFilename(f.name);
        if (date && datesWithTxt.has(date)) {
          if (f.thumbnail) URL.revokeObjectURL(f.thumbnail); // free blob URL
          return false;
        }
        return true;
      });
      candidates.forEach((f, i) => { f.id = i; }); // re-index after removal
    }

    // Sort by date prefix descending (newest first)
    candidates.sort((a, b) => {
      const da = extractDateFromFilename(a.name) || '';
      const db = extractDateFromFilename(b.name) || '';
      return db.localeCompare(da);
    });
    candidates.forEach((f, i) => { f.id = i; });

    state.filteredFiles = candidates;
    state.activeIndex = state.filteredFiles.length > 0 ? 0 : -1;
    
    // Update stats UI
    DOM.statMatching.textContent = state.filteredFiles.length;
    DOM.statScanned.textContent = state.filteredFiles.filter(f => f.status === 'success').length;

    DOM.btnRunOcr.disabled = state.filteredFiles.length === 0;

    renderGallery();
    updateViewerPanel();
    autoReadTextFiles(); // read any newly visible TXT files immediately
  }

  // --- GALLERY RENDERER ---

  // Images that applyFilter() hides behind a TXT of the same date (the TXT
  // replaces their OCR). They have to go along with that TXT — otherwise the
  // hidden image takes its place again on the next reload.
  function hiddenCompanions(fileObj) {
    if (!/\.txt$/i.test(fileObj.name)) return [];
    const date = extractDateFromFilename(fileObj.name);
    if (!date) return [];
    const sameDate = state.allFiles.filter(f => f.name !== fileObj.name && extractDateFromFilename(f.name) === date);
    if (sameDate.some(f => /\.txt$/i.test(f.name))) return []; // still hidden behind another TXT
    return sameDate.filter(f => /\.(png|jpg|jpeg|webp|bmp|tiff|gif)$/i.test(f.name));
  }

  function deleteFile(idx) {
    const fileObj = state.filteredFiles[idx];
    if (!fileObj) return;

    const companions = hiddenCompanions(fileObj);
    const names = new Set([fileObj.name, ...companions.map(f => f.name)]);
    let question = `„${fileObj.name}“ löschen?`;
    if (companions.length) {
      question += `\n\nMit gelöscht wird das ausgeblendete Original vom selben Datum:\n${companions.map(f => '• ' + f.name).join('\n')}`;
    }
    question += '\n\nDie Löschung wird beim nächsten Daten-Export mitgenommen, damit ein ZIP-Import die Datei nicht zurückbringt.';
    if (!confirm(question)) return;

    names.forEach(name => deleteFileFromStorage(name).catch(() => {}));
    state.allFiles = state.allFiles.filter(f => {
      if (!names.has(f.name)) return true;
      f._deleted = true;
      return false;
    });

    const active = state.filteredFiles[state.activeIndex];
    state.filteredFiles = state.filteredFiles.filter(f => {
      if (!names.has(f.name)) return true;
      if (f.thumbnail) URL.revokeObjectURL(f.thumbnail);
      return false;
    });
    state.filteredFiles.forEach((f, i) => { f.id = i; });
    const activeIdx = state.filteredFiles.indexOf(active);
    state.activeIndex = activeIdx >= 0 ? activeIdx : Math.min(idx, state.filteredFiles.length - 1);

    DOM.statTotal.textContent = state.allFiles.length;
    DOM.statMatching.textContent = state.filteredFiles.length;
    DOM.statScanned.textContent = state.filteredFiles.filter(f => f.status === 'success').length;

    renderGallery();
    updateViewerPanel();
    updateAnalytics();
  }

  function renderGallery() {
    DOM.fileListContainer.innerHTML = '';

    if (state.filteredFiles.length === 0) {
      DOM.sidebarEmptyState.style.display = 'flex';
      DOM.sidebarEmptyState.querySelector('h3').textContent = 'No Matches Found';
      DOM.sidebarEmptyState.querySelector('p').textContent = 'Adjust pattern filters or extensions rules';
      return;
    }

    DOM.sidebarEmptyState.style.display = 'none';

    state.filteredFiles.forEach((fileObj, idx) => {
      const fileItem = document.createElement('div');
      fileItem.className = `file-item ${idx === state.activeIndex ? 'active' : ''}`;
      fileItem.setAttribute('data-id', fileObj.id);

      // Create inner details HTML
      fileItem.innerHTML = `
        ${fileObj.thumbnail ? `<img class="thumb-preview" src="${fileObj.thumbnail}" alt="Thumbnail preview" loading="lazy">` : '<div class="thumb-preview thumb-placeholder"></div>'}
        <div class="file-details">
          <span class="file-name" title="${fileObj.name}">${fileObj.name}</span>
          <span class="file-size">${fileObj.sizeFormatted}</span>
        </div>
        <div class="status-badge status-${fileObj.status}" title="Status: ${fileObj.status}"></div>
        <button class="btn-delete-file" title="Eintrag löschen" aria-label="Eintrag löschen">✕</button>
      `;

      fileItem.querySelector('.btn-delete-file').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFile(idx);
      });

      fileItem.addEventListener('click', () => {
        if (state.activeIndex === idx) return;
        state.activeIndex = idx;

        // Update active class state
        const activeItem = DOM.fileListContainer.querySelector('.file-item.active');
        if (activeItem) activeItem.classList.remove('active');
        fileItem.classList.add('active');

        updateViewerPanel();
      });

      DOM.fileListContainer.appendChild(fileItem);
    });
  }

  // --- RESULTS VIEWER UPDATER ---

  function updateViewerPanel() {
    const activeFile = state.filteredFiles[state.activeIndex];

    if (!activeFile) {
      // Empty state
      DOM.viewerHeader.style.visibility = 'hidden';
      DOM.mainPreviewImg.style.display = 'none';
      DOM.viewerEmptyState.style.display = 'flex';
      DOM.ocrResultsContent.textContent = 'Select an image to see its scanned text.';
      DOM.ocrResultsContent.contentEditable = "false";
      DOM.searchResultsInput.disabled = true;
      DOM.searchResultsInput.value = '';
      DOM.cropCanvas.style.display = 'none';
      DOM.cropToolbar.style.display = 'none';
      DOM.ocrCorrections.style.display = 'none';
      return;
    }

    // Loaded state
    DOM.viewerHeader.style.visibility = 'visible';
    DOM.viewerEmptyState.style.display = 'none';
    DOM.mainPreviewImg.src = activeFile.thumbnail || '';
    DOM.mainPreviewImg.style.display = activeFile.thumbnail ? 'block' : 'none';

    // Init crop overlay once the image element is laid out.
    // Show for 'pending' (pre-scan crop) and 'success' (re-scan crop).
    if (activeFile.thumbnail && (activeFile.status === 'success' || activeFile.status === 'pending')) {
      const doInit = () => initCropCanvas();
      if (DOM.mainPreviewImg.complete && DOM.mainPreviewImg.naturalWidth) {
        doInit();
      } else {
        DOM.mainPreviewImg.onload = doInit;
      }
    } else {
      DOM.cropCanvas.style.display = 'none';
      DOM.cropToolbar.style.display = 'none';
    }

    DOM.activeFileName.textContent = activeFile.name;
    DOM.activeFilePath.textContent = activeFile.relativePath;

    DOM.searchResultsInput.value = '';
    DOM.ocrCorrections.style.display = 'none';

    // Render result according to status
    if (activeFile.status === 'pending') {
      const isTxt = /\.txt$/i.test(activeFile.name);
      DOM.ocrResultsContent.innerHTML = `<span style="color: var(--text-muted); font-style: italic;">${isTxt ? 'Text ausstehend.' : 'Pending Scan.'} Klicke auf 'Run OCR Scanner' um ${isTxt ? 'den Text einzulesen.' : 'OCR durchzuführen.'}</span>`;
      DOM.ocrResultsContent.contentEditable = "false";
      DOM.searchResultsInput.disabled = true;
    } else if (activeFile.status === 'scanning') {
      const isTxt = /\.txt$/i.test(activeFile.name);
      DOM.ocrResultsContent.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; padding: 2rem 0; color: var(--warning);">
          <div class="status-badge status-scanning" style="width: 40px; height: 40px; font-size: 1.5rem;"></div>
          <span>${isTxt ? 'Text wird eingelesen…' : `Scanning Image: ${activeFile.progress}% complete…`}</span>
        </div>
      `;
      DOM.ocrResultsContent.contentEditable = "false";
      DOM.searchResultsInput.disabled = true;
    } else if (activeFile.status === 'error') {
      DOM.ocrResultsContent.innerHTML = `<span style="color: var(--danger); font-weight: 500;">OCR Failed: ${activeFile.errorMsg || 'Unknown scanner error'}</span>`;
      DOM.ocrResultsContent.contentEditable = "false";
      DOM.searchResultsInput.disabled = true;
    } else if (activeFile.status === 'success') {
      const isTxt = /\.txt$/i.test(activeFile.name);
      DOM.ocrResultsContent.textContent = activeFile.ocrText || (isTxt ? '(Datei ist leer)' : '(No text could be extracted from this image)');
      DOM.ocrResultsContent.contentEditable = "true";
      DOM.searchResultsInput.disabled = false;
      const corr = activeFile.corrections;
      if (corr && corr.length > 0) {
        DOM.ocrCorrections.style.display = 'block';
        DOM.ocrCorrections.innerHTML =
          `<span class="ocr-corr-label">OCR-Korrekturen (${corr.length}):</span> ` +
          corr.map(c => `<code>${escapeHTML(c.from)}</code>&nbsp;→&nbsp;<code>${escapeHTML(c.to)}</code>`).join(' &nbsp;·&nbsp; ');
      }
    }
  }

  // --- LIVE TEXT SEARCH HIGHLIGHTER ---

  function highlightOcrTextSearch() {
    const activeFile = state.filteredFiles[state.activeIndex];
    if (!activeFile || activeFile.status !== 'success') return;

    const searchTerm = DOM.searchResultsInput.value;
    if (!searchTerm) {
      DOM.ocrResultsContent.textContent = activeFile.ocrText || '(No text)';
      return;
    }

    // Escape search term characters for RegExp safety
    const escapedSearch = searchTerm.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const matchRegex = new RegExp(`(${escapedSearch})`, 'gi');

    // Replace matches with html mark wrapper (escaping text first to prevent HTML injection)
    const escapedText = escapeHTML(activeFile.ocrText || '');
    const highlighted = escapedText.replace(matchRegex, '<mark>$1</mark>');
    DOM.ocrResultsContent.innerHTML = highlighted;
  }

/**
 * Experimentelles Modell (E-CATS) zur Abschätzung des Thromboserisikos bei sitzenden Reisen
 * basierend auf Blutbildparametern und klinischen Faktoren. Entwickelt als Prototyp für die
 * Integration von OCR-gescannten Blutwerten in eine Risikoabschätzung für Flugreisen.
 * Berücksichtigt sowohl direkte Blutbildkomponenten als auch abgeleitete Entzündungsmarker (NLR, PLR)
 * sowie Reise- und Patientenfaktoren (Reisedauer, BMI, Alter, Raucherstatus).
 * Ziel ist es, ein einfaches Punktesystem zu schaffen, das in drei Risikokategorien (niedrig, moderat, hoch)
 * einteilt und konkrete Empfehlungen für Reisende gibt.
 **/
function calculateECATS(patientData) {
    let score = 0;
    let pointDetails = [];

    // 1. Abgeleitete Werte berechnen (NLR und PLR)
    const nlr = patientData.NEUT / patientData.LYMPH;
    const plr = patientData.PLT / patientData.LYMPH;

    // --- BLUTBILD-KOMPONENTE ---

    // Entzündungs-Faktor (Immunothrombose-Risiko)
    if (nlr > 9.0) {
        score += 3;
        pointDetails.push(`NLR von ${nlr.toFixed(2)} ist > 9.0 (+3 Punkte)`);
    } else if (nlr > 3.0) {
        score += 1;
        pointDetails.push(`NLR von ${nlr.toFixed(2)} ist > 3.0 (+1 Punkt)`);
    }

    if (plr > 200) {
        score += 1;
        pointDetails.push(`PLR von ${plr.toFixed(1)} ist > 200 (+1 Punkt)`);
    }

    // Erythrozyten-Faktor (Rheologie/Fließeigenschaft)
    if (patientData.RDW_CV >= 14.0 || patientData.RDW_SD >= 45.5) {
        score += 2;
        pointDetails.push(`RDW (CV: ${patientData.RDW_CV}, SD: ${patientData.RDW_SD}) kritisch erhöht (+2 Punkte)`);
    }

    if (patientData.HCT > 48.0) {
        score += 1;
        pointDetails.push(`HCT von ${patientData.HCT} ist > 48.0 (+1 Punkt)`);
    }

    // Thrombozyten-Aktivierungsfaktor
    if (patientData.PDW > 14.3 || patientData.MPV > 10.5) {
        score += 2;
        pointDetails.push(`Plättchengröße (PDW: ${patientData.PDW}, MPV: ${patientData.MPV}) erhöht (+2 Punkte)`);
    }

    // --- REISE- UND KLINISCHE KOMPONENTE ---
    if (patientData.travelDurationHours > 4) {
        score += 2;
        pointDetails.push(`Sitzende Reise > 4h (${patientData.travelDurationHours}h) (+2 Punkte)`);
    }
    
    if (patientData.bmi > 30) {
        score += 1;
        pointDetails.push(`BMI > 30 (+1 Punkt)`);
    }
    
    if (patientData.age > 60) {
        score += 1;
        pointDetails.push(`Alter > 60 (+1 Punkt)`);
    }
    
    if (patientData.isSmoker) {
        score += 1;
        pointDetails.push(`Raucher (+1 Punkt)`);
    }

    // --- RISIKOEINTEILUNG ---
    let riskCategory = "";
    let recommendation = "";

    if (score <= 2) {
        riskCategory = "Niedriges Basisrisiko";
        recommendation = "Normale Reisetauglichkeit.";
    } else if (score <= 5) {
        riskCategory = "Moderates Risiko";
        recommendation = "Bewegung, viel Trinken und Reisestrümpfe empfohlen.";
    } else {
        riskCategory = "Hohes Risiko";
        recommendation = "Strenge ärztliche Abklärung vor Reiseantritt! (ggf. Thromboseprophylaxe erforderlich).";
    }

    // Rückgabe des Gesamtergebnisses als Objekt
    return {
        berechneteWerte: {
            NLR: nlr.toFixed(2),
            PLR: plr.toFixed(2)
        },
        gesamtScore: score,
        risikoKlasse: riskCategory,
        empfehlung: recommendation,
        punkteAufschlüsselung: pointDetails
    };
}
  // --- OCR SCANNING ACTIONS ---

  // Downscale large images before OCR to reduce WASM memory pressure.
  // On mobile (especially iOS) this prevents tab crashes from RAM exhaustion.
  function preprocessImageForOcr(file, maxDim) {
    if (!(file instanceof Blob)) return Promise.resolve(file);
    if (maxDim === undefined) {
      const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      maxDim = isMobile ? 1500 : 3000;
    }
    return new Promise(resolve => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w <= maxDim && h <= maxDim) { resolve(file); return; }
        const scale = maxDim / Math.max(w, h);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', 0.92);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function groupOcrItemsIntoLines(items) {
    if (!items || items.length === 0) return '';
    const annotated = items.map(item => {
      const ys = item.poly.map(p => p[1]);
      const xs = item.poly.map(p => p[0]);
      return {
        text: item.text,
        centerY: (Math.min(...ys) + Math.max(...ys)) / 2,
        centerX: (Math.min(...xs) + Math.max(...xs)) / 2,
        height: Math.max(...ys) - Math.min(...ys)
      };
    });
    annotated.sort((a, b) => a.centerY - b.centerY);
    const lines = [];
    let currentLine = [annotated[0]];
    for (let i = 1; i < annotated.length; i++) {
      const ref = currentLine[0];
      const avgH = currentLine.reduce((s, it) => s + it.height, 0) / currentLine.length;
      if (Math.abs(annotated[i].centerY - ref.centerY) <= avgH * 0.6) {
        currentLine.push(annotated[i]);
      } else {
        lines.push(currentLine);
        currentLine = [annotated[i]];
      }
    }
    lines.push(currentLine);
    return lines.map(line => {
      line.sort((a, b) => a.centerX - b.centerX);
      return line.map(it => it.text).join(' ');
    }).join('\n');
  }

  async function handleCameraCapture(e) {
    const raw = e.target.files[0];
    e.target.value = ''; // reset so the same photo can be retaken
    if (!raw) return;

    // Downscale the raw camera photo BEFORE anything else.
    // High-res cameras (e.g. iPhone 14 Pro: 48 MP) decode to ~140 MB bitmaps.
    // Loading the full-res image even twice (thumbnail + OCR) exhausts the iOS
    // WebView memory budget and triggers a page reload.  Capping at 1200 px here
    // means only the small blob ever lives in memory from this point on.
    const preScaled = await preprocessImageForOcr(raw, 1200);

    // Give the file a date-prefixed name so extractDateFromFilename works
    const today = new Date().toISOString().slice(0, 10);
    const suffix = Date.now().toString().slice(-6);
    const namedFile = new File([preScaled], `${today}_camera_${suffix}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now()
    });
    namedFile.relativePath = namedFile.name;

    // Build a filteredFiles entry and append it
    const newIdx = state.filteredFiles.length;
    const fileObj = {
      id: newIdx,
      file: namedFile,
      name: namedFile.name,
      relativePath: namedFile.name,
      sizeFormatted: formatBytes(namedFile.size),
      thumbnail: URL.createObjectURL(namedFile),
      status: 'pending',
      progress: 0,
      ocrText: null,
      errorMsg: null
    };
    state.allFiles.push(namedFile);
    state.filteredFiles.push(fileObj);

    // Re-sort descending by date (same rule as applyFilter) and re-index ids
    state.filteredFiles.sort((a, b) => {
      const da = extractDateFromFilename(a.name) || '';
      const db = extractDateFromFilename(b.name) || '';
      return db.localeCompare(da);
    });
    state.filteredFiles.forEach((f, i) => { f.id = i; });
    state.activeIndex = state.filteredFiles.indexOf(fileObj);

    DOM.statTotal.textContent = state.allFiles.length;
    DOM.statMatching.textContent = state.filteredFiles.length;
    DOM.btnClear.disabled = false;

    // Persist immediately as 'pending' so the file survives a crash before OCR starts.
    // The record is updated to 'success' (or 'error') once OCR completes.
    saveFileToStorage(namedFile, '', 'pending');

    renderGallery();
    updateViewerPanel(); // zeigt Bild + Crop-Canvas für 'pending'-Status
  }

  async function handleTxtImport(e) {
    const selectedFiles = Array.from(e.target.files).filter(f => /.txt$/i.test(f.name));
    e.target.value = '';
    if (selectedFiles.length === 0) return;

    showToast('TXT-Dateien werden hinzugefügt...', 'info');
    selectedFiles.forEach(file => {
      file.relativePath = file.name;
      state.allFiles.push(file);
    });

    // Re-run filtering so the new TXT files appear according to the active pattern
    processLoadedFiles();
    showToast(`${selectedFiles.length} TXT-Datei(en) hinzugefügt.`, 'success');
  }

  async function handlePdfImport(e) {
    const selectedFiles = Array.from(e.target.files).filter(f => /\.pdf$/i.test(f.name));
    e.target.value = '';
    if (selectedFiles.length === 0) return;

    showToast('PDF-Dateien werden hinzugefügt...', 'info');
    selectedFiles.forEach(file => {
      file.relativePath = file.name;
      state.allFiles.push(file);
    });

    // Re-run filtering so the new PDF files appear according to the active pattern
    processLoadedFiles();
    showToast(`${selectedFiles.length} PDF-Datei(en) hinzugefügt.`, 'success');
  }

  // --- BLUTBILD JSON EXPORT/IMPORT (menu items in hbm-page-slot) ────────────
  // Mirrors the marker -> [{datum, wert}] shape befund.js's runClaudeAnalysis
  // already builds for the KI-Analyse (gatherAnalysisDatasets' 'blutbild'
  // dataset) — same conversion, reused here for a plain backup/restore of
  // the Blutbild-Zeitreihen alone (independent of the cross-app ZIP export).
  // Computed from ALL stored files (not state.filteredFiles), so "alle
  // Daten" isn't limited by whatever name/extension filter happens to be
  // active in the UI.
  async function exportBlutbildJSON() {
    const storedFiles = await loadFilesFromStorage();
    const grouped = computeGroupedData(storedFiles);
    if (Object.keys(grouped).length === 0) {
      showToast('Keine Blutwert-Daten zum Exportieren vorhanden.', 'error');
      return;
    }

    const payload = {};
    Object.keys(grouped).forEach(marker => {
      payload[marker] = grouped[marker].map(pt => ({ datum: pt.date, wert: pt.value }));
    });

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blutbild-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Reconstructs the imported marker series as synthetic per-date TXT files
  // ("MARKER wert" per line, one file per Messdatum) and feeds them through
  // the same TXT-import pipeline real files go through (processLoadedFiles →
  // autoReadTextFiles → parseMarkerLines/computeGroupedData) — there is no
  // separate storage path for Blutbild-Zeitreihen, files are the single
  // source of truth (see blood-data.js), so import has to go through it too.
  // Derived markers (NLR, PLR, ... TRAVEL_RISK) are skipped: computeGroupedData
  // recomputes those from the base markers automatically.
  async function importBlutbildJSON(jsonFile) {
    let payload;
    try { payload = JSON.parse(await jsonFile.text()); } catch { showToast('Ungültige JSON-Datei.', 'error'); return; }
    if (!payload || typeof payload !== 'object') { showToast('Ungültige JSON-Datei.', 'error'); return; }

    const byDate = {};
    Object.keys(payload).forEach(marker => {
      if (DERIVED_MARKERS.has(marker)) return;
      if (!Object.prototype.hasOwnProperty.call(MEDICAL_ABBR, marker)) return;
      const points = payload[marker];
      if (!Array.isArray(points)) return;
      points.forEach(pt => {
        if (!pt || !pt.datum || typeof pt.wert !== 'number' || isNaN(pt.wert)) return;
        if (!byDate[pt.datum]) byDate[pt.datum] = [];
        byDate[pt.datum].push(`${marker} ${pt.wert}`);
      });
    });

    const dates = Object.keys(byDate);
    if (dates.length === 0) {
      showToast('Keine importierbaren Blutwerte in der JSON-Datei gefunden.', 'error');
      return;
    }

    showToast('Blutbild-JSON wird importiert...', 'info');
    dates.forEach(date => {
      const text = byDate[date].join('\n');
      const syntheticFile = new File([text], `${date}_json-import.txt`, { type: 'text/plain', lastModified: Date.now() });
      syntheticFile.relativePath = syntheticFile.name;
      state.allFiles.push(syntheticFile);
    });

    processLoadedFiles();
    showToast(`${dates.length} Messdatum/-daten aus JSON importiert.`, 'success');
  }

  async function runOCRScanner() {
    if (state.isScanning || state.filteredFiles.length === 0) return;

    // Lock UI and inputs
    setUILocked(true);
    state.isScanning = true;

    DOM.overallProgressPanel.style.display = 'block';
    updateOverallProgress(0, 'Vorbereitung...');

    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      showToast('iOS erkannt: Bilder werden vor dem OCR verkleinert (max 1500px). Bei Absturz bitte weniger Dateien gleichzeitig scannen.', 'info');
    }

    const targetLang = DOM.languageSelect.value;
    const imageExtensionsRe = /\.(png|jpg|jpeg|webp|bmp|tiff|gif)$/i;
    const hasImageFiles = state.filteredFiles.some(f => imageExtensionsRe.test(f.name) && f.file instanceof Blob);
    const hasPdfFiles = state.filteredFiles.some(f => /\.pdf$/i.test(f.name) && f.file instanceof Blob);
    let ocr = null;
    let PDFParseCtor = null;

    try {
      const totalToScan = state.filteredFiles.length;
      let completedScans = 0;

      // Reset scanner outputs on items
      state.filteredFiles.forEach(fileObj => {
        fileObj.status = 'pending';
        fileObj.progress = 0;
        fileObj.ocrText = null;
        fileObj.errorMsg = null;
      });
      renderGallery();

      // Only load WASM/PaddleOCR when image files are present
      if (hasImageFiles) {
        updateOverallProgress(2, 'Waiting for OpenCV.js to initialize...');
        if (typeof window.waitForOpenCV === 'function') {
          await window.waitForOpenCV();
        }
        if (typeof cv === 'undefined') {
          throw new Error('OpenCV.js failed to load. This is required for PaddleOCR image processing. Check your internet connection.');
        }

        updateOverallProgress(5, 'Loading PaddleOCR module...');
        const { PaddleOCR } = await import('https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.3.2/dist/index.mjs');
        if (!PaddleOCR) throw new Error('PaddleOCR module not found in CDN package');

        updateOverallProgress(10, 'Initializing PaddleOCR model...');
        ocr = await PaddleOCR.create({
          lang: targetLang,
          ocrVersion: 'PP-OCRv5',
          ortOptions: { backend: 'wasm' }
        });
        updateOverallProgress(15, 'Model ready. Starting scan...');
      }

      // Only load the PDF parser module when PDF files are present
      if (hasPdfFiles) {
        updateOverallProgress(hasImageFiles ? 16 : 5, 'Loading PDF parser module...');
        PDFParseCtor = await loadPdfParseModule();
      }

      if (!hasImageFiles && !hasPdfFiles) {
        updateOverallProgress(15, 'Texte werden direkt eingelesen...');
      }

      // Sequential processing: txt files read directly, PDFs parsed for blood values, images via OCR
      for (let i = 0; i < state.filteredFiles.length; i++) {
        const fileObj = state.filteredFiles[i];
        const isTxtFile = /\.txt$/i.test(fileObj.name);
        const isPdfFile = /\.pdf$/i.test(fileObj.name);

        fileObj.status = 'scanning';
        updateItemStatusInDOM(fileObj);
        if (state.activeIndex === i) updateViewerPanel();

        updateOverallProgress(
          Math.round(15 + (completedScans / totalToScan) * 80),
          `[${i + 1}/${totalToScan}]: ${fileObj.name}`
        );

        // Skip files restored from IndexedDB that have no actual Blob data
        if (!(fileObj.file instanceof Blob)) {
          fileObj.status = 'error';
          fileObj.errorMsg = 'Datei nicht mehr verfügbar – Ordner erneut öffnen.';
          updateItemStatusInDOM(fileObj);
          completedScans++;
          continue;
        }

        if (isTxtFile) {
          try {
            const raw = await fileObj.file.text();
            const text = normalizeTxtFormat(raw);
            fileObj.ocrText = text;
            fileObj.status = 'success';
            fileObj.progress = 100;
            saveFileToStorage(fileObj.file, text, 'success');
          } catch (err) {
            console.error(`Text read error on file ${fileObj.name}:`, err);
            fileObj.status = 'error';
            fileObj.errorMsg = err.message || 'Text-Datei lesen fehlgeschlagen';
            saveFileToStorage(fileObj.file, '', 'error').catch(() => {});
          }
        } else if (isPdfFile) {
          try {
            await parseSinglePdfFile(fileObj, PDFParseCtor);
          } catch (err) {
            console.error(`PDF processing error on file ${fileObj.name}:`, err);
            fileObj.status = 'error';
            fileObj.errorMsg = err.message || 'PDF-Verarbeitung fehlgeschlagen';
            saveFileToStorage(fileObj.file, '', 'error').catch(() => {});
          }
        } else {
          try {
            // Downscale image to reduce WASM memory pressure, especially on mobile/iOS
            const fileForOcr = await preprocessImageForOcr(fileObj.file);
            const results = await ocr.predict(fileForOcr);

            if (results && results.length > 0) {
              const result = results[0];
              const { text: ocrText, corrections } = correctOcrText(groupOcrItemsIntoLines(result.items));
              fileObj.ocrText = ocrText;
              fileObj.corrections = corrections;
              fileObj.status = 'success';
              fileObj.progress = 100;
              saveFileToStorage(fileObj.file, ocrText, 'success');
              console.log(`${fileObj.name}: ${result.items.length} items, ${corrections.length} correction(s)`);
            } else {
              fileObj.ocrText = '';
              fileObj.corrections = [];
              fileObj.status = 'success';
              fileObj.progress = 100;
              saveFileToStorage(fileObj.file, '', 'success');
            }
          } catch (err) {
            console.error(`OCR processing error on file ${fileObj.name}:`, err);
            fileObj.status = 'error';
            fileObj.errorMsg = err.message || 'OCR processing failed';
            saveFileToStorage(fileObj.file, fileObj.ocrText || '', 'error').catch(() => {});
          }
        }

        completedScans++;
        DOM.statScanned.textContent = state.filteredFiles.filter(f => f.status === 'success').length;
        updateItemStatusInDOM(fileObj);
        if (state.activeIndex === i) updateViewerPanel();
        updateAnalytics();
      }

      updateOverallProgress(100, 'Verarbeitung abgeschlossen!');
      showToast(`${totalToScan} Datei(en) verarbeitet.`, 'success');

      // Druckdatum in .print-header-meta (string-set → @page @top-center)
      // und im Analytics-Header-Absatz (Fallback für Seite 1) eintragen
      const now = new Date();
      const dateStr = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const scanLabel = `Letzter Scan: ${dateStr} ${timeStr}`;

      const printMeta = document.getElementById('print-header-meta');
      if (printMeta) printMeta.textContent = scanLabel;

      const analyticsDesc = document.querySelector('.analytics-header p');
      if (analyticsDesc) analyticsDesc.textContent = `Chronologische Verlaufswerte aus OCR-Dateien — ${scanLabel}`;

    } catch (err) {
      console.error('Initialization error in PaddleOCR:', err);
      
      // Provide more specific error message for module resolution issues
      let errorMsg = err.message;
      if (err.message && err.message.includes('Failed to resolve module specifier')) {
        const moduleName = err.message.match(/"([^"]+)"/)?.[1] || 'unknown module';
        errorMsg = `Missing dependency: ${moduleName}. CDN module resolution issue.`;
        console.error('Full error:', err);
      }
      
      showToast(`OCR initialization error: ${errorMsg}`, 'error');
      
      // Update CDN status to show error
      DOM.cdnStatusDot.style.backgroundColor = 'var(--danger)';
      DOM.cdnStatusDot.style.boxShadow = '0 0 8px var(--danger)';
      DOM.cdnStatusText.textContent = 'PaddleOCR CDN Error';
      DOM.cdnStatusText.style.color = '#f87171';
    } finally {
      // Clean up OCR instance
      if (ocr) {
        try {
          ocr.dispose();
        } catch (e) {
          console.error('OCR cleanup error:', e);
        }
      }

      // Unlock UI
      setUILocked(false);
      state.isScanning = false;
      setTimeout(() => {
        DOM.overallProgressPanel.style.display = 'none';
      }, 4000);
    }
  }

  // Speedily updates specific row state inside Sidebar without full DOM re-renders
  function updateItemStatusInDOM(fileObj) {
    const fileRow = DOM.fileListContainer.querySelector(`.file-item[data-id="${fileObj.id}"]`);
    if (fileRow) {
      const badge = fileRow.querySelector('.status-badge');
      if (badge) {
        badge.className = `status-badge status-${fileObj.status}`;
        badge.title = `Status: ${fileObj.status}`;
      }
    }
  }

  // Update Global progress statistics
  function updateOverallProgress(pct, statusText) {
    DOM.scanStatusText.textContent = statusText;
    DOM.scanStatusPct.textContent = `${pct}%`;
    DOM.scanProgressBar.style.width = `${pct}%`;
  }

  // Lock buttons, text filters and picker forms
  function setUILocked(lock) {
    DOM.btnSelectDir.disabled = lock;
    DOM.filterPattern.disabled = lock;
    DOM.regexMode.disabled = lock;
    DOM.languageSelect.disabled = lock;
    DOM.btnRunOcr.disabled = lock;
    DOM.btnClear.disabled = lock;
    DOM.btnAddImage.disabled = lock;
    DOM.btnAddTxt.disabled = lock;
    DOM.btnAddPdf.disabled = lock;
  }

  // Reset workspace state back to clean loaded state
  function clearWorkspace() {
    if (state.isScanning) return;
    
    // Destroy all active Chart.js line charts
    Object.keys(state.chartInstances).forEach(name => {
      state.chartInstances[name].destroy();
    });
    state.chartInstances = {};

    clearStateData();
    DOM.statTotal.textContent = '0';
    DOM.statMatching.textContent = '0';
    DOM.statScanned.textContent = '0';
    DOM.btnClear.disabled = true;
    DOM.btnRunOcr.disabled = true;

    DOM.fileListContainer.innerHTML = '';
    DOM.sidebarEmptyState.style.display = 'flex';
    DOM.sidebarEmptyState.querySelector('h3').textContent = 'No Directory Selected';
    DOM.sidebarEmptyState.querySelector('p').textContent = 'Load a folder to scan and filter its contents';

    // Reset analytics container and lists
    DOM.chartsContainer.querySelectorAll('.chart-card').forEach(card => card.remove());
    DOM.chartsEmptyState.style.display = 'flex';

    showToast('Workspace cleared successfully.', 'info');
  }

  // --- ACTIONS EXPORT ---

  // Copy Scanned active text
  function copyActiveOcrText() {
    const activeFile = state.filteredFiles[state.activeIndex];
    if (!activeFile || activeFile.status !== 'success' || !activeFile.ocrText) {
      showToast('No scanned text available to copy.', 'error');
      return;
    }

    navigator.clipboard.writeText(activeFile.ocrText)
      .then(() => {
        showToast('Text copied to clipboard!', 'success');
      })
      .catch(err => {
        console.error(err);
        showToast('Failed to copy text: permission denied.', 'error');
      });
  }

  // Download / share scanned text.
  // On iOS Safari <a download> triggers an "upload to server" prompt instead of
  // saving locally.  We use the Web Share API (navigator.share with files) when
  // available — this opens the native iOS share sheet from which the user can
  // choose "Save to Files" (iCloud Drive, On My iPhone, etc.).
  // On macOS/desktop the classic <a download> blob-URL trick is used as fallback.
  async function downloadActiveOcrText() {
    const activeFile = state.filteredFiles[state.activeIndex];
    if (!activeFile || activeFile.status !== 'success' || !activeFile.ocrText) {
      showToast('No scanned text available to download.', 'error');
      return;
    }

    const baseName = activeFile.name.substring(0, activeFile.name.lastIndexOf('.')) || activeFile.name;
    const fileName = `${baseName}_ocr.txt`;
    const blob = new Blob([activeFile.ocrText], { type: 'text/plain;charset=utf-8' });

    // Web Share API with files: iOS 15+ / Android Chrome.
    // macOS Safari/Chrome also expose canShare() but their share sheet has no
    // "Save to File" option, so restrict this path to mobile user-agents only.
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      const shareFile = new File([blob], fileName, { type: 'text/plain' });
      if (navigator.canShare && navigator.canShare({ files: [shareFile] })) {
        try {
          // Do NOT pass `title` alongside `files` here: some share targets
          // (e.g. iOS/macOS "Save to Files") treat it as a separate plain-text
          // share item rather than pure metadata, creating a bogus second
          // download named "Text.txt" containing just the filename string.
          // The filename is already carried by `shareFile` itself.
          await navigator.share({ files: [shareFile] });
        } catch (err) {
          if (err.name !== 'AbortError') {
            showToast(`Teilen fehlgeschlagen: ${err.message}`, 'error');
          }
        }
        return;
      }
    }

    // Desktop fallback: invisible <a download> link
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
    showToast(`Downloaded: ${fileName}`, 'success');
  }

  // --- UTILITY HELPER METHODS ---

  // Convert raw file size bytes to visual strings
  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // HTML escaping helper to prevent script injection in results
  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Debouncing delay for keystroke updates on filtration input
  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // Display floating toast popups
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

    toastTimeout = setTimeout(() => {
      DOM.toastNotification.className = 'toast';
    }, 4000);
  }

  // --- ANALYTICS EXTENSIONS (DATE & MARKER SCANNERS) ---
  // extractDateFromFilename/parseMarkerLines moved to blood-data.js (shared
  // with radar.html/befund.html).

  // Detects and normalises two TXT formats into Format 1 ("ABBR VALUE" per line).
  //
  // Format 1 (pass-through): each line is "ABBR VALUE"
  //   WBC 5.2
  //   RBC 4.86
  //
  // Format 2 (convert): abbreviations block followed by numbers block, 1-to-1 mapping
  //   WBC          →  WBC 5.2
  //   RBC          →  RBC 4.86
  //   5.2
  //   4.86
  //
  // Detection: find the first line that is a bare abbreviation immediately followed
  // by a bare number; verify the prefix is all abbreviations and the suffix is all
  // numbers of equal count.  Any mismatch → treat as Format 1 (pass-through).
  function normalizeTxtFormat(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return text;

    const reAbbr = /^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z][A-Za-z0-9]*)*$/;
    const reNum  = /^[+-]?\d+(?:[.,]\d+)?$/;

    // Find split index: first position where an abbreviation is followed by a number
    let splitIdx = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      if (reAbbr.test(lines[i]) && reNum.test(lines[i + 1])) {
        splitIdx = i + 1;
        break;
      }
    }
    if (splitIdx === -1) return text; // no split found → Format 1

    const abbrPart = lines.slice(0, splitIdx);
    const numPart  = lines.slice(splitIdx);

    // Both halves must be homogeneous and of equal length
    if (!abbrPart.every(l => reAbbr.test(l))) return text;
    if (!numPart.every(l => reNum.test(l)))    return text;
    if (abbrPart.length !== numPart.length)    return text;

    // Normalise decimal comma → dot so parseMarkerLines can consume the result
    return abbrPart
      .map((abbr, i) => `${abbr} ${numPart[i].replace(',', '.')}`)
      .join('\n');
  }

  // Returns the known MEDICAL_ABBR key that matches rawMarker after applying
  // (a) trailing-digit stripping  e.g. "RDW-SD4" → "RDW-SD"
  // (b) O↔0 swaps               e.g. "BAS0"    → "BASO"
  // (c) both combined            e.g. "BAS04"   → "BASO"
  // Returns null when no unique match exists.
  function findCorrectMarker(rawMarker) {
    const known = Object.keys(MEDICAL_ABBR);
    if (known.includes(rawMarker)) return rawMarker;

    // Strip trailing digit(s) that OCR appended to the marker name
    const stripped = rawMarker.replace(/\d+$/, '');
    if (stripped !== rawMarker && known.includes(stripped)) return stripped;

    // Build all O↔0 swap variants of a given string
    function swapVariants(s) {
      const chars = s.split('');
      const idx = chars.reduce((a, c, i) => (c === 'O' || c === '0') ? [...a, i] : a, []);
      if (idx.length === 0) return new Set();
      const out = new Set();
      for (let mask = 1; mask < (1 << idx.length); mask++) {
        const v = [...chars];
        idx.forEach((pos, bit) => { if (mask & (1 << bit)) v[pos] = v[pos] === 'O' ? '0' : 'O'; });
        out.add(v.join(''));
      }
      return out;
    }

    // O↔0 variants of the original
    const v1 = swapVariants(rawMarker);
    const m1 = known.filter(k => v1.has(k));
    if (m1.length === 1) return m1[0];

    // O↔0 variants of the stripped form (handles e.g. "BAS04" → "BAS0" → "BASO")
    if (stripped !== rawMarker) {
      const v2 = swapVariants(stripped);
      const m2 = known.filter(k => v2.has(k));
      if (m2.length === 1) return m2[0];
    }

    return null;
  }

  // Post-processes raw OCR text.
  // Pass 1 – Marker name fixes: O↔0 swaps + trailing-digit stripping
  //           e.g. BAS0 → BASO,  RDW-SD4 → RDW-SD
  // Pass 2 – Stray whitespace after the decimal point
  //           e.g. NEUT 3. 68 → NEUT 3.68
  // Pass 3 – Spurious integer token before decimal value
  //           e.g. MCH 2 29.4 → MCH 29.4
  // Pass 4 – Spurious letter(s) prefixed to the numeric value
  //           e.g. RBC C4.86 → RBC 4.86,  NRBC C0.00 → NRBC 0.00
  // Returns { text: correctedText, corrections: [{from, to}] }.
  function correctOcrText(text) {
    const corrections = [];
    // Sentinel returned by the map below to mark a line for removal further
    // down — needed because the map only ever returns single lines (no
    // splicing), so actual removal happens in the filter pass after join/split.
    const DROP_LINE = ' __DROP_LINE__ ';
    const corrected = text.split(/\r?\n/).map(line => {
      // Detect marker lines; allow an optional letter before the digit so that
      // "RBC C4.86" is recognised even though a spurious 'C' precedes the value.
      const m = line.trim().match(/^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\s*[:=-]?\s*[A-Za-z]*\s*[+-]?\d/);
      if (!m) return line;

      let result = line;
      const rawMarker = m[1];

      // --- Pass 1: marker name correction (O↔0, trailing digits) ---
      const fixed = findCorrectMarker(rawMarker);
      if (fixed && fixed !== rawMarker) {
        corrections.push({ from: rawMarker, to: fixed });
        result = result.replace(rawMarker, fixed);
      }
      const markerName = (fixed && fixed !== rawMarker) ? fixed : rawMarker;
      if (!Object.prototype.hasOwnProperty.call(MEDICAL_ABBR, markerName)) {
        // Unknown marker. The detection regex above lets a digit be "borrowed"
        // from the tail of the marker token itself (needed to catch artifacts
        // like "BAS04"), so a single garbled token with no real value at all —
        // e.g. "D7" from a photo where a cropped line ("RET") got misread —
        // can still match here. Only keep the line if a real, separated
        // numeric value actually follows the marker; otherwise it's noise
        // from a cut-off/misread line and gets dropped entirely.
        const hasRealValue = /\d+\.\d+/.test(line) || /[\s:=]-?\d/.test(line);
        if (!hasRealValue) {
          corrections.push({ from: line.trim(), to: '(entfernt – kein gültiger Marker/Wert erkannt)' });
          return DROP_LINE;
        }
        return result;
      }

      const em = markerName.replace(/-/g, '\\-');

      // --- Pass 2: stray whitespace after the decimal point ---
      // "NEUT 3. 68" → "NEUT 3.68"
      const dotSpaceRe = new RegExp(`^(\\s*${em}\\s*[:=-]?\\s*[+-]?\\d+)\\.\\s+(\\d+)`);
      const dm = result.match(dotSpaceRe);
      if (dm) {
        const cleaned = result.replace(dotSpaceRe, '$1.$2');
        corrections.push({ from: result.trim(), to: cleaned.trim() });
        result = cleaned;
      }

      // --- Pass 3: spurious INTEGER before a decimal value ---
      // "MCH 2 29.4" → "MCH 29.4"
      // Safe: only fires when a bare integer precedes a decimal (has '.').
      const intRe = new RegExp(`^(\\s*${em}\\s*[:=-]?\\s*)\\d+\\s+(\\d+\\.\\d+)`);
      const im = result.match(intRe);
      if (im) {
        const cleaned = result.replace(intRe, '$1$2');
        corrections.push({ from: result.trim(), to: cleaned.trim() });
        result = cleaned;
      }

      // --- Pass 4: spurious LETTER(S) prefixed to the numeric value ---
      // "RBC C4.86" → "RBC 4.86",  "NRBC C0.00" → "NRBC 0.00"
      const letRe = new RegExp(`^(\\s*${em}\\s*[:=-]?\\s*)[A-Za-z]+\\s*([+-]?\\d+(?:\\.\\d+)?)`);
      const lm = result.match(letRe);
      if (lm) {
        const cleaned = result.replace(letRe, '$1$2');
        corrections.push({ from: result.trim(), to: cleaned.trim() });
        result = cleaned;
      }

      // --- Pass 5: non-ASCII characters between marker and value ---
      // "LYMPH 。 1.33" → "LYMPH 1.33"  (e.g. U+3002 ideographic full stop)
      const uniRe = new RegExp(`^(\\s*${em}\\s*[:=-]?\\s*)[^\\x00-\\x7F][^\\x00-\\x7F]*\\s*([+-]?\\d+(?:\\.\\d+)?)`);
      const um = result.match(uniRe);
      if (um) {
        const cleaned = result.replace(uniRe, '$1$2');
        corrections.push({ from: result.trim(), to: cleaned.trim() });
        result = cleaned;
      }

      // --- Pass 6: trailing garbage tokens after the value ---
      // "MPV 12.1 NHH" → "MPV 12.1"
      const trailRe = new RegExp(`^(\\s*${em}\\s*[:=-]?\\s*[+-]?\\d+(?:\\.\\d+)?)\\s+\\S`);
      if (trailRe.test(result)) {
        const cleaned = result.replace(
          new RegExp(`^(\\s*${em}\\s*[:=-]?\\s*[+-]?\\d+(?:\\.\\d+)?)\\s+.*$`), '$1'
        );
        corrections.push({ from: result.trim(), to: cleaned.trim() });
        result = cleaned;
      }

      return result;
    }).join('\n');

    // Post-pass: remove lines that consist only of a number (no leading abbreviation)
    // and lines marked with the DROP_LINE sentinel above (unrecognized marker,
    // no real value — pure OCR noise from a cut-off/misread line).
    const finalLines = corrected.split('\n').filter(line => {
      if (line === DROP_LINE) return false;
      const t = line.trim();
      if (t && /^[+-]?\d+(?:[.,]\d+)?\s*$/.test(t)) {
        corrections.push({ from: `(Marker fehlt – Wert: ${t})`, to: '?' });
        return false;
      }
      return true;
    });

    return { text: finalLines.join('\n'), corrections };
  }

  // Compiles chronological scanner details and constructs Chart.js instances
  function updateAnalytics() {
    // Marker -> chronological value series (incl. derived markers/TRAVEL_RISK),
    // shared with radar.html/befund.html — see blood-data.js.
    const groupedData = computeGroupedData(state.filteredFiles);
    state.groupedData = groupedData;

    // Render Trend Line Charts Grid
    const markerNames = Object.keys(groupedData);

    if (markerNames.length === 0) {
      DOM.chartsEmptyState.style.display = 'flex';
      // Clear any leftover chart cards
      DOM.chartsContainer.querySelectorAll('.chart-card').forEach(card => card.remove());
      
      // Clean up chart instances
      Object.keys(state.chartInstances).forEach(name => {
        state.chartInstances[name].destroy();
      });
      state.chartInstances = {};
      return;
    }

    DOM.chartsEmptyState.style.display = 'none';

    // Remove cards/charts that are no longer present
    Object.keys(state.chartInstances).forEach(name => {
      if (!groupedData[name]) {
        state.chartInstances[name].destroy();
        delete state.chartInstances[name];
        const card = document.getElementById(`chart-card-${name}`);
        if (card) card.remove();
      }
    });

    // Inline Chart.js plugin: draws vertical event lines/bands from EVENTS
    const eventLinesPlugin = {
      id: 'eventLines',
      afterDraw(chart, _args, pluginOpts) {
        const events = pluginOpts.events;
        if (!events || events.length === 0) return;
        const { ctx, chartArea, scales } = chart;
        const chartLabels = chart.data.labels;
        if (!chartLabels || chartLabels.length < 1) return;

        const today = new Date().toISOString().slice(0, 10);
        const labelTimes = chartLabels.map(l => new Date(l).getTime());

        const getXPixel = (dateStr) => {
          const t = new Date(dateStr).getTime();
          if (t <= labelTimes[0]) return scales.x.getPixelForValue(0);
          if (t >= labelTimes[labelTimes.length - 1]) return scales.x.getPixelForValue(chartLabels.length - 1);
          for (let i = 0; i < labelTimes.length - 1; i++) {
            if (t >= labelTimes[i] && t <= labelTimes[i + 1]) {
              const frac = (t - labelTimes[i]) / (labelTimes[i + 1] - labelTimes[i]);
              const x0 = scales.x.getPixelForValue(i);
              const x1 = scales.x.getPixelForValue(i + 1);
              return x0 + frac * (x1 - x0);
            }
          }
          return null;
        };

        events.forEach((ev, idx) => {
          const xBegin = getXPixel(ev.begin);
          const endDate = ev.end || today;
          const xEnd = getXPixel(endDate);
          if (xBegin === null) return;

          // Clamp to chart area
          const clamp = x => Math.max(chartArea.left, Math.min(chartArea.right, x));
          const x0 = clamp(xBegin);
          const x1 = xEnd !== null ? clamp(xEnd) : chartArea.right;

          ctx.save();
          ctx.beginPath();
          ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
          ctx.clip();

          // Begin line (solid amber)
          ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(x0, chartArea.top);
          ctx.lineTo(x0, chartArea.bottom);
          ctx.stroke();

          // End line: dashed if explicit end, dotted+faint if ongoing (= today)
          if (ev.end) {
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.5)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
          } else {
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.25)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 4]);
          }
          ctx.beginPath();
          ctx.moveTo(x1, chartArea.top);
          ctx.lineTo(x1, chartArea.bottom);
          ctx.stroke();

          // Label at top of begin line, alternating vertical offset to avoid overlap
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(251, 191, 36, 0.95)';
          ctx.font = '10px "Plus Jakarta Sans", sans-serif';
          ctx.textAlign = 'left';
          const labelY = chartArea.top + 12 + (idx % 3) * 14;
          ctx.fillText(ev.desc, x0 + 4, labelY);

          ctx.restore();
        });
      }
    };

    // Build or update charts for each unique abbreviation
    markerNames.forEach(markerName => {
      // Sort data points chronologically by date
      groupedData[markerName].sort((a, b) => a.date.localeCompare(b.date));

      const isDerived = DERIVED_MARKERS.has(markerName);

      let card = document.getElementById(`chart-card-${markerName}`);
      if (!card) {
        card = document.createElement('div');
        card.className = `chart-card${isDerived ? ' chart-card-derived' : ''}`;
        card.id = `chart-card-${markerName}`;
        if (MEDICAL_ABBR[markerName]) {
          card.dataset.description = MEDICAL_ABBR[markerName].desc;
        }
        const tooltipAttr = MEDICAL_ABBR[markerName]
          ? ` data-tooltip="${escapeHTML(MEDICAL_ABBR[markerName].desc)}"`
          : '';
        const derivedBadge = isDerived
          ? `<span class="derived-badge" title="${markerName === 'TRAVEL_RISK' ? 'Stetiges Reiserisikomodell basierend auf Blutwertparametern' : 'Berechneter Marker aus Blutwerten'}">berechnet</span>`
          : '';
        card.innerHTML = `
          <h4>
            <span class="chart-marker-title"${tooltipAttr}>${escapeHTML(markerName)}</span>
            <span class="chart-marker-count" id="chart-count-${markerName}">0 points</span>
          </h4>
          ${derivedBadge}
          <div class="chart-canvas-container">
            <canvas id="canvas-${markerName}"></canvas>
          </div>
        `;
        DOM.chartsContainer.appendChild(card);
      }

      // Update point count text
      document.getElementById(`chart-count-${markerName}`).textContent = `${groupedData[markerName].length} scans`;

      const baseLabels = groupedData[markerName].map(item => item.date);
      const baseValues = groupedData[markerName].map(item => item.value);

      // Merge event dates (begin + end) into the x-axis, inserting null data values
      const today = new Date().toISOString().slice(0, 10);
      const eventDates = new Set();
      EVENTS.forEach(ev => {
        eventDates.add(ev.begin);
        if (ev.end) eventDates.add(ev.end);
      });
      const extraDates = [...eventDates].filter(d => !baseLabels.includes(d));
      const merged = [...baseLabels.map((d, i) => ({ d, v: baseValues[i] })),
                      ...extraDates.map(d => ({ d, v: null }))];
      merged.sort((a, b) => a.d.localeCompare(b.d));
      const labels = merged.map(x => x.d);
      const values = merged.map(x => x.v);
      const ctx = document.getElementById(`canvas-${markerName}`).getContext('2d');

      // Re-initialize chart
      if (state.chartInstances[markerName]) {
        state.chartInstances[markerName].destroy();
      }

      // Determine chart colors based on marker type
      let lineColor = '#3b82f6';      // Default: blue
      let pointColor = '#6366f1';
      let fillColor = 'rgba(59, 130, 246, 0.06)';

      if (markerName === 'TRAVEL_RISK') {
        lineColor = '#ef4444';        // Red for risk
        pointColor = '#dc2626';
        fillColor = 'rgba(239, 68, 68, 0.08)';
      } else if (isDerived) {
        lineColor = '#f59e0b';        // Orange for derived
        pointColor = '#d97706';
        fillColor = 'rgba(245, 158, 11, 0.06)';
      }

      const abbrEntry = MEDICAL_ABBR[markerName];
      const unitSuffix = abbrEntry && abbrEntry.unit ? ` ${abbrEntry.unit}` : '';
      const refDatasets = [];
      if (abbrEntry && abbrEntry.min !== undefined) {
        refDatasets.push({
          label: `Min (${abbrEntry.min}${unitSuffix})`,
          data: labels.map(() => abbrEntry.min),
          borderColor: 'rgba(34, 197, 94, 0.55)',
          borderWidth: 1.5,
          borderDash: [5, 4],
          backgroundColor: 'transparent',
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 0,
        });
      }
      if (abbrEntry && abbrEntry.max !== undefined) {
        refDatasets.push({
          label: `Max (${abbrEntry.max}${unitSuffix})`,
          data: labels.map(() => abbrEntry.max),
          borderColor: 'rgba(239, 68, 68, 0.55)',
          borderWidth: 1.5,
          borderDash: [5, 4],
          backgroundColor: 'transparent',
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 0,
        });
      }

      state.chartInstances[markerName] = new Chart(ctx, {
        type: 'line',
        plugins: [eventLinesPlugin],
        data: {
          labels: labels,
          datasets: [{
            label: markerName,
            data: values,
            borderColor: lineColor,
            borderWidth: 2.5,
            backgroundColor: fillColor,
            fill: true,
            tension: 0.25,
            pointBackgroundColor: pointColor,
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1.5,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: '#10b981',
            pointHoverBorderColor: '#ffffff',
            spanGaps: true
          }, ...refDatasets]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            eventLines: { events: EVENTS },
            tooltip: {
              backgroundColor: 'rgba(11, 15, 25, 0.95)',
              titleColor: '#f3f4f6',
              bodyColor: '#e5e7eb',
              borderColor: 'rgba(255, 255, 255, 0.08)',
              borderWidth: 1,
              padding: 10,
              displayColors: false,
              titleFont: { family: 'Plus Jakarta Sans', weight: 600 },
              bodyFont: { family: 'Plus Jakarta Sans' },
              filter: function (item) {
                return item.datasetIndex === 0;
              },
              callbacks: {
                label: function (context) {
                  const val = context.raw;
                  const entry = MEDICAL_ABBR[markerName];
                  const u = entry && entry.unit ? ` ${entry.unit}` : '';
                  if (entry && entry.min !== undefined && entry.max !== undefined) {
                    const inRange = val >= entry.min && val <= entry.max;
                    return [`${markerName}: ${val}${u}`, `Ref: ${entry.min}–${entry.max}${u}`, inRange ? '✓ im Normbereich' : '⚠ außerhalb Normbereich'];
                  }
                  return `${markerName}: ${val}${u}`;
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255, 255, 255, 0.04)' },
              ticks: { color: '#9ca3af', font: { family: 'Plus Jakarta Sans', size: 10 } }
            },
            y: {
              grid: { color: 'rgba(255, 255, 255, 0.04)' },
              ticks: { color: '#9ca3af', font: { family: 'Plus Jakarta Sans', size: 10 } }
            }
          }
        }
      });
    });
  }

  // --- CROP SELECTION ---

  // Returns the rendered rect of the image content inside the <img> element
  // (object-fit: contain may add transparent bars).
  function getRenderedImageRect(img) {
    const cw = img.offsetWidth;
    const ch = img.offsetHeight;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return { x: 0, y: 0, w: cw, h: ch, scaleX: 1, scaleY: 1 };
    const scale = Math.min(cw / nw, ch / nh);
    const rw = nw * scale;
    const rh = nh * scale;
    return { x: (cw - rw) / 2, y: (ch - rh) / 2, w: rw, h: rh, scaleX: scale, scaleY: scale };
  }

  // Controls visibility of all three crop-toolbar buttons based on file status + selection.
  function updateCropToolbar() {
    const activeFile = state.filteredFiles[state.activeIndex];
    const isPending  = activeFile && activeFile.status === 'pending';
    const hasSel     = cropState.hasSelection;
    DOM.btnScanFull.style.display  = isPending ? '' : 'none';
    DOM.btnCropScan.style.display  = hasSel    ? '' : 'none';
    DOM.btnCropReset.style.display = hasSel    ? '' : 'none';
    DOM.cropToolbar.style.display  = (isPending || hasSel) ? 'flex' : 'none';
  }

  function initCropCanvas() {
    const img = DOM.mainPreviewImg;
    const canvas = DOM.cropCanvas;
    canvas.width = img.offsetWidth;
    canvas.height = img.offsetHeight;
    canvas.style.display = 'block';
    cropState.dragging = false;
    cropState.hasSelection = false;
    drawCropOverlay();
    updateCropToolbar();
  }

  function drawCropOverlay() {
    const canvas = DOM.cropCanvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!cropState.dragging && !cropState.hasSelection) return;

    const x = Math.min(cropState.startX, cropState.endX);
    const y = Math.min(cropState.startY, cropState.endY);
    const w = Math.abs(cropState.endX - cropState.startX);
    const h = Math.abs(cropState.endY - cropState.startY);
    if (w < 4 || h < 4) return;

    // Dim outside selection
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.clearRect(x, y, w, h);

    // Dashed selection border
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    // Corner handles
    const hs = 8;
    ctx.fillStyle = '#3b82f6';
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy]) => {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
    });
  }

  function resetCrop() {
    cropState.dragging = false;
    cropState.hasSelection = false;
    const canvas = DOM.cropCanvas;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    updateCropToolbar();
  }

  // Hit-tests a canvas-space point against the 4 corner handles of the
  // current selection. Returns the opposite (anchor) corner's coordinates
  // if a handle is hit, so the caller can drag that one corner while the
  // diagonal corner stays fixed — otherwise null.
  const CORNER_HIT_RADIUS = 36;
  function hitTestCropCornerAnchor(pos) {
    if (!cropState.hasSelection) return null;
    const x = Math.min(cropState.startX, cropState.endX);
    const y = Math.min(cropState.startY, cropState.endY);
    const w = Math.abs(cropState.endX - cropState.startX);
    const h = Math.abs(cropState.endY - cropState.startY);
    const corners = [
      { x: x,     y: y,     anchorX: x + w, anchorY: y + h },
      { x: x + w, y: y,     anchorX: x,     anchorY: y + h },
      { x: x,     y: y + h, anchorX: x + w, anchorY: y     },
      { x: x + w, y: y + h, anchorX: x,     anchorY: y     }
    ];
    let best = null;
    let bestDist = CORNER_HIT_RADIUS;
    corners.forEach(c => {
      const d = Math.hypot(pos.x - c.x, pos.y - c.y);
      if (d <= bestDist) { bestDist = d; best = { x: c.anchorX, y: c.anchorY }; }
    });
    return best;
  }

  function setupCropEvents() {
    const canvas = DOM.cropCanvas;

    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      const src = e.touches ? e.touches[0] : e;
      return {
        x: (src.clientX - rect.left) * (canvas.width / rect.width),
        y: (src.clientY - rect.top) * (canvas.height / rect.height)
      };
    }

    function onStart(e) {
      e.preventDefault();
      const pos = getPos(e);
      const anchor = hitTestCropCornerAnchor(pos);
      if (anchor) {
        // Resize: keep the diagonal corner fixed, drag the grabbed one.
        // The other two corners are recomputed as usual (they necessarily
        // move along with an axis-aligned rectangle's dragged corner), but
        // the selection itself is never discarded/reset.
        Object.assign(cropState, { dragging: true, startX: anchor.x, startY: anchor.y, endX: pos.x, endY: pos.y });
        DOM.cropToolbar.style.display = 'none';
        drawCropOverlay();
        return;
      }
      Object.assign(cropState, { dragging: true, hasSelection: false, startX: pos.x, startY: pos.y, endX: pos.x, endY: pos.y });
      DOM.cropToolbar.style.display = 'none';
      drawCropOverlay();
    }

    function onMove(e) {
      if (!cropState.dragging) {
        // Hover feedback (mouse only): show a resize cursor over a handle.
        if (!e.touches) {
          const pos = getPos(e);
          canvas.style.cursor = hitTestCropCornerAnchor(pos) ? 'move' : 'crosshair';
        }
        return;
      }
      e.preventDefault();
      const pos = getPos(e);
      cropState.endX = pos.x;
      cropState.endY = pos.y;
      drawCropOverlay();
    }

    function onEnd() {
      if (!cropState.dragging) return;
      cropState.dragging = false;
      const w = Math.abs(cropState.endX - cropState.startX);
      const h = Math.abs(cropState.endY - cropState.startY);
      if (w > 10 && h > 10) {
        cropState.hasSelection = true;
      } else {
        cropState.hasSelection = false;
      }
      updateCropToolbar();
    }

    canvas.addEventListener('mousedown', onStart);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onEnd);
    canvas.addEventListener('mouseleave', onEnd);
    canvas.addEventListener('touchstart', onStart, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onEnd);
  }

  // Shared OCR pipeline for a single file (camera capture or crop re-scan).
  // blob: the image data to scan (full file or pre-cropped offscreen canvas blob).
  async function runSingleFileOcr(fileObj, blob) {
    fileObj.status = 'scanning';
    updateItemStatusInDOM(fileObj);
    updateViewerPanel();

    DOM.overallProgressPanel.style.display = 'block';
    updateOverallProgress(0, 'OCR wird vorbereitet…');
    DOM.btnAddImage.disabled = true;

    let ocr = null;
    try {
      updateOverallProgress(5, 'OpenCV wird initialisiert…');
      if (typeof window.waitForOpenCV === 'function') await window.waitForOpenCV();
      if (typeof cv === 'undefined') throw new Error('OpenCV.js nicht geladen.');

      updateOverallProgress(15, 'PaddleOCR wird geladen…');
      const { PaddleOCR } = await import('https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.3.2/dist/index.mjs');
      if (!PaddleOCR) throw new Error('PaddleOCR nicht gefunden.');

      updateOverallProgress(35, 'Modell wird initialisiert…');
      ocr = await PaddleOCR.create({ lang: DOM.languageSelect.value, ocrVersion: 'PP-OCRv5', ortOptions: { backend: 'wasm' } });

      updateOverallProgress(65, 'OCR läuft…');
      const results = await ocr.predict(blob);
      const { text: ocrText, corrections } = correctOcrText(
        (results && results.length > 0) ? groupOcrItemsIntoLines(results[0].items) : ''
      );

      fileObj.ocrText = ocrText;
      fileObj.corrections = corrections;
      fileObj.status = 'success';
      fileObj.progress = 100;
      // Await the save so the IndexedDB transaction commits before the finally
      // block runs expensive DOM updates — prevents data loss if iOS kills the
      // tab during updateAnalytics().
      await saveFileToStorage(fileObj.file, ocrText, 'success');

      updateOverallProgress(100, 'Fertig!');
      showToast('Scan abgeschlossen.', 'success');

    } catch (err) {
      console.error('OCR error:', err);
      fileObj.status = 'error';
      fileObj.errorMsg = err.message || 'OCR fehlgeschlagen';
      // Persist the error state so the file survives a reload and can be retried.
      await saveFileToStorage(fileObj.file, fileObj.ocrText || '', 'error');
      showToast(`OCR Fehler: ${err.message}`, 'error');
    } finally {
      if (ocr) { try { ocr.dispose(); } catch (_) {} }
      DOM.btnAddImage.disabled = false;
      DOM.statScanned.textContent = state.filteredFiles.filter(f => f.status === 'success').length;
      updateItemStatusInDOM(fileObj);
      updateViewerPanel();
      updateAnalytics();
      setTimeout(() => { DOM.overallProgressPanel.style.display = 'none'; }, 3000);
    }
  }

  // Scans the full image of the currently active pending file (no crop).
  async function runFullScanFromCrop() {
    const activeFile = state.filteredFiles[state.activeIndex];
    if (!activeFile || activeFile.status !== 'pending') return;
    if (!(activeFile.file instanceof Blob)) {
      showToast('Originaldatei nicht mehr verfügbar.', 'error');
      return;
    }
    resetCrop();
    // Downscale first, same as the batch scanner and the crop path (which
    // implicitly shrinks via its canvas re-encode) — an unscaled full-res
    // photo can exceed the OCR WASM engine's comfortable memory budget and
    // produce garbled results partway through the image.
    const fileForOcr = await preprocessImageForOcr(activeFile.file);
    await runSingleFileOcr(activeFile, fileForOcr);
  }

  async function runCropOcr() {
    const activeFile = state.filteredFiles[state.activeIndex];
    if (!activeFile || (activeFile.status !== 'success' && activeFile.status !== 'pending') || !cropState.hasSelection) return;
    if (!(activeFile.file instanceof Blob)) {
      showToast('Originaldatei nicht mehr verfügbar – Ordner erneut öffnen.', 'error');
      return;
    }

    // Map canvas selection → natural image pixel coords
    const img = DOM.mainPreviewImg;
    const ir = getRenderedImageRect(img);
    const selX = Math.min(cropState.startX, cropState.endX);
    const selY = Math.min(cropState.startY, cropState.endY);
    const selW = Math.abs(cropState.endX - cropState.startX);
    const selH = Math.abs(cropState.endY - cropState.startY);

    // Clamp selection to actual image area (letterbox-safe)
    const cLeft  = Math.max(selX, ir.x) - ir.x;
    const cTop   = Math.max(selY, ir.y) - ir.y;
    const cRight = Math.min(selX + selW, ir.x + ir.w) - ir.x;
    const cBot   = Math.min(selY + selH, ir.y + ir.h) - ir.y;
    if (cRight <= cLeft || cBot <= cTop) {
      showToast('Ausschnitt außerhalb des Bildbereichs.', 'error');
      return;
    }

    const natX = Math.round(cLeft / ir.scaleX);
    const natY = Math.round(cTop / ir.scaleY);
    const natW = Math.round((cRight - cLeft) / ir.scaleX);
    const natH = Math.round((cBot - cTop) / ir.scaleY);

    const origImg = new Image();
    const origUrl = URL.createObjectURL(activeFile.file);
    await new Promise((res, rej) => { origImg.onload = res; origImg.onerror = rej; origImg.src = origUrl; });
    URL.revokeObjectURL(origUrl);

    const offscreen = document.createElement('canvas');
    offscreen.width = natW;
    offscreen.height = natH;
    offscreen.getContext('2d').drawImage(origImg, natX, natY, natW, natH, 0, 0, natW, natH);
    const croppedBlob = await new Promise(res => offscreen.toBlob(res, 'image/jpeg', 0.92));

    resetCrop();
    await runSingleFileOcr(activeFile, croppedBlob);
  }

  // --- LIVE OCR TEXT EDITING HANDLERS ---

  // Debounced IndexedDB persist after manual text edits (800 ms idle)
  const saveOcrEditDebounced = debounce((fileObj) => {
    saveFileToStorage(fileObj.file, fileObj.ocrText, fileObj.status);
  }, 800);

  // Live manual text editing inputs change handler
  function handleOcrTextInput() {
    const activeFile = state.filteredFiles[state.activeIndex];
    if (activeFile && activeFile.status === 'success') {
      // innerText automatically strips any nested mark elements and returns raw clean text
      activeFile.ocrText = DOM.ocrResultsContent.innerText;
      saveOcrEditDebounced(activeFile);
      updateAnalytics();
    }
  }

  // Clear active search highlighted markings to preserve edit integrity when focused
  function handleOcrTextFocus() {
    if (DOM.searchResultsInput.value) {
      DOM.searchResultsInput.value = '';
      const activeFile = state.filteredFiles[state.activeIndex];
      if (activeFile && activeFile.status === 'success') {
        DOM.ocrResultsContent.textContent = activeFile.ocrText;
      }
    }
  }

  // Execute
  window.addEventListener('DOMContentLoaded', init);

})();
