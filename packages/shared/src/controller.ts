import type { BuilderToHostMessage, HostToBuilderMessage, InitPayload } from './protocol';
import { buildEnvelope, deriveAllowedOrigin, sanitizeIncomingMessage, stableSignature } from './utils';
import type { EmailEditorOptions, EmailEditorPackageInfo, EmailEditorStatus, MergeTagOption, ThemeDefinition } from './types';
import { validateMailLayersLicense } from './license';
import { DEFAULT_BUILDER_SRC } from './constants';
import { validateEmailBuilderInputs } from './runtime-validation';
import { invokeHostCallback } from './callbacks';
import { normalizeAssetListResult, normalizeUploadResult } from './assets';
import type { BuilderConfig } from './protocol';

const DEFAULT_SANDBOX = 'allow-scripts allow-same-origin allow-forms';
const DEFAULT_INITIAL_HTML = '<h1>Hello World</h1><p>Start building your email template.</p>';
const DEFAULT_IFRAME_TITLE = 'Email Builder';
const HANDSHAKE_TIMEOUT_MS = 12_000;
const ASSET_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_ASSET_REQUESTS = 4;
const MAX_RECENT_ASSET_REQUESTS = 100;

type PendingMessage = {
  message: HostToBuilderMessage;
  correlationId?: string;
};

export type EmailEditorContentOptions = Pick<
  EmailEditorOptions,
  'initialHtml' | 'mergeTags' | 'mergeTagTrigger' | 'templateId' | 'config' | 'externalFooterHtml' | 'footerInjectionMode' | 'theme' | 'themeMode' | 'tenantId'
>;

export interface EmailEditorControllerOptions extends EmailEditorOptions, EmailEditorPackageInfo {}

function appendPreviewParamsToSrc(src: string, preview: boolean): string {
  if (!preview) {
    return src;
  }
  try {
    const u = new URL(src, typeof window !== 'undefined' ? window.location.href : 'https://example.com');
    u.searchParams.set('preview', 'true');
    u.searchParams.set('previewOnly', 'true');
    return u.toString();
  } catch {
    const sep = src.includes('?') ? '&' : '?';
    return `${src}${sep}preview=true&previewOnly=true`;
  }
}

function appendEmbedTokenToSrc(src: string, embedToken: string | undefined): string {
  if (typeof embedToken !== 'string' || !embedToken.trim()) {
    return src;
  }
  try {
    const u = new URL(src, typeof window !== 'undefined' ? window.location.href : 'https://example.com');
    u.searchParams.set('embedToken', embedToken);
    return u.toString();
  } catch {
    const sep = src.includes('?') ? '&' : '?';
    return `${src}${sep}embedToken=${encodeURIComponent(embedToken)}`;
  }
}

async function withTimeout<T>(promise: Promise<T>, controller: AbortController, timeoutMs = ASSET_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        abort = () => reject(new Error('operation cancelled'));
        controller.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('operation timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) controller.signal.removeEventListener('abort', abort);
  }
}

const OVERLAY_STYLE =
  'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
  'font-size:0.875rem;font-weight:500;color:#fff;z-index:2;' +
  'background:linear-gradient(135deg, rgba(9,9,9,0.65), rgba(33,33,33,0.85));';
const IFRAME_STYLE = 'border:none;width:100%;height:100%;';

type ValidatedContent = {
  initPayload: InitPayload;
  error: string | null;
};

/**
 * Framework-neutral controller implementing the exact iframe lifecycle,
 * origin policy, and message protocol of `@maillayers/react-email-editor`.
 *
 * Frameworks mount it into a host element inside a browser-only lifecycle
 * hook. Authorization-relevant options are immutable for the lifetime of a
 * controller; content options may be staged with `stageContentUpdate` and are
 * applied only by an explicit `reload()`, never against a live editor.
 */
export class EmailEditorController {
  private readonly options: EmailEditorControllerOptions;
  private readonly propError: string | null;
  private readonly originError: string | null;
  private readonly expectedOrigin: string | null;
  private readonly iframeSrc: string;
  private readonly sandbox: string;
  private readonly iframeTitle: string;
  private readonly hideLoadingOverlay: boolean;

  private host: HTMLElement | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private overlay: HTMLElement | null = null;
  private builderWindow: Window | null = null;

  private destroyed = false;
  private mounted = false;
  private ready = false;
  private initSent = false;
  private licenseValidated = false;
  private authorizationActive = false;
  private statusValue: EmailEditorStatus = 'loading';
  private licenseError: string | null = null;

