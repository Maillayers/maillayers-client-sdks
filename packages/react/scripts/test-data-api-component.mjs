import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import React, { act, createRef } from 'react';
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
const EDITOR_ORIGIN = 'https://editor.maillayers.com';
const meta = (id, overrides = {}) => ({ id, version: '1.0.0', sentAt: Date.now(), ...overrides });
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
      organizationId: 'org-data', licenseId: 'license-data', plan: 'pro',
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

function overlayText(container) {
  const overlay = [...container.querySelectorAll('div')].find((node) => node.textContent?.includes('Connecting to builder'));
  return overlay?.textContent ?? null;
}

async function mountReadyEditor(options = {}) {
  globalThis.fetch = async (url, requestOptions) => successfulResponse(url, requestOptions);
  const session = fixture();
  const editorRef = createRef();
  const statuses = [];
  const posts = [];
  await act(async () => session.root.render(React.createElement(EmailBuilder, {
    ref: editorRef,
    apiKey: 'ml_data_api',
    expectedOrganizationId: 'org-data',
    expectedLicenseId: 'license-data',
    initialHtml: '<p>Initial</p>',
    onStatusChange: (status) => statuses.push(status),
    ...options,
  })));
  await waitFor(() => session.container.querySelector('iframe')?.getAttribute('src') !== 'about:blank', 'iframe did not unlock');
  const iframe = session.container.querySelector('iframe');
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: {
      postMessage(message, targetOrigin) {
        posts.push({ message, targetOrigin });
      },
    },
  });
  await act(async () => {
    iframe.dispatchEvent(new dom.window.Event('load'));
  });
  await tick();
  const contentWindow = iframe.contentWindow;
  await act(async () => {
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'READY', meta: meta('ready-1') },
      origin: EDITOR_ORIGIN,
      source: contentWindow,
    }));
  });
  await waitFor(() => statuses.includes('ready'), 'editor never became ready');
  return { session, editorRef, statuses, posts, iframe, contentWindow };
}

{
  const { session, editorRef, statuses, posts, contentWindow } = await mountReadyEditor();
  assert.equal(overlayText(session.container), null, 'ready editor must not show Connecting overlay');

  const htmlPromise = editorRef.current.getHtml();
  await tick();
  const getHtml = posts.find(({ message }) => message.type === 'GET_HTML');
  assert.ok(getHtml, 'getHtml must post GET_HTML');
  assert.equal(getHtml.targetOrigin, EDITOR_ORIGIN);
  assert.notEqual(getHtml.targetOrigin, '*');
  assert.ok(!JSON.stringify(getHtml.message).includes('ml_data_api'), 'API key must not appear in data messages');

  await act(async () => {
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'HTML_RESULT',
        payload: { html: '<p>Current HTML</p>' },
        meta: meta('html-result', { correlationId: getHtml.message.meta.id }),
      },
      origin: EDITOR_ORIGIN,
      source: contentWindow,
    }));
  });
  assert.equal(await htmlPromise, '<p>Current HTML</p>');

  const jsonPromise = editorRef.current.getJson();
  await tick();
  const getJson = posts.find(({ message }) => message.type === 'GET_JSON');
  assert.ok(getJson, 'getJson must post GET_JSON');
  await act(async () => {
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'JSON_RESULT',
        payload: { json: { id: 'tpl', name: 'Demo', blocks: [] } },
        meta: meta('json-result', { correlationId: getJson.message.meta.id }),
      },
      origin: EDITOR_ORIGIN,
      source: contentWindow,
    }));
  });
  assert.deepEqual(await jsonPromise, { id: 'tpl', name: 'Demo', blocks: [] });

  const statusCount = statuses.length;
  await act(async () => {
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'STATUS', payload: { status: 'loading' }, meta: meta('status-loading') },
      origin: EDITOR_ORIGIN,
      source: contentWindow,
    }));
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'STATUS', payload: { status: 'error' }, meta: meta('status-error') },
      origin: EDITOR_ORIGIN,
      source: contentWindow,
    }));
  });
  assert.equal(statuses.length, statusCount, 'STATUS loading/error must not demote handshake after ready');
  assert.equal(overlayText(session.container), null, 'Export/data STATUS noise must not show Connecting to builder');

  const concurrent = Promise.all([
    editorRef.current.getHtml(),
    editorRef.current.getHtml(),
  ]);
  await tick();
  const htmlRequests = posts.filter(({ message }) => message.type === 'GET_HTML');
  assert.ok(htmlRequests.length >= 3);
  for (const request of htmlRequests.slice(-2)) {
    await act(async () => {
      window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: {
          type: 'HTML_RESULT',
          payload: { html: `<p>${request.message.meta.id}</p>` },
          meta: meta(`r-${request.message.meta.id}`, { correlationId: request.message.meta.id }),
        },
        origin: EDITOR_ORIGIN,
        source: contentWindow,
      }));
    });
  }
  const concurrentResults = await concurrent;
  assert.equal(concurrentResults.length, 2);

  await session.close();
}
console.log('PASS\tgetHtml/getJson return correlated current content and never reopen Connecting overlay');

