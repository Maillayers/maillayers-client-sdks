import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isMessageLike, validateMailLayersLicense } from '../dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'src/EmailBuilder.tsx'), 'utf8');
const constantsSource = await readFile(resolve(root, 'src/constants.ts'), 'utf8');
const results = [];
async function check(name, fn) { try { await fn(); results.push({ name, status: 'PASS' }); } catch (error) { results.push({ name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) }); } }
const originalFetch = globalThis.fetch;
const stub = (response) => {
  globalThis.fetch = async (_url, options = {}) => {
    const request = { ...JSON.parse(options.body), apiKey: options.headers?.['x-api-key'] };
    const value = typeof response === 'function' ? response(request, options) : response;
    if (value?.delay) await new Promise((resolve) => setTimeout(resolve, value.delay));
    return { ok: value?.ok ?? true, status: value?.status ?? 200, statusText: value?.statusText ?? 'OK', url: value?.url ?? 'https://api.maillayers.com/api/sdk/license/validate', headers: { get: (name) => name.toLowerCase() === 'content-type' ? (value?.contentType ?? 'application/json') : null }, text: async () => value?.body ?? '' };
  };
};
const valid = (request, extra = {}) => ({ status: 'valid', reason: 'allowed_domain', origin: 'https://app.example.com', domain: 'app.example.com', requestId: request.requestId, keyFingerprint: createHash('sha256').update(request.apiKey).digest('hex'), organizationId: 'org-synthetic', licenseId: 'license-synthetic', plan: 'pro', ...extra });

await check('missing and non-string keys fail closed', async () => {
  await assert.rejects(() => validateMailLayersLicense({ apiKey: '' }), /apiKey is (required|invalid)/);
  await assert.rejects(() => validateMailLayersLicense({ apiKey: 7 }), /apiKey is (required|invalid)/);
});
await check('invalid/revoked/HTTP failure responses fail', async () => {
  stub({ ok: false, status: 401, body: '{"message":"revoked"}' });
  await assert.rejects(() => validateMailLayersLicense({ apiKey: 'synthetic-invalid' }), /401/);
});
await check('valid response is accepted only with matching requestId', async () => {
  stub((request) => ({ body: JSON.stringify(valid(request)) }));
  const result = await validateMailLayersLicense({ apiKey: 'synthetic-valid', origin: 'https://app.example.com' });
  assert.equal(result.status, 'valid');
});
await check('empty/204/HTML/malformed/arbitrary responses fail', async () => {
  for (const response of [{ body: '' }, { status: 204, body: '' }, { body: '<html>bad</html>', contentType: 'text/html' }, { body: '{' }, { body: '{}' }]) {
    stub(response);
    await assert.rejects(() => validateMailLayersLicense({ apiKey: 'synthetic-key' }));
  }
});
await check('response substitution and expired decisions fail', async () => {
  stub((request) => ({ body: JSON.stringify(valid(request, { keyFingerprint: '0'.repeat(64), organizationId: 'tenant-b' })) }));
  await assert.rejects(() => validateMailLayersLicense({ apiKey: 'synthetic-key-A' }));
  stub((request) => ({ body: JSON.stringify(valid(request, { expiresAt: '2020-01-01T00:00:00Z' })) }));
  await assert.rejects(() => validateMailLayersLicense({ apiKey: 'synthetic-key-A' }));
});
await check('oversized keys and control characters fail', async () => {
  await assert.rejects(() => validateMailLayersLicense({ apiKey: 'x'.repeat(257) }), /invalid/);
  await assert.rejects(() => validateMailLayersLicense({ apiKey: 'x\nsecret' }), /invalid/);
});
await check('timeout, abort, and network rejection are bounded', async () => {
  globalThis.fetch = async (_url, options = {}) => await new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('late network')), 50);
    options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
  await assert.rejects(() => validateMailLayersLicense({ apiKey: 'synthetic-key', timeoutMs: 1 }), /validation (timed out|failed)/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => validateMailLayersLicense({ apiKey: 'synthetic-key', signal: controller.signal }), /validation (timed out|failed)/);
  globalThis.fetch = async () => { throw new Error('network details'); };
  await assert.rejects(() => validateMailLayersLicense({ apiKey: 'synthetic-key' }), /^Error: MailLayers license validation failed\.$/);
});
await check('origin enforcement and no wildcard outbound messages', async () => {
  assert.doesNotMatch(source, /postMessage\([^\n]+,\s*["']\*["']\)/);
  assert.match(source, /sanitizeIncomingMessage/);
  assert.match(source, /expectedOrigin/);
});
await check('malformed protocol payloads are rejected', async () => {
  assert.equal(isMessageLike(null), false);
  assert.equal(isMessageLike({ type: 'CHANGE', payload: {} }), false);
  assert.equal(isMessageLike({ type: 'CHANGE', payload: { html: 7 } }), false);
  assert.equal(isMessageLike({ type: 'AUTH_ERROR', payload: { message: 7 } }), false);
  assert.equal(isMessageLike({ type: 'READY', payload: {} }), false);
  assert.equal(isMessageLike({ type: 'READY' }), true);
});
await check('unsafe asset results are guarded in source', async () => {
  assert.match(source, /(?:success|result\.value) === true/);
  assert.match(source, /https:/);
  assert.match(source, /withTimeout/);
});
await check('default editor endpoint is production host', async () => {
  assert.match(constantsSource, /https:\/\/editor\.maillayers\.com/);
  assert.doesNotMatch(constantsSource, /https:\/\/maillayers\.com\/editor/);
});
await check('package manifest and LICENSE are present', async () => {
  await access(resolve(root, 'LICENSE'));
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.files, ['dist', 'LICENSE', 'README.md']);
});
await check('SSR import succeeds', async () => { await import('../dist/index.js'); });
await check('license-only entrypoint is React-free', async () => {
  const licenseBundle = await readFile(resolve(root, 'dist/license-entry.js'), 'utf8');
  assert.doesNotMatch(licenseBundle, /react|EmailBuilder|editor\.maillayers/);
});
globalThis.fetch = originalFetch;
for (const result of results) console.log(`${result.status}\t${result.name}${result.detail ? `\t${result.detail}` : ''}`);
if (results.some((result) => result.status === 'FAIL')) process.exitCode = 1;
