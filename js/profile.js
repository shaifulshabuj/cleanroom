/**
 * profile.js — type inference, column profiling and issue detection.
 *
 * Everything here is deterministic and local. The agent never sees raw
 * customer data unless it explicitly asks for sample rows; profiles are
 * designed to be small enough to hand an LLM in full.
 */

const CURRENCY = /^\s*[-(]?\s*[$€£¥₹]?\s*[\d,]+(\.\d+)?\s*%?\s*\)?\s*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
const SLASH_DATE = /^\d{1,4}[/.]\d{1,2}[/.]\d{1,4}$/;
const TEXT_DATE = /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}$|^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}$/;
const BOOLEAN = /^(true|false|yes|no|y|n|0|1)$/i;

export function isBlank(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return s === '' || /^(na|n\/a|null|none|nil|-|--|\?)$/i.test(s);
}

/** Parse a loosely-formatted number: "$1,234.50", "(90)", "12%". */
export function coerceNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (isBlank(v)) return null;
  let s = String(v).trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  const pct = /%\s*$/.test(s);
  s = s.replace(/[$€£¥₹,\s%]/g, '');
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  }
  if (s === '' || !/^\d*\.?\d+([eE][-+]?\d+)?$/.test(s)) return null;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (pct) n = n / 100;
  return neg ? -n : n;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse a date into an ISO yyyy-mm-dd string, or null. dayFirst disambiguates. */
export function coerceDate(v, dayFirst = false) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,4})[/.](\d{1,2})[/.](\d{1,4})$/);
  if (m) {
    let a = +m[1], b = +m[2], c = +m[3];
    if (m[1].length === 4) return iso(a, b, c);
    let year = c < 100 ? (c < 70 ? 2000 + c : 1900 + c) : c;
    let day, month;
    if (a > 12) { day = a; month = b; }
    else if (b > 12) { month = a; day = b; }
    else if (dayFirst) { day = a; month = b; }
    else { month = a; day = b; }
    return iso(year, month, day);
  }

  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})$/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return iso(y, MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  }
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return iso(y, MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  }
  return null;
}

function iso(y, m, d) {
  if (!y || !m || !d || m > 12 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Which raw date syntax a value uses — used to spot mixed formats. */
function dateShape(s) {
  if (ISO_DATE.test(s)) return 'ISO (yyyy-mm-dd)';
  if (SLASH_DATE.test(s)) return 'slash/dot (d/m/y or m/d/y)';
  if (TEXT_DATE.test(s)) return 'text month (12 Mar 2026)';
  return null;
}

/** Infer a column's semantic type from its values. */
export function inferType(values) {
  const present = values.filter((v) => !isBlank(v));
  if (!present.length) return 'empty';
  let num = 0, date = 0, bool = 0;
  for (const v of present) {
    const s = String(v).trim();
    if (coerceDate(s) !== null && !/^\d+$/.test(s)) date++;
    if (CURRENCY.test(s) && coerceNumber(s) !== null) num++;
    if (BOOLEAN.test(s)) bool++;
  }
  const n = present.length;
  if (date / n >= 0.8) return 'date';
  if (num / n >= 0.8) return 'number';
  if (bool / n >= 0.95 && new Set(present.map((v) => String(v).toLowerCase())).size <= 3) return 'boolean';
  return 'string';
}

/** Full profile for one column: type, completeness, distribution, extremes. */
export function profileColumn(rows, column, sampleSize = 5) {
  const values = rows.map((r) => r[column]);
  const type = inferType(values);
  const present = values.filter((v) => !isBlank(v));
  const missing = values.length - present.length;
  const distinct = new Set(present.map((v) => String(v)));

  const out = {
    column,
    inferred_type: type,
    total_rows: values.length,
    missing_count: missing,
    missing_pct: values.length ? +((missing / values.length) * 100).toFixed(1) : 0,
    distinct_count: distinct.size,
    sample_values: [...new Set(present.map(String))].slice(0, sampleSize),
  };

  if (type === 'number') {
    const nums = present.map(coerceNumber).filter((n) => n !== null).sort((a, b) => a - b);
    if (nums.length) {
      const q = (p) => nums[Math.min(nums.length - 1, Math.floor(p * (nums.length - 1)))];
      const sum = nums.reduce((a, b) => a + b, 0);
      out.stats = {
        min: nums[0],
        max: nums[nums.length - 1],
        mean: +(sum / nums.length).toFixed(4),
        median: q(0.5),
        p25: q(0.25),
        p75: q(0.75),
        sum: +sum.toFixed(4),
        unparseable_count: present.length - nums.length,
      };
    }
  } else if (type === 'date') {
    const ds = present.map((v) => coerceDate(v)).filter(Boolean).sort();
    const shapes = {};
    for (const v of present) {
      const sh = dateShape(String(v).trim());
      if (sh) shapes[sh] = (shapes[sh] || 0) + 1;
    }
    out.stats = {
      min: ds[0] || null,
      max: ds[ds.length - 1] || null,
      unparseable_count: present.length - ds.length,
      formats_present: shapes,
    };
  } else {
    const freq = new Map();
    for (const v of present) {
      const s = String(v);
      freq.set(s, (freq.get(s) || 0) + 1);
    }
    out.top_values = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value, count }));
  }
  return out;
}

