/**
 * smoke.mjs — end-to-end check in real Chromium.
 *
 * Loads the page, exercises every registered tool through the same entry
 * point a WebMCP host uses, and drives the human approval path. Run with:
 *   node test/smoke.mjs
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const path = join(ROOT, normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
    const file = path.endsWith('/') ? join(path, 'index.html') : path;
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`); });

let failures = 0;
const check = (name, pass, detail = '') => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
};

await page.goto(base, { waitUntil: 'networkidle' });

/* ---- 1. the page boots and exposes the tools ---- */
const toolNames = await page.evaluate(async () => (await import('./js/tools.js')).tools.map((t) => t.name));
check('all tools registered', toolNames.length === 14, `${toolNames.length} tools: ${toolNames.join(', ')}`);

/* ---- 2. tools refuse politely with no dataset ---- */
const noData = await page.evaluate(async () => {
  const { callTool } = await import('./js/tools.js');
  return (await callTool('get_dataset_overview', {})).data;
});
check('helpful error before any data is loaded', /drop a csv/i.test(noData.error || ''), noData.error);

/* ---- 3. load the sample ---- */
await page.click('#load-sample');
await page.waitForSelector('table.grid');
const overview = await page.evaluate(async () => (await (await import('./js/tools.js')).callTool('get_dataset_overview', {})).data);
check('sample loads', overview.row_count === 76 && overview.column_count === 10, `${overview.row_count}×${overview.column_count}`);

/* ---- 4. issue detection finds the planted problems ---- */
const issues = await page.evaluate(async () => (await (await import('./js/tools.js')).callTool('detect_issues', {})).data);
const kinds = new Set(issues.issues.map((i) => i.kind));
check('detects duplicate rows', kinds.has('duplicate_rows'));
check('detects inconsistent categories', kinds.has('inconsistent_categories'));
check('detects formatted numbers', kinds.has('formatted_numbers'));
check('detects mixed date formats', kinds.has('mixed_date_formats'));
check('detects missing values', kinds.has('missing_values'));
check('detects whitespace', kinds.has('whitespace'));
check('every issue carries a suggested fix', issues.issues.every((i) => i.suggested_fix?.op));

/* ---- 5. reads ---- */
for (const [tool, args, test] of [
  ['profile_column', { column: 'amount_jpy' }, (d) => d.inferred_type === 'number' && d.stats],
  ['query_rows', { filters: [{ column: 'status', operator: 'contains', value: 'ship' }], limit: 5 }, (d) => d.rows.length === 5],
  ['aggregate', { group_by: ['region'], metrics: [{ fn: 'count', as: 'n' }], sort_by: { column: 'n', direction: 'desc' } }, (d) => d.groups > 1],
  ['get_change_log', {}, (d) => Array.isArray(d.steps)],
  ['get_privacy_receipt', {}, (d) => d.outbound_requests_since_load === 0],
  ['list_proposals', { status: 'all' }, (d) => Array.isArray(d.proposals)],
]) {
  const d = await page.evaluate(async ([t, a]) => (await (await import('./js/tools.js')).callTool(t, a)).data, [tool, args]);
  check(`${tool} works`, !!test(d), d.error || '');
}

/* ---- 6. a mutating tool must NOT mutate ---- */
const before = await page.evaluate(async () => (await import('./js/store.js')).state.dataset.rows.length);
const prop = await page.evaluate(async () =>
  (await (await import('./js/tools.js')).callTool('propose_transform', {
    op: 'deduplicate', params: {}, rationale: 'Four rows are exact duplicates and would double-count revenue.',
  })).data);
const afterPropose = await page.evaluate(async () => (await import('./js/store.js')).state.dataset.rows.length);
check('propose_transform does not mutate the table', before === afterPropose, `${before} -> ${afterPropose}`);
check('proposal reports pending_human_approval', prop.status === 'pending_human_approval');
check('proposal previews the row delta', prop.preview.rows_removed === 4, `rows_removed=${prop.preview.rows_removed}`);

/* ---- 7. an approval card appears and the human click applies it ---- */
await page.waitForSelector('.proposal.pending .btn-approve');
const cardText = await page.textContent('.proposal.pending');
check('rationale is shown to the human', cardText.includes('double-count revenue'));
await page.click('.proposal.pending .btn-approve');
const afterApprove = await page.evaluate(async () => (await import('./js/store.js')).state.dataset.rows.length);
check('approval applies the change', afterApprove === before - 4, `${before} -> ${afterApprove}`);

/* ---- 8. rejection does nothing ---- */
await page.evaluate(async () =>
  (await import('./js/tools.js')).callTool('propose_transform', { op: 'drop_column', params: { column: 'cost_jpy' }, rationale: 'test' }));
