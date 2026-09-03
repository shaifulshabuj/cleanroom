/**
 * transforms.js — the mutation vocabulary.
 *
 * Every transform is a pure function: (columns, rows, params) -> result.
 * Nothing mutates in place, which is what makes the undo stack and the
 * "preview before you approve" diff possible.
 */

import { coerceNumber, coerceDate, isBlank } from './profile.js';

const clone = (rows) => rows.map((r) => ({ ...r }));

/** Human-readable catalogue, also used to build the tool's inputSchema. */
export const OPS = {
  trim_whitespace: 'Strip leading/trailing whitespace from a column (or every column).',
  normalize_case: 'Normalize text case in a column: lower, upper or title.',
  parse_numbers: 'Convert formatted text ("$1,234.50", "(90)", "12%") into real numbers.',
  parse_dates: 'Normalize a mixed-format date column to ISO yyyy-mm-dd.',
  fill_missing: 'Fill blank values using a constant, mean, median, mode or the previous row.',
  map_values: 'Replace specific values in a column using an explicit {from: to} mapping.',
  rename_column: 'Rename a column.',
  drop_column: 'Remove a column entirely.',
  drop_rows_where: 'Remove rows matching a condition.',
  keep_rows_where: 'Keep only rows matching a condition.',
  deduplicate: 'Remove duplicate rows, optionally keyed on a subset of columns.',
  split_column: 'Split one column into several on a delimiter.',
  derive_column: 'Create a new column from existing ones (add, subtract, multiply, divide, concat).',
  coerce_type: 'Force a column to a type: number, date, string or boolean.',
  sort_rows: 'Sort the table by a column.',
};

export function compare(a, operator, b) {
  const na = coerceNumber(a);
  const nb = coerceNumber(b);
  const numeric = na !== null && nb !== null;
  switch (operator) {
    case 'eq': return numeric ? na === nb : String(a ?? '') === String(b ?? '');
    case 'neq': return numeric ? na !== nb : String(a ?? '') !== String(b ?? '');
    case 'gt': return numeric ? na > nb : String(a ?? '') > String(b ?? '');
    case 'gte': return numeric ? na >= nb : String(a ?? '') >= String(b ?? '');
    case 'lt': return numeric ? na < nb : String(a ?? '') < String(b ?? '');
    case 'lte': return numeric ? na <= nb : String(a ?? '') <= String(b ?? '');
    case 'contains': return String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
    case 'starts_with': return String(a ?? '').toLowerCase().startsWith(String(b ?? '').toLowerCase());
    case 'is_blank': return isBlank(a);
    case 'not_blank': return !isBlank(a);
    case 'in': return (Array.isArray(b) ? b : [b]).some((v) => String(v) === String(a ?? ''));
    default: throw new Error(`Unknown operator "${operator}"`);
  }
}

function requireColumn(columns, name, label = 'column') {
  if (!name) throw new Error(`Missing required parameter "${label}".`);
  if (!columns.includes(name)) {
    throw new Error(`Column "${name}" does not exist. Available columns: ${columns.join(', ')}`);
  }
}

const titleCase = (s) =>
  String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Apply one operation.
 * @returns {{columns:string[], rows:object[], summary:string, cells_changed:number, rows_removed:number}}
 */
