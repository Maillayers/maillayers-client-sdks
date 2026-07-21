import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { EmailBuilder } from '../dist/index.js';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://app.example.com/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLIFrameElement = dom.window.HTMLIFrameElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const API_KEY = 'ml_live_synthetic_protocol';
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
      requestId: request.requestId, keyFingerprint: fingerprint, organizationId: 'org-protocol',
      licenseId: 'license-protocol', plan: 'pro',
    }),
  };
};

const calls = { ready: 0, change: 0, load: 0, save: 0, auth: 0, upload: 0, list: 0, delete: 0 };
const statuses = [];
let windowErrors = 0;
dom.window.addEventListener('error', () => { windowErrors += 1; });

const container = document.getElementById('root');
const root = createRoot(container);
await act(async () => {
  root.render(React.createElement(EmailBuilder, {
    apiKey: API_KEY,
    expectedOrganizationId: 'org-protocol',
    expectedLicenseId: 'license-protocol',
    onReady: () => { calls.ready += 1; },
    onChange: () => { calls.change += 1; },
    onLoad: () => { calls.load += 1; },
    onSave: () => { calls.save += 1; },
    onAuthError: () => { calls.auth += 1; },
    onUpload: async () => { calls.upload += 1; return 'https://assets.example.com/upload.png'; },
    onListAssets: async () => { calls.list += 1; return []; },
    onDeleteAsset: async () => { calls.delete += 1; return true; },
    onStatusChange: (status) => { statuses.push(status); },
  }));
});
for (let attempt = 0; attempt < 10 && container.querySelector('iframe')?.getAttribute('src') === 'about:blank'; attempt += 1) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const iframe = container.querySelector('iframe');
assert.ok(iframe);
const posts = [];
Object.defineProperty(iframe.contentWindow, 'postMessage', { configurable: true, value: (message, targetOrigin) => posts.push({ message, targetOrigin }) });
await act(async () => { iframe.dispatchEvent(new dom.window.Event('load')); });
assert.equal(posts.length, 1);

function send(data) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    origin: 'https://editor.maillayers.com',
    source: iframe.contentWindow,
    data,
  }));
}

const malformed = [
  { type: 'READY', payload: {} },
  { type: 'CHANGE', payload: null },
  { type: 'LOADED', payload: { html: 7 } },
  { type: 'SAVE', payload: {} },
  { type: 'UPLOAD', payload: { file: {} } },
  { type: 'LIST_ASSETS', payload: { limit: 101 } },
  { type: 'DELETE_ASSET', payload: {} },
  { type: 'AUTH_ERROR', payload: { message: 7 } },
  { type: 'STATUS', payload: { status: 'saving' } },
];

await act(async () => { for (const message of malformed) send(message); });
assert.deepEqual(calls, { ready: 0, change: 0, load: 0, save: 0, auth: 0, upload: 0, list: 0, delete: 0 });
assert.equal(posts.length, 1, 'malformed asset messages must not receive sensitive responses');

let getterCalls = 0;
const accessorMessage = {};
Object.defineProperty(accessorMessage, 'type', { enumerable: true, get() { getterCalls += 1; throw new Error('must not execute'); } });
await act(async () => {
  send(accessorMessage);
  send(new Proxy({}, { ownKeys() { throw new Error('proxy trap'); } }));
});
assert.equal(getterCalls, 0);
assert.equal(windowErrors, 0);

const meta = (id) => ({ id, correlationId: '', version: '1.0.0', sentAt: Date.now() });
await act(async () => { send({ type: 'READY', meta: meta('ready') }); });
assert.equal(calls.ready, 1);

await act(async () => {
  send({ type: 'CHANGE', payload: { html: '<p>change</p>' }, meta: meta('change') });
  send({ type: 'LOADED', payload: { html: '<p>loaded</p>' }, meta: meta('loaded') });
  send({ type: 'SAVE', payload: { html: '<p>save</p>' }, meta: meta('save') });
  send({ type: 'UPLOAD', payload: { file: new dom.window.File(['x'], 'x.png', { type: 'image/png' }) }, meta: meta('upload') });
  send({ type: 'LIST_ASSETS', payload: { limit: 10 }, meta: meta('list') });
  send({ type: 'DELETE_ASSET', payload: { id: 'asset-1' }, meta: meta('delete') });
  await Promise.resolve();
});
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

assert.equal(calls.change, 1);
assert.equal(calls.load, 1);
assert.equal(calls.save, 1);
assert.equal(calls.upload, 1);
assert.equal(calls.list, 1);
assert.equal(calls.delete, 1);
assert.ok(posts.some((entry) => entry.message.type === 'UPLOAD_SUCCESS'));
assert.ok(posts.some((entry) => entry.message.type === 'ASSETS_LIST'));
assert.ok(posts.some((entry) => entry.message.type === 'DELETE_ASSET_SUCCESS'));

const statusCount = statuses.length;
await act(async () => { send({ type: 'STATUS', payload: { status: 'loading' }, meta: meta('status') }); });
assert.equal(statuses.length, statusCount + 1);
assert.equal(statuses.at(-1), 'loading');
assert.equal(windowErrors, 0);

console.log('PASS\tmalformed payloads for every inbound type invoke no callbacks or responses');
console.log('PASS\taccessor/proxy messages do not throw or execute getters in the window listener');
console.log('PASS\tvalid messages still work after malformed traffic');
console.log('PASS\tvalidated STATUS messages use the controlled status path');

await act(async () => { root.unmount(); });
globalThis.fetch = originalFetch;
dom.window.close();
