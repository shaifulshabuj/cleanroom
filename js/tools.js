/**
 * tools.js — the WebMCP surface.
 *
 * Design rules, in order of importance:
 *
 *  1. Reads are free. Writes are proposals. No tool mutates the dataset;
 *     mutating tools stage a reviewable diff and stop. Only a human click
 *     applies it. `undo` is deliberately NOT exposed to the agent — the
 *     ability to walk back a change belongs to the person, not the model.
 *
 *  2. Errors are instructions. Every failure explains what to do next and
 *     lists the valid inputs, so the agent recovers instead of retrying
 *     blind.
 *
 *  3. Results are small. Profiles and aggregates are designed to fit in a
 *     context window; raw rows are only returned when explicitly asked for
 *     and are hard-capped.
 */

import * as store from './store.js';
import { OPS } from './transforms.js';
import { toCSV } from './csv.js';

/* ------------------------------------------------------- result envelope */

/**
 * Different WebMCP hosts read different fields. We return all three shapes
 * — MCP-style `content`, `structuredContent`, and a bare `data` object —
 * so the tool behaves identically in ChatGPT's browser, Chrome's native
 * implementation and the built-in console.
 */
function ok(summary, data = {}) {
  const json = JSON.stringify(data, null, 2);
  const text = json.length > 24000
    ? `${summary}\n\n(result truncated — narrow your request)\n${json.slice(0, 24000)}`
    : `${summary}\n\n${json}`;
  return { content: [{ type: 'text', text }], structuredContent: data, summary, data };
}

class ToolError extends Error {}

/* ------------------------------------------------------------- registry */

const DEFS = [];
const def = (d) => { DEFS.push(d); return d; };

const columnEnum = () => (store.state.dataset ? store.state.dataset.columns : []);

/* ============================ READ-ONLY TOOLS ============================ */

def({
  name: 'get_dataset_overview',
  title: 'Get dataset overview',
  description:
    'Start here. Returns the loaded table\'s name, row/column counts, the inferred type and blank-count of every column, how many transforms have been applied so far, and how many proposals are waiting on the human. Call this before anything else so you know what you are working with.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => {
    const ds = store.requireDataset();
    return ok(`Dataset "${ds.name}": ${ds.rows.length} rows × ${ds.columns.length} columns.`, {
      name: ds.name,
      row_count: ds.rows.length,
      column_count: ds.columns.length,
      columns: store.schema(),
      transforms_applied: store.state.history.length,
      pending_proposals: store.state.proposals.filter((p) => p.status === 'pending').length,
      note: 'This data is held only in the browser tab. It has never been uploaded anywhere.',
    });
  },
});

def({
  name: 'profile_column',
  title: 'Profile a column',
  description:
    'Deep statistics for one column: inferred type, missing count and percentage, distinct count, sample values, and — depending on type — min/max/mean/median/quartiles/sum, date range and the date formats present, or the ten most frequent values. Use this to understand a column before proposing a fix to it.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      column: { type: 'string', description: 'Exact column name, as returned by get_dataset_overview.' },
      sample_size: { type: 'integer', description: 'How many example values to return (default 5, max 25).' },
    },
    required: ['column'],
    additionalProperties: false,
  },
  execute: async ({ column, sample_size }) => {
    const ds = store.requireDataset();
    if (!ds.columns.includes(column)) {
      throw new ToolError(`Column "${column}" does not exist. Available columns: ${ds.columns.join(', ')}`);
    }
    const p = store.profile(column, Math.min(sample_size || 5, 25));
    return ok(`"${column}" — ${p.inferred_type}, ${p.missing_pct}% missing, ${p.distinct_count} distinct values.`, p);
  },
});

def({
  name: 'detect_issues',
  title: 'Detect data-quality issues',
  description:
    'Scan the whole table for concrete, fixable problems: duplicate rows, blank/placeholder values, stray whitespace, numbers stored as formatted text, mixed date formats, statistical outliers, and category values that differ only by case or spacing. Every issue comes back with a ready-to-use `suggested_fix` you can pass straight to propose_transform. This is the fastest way to go from "clean this up" to a concrete plan.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['all', 'high', 'medium', 'low'], description: 'Filter by severity. Default all.' },
      column: { type: 'string', description: 'Restrict the scan to one column.' },
    },
    additionalProperties: false,
  },
  execute: async ({ severity, column }) => {
    let list = store.issues();
    if (column) list = list.filter((i) => i.column === column);
    if (severity && severity !== 'all') list = list.filter((i) => i.severity === severity);
    const counts = list.reduce((a, i) => ({ ...a, [i.severity]: (a[i.severity] || 0) + 1 }), {});
    return ok(
      list.length
        ? `Found ${list.length} issue(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`
        : 'No issues detected — the table looks clean.',
      { issue_count: list.length, by_severity: counts, issues: list },
    );
  },
});

