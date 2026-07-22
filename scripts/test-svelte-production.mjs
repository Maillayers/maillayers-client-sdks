/**
 * Direct SvelteKit production gate.
 * Packs @maillayers/svelte-email-editor@0.1.0, installs the exact tarball into a
 * clean SvelteKit consumer, production-builds it, and verifies READY/INIT against
 * https://editor.maillayers.com.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'ml-svelte-prod-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = Date.now();

let chrome = null;
let server = null;
let cdp = null;

async function cleanup() {
  try { cdp?.close(); } catch { /* ignore */ }
  try { chrome?.kill('SIGKILL'); } catch { /* ignore */ }
  try { server?.close(); } catch { /* ignore */ }
  await rm(temporary, { recursive: true, force: true }).catch(() => {});
}

process.on('exit', () => {
  try { chrome?.kill('SIGKILL'); } catch { /* ignore */ }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await cleanup();
    process.exit(1);
  });
}

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
  console.log(`+ ${command} ${args.join(' ')}`);
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
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolvePort(port)));
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
    this.consoleErrors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolveOpen, reject) => {
      this.ws.addEventListener('open', () => resolveOpen());
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (message.method === 'Runtime.exceptionThrown') {
        const text = message.params?.exceptionDetails?.text
          || message.params?.exceptionDetails?.exception?.description
          || 'runtime exception';
        this.consoleErrors.push(text);
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        const args = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
        this.consoleErrors.push(args);
      }
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

try {
  const apiKey = await readApiKey();
  console.log('Building and packing @maillayers/svelte-email-editor...');
  if (process.env.ML_SKIP_BUILD !== '1') {
    run('npm', ['run', 'build:publish', '-w', '@maillayers/svelte-email-editor'], root);
  } else {
    console.log('+ ML_SKIP_BUILD=1 — reusing existing packages/svelte/dist');
  }
  const packDir = resolve(temporary, 'pack');
  await mkdir(packDir, { recursive: true });
  run('npm', ['pack', '-w', '@maillayers/svelte-email-editor', '--ignore-scripts', '--pack-destination', packDir], root);
  const tarball = resolve(packDir, 'maillayers-svelte-email-editor-0.1.0.tgz');
  await access(tarball);
  const tarballSha = createHash('sha256').update(await readFile(tarball)).digest('hex');
  console.log(`tarball=${tarball}`);
  console.log(`sha256=${tarballSha}`);

  // SSR-safe import from the exact tarball
  {
    const extract = resolve(temporary, 'ssr-import');
    await mkdir(extract, { recursive: true });
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
    `], { cwd: extract, encoding: 'utf8' });
    if (ssr.status !== 0) throw new Error(`SSR import failed\n${ssr.stdout}\n${ssr.stderr}`);
    console.log('PASS\tSvelte tarball SSR-safe import');
  }

  // Clean SvelteKit consumer
  const kitDir = resolve(temporary, 'sveltekit-app');
  await mkdir(resolve(kitDir, 'src/routes'), { recursive: true });
  await mkdir(resolve(kitDir, 'static'), { recursive: true });
  await writeFile(resolve(kitDir, 'package.json'), JSON.stringify({
    name: 'sveltekit-maillayers-prod-gate',
    private: true,
    type: 'module',
    scripts: {
      build: 'vite build',
      preview: 'vite preview --host localhost --strictPort',
    },
  }, null, 2));
  await writeFile(resolve(kitDir, 'svelte.config.js'), `
import adapter from '@sveltejs/adapter-static';
export default {
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: true,
    }),
  },
  compilerOptions: { compatibility: { componentApi: 4 } },
};
`);
  await writeFile(resolve(kitDir, 'vite.config.ts'), `
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [sveltekit()],
  build: { minify: false },
  preview: { host: 'localhost' },
});
`);
  await writeFile(resolve(kitDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      sourceMap: true,
      strict: true,
      moduleResolution: 'bundler',
      module: 'esnext',
      target: 'esnext',
    },
    include: ['src/**/*.ts', 'src/**/*.svelte'],
  }, null, 2));
  await writeFile(resolve(kitDir, 'src/app.html'), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
    <style>html,body{margin:0;height:100%}body{display:flex;flex-direction:column}</style>
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display:contents">%sveltekit.body%</div>
  </body>
</html>
`);
  await writeFile(resolve(kitDir, 'src/app.d.ts'), `declare global { namespace App {} } export {};`);
  // iframe editor hosts are client-only; SSR-safe import is verified separately above.
  await writeFile(resolve(kitDir, 'src/routes/+layout.ts'), `
export const ssr = false;
export const prerender = true;
`);
  await writeFile(resolve(kitDir, 'src/routes/+page.ts'), `
export const ssr = false;
export const prerender = true;
export function load() {
  return { apiKey: ${JSON.stringify(apiKey)} };
}
`);
  await writeFile(resolve(kitDir, 'src/routes/+page.svelte'), `
<script lang="ts">
  import { MailLayersEmailEditor } from '@maillayers/svelte-email-editor';
  import { onMount } from 'svelte';

  export let data: { apiKey: string };
  const apiKey = data.apiKey;

  let editorA: MailLayersEmailEditor;
  let editorB: MailLayersEmailEditor | undefined;
  let showB = true;
  let showInvalid = false;
  const evidence = {
    ready: [] as string[],
    changes: [] as Array<{ id: string; html: string }>,
    saves: [] as Array<{ id: string; html: string }>,
    auth: [] as Array<{ id: string; message: string }>,
    statuses: [] as Array<{ id: string; status: string }>,
  };

  onMount(() => {
    (window as any).__evidence = evidence;
    (window as any).__mlOutbound = [];
    (window as any).__controls = {
      reloadA: () => editorA?.reload(),
      toggleB: () => { showB = !showB; },
      showInvalid: () => { showInvalid = true; },
    };
    const timer = setInterval(() => {
      (window as any).__iframeSrcs = [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src'));
      (window as any).__inits = ((window as any).__mlOutbound || []).filter((e: any) => e.type === 'INIT');
      (window as any).__wildcards = ((window as any).__mlOutbound || []).filter((e: any) => e.targetOrigin === '*').length;
    }, 200);
    return () => clearInterval(timer);
  });
</script>

<div style="display:flex;flex-direction:column;height:100vh;gap:8px;padding:8px;box-sizing:border-box">
  <div style="display:flex;gap:8px">
    <button id="reload-a" type="button" on:click={() => editorA.reload()}>Reload A</button>
    <button id="remount" type="button" on:click={() => showB = !showB}>Toggle B</button>
    <button id="show-invalid" type="button" on:click={() => showInvalid = true}>Show invalid</button>
    <span id="status">{evidence.ready.join(',')}</span>
  </div>
  <div style="display:flex;flex:1;gap:8px;min-height:0">
    <div style="flex:1;min-height:320px;border:1px solid #ccc">
      <MailLayersEmailEditor
        bind:this={editorA}
        {apiKey}
        initialHtml="<p>sveltekit-a</p>"
        on:ready={() => evidence.ready.push('A')}
        on:change={(e) => evidence.changes.push({ id: 'A', html: e.detail })}
        on:save={(e) => evidence.saves.push({ id: 'A', html: e.detail })}
        on:authError={(e) => evidence.auth.push({ id: 'A', message: e.detail })}
        on:statusChange={(e) => evidence.statuses.push({ id: 'A', status: e.detail })}
      />
    </div>
    {#if showB}
      <div style="flex:1;min-height:320px;border:1px solid #ccc">
        <MailLayersEmailEditor
          bind:this={editorB}
          {apiKey}
          initialHtml="<p>sveltekit-b</p>"
          on:ready={() => evidence.ready.push('B')}
          on:change={(e) => evidence.changes.push({ id: 'B', html: e.detail })}
          on:authError={(e) => evidence.auth.push({ id: 'B', message: e.detail })}
          on:statusChange={(e) => evidence.statuses.push({ id: 'B', status: e.detail })}
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

  run('npm', [
    'install',
    tarball,
    'svelte@5',
    '@sveltejs/kit@2',
    '@sveltejs/adapter-static@3',
    '@sveltejs/vite-plugin-svelte@5',
    'vite@6',
    'typescript@5.7',
    '--no-audit',
    '--no-fund',
    '--legacy-peer-deps',
  ], kitDir);

  run('npx', ['vite', 'build'], kitDir, { NODE_ENV: 'production' });
  console.log('PASS\tSvelteKit production build');

  const serveRoot = resolve(kitDir, 'build');
  await access(resolve(serveRoot, 'index.html'));

  const port = await freePort();
  server = createServer(async (req, res) => {
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
        res.writeHead(404);
        res.end('missing');
      }
    }
  });
  await new Promise((r) => server.listen(port, 'localhost', r));
  console.log(`+ static server listening on http://localhost:${port}/ (pid-bound to gate)`);

  const chromePort = await freePort();
  const profile = resolve(temporary, 'chrome');
  await mkdir(profile, { recursive: true });
  const chromePath = process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome';
  console.log(`+ ${chromePath} --headless=new --remote-debugging-port=${chromePort}`);
  chrome = spawn(chromePath, [
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
  cdp = new Cdp(page.webSocketDebuggerUrl);
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
      } catch { /* ignore transient */ }
      await wait(400);
    }
    throw new Error(`${message}: ${JSON.stringify(last)}`);
  }

  const ready = await waitFor(
    `(() => {
      const evidence = window.__evidence;
      return evidence ? {
        ready: evidence.ready,
        changes: evidence.changes,
        statuses: evidence.statuses,
        inits: window.__inits || [],
        wildcards: window.__wildcards || 0,
        srcs: window.__iframeSrcs || [],
      } : null;
    })()`,
    (value) => value
      && value.ready.includes('A')
      && value.ready.includes('B')
      && value.inits.length >= 2
      && value.statuses.some((entry) => entry.id === 'A')
      && value.statuses.some((entry) => entry.id === 'B'),
    'SvelteKit production READY/INIT handshake failed',
    120000,
  );
  assert.ok(ready.inits.every((entry) => entry.targetOrigin === 'https://editor.maillayers.com'));
  assert.equal(ready.wildcards, 0);
  assert.ok(ready.srcs.every((src) => !src || src === 'about:blank' || src.startsWith('https://editor.maillayers.com')));
  console.log('PASS\tSvelteKit dual-instance production handshake + events');

  await cdp.evaluate(`document.getElementById('reload-a').click()`);
  const reloaded = await waitFor(
    `(() => ({ inits: window.__inits || [], wildcards: window.__wildcards || 0 }))()`,
    (value) => value && value.inits.length >= 3,
    'SvelteKit reload did not send a fresh INIT',
  );
  assert.ok(reloaded.inits.every((entry) => entry.targetOrigin === 'https://editor.maillayers.com'));
  assert.equal(reloaded.wildcards, 0);
  console.log('PASS\tSvelteKit reload() creates a fresh INIT');

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
    'SvelteKit destroy/remount of second instance failed',
  );
  void remounted;
  console.log('PASS\tSvelteKit destroy/remount of second instance');

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
    'SvelteKit invalid API key did not fail closed',
    30000,
  );
  assert.equal(invalid.src, 'about:blank');
  assert.ok(!String(invalid.auth[0].message).includes(apiKey));
  console.log('PASS\tSvelteKit invalid API key keeps iframe at about:blank');

  assert.equal(cdp.consoleErrors.length, 0, `console errors: ${JSON.stringify(cdp.consoleErrors)}`);
  console.log('PASS\tno console errors');

  const evidence = {
    framework: 'sveltekit',
    tarball: 'maillayers-svelte-email-editor-0.1.0.tgz',
    sha256: tarballSha,
    readyInstances: ready.ready,
    initCount: ready.inits.length,
    reloadInitCount: reloaded.inits.length,
    statusEvents: ready.statuses.length,
    wildcards: reloaded.wildcards,
    consoleErrors: cdp.consoleErrors.length,
    editor: 'https://editor.maillayers.com',
    runtimeMs: Date.now() - startedAt,
  };
  console.log(JSON.stringify(evidence, null, 2));

  await cleanup();
  console.log('SvelteKit direct production gate passed');
} catch (error) {
  await cleanup();
  throw error;
}
