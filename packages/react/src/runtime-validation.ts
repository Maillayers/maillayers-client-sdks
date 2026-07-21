import type { CSSProperties } from 'react';
import type { BuilderConfig } from './protocol';
import type { EmailBuilderProps, MergeTagOption, ThemeDefinition } from './types';

export const SDK_INPUT_LIMITS = Object.freeze({
  apiKeyCharacters: 256,
  urlCharacters: 2048,
  tokenCharacters: 8192,
  htmlBytes: 1_000_000,
  configDepth: 12,
  configBytes: 256_000,
  configProperties: 5_000,
  themeBytes: 64_000,
  styleBytes: 64_000,
  mergeTagCount: 1_000,
  mergeTagBytes: 128_000,
  assetCount: 100,
  keyCharacters: 256,
});

type JsonScalar = null | boolean | number | string;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

type SnapshotLimits = {
  maxDepth: number;
  maxBytes: number;
  maxProperties: number;
  allowArrays: boolean;
};

export type RuntimeInputValidation =
  | {
      ok: true;
      config?: BuilderConfig;
      theme?: ThemeDefinition;
      mergeTags?: MergeTagOption[];
      style?: CSSProperties;
    }
  | { ok: false; code: string; error: string };

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const THEME_TOKEN_KEYS = [
  'primary', 'secondary', 'accent', 'success', 'warning', 'error',
  'background', 'surface', 'border', 'text',
] as const;

function fail(prop: string, reason = 'is invalid'): RuntimeInputValidation {
  const code = `ML_PROP_${prop.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_INVALID`;
  return { ok: false, code, error: `[${code}] EmailBuilder \`${prop}\` ${reason}.` };
}

function boundedUtf8Bytes(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

export function isWithinUtf8ByteLimit(value: string, limit: number): boolean {
  return boundedUtf8Bytes(value, limit) <= limit;
}

function validString(value: unknown, options: { required?: boolean; allowEmpty?: boolean; maxCharacters: number; maxBytes?: number; controls?: boolean }): value is string | undefined {
  if (value === undefined) return !options.required;
  if (typeof value !== 'string' || (!options.allowEmpty && !value.trim()) || value.length > options.maxCharacters) return false;
  if (options.controls !== false && CONTROL_CHARACTERS.test(value)) return false;
  return options.maxBytes === undefined || boundedUtf8Bytes(value, options.maxBytes) <= options.maxBytes;
}

function snapshotJson(value: unknown, limits: SnapshotLimits): JsonValue {
  const seen = new WeakSet<object>();
  let bytes = 0;
  let properties = 0;

  const addBytes = (text: string) => {
    bytes += boundedUtf8Bytes(text, Math.max(0, limits.maxBytes - bytes));
    if (bytes > limits.maxBytes) throw new Error('size');
  };

  const addJsonStringBytes = (text: string) => {
    bytes += 2;
    if (bytes > limits.maxBytes) throw new Error('size');
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
      else if (code < 0x20) bytes += 6;
      else if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
      if (bytes > limits.maxBytes) throw new Error('size');
    }
  };

  const visit = (current: unknown, depth: number): JsonValue => {
    if (depth > limits.maxDepth) throw new Error('depth');
    if (current === null) { addBytes('null'); return null; }
    if (typeof current === 'string') { addJsonStringBytes(current); return current; }
    if (typeof current === 'boolean') { addBytes(current ? 'true' : 'false'); return current; }
    if (typeof current === 'number' && Number.isFinite(current)) { addBytes(String(current)); return current; }
    if (typeof current !== 'object') throw new Error('type');
    if (seen.has(current)) throw new Error('cycle');
    seen.add(current);

    let prototype: object | null;
    let keys: Array<string | symbol>;
    try {
      prototype = Object.getPrototypeOf(current);
      keys = Reflect.ownKeys(current);
    } catch {
      throw new Error('trap');
    }
    if (Array.isArray(current)) {
      if (!limits.allowArrays || prototype !== Array.prototype) throw new Error('array');
      properties += current.length;
      if (properties > limits.maxProperties) throw new Error('properties');
      addBytes('[]');
      if (current.length > 1) addBytes(','.repeat(current.length - 1));
      const result: JsonValue[] = [];
      for (let index = 0; index < current.length; index += 1) {
        let descriptor: PropertyDescriptor | undefined;
        try { descriptor = Object.getOwnPropertyDescriptor(current, String(index)); } catch { throw new Error('trap'); }
        if (!descriptor || !('value' in descriptor)) throw new Error('accessor');
        result.push(visit(descriptor.value, depth + 1));
      }
      seen.delete(current);
      return Object.freeze(result) as JsonValue[];
    }
    if (prototype !== Object.prototype && prototype !== null) throw new Error('prototype');
    if (keys.some((key) => typeof key === 'symbol')) throw new Error('symbol');
    properties += keys.length;
    if (properties > limits.maxProperties) throw new Error('properties');
    addBytes('{}');
    if (keys.length > 0) addBytes(':'.repeat(keys.length));
    if (keys.length > 1) addBytes(','.repeat(keys.length - 1));
    const result: { [key: string]: JsonValue } = Object.create(null);
    for (const key of (keys as string[]).sort()) {
      if (key.length > SDK_INPUT_LIMITS.keyCharacters || CONTROL_CHARACTERS.test(key)) throw new Error('key');
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(current, key); } catch { throw new Error('trap'); }
      if (!descriptor || !('value' in descriptor)) throw new Error('accessor');
      addJsonStringBytes(key);
      result[key] = visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
    return Object.freeze(result);
  };

  return visit(value, 0);
}