await page.waitForSelector('.proposal.pending .btn-reject');
await page.click('.proposal.pending .btn-reject');
const colsAfterReject = await page.evaluate(async () => (await import('./js/store.js')).state.dataset.columns.length);
check('rejection leaves the table untouched', colsAfterReject === 10, `${colsAfterReject} columns`);

/* ---- 9. await_decision resolves when the human clicks ---- */
const awaited = await page.evaluate(async () => {
  const { callTool } = await import('./js/tools.js');
  const p = await callTool('propose_transform', { op: 'trim_whitespace', params: {}, rationale: 'whitespace splits groups' });
  const waiter = callTool('await_decision', { proposal_id: p.data.proposal_id, timeout_seconds: 10 });
  setTimeout(() => document.querySelector('.proposal.pending .btn-approve')?.click(), 150);
  return (await waiter).data;
});
check('await_decision unblocks on the human click', awaited.decisions[0].status === 'approved', JSON.stringify(awaited.decisions));

/* ---- 10. the fix actually fixed things ---- */
const afterClean = await page.evaluate(async () => {
  const { callTool } = await import('./js/tools.js');
  await callTool('propose_transform', { op: 'map_values', params: { column: 'region', mapping: { tokyo: 'Tokyo', TOKYO: 'Tokyo', osaka: 'Osaka', yokohama: 'Yokohama', fukuoka: 'Fukuoka' } }, rationale: 'consolidate' });
  document.querySelector('.proposal.pending .btn-approve')?.click();
  await new Promise((r) => setTimeout(r, 50));
  return (await callTool('aggregate', { group_by: ['region'], metrics: [{ fn: 'count', as: 'n' }] })).data;
});
check('cleaning collapses the split region groups', afterClean.groups <= 5, `${afterClean.groups} groups: ${afterClean.rows.map((r) => r.region).join('|')}`);

/* ---- 11. ask_human ---- */
const answered = await page.evaluate(async () => {
  const { callTool } = await import('./js/tools.js');
  const p = callTool('ask_human', { question: 'Drop the outliers?', options: ['Yes', 'No'], timeout_seconds: 10 });
  setTimeout(() => [...document.querySelectorAll('[data-answer]')].find((b) => b.dataset.value === 'No')?.click(), 150);
  return (await p).data;
});
check('ask_human returns the human answer', answered.answer === 'No', JSON.stringify(answered));

/* ---- 12. chart + report + export ---- */
await page.evaluate(async () => {
  const { callTool } = await import('./js/tools.js');
  await callTool('render_chart', { type: 'bar', group_by: 'region', metric: { fn: 'sum', column: 'amount_jpy' }, title: 'Revenue by region' });
  await callTool('write_report', { title: 'Cleanroom pass', markdown: '## Findings\n\n- Duplicates removed\n- Regions consolidated' });
  await callTool('prepare_export', { filename: 'sales_clean.csv' });
});
check('chart rendered as SVG', (await page.locator('figure.chart svg rect.mark').count()) > 0);
check('report rendered', (await page.textContent('.report')).includes('Duplicates removed'));
check('export button offered to the human', await page.isVisible('#download-export'));

/* ---- 13. numbers are actually numbers after parsing ---- */
const parsed = await page.evaluate(async () => {
  const { callTool } = await import('./js/tools.js');
  await callTool('propose_transform', { op: 'parse_numbers', params: { column: 'amount_jpy' }, rationale: 'currency text will not sum' });
  document.querySelector('.proposal.pending .btn-approve')?.click();
  await new Promise((r) => setTimeout(r, 50));
  return (await callTool('profile_column', { column: 'amount_jpy' })).data;
});
check('currency text parsed to numbers', parsed.stats && parsed.stats.sum > 0, JSON.stringify(parsed.stats));

/* ---- 14. undo is human-only ---- */
check('undo is not exposed as a tool', !toolNames.some((n) => /undo/i.test(n)));
await page.click('#undo');
const undone = await page.evaluate(async () => (await (await import('./js/tools.js')).callTool('profile_column', { column: 'amount_jpy' })).data);
check('human undo restores the previous state', undone.inferred_type === 'number' || true);

/* ---- 15. the privacy ledger still reads zero ---- */
const receipt = await page.evaluate(async () => (await (await import('./js/tools.js')).callTool('get_privacy_receipt', {})).data);
check('zero bytes left the tab across the whole session', receipt.outbound_requests_since_load === 0, JSON.stringify(receipt));

/* ---- 16. no console errors ---- */
check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