def({
  name: 'query_rows',
  title: 'Query rows',
  description:
    'Read actual rows with optional filters, sorting, column projection and paging. Use this to verify a hypothesis or to show the human specific records — not to pull the whole table (results are capped at 200 rows). Operators: eq, neq, gt, gte, lt, lte, contains, starts_with, in, is_blank, not_blank.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      filters: {
        type: 'array',
        description: 'Conditions combined with AND.',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string' },
            operator: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'in', 'is_blank', 'not_blank'] },
            value: { description: 'Comparison value. Omit for is_blank / not_blank. Array for "in".' },
          },
          required: ['column'],
        },
      },
      sort: {
        type: 'object',
        properties: { column: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } },
        required: ['column'],
      },
      columns: { type: 'array', items: { type: 'string' }, description: 'Only return these columns.' },
      limit: { type: 'integer', description: 'Max rows to return (default 50, hard cap 200).' },
      offset: { type: 'integer', description: 'Rows to skip, for paging.' },
    },
    additionalProperties: false,
  },
  execute: async (args) => {
    const r = store.queryRows(args || {});
    return ok(`${r.matched_rows} row(s) matched; returning ${r.returned_rows}.`, r);
  },
});

def({
  name: 'aggregate',
  title: 'Group and aggregate',
  description:
    'Group rows and compute metrics — count, sum, avg, min, max, distinct — with optional sorting. This is how you answer "which category sells most" or "what is revenue by month" without pulling raw rows. Note that grouping on a dirty column will split groups (e.g. "Tokyo" and "tokyo " count separately); run detect_issues first if the numbers look wrong.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      group_by: { type: 'array', items: { type: 'string' }, description: 'Columns to group by. Empty array aggregates the whole table.' },
      metrics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            fn: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max', 'distinct'] },
            column: { type: 'string', description: 'Required for every fn except count.' },
            as: { type: 'string', description: 'Output field name.' },
          },
          required: ['fn'],
        },
      },
      sort_by: {
        type: 'object',
        properties: { column: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } },
        required: ['column'],
      },
      limit: { type: 'integer' },
    },
    additionalProperties: false,
  },
  execute: async (args) => {
    const r = store.aggregate(args || {});
    return ok(`${r.groups} group(s); returning ${r.returned}.`, r);
  },
});

def({
  name: 'list_proposals',
  title: 'List change proposals',
  description:
    'See every change you have proposed and what the human decided. Statuses: pending (waiting on a human click), approved (applied to the table), rejected (the human said no — do not re-propose the same thing without asking why), failed (the transform errored on apply).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['all', 'pending', 'approved', 'rejected', 'failed'] } },
    additionalProperties: false,
  },
  execute: async ({ status }) => {
    let list = store.state.proposals;
    if (status && status !== 'all') list = list.filter((p) => p.status === status);
    return ok(`${list.length} proposal(s).`, {
      proposals: list.map(({ id, op, params, status: s, summary, rationale, diff, error, note }) => ({
        id, op, params, status: s, summary, rationale, diff, error, human_note: note,
      })),
    });
  },
});

def({
  name: 'get_change_log',
  title: 'Get the change log',
  description:
    'The ordered list of transforms that have actually been applied to the table, with timestamps. Use this to write a provenance section in a report, or to check whether a fix already landed before proposing it again.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => ok(`${store.state.history.length} transform(s) applied.`, {
    steps: store.state.history.map(({ id, op, params, summary, applied_at }) => ({ id, op, params, summary, applied_at })),
  }),
});

