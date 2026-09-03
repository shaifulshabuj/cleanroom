/**
 * ui.js — the human half of the app.
 *
 * The UI reads the same store the tools write to, so an agent action and a
 * human action are indistinguishable to the renderer. That is the point:
 * one workspace, two operators.
 */

import * as store from './store.js';
import { renderChart } from './chart.js';
import { isBlank, inferType } from './profile.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MAX_ROWS_RENDERED = 200;
let hostStatus = { connected: false, api: null, registered: 0 };

export function setHostStatus(s) {
  hostStatus = s;
  renderHostPill();
}

/* ------------------------------------------------------------ host pill */

function renderHostPill() {
  const el = $('#host-status');
  if (!el) return;
  if (hostStatus.connected) {
    el.className = 'pill pill-ok';
    el.innerHTML = `<span class="dot"></span> Agent connected · ${hostStatus.registered} tools on <code>${esc(hostStatus.api)}</code>`;
  } else {
    el.className = 'pill pill-warn';
    el.innerHTML = `<span class="dot"></span> No WebMCP host detected — use the Agent Console below to drive the same tools`;
  }
}

/* ------------------------------------------------------------- egress */

export function renderEgress(ledger) {
  const el = $('#egress');
  if (!el) return;
  const clean = ledger.requests === 0;
  el.className = `pill ${clean ? 'pill-ok' : 'pill-alert'}`;
  el.innerHTML = clean
    ? `<span class="dot"></span> 0 bytes uploaded · data stayed in this tab`
    : `<span class="dot"></span> ${ledger.requests} outbound request(s) · ${ledger.bytes} bytes`;
}

/* --------------------------------------------------------------- grid */

