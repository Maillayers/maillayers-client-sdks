import { SDK_INPUT_LIMITS, isWithinUtf8ByteLimit, safeStableSerialize } from './runtime-validation';

export const EMAIL_BUILDER_PROTOCOL_VERSION = '1.0.0';

export type MessageType =
  | 'INIT'
  | 'READY'
  | 'CHANGE'
  | 'LOADED'
  | 'SAVE'
  | 'UPLOAD'
  | 'UPLOAD_SUCCESS'
  | 'LIST_ASSETS'
  | 'ASSETS_LIST'
  | 'DELETE_ASSET'
  | 'DELETE_ASSET_SUCCESS'
  | 'AUTH_ERROR'
  | 'STATUS';

export interface MessageMeta {
  id: string;
  correlationId?: string;
  version: string;
  sentAt: number;
}

export type BuilderConfig = Record<string, unknown> | undefined;

export interface InitPayload {
  /** Inline HTML to import (optional if templateId is set and builder fetches server-side). */
  html?: string;
  /** Merge tag options used by the embedded editor dropdown. */
  mergeTags?: Array<{ label: string; value: string }>;
  /** Trigger used to open merge tag suggestions (defaults to '@'). */
  mergeTagTrigger?: string;
  /** Optional template id for builder-side template loading when supported. */
  templateId?: string;
  config?: BuilderConfig;
  /**
   * Optional: host-provided footer HTML to be rendered by the builder (SDK mode).
   * If set, the builder can avoid importing its own footer and render this exact footer instead.
   */
  externalFooterHtml?: string;
  /**
   * Footer source selection.
   * - `default`: builder uses its existing behavior.
   * - `sdk`: builder uses `externalFooterHtml` (and should avoid importing/auto-generating footer).
   */
  footerInjectionMode?: 'default' | 'sdk';
}

export interface ChangePayload {
  html: string;
}

export interface LoadedPayload {
  html: string;
}

export interface SavePayload {
  html: string;
}

export interface UploadPayload {
  file: File;
}

export interface UploadSuccessPayload {
  url: string;
}

export interface AssetItem {
  id: string;
  url: string;
  name?: string;
  thumbnailUrl?: string;
  mimeType?: 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/svg+xml' | 'image/webp';
}

export interface ListAssetsPayload {
  limit?: number;
}

export interface AssetsListPayload {
  assets: AssetItem[];
}

export interface DeleteAssetPayload {
  id?: string;
  url?: string;
}

export interface DeleteAssetSuccessPayload {
  success: boolean;
}

export interface AuthErrorPayload {
  message: string;
}

export interface StatusPayload {
  status: BuilderStatus;
}

export type BuilderStatus = 'idle' | 'loading' | 'ready' | 'error';

export type Message =
  | { type: 'INIT'; payload: InitPayload; meta?: MessageMeta }
  | { type: 'READY'; meta?: MessageMeta }
  | { type: 'CHANGE'; payload: ChangePayload; meta?: MessageMeta }
  | { type: 'LOADED'; payload: LoadedPayload; meta?: MessageMeta }
  | { type: 'SAVE'; payload: SavePayload; meta?: MessageMeta }
  | { type: 'UPLOAD'; payload: UploadPayload; meta?: MessageMeta }
  | { type: 'UPLOAD_SUCCESS'; payload: UploadSuccessPayload; meta?: MessageMeta }
  | { type: 'LIST_ASSETS'; payload?: ListAssetsPayload; meta?: MessageMeta }
  | { type: 'ASSETS_LIST'; payload: AssetsListPayload; meta?: MessageMeta }
  | { type: 'DELETE_ASSET'; payload: DeleteAssetPayload; meta?: MessageMeta }
  | { type: 'DELETE_ASSET_SUCCESS'; payload: DeleteAssetSuccessPayload; meta?: MessageMeta }
  | { type: 'AUTH_ERROR'; payload: AuthErrorPayload; meta?: MessageMeta }
  | { type: 'STATUS'; payload: StatusPayload; meta?: MessageMeta };

export type BuilderToHostMessage = Extract<
  Message,
  { type: 'READY' | 'CHANGE' | 'LOADED' | 'SAVE' | 'UPLOAD' | 'LIST_ASSETS' | 'DELETE_ASSET' | 'AUTH_ERROR' | 'STATUS' }