function snapshotObject(value: unknown, limits: SnapshotLimits): Record<string, JsonValue> {
  const snapshot = snapshotJson(value, limits);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('object');
  return snapshot;
}

function validateTheme(value: unknown): ThemeDefinition {
  const snapshot = snapshotObject(value, {
    maxDepth: 4,
    maxBytes: SDK_INPUT_LIMITS.themeBytes,
    maxProperties: 64,
    allowArrays: false,
  });
  for (const mode of ['light', 'dark'] as const) {
    const tokens = snapshot[mode];
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('theme');
    for (const key of THEME_TOKEN_KEYS) {
      if (typeof tokens[key] !== 'string' || !tokens[key].trim()) throw new Error('theme');
    }
  }
  if ('name' in snapshot && typeof snapshot.name !== 'string') throw new Error('theme');
  if ('tenantId' in snapshot && typeof snapshot.tenantId !== 'string') throw new Error('theme');
  return snapshot as unknown as ThemeDefinition;
}

function validateMergeTags(value: unknown): MergeTagOption[] {
  if (!Array.isArray(value) || value.length > SDK_INPUT_LIMITS.mergeTagCount) throw new Error('tags');
  const snapshot = snapshotJson(value, {
    maxDepth: 2,
    maxBytes: SDK_INPUT_LIMITS.mergeTagBytes,
    maxProperties: SDK_INPUT_LIMITS.mergeTagCount * 3,
    allowArrays: true,
  });
  if (!Array.isArray(snapshot)) throw new Error('tags');
  for (const tag of snapshot) {
    if (!tag || typeof tag !== 'object' || Array.isArray(tag)) throw new Error('tags');
    if (Object.keys(tag).some((key) => key !== 'label' && key !== 'value')) throw new Error('tags');
    if (typeof tag.label !== 'string' || !tag.label.trim() || typeof tag.value !== 'string' || !tag.value.trim()) throw new Error('tags');
  }
  return snapshot as unknown as MergeTagOption[];
}

function validateStyle(value: unknown): CSSProperties {
  const snapshot = snapshotObject(value, {
    maxDepth: 1,
    maxBytes: SDK_INPUT_LIMITS.styleBytes,
    maxProperties: 512,
    allowArrays: false,
  });
  if (Object.values(snapshot).some((entry) => typeof entry !== 'string' && typeof entry !== 'number')) throw new Error('style');
  return snapshot as CSSProperties;
}

