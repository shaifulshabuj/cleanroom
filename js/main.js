/**
 * main.js — bootstrap.
 *
 * Order matters: the egress monitor is installed before anything else so
 * the privacy ledger covers the whole session, including page setup.
 */

import { installEgressMonitor, onEgress, getLedger } from './egress.js';
import * as store from './store.js';
import { parseDelimited } from './csv.js';
import { registerWithHost } from './tools.js';
import { mountConsole } from './console.js';
import * as ui from './ui.js';
import { SAMPLE_CSV, SAMPLE_NAME } from './sample.js';

const ledger = installEgressMonitor();
store.state.egress = ledger;
onEgress((l) => ui.renderEgress(l));

function ingest(text, name) {
  const { columns, rows } = parseDelimited(text);
  if (!columns.length) {
    alert('That file has no readable columns. Cleanroom expects CSV or TSV with a header row.');
    return;
  }
  store.loadDataset({ name, columns, rows, bytes: new Blob([text]).size });
}

function loadSample() {
  ingest(SAMPLE_CSV, SAMPLE_NAME);
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => ingest(String(reader.result), file.name);
  reader.onerror = () => alert('Could not read that file.');
  reader.readAsText(file);
}

store.subscribe(ui.render);
ui.wireEvents({ onLoadSample: loadSample, onFile: loadFile });
mountConsole();

const status = registerWithHost();
ui.setHostStatus(status);
ui.render(store.state);
ui.renderEgress(getLedger());

// Surface the wiring for debugging and for the demo, without shipping a
// second code path: these are the same objects the host registered.
window.cleanroom = { store, callTool: (n, a) => import('./tools.js').then((m) => m.callTool(n, a)), status };
console.info(
  `%cCleanroom%c ${status.connected ? `${status.registered} tools registered on ${status.api}` : 'no WebMCP host detected — using the built-in Agent Console'}`,
  'font-weight:bold', '',
);
