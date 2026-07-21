import type { AssetItem, BuilderConfig, BuilderStatus, DeleteAssetPayload, ListAssetsPayload } from './protocol';

export interface AssetRequestContext {
  requestId: string;
  signal: AbortSignal;
}

export type UploadHandler = (file: File, context: AssetRequestContext) => Promise<string>;
export type ListAssetsHandler = (payload: ListAssetsPayload | undefined, context: AssetRequestContext) => Promise<AssetItem[]>;
export type DeleteAssetHandler = (payload: DeleteAssetPayload, context: AssetRequestContext) => Promise<boolean>;

export type EmailEditorStatus = BuilderStatus;

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeTokens {
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  background: string;
  surface: string;
  border: string;
  text: string;
}

export interface ThemeDefinition {
  name?: string;
  tenantId?: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

export interface MergeTagOption {
  label: string;
  value: string;
}

/** Framework-neutral inline style record validated by the shared input rules. */
export type StyleRecord = Record<string, string | number>;

export interface EmailEditorCallbacks {
  onChange?: (html: string) => void;
  /** Called once after the editor finishes processing the initially imported HTML. */
  onLoad?: (html: string) => void;
  onSave?: (html: string) => void;
  onUpload?: UploadHandler;
  onListAssets?: ListAssetsHandler;
  onDeleteAsset?: DeleteAssetHandler;
  onReady?: () => void;
  onStatusChange?: (status: EmailEditorStatus) => void;
  onAuthError?: (message: string) => void;
}

/**
 * Framework-neutral editor options. These mirror the public props of
 * `@maillayers/react-email-editor` and are validated with the same rules.
 */
export interface EmailEditorOptions extends EmailEditorCallbacks {
  src?: string;
  apiKey?: string;
  licenseValidationUrl?: string;
  expectedOrganizationId?: string;
  expectedLicenseId?: string;
  initialHtml?: string;
  mergeTags?: MergeTagOption[];
  mergeTagTrigger?: string;
  embedToken?: string;
  templateId?: string;
  config?: BuilderConfig;
  externalFooterHtml?: string;
  footerInjectionMode?: 'default' | 'sdk';
  theme?: ThemeDefinition;
  themeMode?: ThemeMode;
  tenantId?: string;
  preview?: boolean;
  previewOnly?: boolean;
  hideLoadingOverlay?: boolean;
  iframeTitle?: string;
  sandbox?: string;
  allowedOrigin?: string;
}

/** Identity of the concrete published framework package driving the controller. */
export interface EmailEditorPackageInfo {
  packageName: string;
  packageVersion: string;
}
