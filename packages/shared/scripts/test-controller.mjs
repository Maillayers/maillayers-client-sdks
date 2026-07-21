import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(new URL('..', import.meta.url).pathname);
const outDir = resolve(root, '.test-dist');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2019',
  outfile: resolve(outDir, 'shared.mjs'),
});

// SSR safety: importing the module before any browser global exists must not throw.
assert.equal(typeof globalThis.window, 'undefined', 'test must import before window is defined');
const shared = await import(pathToFileURL(resolve(outDir, 'shared.mjs')).href);
const { createEmailEditorController, deriveAllowedOrigin, EMAIL_BUILDER_PROTOCOL_VERSION } = shared;
assert.equal(typeof createEmailEditorController, 'function');
assert.equal(EMAIL_BUILDER_PROTOCOL_VERSION, '1.0.0');
console.log('PASS\tmodule import is SSR-safe (no browser globals at module evaluation)');

// Exact origin derivation for localhost and production.
assert.equal(deriveAllowedOrigin('http://localhost:5173'), 'http://localhost:5173');
assert.equal(deriveAllowedOrigin('https://editor.maillayers.com'), 'https://editor.maillayers.com');
assert.throws(() => deriveAllowedOrigin('http://insecure.example.com'));
assert.throws(() => deriveAllowedOrigin('https://editor.maillayers.com', 'https://evil.example.com'));
console.log('PASS\texact localhost and production origins derive; mismatched overrides fail closed');

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.com/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLIFrameElement = dom.window.HTMLIFrameElement;
globalThis.MessageEvent = dom.window.MessageEvent;

const ORIGIN = 'https://app.example.com';
const EDITOR_ORIGIN = 'https://editor.maillayers.com';
const PKG = { packageName: '@maillayers/test-editor', packageVersion: '0.1.0' };
const meta = (id, extra = {}) => ({ id, version: '1.0.0', sentAt: Date.now(), ...extra });
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));
async function waitFor(predicate, message, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

const originalFetch = globalThis.fetch;
function successfulResponse(url, options) {
  const body = JSON.parse(options.body);
  const key = options.headers['x-api-key'];
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({
      status: 'valid', reason: 'allowed_domain', origin: ORIGIN, domain: 'app.example.com',
      requestId: body.requestId, keyFingerprint: createHash('sha256').update(key).digest('hex'),
      organizationId: 'org-shared', licenseId: 'license-shared', plan: 'pro',
    }),
  };
}

function fixture(options = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const events = { changes: [], loads: [], saves: [], statuses: [], authErrors: [], readies: 0 };
  const controller = createEmailEditorController({
    apiKey: 'ml_shared_test',
    onChange: (html) => events.changes.push(html),
    onLoad: (html) => events.loads.push(html),
    onSave: (html) => events.saves.push(html),
    onStatusChange: (status) => events.statuses.push(status),
    onAuthError: (message) => events.authErrors.push(message),
    onReady: () => { events.readies += 1; },
    ...PKG,
    ...options,
  });
  return {
    host, controller, events,
    iframe: () => host.querySelector('iframe'),
    overlay: () => [...host.querySelectorAll('div')].at(-1),
    close() { controller.destroy(); host.remove(); },
  };
}

function interceptPosts(iframe) {
  const posts = [];
  Object.defineProperty(iframe.contentWindow, 'postMessage', {
    configurable: true,
    value: (message, targetOrigin) => posts.push({ message, targetOrigin }),
  });
  return posts;
}

const send = (iframe, data, origin = EDITOR_ORIGIN, source) =>
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    origin,
    source: source === undefined ? iframe?.contentWindow : source,
    data,
  }));

async function readyFixture(options = {}) {
  const session = fixture(options);
  session.controller.mount(session.host);
  await waitFor(() => session.iframe()?.getAttribute('src') !== 'about:blank', 'license validation did not unlock the iframe');
  const posts = interceptPosts(session.iframe());
  session.iframe().dispatchEvent(new dom.window.Event('load'));
  send(session.iframe(), { type: 'READY', meta: meta('ready-1') });
  await tick();
  return { ...session, posts };
}

// 1. License validation failure keeps the iframe blank and fails closed.
{
  globalThis.fetch = async () => ({
    ok: false, status: 401, url: 'https://api.maillayers.com/api/sdk/license/validate',
    headers: { get: () => 'application/json' }, text: async () => '{}',
  });
  const session = fixture();
  session.controller.mount(session.host);
  await waitFor(() => session.events.authErrors.length === 1, 'invalid key did not fail closed');
  assert.equal(session.iframe().getAttribute('src'), 'about:blank', 'iframe must stay blank on failed validation');
  assert.equal(session.controller.status, 'error');
  assert.match(session.events.authErrors[0], /license validation failed \(401\)/);
  assert.ok(!session.events.authErrors[0].includes('ml_shared_test'), 'errors must not contain the raw API key');
  session.close();
}
console.log('PASS\tinvalid API key fails closed with sanitized error and blank iframe');