/** Loose key used to spot values that are "the same thing, typed differently". */
function normKey(s) {
  return String(s).trim().toLowerCase().replace(/[\s._-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Scan a dataset for concrete, fixable problems.
 * Every issue carries `suggested_fix` — a ready-to-call propose_transform
 * payload. This is what lets an agent go from "what's wrong?" to a queued
 * fix in one hop instead of guessing at an API.
 */
export function detectIssues(ds) {
  const issues = [];
  const push = (o) => issues.push({ id: `issue_${issues.length + 1}`, ...o });
  const { columns, rows } = ds;

  // Whole-table: exact duplicate rows.
  const seen = new Set();
  let dupes = 0;
  for (const r of rows) {
    const k = columns.map((c) => String(r[c] ?? '')).join('');
    if (seen.has(k)) dupes++;
    else seen.add(k);
  }
  if (dupes > 0) {
    push({
      kind: 'duplicate_rows',
      severity: 'high',
      column: null,
      count: dupes,
      detail: `${dupes} row(s) are exact duplicates of an earlier row.`,
      suggested_fix: { op: 'deduplicate', params: {} },
    });
  }

  for (const col of columns) {
    const values = rows.map((r) => r[col]);
    const present = values.filter((v) => !isBlank(v));
    const type = inferType(values);
    const missing = values.length - present.length;

    if (missing > 0) {
      push({
        kind: 'missing_values',
        severity: missing / Math.max(1, values.length) > 0.25 ? 'high' : 'medium',
        column: col,
        count: missing,
        detail: `${missing} of ${values.length} values are blank or a null-like placeholder ("N/A", "-", "null").`,
        suggested_fix: {
          op: 'fill_missing',
          params: type === 'number'
            ? { column: col, strategy: 'median' }
            : { column: col, strategy: 'constant', value: 'Unknown' },
        },
      });
    }

    const padded = present.filter((v) => String(v) !== String(v).trim()).length;
    if (padded > 0) {
      push({
        kind: 'whitespace',
        severity: 'low',
        column: col,
        count: padded,
        detail: `${padded} value(s) carry leading or trailing whitespace, which silently breaks grouping and joins.`,
        suggested_fix: { op: 'trim_whitespace', params: { column: col } },
      });
    }

    if (type === 'number') {
      const strings = present.filter((v) => typeof v === 'string' && /[$€£¥₹,%()]/.test(v)).length;
      if (strings > 0) {
        push({
          kind: 'formatted_numbers',
          severity: 'high',
          column: col,
          count: strings,
          detail: `${strings} value(s) are numbers stored as formatted text (currency symbols, thousands separators or parenthesised negatives). They will not sum or sort correctly.`,
          suggested_fix: { op: 'parse_numbers', params: { column: col } },
        });
      }
      const nums = present.map(coerceNumber).filter((n) => n !== null).sort((a, b) => a - b);
      if (nums.length > 8) {
        const q1 = nums[Math.floor(0.25 * (nums.length - 1))];
        const q3 = nums[Math.floor(0.75 * (nums.length - 1))];
        const iqr = q3 - q1;
        if (iqr > 0) {
          const lo = q1 - 3 * iqr;
          const hi = q3 + 3 * iqr;
          const out = nums.filter((n) => n < lo || n > hi);
          if (out.length) {
            push({
              kind: 'outliers',
              severity: 'medium',
              column: col,
              count: out.length,
              detail: `${out.length} value(s) fall far outside the interquartile range (below ${round(lo)} or above ${round(hi)}). Examples: ${out.slice(0, 4).map(round).join(', ')}.`,
              suggested_fix: { op: 'drop_rows_where', params: { column: col, operator: 'gt', value: round(hi) } },
            });
          }
        }
      }
    }

    if (type === 'date') {
      const shapes = new Set();
      for (const v of present) {
        const sh = dateShape(String(v).trim());
        if (sh) shapes.add(sh);
      }
      if (shapes.size > 1) {
        push({
          kind: 'mixed_date_formats',
          severity: 'high',
          column: col,
          count: present.length,
          detail: `Column mixes ${shapes.size} date formats (${[...shapes].join('; ')}). Sorting this column currently sorts alphabetically, not chronologically.`,
          suggested_fix: { op: 'parse_dates', params: { column: col } },
        });
      }
      const bad = present.filter((v) => coerceDate(v) === null).length;
      if (bad > 0) {
        push({
          kind: 'unparseable_dates',
          severity: 'medium',
          column: col,
          count: bad,
          detail: `${bad} value(s) in a date column could not be parsed as a date.`,
          suggested_fix: { op: 'parse_dates', params: { column: col } },
        });
      }
    }

    if (type === 'string') {
      const groups = new Map();
      for (const v of present) {
        const k = normKey(v);
        if (!groups.has(k)) groups.set(k, new Set());
        groups.get(k).add(String(v));
      }
      const inconsistent = [...groups.entries()].filter(([, set]) => set.size > 1);
      if (inconsistent.length) {
        const example = inconsistent[0][1];
        const mapping = {};
        for (const [, set] of inconsistent) {
          const variants = [...set];
          // Canonical form = the most "typed like a label" variant.
          const canonical = variants.slice().sort((a, b) => {
            const score = (s) => (s === s.trim() ? 0 : 2) + (/^[A-Z][a-z]/.test(s) ? -1 : 0);
            return score(a) - score(b) || a.localeCompare(b);
          })[0];
          for (const v of variants) if (v !== canonical) mapping[v] = canonical;
        }
        push({
          kind: 'inconsistent_categories',
          severity: 'high',
          column: col,
          count: inconsistent.reduce((a, [, s]) => a + s.size, 0),
          detail: `${inconsistent.length} group(s) of values differ only by case, spacing or punctuation — e.g. ${[...example].map((v) => JSON.stringify(v)).join(' vs ')}. These split every group-by.`,
          suggested_fix: { op: 'map_values', params: { column: col, mapping } },
        });
      }
    }
  }

  return issues;
}

function round(n) {
  return Math.abs(n) >= 100 ? Math.round(n) : +n.toFixed(2);
}
