import React, {
  CSSProperties,
  ForwardedRef,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { BuilderToHostMessage, HostToBuilderMessage, InitPayload } from './protocol';
import { buildEnvelope, deriveAllowedOrigin, sanitizeIncomingMessage, stableSignature } from './utils';
import type { EmailBuilderHandle, EmailBuilderProps, EmailBuilderStatus } from './types';
import { validateMailLayersLicense } from './license';
import { DEFAULT_BUILDER_SRC } from './constants';
import { validateEmailBuilderInputs } from './runtime-validation';
import { invokeHostCallback } from './callbacks';
import { normalizeAssetListResult, normalizeUploadResult } from './assets';

const DEFAULT_SANDBOX = 'allow-scripts allow-same-origin allow-forms';
const DEFAULT_INITIAL_HTML = '<h1>Hello World</h1><p>Start building your email template.</p>';
const ASSET_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_ASSET_REQUESTS = 4;
const MAX_RECENT_ASSET_REQUESTS = 100;

type PendingMessage = {
  message: HostToBuilderMessage;
  correlationId?: string;
};

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.875rem',
  fontWeight: 500,
  background: 'linear-gradient(135deg, rgba(9,9,9,0.65), rgba(33,33,33,0.85))',
  color: '#fff',
  zIndex: 2,
};

const iframeStyle: CSSProperties = {
  border: 'none',
  width: '100%',
  height: '100%',
};

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