{
  const { session, editorRef, posts, contentWindow } = await mountReadyEditor();
  const pending = editorRef.current.getHtml();
  await tick();
  const request = posts.find(({ message }) => message.type === 'GET_HTML');
  const rejection = assert.rejects(pending, /unmounted|not available|failed|timed out|restarted|reload/i);
  await session.close();
  await rejection;

  await act(async () => {
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'HTML_RESULT',
        payload: { html: '<p>late</p>' },
        meta: meta('late', { correlationId: request.message.meta.id }),
      },
      origin: EDITOR_ORIGIN,
      source: contentWindow,
    }));
  });
}
console.log('PASS\tlate responses after unmount are rejected and ignored');

{
  const { session, editorRef, posts, contentWindow } = await mountReadyEditor();
  const pending = editorRef.current.getHtml();
  await tick();
  const request = posts.at(-1);
  await act(async () => {
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'HTML_RESULT',
        payload: { html: '<p>wrong-origin</p>' },
        meta: meta('wo', { correlationId: request.message.meta.id }),
      },
      origin: 'https://evil.example',
      source: contentWindow,
    }));
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'HTML_RESULT',
        payload: { html: '<p>wrong-window</p>' },
        meta: meta('ww', { correlationId: request.message.meta.id }),
      },
      origin: EDITOR_ORIGIN,
      source: {},
    }));
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'HTML_RESULT',
        payload: { html: 7 },
        meta: meta('bad', { correlationId: request.message.meta.id }),
      },
      origin: EDITOR_ORIGIN,
      source: contentWindow,
    }));
  });
  const rejection = assert.rejects(pending, /Export failed|data request failed/i);
  await act(async () => {
    window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'DATA_ERROR',
        payload: { message: 'Export failed' },
        meta: meta('err', { correlationId: request.message.meta.id }),
      },
      origin: EDITOR_ORIGIN,
      source: contentWindow,
    }));
  });
  await rejection;
  await session.close();
}
console.log('PASS\twrong origin/window and malformed results are rejected safely');

{
  const { session, posts } = await mountReadyEditor({ exportUi: true });
  const init = posts.find(({ message }) => message.type === 'INIT') ?? posts[0];
  // Eager INIT is posted on iframe load before READY; locate it.
  const initMessage = posts.map(({ message }) => message).find((message) => message.type === 'INIT');
  assert.equal(initMessage.payload.features?.exportUi, true);
  await session.close();
}
console.log('PASS\texportUi:true is sent through INIT features');

{
  const { session, posts } = await mountReadyEditor({ exportUi: false });
  const initMessage = posts.map(({ message }) => message).find((message) => message.type === 'INIT');
  assert.equal(initMessage.payload.features, undefined);
  await session.close();
}
console.log('PASS\texportUi defaults to hidden in embedded INIT (no features.exportUi)');

{
  const { session, editorRef, statuses, iframe } = await mountReadyEditor();
  await act(async () => {
    editorRef.current.reload();
  });
  await waitFor(() => statuses.at(-1) === 'loading', 'reload must restart handshake loading');
  assert.ok(overlayText(session.container)?.includes('Connecting to builder'));
  assert.ok(iframe);
  await session.close();
}
console.log('PASS\texplicit reload restarts the handshake and may show Connecting to builder');
