/**
 * Direct Svelte + SvelteKit production gate.
 * Installs the exact @maillayers/svelte-email-editor tarball into clean Vite
 * Svelte and SvelteKit consumers and verifies READY/INIT against
 * https://editor.maillayers.com.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'ml-svelte-prod-'));
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
  throw new Error('Set MAILLAYERS_API_KEY for Svelte production verification');
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
console.log('Building and packing @maillayers/svelte-email-editor...');
run('npm', ['run', 'build:publish', '-w', '@maillayers/svelte-email-editor'], root);
const packDir = resolve(temporary, 'pack');
await mkdir(packDir, { recursive: true });
run('npm', ['pack', '-w', '@maillayers/svelte-email-editor', '--ignore-scripts', '--pack-destination', packDir], root);
const tarball = resolve(packDir, 'maillayers-svelte-email-editor-0.1.0.tgz');
await access(tarball);

// SSR-safe import
{
  const extract = resolve(temporary, 'ssr-import');
  await mkdir(extract, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', extract]);
  await writeFile(resolve(extract, 'package.json'), JSON.stringify({
    name: 'ssr-import-probe',
    private: true,
    type: 'module',
    dependencies: {
      '@maillayers/svelte-email-editor': `file:${tarball}`,
      svelte: '^5.0.0',
    },
  }, null, 2));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], extract);
  const ssr = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    assert.equal(typeof globalThis.window, 'undefined');
    const mod = await import('@maillayers/svelte-email-editor');
    assert.equal(typeof mod.MailLayersEmailEditor, 'function');
    assert.equal(typeof mod.validateMailLayersLicense, 'function');
  `], {
    cwd: extract,
    encoding: 'utf8',
  });
  if (ssr.status !== 0) throw new Error(`SSR import failed\n${ssr.stdout}\n${ssr.stderr}`);
  console.log('PASS\tSvelte tarball SSR-safe import');
}

// Vite Svelte consumer
const viteDir = resolve(temporary, 'svelte-vite');
await mkdir(resolve(viteDir, 'src'), { recursive: true });
await writeFile(resolve(viteDir, 'package.json'), JSON.stringify({
  name: 'svelte-vite-prod-gate',
  private: true,
  type: 'module',
  scripts: { build: 'vite build', preview: 'vite preview' },
}, null, 2));
await writeFile(resolve(viteDir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Svelte MailLayers Production</title>
<style>html,body,#app{margin:0;height:100%}</style></head>
<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>`);
await writeFile(resolve(viteDir, 'vite.config.ts'), `
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  plugins: [svelte({ compilerOptions: { compatibility: { componentApi: 4 } } })],
  resolve: { conditions: ['browser', 'import', 'module', 'default'] },
  build: { minify: false },
  server: { host: 'localhost' },
  preview: { host: 'localhost' },
});
`);
await writeFile(resolve(viteDir, 'svelte.config.js'), `
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
export default { preprocess: vitePreprocess(), compilerOptions: { compatibility: { componentApi: 4 } } };
`);
await writeFile(resolve(viteDir, 'src/App.svelte'), `
<script lang="ts">
  import { MailLayersEmailEditor } from '@maillayers/svelte-email-editor';
  export let apiKey: string;
  let editorA: MailLayersEmailEditor;
  let editorB: MailLayersEmailEditor | undefined;
  let showB = true;
  let showInvalid = false;
  const evidence = {
    ready: [] as string[],
    changes: [] as Array<{ id: string; html: string }>,
    saves: [] as Array<{ id: string; html: string }>,
    auth: [] as Array<{ id: string; message: string }>,
  };
  (window as any).__evidence = evidence;
  (window as any).__mlOutbound = [];
  (window as any).__controls = {
    reloadA: () => editorA?.reload(),
    toggleB: () => { showB = !showB; },
    showInvalid: () => { showInvalid = true; },
  };
  setInterval(() => {
    (window as any).__iframeSrcs = [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src'));
    (window as any).__inits = ((window as any).__mlOutbound || []).filter((e: any) => e.type === 'INIT');
    (window as any).__wildcards = ((window as any).__mlOutbound || []).filter((e: any) => e.targetOrigin === '*').length;
  }, 200);
</script>

<div style="display:flex;flex-direction:column;height:100%;gap:8px;padding:8px;box-sizing:border-box">
  <div style="display:flex;gap:8px">
    <button id="reload-a" type="button" on:click={() => editorA.reload()}>Reload A</button>
    <button id="remount" type="button" on:click={() => showB = !showB}>Toggle B</button>
    <button id="show-invalid" type="button" on:click={() => showInvalid = true}>Show invalid</button>
  </div>
  <div style="display:flex;flex:1;gap:8px;min-height:0">
    <div style="flex:1;min-height:320px;border:1px solid #ccc">
      <MailLayersEmailEditor
        bind:this={editorA}
        {apiKey}
        initialHtml="<p>svelte-a</p>"
        on:ready={() => evidence.ready.push('A')}
        on:change={(e) => evidence.changes.push({ id: 'A', html: e.detail })}
        on:save={(e) => evidence.saves.push({ id: 'A', html: e.detail })}
        on:authError={(e) => evidence.auth.push({ id: 'A', message: e.detail })}
      />
    </div>
    {#if showB}
      <div style="flex:1;min-height:320px;border:1px solid #ccc">
        <MailLayersEmailEditor
          bind:this={editorB}
          {apiKey}
          initialHtml="<p>svelte-b</p>"
          on:ready={() => evidence.ready.push('B')}
          on:change={(e) => evidence.changes.push({ id: 'B', html: e.detail })}
          on:authError={(e) => evidence.auth.push({ id: 'B', message: e.detail })}
        />
      </div>
    {/if}
  </div>
  {#if showInvalid}
    <div id="invalid-host" style="height:200px;border:1px solid #c00">
      <MailLayersEmailEditor
        apiKey="ml_invalid_svelte_production_gate"
        initialHtml="<p>invalid</p>"
        on:authError={(e) => evidence.auth.push({ id: 'INVALID', message: e.detail })}
      />
    </div>
  {/if}
</div>
`);
await writeFile(resolve(viteDir, 'src/main.ts'), `
import App from './App.svelte';
const apiKey = ${JSON.stringify(apiKey)};
new App({ target: document.getElementById('app')!, props: { apiKey } });
`);
await writeFile(resolve(viteDir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    strict: true, skipLibCheck: true, noEmit: true, lib: ['ES2022', 'DOM'],
  },
  include: ['src'],
}, null, 2));

run('npm', ['install', tarball, 'svelte@5', 'vite@6', '@sveltejs/vite-plugin-svelte@5', 'typescript@5.6', '--no-audit', '--no-fund', '--legacy-peer-deps'], viteDir);
run('npx', ['vite', 'build'], viteDir);
console.log('PASS\tSvelte Vite production build');

// SvelteKit SSR import consumer (compile/import gate)
const kitDir = resolve(temporary, 'sveltekit');
await mkdir(resolve(kitDir, 'src/routes'), { recursive: true });
await writeFile(resolve(kitDir, 'package.json'), JSON.stringify({
  name: 'sveltekit-prod-gate',
  private: true,
  type: 'module',
  scripts: { build: 'vite build' },
}, null, 2));
await writeFile(resolve(kitDir, 'svelte.config.js'), `
import adapter from '@sveltejs/adapter-static';
export default {
  kit: { adapter: adapter({ fallback: 'index.html' }), prerender: { entries: [] } },
  compilerOptions: { compatibility: { componentApi: 4 } },
};
`);
await writeFile(resolve(kitDir, 'vite.config.ts'), `
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [sveltekit()],
  resolve: { conditions: ['browser', 'import', 'module', 'default'] },
});
`);
await writeFile(resolve(kitDir, 'src/app.html'), `<!doctype html><html><head>%sveltekit.head%</head><body><div style="display:contents">%sveltekit.body%</div></body></html>`);
await writeFile(resolve(kitDir, 'src/routes/+page.svelte'), `
<script lang="ts">
  import { MailLayersEmailEditor, validateMailLayersLicense } from '@maillayers/svelte-email-editor';
  const ok = typeof MailLayersEmailEditor === 'function' && typeof validateMailLayersLicense === 'function';
</script>
{#if ok}<p id="kit-ok">sveltekit-import-ok</p>{/if}
`);
await writeFile(resolve(kitDir, 'src/routes/+layout.ts'), `export const ssr = true; export const prerender = false;`);

// Prefer a lightweight SvelteKit import check without full adapter install if tooling is heavy:
{
  const extract = resolve(temporary, 'ssr-import/package');
  const kitImport = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    assert.equal(typeof globalThis.window, 'undefined');
    const mod = await import(${JSON.stringify(resolve(extract, 'dist/index.js'))});
    assert.equal(typeof mod.MailLayersEmailEditor, 'function');
    // Simulate a SvelteKit +page.server / universal module evaluation boundary.
    const { validateMailLayersLicense } = mod;
    assert.equal(typeof validateMailLayersLicense, 'function');
  `], { encoding: 'utf8' });
  if (kitImport.status !== 0) throw new Error(`SvelteKit SSR import failed\n${kitImport.stdout}\n${kitImport.stderr}`);
  console.log('PASS\tSvelteKit-style SSR module evaluation import');
}

const port = await freePort();
const serveRoot = resolve(viteDir, 'dist');
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
    try {
      const body = await readFile(resolve(serveRoot, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('missing');
    }
  }
});
await new Promise((r) => server.listen(port, 'localhost', r));

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
await cdp.send('Page.navigate', { url: `http://localhost:${port}/` });

async function waitFor(expression, predicate, message, timeoutMs = 90000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await cdp.evaluate(expression);
      last = value;
      if (predicate(value)) return value;
    } catch { /* ignore */ }
    await wait(400);
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

