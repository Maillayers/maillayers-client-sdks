import assert from 'node:assert/strict';
import { invokeHostCallback } from '../dist/origin-entry.js';

const unhandled = [];
const onUnhandled = (reason) => { unhandled.push(reason); };
process.on('unhandledRejection', onUnhandled);

assert.deepEqual(await invokeHostCallback(undefined, []), { ok: false, missing: true });
assert.deepEqual(await invokeHostCallback((left, right) => left + right, [2, 3]), { ok: true, value: 5 });
assert.deepEqual(await invokeHostCallback(() => { throw new Error('synthetic sync failure'); }, []), { ok: false, missing: false });
assert.deepEqual(await invokeHostCallback(async () => { throw new Error('synthetic async failure'); }, []), { ok: false, missing: false });

const applyProxy = new Proxy(() => undefined, { apply() { throw new Error('apply trap'); } });
assert.deepEqual(await invokeHostCallback(applyProxy, []), { ok: false, missing: false });

const hostileThenable = { get then() { throw new Error('then getter'); } };
assert.deepEqual(await invokeHostCallback(() => hostileThenable, []), { ok: false, missing: false });

const never = new Promise(() => {});
const pending = invokeHostCallback(() => never, []);
assert.equal(await Promise.race([pending.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('pending'), 5))]), 'pending');

let nestedCalls = 0;
const nested = () => { nestedCalls += 1; };
const outer = () => { nestedCalls += 1; void invokeHostCallback(nested, []); };
assert.equal((await invokeHostCallback(outer, [])).ok, true);
await Promise.resolve();
assert.equal(nestedCalls, 2);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(unhandled.length, 0);

process.off('unhandledRejection', onUnhandled);
console.log('PASS\tsingle callback boundary handles values, missing callbacks, throws, and rejections');
console.log('PASS\tproxy apply traps and hostile thenables fail without escaping');
console.log('PASS\tnever-resolving and nested callbacks do not block or create unhandled rejections');