export function applyOp(columns, rows, op, params = {}) {
  const p = params || {};
  let cols = [...columns];
  let out = clone(rows);
  let changed = 0;
  let removed = 0;
  let summary = '';

  const mapCells = (targets, fn) => {
    for (const r of out) {
      for (const c of targets) {
        const before = r[c];
        const after = fn(before, r, c);
        if (after !== before && !(before === null && after === null)) {
          r[c] = after;
          changed++;
        }
      }
    }
  };

  switch (op) {
    case 'trim_whitespace': {
      const targets = p.column ? [p.column] : cols;
      if (p.column) requireColumn(cols, p.column);
      mapCells(targets, (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v));
      summary = `Trimmed whitespace in ${targets.length === 1 ? `"${targets[0]}"` : `all ${targets.length} columns`}`;
      break;
    }
    case 'normalize_case': {
      requireColumn(cols, p.column);
      const mode = p.mode || 'lower';
      const fn = mode === 'upper' ? (s) => s.toUpperCase() : mode === 'title' ? titleCase : (s) => s.toLowerCase();
      mapCells([p.column], (v) => (typeof v === 'string' ? fn(v) : v));
      summary = `Normalized "${p.column}" to ${mode} case`;
      break;
    }
    case 'parse_numbers': {
      requireColumn(cols, p.column);
      let failed = 0;
      mapCells([p.column], (v) => {
        if (isBlank(v)) return null;
        const n = coerceNumber(v);
        if (n === null) { failed++; return v; }
        return n;
      });
      summary = `Parsed "${p.column}" into numbers` + (failed ? ` (${failed} value(s) could not be parsed and were left as-is)` : '');
      break;
    }
    case 'parse_dates': {
      requireColumn(cols, p.column);
      let failed = 0;
      mapCells([p.column], (v) => {
        if (isBlank(v)) return null;
        const d = coerceDate(v, !!p.day_first);
        if (d === null) { failed++; return v; }
        return d;
      });
      summary = `Normalized "${p.column}" to ISO dates` + (failed ? ` (${failed} unparseable value(s) left as-is)` : '');
      break;
    }
    case 'fill_missing': {
      requireColumn(cols, p.column);
      const strategy = p.strategy || 'constant';
      let filler = p.value ?? 'Unknown';
      const present = out.map((r) => r[p.column]).filter((v) => !isBlank(v));
      if (strategy === 'mean' || strategy === 'median') {
        const nums = present.map(coerceNumber).filter((n) => n !== null).sort((a, b) => a - b);
        if (!nums.length) throw new Error(`Cannot compute ${strategy} for "${p.column}": no numeric values.`);
        filler = strategy === 'mean'
          ? +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4)
          : nums[Math.floor((nums.length - 1) / 2)];
      } else if (strategy === 'mode') {
        const freq = new Map();
        for (const v of present) freq.set(String(v), (freq.get(String(v)) || 0) + 1);
        const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
        if (!top) throw new Error(`Cannot compute mode for "${p.column}": column is empty.`);
        filler = top[0];
      }
      if (strategy === 'forward') {
        let last = null;
        for (const r of out) {
          if (isBlank(r[p.column])) {
            if (last !== null) { r[p.column] = last; changed++; }
          } else last = r[p.column];
        }
      } else {
        mapCells([p.column], (v) => (isBlank(v) ? filler : v));
      }
      summary = `Filled ${changed} blank value(s) in "${p.column}" using ${strategy}${strategy === 'constant' || strategy === 'mean' || strategy === 'median' ? ` (${filler})` : ''}`;
      break;
    }
    case 'map_values': {
      requireColumn(cols, p.column);
      const mapping = p.mapping || {};
      if (!Object.keys(mapping).length) throw new Error('map_values needs a non-empty "mapping" object.');
      mapCells([p.column], (v) => {
        const k = v === null ? '' : String(v);
        return Object.prototype.hasOwnProperty.call(mapping, k) ? mapping[k] : v;
      });
      summary = `Consolidated ${Object.keys(mapping).length} variant(s) in "${p.column}" (${changed} cell(s) changed)`;
      break;
    }
    case 'rename_column': {
      requireColumn(cols, p.column);
      if (!p.to) throw new Error('rename_column needs "to".');
      if (cols.includes(p.to)) throw new Error(`Column "${p.to}" already exists.`);
      cols = cols.map((c) => (c === p.column ? p.to : c));
      out = out.map((r) => {
        const o = {};
        for (const k of Object.keys(r)) o[k === p.column ? p.to : k] = r[k];
        return o;
      });
      changed = out.length;
      summary = `Renamed "${p.column}" to "${p.to}"`;
      break;
    }
    case 'drop_column': {
      const targets = Array.isArray(p.columns) ? p.columns : [p.column];
      for (const c of targets) requireColumn(cols, c, 'column');
      cols = cols.filter((c) => !targets.includes(c));
      out = out.map((r) => {
        const o = { ...r };
        for (const c of targets) delete o[c];
        return o;
      });
      changed = out.length * targets.length;
      summary = `Dropped column(s): ${targets.join(', ')}`;
      break;
    }
    case 'drop_rows_where':
    case 'keep_rows_where': {
      requireColumn(cols, p.column);
      const keepIfMatch = op === 'keep_rows_where';
      const before = out.length;
      out = out.filter((r) => compare(r[p.column], p.operator || 'eq', p.value) === keepIfMatch);
      removed = before - out.length;
      summary = `${op === 'keep_rows_where' ? 'Kept' : 'Removed'} rows where "${p.column}" ${p.operator || 'eq'} ${JSON.stringify(p.value)} — ${removed} row(s) removed`;
      break;
    }
    case 'deduplicate': {
      const subset = Array.isArray(p.columns) && p.columns.length ? p.columns : cols;
      for (const c of subset) requireColumn(cols, c, 'column');
      const seen = new Set();
      const before = out.length;
      out = out.filter((r) => {
        const k = subset.map((c) => String(r[c] ?? '')).join(' ');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      removed = before - out.length;
      summary = `Removed ${removed} duplicate row(s)${p.columns?.length ? ` keyed on ${subset.join(', ')}` : ''}`;
      break;
    }
    case 'split_column': {
      requireColumn(cols, p.column);
      const delim = p.delimiter ?? ' ';
      const into = Array.isArray(p.into) && p.into.length
        ? p.into
        : [`${p.column}_1`, `${p.column}_2`];
      for (const c of into) if (cols.includes(c)) throw new Error(`Column "${c}" already exists.`);
      const idx = cols.indexOf(p.column);
      cols = [...cols.slice(0, idx + 1), ...into, ...cols.slice(idx + 1)];
      for (const r of out) {
        const parts = String(r[p.column] ?? '').split(delim);
        into.forEach((c, i) => { r[c] = parts[i] !== undefined ? parts[i].trim() || null : null; });
        changed++;
      }
      summary = `Split "${p.column}" on ${JSON.stringify(delim)} into ${into.join(', ')}`;
      break;
    }
    case 'derive_column': {
      if (!p.name) throw new Error('derive_column needs "name".');
      if (cols.includes(p.name)) throw new Error(`Column "${p.name}" already exists.`);
      const sources = Array.isArray(p.from) ? p.from : [p.from];
      for (const c of sources) requireColumn(cols, c, 'from');
      const operation = p.operation || 'concat';
      cols = [...cols, p.name];
      for (const r of out) {
        let v;
        if (operation === 'concat') {
          v = sources.map((c) => (r[c] ?? '')).join(p.separator ?? ' ');
        } else {
          const nums = sources.map((c) => coerceNumber(r[c]));
          if (nums.some((n) => n === null)) v = null;
          else if (operation === 'add') v = nums.reduce((a, b) => a + b, 0);
          else if (operation === 'subtract') v = nums.reduce((a, b) => a - b);
          else if (operation === 'multiply') v = nums.reduce((a, b) => a * b, 1);
          else if (operation === 'divide') v = nums.reduce((a, b) => (b === 0 ? null : a / b));
          else throw new Error(`Unknown operation "${operation}".`);
          if (typeof v === 'number') v = +v.toFixed(6);
        }
        r[p.name] = v;
        changed++;
      }
      summary = `Derived "${p.name}" = ${operation}(${sources.join(', ')})`;
      break;
    }
    case 'coerce_type': {
      requireColumn(cols, p.column);
      const t = p.type;
      mapCells([p.column], (v) => {
        if (isBlank(v)) return null;
        if (t === 'number') return coerceNumber(v);
        if (t === 'date') return coerceDate(v, !!p.day_first);
        if (t === 'boolean') return /^(true|yes|y|1)$/i.test(String(v).trim());
        return String(v);
      });
      summary = `Coerced "${p.column}" to ${t}`;
      break;
    }
    case 'sort_rows': {
      requireColumn(cols, p.column);
      const dir = p.direction === 'desc' ? -1 : 1;
      out.sort((a, b) => {
        const x = a[p.column], y = b[p.column];
        if (isBlank(x) && isBlank(y)) return 0;
        if (isBlank(x)) return 1;
        if (isBlank(y)) return -1;
        const nx = coerceNumber(x), ny = coerceNumber(y);
        if (nx !== null && ny !== null) return (nx - ny) * dir;
        return String(x).localeCompare(String(y)) * dir;
      });
      changed = out.length;
      summary = `Sorted by "${p.column}" ${p.direction === 'desc' ? 'descending' : 'ascending'}`;
      break;
    }
    default:
      throw new Error(`Unknown operation "${op}". Valid operations: ${Object.keys(OPS).join(', ')}`);
  }

  return { columns: cols, rows: out, summary, cells_changed: changed, rows_removed: removed };
}

/**
 * Build a compact before/after preview so a human can judge a proposal
 * in a couple of seconds without reading the whole table.
 */
export function buildDiff(beforeCols, beforeRows, afterCols, afterRows, limit = 6) {
  const addedCols = afterCols.filter((c) => !beforeCols.includes(c));
  const removedCols = beforeCols.filter((c) => !afterCols.includes(c));
  const shared = afterCols.filter((c) => beforeCols.includes(c));

  const samples = [];
  const rowsChanged = new Set();
  const n = Math.min(beforeRows.length, afterRows.length);
  const sameLength = beforeRows.length === afterRows.length;

  if (sameLength) {
    for (let i = 0; i < n; i++) {
      for (const c of shared) {
        const b = beforeRows[i][c];
        const a = afterRows[i][c];
        if (String(b ?? '') !== String(a ?? '')) {
          rowsChanged.add(i);
          if (samples.length < limit) {
            samples.push({ row: i + 1, column: c, before: b, after: a });
          }
        }
      }
    }
  }

  return {
    rows_before: beforeRows.length,
    rows_after: afterRows.length,
    rows_removed: Math.max(0, beforeRows.length - afterRows.length),
    columns_added: addedCols,
    columns_removed: removedCols,
    rows_changed: sameLength ? rowsChanged.size : null,
    examples: samples,
  };
}