// 2. Invalid props fail closed without any network call.
{
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('unexpected'); };
  const session = fixture({ src: 'http://insecure.example.com' });
  session.controller.mount(session.host);
  await tick();
  assert.equal(fetches, 0, 'invalid src must not trigger validation');
  assert.equal(session.controller.status, 'error');
  assert.equal(session.iframe().getAttribute('src'), 'about:blank');
  session.close();

  const missingKey = fixture({ apiKey: undefined });
  missingKey.controller.mount(missingKey.host);
  await tick();
  assert.equal(missingKey.controller.status, 'error');
  missingKey.close();
}
console.log('PASS\tinvalid src and missing apiKey fail closed before any network activity');

// 3. Successful handshake: eager INIT on load, READY exactly once, exact target origins.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const session = await readyFixture({ initialHtml: '<p>hello</p>' });
  const inits = session.posts.filter((entry) => entry.message.type === 'INIT');
  assert.equal(inits.length, 1, 'INIT must be sent exactly once per handshake');
  assert.equal(inits[0].targetOrigin, EDITOR_ORIGIN, 'INIT must use the exact editor origin');
  assert.equal(inits[0].message.payload.html, '<p>hello</p>');
  assert.equal(inits[0].message.meta.version, EMAIL_BUILDER_PROTOCOL_VERSION);
  assert.equal(session.controller.status, 'ready');
  assert.equal(session.events.readies, 1);
  send(session.iframe(), { type: 'READY', meta: meta('ready-2') });
  await tick();
  assert.equal(session.posts.filter((entry) => entry.message.type === 'INIT').length, 1, 'duplicate READY must not resend INIT');
  assert.equal(session.events.readies, 1, 'duplicate READY must not re-fire onReady');
  assert.ok(session.posts.every((entry) => entry.targetOrigin === EDITOR_ORIGIN), 'no wildcard or foreign postMessage targets');
  assert.equal(session.overlay().style.display, 'none', 'overlay must hide once ready');
  session.close();
}
console.log('PASS\tREADY/INIT are exact-once with exact target origins and hidden overlay');

// 4. Wrong origin, wrong window, malformed meta, and bad protocol versions are ignored.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const session = await readyFixture();
  const before = session.events.changes.length;
  send(session.iframe(), { type: 'CHANGE', payload: { html: 'evil' }, meta: meta('evil-1') }, 'https://evil.example.com');
  send(session.iframe(), { type: 'CHANGE', payload: { html: 'evil' }, meta: meta('evil-2') }, EDITOR_ORIGIN, dom.window);
  send(session.iframe(), { type: 'CHANGE', payload: { html: 'evil' }, meta: { id: 'evil-3', version: '9.9.9', sentAt: Date.now() } });
  send(session.iframe(), { type: 'CHANGE', payload: { html: 'evil' }, meta: { id: 'evil-4' } });
  send(session.iframe(), { type: 'CHANGE', payload: { html: 12 }, meta: meta('evil-5') });
  send(session.iframe(), { type: 'NOT_A_TYPE', payload: {}, meta: meta('evil-6') });
  send(session.iframe(), 'just a string');
  await tick();
  assert.equal(session.events.changes.length, before, 'malformed or untrusted messages must be ignored');
  send(session.iframe(), { type: 'CHANGE', payload: { html: '<p>real</p>' }, meta: meta('real-1') });
  await tick();
  assert.deepEqual(session.events.changes, ['<p>real</p>']);
  session.close();
}
console.log('PASS\twrong origin/window, malformed meta, and bad versions are ignored without throwing');

// 5. CHANGE/LOADED/SAVE/STATUS/AUTH_ERROR dispatch, callback throws stay contained.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const session = await readyFixture({
    onChange: () => { throw new Error('host bug'); },
  });
  send(session.iframe(), { type: 'CHANGE', payload: { html: '<p>x</p>' }, meta: meta('c1') });
  send(session.iframe(), { type: 'LOADED', payload: { html: '<p>loaded</p>' }, meta: meta('l1') });
  send(session.iframe(), { type: 'SAVE', payload: { html: '<p>saved</p>' }, meta: meta('s1') });
  send(session.iframe(), { type: 'STATUS', payload: { status: 'loading' }, meta: meta('st1') });
  send(session.iframe(), { type: 'AUTH_ERROR', payload: { message: 'builder rejected token' }, meta: meta('a1') });
  await tick();
  assert.deepEqual(session.events.loads, ['<p>loaded</p>']);
  assert.deepEqual(session.events.saves, ['<p>saved</p>']);
  assert.equal(session.controller.status, 'error');
  assert.deepEqual(session.events.authErrors, ['builder rejected token']);
  session.close();
}
console.log('PASS\tCHANGE/LOADED/SAVE/STATUS/AUTH_ERROR dispatch and a throwing callback is contained');

