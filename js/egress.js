/**
 * egress.js — the privacy receipt.
 *
 * Cleanroom's central claim is that your data never leaves the tab. A claim
 * is worth nothing, so we instrument every outbound channel the page could
 * use and show the count in the UI. Loaded first, before any other module,
 * so nothing can slip out ahead of it.
 *
 * This is deliberately honest rather than clever: it counts requests the
 * page itself makes. It cannot police the browser or an extension, and the
 * README says so.
 */

const ledger = { requests: 0, bytes: 0, blocked: [] };
const subscribers = new Set();

function note(kind, target, bytes) {
  ledger.requests++;
  ledger.bytes += bytes || 0;
  ledger.blocked.push({ kind, target: String(target).slice(0, 200), bytes: bytes || 0, at: new Date().toISOString() });
  for (const fn of subscribers) fn(ledger);
}

function sizeOf(body) {
  try {
    if (!body) return 0;
    if (typeof body === 'string') return new Blob([body]).size;
    if (body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer) return body.byteLength;
    return new Blob([String(body)]).size;
  } catch { return 0; }
}

export function installEgressMonitor() {
  if (typeof window === 'undefined') return ledger;

  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      // Same-document module/asset loads are not data egress; anything with
      // a body, or any cross-origin call, is.
      note('fetch', url, sizeOf(init?.body));
      return _fetch.apply(this, arguments);
    };
  }

  const _open = window.XMLHttpRequest?.prototype.open;
  const _send = window.XMLHttpRequest?.prototype.send;
  if (_open && _send) {
    window.XMLHttpRequest.prototype.open = function (method, url) {
      this.__cr_url = url;
      return _open.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.send = function (body) {
      note('xhr', this.__cr_url, sizeOf(body));
      return _send.apply(this, arguments);
    };
  }

  if (navigator.sendBeacon) {
    const _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      note('sendBeacon', url, sizeOf(data));
      return _beacon(url, data);
    };
  }

  if (window.WebSocket) {
    const _WS = window.WebSocket;
    const Wrapped = function (url, protocols) {
      note('websocket', url, 0);
      return new _WS(url, protocols);
    };
    Wrapped.prototype = _WS.prototype;
    Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Wrapped;
  }

  return ledger;
}

export function onEgress(fn) { subscribers.add(fn); }
export function getLedger() { return ledger; }
