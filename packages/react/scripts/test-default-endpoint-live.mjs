import assert from 'node:assert/strict';
import { DEFAULT_BUILDER_SRC } from '../dist/origin-entry.js';

const response = await fetch(DEFAULT_BUILDER_SRC, {
  method: 'HEAD',
  redirect: 'error',
  cache: 'no-store',
  signal: AbortSignal.timeout(15_000),
});

assert.equal(response.status, 200);
assert.equal(response.url, `${DEFAULT_BUILDER_SRC}/`);
assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/i);
console.log(`PASS\tlive default editor endpoint returned ${response.status} ${response.headers.get('content-type')}`);
