import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import React, { StrictMode, act, createRef } from 'react';
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
const ORIGIN = 'https://app.example.com';
const EDITOR_ORIGIN = 'https://editor.maillayers.com';
const meta = (id) => ({ id, version: '1.0.0', sentAt: Date.now() });
const tick = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function successfulResponse(url, options, organizationId = 'org-life', licenseId = 'license-life') {
  const body = JSON.parse(options.body);
  const key = options.headers['x-api-key'];
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    text: async () => JSON.stringify({
      status: 'valid', reason: 'allowed_domain', origin: ORIGIN, domain: 'app.example.com',
      requestId: body.requestId, keyFingerprint: createHash('sha256').update(key).digest('hex'),
      organizationId, licenseId, plan: 'pro',
    }),
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

function fixture() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}

// Strict Mode cleanup happens while fingerprinting. The cancelled generation
// must not reach fetch, and a stable rerender must not duplicate validation.
{
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return successfulResponse(url, options); };
  const session = fixture();
  const props = { apiKey: 'ml_lifecycle_strict', expectedOrganizationId: 'org-life', expectedLicenseId: 'license-life' };
  await act(async () => session.root.render(React.createElement(StrictMode, null, React.createElement(EmailBuilder, props))));
  await waitFor(() => session.container.querySelector('iframe')?.getAttribute('src') !== 'about:blank', 'Strict Mode validation did not complete');
  assert.equal(calls.length, 1, 'Strict Mode must not start a fetch for its cancelled first effect');
  await act(async () => session.root.render(React.createElement(StrictMode, null, React.createElement(EmailBuilder, { ...props, initialHtml: '<p>staged</p>' }))));
  await tick();
  assert.equal(calls.length, 1, 'unrelated initial-content rerenders must reuse the active authorization');
  await session.close();
}
console.log('PASS\tStrict Mode cancellation and stable rerenders do not duplicate validation fetches');

// A key/endpoint change must cancel the old request, lock the iframe, and
// ignore an old response even when the transport resolves after abort.
{
  const requests = [];
  globalThis.fetch = (url, options) => new Promise((resolve) => {
    requests.push({ url, options, resolve, aborted: options.signal.aborted });
    options.signal.addEventListener('abort', () => { requests.find((item) => item.options === options).aborted = true; }, { once: true });
  });
  const session = fixture();
  const editorRef = createRef();
  const base = { ref: editorRef, expectedOrganizationId: 'org-life', expectedLicenseId: 'license-life' };
  await act(async () => session.root.render(React.createElement(EmailBuilder, {
    ...base, apiKey: 'ml_lifecycle_a', licenseValidationUrl: 'https://license-a.example/api/sdk/license/validate', initialHtml: '<p>first</p>',
  })));
  await waitFor(() => requests.length === 1, 'first validation request did not start');
  await act(async () => session.root.render(React.createElement(EmailBuilder, {
    ...base, apiKey: 'ml_lifecycle_b', licenseValidationUrl: 'https://license-b.example/environment', initialHtml: '<p>first</p>',
  })));
  await waitFor(() => requests.length === 2, 'replacement validation request did not start');
  assert.equal(requests[0].aborted, true, 'API key/endpoint change must abort the old request');
  assert.equal(requests[0].url, 'https://license-a.example/api/sdk/license/validate');
  assert.equal(requests[1].url, 'https://license-b.example/environment/api/sdk/license/validate');

  await act(async () => requests[0].resolve(successfulResponse(requests[0].url, requests[0].options)));
  await tick();
  assert.equal(session.container.querySelector('iframe').getAttribute('src'), 'about:blank', 'stale success must not unlock the iframe');
  await act(async () => requests[1].resolve(successfulResponse(requests[1].url, requests[1].options)));
  await waitFor(() => session.container.querySelector('iframe')?.getAttribute('src') !== 'about:blank', 'current validation did not unlock iframe');

  let iframe = session.container.querySelector('iframe');
  const firstPosts = [];
  Object.defineProperty(iframe.contentWindow, 'postMessage', { configurable: true, value: (message, targetOrigin) => firstPosts.push({ message, targetOrigin }) });
  await act(async () => iframe.dispatchEvent(new dom.window.Event('load')));
  const send = (target, data) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { origin: EDITOR_ORIGIN, source: target.contentWindow, data }));
  await act(async () => { send(iframe, { type: 'READY', meta: meta('ready-1') }); send(iframe, { type: 'READY', meta: meta('ready-2') }); });
  assert.equal(firstPosts.filter((entry) => entry.message.type === 'INIT').length, 1, 'load plus repeated READY must send INIT once');
  assert.equal(firstPosts[0].message.meta.version, '1.0.0');
  assert.ok(firstPosts[0].message.meta.id, 'INIT must carry a correlation-capable message id');

  await act(async () => session.root.render(React.createElement(EmailBuilder, {
    ...base, apiKey: 'ml_lifecycle_b', licenseValidationUrl: 'https://license-b.example/environment', initialHtml: '<p>second</p>',
  })));
  await tick();
  assert.equal(requests.length, 2, 'content changes must not revalidate');
  assert.equal(firstPosts.filter((entry) => entry.message.type === 'INIT').length, 1, 'content prop changes must not overwrite the active editor');

  await act(async () => editorRef.current.reload());
  iframe = session.container.querySelector('iframe');
  const reloadPosts = [];
  Object.defineProperty(iframe.contentWindow, 'postMessage', { configurable: true, value: (message, targetOrigin) => reloadPosts.push({ message, targetOrigin }) });
  await act(async () => iframe.dispatchEvent(new dom.window.Event('load')));
  assert.equal(reloadPosts.filter((entry) => entry.message.type === 'INIT').length, 1, 'reload must create one new handshake INIT');
  assert.equal(reloadPosts.find((entry) => entry.message.type === 'INIT').message.payload.html, '<p>second</p>', 'reload must apply staged initial props');
  await session.close();
}
console.log('PASS\tkey and endpoint changes cancel old work; stale responses cannot authorize');
console.log('PASS\tINIT is exactly once per handshake and reload applies staged initial props');