export function validateEmailBuilderInputs(input: Record<string, unknown>): RuntimeInputValidation {
  try {
    if (!validString(input.src, { maxCharacters: SDK_INPUT_LIMITS.urlCharacters })) return fail('src');
    if (!validString(input.allowedOrigin, { maxCharacters: SDK_INPUT_LIMITS.urlCharacters })) return fail('allowedOrigin');
    if (!validString(input.licenseValidationUrl, { maxCharacters: SDK_INPUT_LIMITS.urlCharacters })) return fail('licenseValidationUrl');
    if (!validString(input.apiKey, { required: true, maxCharacters: SDK_INPUT_LIMITS.apiKeyCharacters })) return fail('apiKey');
    if (!validString(input.embedToken, { maxCharacters: SDK_INPUT_LIMITS.tokenCharacters })) return fail('embedToken');
    if (!validString(input.initialHtml, { allowEmpty: true, maxCharacters: SDK_INPUT_LIMITS.htmlBytes, maxBytes: SDK_INPUT_LIMITS.htmlBytes, controls: false })) return fail('initialHtml', 'exceeds the byte limit or has an invalid type');
    if (!validString(input.externalFooterHtml, { allowEmpty: true, maxCharacters: SDK_INPUT_LIMITS.htmlBytes, maxBytes: SDK_INPUT_LIMITS.htmlBytes, controls: false })) return fail('externalFooterHtml', 'exceeds the byte limit or has an invalid type');
    if (!validString(input.mergeTagTrigger, { maxCharacters: 64 })) return fail('mergeTagTrigger');
    if (!validString(input.templateId, { maxCharacters: SDK_INPUT_LIMITS.keyCharacters })) return fail('templateId');
    if (!validString(input.tenantId, { maxCharacters: SDK_INPUT_LIMITS.keyCharacters })) return fail('tenantId');
    if (!validString(input.expectedOrganizationId, { maxCharacters: SDK_INPUT_LIMITS.keyCharacters })) return fail('expectedOrganizationId');
    if (!validString(input.expectedLicenseId, { maxCharacters: SDK_INPUT_LIMITS.keyCharacters })) return fail('expectedLicenseId');
    if (!validString(input.className, { allowEmpty: true, maxCharacters: 1024 })) return fail('className');
    if (!validString(input.sandbox, { allowEmpty: true, maxCharacters: 1024 })) return fail('sandbox');
    if (!validString(input.iframeTitle, { maxCharacters: 256 }) || (typeof input.iframeTitle === 'string' && !input.iframeTitle.trim())) return fail('iframeTitle');
    if (input.footerInjectionMode !== undefined && input.footerInjectionMode !== 'default' && input.footerInjectionMode !== 'sdk') return fail('footerInjectionMode');
    if (input.themeMode !== undefined && input.themeMode !== 'light' && input.themeMode !== 'dark' && input.themeMode !== 'system') return fail('themeMode');
    for (const prop of ['preview', 'previewOnly', 'hideLoadingOverlay'] as const) {
      if (input[prop] !== undefined && typeof input[prop] !== 'boolean') return fail(prop);
    }
    for (const prop of ['onChange', 'onLoad', 'onSave', 'onUpload', 'onListAssets', 'onDeleteAsset', 'onReady', 'onStatusChange', 'onAuthError'] as const) {
      if (input[prop] !== undefined && typeof input[prop] !== 'function') return fail(prop);
    }

    let config: BuilderConfig;
    let theme: ThemeDefinition | undefined;
    let mergeTags: MergeTagOption[] | undefined;
    let style: CSSProperties | undefined;
    try {
      config = input.config === undefined ? undefined : snapshotObject(input.config, {
        maxDepth: SDK_INPUT_LIMITS.configDepth,
        maxBytes: SDK_INPUT_LIMITS.configBytes,
        maxProperties: SDK_INPUT_LIMITS.configProperties,
        allowArrays: true,
      });
    } catch { return fail('config', 'is unsafe or exceeds serialization limits'); }
    try { theme = input.theme === undefined ? undefined : validateTheme(input.theme); }
    catch { return fail('theme', 'is unsafe or does not match the theme schema'); }
    try { mergeTags = input.mergeTags === undefined ? undefined : validateMergeTags(input.mergeTags); }
    catch { return fail('mergeTags', 'is unsafe or exceeds merge-tag limits'); }
    try { style = input.style === undefined ? undefined : validateStyle(input.style); }
    catch { return fail('style', 'is unsafe or exceeds style limits'); }

    return { ok: true, config, theme, mergeTags, style };
  } catch {
    return fail('input', 'could not be inspected safely');
  }
}

export function safeStableSerialize(value: unknown): string {
  return JSON.stringify(snapshotJson(value, {
    maxDepth: SDK_INPUT_LIMITS.configDepth,
    maxBytes: SDK_INPUT_LIMITS.configBytes,
    maxProperties: SDK_INPUT_LIMITS.configProperties,
    allowArrays: true,
  }));
}
