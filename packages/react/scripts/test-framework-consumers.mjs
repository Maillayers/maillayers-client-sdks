import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(root, '../..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const expectedTarball = `maillayers-react-email-editor-${packageJson.version}.tgz`;
const tarball = resolve(root, process.argv[2] ?? expectedTarball);
const temporary = await mkdtemp(resolve(tmpdir(), 'maillayers-framework-consumers-'));
const cache = resolve(temporary, 'npm-cache');
const sdkModules = existsSync(resolve(root, 'node_modules/react/package.json'))
  ? resolve(root, 'node_modules')
  : resolve(workspaceRoot, 'node_modules');
const harnessModules = sdkModules;
const nextModules = sdkModules;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache, NEXT_TELEMETRY_DISABLED: '1' },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function linkPackage(directory, name, source) {
  const target = resolve(directory, 'node_modules', name);
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, 'dir');
}

function installTarball(directory) {
  run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--package-lock=false'], directory);
}

async function baseConsumer(name) {
  const directory = resolve(temporary, name);
  await mkdir(directory, { recursive: true });
  await writeJson(resolve(directory, 'package.json'), { name, private: true, type: 'module' });
  installTarball(directory);
  return directory;
}

async function linkReact(directory, major) {
  if (major === 18) {
    await linkPackage(directory, 'react', resolve(sdkModules, 'react18'));
    await linkPackage(directory, 'react-dom', resolve(sdkModules, 'react-dom18'));
  } else {
    await linkPackage(directory, 'react', resolve(sdkModules, 'react'));
    await linkPackage(directory, 'react-dom', resolve(sdkModules, 'react-dom'));
  }
}

async function createVite(name, reactMajor) {
  const directory = await baseConsumer(name);
  await mkdir(resolve(directory, 'src'), { recursive: true });
  await linkReact(directory, reactMajor);
  await writeFile(resolve(directory, 'index.html'), '<div id="root"></div><script type="module" src="/src/main.jsx"></script>\n');
  await writeFile(resolve(directory, 'src/main.jsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MailLayersEmailEditor } from '@maillayers/react-email-editor';
    createRoot(document.getElementById('root')).render(React.createElement(MailLayersEmailEditor, { apiKey: 'synthetic-build-only' }));
  `);
  run('node', [resolve(harnessModules, 'vite/bin/vite.js'), 'build'], directory);
  assert.match(await readFile(resolve(directory, 'dist/index.html'), 'utf8'), /script/);
}

async function createNextConsumer() {
  const directory = await baseConsumer('next-client-consumer');
  await mkdir(resolve(directory, 'app'), { recursive: true });
  await linkReact(directory, 19);
  await linkPackage(directory, 'next', resolve(nextModules, 'next'));
  await writeFile(resolve(directory, 'app/layout.js'), `export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n`);
  await writeFile(resolve(directory, 'app/page.js'), `
    'use client';
    import { MailLayersEmailEditor } from '@maillayers/react-email-editor';
    export default function Page() { return <MailLayersEmailEditor apiKey="synthetic-build-only" />; }
  `);
  run('node', [resolve(nextModules, 'next/dist/bin/next'), 'build'], directory);
  assert.equal((await readFile(resolve(directory, '.next/BUILD_ID'), 'utf8')).trim().length > 0, true);
}

async function createModuleConsumers() {
  const directory = await baseConsumer('module-consumers');
  await linkReact(directory, 19);
  run('node', ['--input-type=module', '-e', "import('@maillayers/react-email-editor').then(m => { if (typeof m.validateMailLayersLicense !== 'function') process.exit(1); })"], directory);
  run('node', ['-e', "const m = require('@maillayers/react-email-editor'); if (typeof m.validateMailLayersLicense !== 'function') process.exit(1)"], directory);
}

async function createSecurityHarness() {
  const directory = await baseConsumer('sdk-security-harness');
  await mkdir(resolve(directory, 'src'), { recursive: true });
  await writeFile(resolve(directory, 'index.html'), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n');
  await writeJson(resolve(directory, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src'],
  });
  await writeFile(resolve(directory, 'src/main.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MailLayersEmailEditor, validateMailLayersLicense } from '@maillayers/react-email-editor';
    const validation = validateMailLayersLicense({ apiKey: 'synthetic-license-fixture', origin: window.location.origin });
    void validation;
    createRoot(document.getElementById('root')!).render(
      <MailLayersEmailEditor apiKey="synthetic-license-fixture" onChange={() => undefined} />
    );
  `);
  await linkReact(directory, 18);
  for (const [name, sourcePath] of Object.entries({
    '@types/node': resolve(harnessModules, '@types/node'),
    '@types/react': resolve(harnessModules, '@types/react'),
    '@types/react-dom': resolve(harnessModules, '@types/react-dom'),
    '@vitejs/plugin-react': resolve(harnessModules, '@vitejs/plugin-react'),
    csstype: resolve(harnessModules, 'csstype'),
    vite: resolve(harnessModules, 'vite'),
  })) await linkPackage(directory, name, sourcePath);
  run('node', [resolve(harnessModules, 'typescript/bin/tsc'), '-b'], directory);
  run('node', [resolve(harnessModules, 'vite/bin/vite.js'), 'build'], directory);
  assert.match(await readFile(resolve(directory, 'dist/index.html'), 'utf8'), /script/);
}

try {
  assert.equal(basename(tarball), expectedTarball);
  await readFile(tarball);
  await createSecurityHarness();
  console.log('PASS\tsdk-security-harness source builds against the new tarball in a clean React 18 install');
  await createVite('vite-react18-consumer', 18);
  console.log('PASS\tclean Vite React 18 consumer builds against the new tarball');
  await createVite('vite-react19-consumer', 19);
  console.log('PASS\tclean Vite React 19 consumer builds against the new tarball');
  await createNextConsumer();
  console.log('PASS\tclean Next.js client-only consumer builds against the new tarball');
  await createModuleConsumers();
  console.log('PASS\tclean SSR-safe ESM and CommonJS consumers import the new tarball');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
