import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'ml-prod-fw-'));

async function readApiKey() {
  if (process.env.MAILLAYERS_API_KEY) return process.env.MAILLAYERS_API_KEY.trim();
  const candidates = [
    resolve(root, '../editor/.env'),
    resolve(process.cwd(), '../editor/.env'),
  ];
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, 'utf8');
      const match = text.match(/^VITE_MAILLAYERS_API_KEY=(.+)$/m);
      if (match) return match[1].trim();
    } catch {
      // try next candidate
    }
  }
  throw new Error('Set MAILLAYERS_API_KEY for production framework verification');
}

const apiKey = await readApiKey();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const open = await new Promise((resolveOpen) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolveOpen(true);
      });
      socket.on('error', () => resolveOpen(false));
    });
    if (open) return;
    await wait(250);
  }
  throw new Error(`port ${port} did not open`);
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolveOpen, reject) => {
      this.ws.addEventListener('open', () => resolveOpen());
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: resolvePending, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolvePending(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId += 1;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
    return result.result?.value;
  }

  close() {
    this.ws?.close();
  }
}

const publicDir = resolve(temporary, 'public');
await mkdir(publicDir, { recursive: true });
await build({
  entryPoints: [resolve(root, 'packages/shared/src/index.ts')],
  bundle: true,
  format: 'esm',
  outfile: resolve(publicDir, 'shared.js'),
  platform: 'browser',
});

await writeFile(resolve(publicDir, 'index.html'), `<!doctype html>
<html><body>
<div id="one" style="height:40vh"></div>
<div id="two" style="height:40vh"></div>
<script type="module">
import { createEmailEditorController } from './shared.js';
const apiKey = ${JSON.stringify(apiKey)};
globalThis.__mlOutbound = [];
const evidence = { ready: 0, inits: [], posts: [], changes: [], saves: [], authErrors: [], wildcards: 0, consoleErrors: [], statuses: [], iframeSrcs: [], outbound: [] };
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://editor.maillayers.com') return;
  if (event.data?.type === 'READY') evidence.ready += 1;
  if (event.data?.type === 'CHANGE') evidence.changes.push(event.data.payload?.html);
  if (event.data?.type === 'SAVE') evidence.saves.push(event.data.payload?.html);
  if (event.data?.type === 'AUTH_ERROR') evidence.authErrors.push(event.data.payload?.message);
});
function mount(id, html) {
  const controller = createEmailEditorController({
    apiKey,
    initialHtml: html,
    packageName: '@maillayers/vue-email-editor',
    packageVersion: '0.1.0',
    onAuthError: (message) => evidence.authErrors.push(message),
    onStatusChange: (status) => evidence.statuses.push(status + ':' + id),
  });
  controller.mount(document.getElementById(id));
  return controller;
}
window.__controllers = {
  one: mount('one', '<p>shared-one</p>'),
  two: mount('two', '<p>shared-two</p>'),
};
window.__evidence = evidence;
setInterval(() => {
  evidence.iframeSrcs = [...document.querySelectorAll('iframe')].map((frame) => frame.getAttribute('src'));
  evidence.outbound = JSON.parse(JSON.stringify(globalThis.__mlOutbound || []));
  evidence.inits = evidence.outbound.filter((entry) => entry.type === 'INIT');
  evidence.wildcards = evidence.outbound.filter((entry) => entry.targetOrigin === '*').length;
}, 100);
</script>
</body></html>`);

await writeFile(resolve(publicDir, 'invalid.html'), `<!doctype html>
<html><body><div id="host" style="height:200px"></div>
<script type="module">
import { createEmailEditorController } from './shared.js';
const evidence = { authErrors: [], iframeSrc: null };
createEmailEditorController({
  apiKey: 'ml_invalid_production_gate',
  packageName: '@maillayers/vue-email-editor',
  packageVersion: '0.1.0',
  onAuthError: (message) => { evidence.authErrors.push(message); evidence.iframeSrc = document.querySelector('iframe')?.getAttribute('src') || null; window.__invalid = evidence; },
}).mount(document.getElementById('host'));
window.__invalid = evidence;
</script></body></html>`);

const port = await freePort();
const server = createServer(async (req, res) => {
  const relative = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(resolve(publicDir, '.' + relative));
    res.writeHead(200, { 'content-type': relative.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('missing');
  }
});
await new Promise((resolveListen) => server.listen(port, 'localhost', resolveListen));

const chromePort = await freePort();
const profile = resolve(temporary, 'chrome');
await mkdir(profile, { recursive: true });
const chromePath = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome';
const chrome = spawn(chromePath, [
  `--remote-debugging-port=${chromePort}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  'about:blank',
], { stdio: 'ignore' });
await waitForPort(chromePort);

const version = await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json();
void version;
const targets = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
let page = targets.find((target) => target.type === 'page');
if (!page) {
  page = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: 'PUT' })).json();
}
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: `http://localhost:${port}/` });

async function waitFor(expression, predicate, message, timeoutMs = 60000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await cdp.evaluate(expression);
      last = value;
      if (predicate(value)) return value;
    } catch {
      // navigation/context may briefly invalidate evaluations
    }
    await wait(400);
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

const ready = await waitFor(
  'window.__evidence ? JSON.parse(JSON.stringify(window.__evidence)) : null',
  (value) => value && value.ready >= 2 && value.inits.length >= 2,
  'production READY/INIT handshake failed',
);
assert.ok(ready.inits.every((entry) => entry.targetOrigin === 'https://editor.maillayers.com'));
assert.equal(ready.wildcards, 0);
assert.equal(new Set(ready.inits.map((entry) => entry.html)).size, 2);

await cdp.evaluate('window.__controllers.one.reload()');
const reloaded = await waitFor(
  'window.__evidence ? JSON.parse(JSON.stringify(window.__evidence)) : null',
  (value) => value && value.inits.length >= 3,
  'reload did not send a fresh INIT',
);
assert.ok(reloaded.inits.every((entry) => entry.targetOrigin === 'https://editor.maillayers.com'));
assert.equal(reloaded.wildcards, 0);

await cdp.send('Page.navigate', { url: `http://localhost:${port}/invalid.html` });
const invalid = await waitFor(
  'window.__invalid ? JSON.parse(JSON.stringify(window.__invalid)) : null',
  (value) => value && value.authErrors.length > 0,
  'invalid API key did not fail closed',
);
assert.equal(invalid.iframeSrc, 'about:blank');
assert.ok(!String(invalid.authErrors[0]).includes(apiKey));

console.log('PASS\tproduction dual-editor handshake against https://editor.maillayers.com');
console.log('PASS\tINIT uses exact editor origin; no wildcard postMessage');
console.log('PASS\treload creates a fresh INIT');
console.log('PASS\tinvalid API key keeps iframe blank with sanitized errors');
console.log(JSON.stringify({
  readyCount: ready.ready,
  initCount: ready.inits.length,
  reloadInitCount: reloaded.inits.length,
  wildcards: reloaded.wildcards,
}, null, 2));

cdp.close();
chrome.kill('SIGKILL');
server.close();
await rm(temporary, { recursive: true, force: true });
