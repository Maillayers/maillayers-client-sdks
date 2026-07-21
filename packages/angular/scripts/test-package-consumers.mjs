import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(root, '../..');
const localModules = existsSync(resolve(root, 'node_modules/@angular/core/package.json'))
  ? resolve(root, 'node_modules')
  : resolve(workspaceRoot, 'node_modules');
const temporary = await mkdtemp(resolve(tmpdir(), 'maillayers-angular-consumers-'));

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
  assert.ok(inventory.some((path) => path.includes('fesm2022/') && path.endsWith('.mjs')));
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
    (await filesUnder(resolve(packedRoot, 'dist'))).filter((path) => /\.mjs$/.test(path)).map((path) => readFile(path, 'utf8')),
  )).join('\n');
  assert.match(packedJs, /editor\.maillayers\.com/);
  assert.doesNotMatch(packedJs, /sourceMappingURL|sourcesContent|postMessage\([^,]*,\s*["']\*["']\)/);
  assert.doesNotMatch(packedJs, /@maillayers\/(?:core|render|templates|themes|shared)/);
  const packedManifest = JSON.parse(await readFile(resolve(packedRoot, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(packedManifest.peerDependencies || {}).sort(), ['@angular/common', '@angular/core']);
  assert.deepEqual(Object.keys(packedManifest.dependencies || {}), ['tslib']);

  const directory = resolve(temporary, 'angular-consumer');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: 'angular-consumer', private: true, type: 'module' }, null, 2));
  run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--package-lock=false'], directory);
  for (const name of ['@angular/core', '@angular/common', '@angular/compiler', 'rxjs', 'tslib']) {
    const source = resolve(localModules, name);
    if (existsSync(source)) await linkPackage(source, resolve(directory, 'node_modules'), name);
  }

  // Partial-Ivy libraries need the JIT compiler (or Angular Linker) before evaluation.
  run('node', ['--input-type=module', '-e', `
    import '@angular/compiler';
    const mod = await import('@maillayers/angular-email-editor');
    if (typeof mod.MailLayersEmailEditorComponent !== 'function' || typeof mod.MailLayersEmailEditorModule !== 'function' || typeof mod.validateMailLayersLicense !== 'function') process.exit(1);
  `], directory);

  console.log('PASS\tAngular publication tarball installs cleanly without private packages, maps, secrets, or machine paths');
  console.log('PASS\tAngular ESM consumer succeeds');
  console.log('PASS\tAngular package exposes Ivy partial FESM for CLI AOT consumers');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
