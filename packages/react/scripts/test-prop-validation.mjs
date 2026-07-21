import assert from 'node:assert/strict';
import { SDK_INPUT_LIMITS, safeStableSerialize, validateEmailBuilderInputs } from '../dist/origin-entry.js';

const base = { apiKey: 'ml_live_synthetic_props' };
const validTokens = {
  primary: '#000', secondary: '#111', accent: '#222', success: '#333', warning: '#444',
  error: '#555', background: '#fff', surface: '#eee', border: '#ddd', text: '#111',
};

function invalid(prop, value, expectedCode = `ML_PROP_${prop.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_INVALID`) {
  const result = validateEmailBuilderInputs({ ...base, [prop]: value });
  assert.equal(result.ok, false, `${prop} should fail`);
  assert.equal(result.code, expectedCode);
  assert.match(result.error, new RegExp(`^\\[${expectedCode}\\]`));
}

for (const [prop, values] of Object.entries({
  src: [null, 7, [], {}, '', ' '.repeat(2), 'x'.repeat(SDK_INPUT_LIMITS.urlCharacters + 1)],
  allowedOrigin: [null, 7, [], {}, '', 'x'.repeat(SDK_INPUT_LIMITS.urlCharacters + 1)],
  licenseValidationUrl: [null, 7, [], {}, '', 'x'.repeat(SDK_INPUT_LIMITS.urlCharacters + 1)],
  apiKey: [null, undefined, 7, [], {}, '', ' ', 'x'.repeat(SDK_INPUT_LIMITS.apiKeyCharacters + 1), 'bad\nkey'],
  embedToken: [null, 7, [], {}, '', 'x'.repeat(SDK_INPUT_LIMITS.tokenCharacters + 1)],
  initialHtml: [null, 7, [], {}],
  externalFooterHtml: [null, 7, [], {}],
  footerInjectionMode: [null, 7, 'other'],
  themeMode: [null, 7, 'other'],
  mergeTagTrigger: [null, 7, '', 'x'.repeat(65)],
  templateId: [null, 7, '', 'x'.repeat(SDK_INPUT_LIMITS.keyCharacters + 1)],
  tenantId: [null, 7, '', 'x'.repeat(SDK_INPUT_LIMITS.keyCharacters + 1)],
  sandbox: [null, 7, [], {}],
  iframeTitle: [null, 7, '', ' ', 'x'.repeat(257)],
  style: [null, 7, [], 'bad'],
})) {
  for (const value of values) invalid(prop, value);
}

for (const prop of ['preview', 'previewOnly', 'hideLoadingOverlay']) invalid(prop, 'true');
for (const prop of ['onChange', 'onLoad', 'onSave', 'onUpload', 'onListAssets', 'onDeleteAsset', 'onReady', 'onStatusChange', 'onAuthError']) invalid(prop, {});

const oversizedHtml = 'é'.repeat(Math.floor(SDK_INPUT_LIMITS.htmlBytes / 2) + 1);
invalid('initialHtml', oversizedHtml);
invalid('externalFooterHtml', oversizedHtml);

const cyclic = {};
cyclic.self = cyclic;
invalid('config', cyclic);

let deep = { value: true };
for (let index = 0; index <= SDK_INPUT_LIMITS.configDepth; index += 1) deep = { nested: deep };
invalid('config', deep);
invalid('config', { huge: 'x'.repeat(SDK_INPUT_LIMITS.configBytes + 1) });
invalid('config', { escaped: '"'.repeat(Math.floor(SDK_INPUT_LIMITS.configBytes / 2) + 1) });

let getterCalls = 0;
const throwingGetter = {};
Object.defineProperty(throwingGetter, 'secret', { enumerable: true, get() { getterCalls += 1; throw new Error('getter leaked'); } });
invalid('config', throwingGetter);
assert.equal(getterCalls, 0, 'validation must reject accessors without invoking them');

const throwingProxy = new Proxy({}, { ownKeys() { throw new Error('proxy trap'); } });
invalid('config', throwingProxy);
invalid('style', throwingProxy);
invalid('config', { [Symbol('unsafe')]: true });

invalid('mergeTags', new Array(SDK_INPUT_LIMITS.mergeTagCount + 1).fill({ label: 'a', value: 'b' }));
invalid('mergeTags', [{ label: 'a', value: 7 }]);
invalid('mergeTags', [{ label: 'a', value: 'b', secret: true }]);
invalid('mergeTags', throwingProxy);
invalid('theme', { light: validTokens, dark: { ...validTokens, text: 7 } });
invalid('theme', throwingProxy);
invalid('style', { color: { nested: true } });

const sourceConfig = { nested: { enabled: true }, list: [1, 'two', false] };
const sourceStyle = { color: 'red', zIndex: 2 };
const valid = validateEmailBuilderInputs({
  ...base,
  initialHtml: '',
  externalFooterHtml: '',
  sandbox: '',
  config: sourceConfig,
  style: sourceStyle,
  theme: { name: 'Synthetic', light: validTokens, dark: validTokens },
  mergeTags: [{ label: 'First name', value: '{{first_name}}' }],
});
assert.equal(valid.ok, true);
assert.notEqual(valid.config, sourceConfig);
assert.notEqual(valid.style, sourceStyle);
sourceConfig.nested.enabled = false;
sourceStyle.color = 'blue';
assert.equal(valid.config.nested.enabled, true);
assert.equal(valid.style.color, 'red');
assert.equal(Object.isFrozen(valid.config), true);

assert.throws(() => safeStableSerialize(cyclic));
assert.throws(() => safeStableSerialize(throwingGetter));
assert.doesNotThrow(() => safeStableSerialize({ b: 2, a: 1 }));
assert.equal(safeStableSerialize({ b: 2, a: 1 }), '{"a":1,"b":2}');

console.log('PASS\tall scalar public props reject wrong types and bounded values');
console.log('PASS\tHTML byte, config depth/byte/property, merge-tag, key, and style limits');
console.log('PASS\tcycles, accessors, throwing proxies, symbols, and nested style objects fail closed');
console.log('PASS\tvalidated config/theme/mergeTags/style are safe detached snapshots');
console.log('PASS\tstable serialization is bounded, deterministic, and getter-free');
