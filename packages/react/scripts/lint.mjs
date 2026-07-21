import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const files = ['src/license.ts', 'src/EmailBuilder.tsx', 'src/protocol.ts', 'src/utils.ts', 'src/runtime-validation.ts', 'src/callbacks.ts', 'src/assets.ts', 'src/build-info.ts', 'src/constants.ts', 'src/origin-entry.ts'];
for (const file of files) {
  const text = await readFile(resolve(root, file), 'utf8');
  if (/postMessage\([^\n]*,\s*["']\*["']\)/.test(text)) throw new Error(`${file}: wildcard postMessage target`);
  if (text.includes('console.log(')) throw new Error(`${file}: console.log is not permitted`);
}
console.log(`lint passed (${files.length} source files)`);