// 6. Upload/list/delete correlation, HTTPS-only results, invalid results fail closed.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const session = await readyFixture({
    onUpload: async (file, context) => {
      assert.equal(typeof context.requestId, 'string');
      assert.ok(context.signal instanceof dom.window.AbortSignal || typeof context.signal.aborted === 'boolean');
      return file.name === 'good.png' ? 'https://cdn.example.com/good.png' : 'http://cdn.example.com/insecure.png';
    },
    onListAssets: async () => [{ id: 'a1', url: 'https://cdn.example.com/a1.png' }],
    onDeleteAsset: async (payload) => payload.id === 'a1',
  });
  const file = new dom.window.File(['x'], 'good.png', { type: 'image/png' });
  send(session.iframe(), { type: 'UPLOAD', payload: { file }, meta: meta('up-1') });
  await waitFor(() => session.posts.some((entry) => entry.message.type === 'UPLOAD_SUCCESS'), 'upload response missing');
  const upload = session.posts.find((entry) => entry.message.type === 'UPLOAD_SUCCESS');
  assert.equal(upload.message.meta.correlationId, 'up-1', 'upload response must correlate to the request');
  assert.equal(upload.message.payload.url, 'https://cdn.example.com/good.png');

  const badFile = new dom.window.File(['x'], 'bad.png', { type: 'image/png' });
  send(session.iframe(), { type: 'UPLOAD', payload: { file: badFile }, meta: meta('up-2') });
  await waitFor(() => session.posts.filter((entry) => entry.message.type === 'UPLOAD_SUCCESS').length === 2, 'second upload response missing');
  const insecure = session.posts.filter((entry) => entry.message.type === 'UPLOAD_SUCCESS')[1];
  assert.equal(insecure.message.payload.url, '', 'non-HTTPS upload results must fail closed');

  send(session.iframe(), { type: 'LIST_ASSETS', payload: { limit: 10 }, meta: meta('list-1') });
  await waitFor(() => session.posts.some((entry) => entry.message.type === 'ASSETS_LIST'), 'assets list missing');
  const list = session.posts.find((entry) => entry.message.type === 'ASSETS_LIST');
  assert.equal(list.message.meta.correlationId, 'list-1');
  assert.deepEqual(list.message.payload.assets, [{ id: 'a1', url: 'https://cdn.example.com/a1.png' }]);

  send(session.iframe(), { type: 'DELETE_ASSET', payload: { id: 'a1' }, meta: meta('del-1') });
  await waitFor(() => session.posts.some((entry) => entry.message.type === 'DELETE_ASSET_SUCCESS'), 'delete response missing');
  const deletion = session.posts.find((entry) => entry.message.type === 'DELETE_ASSET_SUCCESS');
  assert.equal(deletion.message.meta.correlationId, 'del-1');
  assert.equal(deletion.message.payload.success, true);
  session.close();
}
console.log('PASS\tupload/list/delete stay correlated with HTTPS-only, fail-closed results');

// 7. Missing asset callbacks produce controlled failures.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const session = await readyFixture();
  const file = new dom.window.File(['x'], 'a.png', { type: 'image/png' });
  send(session.iframe(), { type: 'UPLOAD', payload: { file }, meta: meta('up-missing') });
  send(session.iframe(), { type: 'LIST_ASSETS', meta: meta('list-missing') });
  send(session.iframe(), { type: 'DELETE_ASSET', payload: { id: 'x' }, meta: meta('del-missing') });
  await waitFor(() => session.posts.filter((entry) => ['UPLOAD_SUCCESS', 'ASSETS_LIST', 'DELETE_ASSET_SUCCESS'].includes(entry.message.type)).length === 3, 'controlled failures missing');
  assert.equal(session.posts.find((entry) => entry.message.type === 'UPLOAD_SUCCESS').message.payload.url, '');
  assert.deepEqual(session.posts.find((entry) => entry.message.type === 'ASSETS_LIST').message.payload.assets, []);
  assert.equal(session.posts.find((entry) => entry.message.type === 'DELETE_ASSET_SUCCESS').message.payload.success, false);
  session.close();
}
console.log('PASS\tmissing asset callbacks return controlled protocol failures');