function renderGrid(s) {
  const wrap = $('#grid-wrap');
  const meta = $('#dataset-meta');
  if (!s.dataset) {
    meta.textContent = '';
    wrap.innerHTML = `<div class="empty">
      <h2>Drop a CSV here</h2>
      <p>Or <button class="link" id="load-sample">load the sample dataset</button> — a deliberately messy sales export.</p>
      <p class="muted small">Your file is parsed in this browser tab. It is never uploaded, and the page has no server to upload it to.</p>
    </div>`;
    return;
  }

  const ds = s.dataset;
  const issues = store.issues();
  const byColumn = new Map();
  for (const i of issues) {
    if (!i.column) continue;
    byColumn.set(i.column, (byColumn.get(i.column) || 0) + 1);
  }

  meta.innerHTML = `<strong>${esc(ds.name)}</strong> · ${ds.rows.length.toLocaleString()} rows × ${ds.columns.length} columns
    · <span class="${issues.length ? 'warn-text' : 'ok-text'}">${issues.length} issue${issues.length === 1 ? '' : 's'}</span>
    · ${s.history.length} transform${s.history.length === 1 ? '' : 's'} applied`;

  const types = {};
  for (const c of ds.columns) types[c] = inferType(ds.rows.map((r) => r[c]));

  const head = ds.columns
    .map(
      (c) => `<th>
        <span class="col-name">${esc(c)}</span>
        <span class="col-type type-${types[c]}">${types[c]}</span>
        ${byColumn.get(c) ? `<span class="col-issue" title="${byColumn.get(c)} issue(s) detected">${byColumn.get(c)}</span>` : ''}
      </th>`,
    )
    .join('');

  const body = ds.rows
    .slice(0, MAX_ROWS_RENDERED)
    .map(
      (r, i) =>
        `<tr><td class="rownum">${i + 1}</td>${ds.columns
          .map((c) => {
            const v = r[c];
            if (isBlank(v)) return '<td class="blank">—</td>';
            const s2 = String(v);
            const dirty = s2 !== s2.trim();
            return `<td${dirty ? ' class="dirty" title="has surrounding whitespace"' : ''}>${esc(s2)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');

  wrap.innerHTML = `<table class="grid">
      <thead><tr><th class="rownum">#</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${ds.rows.length > MAX_ROWS_RENDERED
      ? `<p class="muted small pad">Showing the first ${MAX_ROWS_RENDERED} of ${ds.rows.length.toLocaleString()} rows. The agent can query all of them.</p>`
      : ''}`;
}

/* ---------------------------------------------------------- proposals */

function diffLine(d) {
  const bits = [];
  if (d.rows_changed) bits.push(`${d.rows_changed} row${d.rows_changed === 1 ? '' : 's'} changed`);
  if (d.rows_removed) bits.push(`${d.rows_removed} row${d.rows_removed === 1 ? '' : 's'} removed`);
  if (d.columns_added?.length) bits.push(`+${d.columns_added.join(', ')}`);
  if (d.columns_removed?.length) bits.push(`−${d.columns_removed.join(', ')}`);
  if (!bits.length) bits.push('no visible change');
  return bits.join(' · ');
}

function renderProposals(s) {
  const el = $('#proposals');
  const pending = s.proposals.filter((p) => p.status === 'pending');
  const decided = s.proposals.filter((p) => p.status !== 'pending').slice(-6).reverse();

  $('#pending-count').textContent = pending.length || '';
  $('#pending-count').style.display = pending.length ? '' : 'none';

  if (!pending.length && !decided.length) {
    el.innerHTML = `<p class="muted small">No changes proposed yet. When an agent wants to modify the table, its proposal lands here for you to approve or reject — nothing is applied until you click.</p>`;
    return;
  }

  const card = (p) => {
    const examples = (p.diff.examples || [])
      .map(
        (e) =>
          `<tr><td class="muted">row ${e.row}</td><td class="muted">${esc(e.column)}</td>
           <td class="before">${esc(e.before === null ? '—' : e.before)}</td>
           <td class="arrow">→</td>
           <td class="after">${esc(e.after === null ? '—' : e.after)}</td></tr>`,
      )
      .join('');
    return `<article class="proposal ${p.status}" data-id="${p.id}">
      <header>
        <code class="op">${esc(p.op)}</code>
        <span class="status status-${p.status}">${p.status === 'pending' ? 'awaiting you' : p.status}</span>
      </header>
      <p class="summary">${esc(p.summary)}</p>
      ${p.rationale ? `<p class="rationale">“${esc(p.rationale)}”</p>` : ''}
      <p class="diffline">${esc(diffLine(p.diff))}</p>
      ${examples ? `<table class="diff"><tbody>${examples}</tbody></table>` : ''}
      ${p.error ? `<p class="error">${esc(p.error)}</p>` : ''}
      ${p.status === 'pending'
        ? `<div class="actions">
             <button class="btn btn-approve" data-approve="${p.id}">Approve</button>
             <button class="btn btn-reject" data-reject="${p.id}">Reject</button>
           </div>`
        : ''}
    </article>`;
  };

  el.innerHTML = pending.map(card).join('') + decided.map(card).join('');
}

/* ---------------------------------------------------------- questions */

function renderQuestions(s) {
  const el = $('#questions');
  const open = s.questions.filter((q) => q.answer === null);
  if (!open.length) { el.innerHTML = ''; return; }
  el.innerHTML = open
    .map(
      (q) => `<article class="question" data-q="${q.id}">
        <p class="qtext">${esc(q.question)}</p>
        ${q.options.length
          ? `<div class="actions">${q.options
              .map((o) => `<button class="btn btn-quiet" data-answer="${q.id}" data-value="${esc(o)}">${esc(o)}</button>`)
              .join('')}</div>`
          : `<form class="answer-form" data-form="${q.id}">
               <input type="text" placeholder="Type your answer…" aria-label="Answer" />
               <button class="btn" type="submit">Send</button>
             </form>`}
      </article>`,
    )
    .join('');
}

/* ----------------------------------------------------------- activity */

function renderActivity(s) {
  const el = $('#activity');
  if (!s.activity.length) {
    el.innerHTML = `<p class="muted small">Every tool call an agent makes appears here — arguments, duration and result. Nothing happens to your data off-screen.</p>`;
    return;
  }
  el.innerHTML = s.activity
    .slice(0, 40)
    .map((a) => {
      const args = JSON.stringify(a.args || {});
      return `<div class="act act-${a.status}">
        <div class="act-top">
          <span class="act-kind ${a.readOnly ? 'read' : 'write'}">${a.readOnly ? 'read' : 'write'}</span>
          <code>${esc(a.tool)}</code>
          <span class="act-ms">${a.ms !== undefined ? `${a.ms}ms` : '…'}</span>
        </div>
        ${args !== '{}' ? `<div class="act-args">${esc(args.length > 160 ? args.slice(0, 160) + '…' : args)}</div>` : ''}
        ${a.result ? `<div class="act-result">${esc(a.result)}</div>` : ''}
      </div>`;
    })
    .join('');
}

/* ------------------------------------------------ charts, report, export */

function renderOutputs(s) {
  const el = $('#outputs');
  let html = '';

  if (s.export) {
    html += `<div class="export-card">
      <div>
        <strong>${esc(s.export.filename)}</strong>
        <span class="muted small">${s.export.bytes.toLocaleString()} bytes · built in this tab</span>
      </div>
      <button class="btn" id="download-export">Download</button>
    </div>`;
  }
  if (s.charts.length) html += s.charts.map((c) => renderChart(c)).join('');
  if (s.report) {
    html += `<article class="report">
      <h3>${esc(s.report.title)}</h3>
      <div class="report-body">${markdownToHtml(s.report.markdown)}</div>
    </article>`;
  }
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
}

/** Deliberately tiny markdown subset — no library, no innerHTML of raw input. */
function markdownToHtml(md) {
  const lines = esc(md).split('\n');
  let out = '';
  let inList = false;
  for (let line of lines) {
    line = line
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/(^|\s)\*(?!\s)(.+?)\*/g, '$1<em>$2</em>');
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) {
      if (!inList) { out += '<ul>'; inList = true; }
      out += `<li>${li[1]}</li>`;
      continue;
    }
    if (inList) { out += '</ul>'; inList = false; }
    if (h) out += `<h${h[1].length + 2}>${h[2]}</h${h[1].length + 2}>`;
    else if (line.trim() === '') out += '';
    else out += `<p>${line}</p>`;
  }
  if (inList) out += '</ul>';
  return out;
}

