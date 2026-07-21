import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const files = ['src/index.ts', 'src/build-info.ts', 'src/MailLayersEmailEditor.svelte'];
for (const file of files) {
  const text = await readFile(resolve(root, file), 'utf8');
  if (/postMessage\([^\n]*,\s*["']\*["']\)/.test(text)) throw new Error(`${file}: wildcard postMessage target`);
  if (text.includes('console.log(')) throw new Error(`${file}: console.log is not permitted`);
  if (/@maillayers\/core|@maillayers\/render|@maillayers\/templates|@maillayers\/themes/.test(text)) {
    throw new Error(`${file}: must not depend on private editor packages`);
  }
}
console.log(`lint passed (${files.length} source files)`);
