import type { AssetItem } from './protocol';
import { SDK_INPUT_LIMITS, isWithinUtf8ByteLimit } from './runtime-validation';

const APPROVED_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);
const MAX_ASSET_METADATA_BYTES = 4096;

function exactDataRecord(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) return null;
    for (const key of required) if (!Object.prototype.hasOwnProperty.call(descriptors, key)) return null;
    const record: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Public asset URLs are intentionally HTTPS-only. Relative, data, script, and mixed-content URLs fail closed. */
export function normalizeAssetUrl(value: unknown): string | null {
  if (!boundedString(value, SDK_INPUT_LIMITS.urlCharacters)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hostname.endsWith('.')) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function normalizeUploadResult(value: unknown): string | null {
  return normalizeAssetUrl(value);
}

export function normalizeAssetListResult(value: unknown, requestedLimit: number = SDK_INPUT_LIMITS.assetCount): AssetItem[] | null {
  if (!Array.isArray(value) || value.length > SDK_INPUT_LIMITS.assetCount || value.length > requestedLimit) return null;
  const ids = new Set<string>();
  const urls = new Set<string>();
  const safe: AssetItem[] = [];

  for (const itemValue of value) {
    const item = exactDataRecord(itemValue, ['id', 'url', 'name', 'thumbnailUrl', 'mimeType'], ['id', 'url']);
    if (!item || !boundedString(item.id, SDK_INPUT_LIMITS.keyCharacters)) return null;
    const url = normalizeAssetUrl(item.url);
    if (!url || ids.has(item.id) || urls.has(url)) return null;
    if (item.name !== undefined && !boundedString(item.name, SDK_INPUT_LIMITS.keyCharacters)) return null;
    const thumbnailUrl = item.thumbnailUrl === undefined ? undefined : normalizeAssetUrl(item.thumbnailUrl);
    if (item.thumbnailUrl !== undefined && !thumbnailUrl) return null;
    if (item.mimeType !== undefined && (!boundedString(item.mimeType, 256) || !APPROVED_IMAGE_MIME_TYPES.has(item.mimeType))) return null;

    const metadata = JSON.stringify({ id: item.id, url, name: item.name, thumbnailUrl, mimeType: item.mimeType });
    if (!isWithinUtf8ByteLimit(metadata, MAX_ASSET_METADATA_BYTES)) return null;
    ids.add(item.id);
    urls.add(url);
    const safeItem: AssetItem = {
      id: item.id,
      url,
      ...(item.name === undefined ? {} : { name: item.name }),
      ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
    } as AssetItem;
    if (typeof thumbnailUrl === 'string') safeItem.thumbnailUrl = thumbnailUrl;
    safe.push(Object.freeze(safeItem));
  }
  return Object.freeze(safe) as AssetItem[];
}
