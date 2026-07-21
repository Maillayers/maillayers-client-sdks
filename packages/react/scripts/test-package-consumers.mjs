import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(root, '../..');
const localModules = existsSync(resolve(root, 'node_modules/react/package.json'))
  ? resolve(root, 'node_modules')
  : resolve(workspaceRoot, 'node_modules');
const temporary = await mkdtemp(resolve(tmpdir(), 'maillayers-consumers-'));

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    // An outer `npm publish --dry-run` exports npm_config_dry_run=true. The
    // consumer test must still create its local inspection tarball, so prevent
    // that lifecycle flag from turning this nested `npm pack` into a no-op.
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
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, 'dir');
}

async function createConsumer(name, fixture, expectedReactMajor, tarball) {
  const directory = resolve(temporary, name);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }, null, 2));
  run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--package-lock=false'], directory);
  const modules = resolve(directory, 'node_modules');
  for (const [dependency, source] of Object.entries(fixture)) {
    await linkPackage(source, modules, dependency);
  }

  const installedReact = JSON.parse(await readFile(resolve(modules, 'react/package.json'), 'utf8')).version;
  assert.equal(Number.parseInt(installedReact, 10), expectedReactMajor);
  run('node', ['--input-type=module', '-e', `
    import React from 'react';
    import { EmailBuilder, validateMailLayersLicense } from '@maillayers/react-email-editor';
    import { validateMailLayersLicense as licenseOnly } from '@maillayers/react-email-editor/license';
    if (typeof React.createElement !== 'function' || typeof EmailBuilder !== 'object' || typeof validateMailLayersLicense !== 'function' || typeof licenseOnly !== 'function') process.exit(1);
  `], directory);
  run('node', ['-e', `
    const React = require('react');
    const sdk = require('@maillayers/react-email-editor');
    const license = require('@maillayers/react-email-editor/license');
    if (typeof React.createElement !== 'function' || typeof sdk.EmailBuilder !== 'object' || typeof sdk.validateMailLayersLicense !== 'function' || typeof license.validateMailLayersLicense !== 'function') process.exit(1);
  `], directory);

  await writeFile(resolve(directory, 'consumer.mts'), `
    import { EmailBuilder, validateMailLayersLicense, type EmailBuilderProps, type AssetRequestContext } from '@maillayers/react-email-editor';
    import { validateMailLayersLicense as licenseOnly } from '@maillayers/react-email-editor/license';
    const props: EmailBuilderProps = { apiKey: 'synthetic-type-only' };
    const context: AssetRequestContext = { requestId: 'request', signal: new AbortController().signal };
    void props; void context; void EmailBuilder; void validateMailLayersLicense; void licenseOnly;
  `);
  await writeFile(resolve(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, skipLibCheck: false, noEmit: true, lib: ['ES2022', 'DOM'],
    },
    include: ['consumer.mts'],
  }, null, 2));
  run(resolve(localModules, '.bin/tsc'), ['-p', 'tsconfig.json'], directory);
  return directory;
}

try {
  run('npm', ['run', 'build:publish']);
  const packOutput = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]);
  const pack = JSON.parse(packOutput)[0];
  const tarball = resolve(temporary, pack.filename);
  const inventory = run('tar', ['-tzf', tarball]).trim().split('\n').sort();
  assert.equal(inventory.length, 12);
  assert.ok(inventory.includes('package/LICENSE'));
  assert.ok(inventory.includes('package/README.md'));
  assert.ok(inventory.includes('package/package.json'));
  assert.ok(inventory.includes('package/dist/license-entry.js'));
  assert.equal(inventory.some((path) => /origin-entry|\.map$|^package\/src\/|^package\/scripts\/|\.env|\.pem|\.key/.test(path)), false);

  const extracted = resolve(temporary, 'extracted');
  await mkdir(extracted);
  run('tar', ['-xzf', tarball, '-C', extracted]);
  const packedFiles = await filesUnder(resolve(extracted, 'package'));
  for (const path of packedFiles) {
    const content = await readFile(path);
    if (content.includes(0)) continue;
    const text = content.toString('utf8');
    assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ml_(?:live|test)_[A-Za-z0-9]{16,}/);
    assert.doesNotMatch(text, /\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\/);
  }
  const packedJs = (await Promise.all(packedFiles.filter((path) => /\.(?:js|cjs)$/.test(path)).map((path) => readFile(path, 'utf8')))).join('\n');
  assert.doesNotMatch(packedJs, /sourceMappingURL|sourcesContent|React SDK for embedding the MailLayers email editor|"scripts"\s*:/);

  const react18 = await createConsumer('react18-consumer', {
    react: resolve(localModules, 'react18'),
    'react-dom': resolve(localModules, 'react-dom18'),
    '@types/react': resolve(localModules, '@types/react'),
    '@types/react-dom': resolve(localModules, '@types/react-dom'),
    csstype: resolve(localModules, 'csstype'),
  }, 18, tarball);
  const react19 = await createConsumer('react19-consumer', {
    react: resolve(localModules, 'react'),
    'react-dom': resolve(localModules, 'react-dom'),
    '@types/react': resolve(localModules, '@types/react19'),
    '@types/react-dom': resolve(localModules, '@types/react-dom19'),
    csstype: resolve(localModules, 'csstype'),
  }, 19, tarball);

  const treeEntry = resolve(react19, 'license-only.mjs');
  const treeOutput = resolve(react19, 'license-only.bundle.js');
  await writeFile(treeEntry, `import { validateMailLayersLicense } from '@maillayers/react-email-editor/license'; globalThis.validateLicense = validateMailLayersLicense;`);
  await esbuild({ entryPoints: [treeEntry], outfile: treeOutput, bundle: true, platform: 'browser', format: 'esm', minify: true, logLevel: 'silent' });
  const treeBundle = await readFile(treeOutput, 'utf8');
  assert.doesNotMatch(treeBundle, /react(?:-dom|\/jsx-runtime)|EmailBuilder|iframe|editor\.maillayers\.com|DEFAULT_BUILDER|React SDK for embedding/i);
  assert.ok(treeBundle.length < 10_000, `license-only bundle is unexpectedly large: ${treeBundle.length}`);

  console.log('PASS\tactual publication tarball installs cleanly and inventory includes LICENSE without maps, internals, secrets, or machine paths');
  console.log('PASS\tclean React 18 consumer passes root/license ESM, CommonJS, and SSR-safe imports');
  console.log('PASS\tclean React 19 consumer passes root/license ESM, CommonJS, and SSR-safe imports');
  console.log('PASS\tstrict declaration consumers pass with React 18 and React 19 type fixtures');
  console.log(`PASS\tactual license-only consumer bundle tree-shakes React/editor code (${treeBundle.length} bytes)`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
