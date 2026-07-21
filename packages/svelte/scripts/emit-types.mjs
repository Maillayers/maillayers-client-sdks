import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const dts = `import type { SvelteComponent } from 'svelte';
export { validateMailLayersLicense } from './shared-types';
export type {
  AssetItem,
  AssetRequestContext,
  BuilderConfig,
  DeleteAssetHandler,
  DeleteAssetPayload,
  EmailEditorStatus,
  ListAssetsHandler,
  ListAssetsPayload,
  MergeTagOption,
  ThemeDefinition,
  ThemeMode,
  ThemeTokens,
  UploadHandler,
  ValidateMailLayersLicenseOptions,
  MailLayersLicenseValidationResponse,
} from './shared-types';

export interface MailLayersEmailEditorProps {
  src?: string;
  apiKey?: string;
  licenseValidationUrl?: string;
  expectedOrganizationId?: string;
  expectedLicenseId?: string;
  initialHtml?: string;
  mergeTags?: import('./shared-types').MergeTagOption[];
  mergeTagTrigger?: string;
  embedToken?: string;
  templateId?: string;
  config?: Exclude<import('./shared-types').BuilderConfig, undefined>;
  externalFooterHtml?: string;
  footerInjectionMode?: 'default' | 'sdk';
  theme?: import('./shared-types').ThemeDefinition;
  themeMode?: import('./shared-types').ThemeMode;
  tenantId?: string;
  preview?: boolean;
  previewOnly?: boolean;
  hideLoadingOverlay?: boolean;
  iframeTitle?: string;
  sandbox?: string;
  allowedOrigin?: string;
  upload?: import('./shared-types').UploadHandler;
  listAssets?: import('./shared-types').ListAssetsHandler;
  deleteAsset?: import('./shared-types').DeleteAssetHandler;
}

declare class MailLayersEmailEditor extends SvelteComponent<MailLayersEmailEditorProps> {
  reload(): void;
}

export { MailLayersEmailEditor };
export default MailLayersEmailEditor;
`;

const sharedTypes = `export type BuilderConfig = Record<string, unknown> | undefined;
export type EmailEditorStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ThemeMode = 'light' | 'dark' | 'system';
export interface ThemeTokens {
  primary: string; secondary: string; accent: string; success: string; warning: string; error: string;
  background: string; surface: string; border: string; text: string;
}
export interface ThemeDefinition { name?: string; tenantId?: string; light: ThemeTokens; dark: ThemeTokens; }
export interface MergeTagOption { label: string; value: string; }
export interface AssetRequestContext { requestId: string; signal: AbortSignal; }
export interface AssetItem {
  id: string; url: string; name?: string; thumbnailUrl?: string;
  mimeType?: 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/svg+xml' | 'image/webp';
}
export interface ListAssetsPayload { limit?: number; }
export interface DeleteAssetPayload { id?: string; url?: string; }
export type UploadHandler = (file: File, context: AssetRequestContext) => Promise<string>;
export type ListAssetsHandler = (payload: ListAssetsPayload | undefined, context: AssetRequestContext) => Promise<AssetItem[]>;
export type DeleteAssetHandler = (payload: DeleteAssetPayload, context: AssetRequestContext) => Promise<boolean>;
export interface ValidateMailLayersLicenseOptions {
  apiKey: unknown; apiUrl?: string; packageName?: string; packageVersion?: string;
  signal?: AbortSignal; timeoutMs?: number; origin?: string;
  expectedOrganizationId?: string; expectedLicenseId?: string;
}
export interface MailLayersLicenseValidationResponse {
  status: 'valid'; reason: 'allowed_domain' | 'local_development'; origin: string; domain: string;
  requestId: string; keyFingerprint: string; organizationId: string; licenseId: string; plan: string;
}
export declare function validateMailLayersLicense(options: ValidateMailLayersLicenseOptions): Promise<MailLayersLicenseValidationResponse>;
`;

await writeFile(resolve(root, 'dist/index.d.ts'), dts);
await writeFile(resolve(root, 'dist/index.d.cts'), dts);
await writeFile(resolve(root, 'dist/shared-types.d.ts'), sharedTypes);
await writeFile(resolve(root, 'dist/shared-types.d.cts'), sharedTypes);
console.log('emitted svelte declaration files');
