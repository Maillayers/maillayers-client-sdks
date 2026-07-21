import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { EmailBuilder } from '../dist/index.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.com/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLIFrameElement = dom.window.HTMLIFrameElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 15_000 ? 5 : delay, ...args);
const API_KEY = 'ml_asset_component';
const API_URL = 'https://api.maillayers.com/api/sdk/license/validate';
const fingerprint = createHash('sha256').update(API_KEY).digest('hex');
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  return {
    ok: true, status: 200, url: API_URL,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    text: async () => JSON.stringify({
      status: 'valid', reason: 'allowed_domain', origin: 'https://app.example.com', domain: 'app.example.com',
      requestId: request.requestId, keyFingerprint: fingerprint, organizationId: 'org-assets', licenseId: 'license-assets', plan: 'pro',
    }),
  };
};

const meta = (id) => ({ id, version: '1.0.0', sentAt: Date.now() });
const tick = async (delay = 0) => act(async () => { await new Promise((resolve) => nativeSetTimeout(resolve, delay)); });

async function mount(props = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(EmailBuilder, {
    apiKey: API_KEY, expectedOrganizationId: 'org-assets', expectedLicenseId: 'license-assets', ...props,
  })));
  for (let attempt = 0; attempt < 20 && container.querySelector('iframe')?.getAttribute('src') === 'about:blank'; attempt += 1) await tick();
  const iframe = container.querySelector('iframe');
  assert.ok(iframe);
  const posts = [];
  Object.defineProperty(iframe.contentWindow, 'postMessage', { configurable: true, value: (message, targetOrigin) => posts.push({ message, targetOrigin }) });
  const send = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    origin: 'https://editor.maillayers.com', source: iframe.contentWindow, data,
  }));
  await act(async () => iframe.dispatchEvent(new dom.window.Event('load')));
  await act(async () => send({ type: 'READY', meta: meta('ready') }));
  return { container, root, iframe, posts, send, async close() { await act(async () => root.unmount()); container.remove(); } };
}

function responseFor(session, correlationId) {
  return session.posts.findLast((entry) => entry.message.meta?.correlationId === correlationId)?.message;
}

// Missing callbacks must settle every remote request with a correlated failure.
{
  const session = await mount();
  await act(async () => {
    session.send({ type: 'UPLOAD', payload: { file: new dom.window.File(['x'], 'x.png', { type: 'image/png' }) }, meta: meta('missing-upload') });
    session.send({ type: 'LIST_ASSETS', meta: meta('missing-list') });
    session.send({ type: 'DELETE_ASSET', payload: { id: 'asset-1' }, meta: meta('missing-delete') });
    await Promise.resolve();
  });
  await tick();
  assert.equal(responseFor(session, 'missing-upload').payload.url, '');
  assert.deepEqual(responseFor(session, 'missing-list').payload.assets, []);
  assert.equal(responseFor(session, 'missing-delete').payload.success, false);
  await session.close();
}
console.log('PASS\tmissing asset callbacks return correlated failures instead of leaving requests pending');

// All malformed upload/list/delete results fail closed; valid values are copied.
{
  const uploadResults = [{}, [], '', 'javascript:alert(1)', 'vbscript:x', 'data:image/png;base64,AA==', '/relative.png', 'http://assets.example.com/x.png', 'https://assets.example.com/good.png'];
  const listResults = [
    {}, [{ url: 'https://assets.example.com/a.png' }],
    [{ id: 'a', url: 'https://assets.example.com/a.png' }, { id: 'a', url: 'https://assets.example.com/b.png' }],
    [{ id: 'a', url: 'https://assets.example.com/a.png', mimeType: 'text/html' }],
    [{ id: 'good', url: 'https://assets.example.com/good.png', mimeType: 'image/png' }],
  ];
  const deleteResults = [1, 'true', {}, true];
  const session = await mount({
    onUpload: async () => uploadResults.shift(),
    onListAssets: async () => listResults.shift(),
    onDeleteAsset: async () => deleteResults.shift(),
  });
  for (let index = 0; index < 9; index += 1) {
    const id = `upload-${index}`;
    await act(async () => { session.send({ type: 'UPLOAD', payload: { file: new dom.window.File(['x'], `${index}.png`) }, meta: meta(id) }); await Promise.resolve(); });
    await tick();
    assert.equal(responseFor(session, id).payload.url, index === 8 ? 'https://assets.example.com/good.png' : '');
  }
  for (let index = 0; index < 5; index += 1) {
    const id = `list-${index}`;
    await act(async () => { session.send({ type: 'LIST_ASSETS', payload: { limit: 10 }, meta: meta(id) }); await Promise.resolve(); });
    await tick();
    assert.equal(responseFor(session, id).payload.assets.length, index === 4 ? 1 : 0);
  }
  for (let index = 0; index < 4; index += 1) {
    const id = `delete-${index}`;
    await act(async () => { session.send({ type: 'DELETE_ASSET', payload: { id: 'asset-1' }, meta: meta(id) }); await Promise.resolve(); });
    await tick();
    assert.equal(responseFor(session, id).payload.success, index === 3);
  }
  await session.close();
}
console.log('PASS\tmalformed upload/list/delete callback results fail closed; only literal true deletes successfully');

