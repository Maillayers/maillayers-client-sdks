export interface ValidateMailLayersLicenseOptions {
  apiKey: unknown;
  apiUrl?: string;
  packageName?: string;
  packageVersion?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  origin?: string;
  expectedOrganizationId?: string;
  expectedLicenseId?: string;
}

export interface MailLayersLicenseValidationResponse {
  status: 'valid';
  reason: 'allowed_domain' | 'local_development';
  origin: string;
  domain: string;
  requestId: string;
  keyFingerprint: string;
  organizationId: string;
  licenseId: string;
  plan: string;
}

const DEFAULT_API_URL = 'https://api.maillayers.com';
const DEFAULT_PACKAGE_NAME = '@maillayers/react-email-editor';
const DEFAULT_PACKAGE_VERSION = '0.0.0';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_API_KEY_LENGTH = 256;
const MAX_CONTEXT_ID_LENGTH = 256;
const SUCCESS_RESPONSE_FIELDS = new Set([
  'status',
  'reason',
  'origin',
  'domain',
  'requestId',
  'keyFingerprint',
  'organizationId',
  'licenseId',
  'plan',
]);

function joinApiUrl(apiUrl: unknown): string {
  if (typeof apiUrl !== 'string' || !apiUrl.trim()) {
    throw new Error('MailLayers license validation endpoint is invalid.');
  }
  const parsed = new URL(apiUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('MailLayers license validation endpoint is invalid.');
  }
  if (parsed.search || parsed.hash) throw new Error('MailLayers license validation endpoint is invalid.');
  if (parsed.pathname.replace(/\/+$/, '') === '/api/sdk/license/validate') {
    return `${parsed.origin}/api/sdk/license/validate`;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/api/sdk/license/validate`;
}

function safeErrorMessage(status?: number): string {
  return status ? `MailLayers license validation failed (${status}).` : 'MailLayers license validation failed.';
}

function isNonEmptyString(value: unknown, maxLength = MAX_CONTEXT_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLength && value.trim() === value && value.length > 0;
}

function normalizeOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('MailLayers license validation origin is invalid.');
  }
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== value) {
    throw new Error('MailLayers license validation origin is invalid.');
  }
  return parsed.origin;
}

function normalizeExpectedId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) {
    throw new Error(`MailLayers license validation ${name} is invalid.`);
  }
  return value;
}

function responseDomain(origin: string): string {
  const parsed = new URL(origin);
  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
  return parsed.port ? `${hostname}:${parsed.port}` : hostname;
}

function isValidResponse(
  value: unknown,
  context: {
    requestId: string;
    keyFingerprint: string;
    origin?: string;
    expectedOrganizationId?: string;
    expectedLicenseId?: string;
  },
): value is MailLayersLicenseValidationResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((field) => !SUCCESS_RESPONSE_FIELDS.has(field))) return false;
  if (candidate.status !== 'valid') return false;
  if (candidate.reason !== 'allowed_domain' && candidate.reason !== 'local_development') return false;
  if (!isNonEmptyString(candidate.origin, 2048) || !isNonEmptyString(candidate.domain)) return false;
  let parsedOrigin: URL;
  try { parsedOrigin = new URL(candidate.origin); } catch { return false; }
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== candidate.origin) return false;
  if (candidate.domain !== responseDomain(candidate.origin)) return false;
  if (context.origin && candidate.origin !== context.origin) return false;
  if (candidate.requestId !== context.requestId || candidate.keyFingerprint !== context.keyFingerprint) return false;
  if (!/^[a-f0-9]{64}$/.test(candidate.keyFingerprint as string)) return false;
  for (const field of ['organizationId', 'licenseId', 'plan']) {
    if (!isNonEmptyString(candidate[field])) return false;
  }
  if (context.expectedOrganizationId && candidate.organizationId !== context.expectedOrganizationId) return false;
  if (context.expectedLicenseId && candidate.licenseId !== context.expectedLicenseId) return false;
  return true;
}

function parseResponse(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validateApiKey(apiKey: unknown): string {
  if (typeof apiKey !== 'string') throw new Error('MailLayers license validation failed: apiKey is required.');
  const trimmed = apiKey.trim();
  if (!trimmed || trimmed.length > MAX_API_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('MailLayers license validation failed: apiKey is invalid.');
  }
  return trimmed;
}

async function fingerprint(apiKey: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('MailLayers license validation is unavailable in this environment.');
}

export async function validateMailLayersLicense(options: ValidateMailLayersLicenseOptions): Promise<MailLayersLicenseValidationResponse> {
  const apiKey = validateApiKey(options?.apiKey);
  const endpoint = joinApiUrl(options?.apiUrl ?? DEFAULT_API_URL);
  const requestedOrigin = normalizeOrigin(options?.origin ?? (typeof window !== 'undefined' ? window.location.origin : undefined));
  const expectedOrganizationId = normalizeExpectedId(options?.expectedOrganizationId, 'expectedOrganizationId');
  const expectedLicenseId = normalizeExpectedId(options?.expectedLicenseId, 'expectedLicenseId');
  const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  const keyFingerprint = await fingerprint(apiKey);
  const requestedTimeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(requestedTimeout, 60_000))
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abortCaller = () => { callerAborted = true; controller.abort(); };
  options?.signal?.addEventListener('abort', abortCaller, { once: true });
  if (options?.signal?.aborted) abortCaller();

  try {
    // Strict Mode may clean up an effect while the key fingerprint is still
    // being calculated. Do not start a fetch after that cancellation.
    if (callerAborted || controller.signal.aborted) {
      throw new Error('MailLayers license validation timed out or was cancelled.');
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        packageName: options?.packageName ?? DEFAULT_PACKAGE_NAME,
        packageVersion: options?.packageVersion ?? DEFAULT_PACKAGE_VERSION,
        origin: requestedOrigin,
        requestId,
      }),
    });
    if (response.url && new URL(response.url).origin !== new URL(endpoint).origin) {
      throw new Error('MailLayers license validation failed: invalid response origin.');
    }
    const contentType = response.headers?.get?.('content-type');
    const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) {
      throw new Error('MailLayers license validation failed: invalid response content type.');
    }
    const body = parseResponse(await response.text());
    if (!response.ok) throw new Error(safeErrorMessage(response.status));
    if (!isValidResponse(body, { requestId, keyFingerprint, origin: requestedOrigin, expectedOrganizationId, expectedLicenseId })) {
      throw new Error('MailLayers license validation failed: invalid authorization response.');
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MailLayers license validation failed')) throw error;
    if (timedOut || callerAborted || controller.signal.aborted) {
      throw new Error('MailLayers license validation timed out or was cancelled.');
    }
    throw new Error('MailLayers license validation failed.');
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', abortCaller);
  }
}
