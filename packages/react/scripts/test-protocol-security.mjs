import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EMAIL_BUILDER_PROTOCOL_VERSION, isMessageLike } from '../dist/index.js';

const dom = new JSDOM();
const file = new dom.window.File(['synthetic'], 'asset.png', { type: 'image/png' });
const meta = { id: 'message-1', correlationId: '', version: EMAIL_BUILDER_PROTOCOL_VERSION, sentAt: Date.now() };

const validInbound = [
  { type: 'READY', meta },
  { type: 'CHANGE', payload: { html: '<p>change</p>' }, meta },
  { type: 'LOADED', payload: { html: '<p>loaded</p>' }, meta },
  { type: 'SAVE', payload: { html: '<p>save</p>' }, meta },
  { type: 'UPLOAD', payload: { file }, meta },
  { type: 'LIST_ASSETS', meta },
  { type: 'LIST_ASSETS', payload: {}, meta },
  { type: 'LIST_ASSETS', payload: { limit: 100 }, meta },
  { type: 'DELETE_ASSET', payload: { id: 'asset-1' }, meta },
  { type: 'DELETE_ASSET', payload: { url: 'https://assets.example.com/asset.png' }, meta },
  { type: 'AUTH_ERROR', payload: { message: 'Synthetic auth failure' }, meta },
  { type: 'STATUS', payload: { status: 'ready' }, meta },
];
for (const message of validInbound) assert.equal(isMessageLike(message), true, `valid ${message.type}`);

const malformedByType = {
  READY: [
    { type: 'READY', payload: undefined },
    { type: 'READY', payload: null },
    { type: 'READY', payload: {} },
    { type: 'READY', extra: true },
  ],
  CHANGE: [
    { type: 'CHANGE' },
    { type: 'CHANGE', payload: null },
    { type: 'CHANGE', payload: {} },
    { type: 'CHANGE', payload: { html: 7 } },
    { type: 'CHANGE', payload: { html: '<p>x</p>', extra: true } },
    { type: 'CHANGE', payload: { html: 'x'.repeat(1_000_001) } },
  ],
  LOADED: [
    { type: 'LOADED' },
    { type: 'LOADED', payload: null },
    { type: 'LOADED', payload: { html: [] } },
    { type: 'LOADED', payload: { html: '', extra: true } },
  ],
  SAVE: [
    { type: 'SAVE' },
    { type: 'SAVE', payload: null },
    { type: 'SAVE', payload: { html: {} } },
    { type: 'SAVE', payload: { html: '', extra: true } },
  ],
  UPLOAD: [
    { type: 'UPLOAD' },
    { type: 'UPLOAD', payload: null },
    { type: 'UPLOAD', payload: {} },
    { type: 'UPLOAD', payload: { file: {} } },
    { type: 'UPLOAD', payload: { file: new dom.window.Blob(['x']) } },
    { type: 'UPLOAD', payload: { file, extra: true } },
  ],
  LIST_ASSETS: [
    { type: 'LIST_ASSETS', payload: null },
    { type: 'LIST_ASSETS', payload: { limit: '10' } },
    { type: 'LIST_ASSETS', payload: { limit: 0 } },
    { type: 'LIST_ASSETS', payload: { limit: 101 } },
    { type: 'LIST_ASSETS', payload: { limit: 1.5 } },
    { type: 'LIST_ASSETS', payload: { extra: true } },
  ],
  DELETE_ASSET: [
    { type: 'DELETE_ASSET' },
    { type: 'DELETE_ASSET', payload: null },
    { type: 'DELETE_ASSET', payload: {} },
    { type: 'DELETE_ASSET', payload: { id: 7 } },
    { type: 'DELETE_ASSET', payload: { url: [] } },
    { type: 'DELETE_ASSET', payload: { id: '' } },
    { type: 'DELETE_ASSET', payload: { id: 'asset-1', extra: true } },
  ],
  AUTH_ERROR: [
    { type: 'AUTH_ERROR' },
    { type: 'AUTH_ERROR', payload: null },
    { type: 'AUTH_ERROR', payload: {} },
    { type: 'AUTH_ERROR', payload: { message: 7 } },
    { type: 'AUTH_ERROR', payload: { message: '' } },
    { type: 'AUTH_ERROR', payload: { message: 'x'.repeat(4097) } },
    { type: 'AUTH_ERROR', payload: { message: 'error', extra: true } },
  ],
  STATUS: [
    { type: 'STATUS' },
    { type: 'STATUS', payload: null },
    { type: 'STATUS', payload: {} },
    { type: 'STATUS', payload: { status: 7 } },
    { type: 'STATUS', payload: { status: 'saving' } },
    { type: 'STATUS', payload: { status: 'ready', extra: true } },
  ],
};

for (const [type, messages] of Object.entries(malformedByType)) {
  for (const message of messages) assert.equal(isMessageLike(message), false, `malformed ${type}: ${JSON.stringify(message)}`);
}

const invalidMeta = [
  null,
  {},
  { id: '', version: EMAIL_BUILDER_PROTOCOL_VERSION, sentAt: Date.now() },
  { id: 'id', version: '2.0.0', sentAt: Date.now() },
  { id: 'id', version: EMAIL_BUILDER_PROTOCOL_VERSION, sentAt: NaN },
  { id: 'id', version: EMAIL_BUILDER_PROTOCOL_VERSION, sentAt: Date.now(), correlationId: 7 },
  { id: 'id', version: EMAIL_BUILDER_PROTOCOL_VERSION, sentAt: Date.now(), extra: true },
];
for (const value of invalidMeta) assert.equal(isMessageLike({ type: 'READY', meta: value }), false);

let getterCalls = 0;
const getterMessage = {};
Object.defineProperty(getterMessage, 'type', { enumerable: true, get() { getterCalls += 1; throw new Error('must not run'); } });
assert.equal(isMessageLike(getterMessage), false);
assert.equal(getterCalls, 0);
assert.equal(isMessageLike(new Proxy({}, { ownKeys() { throw new Error('trap'); } })), false);
assert.equal(isMessageLike(null), false);
assert.equal(isMessageLike([]), false);
assert.equal(isMessageLike({ type: 'UNKNOWN' }), false);

const validOutbound = [
  { type: 'INIT', payload: { html: '', config: {} }, meta },
  { type: 'UPLOAD_SUCCESS', payload: { url: '' }, meta },
  { type: 'ASSETS_LIST', payload: { assets: [] }, meta },
  { type: 'DELETE_ASSET_SUCCESS', payload: { success: false }, meta },
];
for (const message of validOutbound) assert.equal(isMessageLike(message), true, `valid outbound ${message.type}`);
for (const message of [
  { type: 'INIT', payload: { config: [] } },
  { type: 'UPLOAD_SUCCESS', payload: { url: 7 } },
  { type: 'ASSETS_LIST', payload: { assets: [{}] } },
  { type: 'DELETE_ASSET_SUCCESS', payload: { success: 1 } },
]) assert.equal(isMessageLike(message), false);

console.log(`PASS\texact valid schemas for ${validInbound.length} inbound message variants`);
console.log(`PASS\tmalformed/null/wrong-type payloads rejected for all ${Object.keys(malformedByType).length} inbound types`);
console.log('PASS\texact metadata version/shape and unknown-field enforcement');
console.log('PASS\taccessor and throwing-proxy messages fail without executing getters or throwing');
console.log('PASS\toutbound message schemas also fail closed');

dom.window.close();