  private latestInit: HostToBuilderMessage;
  private queue: PendingMessage[] = [];
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private validationGeneration = 0;
  private handshakeGeneration = 0;
  private validationAbort: AbortController | null = null;
  private readonly activeAssetRequests = new Map<string, AbortController>();
  private readonly recentAssetResponses = new Map<string, HostToBuilderMessage>();

  private readonly boundHandleMessage = (event: MessageEvent) => this.handleMessage(event);
  private readonly boundHandleIframeLoad = () => this.handleIframeLoad();

  constructor(options: EmailEditorControllerOptions) {
    this.options = options;
    const inputValidation = validateEmailBuilderInputs({
      src: options.src,
      allowedOrigin: options.allowedOrigin,
      apiKey: options.apiKey,
      licenseValidationUrl: options.licenseValidationUrl,
      embedToken: options.embedToken,
      initialHtml: options.initialHtml,
      externalFooterHtml: options.externalFooterHtml,
      footerInjectionMode: options.footerInjectionMode,
      themeMode: options.themeMode,
      theme: options.theme,
      config: options.config,
      mergeTags: options.mergeTags,
      mergeTagTrigger: options.mergeTagTrigger,
      templateId: options.templateId,
      tenantId: options.tenantId,
      expectedOrganizationId: options.expectedOrganizationId,
      expectedLicenseId: options.expectedLicenseId,
      sandbox: options.sandbox,
      iframeTitle: options.iframeTitle,
      preview: options.preview,
      previewOnly: options.previewOnly,
      hideLoadingOverlay: options.hideLoadingOverlay,
      onChange: options.onChange,
      onLoad: options.onLoad,
      onSave: options.onSave,
      onUpload: options.onUpload,
      onListAssets: options.onListAssets,
      onDeleteAsset: options.onDeleteAsset,
      onReady: options.onReady,
      onStatusChange: options.onStatusChange,
      onAuthError: options.onAuthError,
    });
    this.propError = inputValidation.ok ? null : inputValidation.error;

    const resolvedSrc = typeof options.src === 'string' && options.src.trim() ? options.src.trim() : DEFAULT_BUILDER_SRC;
    const isPreviewMode = Boolean(options.preview || options.previewOnly);
    this.iframeSrc = appendEmbedTokenToSrc(appendPreviewParamsToSrc(resolvedSrc, isPreviewMode), options.embedToken);
    this.sandbox = this.propError
      ? DEFAULT_SANDBOX
      : typeof options.sandbox === 'string'
        ? options.sandbox
        : DEFAULT_SANDBOX;
    this.iframeTitle =
      typeof options.iframeTitle === 'string' && options.iframeTitle.trim() ? options.iframeTitle : DEFAULT_IFRAME_TITLE;
    this.hideLoadingOverlay = options.hideLoadingOverlay === true;

    let expectedOrigin: string | null = null;
    try {
      expectedOrigin = this.propError ? null : deriveAllowedOrigin(resolvedSrc, options.allowedOrigin);
    } catch {
      expectedOrigin = null;
    }
    this.expectedOrigin = expectedOrigin;
    this.originError = !this.propError && !expectedOrigin
      ? 'EmailBuilder origin configuration is invalid or untrusted.'
      : null;

    const content = this.validateContent(options, inputValidation.ok ? inputValidation : undefined);
    this.latestInit = { type: 'INIT', payload: content.initPayload };
    if (content.error && !this.propError && !this.originError) {
      this.licenseError = content.error;
    }
  }

  get status(): EmailEditorStatus {
    return this.statusValue;
  }