// Separate editors and authorization contexts never share validation success.
{
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const index = calls.push({ url, options }) - 1;
    return successfulResponse(url, options, index === 0 ? 'org-one' : 'org-two', index === 0 ? 'license-one' : 'license-two');
  };
  const session = fixture();
  await act(async () => session.root.render(React.createElement(React.Fragment, null,
    React.createElement(EmailBuilder, { apiKey: 'ml_context_one', expectedOrganizationId: 'org-one', expectedLicenseId: 'license-one', licenseValidationUrl: 'https://env-one.example' }),
    React.createElement(EmailBuilder, { apiKey: 'ml_context_two', expectedOrganizationId: 'org-two', expectedLicenseId: 'license-two', licenseValidationUrl: 'https://env-two.example' }),
  )));
  await waitFor(() => calls.length === 2, 'both isolated context validations did not start');
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    'https://env-one.example/api/sdk/license/validate',
    'https://env-two.example/api/sdk/license/validate',
  ]);
  await session.close();
}
console.log('PASS\tmultiple editors do not share authorization across key, organization, license, or environment');

// A live handshake timer must be removed during teardown.
{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const session = fixture();
  await act(async () => session.root.render(React.createElement(EmailBuilder, {
    apiKey: 'ml_timer_cleanup', expectedOrganizationId: 'org-life', expectedLicenseId: 'license-life',
  })));
  await waitFor(() => session.container.querySelector('iframe')?.getAttribute('src') !== 'about:blank', 'timer fixture did not validate');
  const nativeWindowSetTimeout = dom.window.setTimeout.bind(dom.window);
  const nativeWindowClearTimeout = dom.window.clearTimeout.bind(dom.window);
  const handshakeTimers = new Set();
  dom.window.setTimeout = (callback, delay, ...args) => {
    const id = nativeWindowSetTimeout(callback, delay, ...args);
    if (delay === 12000) handshakeTimers.add(id);
    return id;
  };
  dom.window.clearTimeout = (id) => { handshakeTimers.delete(id); return nativeWindowClearTimeout(id); };
  const iframe = session.container.querySelector('iframe');
  await act(async () => iframe.dispatchEvent(new dom.window.Event('load')));
  assert.equal(handshakeTimers.size, 1, 'load must establish one bounded handshake timer');
  await session.close();
  assert.equal(handshakeTimers.size, 0, 'unmount must clear the handshake timer');
  dom.window.setTimeout = nativeWindowSetTimeout;
  dom.window.clearTimeout = nativeWindowClearTimeout;
}
console.log('PASS\tunmount clears the active handshake timer');

// Repeated pending mounts must abort cleanly. Late resolutions cannot update
// state, post messages, or leave a message listener capable of calling hosts.
{
  const pending = [];
  globalThis.fetch = (url, options) => new Promise((resolve) => {
    const request = { url, options, resolve, aborted: false };
    pending.push(request);
    options.signal.addEventListener('abort', () => { request.aborted = true; }, { once: true });
  });
  let changes = 0;
  for (let index = 0; index < 3; index += 1) {
    const session = fixture();
    await act(async () => session.root.render(React.createElement(EmailBuilder, { apiKey: `ml_pending_${index}`, onChange: () => { changes += 1; } })));
    await waitFor(() => pending.length === index + 1, 'pending validation did not start');
    await session.close();
    assert.equal(pending[index].aborted, true, 'each unmount must abort pending validation');
    await act(async () => pending[index].resolve(successfulResponse(pending[index].url, pending[index].options, 'late-org', 'late-license')));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { origin: EDITOR_ORIGIN, data: { type: 'CHANGE', payload: { html: 'late' }, meta: meta(`late-${index}`) } }));
  }
  await tick();
  assert.equal(changes, 0, 'removed listeners must suppress messages after unmount');
}
console.log('PASS\trepeated mount/unmount aborts validation and suppresses late state/messages');

globalThis.fetch = originalFetch;
dom.window.close();