>;

export type HostToBuilderMessage = Extract<
  Message,
  { type: 'INIT' | 'UPLOAD_SUCCESS' | 'ASSETS_LIST' | 'DELETE_ASSET_SUCCESS' }
>;

const VALID_TYPES = new Set<MessageType>([
  'INIT',
  'READY',
  'CHANGE',
  'LOADED',
  'SAVE',
  'UPLOAD',
  'UPLOAD_SUCCESS',
  'LIST_ASSETS',
  'ASSETS_LIST',
  'DELETE_ASSET',
  'DELETE_ASSET_SUCCESS',
  'AUTH_ERROR',
  'STATUS',
]);

type ExactRecord = Record<string, unknown>;

function exactRecord(value: unknown, allowed: readonly string[], required: readonly string[] = []): ExactRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) return null;
    if (required.some((key) => !keys.includes(key))) return null;
    const result: ExactRecord = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function validBoundedString(value: unknown, maxCharacters: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxCharacters && (allowEmpty || value.length > 0);
}

function validAssetUrl(value: unknown, allowEmpty = false): value is string {
  if (allowEmpty && value === '') return true;
  if (!validBoundedString(value, SDK_INPUT_LIMITS.urlCharacters)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hostname.endsWith('.');
  } catch {
    return false;
  }
}

function validMeta(value: unknown): boolean {
  if (value === undefined) return true;
  const meta = exactRecord(value, ['id', 'correlationId', 'version', 'sentAt'], ['id', 'version', 'sentAt']);
  if (!meta || !validBoundedString(meta.id, 128)) return false;
  if (meta.correlationId !== undefined && !validBoundedString(meta.correlationId, 128, true)) return false;
  return meta.version === EMAIL_BUILDER_PROTOCOL_VERSION && typeof meta.sentAt === 'number' && Number.isFinite(meta.sentAt) && meta.sentAt >= 0;
}

function validHtmlPayload(value: unknown): boolean {
  const payload = exactRecord(value, ['html'], ['html']);
  return !!payload && typeof payload.html === 'string' && isWithinUtf8ByteLimit(payload.html, SDK_INPUT_LIMITS.htmlBytes);
}

function validFile(value: unknown): value is File {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const tag = Object.prototype.toString.call(value);
    if (tag !== '[object File]') return false;
    const file = value as File;
    return validBoundedString(file.name, SDK_INPUT_LIMITS.keyCharacters, true) &&
      typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0 &&
      typeof file.type === 'string' && file.type.length <= 256 &&
      typeof file.slice === 'function';
  } catch {
    return false;
  }
}

function validAsset(value: unknown): boolean {
  const asset = exactRecord(value, ['url', 'id', 'name', 'thumbnailUrl', 'mimeType'], ['id', 'url']);
  if (!asset || !validBoundedString(asset.id, SDK_INPUT_LIMITS.keyCharacters) || !validAssetUrl(asset.url)) return false;
  if (asset.name !== undefined && !validBoundedString(asset.name, SDK_INPUT_LIMITS.keyCharacters)) return false;
  if (asset.thumbnailUrl !== undefined && !validAssetUrl(asset.thumbnailUrl)) return false;
  return asset.mimeType === undefined || ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp'].includes(asset.mimeType as string);
}