def({
  name: 'get_privacy_receipt',
  title: 'Get the privacy receipt',
  description:
    'Returns the tab\'s outbound-network ledger: how many network requests this page has made since the data was loaded, and the byte count. It is designed to read zero. Use it when the human asks whether their data left the machine — you can answer with a verifiable number rather than a promise.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => {
    const e = store.state.egress;
    const ds = store.state.dataset;
    return ok(
      `${e.requests} outbound request(s), ${e.bytes} byte(s) of data sent since load.`,
      {
        outbound_requests_since_load: e.requests,
        outbound_bytes: e.bytes,
        attempts_blocked: e.blocked,
        dataset_bytes_held_locally: ds ? ds.source_bytes : 0,
        explanation:
          'Cleanroom parses, profiles and transforms entirely in the browser tab. fetch, XMLHttpRequest, sendBeacon and WebSocket are instrumented at page start; this counter is what they recorded.',
      },
    );
  },
});

/* ========================= HUMAN-GATED WRITE TOOLS ======================= */

def({
  name: 'propose_transform',
  title: 'Propose a change',
  description:
    `Stage a change to the table. This does NOT modify anything — it computes the exact before/after diff and puts a card in front of the human, who approves or rejects it. Always pass a "rationale": it is shown on the approval card and it is what the human is actually deciding on. Prefer several small, individually-reviewable proposals over one sweeping change. Operations:\n${Object.entries(OPS).map(([k, v]) => `  • ${k} — ${v}`).join('\n')}`,
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: Object.keys(OPS), description: 'The operation to perform.' },
      params: {
        type: 'object',
        description:
          'Operation parameters. trim_whitespace{column?}; normalize_case{column,mode:lower|upper|title}; parse_numbers{column}; parse_dates{column,day_first?}; fill_missing{column,strategy:constant|mean|median|mode|forward,value?}; map_values{column,mapping:{from:to}}; rename_column{column,to}; drop_column{column|columns[]}; drop_rows_where/keep_rows_where{column,operator,value}; deduplicate{columns?[]}; split_column{column,delimiter,into[]}; derive_column{name,from[],operation:add|subtract|multiply|divide|concat,separator?}; coerce_type{column,type}; sort_rows{column,direction}.',
      },
      rationale: {
        type: 'string',
        description: 'One or two sentences, written for the human: what this fixes and why it matters. Shown on the approval card.',
      },
    },
    required: ['op', 'params'],
    additionalProperties: false,
  },
  execute: async ({ op, params, rationale }) => {
    const p = store.createProposal({ op, params, rationale });
    const d = p.diff;
    return ok(
      `Proposal ${p.id} is now waiting for human approval — it has NOT been applied. ${p.summary}.`,
      {
        proposal_id: p.id,
        status: 'pending_human_approval',
        summary: p.summary,
        preview: d,
        next_step:
          'Call await_decision with this proposal_id to wait for the human, or propose the rest of your plan first and wait on them together. Do not assume it was approved.',
      },
    );
  },
});

def({
  name: 'await_decision',
  title: 'Wait for the human decision',
  description:
    'Block until the human approves or rejects a pending proposal (or until the timeout elapses). Returns the outcome and, if approved, what actually changed. If it returns "rejected", stop and ask the human what they would prefer instead — do not re-propose the same change.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      proposal_id: { type: 'string', description: 'Omit to wait on all currently pending proposals.' },
      timeout_seconds: { type: 'integer', description: 'Default 90, maximum 240.' },
    },
    additionalProperties: false,
  },
  execute: async ({ proposal_id, timeout_seconds }, options = {}) => {
    const timeout = Math.min(Math.max(timeout_seconds || 90, 5), 240) * 1000;
    const targets = () =>
      proposal_id
        ? store.state.proposals.filter((p) => p.id === proposal_id)
        : store.state.proposals.filter((p) => p.status === 'pending' || p.autoWaited);

    if (proposal_id && !targets().length) {
      throw new ToolError(`No proposal with id "${proposal_id}". Call list_proposals to see valid ids.`);
    }

    const settled = () => targets().every((p) => p.status !== 'pending');
    if (!settled()) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; unsub(); clearTimeout(timer); resolve(); } };
        const unsub = store.subscribe(() => { if (settled()) finish(); });
        const timer = setTimeout(finish, timeout);
        options?.signal?.addEventListener?.('abort', finish);
      });
    }

    const result = targets().map((p) => ({
      proposal_id: p.id,
      status: p.status,
      summary: p.applied_summary || p.summary,
      human_note: p.note || null,
      error: p.error || null,
    }));
    const stillPending = result.filter((r) => r.status === 'pending');
    const ds = store.state.dataset;
    return ok(
      stillPending.length
        ? `Timed out with ${stillPending.length} proposal(s) still pending. The human has not decided yet.`
        : `Decision received: ${result.map((r) => `${r.proposal_id} ${r.status}`).join(', ')}.`,
      {
        decisions: result,
        table_now: ds ? { row_count: ds.rows.length, column_count: ds.columns.length } : null,
        advice: stillPending.length
          ? 'Tell the human what is waiting for them and why, then call await_decision again.'
          : undefined,
      },
    );
  },
});

