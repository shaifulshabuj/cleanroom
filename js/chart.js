/**
 * chart.js — hand-rolled inline SVG. No charting library, because a
 * dependency that phones home would undermine the whole point of the app.
 *
 * Single-series only, so identity is never carried by color alone: the
 * title names the series and every mark is directly hoverable.
 */

const PAD = { top: 16, right: 16, bottom: 44, left: 56 };

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function niceTicks(max, count = 4) {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

const fmt = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(0) + 'k';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
};

const truncate = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

/**
 * @param {object} chart {type,title,categoryField,valueField,rows}
 * @returns {string} SVG markup
 */
export function renderChart(chart, width = 620, height = 260) {
  const rows = (chart.rows || []).filter((r) => r[chart.valueField] !== null);
  if (!rows.length) return '<p class="muted">No plottable values.</p>';

  const values = rows.map((r) => Number(r[chart.valueField]) || 0);
  const max = Math.max(...values, 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;

  const w = width - PAD.left - PAD.right;
  const h = height - PAD.top - PAD.bottom;
  const y = (v) => PAD.top + h - (v / top) * h;

  let marks = '';
  let xLabels = '';

  if (chart.type === 'line') {
    const step = rows.length > 1 ? w / (rows.length - 1) : 0;
    const x = (i) => PAD.left + i * step;
    const path = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`).join(' ');
    marks += `<path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    rows.forEach((r, i) => {
      marks += `<circle cx="${x(i).toFixed(1)}" cy="${y(values[i]).toFixed(1)}" r="4.5"
        fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"
        class="mark"><title>${esc(r[chart.categoryField])}: ${esc(fmt(values[i]))}</title></circle>`;
    });
    const every = Math.max(1, Math.ceil(rows.length / 7));
    rows.forEach((r, i) => {
      if (i % every) return;
      xLabels += `<text x="${x(i).toFixed(1)}" y="${height - PAD.bottom + 18}" text-anchor="middle"
        class="axis-label">${esc(truncate(r[chart.categoryField], 12))}</text>`;
    });
  } else {
    const slot = w / rows.length;
    const bw = Math.max(4, Math.min(48, slot - 6)); // 2px+ surface gap between bars
    rows.forEach((r, i) => {
      const cx = PAD.left + slot * i + slot / 2;
      const v = values[i];
      const barTop = y(v);
      const barH = Math.max(1, PAD.top + h - barTop);
      marks += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${barTop.toFixed(1)}" width="${bw.toFixed(1)}"
        height="${barH.toFixed(1)}" rx="4" ry="4" fill="var(--series-1)" class="mark"
        ><title>${esc(r[chart.categoryField])}: ${esc(fmt(v))}</title></rect>`;
      if (rows.length <= 12) {
        xLabels += `<text x="${cx.toFixed(1)}" y="${height - PAD.bottom + 18}" text-anchor="middle"
          class="axis-label">${esc(truncate(r[chart.categoryField], 10))}</text>`;
      }
    });
  }

  const grid = ticks
    .map(
      (t) =>
        `<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grid"/>
         <text x="${PAD.left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" class="axis-label">${esc(fmt(t))}</text>`,
    )
    .join('');

  return `<figure class="chart">
    <figcaption>${esc(chart.title)}</figcaption>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(chart.title)}" preserveAspectRatio="xMidYMid meet">
      ${grid}
      <line x1="${PAD.left}" x2="${width - PAD.right}" y1="${PAD.top + h}" y2="${PAD.top + h}" class="axis"/>
      ${marks}
      ${xLabels}
    </svg>
  </figure>`;
}
