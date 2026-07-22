/**
 * Direct Angular CLI production gate.
 * Installs the exact @maillayers/angular-email-editor tarball into a clean
 * Angular CLI application and verifies READY/INIT against editor.maillayers.com.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const temporary = await mkdtemp(resolve(tmpdir(), 'ml-angular-prod-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function readApiKey() {
  if (process.env.MAILLAYERS_API_KEY) return process.env.MAILLAYERS_API_KEY.trim();
  for (const candidate of [resolve(root, '../editor/.env'), resolve(process.cwd(), '../editor/.env')]) {
    try {
      const text = await readFile(candidate, 'utf8');
      const match = text.match(/^VITE_MAILLAYERS_API_KEY=(.+)$/m);
      if (match) return match[1].trim();
    } catch { /* continue */ }
  }
  throw new Error('Set MAILLAYERS_API_KEY for Angular production verification');
}

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env, npm_config_dry_run: 'false' },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const open = await new Promise((resolveOpen) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolveOpen(true);
      });
      socket.on('error', () => resolveOpen(false));
    });
    if (open) return;
    await wait(250);
  }
  throw new Error(`port ${port} did not open`);
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolveOpen, reject) => {
      this.ws.addEventListener('open', () => resolveOpen());
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: resolvePending, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolvePending(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId += 1;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
    return result.result?.value;
  }

  close() {
    this.ws?.close();
  }
}

const apiKey = await readApiKey();
console.log('Building and packing @maillayers/angular-email-editor...');
if (process.env.ML_SKIP_BUILD !== '1') run('npm', ['run', 'build:publish', '-w', '@maillayers/angular-email-editor'], root);
const packDir = resolve(temporary, 'pack');
await mkdir(packDir, { recursive: true });
run('npm', ['pack', '-w', '@maillayers/angular-email-editor', '--ignore-scripts', '--pack-destination', packDir], root);
const tarball = resolve(packDir, 'maillayers-angular-email-editor-0.1.0.tgz');
await access(tarball);