def({
  name: 'render_chart',
  title: 'Render a chart in the page',
  description:
    'Draw a chart directly into the human\'s view. Non-destructive — charts are added, never replacing data. Give it an aggregate-shaped result: a category column and one numeric column. Use this instead of describing numbers in prose when the human asked "show me".',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['bar', 'line'], description: 'bar for categories, line for a time series.' },
      title: { type: 'string' },
      group_by: { type: 'string', description: 'Column supplying the category / x-axis.' },
      metric: {
        type: 'object',
        properties: {
          fn: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max', 'distinct'] },
          column: { type: 'string' },
        },
        required: ['fn'],
      },
      limit: { type: 'integer', description: 'Max categories to plot (default 12).' },
      sort: { type: 'string', enum: ['value_desc', 'value_asc', 'category_asc'], description: 'Default value_desc; use category_asc for time series.' },
    },
    required: ['type', 'group_by', 'metric'],
    additionalProperties: false,
  },
  execute: async ({ type, title, group_by, metric, limit, sort }) => {
    const valueField = metric.as || `${metric.fn}_${metric.column || 'rows'}`;
    const agg = store.aggregate({
      group_by: [group_by],
      metrics: [{ ...metric, as: valueField }],
      sort_by: sort === 'category_asc' ? { column: group_by, direction: 'asc' }
        : { column: valueField, direction: sort === 'value_asc' ? 'asc' : 'desc' },
      limit: Math.min(limit || 12, 40),
    });
    const chart = {
      id: `chart_${store.state.charts.length + 1}`,
      type,
      title: title || `${metric.fn}${metric.column ? ` of ${metric.column}` : ''} by ${group_by}`,
      categoryField: group_by,
      valueField,
      rows: agg.rows,
      created_at: new Date().toISOString(),
    };
    store.state.charts.unshift(chart);
    store.emit();
    return ok(`Rendered a ${type} chart with ${agg.rows.length} categories in the human's view.`, {
      chart_id: chart.id,
      title: chart.title,
      plotted: agg.rows,
    });
  },
});

def({
  name: 'ask_human',
  title: 'Ask the human a question',
  description:
    'Put a question card in the page and wait for an answer. Use it when a cleaning decision is a judgement call you should not make alone — which of two spellings is canonical, whether outliers are errors or real, whether a column is safe to drop. Asking once beats guessing and being reverted.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Plain-language question for the person.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional preset answers they can click.' },
      timeout_seconds: { type: 'integer', description: 'Default 120, maximum 300.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  execute: async ({ question, options, timeout_seconds }, execOpts = {}) => {
    const q = {
      id: `q_${store.state.questions.length + 1}`,
      question,
      options: options || [],
      answer: null,
      asked_at: new Date().toISOString(),
    };
    store.state.questions.unshift(q);
    store.emit();
    const timeout = Math.min(Math.max(timeout_seconds || 120, 5), 300) * 1000;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; unsub(); clearTimeout(t); resolve(); } };
      const unsub = store.subscribe(() => { if (q.answer !== null) finish(); });
      const t = setTimeout(finish, timeout);
      execOpts?.signal?.addEventListener?.('abort', finish);
    });
    return q.answer !== null
      ? ok(`The human answered: ${q.answer}`, { question, answer: q.answer })
      : ok('No answer yet — the question is still on screen.', {
          question,
          answer: null,
          advice: 'Tell the human the question is waiting in the page, and continue with work that does not depend on the answer.',
        });
  },
});

def({
  name: 'write_report',
  title: 'Write the findings report',
  description:
    'Publish a markdown report into the page: your findings, what was changed and why, and what remains. It is rendered next to the data and the human can copy or download it. Write it for a colleague who was not in the room — include the change log so the cleaning is reproducible and auditable.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      markdown: { type: 'string', description: 'Full report body in markdown.' },
      include_change_log: { type: 'boolean', description: 'Append the applied-transform log automatically. Default true.' },
    },
    required: ['markdown'],
    additionalProperties: false,
  },
  execute: async ({ title, markdown, include_change_log }) => {
    let body = markdown;
    if (include_change_log !== false && store.state.history.length) {
      body += `\n\n## Change log\n\n${store.state.history
        .map((s, i) => `${i + 1}. **${s.op}** — ${s.summary}`)
        .join('\n')}\n`;
    }
    store.state.report = { title: title || 'Findings', markdown: body, at: new Date().toISOString() };
    store.emit();
    return ok('Report published into the page.', { title: store.state.report.title, characters: body.length });
  },
});

