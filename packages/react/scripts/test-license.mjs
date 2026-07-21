import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateMailLayersLicense } from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const packageJson = JSON.parse(
  await readFile(resolve(rootDir, 'package.json'), 'utf8')
);

const apiKey = process.env.MAILLAYERS_API_KEY;
const testOrigin = process.env.MAILLAYERS_TEST_ORIGIN;

if (!apiKey?.trim()) {
  console.error('MAILLAYERS_API_KEY is required to test license validation.');
  process.exit(1);
}

let restoreFetch;

if (testOrigin?.trim() && typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };
  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', testOrigin.trim());
    return originalFetch(input, {
      ...init,
      headers,
    });
  };
}

try {
  const result = await validateMailLayersLicense({
    apiKey,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  restoreFetch?.();
}