function validInitPayload(value: unknown): boolean {
  const payload = exactRecord(value, ['html', 'mergeTags', 'mergeTagTrigger', 'templateId', 'config', 'externalFooterHtml', 'footerInjectionMode']);
  if (!payload) return false;
  if (payload.html !== undefined && (typeof payload.html !== 'string' || !isWithinUtf8ByteLimit(payload.html, SDK_INPUT_LIMITS.htmlBytes))) return false;
  if (payload.externalFooterHtml !== undefined && (typeof payload.externalFooterHtml !== 'string' || !isWithinUtf8ByteLimit(payload.externalFooterHtml, SDK_INPUT_LIMITS.htmlBytes))) return false;
  if (payload.mergeTagTrigger !== undefined && !validBoundedString(payload.mergeTagTrigger, 64)) return false;
  if (payload.templateId !== undefined && !validBoundedString(payload.templateId, SDK_INPUT_LIMITS.keyCharacters)) return false;
  if (payload.footerInjectionMode !== undefined && payload.footerInjectionMode !== 'default' && payload.footerInjectionMode !== 'sdk') return false;
  if (payload.config !== undefined) {
    if (typeof payload.config !== 'object' || payload.config === null || Array.isArray(payload.config)) return false;
    try { safeStableSerialize(payload.config); } catch { return false; }
  }
  if (payload.mergeTags !== undefined) {
    if (!Array.isArray(payload.mergeTags) || payload.mergeTags.length > SDK_INPUT_LIMITS.mergeTagCount) return false;
    for (const tagValue of payload.mergeTags) {
      const tag = exactRecord(tagValue, ['label', 'value'], ['label', 'value']);
      if (!tag || !validBoundedString(tag.label, SDK_INPUT_LIMITS.keyCharacters) || !validBoundedString(tag.value, SDK_INPUT_LIMITS.keyCharacters)) return false;
    }
  }
  return true;
}

export function isMessageLike(value: unknown): value is Message {
  try {
    const candidate = exactRecord(value, ['type', 'payload', 'meta'], ['type']);
    if (!candidate || typeof candidate.type !== 'string' || !VALID_TYPES.has(candidate.type as MessageType) || !validMeta(candidate.meta)) return false;
    if (['UPLOAD', 'LIST_ASSETS', 'DELETE_ASSET'].includes(candidate.type) && candidate.meta === undefined) return false;
    const payload = candidate.payload;
    switch (candidate.type as MessageType) {
    case 'READY': return !Object.prototype.hasOwnProperty.call(candidate, 'payload');
    case 'CHANGE': case 'LOADED': case 'SAVE': return validHtmlPayload(payload);
    case 'AUTH_ERROR': {
      const record = exactRecord(payload, ['message'], ['message']);
      return !!record && validBoundedString(record.message, 4096);
    }
    case 'STATUS': {
      const record = exactRecord(payload, ['status'], ['status']);
      return !!record && (record.status === 'idle' || record.status === 'loading' || record.status === 'ready' || record.status === 'error');
    }
    case 'UPLOAD': {
      const record = exactRecord(payload, ['file'], ['file']);
      return !!record && validFile(record.file);
    }
    case 'LIST_ASSETS': {
      if (payload === undefined) return true;
      const record = exactRecord(payload, ['limit']);
      return !!record && (record.limit === undefined || (typeof record.limit === 'number' && Number.isInteger(record.limit) && record.limit >= 1 && record.limit <= SDK_INPUT_LIMITS.assetCount));
    }
    case 'DELETE_ASSET': {
      const record = exactRecord(payload, ['id', 'url']);
      if (!record) return false;
      const idValid = record.id === undefined || validBoundedString(record.id, SDK_INPUT_LIMITS.keyCharacters);
      const urlValid = record.url === undefined || validAssetUrl(record.url);
      return idValid && urlValid && (record.id !== undefined || record.url !== undefined);
    }
    case 'INIT': return validInitPayload(payload);
    case 'UPLOAD_SUCCESS': {
      const record = exactRecord(payload, ['url'], ['url']);
      return !!record && validAssetUrl(record.url, true);
    }
    case 'ASSETS_LIST': {
      const record = exactRecord(payload, ['assets'], ['assets']);
      if (!record || !Array.isArray(record.assets) || record.assets.length > SDK_INPUT_LIMITS.assetCount || !record.assets.every(validAsset)) return false;
      const ids = new Set<string>();
      const urls = new Set<string>();
      for (const value of record.assets) {
        const asset = value as AssetItem;
        if (ids.has(asset.id) || urls.has(asset.url)) return false;
        ids.add(asset.id);
        urls.add(asset.url);
      }
      return true;
    }
      case 'DELETE_ASSET_SUCCESS': {
        const record = exactRecord(payload, ['success'], ['success']);
        return !!record && typeof record.success === 'boolean';
      }
    }
  } catch {
    return false;
  }
}

export function createMessageMeta(correlationId?: string): MessageMeta {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return {
    id,
    correlationId,
    version: EMAIL_BUILDER_PROTOCOL_VERSION,
    sentAt: Date.now(),
  };
}