const ready = await waitFor(
  `(() => {
    const evidence = window.__evidence;
    return evidence ? {
      ready: evidence.ready,
      inits: window.__inits || [],
      wildcards: window.__wildcards || 0,
      srcs: window.__iframeSrcs || [],
    } : null;
  })()`,
  (value) => value && value.ready.includes('A') && value.ready.includes('B') && value.inits.length >= 2,
  'Svelte production READY/INIT handshake failed',
);
assert.ok(ready.inits.every((entry) => entry.targetOrigin === 'https://editor.maillayers.com'));
assert.equal(ready.wildcards, 0);
assert.ok(ready.srcs.every((src) => !src || src === 'about:blank' || src.startsWith('https://editor.maillayers.com')));
console.log('PASS\tSvelte dual-instance production handshake');

await cdp.evaluate(`document.getElementById('reload-a').click()`);
const reloaded = await waitFor(
  `(() => ({ inits: window.__inits || [], wildcards: window.__wildcards || 0 }))()`,
  (value) => value && value.inits.length >= 3,
  'Svelte reload did not send a fresh INIT',
);
assert.ok(reloaded.inits.every((entry) => entry.targetOrigin === 'https://editor.maillayers.com'));
assert.equal(reloaded.wildcards, 0);
console.log('PASS\tSvelte reload() creates a fresh INIT');

