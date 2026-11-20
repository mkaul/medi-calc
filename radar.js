// Gesundheits-Spinnennetz (Radar chart) — standalone page.
// Reads the same OCR-scanned blood values blutbild.html stores in IndexedDB
// (via blood-data.js) and renders them as a radar chart, one wedge per
// marker, for a user-selectable date. Moved out of blutbild.html so it's
// reachable directly from the start screen instead of buried at the bottom
// of the OCR page.
(function () {
  'use strict';

  const {
    loadFilesFromStorage, computeGroupedData,
    MEDICAL_ABBR, DERIVED_MARKERS, computeHealthScore, scoreColor
  } = window.BloodData;

  const DOM = {
    radarSection: document.getElementById('radar-section'),
    radarEmptyState: document.getElementById('radar-empty-state'),
    radarCanvases: [document.getElementById('radar-canvas-a'), document.getElementById('radar-canvas-b')],
    radarSlider: document.getElementById('radar-slider'),
    radarDateDisplay: document.getElementById('radar-date-display'),
    radarDateMin: document.getElementById('radar-date-min'),
    radarDateMax: document.getElementById('radar-date-max'),
    radarScoreValue: document.getElementById('radar-score-value'),
    radarScoreSub: document.getElementById('radar-score-sub'),
    radarLegend: document.getElementById('radar-legend'),
  };

  const state = {
    groupedData: {},
    radarCharts: [null, null], // Chart.js instances for canvas-a [0] and canvas-b [1]
    radarActive: 0,            // Index of currently visible canvas (0=a, 1=b)
    radarSortedDates: [],      // All unique dates with radar data, ascending
    radarDateIndex: -1,        // Currently selected date index (-1 = latest)
  };

  // Single source of truth for the crossfade duration.
  const RADAR_FADE_MS = 2000;
  document.documentElement.style.setProperty('--radar-fade-duration', RADAR_FADE_MS + 'ms');
  let radarCleanupTimer = null;

  // Hergeleitete Marker (DERIVED_SPECS) werden wie in blutbild.html gelb dargestellt.
  const DERIVED_COLOR = '#fbbf24';
  const nameColor = (name, normal) => DERIVED_MARKERS.has(name) ? DERIVED_COLOR : normal;

  // Markers eligible as radar axes: need a reference range, and must not be
  // opted out via `radar: false` in MEDICAL_ABBR (e.g. too few measurements).
  function radarMarkers() {
    return Object.keys(MEDICAL_ABBR).filter(m => {
      const a = MEDICAL_ABBR[m];
      return a.radar !== false && a.min !== undefined && a.max !== undefined;
    });
  }

  // Collect all dates that have at least one scoreable direct marker,
  // rebuild the slider, and render the chart for the current (or latest) date.
  function updateRadarChart() {
    const directMarkers = radarMarkers();

    const dateSet = new Set();
    directMarkers.forEach(m => {
      (state.groupedData[m] || []).forEach(p => dateSet.add(p.date));
    });

    const sorted = [...dateSet].sort();
    state.radarSortedDates = sorted;

    if (sorted.length === 0) {
      DOM.radarSection.style.display = 'none';
      DOM.radarEmptyState.style.display = 'flex';
      state.radarCharts.forEach((c, i) => { if (c) { c.destroy(); state.radarCharts[i] = null; } });
      return;
    }

    DOM.radarSection.style.display = 'block';
    DOM.radarEmptyState.style.display = 'none';
    DOM.radarSlider.min = 0;
    DOM.radarSlider.max = sorted.length - 1;
    DOM.radarDateMin.textContent = sorted[0];
    DOM.radarDateMax.textContent = sorted[sorted.length - 1];

    // Default to the most recent date unless the user already moved the slider
    if (state.radarDateIndex < 0 || state.radarDateIndex >= sorted.length) {
      state.radarDateIndex = sorted.length - 1;
    }
    DOM.radarSlider.value = state.radarDateIndex;
    renderRadarForDate(sorted[state.radarDateIndex]);
  }

  function renderRadarForDate(date) {
    if (!date) return;
    DOM.radarDateDisplay.textContent = date;

    // Gather scored axes – only markers with data on this exact date
    const directMarkers = radarMarkers();

    const labels = [];
    const scores = [];
    const rawValues = [];

    directMarkers.forEach(m => {
      const series = state.groupedData[m];
      if (!series) return;
      const pt = series.find(p => p.date === date);
      if (!pt) return;
      const s = computeHealthScore(m, pt.value);
      if (s === null) return;
      labels.push(m);
      scores.push(s);
      rawValues.push(pt.value);
    });

    if (labels.length === 0) return;

    // Overall score: 70 % weight on worst single value + 30 % on mean.
    // This ensures borderline or out-of-range values drag the total down significantly.
    const minScore = Math.min(...scores);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const overall = Math.round(0.7 * minScore + 0.3 * avgScore);
    const mean = overall;
    const col = scoreColor(mean);
    DOM.radarScoreValue.textContent = mean + '%';
    DOM.radarScoreValue.style.color = col;
    DOM.radarScoreSub.textContent = `${labels.length} Werte · ${date}`;

    // Legend items
    DOM.radarLegend.innerHTML = [
      { col: '#10b981', label: '> 95 % — im Referenzbereich' },
      { col: '#f59e0b', label: '40–95 % — außerhalb, grenzwertig' },
      { col: '#ef4444', label: '< 40 % — deutlich außerhalb' }
    ].map(l =>
      `<div class="radar-legend-item">
        <span class="radar-legend-dot" style="background:${l.col};"></span>
        <span>${l.label}</span>
      </div>`
    ).join('');

    // Point colours per axis
    const pointColors = scores.map(scoreColor);

    // Crossfade: draw new chart on the hidden canvas, then swap opacities.
    if (radarCleanupTimer !== null) { clearTimeout(radarCleanupTimer); radarCleanupTimer = null; }

    const next      = 1 - state.radarActive;
    const prevActive = state.radarActive;
    const nextEl    = DOM.radarCanvases[next];
    const prevEl    = DOM.radarCanvases[prevActive];
    const hasActive = state.radarCharts[prevActive] !== null;

    if (state.radarCharts[next]) { state.radarCharts[next].destroy(); state.radarCharts[next] = null; }

    const ctx = nextEl.getContext('2d');
    state.radarCharts[next] = new Chart(ctx, {
      type: 'radar',
      data: {
        labels,
        datasets: [{
          label: 'Gesundheits-Score',
          data: scores,
          backgroundColor: 'rgba(16, 185, 129, 0.12)',
          borderColor: 'rgba(16, 185, 129, 0.75)',
          borderWidth: 2,
          pointBackgroundColor: pointColors,
          pointBorderColor: '#fff',
          pointBorderWidth: 1.5,
          pointRadius: 5,
          pointHoverRadius: 7,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // 'point' statt 'nearest': liefert alle Knoten unter dem Cursor,
        // auch wenn mehrere (z.B. Score 0) im Zentrum übereinander liegen.
        interaction: { mode: 'point', intersect: true },
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: {
              stepSize: 25,
              color: 'rgba(156, 163, 175, 0.7)',
              backdropColor: 'transparent',
              font: { family: 'Plus Jakarta Sans', size: 9 },
              callback: v => v + '%'
            },
            grid: { color: 'rgba(255, 255, 255, 0.07)' },
            angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
            pointLabels: {
              color: c => nameColor(labels[c.index], '#e5e7eb'),
              font: { family: 'Plus Jakarta Sans', size: 10, weight: '600' }
            }
          }
        },
        plugins: {
          legend: { display: false },
          // Eigenes HTML-Tooltip, damit die Kürzel fett dargestellt werden können.
          tooltip: {
            enabled: false,
            external: ({ chart, tooltip }) => renderNodeTooltip(chart, tooltip, labels, rawValues)
          }
        }
      }
    });

    // Bring next canvas to front, crossfade with previous.
    state.radarActive = next;
    nextEl.style.zIndex = '2';
    prevEl.style.zIndex = '1';
    nextEl.style.opacity = '1';
    if (hasActive) {
      prevEl.style.opacity = '0';
      radarCleanupTimer = setTimeout(() => {
        radarCleanupTimer = null;
        if (state.radarCharts[prevActive]) {
          state.radarCharts[prevActive].destroy();
          state.radarCharts[prevActive] = null;
        }
      }, RADAR_FADE_MS);
    }
  }

  // Popup mit der Definition des Kürzels, wenn der Cursor über einer
  // Achsenbeschriftung steht (Chart.js liefert dafür kein Hover-Event).
  const abbrTip = document.createElement('div');
  abbrTip.id = 'abbr-tooltip';
  document.body.appendChild(abbrTip);

  function labelAt(chart, x, y) {
    const r = chart && chart.scales && chart.scales.r;
    if (!r || !r._pointLabelItems) return null;
    const pad = 3;
    for (let i = 0; i < r._pointLabelItems.length; i++) {
      const it = r._pointLabelItems[i];
      if (x >= it.left - pad && x <= it.right + pad && y >= it.top - pad && y <= it.bottom + pad) {
        return chart.data.labels[i];
      }
    }
    return null;
  }

  DOM.radarCanvases.forEach((canvas, idx) => {
    canvas.addEventListener('mousemove', e => {
      const chart = state.radarCharts[idx];
      const rect = canvas.getBoundingClientRect();
      const key = labelAt(chart, e.clientX - rect.left, e.clientY - rect.top);
      const abbr = key && MEDICAL_ABBR[key];
      if (!abbr || !abbr.desc) { abbrTip.style.display = 'none'; canvas.style.cursor = ''; return; }
      abbrTip.innerHTML = '';
      const b = document.createElement('strong');
      b.textContent = key;
      b.style.color = nameColor(key, '');
      abbrTip.append(b, ' – ' + abbr.desc);
      abbrTip.style.display = 'block';
      canvas.style.cursor = 'help';
      const w = abbrTip.offsetWidth, h = abbrTip.offsetHeight;
      abbrTip.style.left = Math.max(4, Math.min(e.clientX + 14, window.innerWidth - w - 4)) + 'px';
      abbrTip.style.top = Math.max(4, Math.min(e.clientY + 14, window.innerHeight - h - 4)) + 'px';
    });
    canvas.addEventListener('mouseleave', () => { abbrTip.style.display = 'none'; });
  });

  // Knoten-Tooltip. Bis zu MAX_BLOCK_NODES übereinanderliegende Knoten:
  // je Knoten ein Block (Kürzel fett, Werte untereinander). Darüber: je Knoten
  // eine Zeile mit " | " getrennten Werten.
  const MAX_BLOCK_NODES = 3;
  const nodeTip = document.createElement('div');
  nodeTip.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;display:none;' +
    'padding:10px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);' +
    'background:rgba(11,15,25,0.95);color:#e5e7eb;font:12px/1.5 "Plus Jakarta Sans",system-ui,sans-serif;';
  document.body.appendChild(nodeTip);

  function renderNodeTooltip(chart, tooltip, labels, rawValues) {
    if (!tooltip.opacity || !tooltip.dataPoints || !tooltip.dataPoints.length) {
      nodeTip.style.display = 'none';
      return;
    }
    const items = tooltip.dataPoints;
    const compact = items.length > MAX_BLOCK_NODES;
    nodeTip.textContent = '';
    if (items.length > 1) {
      const head = document.createElement('div');
      head.style.color = '#9ca3af';
      head.textContent = `${items.length} Werte`;
      nodeTip.appendChild(head);
    }
    items.forEach(it => {
      const idx = it.dataIndex;
      const name = labels[idx];
      const abbr = MEDICAL_ABBR[name];
      const unit = abbr && abbr.unit ? ` ${abbr.unit}` : '';
      const parts = [`Score: ${it.raw}%`, `Wert: ${rawValues[idx]}${unit}`];
      if (abbr && abbr.min !== undefined && abbr.max !== undefined) {
        parts.push(`Ref: ${abbr.min}–${abbr.max}${unit}`);
      }
      const row = document.createElement('div');
      if (!compact && items.length > 1) row.style.marginTop = '4px';
      const b = document.createElement('strong');
      b.style.color = nameColor(name, '#f3f4f6');
      b.textContent = name;
      row.appendChild(b);
      if (compact) {
        row.append(' | ' + parts.join(' | '));
      } else {
        parts.forEach(p => {
          const d = document.createElement('div');
          d.textContent = p;
          row.appendChild(d);
        });
      }
      nodeTip.appendChild(row);
    });
    const rect = chart.canvas.getBoundingClientRect();
    nodeTip.style.display = 'block';
    const w = nodeTip.offsetWidth, h = nodeTip.offsetHeight;
    const x = rect.left + tooltip.caretX + 12, y = rect.top + tooltip.caretY + 12;
    nodeTip.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
    nodeTip.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
  }

  DOM.radarSlider.addEventListener('input', () => {
    state.radarDateIndex = parseInt(DOM.radarSlider.value, 10);
    renderRadarForDate(state.radarSortedDates[state.radarDateIndex]);
  });

  function init() {
    loadFilesFromStorage().then(files => {
      state.groupedData = computeGroupedData(files);
      updateRadarChart();
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