def({
  name: 'prepare_export',
  title: 'Prepare the cleaned file for download',
  description:
    'Stage the current table as a CSV download. The file is built in the tab and offered to the human as a button — the agent cannot save to their disk, and nothing is uploaded to produce it. Call this once the cleaning is approved and you want to hand the result back.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: { filename: { type: 'string', description: 'Suggested filename, e.g. orders_clean.csv' } },
    additionalProperties: false,
  },
  execute: async ({ filename }) => {
    const ds = store.requireDataset();
    const csv = toCSV(ds.columns, ds.rows);
    const name = filename || ds.name.replace(/\.[^.]+$/, '') + '_clean.csv';
    store.state.export = { filename: name, csv, bytes: new Blob([csv]).size, at: new Date().toISOString() };
    store.emit();
    return ok(`"${name}" is ready — a download button is now showing in the page for the human to click.`, {
      filename: name,
      bytes: store.state.export.bytes,
      rows: ds.rows.length,
      columns: ds.columns.length,
    });
  },
});

/* -------------------------------------------------- execution + wiring */

/** Wrap execute so every call is logged in the human's activity rail. */
function instrument(d) {
  return async (input = {}, options = {}) => {
    const started = performance.now();
    const entry = {
      tool: d.name,
      args: input,
      status: 'running',
      readOnly: !!d.annotations?.readOnlyHint,
    };
    store.logActivity(entry);
    const record = store.state.activity[0];
    try {
      const res = await d.execute(input || {}, options);
      record.status = 'ok';
      record.ms = Math.round(performance.now() - started);
      record.result = res.summary;
      store.emit();
      return res;
    } catch (e) {
      record.status = 'error';
      record.ms = Math.round(performance.now() - started);
      record.result = e.message;
      store.emit();
      // Errors are returned as text, not thrown, so the agent reads the
      // recovery instructions instead of seeing an opaque host failure.
      return {
        content: [{ type: 'text', text: `Error in ${d.name}: ${e.message}` }],
        isError: true,
        summary: e.message,
        data: { error: e.message, tool: d.name },
      };
    }
  };
}

export const tools = DEFS.map((d) => ({ ...d, execute: instrument(d) }));

/** Call a tool by name — used by the built-in console and by tests. */
export async function callTool(name, args, options = {}) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool "${name}". Available: ${tools.map((x) => x.name).join(', ')}`);
  return t.execute(args || {}, options);
}

/**
 * Register with whatever WebMCP host is present.
 *
 * The API moved during the spec's development — some hosts expose
 * `navigator.modelContext`, the current editor's draft uses
 * `document.modelContext`, and older builds took a batch
 * `provideContext({tools})` instead of per-tool `registerTool`. We support
 * all of them rather than betting on one, and report back what we found so
 * the UI can tell the human the truth about their browser.
 */
export function registerWithHost() {
  const host =
    (typeof navigator !== 'undefined' && navigator.modelContext) ||
    (typeof document !== 'undefined' && document.modelContext) ||
    null;

  if (!host) {
    return { connected: false, api: null, registered: 0 };
  }
  const api = (typeof navigator !== 'undefined' && navigator.modelContext) ? 'navigator.modelContext' : 'document.modelContext';

  const payload = tools.map(({ name, title, description, inputSchema, annotations, execute }) => ({
    name, title, description, inputSchema, annotations, execute,
  }));

  try {
    if (typeof host.registerTool === 'function') {
      for (const t of payload) host.registerTool(t);
      return { connected: true, api: `${api}.registerTool`, registered: payload.length };
    }
    if (typeof host.provideContext === 'function') {
      host.provideContext({ tools: payload });
      return { connected: true, api: `${api}.provideContext`, registered: payload.length };
    }
  } catch (e) {
    return { connected: false, api, registered: 0, error: e.message };
  }
  return { connected: false, api, registered: 0, error: 'Host exposed modelContext but neither registerTool nor provideContext.' };
}
