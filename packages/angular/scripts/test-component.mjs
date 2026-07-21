import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  outfile: resolve(outDir, 'angular-sdk.mjs'),
  external: [
    '@angular/core',
    '@angular/common',
    '@angular/compiler',
    'rxjs',
    'rxjs/operators',
  ],
  define: { __MAILLAYERS_PACKAGE_VERSION__: JSON.stringify('0.1.0') },
});
const sdkUrl = pathToFileURL(resolve(outDir, 'angular-sdk.mjs')).href;
const ssr = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  assert.equal(typeof globalThis.window, 'undefined');
  const mod = await import(${JSON.stringify(sdkUrl)});
  assert.equal(typeof mod.MailLayersEmailEditorComponent, 'function');
  assert.equal(typeof mod.MailLayersEmailEditorModule, 'function');
  assert.equal(typeof mod.validateMailLayersLicense, 'function');
`], { encoding: 'utf8' });
if (ssr.status !== 0) throw new Error(`SSR import failed\n${ssr.stdout}\n${ssr.stderr}`);
console.log('PASS\tAngular SDK import is SSR-safe');

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.com/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLIFrameElement = dom.window.HTMLIFrameElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.MessageEvent = dom.window.MessageEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const {
  MailLayersEmailEditorComponent,
} = await import(sdkUrl);

const ORIGIN = 'https://app.example.com';
const EDITOR_ORIGIN = 'https://editor.maillayers.com';
const meta = (id) => ({ id, version: '1.0.0', sentAt: Date.now() });
const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(predicate, message, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

function successfulResponse(url, options) {
  const body = JSON.parse(options.body);
  const key = options.headers['x-api-key'];
  assert.equal(body.packageName, '@maillayers/angular-email-editor');
  assert.equal(body.packageVersion, '0.1.0');
  return {
    ok: true, status: 200, url,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({
      status: 'valid', reason: 'allowed_domain', origin: ORIGIN, domain: 'app.example.com',
      requestId: body.requestId, keyFingerprint: createHash('sha256').update(key).digest('hex'),
      organizationId: 'org-angular', licenseId: 'license-angular', plan: 'pro',
    }),
  };
}

const originalFetch = globalThis.fetch;

function mount(props = {}, handlers = {}) {
  const host = document.createElement('div');
  const inner = document.createElement('div');
  host.append(inner);
  document.body.append(host);
  const component = new MailLayersEmailEditorComponent();
  Object.assign(component, { apiKey: 'ml_angular_test', ...props });
  component.hostRef = { nativeElement: inner };
  for (const [event, handler] of Object.entries(handlers)) {
    component[event].subscribe(handler);
  }
  component.ngAfterViewInit();
  return {
    host,
    component,
    iframe: () => host.querySelector('iframe'),
    close() {
      component.ngOnDestroy();
      host.remove();
    },
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
  dom.window.dispatchEvent(new MessageEvent('message', {
    origin,
    source: source === undefined ? iframe?.contentWindow : source,
    data,
  }));

async function readyMount(props = {}, handlers = {}) {
  const session = mount(props, handlers);
  await waitFor(() => session.iframe()?.getAttribute('src') !== 'about:blank', 'angular license did not unlock iframe');
  const posts = interceptPosts(session.iframe());
  session.iframe().dispatchEvent(new dom.window.Event('load'));
  send(session.iframe(), { type: 'READY', meta: meta('ready-1') });
  await tick();
  return { ...session, posts };
}

{
  globalThis.fetch = async () => ({
    ok: false, status: 401, url: 'https://api.maillayers.com/api/sdk/license/validate',
    headers: { get: () => 'application/json' }, text: async () => '{}',
  });
  const auth = [];
  const session = mount({}, { authError: (message) => auth.push(message) });
  await waitFor(() => auth.length === 1, 'angular invalid key did not authError');
  assert.equal(session.iframe().getAttribute('src'), 'about:blank');
  session.close();
}
console.log('PASS\tAngular invalid API key keeps iframe blank');

{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const events = { changes: [], saves: [], readies: 0 };
  const session = await readyMount(
    { initialHtml: '<p>angular</p>' },
    {
      change: (html) => events.changes.push(html),
      save: (html) => events.saves.push(html),
      ready: () => { events.readies += 1; },
    },
  );
  const inits = session.posts.filter((entry) => entry.message.type === 'INIT');
  assert.equal(inits.length, 1);
  assert.equal(inits[0].targetOrigin, EDITOR_ORIGIN);
  assert.equal(inits[0].message.payload.html, '<p>angular</p>');
  assert.equal(events.readies, 1);
  send(session.iframe(), { type: 'CHANGE', payload: { html: '<p>edited</p>' }, meta: meta('c1') });
  send(session.iframe(), { type: 'SAVE', payload: { html: '<p>saved</p>' }, meta: meta('s1') });
  await tick();
  assert.deepEqual(events.changes, ['<p>edited</p>']);
  assert.deepEqual(events.saves, ['<p>saved</p>']);
  send(session.iframe(), { type: 'CHANGE', payload: { html: 'evil' }, meta: meta('evil') }, 'https://evil.example.com');
  await tick();
  assert.equal(events.changes.length, 1);
  session.component.reload();
  await waitFor(() => session.iframe()?.getAttribute('src') !== 'about:blank', 'reload did not remount iframe');
  const reloadPosts = interceptPosts(session.iframe());
  session.iframe().dispatchEvent(new dom.window.Event('load'));
  send(session.iframe(), { type: 'READY', meta: meta('ready-reload') });
  await tick();
  assert.equal(reloadPosts.filter((entry) => entry.message.type === 'INIT').length, 1);
  assert.ok(reloadPosts.every((entry) => entry.targetOrigin === EDITOR_ORIGIN));
  session.close();
}
console.log('PASS\tAngular handshake, CHANGE/SAVE, wrong-origin rejection, and reload');

{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const oneEvents = { changes: [] };
  const twoEvents = { changes: [] };
  const one = await readyMount({ initialHtml: '<p>one</p>' }, { change: (html) => oneEvents.changes.push(html) });
  const two = await readyMount({ initialHtml: '<p>two</p>' }, { change: (html) => twoEvents.changes.push(html) });
  send(one.iframe(), { type: 'CHANGE', payload: { html: '<p>from-one</p>' }, meta: meta('iso') });
  await tick();
  assert.deepEqual(oneEvents.changes, ['<p>from-one</p>']);
  assert.deepEqual(twoEvents.changes, []);
  const iframe = one.iframe();
  one.close();
  send(iframe, { type: 'CHANGE', payload: { html: '<p>late</p>' }, meta: meta('late') });
  await tick();
  assert.deepEqual(oneEvents.changes, ['<p>from-one</p>']);
  two.close();
}
console.log('PASS\tAngular multiple instances stay isolated; late messages after destroy are ignored');

globalThis.fetch = originalFetch;
await rm(outDir, { recursive: true, force: true });
console.log('angular component suite passed');
