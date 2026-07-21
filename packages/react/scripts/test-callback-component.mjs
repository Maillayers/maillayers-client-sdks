import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import React, { act, useState } from 'react';
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

const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 15_000 ? 5 : delay, ...args);

const API_KEY = 'ml_live_synthetic_callbacks';
const fingerprint = createHash('sha256').update(API_KEY).digest('hex');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options = {}) => {
  const request = JSON.parse(options.body ?? '{}');
  return {
    ok: true,
    status: 200,
    url: 'https://api.maillayers.com/api/sdk/license/validate',
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    text: async () => JSON.stringify({
      status: 'valid', reason: 'allowed_domain', origin: 'https://app.example.com', domain: 'app.example.com',
      requestId: request.requestId, keyFingerprint: fingerprint, organizationId: 'org-callback',
      licenseId: 'license-callback', plan: 'pro',
    }),
  };
};

const meta = (id) => ({ id, correlationId: '', version: '1.0.0', sentAt: Date.now() });
async function tick(delay = 0) { await act(async () => { await new Promise((resolve) => nativeSetTimeout(resolve, delay)); }); }

async function mount(callbackFactory = () => ({}), elementFactory) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const controls = { root, didUnmount: false, send: () => {} };
  const callbacks = callbackFactory(controls);
  await act(async () => {
    root.render(elementFactory
      ? elementFactory(controls)
      : React.createElement(EmailBuilder, {
          apiKey: API_KEY,
          expectedOrganizationId: 'org-callback',
          expectedLicenseId: 'license-callback',
          ...callbacks,
        }));
  });
  for (let attempt = 0; attempt < 10 && container.querySelector('iframe')?.getAttribute('src') === 'about:blank'; attempt += 1) await tick();
  const iframe = container.querySelector('iframe');
  assert.ok(iframe);
  const posts = [];
  Object.defineProperty(iframe.contentWindow, 'postMessage', { configurable: true, value: (message, targetOrigin) => posts.push({ message, targetOrigin }) });
  controls.send = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    origin: 'https://editor.maillayers.com', source: iframe.contentWindow, data,
  }));
  await act(async () => { iframe.dispatchEvent(new dom.window.Event('load')); });
  return {
    controls, container, iframe, posts,
    send: controls.send,
    async cleanup() {
      if (!controls.didUnmount) await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

function allCallbackMessages(session) {
  session.send({ type: 'READY', meta: meta('ready') });
  session.send({ type: 'CHANGE', payload: { html: '<p>change</p>' }, meta: meta('change') });
  session.send({ type: 'LOADED', payload: { html: '<p>loaded</p>' }, meta: meta('load') });
  session.send({ type: 'SAVE', payload: { html: '<p>save</p>' }, meta: meta('save') });
  session.send({ type: 'UPLOAD', payload: { file: new dom.window.File(['x'], 'x.png', { type: 'image/png' }) }, meta: meta('upload') });
  session.send({ type: 'LIST_ASSETS', payload: { limit: 10 }, meta: meta('list') });
  session.send({ type: 'DELETE_ASSET', payload: { id: 'asset-1' }, meta: meta('delete') });
  session.send({ type: 'AUTH_ERROR', payload: { message: 'synthetic auth error' }, meta: meta('auth') });
}

const callbackNames = ['onReady', 'onStatusChange', 'onChange', 'onLoad', 'onSave', 'onAuthError', 'onUpload', 'onListAssets', 'onDeleteAsset'];
const unhandled = [];
const onUnhandled = (reason) => { unhandled.push(reason); };
process.on('unhandledRejection', onUnhandled);

for (const mode of ['throw', 'reject']) {
  const counts = Object.fromEntries(callbackNames.map((name) => [name, 0]));
  const session = await mount(() => Object.fromEntries(callbackNames.map((name) => [name, () => {
    counts[name] += 1;
    if (mode === 'throw') throw new Error(`${name} sync failure`);
    return Promise.reject(new Error(`${name} async failure`));
  }])));
  await act(async () => { allCallbackMessages(session); await Promise.resolve(); });
  await tick(10);
  for (const name of callbackNames) assert.ok(counts[name] >= 1, `${mode}: ${name} should run`);
  for (const type of ['UPLOAD_SUCCESS', 'ASSETS_LIST', 'DELETE_ASSET_SUCCESS']) assert.ok(session.posts.some((entry) => entry.message.type === type), `${mode}: ${type}`);
  const changeCount = counts.onChange;
  await act(async () => { session.send({ type: 'CHANGE', payload: { html: '<p>subsequent</p>' }, meta: meta('change-2') }); });
  assert.equal(counts.onChange, changeCount + 1, `${mode}: subsequent messages must continue`);
  await session.cleanup();
}
await tick();
assert.equal(unhandled.length, 0);

const neverCounts = Object.fromEntries(callbackNames.map((name) => [name, 0]));
const never = new Promise(() => {});
const neverSession = await mount(() => Object.fromEntries(callbackNames.map((name) => [name, () => { neverCounts[name] += 1; return never; }])));
await act(async () => { allCallbackMessages(neverSession); });
await tick(20);
for (const name of callbackNames) assert.ok(neverCounts[name] >= 1, `never: ${name} should run without blocking dispatch`);
for (const type of ['UPLOAD_SUCCESS', 'ASSETS_LIST', 'DELETE_ASSET_SUCCESS']) assert.ok(neverSession.posts.some((entry) => entry.message.type === type), `never: timed-out ${type}`);
await neverSession.cleanup();

const triggerByName = {
  onReady: (session) => session.send({ type: 'READY', meta: meta('ready-unmount') }),
  onStatusChange: (session) => session.send({ type: 'READY', meta: meta('status-unmount') }),
  onChange: (session) => session.send({ type: 'CHANGE', payload: { html: 'x' }, meta: meta('change-unmount') }),
  onLoad: (session) => session.send({ type: 'LOADED', payload: { html: 'x' }, meta: meta('load-unmount') }),
  onSave: (session) => session.send({ type: 'SAVE', payload: { html: 'x' }, meta: meta('save-unmount') }),
  onAuthError: (session) => session.send({ type: 'AUTH_ERROR', payload: { message: 'x' }, meta: meta('auth-unmount') }),
  onUpload: (session) => session.send({ type: 'UPLOAD', payload: { file: new dom.window.File(['x'], 'x.png') }, meta: meta('upload-unmount') }),
  onListAssets: (session) => session.send({ type: 'LIST_ASSETS', meta: meta('list-unmount') }),
  onDeleteAsset: (session) => session.send({ type: 'DELETE_ASSET', payload: { id: 'x' }, meta: meta('delete-unmount') }),
};

for (const name of callbackNames) {
  const session = await mount((controls) => ({
    [name]: () => {
      if (!controls.didUnmount) {
        controls.didUnmount = true;
        controls.root.unmount();
      }
      if (name === 'onUpload') return 'https://assets.example.com/x.png';
      if (name === 'onListAssets') return [];
      if (name === 'onDeleteAsset') return true;
    },
  }));
  if (!['onReady', 'onStatusChange'].includes(name)) await act(async () => { session.send({ type: 'READY', meta: meta(`ready-before-${name}`) }); });
  const postsBefore = session.posts.length;
  await act(async () => { triggerByName[name](session); await Promise.resolve(); });
  await tick(10);
  assert.equal(session.controls.didUnmount, true, `${name} should unmount`);
  if (['onUpload', 'onListAssets', 'onDeleteAsset'].includes(name)) assert.equal(session.posts.length, postsBefore, `${name} must suppress late response after unmount`);
  await session.cleanup();
}

function ChangingHost() {
  const [html, setHtml] = useState('<p>first</p>');
  return React.createElement(EmailBuilder, {
    apiKey: API_KEY,
    expectedOrganizationId: 'org-callback',
    expectedLicenseId: 'license-callback',
    initialHtml: html,
    onReady: () => setHtml('<p>second</p>'),
  });
}
const changing = await mount(() => ({}), () => React.createElement(ChangingHost));
await act(async () => { changing.send({ type: 'READY', meta: meta('ready-change-props') }); await Promise.resolve(); });
await tick();
assert.equal(changing.posts.filter((entry) => entry.message.type === 'INIT').length, 1, 'prop changes after READY must not overwrite remote content with another INIT');
await changing.cleanup();

let reentrantSave = 0;
const reentrant = await mount((controls) => ({
  onChange: () => controls.send({ type: 'SAVE', payload: { html: '<p>nested</p>' }, meta: meta('nested-save') }),
  onSave: () => { reentrantSave += 1; },
}));
await act(async () => {
  reentrant.send({ type: 'READY', meta: meta('ready-reentrant') });
  reentrant.send({ type: 'CHANGE', payload: { html: '<p>outer</p>' }, meta: meta('outer-change') });
});
assert.equal(reentrantSave, 1);
await reentrant.cleanup();

await tick();
assert.equal(unhandled.length, 0);
process.off('unhandledRejection', onUnhandled);

console.log('PASS\tall nine callbacks isolate synchronous throws and asynchronous rejections');
console.log('PASS\tall nine callbacks may never resolve without blocking protocol progress');
console.log('PASS\tall nine callbacks may unmount safely; asset responses are suppressed afterward');
console.log('PASS\tREADY protocol work completes before callbacks; prop changes do not resend INIT');
console.log('PASS\treentrant callbacks and subsequent messages remain functional with no unhandled rejections');

globalThis.setTimeout = nativeSetTimeout;
globalThis.fetch = originalFetch;
dom.window.close();
