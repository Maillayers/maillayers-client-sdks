import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { normalizeAssetListResult, normalizeAssetUrl, normalizeUploadResult } from '../dist/origin-entry.js';
import { EMAIL_BUILDER_PROTOCOL_VERSION, isMessageLike } from '../dist/index.js';

const meta = { id: 'asset-request', version: EMAIL_BUILDER_PROTOCOL_VERSION, sentAt: Date.now() };
const file = new JSDOM().window.File;

assert.equal(normalizeAssetUrl('https://assets.example.com/image.png'), 'https://assets.example.com/image.png');
assert.equal(normalizeUploadResult('https://assets.example.com/a b.png'), 'https://assets.example.com/a%20b.png');
for (const value of [
  null, undefined, {}, [], '', ' ', '/relative.png', './relative.png',
  'http://assets.example.com/a.png', 'http://localhost/a.png',
  'javascript:alert(1)', 'vbscript:msgbox(1)', 'data:image/png;base64,AA==',
  'ftp://assets.example.com/a.png', 'https://user:pass@assets.example.com/a.png',
  'https://assets.example.com./a.png', 'not a URL',
]) assert.equal(normalizeAssetUrl(value), null, `must reject ${String(value)}`);

const source = [{
  id: 'asset-1', url: 'https://assets.example.com/a.png', name: 'A',
  thumbnailUrl: 'https://assets.example.com/thumb.png', mimeType: 'image/png',
}];
const safe = normalizeAssetListResult(source);
assert.deepEqual(safe, source);
assert.notEqual(safe, source);
assert.notEqual(safe[0], source[0]);
assert.equal(Object.isFrozen(safe), true);
assert.equal(Object.isFrozen(safe[0]), true);

const invalidLists = [
  null, {}, 'assets', new Array(101).fill({ id: 'x', url: 'https://assets.example.com/x.png' }),
  [{}], [{ id: 'a' }], [{ url: 'https://assets.example.com/a.png' }],
  [{ id: 7, url: 'https://assets.example.com/a.png' }],
  [{ id: 'a', url: '/relative.png' }],
  [{ id: 'a', url: 'https://assets.example.com/a.png', mimeType: 'text/html' }],
  [{ id: 'a', url: 'https://assets.example.com/a.png', extra: true }],
  [{ id: 'a', url: 'https://assets.example.com/a.png' }, { id: 'a', url: 'https://assets.example.com/b.png' }],
  [{ id: 'a', url: 'https://assets.example.com/a.png' }, { id: 'b', url: 'https://assets.example.com/a.png' }],
  [{ id: 'a', url: 'https://assets.example.com/a.png', name: 'x'.repeat(257) }],
];
for (const value of invalidLists) assert.equal(normalizeAssetListResult(value), null);
assert.equal(normalizeAssetListResult(source, 0), null, 'callback may not exceed the requested limit');

let getterCalls = 0;
const accessor = { id: 'a', url: 'https://assets.example.com/a.png' };
Object.defineProperty(accessor, 'name', { enumerable: true, get() { getterCalls += 1; return 'unsafe'; } });
assert.equal(normalizeAssetListResult([accessor]), null);
assert.equal(getterCalls, 0);
assert.equal(normalizeAssetListResult([new Proxy({}, { ownKeys() { throw new Error('trap'); } })]), null);

for (const type of ['UPLOAD', 'LIST_ASSETS', 'DELETE_ASSET']) {
  const payload = type === 'UPLOAD' ? { file: new file(['x'], 'x.png') } : type === 'DELETE_ASSET' ? { id: 'a' } : undefined;
  assert.equal(isMessageLike({ type, ...(payload === undefined ? {} : { payload }) }), false, `${type} requires request metadata`);
}
assert.equal(isMessageLike({ type: 'ASSETS_LIST', payload: { assets: [
  { id: 'a', url: 'https://assets.example.com/a.png' },
  { id: 'a', url: 'https://assets.example.com/b.png' },
] }, meta }), false);
assert.equal(isMessageLike({ type: 'UPLOAD_SUCCESS', payload: { url: 'http://assets.example.com/a.png' }, meta }), false);
assert.equal(isMessageLike({ type: 'ASSETS_LIST', payload: { assets: [
  { id: 'a', url: 'https://assets.example.com/a.png' },
  { id: 'b', url: 'https://assets.example.com/a.png' },
] }, meta }), false);

console.log('PASS\tupload URLs allow absolute HTTPS only and reject script, data, relative, credential, and mixed-content URLs');
console.log('PASS\tasset lists require bounded exact items and reject missing fields, MIME violations, duplicates, and excessive results');
console.log('PASS\tasset validation creates detached snapshots without invoking accessors or proxy traps');
console.log('PASS\tasset protocol requests require IDs and outbound lists reject duplicate IDs/URLs');
