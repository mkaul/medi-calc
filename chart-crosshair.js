// Lightweight Chart.js plugin: draws a vertical crosshair line at either
// (a) the pointer position while hovering/tapping the chart, or (b) a
// timestamp set from outside (e.g. an unrelated UI element that should
// stay in sync with the chart's time axis) — no dependency beyond Chart.js
// itself, so no extra CDN entry / offline-cache entry is needed.
//
// Usage:
//   const crosshair = createChartCrosshairPlugin({ onHover(ts) { ... } });
//   new Chart(ctx, { ..., plugins: [crosshair] });
//   crosshair.setPosition(ts); chart.draw();   // drive it externally
(function () {
  'use strict';

  function createChartCrosshairPlugin(opts) {
    opts = opts || {};
    let ts = null;

    const plugin = {
      id: opts.id || 'crosshair',
      afterEvent(chart, args) {
        const { event } = args;
        // 'click' is included so this also works on touch devices (iPhone
        // Safari has no hover concept) — a tap moves the crosshair just
        // like a mousemove would on desktop.
        if (event.type !== 'mousemove' && event.type !== 'click') return;
        const xScale = chart.scales.x;
        if (!xScale) return;
        ts = xScale.getValueForPixel(event.x);
        args.changed = true;
        if (opts.onHover) opts.onHover(ts);
      },
      afterDraw(chart) {
        if (ts == null) return;
        const { ctx, chartArea, scales } = chart;
        const xScale = scales.x;
        if (!chartArea || !xScale) return;
        if (ts < xScale.min || ts > xScale.max) return;
        const x = xScale.getPixelForValue(ts);
        ctx.save();
        ctx.strokeStyle = opts.color || '#22d3ee';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
      },
    };

    // Set/clear the line from outside the chart's own hover handling (e.g.
    // driven by an external slider); caller is responsible for triggering a
    // redraw (chart.draw()) afterwards.
    plugin.setPosition = newTs => { ts = newTs; };
    plugin.clear = () => { ts = null; };
    // Read the current position back out — e.g. so another plugin can draw
    // something (an interpolated value, ...) at the exact same continuous
    // timestamp the crosshair line is already following.
    plugin.getPosition = () => ts;

    return plugin;
  }

  window.createChartCrosshairPlugin = createChartCrosshairPlugin;
})();
