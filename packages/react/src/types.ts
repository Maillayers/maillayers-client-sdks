import type { AssetItem, BuilderConfig, BuilderStatus, DeleteAssetPayload, ListAssetsPayload } from './protocol';
import type { CSSProperties, ReactNode } from 'react';

export interface AssetRequestContext {
  requestId: string;
  signal: AbortSignal;
}

export type UploadHandler = (file: File, context: AssetRequestContext) => Promise<string>;
export type ListAssetsHandler = (payload: ListAssetsPayload | undefined, context: AssetRequestContext) => Promise<AssetItem[]>;
export type DeleteAssetHandler = (payload: DeleteAssetPayload, context: AssetRequestContext) => Promise<boolean>;

export type EmailBuilderStatus = BuilderStatus;

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

export interface EmailBuilderProps {
  /**
  * Optional builder app URL. If omitted, SDK uses the managed MailLayers builder endpoint.
   */
  src?: string;
  /** MailLayers SDK API key used to validate licensed usage. */
  apiKey?: string;
  /** Optional validation API base URL or exact `/api/sdk/license/validate` URL. */
  licenseValidationUrl?: string;
  /** Optional expected organization binding for fail-closed multi-tenant validation. */
  expectedOrganizationId?: string;
  /** Optional expected license binding for fail-closed license substitution protection. */
  expectedLicenseId?: string;
  initialHtml?: string;
  /** Merge tag options used by the embedded editor dropdown. */
  mergeTags?: MergeTagOption[];
  /** Trigger used to open merge tag suggestions (defaults to '@'). */
  mergeTagTrigger?: string;
  /**
   * @deprecated No longer required. Use apiKey only.
   * Retained for backward compatibility with existing 0.2.0 consumers.
   * Omitting this prop is fully supported for the hosted editor protocol.
   */
  embedToken?: string;
  /**
   * Optional template id for builder-side template loading when supported.
   * Prefer `initialHtml` for typical hosted embeds.
   */
  templateId?: string;
  config?: BuilderConfig;
  /**
   * Optional: host-provided footer HTML to be rendered inside the builder (SDK mode).
   * When provided, the builder can avoid importing/auto-generating its own footer.
   */
  externalFooterHtml?: string;
  /**
   * Footer source selection.
   * - `default`: existing behavior
   * - `sdk`: use `externalFooterHtml`
   */
  footerInjectionMode?: 'default' | 'sdk';
  /** Optional runtime theme definition for light/dark rendering. */
  theme?: ThemeDefinition;
  /** Theme mode selector. `system` follows user OS preference. */
  themeMode?: ThemeMode;
  /** Optional tenant identifier used by host products for multi-tenant scoping. */
  tenantId?: string;
  /** Render the embedded builder in preview-only mode with just the desktop/mobile switcher. */
  preview?: boolean;
  /** Backwards-compatible alias for `preview`. */
  previewOnly?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Hide the SDK's default iframe loading overlay so the host can render its own loader. */
  hideLoadingOverlay?: boolean;
  /**
   * Custom loading UI shown while the editor is not ready.
   * When omitted, the SDK renders a neutral built-in spinner.
   * Auth/input error messages still replace the loader when validation fails.
   */
  loadingFallback?: ReactNode;
  /**
   * Accessible label for the default loading indicator.
   * Defaults to "Loading editor". Not shown as visible technical copy.
   */
  loadingLabel?: string;
  iframeTitle?: string;
  sandbox?: string;
  /**
   * When true, the hosted editor shows its Export button and modal in embedded mode.
   * Default: false (Export UI is hidden for SDK embeds). Standalone hosted editor
   * always shows Export. Not controllable via query parameters.
   */
  exportUi?: boolean;
  onChange?: (html: string) => void;
  /** Called once after the editor finishes processing the initially imported HTML.
   * Updates internal state without marking the template as user-modified. */
  onLoad?: (html: string) => void;
  onSave?: (html: string) => void;
  onUpload?: UploadHandler;
  onListAssets?: ListAssetsHandler;
  onDeleteAsset?: DeleteAssetHandler;
  onReady?: () => void;
  onStatusChange?: (status: EmailBuilderStatus) => void;
  /** Called when authorization fails or the embedded builder reports an auth error. */
  onAuthError?: (message: string) => void;
  /**
   * Optional explicit origin assertion. It must be an origin-only HTTP(S) URL,
   * exactly match `src`, and use HTTPS except for loopback development hosts.
   */
  allowedOrigin?: string;
}

export interface EmailBuilderHandle {
  /** Starts a new iframe handshake using the latest validated initial props. */
  reload: () => void;
  /** Returns the current exportable HTML from the hosted editor. */
  getHtml: () => Promise<string>;
  /** Returns the current structured template JSON from the hosted editor. */
  getJson: () => Promise<unknown>;
}

/** Public imperative ref API for `MailLayersEmailEditor`. */
export type MailLayersEmailEditorRef = EmailBuilderHandle;