// In-flight duplicates invoke the host once; completed retries replay the bounded cached response.
{
  let calls = 0;
  let resolveUpload;
  const pending = new Promise((resolve) => { resolveUpload = resolve; });
  const session = await mount({ onUpload: () => { calls += 1; return pending; } });
  const request = { type: 'UPLOAD', payload: { file: new dom.window.File(['x'], 'duplicate.png') }, meta: meta('duplicate-upload') };
  await act(async () => { session.send(request); session.send(request); });
  assert.equal(calls, 1);
  assert.equal(responseFor(session, 'duplicate-upload'), undefined);
  await act(async () => { resolveUpload('https://assets.example.com/duplicate.png'); await Promise.resolve(); });
  await tick();
  assert.equal(session.posts.filter((entry) => entry.message.meta?.correlationId === 'duplicate-upload').length, 1);
  await act(async () => session.send(request));
  assert.equal(calls, 1);
  assert.equal(session.posts.filter((entry) => entry.message.meta?.correlationId === 'duplicate-upload').length, 2);
  await session.close();
}
console.log('PASS\tduplicate request IDs are deduplicated in flight and safely replay bounded results');

// Reload cancels active work and suppresses a transport that resolves afterward.
{
  const editorRef = createRef();
  let context;
  let resolveUpload;
  const pending = new Promise((resolve) => { resolveUpload = resolve; });
  const session = await mount({ ref: editorRef, onUpload: (_file, nextContext) => { context = nextContext; return pending; } });
  await act(async () => session.send({ type: 'UPLOAD', payload: { file: new dom.window.File(['x'], 'late.png') }, meta: meta('late-upload') }));
  await act(async () => editorRef.current.reload());
  assert.equal(context.signal.aborted, true);
  await act(async () => { resolveUpload('https://assets.example.com/late.png'); await Promise.resolve(); });
  await tick();
  assert.equal(responseFor(session, 'late-upload'), undefined, 'late result from the prior handshake must be suppressed');
  await session.close();
}
console.log('PASS\treload cancels active callbacks and suppresses late results from the prior handshake');

// Timeout aborts the callback context and still sends failure. Concurrency is capped at four.
{
  let timeoutContext;
  const never = new Promise(() => {});
  const session = await mount({ onUpload: (_file, context) => { timeoutContext = context; return never; } });
  await act(async () => session.send({ type: 'UPLOAD', payload: { file: new dom.window.File(['x'], 'timeout.png') }, meta: meta('timeout-upload') }));
  await tick(10);
  assert.equal(timeoutContext.signal.aborted, true);
  assert.equal(responseFor(session, 'timeout-upload').payload.url, '');
  await session.close();
}

{
  const contexts = [];
  const never = new Promise(() => {});
  const session = await mount({ onListAssets: (_payload, context) => { contexts.push(context); return never; } });
  await act(async () => {
    for (let index = 0; index < 5; index += 1) session.send({ type: 'LIST_ASSETS', meta: meta(`concurrent-${index}`) });
  });
  assert.equal(contexts.length, 4, 'only four host asset operations may run concurrently');
  assert.deepEqual(responseFor(session, 'concurrent-4').payload.assets, []);
  await session.close();
  assert.equal(contexts.every((context) => context.signal.aborted), true, 'unmount must cancel every active operation');
}
console.log('PASS\tasset requests time out with correlated failure, expose cancellation signals, and enforce concurrency four');

globalThis.fetch = originalFetch;
globalThis.setTimeout = nativeSetTimeout;
dom.window.close();