// SSR-safe import of the packed package without browser globals.
{
  const extract = resolve(temporary, 'ssr-import');
  await mkdir(extract, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', extract]);
  const modules = resolve(extract, 'node_modules');
  await mkdir(modules, { recursive: true });
  // Provide peer packages so the ESM graph can evaluate without a browser.
  for (const name of ['@angular/core', '@angular/common', '@angular/compiler', 'rxjs', 'tslib']) {
    const source = resolve(root, 'node_modules', name);
    try {
      await access(source);
      await cp(source, resolve(modules, name), { recursive: true });
    } catch {
      // optional peer may be hoisted differently
    }
  }
  const ssr = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    assert.equal(typeof globalThis.window, 'undefined');
    import '@angular/compiler';
    const mod = await import(${JSON.stringify(resolve(extract, 'package/dist/fesm2022/maillayers-angular-email-editor.mjs'))});
    assert.equal(typeof mod.MailLayersEmailEditorComponent, 'function');
    assert.equal(typeof mod.MailLayersEmailEditorModule, 'function');
    assert.equal(typeof mod.validateMailLayersLicense, 'function');
  `], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: modules },
  });
  if (ssr.status !== 0) throw new Error(`SSR import failed\n${ssr.stdout}\n${ssr.stderr}`);
  console.log('PASS\tAngular tarball SSR-safe import');
}

const appDir = resolve(temporary, 'angular-app');
console.log('Creating Angular CLI application...');
run('npx', ['-y', '@angular/cli@19', 'new', 'angular-app', '--defaults', '--routing=false', '--style=css', '--ssr=false', '--skip-git=true', '--package-manager=npm'], temporary, {
  NG_CLI_ANALYTICS: 'false',
});

run('npm', ['install', tarball, '--legacy-peer-deps', '--no-audit', '--no-fund'], appDir);

// Standalone host + NgModule host + dual instances + reload controls.
await writeFile(resolve(appDir, 'src/app/app.component.ts'), `
import { Component, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MailLayersEmailEditorComponent,
  MailLayersEmailEditorModule,
} from '@maillayers/angular-email-editor';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, MailLayersEmailEditorComponent, MailLayersEmailEditorModule],
  template: \`
    <div style="display:flex;flex-direction:column;height:100vh;gap:8px;padding:8px;box-sizing:border-box">
      <div style="display:flex;gap:8px">
        <button id="reload-a" type="button" (click)="editorA?.reload()">Reload A</button>
        <button id="remount" type="button" (click)="toggleB()">Toggle B</button>
        <button id="show-invalid" type="button" (click)="showInvalid = true">Show invalid</button>
        <span id="status">{{ status }}</span>
      </div>
      <div style="display:flex;flex:1;gap:8px;min-height:0">
        <maillayers-email-editor
          #editorA
          style="flex:1;min-height:320px;border:1px solid #ccc"
          [apiKey]="apiKey"
          [initialHtml]="htmlA"
          (ready)="onReady('A')"
          (change)="onChange('A', $event)"
          (save)="onSave('A', $event)"
          (authError)="onAuth('A', $event)"
          (statusChange)="onStatus('A', $event)"
        />
        @if (showB) {
          <maillayers-email-editor
            #editorB
            style="flex:1;min-height:320px;border:1px solid #ccc"
            [apiKey]="apiKey"
            [initialHtml]="htmlB"
            (ready)="onReady('B')"
            (change)="onChange('B', $event)"
            (authError)="onAuth('B', $event)"
            (statusChange)="onStatus('B', $event)"
          />
        }
      </div>
      <div id="module-host" style="height:280px;border:1px solid #999">
        <maillayers-email-editor
          [apiKey]="apiKey"
          [initialHtml]="'<p>module-host</p>'"
          (ready)="onReady('M')"
          (authError)="onAuth('M', $event)"
        />
      </div>
      @if (showInvalid) {
        <div id="invalid-host" style="height:200px;border:1px solid #c00">
          <maillayers-email-editor
            [apiKey]="'ml_invalid_angular_production_gate'"
            [initialHtml]="'<p>invalid</p>'"
            (authError)="onAuth('INVALID', $event)"
            (statusChange)="onStatus('INVALID', $event)"
          />
        </div>
      }
    </div>
  \`,
})
export class AppComponent {
  @ViewChild('editorA') editorA?: MailLayersEmailEditorComponent;
  @ViewChild('editorB') editorB?: MailLayersEmailEditorComponent;
  apiKey = ${JSON.stringify(apiKey)};
  htmlA = '<p>angular-standalone-a</p>';
  htmlB = '<p>angular-standalone-b</p>';
  showB = true;
  showInvalid = false;
  status = 'booting';
  evidence = {
    ready: [] as string[],
    changes: [] as Array<{ id: string; html: string }>,
    saves: [] as Array<{ id: string; html: string }>,
    auth: [] as Array<{ id: string; message: string }>,
    statuses: [] as Array<{ id: string; status: string }>,
    wildcards: 0,
    consoleErrors: [] as string[],
    inits: [] as Array<{ targetOrigin: string; html?: string }>,
  };

  constructor() {
    (window as any).__evidence = this.evidence;
    (window as any).__app = this;
    const outbound = ((window as any).__mlOutbound = [] as any[]);
    const native = Window.prototype.postMessage;
    // Best-effort wildcard detection for same-window posts; controller also records __mlOutbound.
    Window.prototype.postMessage = function(this: Window, message: any, targetOrigin?: any, transfer?: Transferable[]) {
      if (targetOrigin === '*') (window as any).__evidence.wildcards += 1;
      return (native as any).apply(this, arguments);
    } as typeof Window.prototype.postMessage;
    setInterval(() => {
      this.evidence.inits = outbound.filter((entry) => entry.type === 'INIT');
      this.evidence.wildcards = outbound.filter((entry) => entry.targetOrigin === '*').length;
      (window as any).__iframeSrcs = [...document.querySelectorAll('iframe')].map((frame) => frame.getAttribute('src'));
    }, 200);
  }

  onReady(id: string) {
    this.evidence.ready.push(id);
    this.status = 'ready:' + this.evidence.ready.join(',');
  }
  onChange(id: string, html: string) { this.evidence.changes.push({ id, html }); }
  onSave(id: string, html: string) { this.evidence.saves.push({ id, html }); }
  onAuth(id: string, message: string) { this.evidence.auth.push({ id, message }); }
  onStatus(id: string, status: string) { this.evidence.statuses.push({ id, status }); }
  toggleB() { this.showB = !this.showB; }
}
`);

await writeFile(resolve(appDir, 'src/app/app.config.ts'), `
import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
export const appConfig: ApplicationConfig = {
  providers: [provideZoneChangeDetection()],
};
`);

await writeFile(resolve(appDir, 'src/main.ts'), `
import 'zone.js';
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';
bootstrapApplication(AppComponent, appConfig).catch((error) => {
  (window as any).__bootError = String(error);
});
`);

await writeFile(resolve(appDir, 'src/index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Angular MailLayers Production Gate</title>
  <base href="/">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <app-root></app-root>
</body>
</html>
`);

console.log('Running Angular production build...');
run('npx', ['ng', 'build', '--configuration=production'], appDir, { NG_CLI_ANALYTICS: 'false' });
console.log('PASS\tAngular CLI production build');

// Invalid-key page for fail-closed check.
const distDir = resolve(appDir, 'dist/angular-app/browser');
try {
  await access(distDir);
} catch {
  // Angular 19 may emit to dist/angular-app without browser/
  const alt = resolve(appDir, 'dist/angular-app');
  await access(alt);
}

const serveRoot = await (async () => {
  try {
    await access(resolve(appDir, 'dist/angular-app/browser/index.html'));
    return resolve(appDir, 'dist/angular-app/browser');
  } catch {
    return resolve(appDir, 'dist/angular-app');
  }
})();

const port = await freePort();
const server = createServer(async (req, res) => {
  const relative = (req.url || '/').split('?')[0];
  const path = relative === '/' ? '/index.html' : relative;
  try {
    const body = await readFile(resolve(serveRoot, '.' + path));
    const type = path.endsWith('.js') ? 'text/javascript'
      : path.endsWith('.css') ? 'text/css'
        : path.endsWith('.html') ? 'text/html'
          : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    // SPA fallback
    try {
      const body = await readFile(resolve(serveRoot, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('missing');
    }
  }
});
await new Promise((resolveListen) => server.listen(port, 'localhost', resolveListen));

const chromePort = await freePort();
const profile = resolve(temporary, 'chrome');
await mkdir(profile, { recursive: true });
const chromePath = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome';
const chrome = spawn(chromePath, [
  `--remote-debugging-port=${chromePort}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  'about:blank',
], { stdio: 'ignore' });
await waitForPort(chromePort);