function EmailBuilderInner(
  {
    src,
    apiKey,
    licenseValidationUrl,
    expectedOrganizationId,
    expectedLicenseId,
    initialHtml,
    mergeTags,
    mergeTagTrigger,
    embedToken,
    templateId,
    config,
    theme,
    themeMode,
    tenantId,
    externalFooterHtml,
    footerInjectionMode,
    preview = false,
    previewOnly = false,
    className,
    style,
    hideLoadingOverlay = false,
    iframeTitle = 'Email Builder',
    sandbox = DEFAULT_SANDBOX,
    onChange,
    onLoad,
    onSave,
    onUpload,
    onListAssets,
    onDeleteAsset,
    onReady,
    onStatusChange,
    onAuthError,
    allowedOrigin,
  }: EmailBuilderProps,
  ref: ForwardedRef<EmailBuilderHandle>
) {
  const inputValidation = useMemo(() => validateEmailBuilderInputs({
    src, allowedOrigin, apiKey, licenseValidationUrl, embedToken, initialHtml, externalFooterHtml,
    footerInjectionMode, themeMode, theme, config, mergeTags, mergeTagTrigger,
    templateId, tenantId, expectedOrganizationId, expectedLicenseId, style,
    sandbox, iframeTitle, preview, previewOnly, className, hideLoadingOverlay,
    onChange, onLoad, onSave, onUpload, onListAssets, onDeleteAsset, onReady,
    onStatusChange, onAuthError,
  }), [
    src, allowedOrigin, apiKey, licenseValidationUrl, embedToken, initialHtml, externalFooterHtml,
    footerInjectionMode, themeMode, theme, config, mergeTags, mergeTagTrigger,
    templateId, tenantId, expectedOrganizationId, expectedLicenseId, style,
    sandbox, iframeTitle, preview, previewOnly, className, hideLoadingOverlay,
    onChange, onLoad, onSave, onUpload, onListAssets, onDeleteAsset, onReady,
    onStatusChange, onAuthError,
  ]);
  const propError = inputValidation.ok ? null : inputValidation.error;
  const safeConfig = inputValidation.ok ? inputValidation.config : undefined;
  const safeTheme = inputValidation.ok ? inputValidation.theme : undefined;
  const safeMergeTags = inputValidation.ok ? inputValidation.mergeTags : undefined;
  const safeStyle = inputValidation.ok ? inputValidation.style : undefined;
  const safeInitialHtml = inputValidation.ok && typeof initialHtml === 'string' ? initialHtml : undefined;
  const safeExternalFooterHtml = inputValidation.ok && typeof externalFooterHtml === 'string' ? externalFooterHtml : undefined;
  const safeMergeTagTrigger = inputValidation.ok && typeof mergeTagTrigger === 'string' ? mergeTagTrigger : undefined;
  const safeTemplateId = inputValidation.ok && typeof templateId === 'string' ? templateId : undefined;
  const safeTenantId = inputValidation.ok && typeof tenantId === 'string' ? tenantId : undefined;
  const safeThemeMode = inputValidation.ok ? themeMode : undefined;
  const safeFooterInjectionMode = inputValidation.ok ? footerInjectionMode : undefined;
  const resolvedSrc = typeof src === 'string' && src.trim() ? src.trim() : DEFAULT_BUILDER_SRC;
  const isPreviewMode = preview || previewOnly;
  const effectiveConfig = useMemo(() => {
    const mergedConfig: Record<string, unknown> = {
      ...(safeConfig ?? {}),
      ...(safeTheme ? { theme: safeTheme } : {}),
      ...(safeThemeMode ? { themeMode: safeThemeMode } : {}),
      ...(safeTenantId ? { tenantId: safeTenantId } : {}),
    };

    if (isPreviewMode) {
      mergedConfig.preview = true;
      mergedConfig.previewOnly = true;
    }

    return mergedConfig;
  }, [safeConfig, isPreviewMode, safeTheme, safeThemeMode, safeTenantId]);
  const iframeSrc = useMemo(
    () => appendEmbedTokenToSrc(appendPreviewParamsToSrc(resolvedSrc, isPreviewMode), embedToken),
    [resolvedSrc, embedToken, isPreviewMode]
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const builderWindowRef = useRef<Window | null>(null);
  const readyRef = useRef(false);
  const initSentRef = useRef(false);
  const statusRef = useRef<EmailBuilderStatus>('loading');
  const [status, setStatus] = useState<EmailBuilderStatus>('loading');
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [isLicenseValidated, setIsLicenseValidated] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const queueRef = useRef<PendingMessage[]>([]);
  const handshakeTimerRef = useRef<number | null>(null);
  const validationGenerationRef = useRef(0);
  const handshakeGenerationRef = useRef(0);
  const authorizationActiveRef = useRef(false);
  const activeAssetRequestsRef = useRef(new Map<string, AbortController>());
  const recentAssetResponsesRef = useRef(new Map<string, HostToBuilderMessage>());
  const onAuthErrorRef = useRef(onAuthError);
  const onStatusChangeRef = useRef(onStatusChange);

  const resetAssetRequests = useCallback(() => {
    for (const controller of activeAssetRequestsRef.current.values()) controller.abort();
    activeAssetRequestsRef.current.clear();
    recentAssetResponsesRef.current.clear();
  }, []);

  const effectiveInitialHtml =
    safeInitialHtml !== undefined
      ? safeInitialHtml
      : safeTemplateId
        ? ''
        : DEFAULT_INITIAL_HTML;

  const effectiveFooterMode =
    safeFooterInjectionMode ||
    (safeExternalFooterHtml?.trim() ? 'sdk' : 'default');

  const initPayload: InitPayload = {
    html: effectiveInitialHtml,
    ...(safeMergeTags ? { mergeTags: safeMergeTags } : {}),
    ...(safeMergeTagTrigger?.trim()
      ? { mergeTagTrigger: safeMergeTagTrigger.trim() }
      : {}),
    config: effectiveConfig,
    ...(safeTemplateId ? { templateId: safeTemplateId } : {}),
    ...(safeExternalFooterHtml ? { externalFooterHtml: safeExternalFooterHtml } : {}),
    footerInjectionMode: effectiveFooterMode,
  };

  const latestInitRef = useRef<HostToBuilderMessage>({
    type: 'INIT',
    payload: initPayload,
  });

  const expectedOrigin = useMemo(() => {
    try { return propError ? null : deriveAllowedOrigin(resolvedSrc, allowedOrigin); }
    catch { return null; }
  }, [resolvedSrc, allowedOrigin, propError]);
  const originError = !propError && !expectedOrigin
    ? 'EmailBuilder origin configuration is invalid or untrusted.'
    : null;

  const resolveTargetOrigin = useCallback(() => expectedOrigin, [expectedOrigin]);

  const setStatusSafely = useCallback(
    (next: EmailBuilderStatus) => {
      if (statusRef.current === next) {
        return;
      }
      statusRef.current = next;
      setStatus(next);
      void invokeHostCallback(onStatusChangeRef.current, [next]);
    },
    []
  );

  useEffect(() => {
    onAuthErrorRef.current = onAuthError;
  }, [onAuthError]);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const generation = ++validationGenerationRef.current;
    authorizationActiveRef.current = false;
    resetAssetRequests();
    handshakeGenerationRef.current += 1;
    readyRef.current = false;
    initSentRef.current = false;
    queueRef.current = [];
    builderWindowRef.current = null;
    if (handshakeTimerRef.current && typeof window !== 'undefined') {
      window.clearTimeout(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
    }
    setLicenseError(null);
    setIsLicenseValidated(false);

    if (propError || originError) {
      const message = propError || originError || 'EmailBuilder input validation failed.';
      setLicenseError(message);
      if (statusRef.current !== 'error') {
        statusRef.current = 'error';
        setStatus('error');
        void invokeHostCallback(onStatusChangeRef.current, ['error']);
      }
      if (mountedRef.current) void invokeHostCallback(onAuthErrorRef.current, [message]);
      return () => controller.abort();
    }

    setStatusSafely('loading');
    if (!mountedRef.current) {
      controller.abort();
      return () => controller.abort();
    }

    validateMailLayersLicense({
      apiKey,
      apiUrl: licenseValidationUrl,
      signal: controller.signal,
      origin: typeof window !== 'undefined' ? window.location.origin : undefined,
      expectedOrganizationId,
      expectedLicenseId,
    })
      .then(() => {
        if (cancelled || !mountedRef.current || validationGenerationRef.current !== generation) {
          return;
        }
        authorizationActiveRef.current = true;
        setIsLicenseValidated(true);
      })
      .catch((error) => {
        if (cancelled || !mountedRef.current || validationGenerationRef.current !== generation) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : 'MailLayers SDK license validation failed.';
        setLicenseError(message);
        if (statusRef.current !== 'error') {
          statusRef.current = 'error';
          setStatus('error');
        void invokeHostCallback(onStatusChangeRef.current, ['error']);
        }
        if (mountedRef.current) void invokeHostCallback(onAuthErrorRef.current, [message]);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiKey, licenseValidationUrl, expectedOrganizationId, expectedLicenseId, expectedOrigin, propError, originError, resetAssetRequests, setStatusSafely]);

  const postMessage = useCallback(
    (message: HostToBuilderMessage, correlationId?: string) => {
      if (!mountedRef.current || !authorizationActiveRef.current) return;
      const target = iframeRef.current?.contentWindow ?? builderWindowRef.current;
      if (target) {
        builderWindowRef.current = target;
      }

      if (!expectedOrigin || !builderWindowRef.current || !readyRef.current) {
        queueRef.current.push({ message, correlationId });
        return;
      }

      try {
        builderWindowRef.current.postMessage(buildEnvelope(message, correlationId), resolveTargetOrigin()!);
      } catch {
        setStatusSafely('error');
      }
    },
    [resolveTargetOrigin, expectedOrigin, setStatusSafely]
  );

  const flushQueue = useCallback(() => {
    if (!expectedOrigin || !readyRef.current || !builderWindowRef.current) {
      return;
    }
    const pending = [...queueRef.current];
    queueRef.current = [];
    pending.forEach(({ message, correlationId }) => {
      if (!mountedRef.current) return;
      try {
        builderWindowRef.current?.postMessage(
          buildEnvelope(message, correlationId),
          resolveTargetOrigin()!
        );
      } catch {
        setStatusSafely('error');
      }
    });
  }, [resolveTargetOrigin, expectedOrigin, setStatusSafely]);

  const executeAssetRequest = useCallback(async (
    requestKey: string,
    correlationId: string,
    operation: (controller: AbortController) => Promise<HostToBuilderMessage>,
    failure: HostToBuilderMessage,
  ) => {
    const cached = recentAssetResponsesRef.current.get(requestKey);
    if (cached) {
      postMessage(cached, correlationId);
      return;
    }
    if (activeAssetRequestsRef.current.has(requestKey)) return;
    if (activeAssetRequestsRef.current.size >= MAX_CONCURRENT_ASSET_REQUESTS) {
      postMessage(failure, correlationId);
      return;
    }

    const controller = new AbortController();
    const generation = handshakeGenerationRef.current;
    activeAssetRequestsRef.current.set(requestKey, controller);
    let response = failure;
    let requestStillActive = false;
    try {
      response = await operation(controller);
    } catch {
      response = failure;
    } finally {
      requestStillActive = activeAssetRequestsRef.current.get(requestKey) === controller;
      if (requestStillActive) activeAssetRequestsRef.current.delete(requestKey);
    }

    if (!requestStillActive || !mountedRef.current || !authorizationActiveRef.current || handshakeGenerationRef.current !== generation) return;
    recentAssetResponsesRef.current.set(requestKey, response);
    if (recentAssetResponsesRef.current.size > MAX_RECENT_ASSET_REQUESTS) {
      const oldest = recentAssetResponsesRef.current.keys().next().value;
      if (typeof oldest === 'string') recentAssetResponsesRef.current.delete(oldest);
    }
    postMessage(response, correlationId);
  }, [postMessage]);

  const handleReadyMessage = useCallback(() => {
    if (readyRef.current) {
      return;
    }
    if (handshakeTimerRef.current) {
      window.clearTimeout(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
    }
    readyRef.current = true;
    const statusChanged = statusRef.current !== 'ready';
    if (statusChanged) {
      statusRef.current = 'ready';
      setStatus('ready');
    }
    if (!initSentRef.current) {
      postMessage(latestInitRef.current);
      initSentRef.current = true;
    }
    flushQueue();
    if (statusChanged) void invokeHostCallback(onStatusChange, ['ready']);
    if (mountedRef.current) void invokeHostCallback(onReady, []);
  }, [flushQueue, onReady, onStatusChange, postMessage]);

  const handleUpload = useCallback(
    async (eventMessage: BuilderToHostMessage) => {
      if (eventMessage.type !== 'UPLOAD') {
        return;
      }
      const requestId = eventMessage.meta!.id;
      const failure: HostToBuilderMessage = { type: 'UPLOAD_SUCCESS', payload: { url: '' } };
      await executeAssetRequest(`UPLOAD:${requestId}`, requestId, async (controller) => {
        const result = await withTimeout(invokeHostCallback(onUpload, [eventMessage.payload.file, { requestId, signal: controller.signal }]), controller);
        const url = result.ok ? normalizeUploadResult(result.value) : null;
        if (!url) throw new Error('invalid upload result');
        return { type: 'UPLOAD_SUCCESS', payload: { url } };
      }, failure);
    },
    [executeAssetRequest, onUpload]
  );

  const handleListAssets = useCallback(
    async (eventMessage: BuilderToHostMessage) => {
      if (eventMessage.type !== 'LIST_ASSETS') {
        return;
      }
      const requestId = eventMessage.meta!.id;
      const failure: HostToBuilderMessage = { type: 'ASSETS_LIST', payload: { assets: [] } };
      await executeAssetRequest(`LIST_ASSETS:${requestId}`, requestId, async (controller) => {
        const result = await withTimeout(invokeHostCallback(onListAssets, [eventMessage.payload, { requestId, signal: controller.signal }]), controller);
        const assets = result.ok ? normalizeAssetListResult(result.value, eventMessage.payload?.limit) : null;
        if (!assets) throw new Error('invalid asset list');
        return { type: 'ASSETS_LIST', payload: { assets } };
      }, failure);
    },
    [executeAssetRequest, onListAssets]
  );

  const handleDeleteAsset = useCallback(
    async (eventMessage: BuilderToHostMessage) => {
      if (eventMessage.type !== 'DELETE_ASSET') {
        return;
      }
      const requestId = eventMessage.meta!.id;
      const failure: HostToBuilderMessage = { type: 'DELETE_ASSET_SUCCESS', payload: { success: false } };
      await executeAssetRequest(`DELETE_ASSET:${requestId}`, requestId, async (controller) => {
        const result = await withTimeout(invokeHostCallback(onDeleteAsset, [eventMessage.payload, { requestId, signal: controller.signal }]), controller);
        return { type: 'DELETE_ASSET_SUCCESS', payload: { success: result.ok && result.value === true } };
      }, failure);
    },
    [executeAssetRequest, onDeleteAsset]
  );

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (!mountedRef.current || !authorizationActiveRef.current) return;
      const iframeWindow = iframeRef.current?.contentWindow ?? builderWindowRef.current;
      if (!iframeWindow || !expectedOrigin) return;
      const message = sanitizeIncomingMessage(event, expectedOrigin, iframeWindow);
      if (!message) return;

      if (event.source && event.source !== builderWindowRef.current) {
        builderWindowRef.current = event.source as Window;
      }

      switch (message.type) {
        case 'READY':
          handleReadyMessage();
          break;
        case 'CHANGE':
          void invokeHostCallback(onChange, [message.payload.html]);
          break;
        case 'LOADED':
          void invokeHostCallback(onLoad, [message.payload.html]);
          break;
        case 'SAVE':
          void invokeHostCallback(onSave, [message.payload.html]);
          break;
        case 'UPLOAD':
          void handleUpload(message);
          break;
        case 'LIST_ASSETS':
          void handleListAssets(message);
          break;
        case 'DELETE_ASSET':
          void handleDeleteAsset(message);
          break;
        case 'AUTH_ERROR': {
          const msg = message.payload?.message || 'Email builder authentication failed';
          if (statusRef.current !== 'error') {
            setStatusSafely('error');
            if (mountedRef.current) void invokeHostCallback(onAuthError, [msg]);
          }
          break;
        }
        case 'STATUS':
          setStatusSafely(message.payload.status);
          break;
        default:
          break;
      }
    },
    [expectedOrigin, handleReadyMessage, handleUpload, handleListAssets, handleDeleteAsset, onChange, onLoad, onSave, onAuthError, setStatusSafely]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [handleMessage]);

  useEffect(() => {
    const nextPayload: InitPayload = {
      html: effectiveInitialHtml,
      ...(safeMergeTags ? { mergeTags: safeMergeTags } : {}),
      ...(safeMergeTagTrigger?.trim()
        ? { mergeTagTrigger: safeMergeTagTrigger.trim() }
        : {}),
      config: effectiveConfig,
      ...(safeTemplateId ? { templateId: safeTemplateId } : {}),
      ...(safeExternalFooterHtml !== undefined ? { externalFooterHtml: safeExternalFooterHtml } : {}),
      footerInjectionMode: effectiveFooterMode,
    };
    try {
      stableSignature(nextPayload);
    } catch {
      setLicenseError('EmailBuilder input exceeds the serialization limits.');
      setIsLicenseValidated(false);
      return;
    }
    latestInitRef.current = { type: 'INIT', payload: nextPayload };
    // Initial inputs are immutable for the active handshake. Changes are staged
    // in latestInitRef and applied only after an explicit reload/remount.
  }, [
    effectiveConfig,
    effectiveInitialHtml,
    safeMergeTags,
    safeMergeTagTrigger,
    safeTemplateId,
    safeExternalFooterHtml,
    safeFooterInjectionMode,
  ]);

  const handleIframeLoad = useCallback(() => {
    if (!isLicenseValidated) {
      return;
    }
    handshakeGenerationRef.current += 1;
    resetAssetRequests();
    builderWindowRef.current = iframeRef.current?.contentWindow ?? null;
    readyRef.current = false;
    initSentRef.current = false;
    setStatusSafely('loading');

    if (handshakeTimerRef.current) {
      window.clearTimeout(handshakeTimerRef.current);
    }
    if (expectedOrigin && builderWindowRef.current) {
      try {
        builderWindowRef.current.postMessage(buildEnvelope(latestInitRef.current), expectedOrigin);
        initSentRef.current = true;
      } catch {
        setStatusSafely('error');
      }
    }

    handshakeTimerRef.current = window.setTimeout(() => {
      if (readyRef.current) {
        return;
      }
      setStatusSafely('error');
      if (mountedRef.current) void invokeHostCallback(onAuthError, ['Builder handshake failed or authentication was rejected.']);
    }, 12000);
  }, [expectedOrigin, isLicenseValidated, onAuthError, resetAssetRequests, setStatusSafely]);

  useImperativeHandle(
    ref,
    () => ({
      reload() {
        handshakeGenerationRef.current += 1;
        resetAssetRequests();
        queueRef.current = [];
        readyRef.current = false;
        initSentRef.current = false;
        builderWindowRef.current = null;
        if (handshakeTimerRef.current) {
          window.clearTimeout(handshakeTimerRef.current);
          handshakeTimerRef.current = null;
        }
        setStatusSafely('loading');
        setReloadKey((key) => key + 1);
      },
    }),
    [resetAssetRequests, setStatusSafely]
  );

  useEffect(() => {
    return () => {
      if (handshakeTimerRef.current) {
        window.clearTimeout(handshakeTimerRef.current);
        handshakeTimerRef.current = null;
      }
      queueRef.current = [];
      builderWindowRef.current = null;
      readyRef.current = false;
      initSentRef.current = false;
      validationGenerationRef.current += 1;
      handshakeGenerationRef.current += 1;
      authorizationActiveRef.current = false;
      resetAssetRequests();
      mountedRef.current = false;
    };
  }, [resetAssetRequests]);

  return (
    <div className={propError ? undefined : className} style={{ position: 'relative', width: '100%', height: '100%', ...safeStyle }}>
      <iframe
        key={reloadKey}
        ref={iframeRef}
        src={!propError && !originError && isLicenseValidated ? iframeSrc : 'about:blank'}
        title={typeof iframeTitle === 'string' && iframeTitle.trim() ? iframeTitle : 'Email Builder'}
        sandbox={propError ? DEFAULT_SANDBOX : sandbox}
        style={iframeStyle}
        loading="lazy"
        allowFullScreen
        onLoad={handleIframeLoad}
      />
      {!hideLoadingOverlay && status !== 'ready' && (
        <div style={overlayStyle}>
          {propError || originError || licenseError || 'Connecting to builder...'}
        </div>
      )}
    </div>
  );
}

export const EmailBuilder = forwardRef(EmailBuilderInner);
export const MailLayersEmailEditor = EmailBuilder;
