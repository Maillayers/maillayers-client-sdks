import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

async function removeMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await removeMaps(path);
    else if (entry.name.endsWith('.map') || entry.name === '.npmignore') await rm(path, { force: true });
  }
}

await removeMaps(dist);
await rm(resolve(dist, 'package.json'), { force: true });
await rm(resolve(dist, 'LICENSE'), { force: true });
await rm(resolve(dist, 'README.md'), { force: true });

const bundle = resolve(dist, 'fesm2022/maillayers-angular-email-editor.mjs');
const source = await readFile(bundle, 'utf8');
if (source.includes('sourceMappingURL') || source.includes('sourcesContent')) {
  await writeFile(bundle, source.replace(/\n\/\/# sourceMappingURL=.*$/m, ''));
}
if (/postMessage\([^,]*,\s*["']\*["']\)/.test(source)) {
  throw new Error('wildcard postMessage target found in Angular bundle');
}
if (/@maillayers\/(?:core|render|templates|themes|shared)/.test(source)) {
  throw new Error('private package reference found in Angular bundle');
}
console.log('sanitized Angular dist for publication');