const targets = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
let page = targets.find((target) => target.type === 'page');
if (!page) {
  page = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: 'PUT' })).json();
}
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Console.enable');
const consoleErrors = [];
// Listen via CDP events through raw socket — Runtime.exceptionThrown is enough via evaluate later.

await cdp.send('Page.navigate', { url: `http://localhost:${port}/` });

async function waitFor(expression, predicate, message, timeoutMs = 90000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await cdp.evaluate(expression);
      last = value;
      if (predicate(value)) return value;
    } catch { /* ignore transient */ }
    await wait(400);
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

const ready = await waitFor(
  `(() => {
    const evidence = window.__evidence;
    const srcs = window.__iframeSrcs || [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src'));
    const outbound = window.__mlOutbound || [];
    return evidence ? {
      ready: evidence.ready,
      inits: outbound.filter((e) => e.type === 'INIT'),
      wildcards: outbound.filter((e) => e.targetOrigin === '*').length,
      auth: evidence.auth,
      srcs,
      bootError: window.__bootError || null,
    } : null;
  })()`,
  (value) => value && !value.bootError
    && value.ready.includes('A') && value.ready.includes('B') && value.ready.includes('M')
    && value.inits.length >= 3,
  'Angular production READY/INIT handshake failed',
  120000,
);

assert.ok(ready.srcs.every((src) => src === 'https://editor.maillayers.com' || src?.startsWith('https://editor.maillayers.com')), 'iframes must load production editor');
assert.ok(ready.inits.every((entry) => entry.targetOrigin === 'https://editor.maillayers.com'), 'INIT must use exact editor origin');
assert.equal(ready.wildcards, 0, 'no wildcard postMessage');
assert.ok(ready.ready.includes('M'), 'NgModule-imported editor instance must become ready');
console.log('PASS\tAngular standalone + NgModule dual-instance production handshake');

await cdp.evaluate(`document.getElementById('reload-a').click()`);
const reloaded = await waitFor(
  `(() => {
    const outbound = window.__mlOutbound || [];
    return { inits: outbound.filter((e) => e.type === 'INIT'), wildcards: outbound.filter((e) => e.targetOrigin === '*').length };
  })()`,
  (value) => value && value.inits.length >= 3,
  'Angular reload did not send a fresh INIT',
);
assert.ok(reloaded.inits.every((entry) => entry.targetOrigin === 'https://editor.maillayers.com'));
assert.equal(reloaded.wildcards, 0);
console.log('PASS\tAngular reload() creates a fresh INIT');

await cdp.evaluate(`document.getElementById('remount').click()`); // hide B
await wait(500);
await cdp.evaluate(`document.getElementById('remount').click()`); // show B again
const remounted = await waitFor(
  `(() => {
    const evidence = window.__evidence;
    const outbound = window.__mlOutbound || [];
    return {
      readyB: evidence.ready.filter((id) => id === 'B').length,
      inits: outbound.filter((e) => e.type === 'INIT').length,
      srcs: [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src')),
    };
  })()`,
  (value) => value && value.readyB >= 2 && value.srcs.filter((src) => src && src.includes('editor.maillayers.com')).length >= 3,
  'Angular destroy/remount of second instance failed',
);
void remounted;
console.log('PASS\tAngular destroy/remount of second instance');

await cdp.evaluate(`document.getElementById('show-invalid').click()`);
const invalid = await waitFor(
  `(() => {
    const evidence = window.__evidence;
    const host = document.getElementById('invalid-host');
    const src = host?.querySelector('iframe')?.getAttribute('src') || null;
    return {
      auth: evidence.auth.filter((entry) => entry.id === 'INVALID'),
      src,
    };
  })()`,
  (value) => value && value.auth.length > 0,
  'Angular invalid API key did not fail closed',
  30000,
);
assert.equal(invalid.src, 'about:blank');
assert.ok(!String(invalid.auth[0].message).includes(apiKey));
console.log('PASS\tAngular invalid API key keeps iframe at about:blank');

console.log(JSON.stringify({
  framework: 'angular',
  readyInstances: ready.ready,
  initCount: ready.inits.length,
  reloadInitCount: reloaded.inits.length,
  wildcards: reloaded.wildcards,
  editor: 'https://editor.maillayers.com',
}, null, 2));

cdp.close();
chrome.kill('SIGKILL');
server.close();
await rm(temporary, { recursive: true, force: true });
console.log('Angular direct production gate passed');
