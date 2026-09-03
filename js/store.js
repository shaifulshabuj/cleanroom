/**
 * store.js — the single source of truth shared by the human UI and the
 * agent's tools. There is no second copy of the data anywhere: when the
 * agent changes something, the human sees the same object change.
 */

import { applyOp, buildDiff, compare } from './transforms.js';
import { profileColumn, detectIssues, inferType, coerceNumber, isBlank } from './profile.js';

const listeners = new Set();

export const state = {
  dataset: null,          // { id, name, columns, rows, loaded_at, source_bytes }
  history: [],            // applied steps, newest last
  proposals: [],          // { id, status: pending|approved|rejected|failed, ... }
  activity: [],           // every tool call, newest first
  questions: [],          // agent -> human questions awaiting an answer
  charts: [],             // rendered chart specs
  report: null,           // generated markdown summary
  egress: { requests: 0, bytes: 0, blocked: [] },
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error('listener failed', e); }
  }
}

let seq = 0;
const nextId = (prefix) => `${prefix}_${String(++seq).padStart(3, '0')}`;

/* ---------------------------------------------------------------- dataset */

export function loadDataset({ name, columns, rows, bytes = 0 }) {
  state.dataset = {
    id: nextId('ds'),
    name,
    columns,
    rows,
    loaded_at: new Date().toISOString(),
    source_bytes: bytes,
    original: { columns: [...columns], rows: rows.map((r) => ({ ...r })) },
  };
  state.history = [];
  state.proposals = [];
  state.charts = [];
  state.questions = [];
  state.report = null;
  emit();
  return state.dataset;
}

export function requireDataset() {
  if (!state.dataset) {
    throw new Error(
      'No dataset is loaded. The human needs to drop a CSV onto the page (or click "Load sample data") before any analysis is possible. Tell them that.'
    );
  }
  return state.dataset;
}

export function schema() {
  const ds = requireDataset();
  return ds.columns.map((c) => {
    const values = ds.rows.map((r) => r[c]);
    return {
      name: c,
      inferred_type: inferType(values),
      missing_count: values.filter(isBlank).length,
    };
  });
}

/* -------------------------------------------------------------- proposals */

/**
 * Stage a mutation. Nothing is applied here — the transform runs against a
 * copy so we can show the human exactly what would change, then it waits.
 * This is the heart of the app: the agent proposes, the human disposes.
 */
export function createProposal({ op, params, rationale, autoApprovable = false }) {
  const ds = requireDataset();
  const result = applyOp(ds.columns, ds.rows, op, params); // throws on bad input
  const diff = buildDiff(ds.columns, ds.rows, result.columns, result.rows);

  const proposal = {
    id: nextId('prop'),
    op,
    params,
    rationale: rationale || null,
    summary: result.summary,
    diff,
    status: 'pending',
    created_at: new Date().toISOString(),
    decided_at: null,
    autoApprovable,
  };
  state.proposals.push(proposal);
  emit();
  return proposal;
}

export function decideProposal(id, decision, note) {
  const p = state.proposals.find((x) => x.id === id);
  if (!p) throw new Error(`No proposal with id "${id}".`);
  if (p.status !== 'pending') throw new Error(`Proposal ${id} was already ${p.status}.`);

  if (decision === 'reject') {
    p.status = 'rejected';
    p.decided_at = new Date().toISOString();
    p.note = note || null;
    emit();
    return p;
  }

  const ds = state.dataset;
  try {
    const result = applyOp(ds.columns, ds.rows, p.op, p.params);
    state.history.push({
      id: nextId('step'),
      proposal_id: p.id,
      op: p.op,
      params: p.params,
      summary: result.summary,
      applied_at: new Date().toISOString(),
      snapshot: { columns: ds.columns, rows: ds.rows }, // pre-state, for undo
    });
    ds.columns = result.columns;
    ds.rows = result.rows;
    p.status = 'approved';
    p.decided_at = new Date().toISOString();
    p.applied_summary = result.summary;
  } catch (e) {
    p.status = 'failed';
    p.error = e.message;
    p.decided_at = new Date().toISOString();
  }
  emit();
  return p;
}

export function undoLast() {
  const step = state.history.pop();
  if (!step) throw new Error('Nothing to undo — no transforms have been applied.');
  state.dataset.columns = step.snapshot.columns;
  state.dataset.rows = step.snapshot.rows;
  emit();
  return step;
}

