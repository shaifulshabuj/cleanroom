/**
 * csv.js — RFC-4180-tolerant CSV/TSV parsing and serialization.
 * Runs entirely in the browser. No network, no dependencies.
 */

/** Detect the most likely delimiter from the first few lines. */
export function sniffDelimiter(text) {
  const sample = text.slice(0, 64 * 1024).split(/\r?\n/).slice(0, 20);
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = sample
      .filter((l) => l.trim().length)
      .map((l) => splitLine(l, d).length);
    if (!counts.length) continue;
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    if (mode < 2) continue;
    // Prefer delimiters that produce a consistent column count.
    const consistency = counts.filter((c) => c === mode).length / counts.length;
    const score = consistency * 10 + mode * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function splitLine(line, delimiter) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse delimited text into { columns, rows }.
 * Rows are plain objects keyed by column name. Values are raw strings
 * (or null when blank) — typing happens later in profile.js so that the
 * original bytes remain inspectable.
 */
export function parseDelimited(text, opts = {}) {
  let src = text.replace(/^﻿/, '');
  const delimiter = opts.delimiter || sniffDelimiter(src);

  // Walk the whole document so quoted fields may contain newlines.
  const records = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      records.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur);
    records.push(row);
  }

  const nonEmpty = records.filter((r) => r.some((c) => c !== ''));
  if (!nonEmpty.length) return { columns: [], rows: [], delimiter };

  const header = nonEmpty[0].map((h, i) => {
    const clean = h.trim();
    return clean || `column_${i + 1}`;
  });
  // De-duplicate header names so row objects never lose a column.
  const seen = new Map();
  const columns = header.map((h) => {
    const n = seen.get(h) || 0;
    seen.set(h, n + 1);
    return n === 0 ? h : `${h}_${n + 1}`;
  });

  const rows = nonEmpty.slice(1).map((rec) => {
    const o = {};
    columns.forEach((c, i) => {
      const v = rec[i];
      o[c] = v === undefined || v === '' ? null : v;
    });
    return o;
  });

  return { columns, rows, delimiter };
}

/** Serialize back to CSV text. */
export function toCSV(columns, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(','));
  return lines.join('\n');
}
