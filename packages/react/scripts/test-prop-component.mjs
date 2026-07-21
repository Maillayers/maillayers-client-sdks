import assert from 'node:assert/strict';
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

let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls += 1; throw new Error('invalid props must not fetch'); };

const cyclic = {};
cyclic.self = cyclic;
const deep = {};
let cursor = deep;
for (let index = 0; index < 16; index += 1) { cursor.next = {}; cursor = cursor.next; }
const getter = {};
Object.defineProperty(getter, 'secret', { enumerable: true, get() { throw new Error('getter must not run'); } });
const proxy = new Proxy({}, { ownKeys() { throw new Error('proxy must be controlled'); } });

const cases = [
  ['non-string src', { src: 7 }],
  ['invalid allowedOrigin', { allowedOrigin: {} }],
  ['non-string API key', { apiKey: 7 }],
  ['oversized HTML', { initialHtml: 'x'.repeat(1_000_001) }],
  ['cyclic config', { config: cyclic }],
  ['deep config', { config: deep }],
  ['throwing config getter', { config: getter }],
  ['throwing config proxy', { config: proxy }],
  ['throwing theme proxy', { theme: proxy }],
  ['throwing mergeTags proxy', { mergeTags: proxy }],
  ['throwing style proxy', { style: proxy }],
  ['invalid footer mode', { footerInjectionMode: 'other' }],
  ['invalid theme mode', { themeMode: 'other' }],
  ['empty iframe title', { iframeTitle: ' ' }],
  ['invalid sandbox', { sandbox: 7 }],
];

for (const [name, props] of cases) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let controlledError = '';
  await act(async () => {
    root.render(React.createElement(EmailBuilder, {
      apiKey: 'ml_live_synthetic_props',
      onAuthError: (message) => { controlledError = message; },
      ...props,
    }));
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const iframe = container.querySelector('iframe');
  assert.equal(iframe?.getAttribute('src'), 'about:blank', `${name}: iframe must remain locked`);
  assert.match(container.textContent ?? '', /\[ML_PROP_[A-Z_]+_INVALID\]/, `${name}: stable error code must render`);
  assert.match(controlledError, /^\[ML_PROP_[A-Z_]+_INVALID\]/, `${name}: controlled error callback must run`);
  await act(async () => { root.unmount(); });
  container.remove();
}

assert.equal(fetchCalls, 0);
console.log(`PASS\t${cases.length} mounted invalid-prop cases did not crash or fetch`);
console.log('PASS\tall mounted invalid-prop cases stayed about:blank with stable controlled errors');

globalThis.fetch = originalFetch;
dom.window.close();