export function resetToOriginal() {
  const ds = requireDataset();
  ds.columns = [...ds.original.columns];
  ds.rows = ds.original.rows.map((r) => ({ ...r }));
  state.history = [];
  emit();
}

/* ------------------------------------------------------------ reads */

export function queryRows({ filters = [], sort = null, columns = null, limit = 50, offset = 0 }) {
  const ds = requireDataset();
  const cols = columns && columns.length ? columns : ds.columns;
  for (const c of cols) {
    if (!ds.columns.includes(c)) {
      throw new Error(`Column "${c}" does not exist. Available: ${ds.columns.join(', ')}`);
    }
  }
  let rows = ds.rows;
  for (const f of filters) {
    if (!ds.columns.includes(f.column)) {
      throw new Error(`Filter references unknown column "${f.column}". Available: ${ds.columns.join(', ')}`);
    }
    rows = rows.filter((r) => compare(r[f.column], f.operator || 'eq', f.value));
  }
  const matched = rows.length;
  if (sort && sort.column) {
    if (!ds.columns.includes(sort.column)) throw new Error(`Cannot sort by unknown column "${sort.column}".`);
    const dir = sort.direction === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = a[sort.column], y = b[sort.column];
      const nx = coerceNumber(x), ny = coerceNumber(y);
      if (nx !== null && ny !== null) return (nx - ny) * dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * dir;
    });
  }
  const page = rows.slice(offset, offset + Math.min(limit, 200)).map((r) => {
    const o = {};
    for (const c of cols) o[c] = r[c];
    return o;
  });
  return { matched_rows: matched, returned_rows: page.length, offset, rows: page };
}

export function aggregate({ group_by = [], metrics = [], sort_by = null, limit = 50 }) {
  const ds = requireDataset();
  for (const c of group_by) {
    if (!ds.columns.includes(c)) throw new Error(`Cannot group by unknown column "${c}". Available: ${ds.columns.join(', ')}`);
  }
  if (!metrics.length) metrics = [{ fn: 'count', as: 'count' }];
  for (const m of metrics) {
    if (m.fn !== 'count' && !ds.columns.includes(m.column)) {
      throw new Error(`Metric references unknown column "${m.column}". Available: ${ds.columns.join(', ')}`);
    }
  }

  const buckets = new Map();
  for (const r of ds.rows) {
    const key = group_by.map((c) => String(r[c] ?? '(blank)')).join(' ⋮ ');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }

  let out = [...buckets.entries()].map(([key, rows]) => {
    const o = {};
    group_by.forEach((c, i) => { o[c] = key.split(' ⋮ ')[i]; });
    for (const m of metrics) {
      const as = m.as || `${m.fn}_${m.column || 'rows'}`;
      if (m.fn === 'count') { o[as] = rows.length; continue; }
      const vals = rows.map((r) => r[m.column]).filter((v) => !isBlank(v));
      if (m.fn === 'distinct') { o[as] = new Set(vals.map(String)).size; continue; }
      const nums = vals.map(coerceNumber).filter((n) => n !== null);
      if (!nums.length) { o[as] = null; continue; }
      if (m.fn === 'sum') o[as] = +nums.reduce((a, b) => a + b, 0).toFixed(4);
      else if (m.fn === 'avg') o[as] = +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4);
      else if (m.fn === 'min') o[as] = Math.min(...nums);
      else if (m.fn === 'max') o[as] = Math.max(...nums);
      else throw new Error(`Unknown aggregate function "${m.fn}". Use count, sum, avg, min, max or distinct.`);
    }
    return o;
  });

  if (sort_by) {
    const dir = sort_by.direction === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      const x = a[sort_by.column], y = b[sort_by.column];
      const nx = coerceNumber(x), ny = coerceNumber(y);
      if (nx !== null && ny !== null) return (nx - ny) * dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * dir;
    });
  }
  const total = out.length;
  out = out.slice(0, Math.min(limit, 200));
  return { groups: total, returned: out.length, rows: out };
}

export const profile = (column, sample) => profileColumn(requireDataset().rows, column, sample);
export const issues = () => detectIssues(requireDataset());

/* ------------------------------------------------------------- activity */

export function logActivity(entry) {
  state.activity.unshift({ id: nextId('act'), at: new Date().toISOString(), ...entry });
  if (state.activity.length > 200) state.activity.length = 200;
  emit();
}
