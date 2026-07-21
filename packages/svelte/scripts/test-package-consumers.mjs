import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(root, '../..');
const localModules = existsSync(resolve(root, 'node_modules/svelte/package.json'))
  ? resolve(root, 'node_modules')
  : resolve(workspaceRoot, 'node_modules');
const temporary = await mkdtemp(resolve(tmpdir(), 'maillayers-svelte-consumers-'));

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: resolve(temporary, 'npm-cache'),
      npm_config_dry_run: 'false',
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

async function linkPackage(source, consumerNodeModules, name) {
  const target = resolve(consumerNodeModules, name);
  if (existsSync(target)) return;
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, 'dir');
}

try {
  run('npm', ['run', 'build:publish']);
  const packOutput = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]);
  const pack = JSON.parse(packOutput)[0];
  const tarball = resolve(temporary, pack.filename);
  const inventory = run('tar', ['-tzf', tarball]).trim().split('\n').sort();
  assert.ok(inventory.includes('package/LICENSE'));
  assert.ok(inventory.includes('package/README.md'));
  assert.ok(inventory.includes('package/package.json'));
  assert.ok(inventory.includes('package/dist/index.js'));
  assert.ok(inventory.includes('package/dist/index.cjs'));
  assert.ok(inventory.includes('package/dist/index.d.ts'));
  assert.equal(inventory.some((path) => /\.map$|^package\/src\/|^package\/scripts\/|\.env/.test(path)), false);

  const extracted = resolve(temporary, 'extracted');
  await mkdir(extracted);
  run('tar', ['-xzf', tarball, '-C', extracted]);
  const packedRoot = resolve(extracted, 'package');
  for (const path of await filesUnder(packedRoot)) {
    const content = await readFile(path);
    if (content.includes(0)) continue;
    const text = content.toString('utf8');
    assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ml_(?:live|test)_[A-Za-z0-9]{16,}/);
    assert.doesNotMatch(text, /\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\/);
  }
  const packedJs = (await Promise.all(
    (await filesUnder(resolve(packedRoot, 'dist'))).filter((path) => /\.(?:js|cjs)$/.test(path)).map((path) => readFile(path, 'utf8')),
  )).join('\n');
  assert.match(packedJs, /editor\.maillayers\.com/);
  assert.doesNotMatch(packedJs, /sourceMappingURL|sourcesContent|postMessage\([^,]*,\s*["']\*["']\)/);
  assert.doesNotMatch(packedJs, /@maillayers\/(?:core|render|templates|themes|shared)/);
  const packedManifest = JSON.parse(await readFile(resolve(packedRoot, 'package.json'), 'utf8'));
  assert.equal(packedManifest.dependencies, undefined);
  assert.deepEqual(Object.keys(packedManifest.peerDependencies || {}), ['svelte']);

  const directory = resolve(temporary, 'svelte-consumer');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: 'svelte-consumer', private: true, type: 'module' }, null, 2));
  run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--package-lock=false'], directory);
  await linkPackage(resolve(localModules, 'svelte'), resolve(directory, 'node_modules'), 'svelte');

  run('node', ['--input-type=module', '-e', `
    import { MailLayersEmailEditor, validateMailLayersLicense } from '@maillayers/svelte-email-editor';
    if (typeof MailLayersEmailEditor !== 'function' || typeof validateMailLayersLicense !== 'function') process.exit(1);
  `], directory);
  run('node', ['-e', `
    const sdk = require('@maillayers/svelte-email-editor');
    if (typeof sdk.MailLayersEmailEditor !== 'function' || typeof sdk.validateMailLayersLicense !== 'function') process.exit(1);
  `], directory);

  const viteDir = resolve(temporary, 'svelte-vite');
  await mkdir(resolve(viteDir, 'src'), { recursive: true });
  await writeFile(resolve(viteDir, 'package.json'), JSON.stringify({ name: 'svelte-vite-consumer', private: true, type: 'module' }, null, 2));
  await writeFile(resolve(viteDir, 'index.html'), `<!doctype html><html><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>`);
  await writeFile(resolve(viteDir, 'src/main.ts'), `
    import { MailLayersEmailEditor } from '@maillayers/svelte-email-editor';
    const target = document.getElementById('app');
    new MailLayersEmailEditor({ target, props: { apiKey: 'synthetic' } });
  `);
  await writeFile(resolve(viteDir, 'vite.config.ts'), `
    import { defineConfig } from 'vite';
    export default defineConfig({ build: { minify: false } });
  `);
  run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--package-lock=false'], viteDir);
  await linkPackage(resolve(localModules, 'svelte'), resolve(viteDir, 'node_modules'), 'svelte');
  await linkPackage(resolve(localModules, 'vite'), resolve(viteDir, 'node_modules'), 'vite');
  for (const name of ['esbuild', 'rollup', 'fdir', 'picomatch', 'postcss', 'nanoid', 'source-map-js', 'tinyglobby', '@esbuild/darwin-arm64', '@rollup/rollup-darwin-arm64']) {
    const source = resolve(localModules, name);
    if (existsSync(source)) await linkPackage(source, resolve(viteDir, 'node_modules'), name);
  }
  run(resolve(localModules, '.bin/vite'), ['build'], viteDir);
  assert.ok(existsSync(resolve(viteDir, 'dist/index.html')));

  console.log('PASS\tSvelte publication tarball installs cleanly without private packages, maps, secrets, or machine paths');
  console.log('PASS\tSvelte ESM/CJS consumers succeed');
  console.log('PASS\tSvelte Vite production consumer build succeeds');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