// 8. Handshake timeout fails closed.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const timers = [];
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 12000) { timers.push(callback); return 987654; }
    return nativeSetTimeout(callback, delay, ...args);
  };
  const session = fixture();
  session.controller.mount(session.host);
  await waitFor(() => session.iframe()?.getAttribute('src') !== 'about:blank', 'timeout fixture did not validate');
  interceptPosts(session.iframe());
  session.iframe().dispatchEvent(new dom.window.Event('load'));
  assert.equal(timers.length, 1, 'load must arm exactly one handshake timer');
  timers[0]();
  await tick();
  assert.equal(session.controller.status, 'error');
  assert.deepEqual(session.events.authErrors, ['Builder handshake failed or authentication was rejected.']);
  globalThis.setTimeout = nativeSetTimeout;
  session.close();
}
console.log('PASS\thandshake timeout fails closed with the sanitized SDK error');

// 9. reload() runs a fresh exact-once handshake and applies staged content.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const session = await readyFixture({ initialHtml: '<p>first</p>' });
  session.controller.stageContentUpdate({ initialHtml: '<p>second</p>' });
  assert.equal(session.posts.filter((entry) => entry.message.type === 'INIT').length, 1, 'staging content must not touch the live editor');
  session.controller.reload();
  const iframe = session.iframe();
  assert.notEqual(iframe, null, 'reload must create a fresh iframe');
  const reloadPosts = interceptPosts(iframe);
  iframe.dispatchEvent(new dom.window.Event('load'));
  send(iframe, { type: 'READY', meta: meta('ready-reload') });
  await tick();
  const inits = reloadPosts.filter((entry) => entry.message.type === 'INIT');
  assert.equal(inits.length, 1, 'reload must produce exactly one INIT');
  assert.equal(inits[0].message.payload.html, '<p>second</p>', 'reload must apply staged content');
  assert.equal(session.controller.status, 'ready');
  session.close();
}
console.log('PASS\treload creates one fresh handshake and applies staged content only then');

// 10. destroy() prevents any further posts or callback invocations.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const session = await readyFixture();
  const postsBefore = session.posts.length;
  const iframe = session.iframe();
  session.controller.destroy();
  assert.equal(session.host.querySelector('iframe'), null, 'destroy must remove the iframe');
  send(iframe, { type: 'CHANGE', payload: { html: '<p>late</p>' }, meta: meta('late-1') });
  const file = new dom.window.File(['x'], 'late.png', { type: 'image/png' });
  send(iframe, { type: 'UPLOAD', payload: { file }, meta: meta('late-2') });
  await tick();
  assert.equal(session.events.changes.length, 0, 'late messages after destroy must be ignored');
  assert.equal(session.posts.length, postsBefore, 'no postMessage after destroy');
  session.controller.destroy();
  session.host.remove();
}
console.log('PASS\tdestroy is idempotent, removes DOM, and suppresses late messages and posts');

// 11. Two controllers stay source-isolated.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const one = await readyFixture({ initialHtml: '<p>one</p>' });
  const two = await readyFixture({ initialHtml: '<p>two</p>' });
  send(one.iframe(), { type: 'CHANGE', payload: { html: '<p>from-one</p>' }, meta: meta('iso-1') });
  await tick();
  assert.deepEqual(one.events.changes, ['<p>from-one</p>']);
  assert.deepEqual(two.events.changes, [], 'messages from one iframe must not reach the other controller');
  const oneInit = one.posts.find((entry) => entry.message.type === 'INIT');
  const twoInit = two.posts.find((entry) => entry.message.type === 'INIT');
  assert.equal(oneInit.message.payload.html, '<p>one</p>');
  assert.equal(twoInit.message.payload.html, '<p>two</p>');
  one.close();
  two.close();
}
console.log('PASS\ttwo simultaneous controllers remain fully isolated');

// 12. Stale license responses cannot authorize a destroyed controller.
{
  let resolvePending;
  globalThis.fetch = (url, options) => new Promise((resolveFetch) => {
    resolvePending = () => resolveFetch(successfulResponse(url, options));
  });
  const session = fixture();
  session.controller.mount(session.host);
  await waitFor(() => typeof resolvePending === 'function', 'pending validation did not start');
  session.controller.destroy();
  resolvePending();
  await tick();
  await tick();
  assert.notEqual(session.controller.status, 'ready');
  assert.equal(session.host.querySelector('iframe'), null);
  session.host.remove();
}
console.log('PASS\tstale license responses cannot authorize after destroy');

globalThis.fetch = originalFetch;
await rm(outDir, { recursive: true, force: true });
console.log('shared controller suite passed');
