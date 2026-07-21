import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import React, { act } from 'react';
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

const API_KEY = 'ml_live_synthetic_origin';
const API_URL = 'https://api.maillayers.com/api/sdk/license/validate';
const keyFingerprint = createHash('sha256').update(API_KEY).digest('hex');
const originalFetch = globalThis.fetch;

globalThis.fetch = async (_url, options = {}) => {
  const request = JSON.parse(options.body ?? '{}');
  return {
    ok: true,
    status: 200,
    url: API_URL,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    text: async () => JSON.stringify({
      status: 'valid',
      reason: 'allowed_domain',
      origin: 'https://app.example.com',
      domain: 'app.example.com',
      requestId: request.requestId,
      keyFingerprint,
      organizationId: 'org-origin',
      licenseId: 'license-origin',
      plan: 'pro',
    }),
  };
};

async function tick() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mountEditor(props = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(EmailBuilder, {
      apiKey: API_KEY,
      expectedOrganizationId: 'org-origin',
      expectedLicenseId: 'license-origin',
      ...props,
    }));
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const iframe = container.querySelector('iframe');
    if (iframe?.getAttribute('src') !== 'about:blank') break;
    await tick();
  }
  return {
    container,
    root,
    iframe: container.querySelector('iframe'),
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

function sendMessage(iframe, origin, data, source = iframe.contentWindow) {
  const message = new dom.window.MessageEvent('message', { origin, source, data });
  dom.window.dispatchEvent(message);
}

function capturePosts(iframe) {
  const posts = [];
  Object.defineProperty(iframe.contentWindow, 'postMessage', {
    configurable: true,
    value: (message, targetOrigin) => { posts.push({ message, targetOrigin }); },
  });
  return posts;
}

let readyCalls = 0;
const managed = await mountEditor({ onReady: () => { readyCalls += 1; } });
assert.equal(managed.iframe.getAttribute('src'), 'https://editor.maillayers.com');
const managedPosts = capturePosts(managed.iframe);

await act(async () => { managed.iframe.dispatchEvent(new dom.window.Event('load')); });
assert.equal(managedPosts.length, 1, 'load must send INIT');
assert.equal(managedPosts[0].message.type, 'INIT');

for (const origin of [
  'https://evil.example.com',
  'https://sub.editor.maillayers.com',
  'https://editor.maillayers.com.evil.example',
  'https://evileditor.maillayers.com',
  'https://editor.maillayers.com:8443',
  'http://editor.maillayers.com',
  'null',
  'https://redirected.example.com',
]) {
  await act(async () => { sendMessage(managed.iframe, origin, { type: 'READY' }); });
}
await act(async () => { sendMessage(managed.iframe, 'https://editor.maillayers.com', { type: 'READY' }, {}); });
assert.equal(readyCalls, 0, 'wrong origins and windows must not establish readiness');

await act(async () => { sendMessage(managed.iframe, 'https://editor.maillayers.com', { type: 'READY' }); });
assert.equal(readyCalls, 1, 'exact origin and iframe window must establish readiness');

const meta = (id) => ({ id, version: '1.0.0', sentAt: Date.now() });
await act(async () => {
  sendMessage(managed.iframe, 'https://editor.maillayers.com', { type: 'UPLOAD', payload: { file: new dom.window.File(['synthetic'], 'asset.png', { type: 'image/png' }) }, meta: meta('upload-1') });
  sendMessage(managed.iframe, 'https://editor.maillayers.com', { type: 'LIST_ASSETS', meta: meta('list-1') });
  sendMessage(managed.iframe, 'https://editor.maillayers.com', { type: 'DELETE_ASSET', payload: { id: 'asset-1' }, meta: meta('delete-1') });
  await Promise.resolve();
});
await tick();

assert.deepEqual(
  managedPosts.map((post) => post.message.type).sort(),
  ['ASSETS_LIST', 'DELETE_ASSET_SUCCESS', 'INIT', 'UPLOAD_SUCCESS'].sort(),
  'all outbound protocol response types must be captured',
);
assert.ok(managedPosts.every((post) => post.targetOrigin === 'https://editor.maillayers.com'));
assert.ok(managedPosts.every((post) => post.targetOrigin !== '*'));
await managed.unmount();

const custom = await mountEditor({
  src: 'https://custom-editor.example.com/embed?tenant=synthetic',
  allowedOrigin: 'https://custom-editor.example.com',
});
assert.match(custom.iframe.getAttribute('src'), /^https:\/\/custom-editor\.example\.com\/embed/);
const customPosts = capturePosts(custom.iframe);
await act(async () => { custom.iframe.dispatchEvent(new dom.window.Event('load')); });
assert.equal(customPosts.length, 1);
assert.equal(customPosts[0].targetOrigin, 'https://custom-editor.example.com');
await custom.unmount();

const blocked = await mountEditor({
  src: 'https://custom-editor.example.com/embed',
  allowedOrigin: 'https://redirected.example.com',
});
assert.equal(blocked.iframe.getAttribute('src'), 'about:blank');
const blockedPosts = capturePosts(blocked.iframe);
await act(async () => { blocked.iframe.dispatchEvent(new dom.window.Event('load')); });
assert.equal(blockedPosts.length, 0, 'invalid custom origin configuration must send no payload');
await blocked.unmount();

let firstReady = 0;
let secondReady = 0;
const first = await mountEditor({ onReady: () => { firstReady += 1; } });
const second = await mountEditor({ onReady: () => { secondReady += 1; } });
capturePosts(first.iframe);
capturePosts(second.iframe);
await act(async () => {
  first.iframe.dispatchEvent(new dom.window.Event('load'));
  second.iframe.dispatchEvent(new dom.window.Event('load'));
  sendMessage(first.iframe, 'https://editor.maillayers.com', { type: 'READY' });
});
assert.equal(firstReady, 1);
assert.equal(secondReady, 0, 'another editor instance window must not be trusted');
await first.unmount();
await second.unmount();

console.log('PASS\tmanaged editor rejects wrong origin/window and accepts exact READY');
console.log('PASS\tINIT, upload, list, and delete outbound messages use exact target origin');
console.log('PASS\tapproved custom origin uses exact custom target origin');
console.log('PASS\tblocked custom/redirect origin stays about:blank and sends no payload');
console.log('PASS\ttwo editor instances remain window-isolated');

globalThis.fetch = originalFetch;
dom.window.close();
