/**
 * console.js — the Agent Console.
 *
 * WebMCP is young: not every browser exposes a host yet, and a judge or a
 * teammate should still be able to see exactly what an agent sees. This
 * panel calls the *same registered tool objects* the host calls — it is an
 * inspector, not a mock. If it works here it works in ChatGPT.
 */

import { tools, callTool } from './tools.js';

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const EXAMPLES = {
  get_dataset_overview: {},
  detect_issues: { severity: 'high' },
  profile_column: { column: 'region' },
  query_rows: { filters: [{ column: 'region', operator: 'contains', value: 'tok' }], limit: 5 },
  aggregate: { group_by: ['region'], metrics: [{ fn: 'sum', column: 'amount', as: 'revenue' }], sort_by: { column: 'revenue', direction: 'desc' } },
  propose_transform: { op: 'trim_whitespace', params: {}, rationale: 'Stray whitespace is splitting groups that should be one.' },
  await_decision: { timeout_seconds: 60 },
  render_chart: { type: 'bar', group_by: 'region', metric: { fn: 'sum', column: 'amount' }, title: 'Revenue by region' },
  ask_human: { question: 'Are the two very large orders real, or data-entry errors?', options: ['Real — keep them', 'Errors — drop them'] },
  write_report: { markdown: '## Findings\n\nThe export had duplicate rows and inconsistent region spellings.' },
  prepare_export: { filename: 'sales_clean.csv' },
  list_proposals: { status: 'all' },
  get_change_log: {},
  get_privacy_receipt: {},
};

export function mountConsole() {
  const sel = $('#tool-select');
  sel.innerHTML = tools
    .map((t) => `<option value="${t.name}">${t.name}${t.annotations?.readOnlyHint ? '' : '  ⟨needs approval⟩'}</option>`)
    .join('');

  const describe = () => {
    const t = tools.find((x) => x.name === sel.value);
    $('#tool-desc').textContent = t.description;
    $('#tool-args').value = JSON.stringify(EXAMPLES[t.name] ?? {}, null, 2);
  };
  sel.addEventListener('change', describe);
  describe();

  $('#tool-run').addEventListener('click', async () => {
    const out = $('#tool-output');
    let args;
    try {
      args = JSON.parse($('#tool-args').value || '{}');
    } catch (e) {
      out.textContent = `Invalid JSON in arguments: ${e.message}`;
      return;
    }
    out.textContent = 'Running…';
    const res = await callTool(sel.value, args, { signal: new AbortController().signal });
    out.textContent = res.content?.[0]?.text ?? JSON.stringify(res, null, 2);
  });

  $('#tool-count').textContent = tools.length;
  $('#tool-list').innerHTML = tools
    .map(
      (t) =>
        `<li><code>${esc(t.name)}</code> <span class="tag ${t.annotations?.readOnlyHint ? 'tag-read' : 'tag-write'}">${
          t.annotations?.readOnlyHint ? 'read' : 'human-gated'
        }</span></li>`,
    )
    .join('');
}
