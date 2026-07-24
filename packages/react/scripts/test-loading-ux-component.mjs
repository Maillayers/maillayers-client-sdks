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

const ORIGIN = 'https://app.example.com';
const tick = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function successfulResponse(url, options) {
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
      organizationId: 'org-load', licenseId: 'license-load', plan: 'pro',
    }),
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

function fixture() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    root,
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function visibleOverlayCopy(container) {
  const nodes = [...container.querySelectorAll('div')];
  const overlay = nodes.find((node) => {
    const style = node.getAttribute('style') || '';
    return style.includes('position: absolute') && style.includes('inset: 0');
  });
  return overlay?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

{
  globalThis.fetch = async () => new Promise(() => {});
  const session = fixture();
  await act(async () => session.root.render(React.createElement(EmailBuilder, {
    apiKey: 'ml_loading_default',
    expectedOrganizationId: 'org-load',
    expectedLicenseId: 'license-load',
  })));
  await tick();
  const copy = visibleOverlayCopy(session.container);
  assert.equal(copy.includes('Connecting to builder'), false, 'default loader must not show Connecting to builder');
  assert.ok(
    session.container.querySelector('[aria-label="Loading editor"]'),
    'default loader must expose an accessible loading label'
  );
  assert.ok(session.container.querySelector('svg'), 'default loader must render a spinner indicator');
  await session.close();
}
console.log('PASS\tdefault loading state uses a neutral spinner without Connecting to builder copy');

{
  globalThis.fetch = async () => new Promise(() => {});
  const session = fixture();
  await act(async () => session.root.render(React.createElement(EmailBuilder, {
    apiKey: 'ml_loading_custom',
    expectedOrganizationId: 'org-load',
    expectedLicenseId: 'license-load',
    loadingLabel: 'Preparing workspace',
    loadingFallback: React.createElement('div', { 'data-testid': 'custom-loader' }, 'Loading editor…'),
  })));
  await tick();
  assert.ok(session.container.querySelector('[data-testid="custom-loader"]'));
  assert.equal(visibleOverlayCopy(session.container), 'Loading editor…');
  assert.equal(session.container.querySelector('[aria-label="Preparing workspace"]'), null);
  await session.close();
}
console.log('PASS\tloadingFallback replaces the built-in loader during the pre-ready state');

{
  globalThis.fetch = async (url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      ok: false,
      status: 403,
      url,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
      text: async () => JSON.stringify({
        status: 'blocked',
        reason: 'domain_not_allowed',
        message: 'This domain is not allowed for this MailLayers API key.',
        origin: ORIGIN,
        requestId: JSON.parse(options.body).requestId,
      }),
    };
  };
  const session = fixture();
  let authMessage = null;
  await act(async () => session.root.render(React.createElement(EmailBuilder, {
    apiKey: 'ml_loading_auth_fail',
    expectedOrganizationId: 'org-load',
    expectedLicenseId: 'license-load',
    loadingFallback: React.createElement('div', null, 'should not remain visible'),
    onAuthError: (message) => { authMessage = message; },
  })));
  await waitFor(() => Boolean(authMessage), 'auth failure did not surface');
  const copy = visibleOverlayCopy(session.container);
  assert.equal(copy.includes('should not remain visible'), false);
  assert.ok(copy.length > 0, 'auth failure must keep visible error presentation');
  assert.equal(session.container.querySelector('iframe')?.getAttribute('src'), 'about:blank');
  await session.close();
}
console.log('PASS\tauth failures keep error presentation and are not replaced by the custom loader');

{
  globalThis.fetch = async (url, options) => successfulResponse(url, options);
  const session = fixture();
  const statuses = [];
  await act(async () => session.root.render(React.createElement(EmailBuilder, {
    apiKey: 'ml_loading_ready',
    expectedOrganizationId: 'org-load',
    expectedLicenseId: 'license-load',
    loadingFallback: React.createElement('div', { 'data-testid': 'custom-loader' }, 'Loading editor…'),
    onStatusChange: (status) => statuses.push(status),
  })));
  await waitFor(() => session.container.querySelector('iframe')?.getAttribute('src') !== 'about:blank', 'iframe did not unlock');
  const iframe = session.container.querySelector('iframe');
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: { postMessage() {} },
  });
  await act(async () => { iframe.dispatchEvent(new dom.window.Event('load')); });
  await act(async () => {
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'READY', meta: { id: 'ready', version: '1.0.0', sentAt: Date.now() } },
      origin: 'https://editor.maillayers.com',
      source: iframe.contentWindow,
    }));
  });
  await waitFor(() => statuses.includes('ready'), 'editor never became ready');
  assert.equal(session.container.querySelector('[data-testid="custom-loader"]'), null);
  assert.equal(visibleOverlayCopy(session.container), '');
  await session.close();
}
console.log('PASS\tloader disappears completely once the editor is ready');
