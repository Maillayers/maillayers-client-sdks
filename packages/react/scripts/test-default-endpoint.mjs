import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DEFAULT_BUILDER_SRC } from '../dist/origin-entry.js';

const expected = 'https://editor.maillayers.com';
assert.equal(DEFAULT_BUILDER_SRC, expected);

const parsed = new URL(DEFAULT_BUILDER_SRC);
assert.equal(parsed.protocol, 'https:');
assert.equal(parsed.hostname, 'editor.maillayers.com');
assert.equal(parsed.port, '');
assert.equal(parsed.pathname, '/');
assert.equal(parsed.search, '');
assert.equal(parsed.hash, '');

const distUrl = new URL('../dist/', import.meta.url);
const compiledFiles = (await readdir(distUrl)).filter((file) => file.endsWith('.js') || file.endsWith('.cjs'));
const compiled = (await Promise.all(compiledFiles.map((file) => readFile(new URL(file, distUrl), 'utf8')))).join('\n');
assert.match(compiled, /https:\/\/editor\.maillayers\.com/);
assert.doesNotMatch(compiled, /https:\/\/maillayers\.com\/editor/);

console.log('PASS\tcompiled default editor endpoint is the supported HTTPS origin root');
