// Copies the private @maillayers/shared sources into a framework package so the
// published tarball is fully self-contained and never depends on an unpublished
// workspace package. Regenerated on every lint/typecheck/test/build.
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/sync-shared.mjs <destination-directory>');
  process.exit(1);
}

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const source = resolve(repoRoot, 'packages/shared/src');
const destination = resolve(repoRoot, target);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await writeFile(
  resolve(destination, 'GENERATED.md'),
  'Generated copy of packages/shared/src. Do not edit; run scripts/sync-shared.mjs.\n'
);
const files = await readdir(destination);
console.log(`synced ${files.length - 1} shared source files -> ${target}`);