/* ------------------------------------------------------------- render */

export function render(s = store.state) {
  renderGrid(s);
  renderProposals(s);
  renderQuestions(s);
  renderActivity(s);
  renderOutputs(s);
  renderHostPill();
  const undo = $('#undo');
  if (undo) undo.disabled = !s.history.length;
}

/* ------------------------------------------------------------ wiring */

export function wireEvents({ onLoadSample, onFile }) {
  document.addEventListener('click', (e) => {
    const approve = e.target.closest('[data-approve]');
    const reject = e.target.closest('[data-reject]');
    const answer = e.target.closest('[data-answer]');
    if (approve) return void store.decideProposal(approve.dataset.approve, 'approve');
    if (reject) return void store.decideProposal(reject.dataset.reject, 'reject', 'Rejected by the human in the UI.');
    if (answer) {
      const q = store.state.questions.find((x) => x.id === answer.dataset.answer);
      if (q) { q.answer = answer.dataset.value; store.emit(); }
      return;
    }
    if (e.target.id === 'load-sample') return void onLoadSample();
    if (e.target.id === 'download-export') {
      const ex = store.state.export;
      if (!ex) return;
      const url = URL.createObjectURL(new Blob([ex.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = ex.filename;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (e.target.id === 'undo') {
      try { store.undoLast(); } catch (err) { alert(err.message); }
    }
    if (e.target.id === 'reset') store.resetToOriginal();
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const q = store.state.questions.find((x) => x.id === form.dataset.form);
    const val = form.querySelector('input').value.trim();
    if (q && val) { q.answer = val; store.emit(); }
  });

  const drop = document.body;
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); document.body.classList.add('dragging'); }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.body) document.body.classList.remove('dragging'); }),
  );
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
  const picker = $('#file-input');
  if (picker) picker.addEventListener('change', (e) => { if (e.target.files[0]) onFile(e.target.files[0]); });
}
