import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const files = (await readdir(resolve(root, 'src'))).filter((name) => name.endsWith('.ts')).map((name) => `src/${name}`);
for (const file of files) {
  const text = await readFile(resolve(root, file), 'utf8');
  if (/postMessage\([^\n]*,\s*["']\*["']\)/.test(text)) throw new Error(`${file}: wildcard postMessage target`);
  if (text.includes('console.log(')) throw new Error(`${file}: console.log is not permitted`);
  if (/from ['"]react['"]/.test(text)) throw new Error(`${file}: shared package must stay framework neutral`);
}
console.log(`lint passed (${files.length} source files)`);
