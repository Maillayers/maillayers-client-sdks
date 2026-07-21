import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const publicationConfig = await readFile(resolve(root, 'tsup.publish.config.ts'), 'utf8');

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

async function esmGraph(entry) {
  const seen = new Set();
  const visit = async (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.\.?\/[^"']+)["']/g)) {
      await visit(resolve(dirname(path), match[1]));
    }
  };
  await visit(entry);
  return [...seen];
}

for (const path of [
  'LICENSE', 'dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts',
  'dist/license-entry.js', 'dist/license-entry.cjs', 'dist/license-entry.d.ts', 'dist/license-entry.d.cts',
]) await access(resolve(root, path));
assert.ok((await readFile(resolve(root, 'LICENSE'), 'utf8')).trim().length > 0);
assert.deepEqual(manifest.files, ['dist', 'LICENSE', 'README.md']);
assert.equal(manifest.dependencies, undefined, 'runtime dependency graph must remain empty');
assert.deepEqual(Object.keys(manifest.peerDependencies).sort(), ['react', 'react-dom']);

const distFiles = await filesUnder(dist);
assert.equal(distFiles.some((path) => path.endsWith('.map')), false, 'published build must not contain source maps');
for (const path of distFiles.filter((value) => /\.(?:js|cjs)$/.test(value))) {
  const source = await readFile(path, 'utf8');
  assert.doesNotMatch(source, /sourceMappingURL|sourcesContent/);
  assert.doesNotMatch(source, /__MAILLAYERS_PACKAGE_VERSION__/);
  assert.doesNotMatch(source, /"keywords"\s*:|React SDK for embedding the MailLayers email editor/);
}

const licenseGraph = await esmGraph(resolve(dist, 'license-entry.js'));
licenseGraph.push(resolve(dist, 'license-entry.cjs'), resolve(dist, 'license-entry.d.ts'), resolve(dist, 'license-entry.d.cts'));
for (const path of licenseGraph) {
  const source = await readFile(path, 'utf8');
  assert.doesNotMatch(source, /(?:from\s*|import\s*|require\()['"]react(?:-dom|\/jsx-runtime)?['"]|EmailBuilder|iframe|editor\.maillayers\.com|DEFAULT_BUILDER|package\.json/i, `license graph leaked UI data through ${path}`);
}
assert.ok((await Promise.all(licenseGraph.map((path) => readFile(path, 'utf8')))).join('\n').includes(manifest.version), 'injected package version missing');

const esm = await import('@maillayers/react-email-editor/license');
const cjs = createRequire(import.meta.url)('@maillayers/react-email-editor/license');
assert.equal(typeof esm.validateMailLayersLicense, 'function');
assert.equal(typeof cjs.validateMailLayersLicense, 'function');
assert.deepEqual(Object.keys(esm), ['validateMailLayersLicense']);
assert.deepEqual(Object.keys(cjs), ['validateMailLayersLicense']);

assert.match(publicationConfig, /entry:\s*\['src\/index\.ts', 'src\/license-entry\.ts'\]/);
assert.doesNotMatch(publicationConfig, /origin-entry/);
assert.match(publicationConfig, /sourcemap:\s*false/);
assert.match(publicationConfig, /__MAILLAYERS_PACKAGE_VERSION__/);
assert.equal(manifest.scripts.test.includes('test:editor-endpoint:live'), false);
assert.equal(manifest.scripts['test:phase19'].includes('test-default-endpoint-live'), false);

console.log('PASS\tpackage manifest exposes only dist, LICENSE, and README with no runtime dependency graph');
console.log('PASS\tstandard artifacts contain no source maps, sourcesContent, manifest payload, or unresolved version token');
console.log('PASS\tlicense-only ESM/CJS graph excludes React, editor, iframe, default URL, and package manifest data');
console.log('PASS\tlicense-only self-reference exports work in ESM and CommonJS');
console.log('PASS\tpublication profile excludes test-only entrypoints and default tests contain no live endpoint command');
