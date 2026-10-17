// Actual service-worker source in a deterministic VM with browser/SDK doubles.
// No production traffic. Validates routing and sender checks, not browser exploitability.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const handlers = new Map(); const logs = [];
const context = vm.createContext({
  URL, URLSearchParams, Response, Request, Headers, TextEncoder, TextDecoder,
  Uint8Array, setTimeout, clearTimeout, crypto: globalThis.crypto, console,
  location: { origin: 'https://preview.audit.invalid' },
  addEventListener(type, callback) { handlers.set(type, callback); },
  clients: { async matchAll() { return [{ id: 'control-a' }, { id: 'control-b' }, { id: 'untrusted-page' }]; }, async get(id) { return { postMessage(m) { logs.push({ destination: id, message: m }); } }; } },
});
vm.runInContext(fs.readFileSync(path.join(root, 'pad/preview/sw.js'), 'utf8'), context);
function message(data, source, ports = []) { handlers.get('message')({ data, source: { id: source }, ports, waitUntil(p) { return p; } }); }
function register(session) {
  let receive; const id = 'route-' + session;
  const port = {
    addEventListener(_type, fn) { receive = fn; }, start() {}, close() {},
    postMessage(m) { if (m.type === 'wasmer-sdk:http-request') queueMicrotask(() => receive({ data: { type: 'wasmer-sdk:http-response', serverId: id, requestId: m.requestId, status: 200, headers: [['content-type', 'text/plain']], body: [...new TextEncoder().encode('private response from ' + session)] } })); },
  };
  message({ type: 'wasmer-sdk:http-register', serverId: id }, 'control-' + session, [port]);
  message({ type: 'pad-preview:route', session, serverId: id, guest: 5000, padOrigin: 'https://code.audit.invalid' }, 'control-' + session);
  message({ type: 'pad-preview:front', session, guest: 5000 }, 'control-' + session);
}
async function navigate(clientId, resultingClientId) {
  let response;
  const request = new Request('https://preview.audit.invalid/private');
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  Object.defineProperty(request, 'destination', { value: 'iframe' });
  handlers.get('fetch')({ request, clientId, resultingClientId, respondWith(p) { response = p; } });
  return (await response).text();
}
(async () => {
  register('a');
  const initial = await navigate('', 'page-a');
  assert.equal(initial, 'private response from a');
  register('b');
  const afterOtherPadOpened = await navigate('page-a', 'page-a-next');
  assert.equal(afterOtherPadOpened, 'private response from b');
  const before = vm.runInContext("sessions.get('a').control", context);
  message({ type: 'pad-preview:front', session: 'a', guest: 5000 }, 'untrusted-page');
  const after = vm.runInContext("sessions.get('a').control", context);
  assert.equal(before, 'control-a'); assert.equal(after, 'untrusted-page');
  const results = [
    { test: 'navigation from pad A goes to latest active pad B', observed: { initial, afterOtherPadOpened } },
    { test: 'ordinary preview page can replace control recipient', observed: { before, after } },
  ];
  for (const row of results) console.log(JSON.stringify(row));
  fs.writeFileSync(path.join(__dirname, 'preview-session-repros.json'), JSON.stringify(results, null, 2) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
