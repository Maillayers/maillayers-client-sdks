import type { BuilderToHostMessage, HostToBuilderMessage, MessageMeta } from './protocol';
import { createMessageMeta, isMessageLike } from './protocol';
import { safeStableSerialize } from './runtime-validation';

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '0.0.0.0';
}

function parseTrustedHttpUrl(value: unknown, label: 'src' | 'allowedOrigin'): URL {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`EmailBuilder \`${label}\` must be a non-empty absolute URL`);
  }
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`EmailBuilder \`${label}\` must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null' || parsed.username || parsed.password) {
    throw new Error(`EmailBuilder \`${label}\` must use a trusted HTTP(S) origin`);
  }
  if (parsed.hostname.endsWith('.')) {
    throw new Error(`EmailBuilder \`${label}\` must not use a trailing-dot hostname`);
  }
  if (parsed.protocol !== 'https:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`EmailBuilder \`${label}\` must use HTTPS outside local development`);
  }
  if (label === 'allowedOrigin' && trimmed !== parsed.origin) {
    throw new Error('EmailBuilder `allowedOrigin` must contain an origin only');
  }
  return parsed;
}

export function deriveAllowedOrigin(src: string, override?: string): string {
  const srcUrl = parseTrustedHttpUrl(src, 'src');
  if (override !== undefined) {
    const overrideUrl = parseTrustedHttpUrl(override, 'allowedOrigin');
    if (overrideUrl.origin !== srcUrl.origin) {
      throw new Error('EmailBuilder `allowedOrigin` must exactly match the `src` origin');
    }
  }
  return srcUrl.origin;
}

export function buildEnvelope<T extends HostToBuilderMessage>(message: T, correlationId?: string): T {
  const meta: MessageMeta = createMessageMeta(correlationId);
  return { ...message, meta } as T;
}

export function sanitizeIncomingMessage(
  event: MessageEvent,
  allowedOrigin: string,
  iframeWindow: Window | null
): BuilderToHostMessage | null {
  if (event.origin !== allowedOrigin) {
    return null;
  }

  if (!iframeWindow || event.source !== iframeWindow) {
    return null;
  }

  if (!isMessageLike(event.data)) {
    return null;
  }

  return event.data as BuilderToHostMessage;
}

export function stableSignature(value: unknown): string {
  return safeStableSerialize(value);
}
