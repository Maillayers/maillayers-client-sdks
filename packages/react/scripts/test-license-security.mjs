import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateMailLayersLicense } from '../dist/license-entry.js';

const API_URL = 'https://api.maillayers.com/api/sdk/license/validate';
const TEST_KEY = 'synthetic-license-fixture';
const TEST_ORIGIN = 'https://app.example.com';
const originalFetch = globalThis.fetch;
const results = [];

function fingerprint(apiKey) {
  return createHash('sha256').update(apiKey).digest('hex');
}

function validDecision(request, apiKey = TEST_KEY, overrides = {}) {
  return {
    status: 'valid',
    reason: 'allowed_domain',
    origin: TEST_ORIGIN,
    domain: 'app.example.com',
    requestId: request.requestId,
    keyFingerprint: fingerprint(apiKey),
    organizationId: 'org-synthetic-a',
    licenseId: 'license-synthetic-a',
    plan: 'pro',
    ...overrides,
  };
}

function installFetch(factory) {
  globalThis.fetch = async (url, options = {}) => {
    const request = JSON.parse(options.body ?? '{}');
    const fixture = await factory(request, options);
    if (fixture instanceof Error) throw fixture;
    if (fixture?.hang) {
      return await new Promise((_, reject) => {
        const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (options.signal?.aborted) return rejectAbort();
        options.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    }
    return {
      ok: fixture?.ok ?? ((fixture?.status ?? 200) >= 200 && (fixture?.status ?? 200) < 300),
      status: fixture?.status ?? 200,
      statusText: fixture?.statusText ?? 'OK',
      url: fixture?.url ?? API_URL,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? (fixture?.contentType ?? 'application/json; charset=utf-8') : null },
      text: async () => fixture?.body ?? '',
    };
  };
}

async function expectFailure(fixture, options = {}) {
  installFetch(async (request, init) => typeof fixture === 'function' ? fixture(request, init) : fixture);
  await assert.rejects(() => validateMailLayersLicense({ apiKey: TEST_KEY, origin: TEST_ORIGIN, ...options }));
}

async function check(name, run) {
  try {
    await run();
    results.push({ name, status: 'PASS' });
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
  }
}

await check('accepts the exact production success schema', async () => {
  installFetch(async (request, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.apiKey, undefined, 'API key must not be duplicated into the JSON body');
    assert.equal(options.headers['x-api-key'], TEST_KEY);
    return { body: JSON.stringify(validDecision(request)) };
  });
  const result = await validateMailLayersLicense({
    apiKey: TEST_KEY,
    origin: TEST_ORIGIN,
    expectedOrganizationId: 'org-synthetic-a',
    expectedLicenseId: 'license-synthetic-a',
  });
  assert.equal(result.organizationId, 'org-synthetic-a');
});

await check('rejects all malformed successful HTTP responses', async () => {
  const fixtures = [
    { body: '' },
    { status: 204, body: '' },
    { body: '<html>gateway</html>', contentType: 'text/html' },
    { body: '{' },
    { body: '{}' },
    { body: '{"hello":"world"}' },
    { body: '{"valid":false}' },
  ];
  for (const fixture of fixtures) await expectFailure(fixture);
});

await check('rejects missing fields, wrong field types, and unknown success formats', async () => {
  await expectFailure((request) => ({ body: JSON.stringify(validDecision(request, TEST_KEY, { organizationId: undefined })) }));
  await expectFailure((request) => ({ body: JSON.stringify(validDecision(request, TEST_KEY, { plan: 7 })) }));
  await expectFailure((request) => ({ body: JSON.stringify(validDecision(request, TEST_KEY, { unexpectedAuthorization: true })) }));
});

await check('rejects blocked, revoked, inactive, and false decisions even on HTTP 200', async () => {
  for (const reason of ['license_blocked', 'revoked_api_key', 'inactive_license']) {
    await expectFailure({ body: JSON.stringify({ status: 'blocked', reason, origin: TEST_ORIGIN, domain: 'app.example.com' }) });
  }
});

await check('rejects unsupported expiry fields and expired fixtures', async () => {
  await expectFailure((request) => ({ body: JSON.stringify(validDecision(request, TEST_KEY, { expiresAt: '2020-01-01T00:00:00.000Z' })) }));
});