  /** Mounts the iframe into the host element and starts license validation. Browser-only. */
  mount(host: HTMLElement): void {
    if (this.destroyed || this.mounted) {
      return;
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    this.mounted = true;
    this.host = host;
    host.style.position = 'relative';
    if (!host.style.width) host.style.width = '100%';
    if (!host.style.height) host.style.height = '100%';

    window.addEventListener('message', this.boundHandleMessage);
    this.createIframe();
    this.createOverlay();
    this.startAuthorization();
  }

  /**
   * Stages new content options for the next handshake. The live editor is
   * never overwritten; staged values apply only after `reload()`.
   */
  stageContentUpdate(content: EmailEditorContentOptions): void {
    if (this.destroyed) {
      return;
    }
    const merged: EmailEditorControllerOptions = { ...this.options, ...content };
    const inputValidation = validateEmailBuilderInputs({
      apiKey: merged.apiKey,
      initialHtml: merged.initialHtml,
      externalFooterHtml: merged.externalFooterHtml,
      footerInjectionMode: merged.footerInjectionMode,
      themeMode: merged.themeMode,
      theme: merged.theme,
      config: merged.config,
      mergeTags: merged.mergeTags,
      mergeTagTrigger: merged.mergeTagTrigger,
      templateId: merged.templateId,
      tenantId: merged.tenantId,
      preview: merged.preview,
      previewOnly: merged.previewOnly,
    });
    if (!inputValidation.ok) {
      return;
    }
    const next = this.validateContent(merged, inputValidation);
    if (next.error) {
      return;
    }
    this.latestInit = { type: 'INIT', payload: next.initPayload };
  }

  /** Starts a new iframe handshake using the latest staged content. */
  reload(): void {
    if (this.destroyed || !this.mounted) {
      return;
    }
    this.handshakeGeneration += 1;
    this.resetAssetRequests();
    this.queue = [];
    this.ready = false;
    this.initSent = false;
    this.builderWindow = null;
    this.clearHandshakeTimer();
    this.setStatusSafely('loading');
    this.replaceIframe();
  }

  /** Tears down all listeners, timers, in-flight work, and DOM. Idempotent. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.clearHandshakeTimer();
    this.queue = [];
    this.builderWindow = null;
    this.ready = false;
    this.initSent = false;
    this.validationGeneration += 1;
    this.handshakeGeneration += 1;
    this.authorizationActive = false;
    this.validationAbort?.abort();
    this.validationAbort = null;
    this.resetAssetRequests();
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.boundHandleMessage);
    }
    if (this.iframe) {
      this.iframe.removeEventListener('load', this.boundHandleIframeLoad);
      this.iframe.remove();
      this.iframe = null;
    }
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    this.host = null;
  }

  private validateContent(
    options: EmailEditorControllerOptions,
    validated?: { config?: BuilderConfig; theme?: ThemeDefinition; mergeTags?: MergeTagOption[] },
  ): ValidatedContent {
    const safeConfig = validated?.config;
    const safeTheme = validated?.theme;
    const safeMergeTags = validated?.mergeTags;
    const safeInitialHtml = typeof options.initialHtml === 'string' ? options.initialHtml : undefined;
    const safeExternalFooterHtml = typeof options.externalFooterHtml === 'string' ? options.externalFooterHtml : undefined;
    const safeMergeTagTrigger = typeof options.mergeTagTrigger === 'string' ? options.mergeTagTrigger : undefined;
    const safeTemplateId = typeof options.templateId === 'string' ? options.templateId : undefined;
    const safeTenantId = typeof options.tenantId === 'string' ? options.tenantId : undefined;
    const isPreviewMode = Boolean(options.preview || options.previewOnly);

    const effectiveConfig: Record<string, unknown> = {
      ...(safeConfig ?? {}),
      ...(safeTheme ? { theme: safeTheme } : {}),
      ...(options.themeMode ? { themeMode: options.themeMode } : {}),
      ...(safeTenantId ? { tenantId: safeTenantId } : {}),
    };
    if (isPreviewMode) {
      effectiveConfig.preview = true;
      effectiveConfig.previewOnly = true;
    }

    const effectiveInitialHtml =
      safeInitialHtml !== undefined ? safeInitialHtml : safeTemplateId ? '' : DEFAULT_INITIAL_HTML;
    const effectiveFooterMode =
      options.footerInjectionMode || (safeExternalFooterHtml?.trim() ? 'sdk' : 'default');

    const initPayload: InitPayload = {
      html: effectiveInitialHtml,
      ...(safeMergeTags ? { mergeTags: safeMergeTags } : {}),
      ...(safeMergeTagTrigger?.trim() ? { mergeTagTrigger: safeMergeTagTrigger.trim() } : {}),
      config: effectiveConfig,
      ...(safeTemplateId ? { templateId: safeTemplateId } : {}),
      ...(safeExternalFooterHtml !== undefined ? { externalFooterHtml: safeExternalFooterHtml } : {}),
      footerInjectionMode: effectiveFooterMode,
    };

    try {
      stableSignature(initPayload);
    } catch {
      return { initPayload, error: 'EmailBuilder input exceeds the serialization limits.' };
    }
    return { initPayload, error: null };
  }

  private createIframe(): void {
    if (!this.host) {
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', this.sandbox);
    iframe.title = this.iframeTitle;
    iframe.style.cssText = IFRAME_STYLE;
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.src = this.canLoadBuilder() ? this.iframeSrc : 'about:blank';
    iframe.addEventListener('load', this.boundHandleIframeLoad);
    this.host.append(iframe);
    this.iframe = iframe;
  }

  private replaceIframe(): void {
    if (this.iframe) {
      this.iframe.removeEventListener('load', this.boundHandleIframeLoad);
      this.iframe.remove();
      this.iframe = null;
    }
    this.createIframe();
    if (this.overlay && this.host) {
      // Keep the overlay stacked above the newly appended iframe.
      this.host.append(this.overlay);
    }
  }

  private canLoadBuilder(): boolean {
    return !this.propError && !this.originError && this.licenseValidated;
  }

  private createOverlay(): void {
    if (this.hideLoadingOverlay || !this.host) {
      return;
    }
    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;
    this.host.append(overlay);
    this.overlay = overlay;
    this.syncOverlay();
  }

  private syncOverlay(): void {
    if (!this.overlay) {
      return;
    }
    if (this.statusValue === 'ready') {
      this.overlay.style.display = 'none';
      return;
    }
    this.overlay.style.display = 'flex';
    this.overlay.textContent = this.propError || this.originError || this.licenseError || 'Connecting to builder...';
  }

  private setStatusSafely(next: EmailEditorStatus): void {
    if (this.statusValue === next) {
      return;
    }
    this.statusValue = next;
    this.syncOverlay();
    void invokeHostCallback(this.options.onStatusChange, [next]);
  }

  private startAuthorization(): void {
    const controller = new AbortController();
    this.validationAbort = controller;
    const generation = ++this.validationGeneration;
    this.authorizationActive = false;
    this.resetAssetRequests();
    this.handshakeGeneration += 1;
    this.ready = false;
    this.initSent = false;
    this.queue = [];
    this.builderWindow = null;
    this.clearHandshakeTimer();
    this.licenseValidated = false;

    if (this.propError || this.originError || this.licenseError) {
      const message = this.propError || this.originError || this.licenseError || 'EmailBuilder input validation failed.';
      this.licenseError = message;
      if (this.statusValue !== 'error') {
        this.statusValue = 'error';
        void invokeHostCallback(this.options.onStatusChange, ['error']);
      }
      this.syncOverlay();
      void invokeHostCallback(this.options.onAuthError, [message]);
      return;
    }

    this.setStatusSafely('loading');
    validateMailLayersLicense({
      apiKey: this.options.apiKey,
      apiUrl: this.options.licenseValidationUrl,
      signal: controller.signal,
      origin: typeof window !== 'undefined' ? window.location.origin : undefined,
      expectedOrganizationId: this.options.expectedOrganizationId,
      expectedLicenseId: this.options.expectedLicenseId,
      packageName: this.options.packageName,
      packageVersion: this.options.packageVersion,
    })
      .then(() => {
        if (this.destroyed || this.validationGeneration !== generation) {
          return;
        }
        this.authorizationActive = true;
        this.licenseValidated = true;
        if (this.iframe) {
          this.iframe.src = this.iframeSrc;
        }
      })
      .catch((error: unknown) => {
        if (this.destroyed || this.validationGeneration !== generation) {
          return;
        }
        const message = error instanceof Error ? error.message : 'MailLayers SDK license validation failed.';
        this.licenseError = message;
        if (this.statusValue !== 'error') {
          this.statusValue = 'error';
          void invokeHostCallback(this.options.onStatusChange, ['error']);
        }
        this.syncOverlay();
        void invokeHostCallback(this.options.onAuthError, [message]);
      });
  }

  private resolveTargetOrigin(): string | null {
    return this.expectedOrigin;
  }

  private postMessage(message: HostToBuilderMessage, correlationId?: string): void {
    if (this.destroyed || !this.authorizationActive) {
      return;
    }
    const target = this.iframe?.contentWindow ?? this.builderWindow;
    if (target) {
      this.builderWindow = target;
    }
    if (!this.expectedOrigin || !this.builderWindow || !this.ready) {
      this.queue.push({ message, correlationId });
      return;
    }
    try {
      const outbound = typeof window !== 'undefined'
        ? (window as unknown as { __mlOutbound?: Array<Record<string, unknown>> }).__mlOutbound
        : undefined;
      if (Array.isArray(outbound)) {
        outbound.push({
          type: message.type,
          targetOrigin: this.resolveTargetOrigin(),
          html: 'payload' in message && message.payload && typeof message.payload === 'object' && 'html' in message.payload
            ? (message.payload as { html?: string }).html
            : undefined,
        });
      }
      this.builderWindow.postMessage(buildEnvelope(message, correlationId), this.resolveTargetOrigin()!);
    } catch {
      this.setStatusSafely('error');
    }
  }

  private flushQueue(): void {
    if (!this.expectedOrigin || !this.ready || !this.builderWindow) {
      return;
    }
    const pending = [...this.queue];
    this.queue = [];
    for (const { message, correlationId } of pending) {
      if (this.destroyed) {
        return;
      }
      try {
        this.builderWindow?.postMessage(buildEnvelope(message, correlationId), this.resolveTargetOrigin()!);
      } catch {
        this.setStatusSafely('error');
      }
    }
  }

  private resetAssetRequests(): void {
    for (const controller of this.activeAssetRequests.values()) {
      controller.abort();
    }
    this.activeAssetRequests.clear();
    this.recentAssetResponses.clear();
  }

  private async executeAssetRequest(
    requestKey: string,
    correlationId: string,
    operation: (controller: AbortController) => Promise<HostToBuilderMessage>,
    failure: HostToBuilderMessage,
  ): Promise<void> {
    const cached = this.recentAssetResponses.get(requestKey);
    if (cached) {
      this.postMessage(cached, correlationId);
      return;
    }
    if (this.activeAssetRequests.has(requestKey)) {
      return;
    }
    if (this.activeAssetRequests.size >= MAX_CONCURRENT_ASSET_REQUESTS) {
      this.postMessage(failure, correlationId);
      return;
    }

    const controller = new AbortController();
    const generation = this.handshakeGeneration;
    this.activeAssetRequests.set(requestKey, controller);
    let response = failure;
    let requestStillActive = false;
    try {
      response = await operation(controller);
    } catch {
      response = failure;
    } finally {
      requestStillActive = this.activeAssetRequests.get(requestKey) === controller;
      if (requestStillActive) {
        this.activeAssetRequests.delete(requestKey);
      }
    }

    if (!requestStillActive || this.destroyed || !this.authorizationActive || this.handshakeGeneration !== generation) {
      return;
    }
    this.recentAssetResponses.set(requestKey, response);
    if (this.recentAssetResponses.size > MAX_RECENT_ASSET_REQUESTS) {
      const oldest = this.recentAssetResponses.keys().next().value;
      if (typeof oldest === 'string') {
        this.recentAssetResponses.delete(oldest);
      }
    }
    this.postMessage(response, correlationId);
  }

  private handleReadyMessage(): void {
    if (this.ready) {
      return;
    }
    this.clearHandshakeTimer();
    this.ready = true;
    const statusChanged = this.statusValue !== 'ready';
    if (statusChanged) {
      this.statusValue = 'ready';
      this.syncOverlay();
    }
    if (!this.initSent) {
      this.postMessage(this.latestInit);
      this.initSent = true;
    }
    this.flushQueue();
    if (statusChanged) {
      void invokeHostCallback(this.options.onStatusChange, ['ready']);
    }
    if (!this.destroyed) {
      void invokeHostCallback(this.options.onReady, []);
    }
  }

  private async handleUpload(eventMessage: BuilderToHostMessage): Promise<void> {
    if (eventMessage.type !== 'UPLOAD') {
      return;
    }
    const requestId = eventMessage.meta!.id;
    const failure: HostToBuilderMessage = { type: 'UPLOAD_SUCCESS', payload: { url: '' } };
    await this.executeAssetRequest(`UPLOAD:${requestId}`, requestId, async (controller) => {
      const result = await withTimeout(
        invokeHostCallback(this.options.onUpload, [eventMessage.payload.file, { requestId, signal: controller.signal }]),
        controller,
      );
      const url = result.ok ? normalizeUploadResult(result.value) : null;
      if (!url) throw new Error('invalid upload result');
      return { type: 'UPLOAD_SUCCESS', payload: { url } };
    }, failure);
  }

  private async handleListAssets(eventMessage: BuilderToHostMessage): Promise<void> {
    if (eventMessage.type !== 'LIST_ASSETS') {
      return;
    }
    const requestId = eventMessage.meta!.id;
    const failure: HostToBuilderMessage = { type: 'ASSETS_LIST', payload: { assets: [] } };
    await this.executeAssetRequest(`LIST_ASSETS:${requestId}`, requestId, async (controller) => {
      const result = await withTimeout(
        invokeHostCallback(this.options.onListAssets, [eventMessage.payload, { requestId, signal: controller.signal }]),
        controller,
      );
      const assets = result.ok ? normalizeAssetListResult(result.value, eventMessage.payload?.limit) : null;
      if (!assets) throw new Error('invalid asset list');
      return { type: 'ASSETS_LIST', payload: { assets } };
    }, failure);
  }

  private async handleDeleteAsset(eventMessage: BuilderToHostMessage): Promise<void> {
    if (eventMessage.type !== 'DELETE_ASSET') {
      return;
    }
    const requestId = eventMessage.meta!.id;
    const failure: HostToBuilderMessage = { type: 'DELETE_ASSET_SUCCESS', payload: { success: false } };
    await this.executeAssetRequest(`DELETE_ASSET:${requestId}`, requestId, async (controller) => {
      const result = await withTimeout(
        invokeHostCallback(this.options.onDeleteAsset, [eventMessage.payload, { requestId, signal: controller.signal }]),
        controller,
      );
      return { type: 'DELETE_ASSET_SUCCESS', payload: { success: result.ok && result.value === true } };
    }, failure);
  }

  private handleMessage(event: MessageEvent): void {
    if (this.destroyed || !this.authorizationActive) {
      return;
    }
    const iframeWindow = this.iframe?.contentWindow ?? this.builderWindow;
    if (!iframeWindow || !this.expectedOrigin) {
      return;
    }
    const message = sanitizeIncomingMessage(event, this.expectedOrigin, iframeWindow);
    if (!message) {
      return;
    }
    if (event.source && event.source !== this.builderWindow) {
      this.builderWindow = event.source as Window;
    }

    switch (message.type) {
      case 'READY':
        this.handleReadyMessage();
        break;
      case 'CHANGE':
        void invokeHostCallback(this.options.onChange, [message.payload.html]);
        break;
      case 'LOADED':
        void invokeHostCallback(this.options.onLoad, [message.payload.html]);
        break;
      case 'SAVE':
        void invokeHostCallback(this.options.onSave, [message.payload.html]);
        break;
      case 'UPLOAD':
        void this.handleUpload(message);
        break;
      case 'LIST_ASSETS':
        void this.handleListAssets(message);
        break;
      case 'DELETE_ASSET':
        void this.handleDeleteAsset(message);
        break;
      case 'AUTH_ERROR': {
        const msg = message.payload?.message || 'Email builder authentication failed';
        if (this.statusValue !== 'error') {
          this.setStatusSafely('error');
          if (!this.destroyed) {
            void invokeHostCallback(this.options.onAuthError, [msg]);
          }
        }
        break;
      }
      case 'STATUS':
        this.setStatusSafely(message.payload.status);
        break;
      default:
        break;
    }
  }

  private handleIframeLoad(): void {
    if (this.destroyed || !this.licenseValidated) {
      return;
    }
    this.handshakeGeneration += 1;
    this.resetAssetRequests();
    this.builderWindow = this.iframe?.contentWindow ?? null;
    this.ready = false;
    this.initSent = false;
    this.setStatusSafely('loading');

    this.clearHandshakeTimer();
    if (this.expectedOrigin && this.builderWindow) {
      try {
        const envelope = buildEnvelope(this.latestInit);
        const outbound = typeof window !== 'undefined'
          ? (window as unknown as { __mlOutbound?: Array<Record<string, unknown>> }).__mlOutbound
          : undefined;
        if (Array.isArray(outbound)) {
          outbound.push({
            type: envelope.type,
            targetOrigin: this.expectedOrigin,
            html: this.latestInit.type === 'INIT' ? this.latestInit.payload.html : undefined,
          });
        }
        this.builderWindow.postMessage(envelope, this.expectedOrigin);
        this.initSent = true;
      } catch {
        this.setStatusSafely('error');
      }
    }

    this.handshakeTimer = setTimeout(() => {
      if (this.ready) {
        return;
      }
      this.setStatusSafely('error');
      if (!this.destroyed) {
        void invokeHostCallback(this.options.onAuthError, ['Builder handshake failed or authentication was rejected.']);
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }
}

export function createEmailEditorController(options: EmailEditorControllerOptions): EmailEditorController {
  return new EmailEditorController(options);
}
