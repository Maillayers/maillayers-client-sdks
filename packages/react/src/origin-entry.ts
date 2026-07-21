// Internal deterministic-test entrypoint. Not exposed through package exports.
export { deriveAllowedOrigin, sanitizeIncomingMessage } from './utils';
export { DEFAULT_BUILDER_SRC } from './constants';
export { SDK_INPUT_LIMITS, safeStableSerialize, validateEmailBuilderInputs } from './runtime-validation';
export { invokeHostCallback } from './callbacks';
export { normalizeAssetUrl, normalizeUploadResult, normalizeAssetListResult } from './assets';