await check('binds decisions to request, API key, origin, organization, and license', async () => {
  await expectFailure((request) => ({ body: JSON.stringify(validDecision(request, TEST_KEY, { requestId: 'stale-request-id' })) }));
  await expectFailure((request) => ({ body: JSON.stringify(validDecision(request, TEST_KEY, { keyFingerprint: '0'.repeat(64) })) }));
  await expectFailure((request) => ({ body: JSON.stringify(validDecision(request, TEST_KEY, { origin: 'https://other.example.com', domain: 'other.example.com' })) }));
  await expectFailure(
    (request) => ({ body: JSON.stringify(validDecision(request, TEST_KEY, { organizationId: 'org-synthetic-b' })) }),
    { expectedOrganizationId: 'org-synthetic-a' },
  );
  await expectFailure(
    (request) => ({ body: JSON.stringify(validDecision(request, TEST_KEY, { licenseId: 'license-synthetic-b' })) }),
    { expectedLicenseId: 'license-synthetic-a' },
  );
});

await check('rejects non-string, empty, oversized, and control-character API keys without fetching', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('must not fetch'); };
  for (const apiKey of [null, undefined, 7, [], {}, '', '   ', 'x'.repeat(257), 'ml_live_bad\nkey']) {
    await assert.rejects(() => validateMailLayersLicense({ apiKey, origin: TEST_ORIGIN }));
  }
  assert.equal(fetchCalls, 0);
});

await check('requires a valid exact HTTP(S) request origin', async () => {
  for (const origin of [null, 7, '', 'https://user@example.com', 'file:///tmp/test', 'https://example.com/path', 'null']) {
    await assert.rejects(() => validateMailLayersLicense({ apiKey: TEST_KEY, origin }));
  }
});

await check('requires an explicit JSON response content type', async () => {
  await expectFailure((request) => ({ body: JSON.stringify(validDecision(request)), contentType: '' }));
  await expectFailure((request) => ({ body: JSON.stringify(validDecision(request)), contentType: 'text/plain' }));
});

await check('handles timeout and already-aborted or later-aborted caller signals', async () => {
  installFetch(async () => ({ hang: true }));
  await assert.rejects(
    () => validateMailLayersLicense({ apiKey: TEST_KEY, origin: TEST_ORIGIN, timeoutMs: 2 }),
    /timed out or was cancelled/,
  );
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    () => validateMailLayersLicense({ apiKey: TEST_KEY, origin: TEST_ORIGIN, signal: alreadyAborted.signal }),
    /timed out or was cancelled/,
  );
  const laterAborted = new AbortController();
  const pending = validateMailLayersLicense({ apiKey: TEST_KEY, origin: TEST_ORIGIN, signal: laterAborted.signal });
  laterAborted.abort();
  await assert.rejects(() => pending, /timed out or was cancelled/);
});

await check('sanitizes network failures and raw server errors', async () => {
  globalThis.fetch = async () => { throw new Error('database host db.internal token=secret-value'); };
  await assert.rejects(
    () => validateMailLayersLicense({ apiKey: TEST_KEY, origin: TEST_ORIGIN }),
    (error) => error.message === 'MailLayers license validation failed.' && !error.message.includes('secret-value'),
  );
  await expectFailure({ status: 500, body: '<html>stack trace secret-value</html>', contentType: 'text/html' });
});

await check('fails closed for 400, 401, 403, 429, and 500', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    installFetch(async () => ({ status, body: JSON.stringify({ message: `raw-${status}-secret` }) }));
    await assert.rejects(
      () => validateMailLayersLicense({ apiKey: TEST_KEY, origin: TEST_ORIGIN }),
      (error) => !error.message.includes('secret') && error.message.includes(String(status)),
    );
  }
});

await check('blocks cross-host redirected responses', async () => {
  await expectFailure((request) => ({
    url: 'https://evil.example.net/api/sdk/license/validate',
    body: JSON.stringify(validDecision(request)),
  }));
});

globalThis.fetch = originalFetch;
for (const result of results) {
  console.log(`${result.status}\t${result.name}${result.detail ? `\t${result.detail}` : ''}`);
}
if (results.some((result) => result.status === 'FAIL')) process.exitCode = 1;