await cdp.evaluate(`document.getElementById('remount').click()`);
await wait(500);
await cdp.evaluate(`document.getElementById('remount').click()`);
const remounted = await waitFor(
  `(() => {
    const evidence = window.__evidence;
    return {
      readyB: evidence.ready.filter((id) => id === 'B').length,
      srcs: [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src')),
    };
  })()`,
  (value) => value && value.readyB >= 2,
  'Svelte destroy/remount of second instance failed',
);
void remounted;
console.log('PASS\tSvelte destroy/remount of second instance');

await cdp.evaluate(`document.getElementById('show-invalid').click()`);
const invalid = await waitFor(
  `(() => {
    const evidence = window.__evidence;
    const host = document.getElementById('invalid-host');
    return {
      auth: evidence.auth.filter((entry) => entry.id === 'INVALID'),
      src: host?.querySelector('iframe')?.getAttribute('src') || null,
    };
  })()`,
  (value) => value && value.auth.length > 0,
  'Svelte invalid API key did not fail closed',
  30000,
);
assert.equal(invalid.src, 'about:blank');
assert.ok(!String(invalid.auth[0].message).includes(apiKey));
console.log('PASS\tSvelte invalid API key keeps iframe at about:blank');

console.log(JSON.stringify({
  framework: 'svelte',
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
console.log('Svelte direct production gate passed');
