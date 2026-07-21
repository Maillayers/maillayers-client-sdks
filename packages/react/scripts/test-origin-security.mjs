import assert from 'node:assert/strict';
import { deriveAllowedOrigin, sanitizeIncomingMessage } from '../dist/origin-entry.js';

const PROD = 'https://editor.maillayers.com';
const iframeWindow = {};
const ready = { type: 'READY' };

function event(origin, source = iframeWindow, data = ready) {
  return { origin, source, data };
}

const acceptedOrigins = [
  [PROD, undefined, PROD],
  ['https://EDITOR.MAILLAYERS.COM/path?next=https://evil.example/#fragment', undefined, PROD],
  ['https://editor.maillayers.com:443/editor', undefined, PROD],
  ['https://custom.example.com/editor?mode=embed#ready', undefined, 'https://custom.example.com'],
  ['https://custom.example.com:8443/editor', 'https://custom.example.com:8443', 'https://custom.example.com:8443'],
  ['http://localhost/editor', undefined, 'http://localhost'],
  ['http://localhost:5173/editor', 'http://localhost:5173', 'http://localhost:5173'],
  ['http://127.0.0.1:5173/editor', undefined, 'http://127.0.0.1:5173'],
  ['http://[::1]:5173/editor', undefined, 'http://[::1]:5173'],
];

for (const [src, allowedOrigin, expected] of acceptedOrigins) {
  assert.equal(deriveAllowedOrigin(src, allowedOrigin), expected);
}

const blockedConfigurations = [
  ['editor.maillayers.com'],
  ['http://editor.maillayers.com'],
  ['file:///tmp/editor'],
  ['data:text/html,editor'],
  ['https://user@editor.maillayers.com'],
  ['https://editor.maillayers.com.'],
  [PROD, 'https://evil.example.com'],
  [PROD, 'https://sub.editor.maillayers.com'],
  [PROD, 'https://editor.maillayers.com.evil.example'],
  [PROD, 'https://evileditor.maillayers.com'],
  [PROD, 'https://user@editor.maillayers.com'],
  [PROD, 'https://editor.maillayers.com/?next=https://evil.example'],
  [PROD, 'https://editor.maillayers.com#https://evil.example'],
  [PROD, 'https://editor.maillayers.com:8443'],
  [PROD, 'http://editor.maillayers.com'],
  [PROD, 'https://editor.maillayers.com.'],
  [PROD, 'null'],
  [PROD, ''],
];

for (const [src, allowedOrigin] of blockedConfigurations) {
  assert.throws(() => deriveAllowedOrigin(src, allowedOrigin));
}

assert.deepEqual(sanitizeIncomingMessage(event(PROD), PROD, iframeWindow), ready);

const rejectedIncomingOrigins = [
  'https://evil.example.com',
  'https://sub.editor.maillayers.com',
  'https://editor.maillayers.com.evil.example',
  'https://evileditor.maillayers.com',
  'https://user@editor.maillayers.com',
  'https://editor.maillayers.com?next=https://evil.example',
  'https://editor.maillayers.com#https://evil.example',
  'https://EDITOR.MAILLAYERS.COM',
  'https://editor.maillayers.com:8443',
  'http://editor.maillayers.com',
  'https://editor.maillayers.com.',
  'null',
  '',
];

for (const origin of rejectedIncomingOrigins) {
  assert.equal(sanitizeIncomingMessage(event(origin), PROD, iframeWindow), null);
}

assert.equal(sanitizeIncomingMessage(event(PROD, {}), PROD, iframeWindow), null, 'wrong iframe window must fail');
assert.equal(sanitizeIncomingMessage(event(PROD), PROD, {}), null, 'another SDK instance must fail');
assert.equal(sanitizeIncomingMessage(event(PROD, iframeWindow, { type: 'CHANGE', payload: {} }), PROD, iframeWindow), null, 'malformed protocol payload must fail');
assert.equal(sanitizeIncomingMessage(event('https://redirected.example.com'), PROD, iframeWindow), null, 'redirected iframe origin must fail');

console.log(`PASS\taccepted canonical/custom/loopback origins: ${acceptedOrigins.length}`);
console.log(`PASS\tblocked origin configurations: ${blockedConfigurations.length}`);
console.log(`PASS\trejected incoming origin attacks: ${rejectedIncomingOrigins.length}`);
console.log('PASS\twrong-window, two-instance, malformed-message, and redirected-origin checks');
