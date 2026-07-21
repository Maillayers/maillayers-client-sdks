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

const API_URL = 'https://api.maillayers.com/api/sdk/license/validate';
const API_KEY = 'ml_live_synthetic_iframe';
const originalFetch = globalThis.fetch;
const fingerprint = createHash('sha256').update(API_KEY).digest('hex');

function valid(request, overrides = {}) {
  return {
    status: 'valid',
    reason: 'allowed_domain',
    origin: 'https://app.example.com',
    domain: 'app.example.com',
    requestId: request.requestId,
    keyFingerprint: fingerprint,
    organizationId: 'org-a',
    licenseId: 'license-a',
    plan: 'pro',
    ...overrides,
  };
}

function response(fixture) {
  return {
    ok: fixture.ok ?? ((fixture.status ?? 200) >= 200 && (fixture.status ?? 200) < 300),
    status: fixture.status ?? 200,
    statusText: 'fixture',
    url: fixture.url ?? API_URL,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? (fixture.contentType ?? 'application/json') : null },
    text: async () => fixture.body ?? '',
  };
}

async function assertLocked(name, fixtureFactory, extraProps = {}, waitForFailure = true) {
  let failed = false;
  globalThis.fetch = async (_url, options = {}) => {
    const request = JSON.parse(options.body ?? '{}');
    const fixture = await fixtureFactory(request, options);
    if (fixture?.networkError) throw new Error('raw internal network secret');
    if (fixture?.hang) {
      return await new Promise((_, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (options.signal?.aborted) return abort();
        options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return response(fixture);
  };

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(EmailBuilder, {
      apiKey: API_KEY,
      expectedOrganizationId: 'org-a',
      expectedLicenseId: 'license-a',
      onAuthError: () => { failed = true; },
      ...extraProps,
    }));
  });
  for (let attempt = 0; attempt < 10 && waitForFailure && !failed; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  const iframe = container.querySelector('iframe');
  assert.ok(iframe, `${name}: iframe should render`);
  assert.equal(iframe.getAttribute('src'), 'about:blank', `${name}: failed validation must not unlock iframe`);
  if (waitForFailure) assert.equal(failed, true, `${name}: controlled auth failure should be reported`);
  await act(async () => { root.unmount(); });
  container.remove();
}

const fixtures = [
  ['empty 200', async () => ({ body: '' })],
  ['204', async () => ({ status: 204, body: '' })],
  ['HTML 200', async () => ({ body: '<html>bad</html>', contentType: 'text/html' })],
  ['malformed JSON', async () => ({ body: '{' })],
  ['arbitrary JSON', async () => ({ body: '{"arbitrary":true}' })],
  ['missing required field', async (request) => ({ body: JSON.stringify(valid(request, { licenseId: undefined })) })],
  ['wrong field type', async (request) => ({ body: JSON.stringify(valid(request, { plan: 7 })) })],
  ['blocked response', async () => ({ body: '{"status":"blocked","reason":"license_blocked"}' })],
  ['expired unsupported response', async (request) => ({ body: JSON.stringify(valid(request, { expiresAt: '2020-01-01T00:00:00Z' })) })],
  ['stale response', async (request) => ({ body: JSON.stringify(valid(request, { requestId: 'stale-request' })) })],
  ['cross-tenant response', async (request) => ({ body: JSON.stringify(valid(request, { organizationId: 'org-b' })) })],
  ['cross-license response', async (request) => ({ body: JSON.stringify(valid(request, { licenseId: 'license-b' })) })],
  ['network rejection', async () => ({ networkError: true })],
  ['cross-host redirect', async (request) => ({ url: 'https://evil.example.net/validate', body: JSON.stringify(valid(request)) })],
  ...[400, 401, 403, 429, 500].map((status) => [`HTTP ${status}`, async () => ({ status, body: '{"message":"raw secret"}' })]),
];

for (const [name, fixture] of fixtures) {
  await assertLocked(name, fixture);
  console.log(`PASS\tiframe remains about:blank: ${name}`);
}

await assertLocked('pending validation', async () => ({ hang: true }), {}, false);
console.log('PASS\tiframe remains about:blank: pending validation and unmount abort');

await assertLocked('non-string API key', async () => { throw new Error('fetch must not run'); }, { apiKey: 7 });
console.log('PASS\tiframe remains about:blank: non-string API key');

globalThis.fetch = originalFetch;
dom.window.close();
