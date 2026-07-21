# @maillayers/react-email-editor

React SDK for embedding the MailLayers email editor in your app.

## Install

```bash
npm install @maillayers/react-email-editor
```

## Quick Start

```tsx
import { MailLayersEmailEditor } from '@maillayers/react-email-editor';

export function EmailEditor() {
  return (
    <div style={{ height: '100vh' }}>
      <MailLayersEmailEditor
        apiKey={process.env.NEXT_PUBLIC_MAILLAYERS_API_KEY}
        embedToken={process.env.NEXT_PUBLIC_EMAIL_BUILDER_TOKEN}
        initialHtml="<h1>Welcome</h1><p>Edit this email template</p>"
        themeMode="system"
        theme={{
          tenantId: "acme",
          light: {
            primary: "220 90% 56%",
            secondary: "220 12% 45%",
            accent: "188 94% 43%",
            success: "142 72% 36%",
            warning: "35 92% 50%",
            error: "0 84% 60%",
            background: "0 0% 100%",
            surface: "0 0% 100%",
            border: "220 14% 90%",
            text: "222 84% 5%",
          },
          dark: {
            primary: "220 90% 70%",
            secondary: "220 10% 70%",
            accent: "188 80% 62%",
            success: "142 70% 50%",
            warning: "40 96% 62%",
            error: "0 80% 68%",
            background: "222 47% 11%",
            surface: "222 39% 14%",
            border: "217 19% 27%",
            text: "210 40% 96%",
          },
        }}
        footerInjectionMode="sdk"
        externalFooterHtml="<div>Custom footer</div>"
        onAuthError={(message) => console.error('auth failed', message)}
        onChange={(html) => console.log('changed', html)}
        onSave={(html) => console.log('saved', html)}
        onUpload={async (file) => {
          const body = new FormData();
          body.append('asset', file);
          const response = await fetch('/api/uploads', { method: 'POST', body });
          const data = await response.json();
          return data.url;
        }}
        onListAssets={async () => {
          const response = await fetch('/api/assets');
          const data = await response.json();
          return data.assets;
        }}
        onDeleteAsset={async ({ id }) => {
          if (!id) return false;
          const response = await fetch(`/api/assets/${id}`, { method: 'DELETE' });
          return response.ok;
        }}
      />
    </div>
  );
}
```

If `initialHtml` is not provided, the editor starts with a default Hello World template.
If `src` is not provided, the SDK uses the managed MailLayers builder endpoint.

## Props

| Prop | Type | Required | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | Yes | MailLayers SDK API key used to validate licensed usage. |
| `licenseValidationUrl` | `string` | No | Optional validation API base URL or exact validation endpoint for authorized self-hosted/test environments. |
| `embedToken` | `string` | Yes | Token passed to iframe for backend verification. |
| `src` | `string` | No | Optional trusted custom builder URL. HTTPS is required except on loopback development hosts. |
| `initialHtml` | `string` | No | Initial HTML content to load in the editor. |
| `templateId` | `string` | No | Optional template id; builder fetches HTML from backend when provided. |
| `externalFooterHtml` | `string` | No | Optional host-provided footer HTML snippet. |
| `footerInjectionMode` | `'default' \| 'sdk'` | No | Footer source mode. Use `'sdk'` to apply `externalFooterHtml`. |
| `theme` | `ThemeDefinition` | No | Runtime tenant theme with `light` and `dark` token sets. |
| `themeMode` | `'light' \| 'dark' \| 'system'` | No | Active theme mode for runtime rendering. |
| `tenantId` | `string` | No | Optional tenant id used for theme scoping metadata. |
| `config` | `Record<string, unknown>` | No | Optional builder configuration object. |
| `className` | `string` | No | Class for the wrapper container. |
| `style` | `React.CSSProperties` | No | Inline styles for the wrapper container. |
| `iframeTitle` | `string` | No | Accessible title for the iframe. |
| `sandbox` | `string` | No | Custom iframe sandbox value. |
| `allowedOrigin` | `string` | No | Optional origin assertion. Must contain only an absolute origin and exactly match the canonical `src` origin. |
| `onReady` | `() => void` | No | Called when editor is ready. |
| `onStatusChange` | `(status) => void` | No | Called on status changes (`loading`, `ready`, `error`). |
| `onChange` | `(html: string) => void` | No | Called when editor content changes. |
| `onSave` | `(html: string) => void` | No | Called when user saves content. |
| `onUpload` | `(file: File, context: AssetRequestContext) => Promise<string>` | No | Upload handler that returns an absolute public HTTPS URL. |
| `onListAssets` | `(payload: { limit?: number } \| undefined, context: AssetRequestContext) => Promise<AssetItem[]>` | No | Returns a bounded, strictly validated image list. |
| `onDeleteAsset` | `(payload: { id?: string; url?: string }, context: AssetRequestContext) => Promise<boolean>` | No | Deletes an asset; only literal `true` reports success. |
| `onAuthError` | `(message: string) => void` | No | Called when token is missing/invalid/rejected. |

`AssetItem` shape:

```ts
type AssetItem = {
  id: string;
  url: string;
  name?: string;
  thumbnailUrl?: string;
  mimeType?: 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/svg+xml' | 'image/webp';
};

type AssetRequestContext = {
  requestId: string;
  signal: AbortSignal;
};
```

## Asset callback security and lifecycle

Asset and thumbnail URLs must be absolute HTTPS URLs. Relative URLs, HTTP/mixed
content, credentials, `javascript:`, `vbscript:`, `data:`, and unsupported schemes
fail closed. List results may contain at most 100 exact-shape items (and may not
exceed the remote request's lower limit). Every item requires a unique non-empty
`id` and unique HTTPS `url`; optional MIME types are limited to the image formats
shown above. Unknown fields, accessors, proxies, oversized metadata, invalid
thumbnails, duplicates, and malformed items cause a correlated empty-list failure
rather than passing arbitrary values to the editor.

UPLOAD, LIST_ASSETS, and DELETE_ASSET require protocol request IDs. Missing
callbacks, invalid results, exceptions, and timeouts receive correlated failure
responses. Duplicate IDs are invoked once while active and replay a bounded recent
result after completion. At most four asset callbacks run concurrently. The
optional callback context exposes the request ID and an AbortSignal that fires on
timeout, reload, authorization-context changes, or unmount. Late results are
ignored after cancellation. Only literal boolean `true` is a successful delete.

## Custom editor origin trust model

The managed default is `https://editor.maillayers.com`. A host may intentionally
use a custom editor through `src`, but the SDK treats that origin as fully trusted
to receive editor initialization data and asset responses.

- Custom production editors must use HTTPS.
- HTTP is accepted only for `localhost`, `127.0.0.1`, `[::1]`, and `0.0.0.0` local
  development origins.
- URL credentials and trailing-dot hostnames are rejected.
- Paths, queries, and fragments may be present in `src`, but never affect the
  trusted origin.
- If `allowedOrigin` is provided, it must be an origin-only URL and exactly match
  the canonical origin derived from `src`.
- Redirecting the iframe to another origin does not transfer trust; messages from
  the redirected origin are rejected and outbound messages remain targeted to the
  configured origin.

Invalid origin configuration leaves the iframe at `about:blank` and no protocol
payload is sent.

## Image Management Contract

To support reusable image uploads for any client app:

- implement `onUpload` to upload a file and return a public URL
- implement `onListAssets` to return uploaded images
- implement `onDeleteAsset` to delete uploaded images from your backend/storage

The SDK stays storage-agnostic (S3, GCS, Cloudflare R2, etc.).

## Ref API

`MailLayersEmailEditor` supports a ref with:

- `reload(): void` - Starts a new iframe handshake using the latest validated
  initial-content/config props.

Initial-content props (`initialHtml`, merge tags, config, template/footer, and theme
inputs) are immutable for an active iframe handshake. Changing them after READY
does not send another INIT or overwrite remote edits. The latest validated values
are staged and applied by an explicit `reload()` or by remounting the component.

Changing `apiKey`, expected organization/license context, or
`licenseValidationUrl` cancels the prior validation, locks the iframe, and starts a
new validation generation. Validation success is never shared between different
keys, origins, organizations, licenses, or endpoints.

`EmailBuilder` remains exported as a backwards-compatible alias.

## Package entrypoints and publication build

The root package exports the React editor. License-only consumers should use the
dedicated entrypoint, which excludes React, iframe/editor code, and the managed
editor URL from its ESM and CommonJS dependency graphs:

```ts
import { validateMailLayersLicense } from '@maillayers/react-email-editor/license';
```

`npm run build:publish` creates the release artifacts. The publication profile
emits only the public root and license entrypoints, produces ESM, CommonJS, and
declarations, injects only the package version string, and explicitly disables
source maps and embedded source content. The package has no runtime dependency
graph; React and ReactDOM remain peer dependencies.

`npm test` is fully local and deterministic. It uses synthetic fixtures and does
not require production access, browser login, customer data, or live credentials.
The opt-in live endpoint and license checks remain separate commands.

The automated suite is organized around three release boundaries:

- Unit coverage validates license parsing, props, origins, protocol schemas,
  sanitized errors, assets, serialization, and resource limits.
- Mounted React coverage validates Strict Mode, mount/unmount and key changes,
  stale work, callback failures, exact-once READY/INIT behavior, multiple editors,
  malformed traffic, late assets, and cleanup.
- Package-consumer coverage builds and installs a real temporary tarball, then
  checks ESM, CommonJS, SSR-safe imports, React 18 and 19, declarations, inventory,
  LICENSE, disclosure scans, and license-entrypoint tree shaking.

Real-browser behavior is a separate integration boundary. Origin/navigation,
strict CSP, mobile sizing, keyboard/focus, console, remote-editor HTML, storage,
and service-worker isolation must remain reported as blocked unless a supported
browser runtime is actually available and those checks execute.

## Requirements

- React `>=18.2.0`
- ReactDOM `>=18.2.0`

## License Validation Test

Run the direct SDK license validation test against the built package:

```bash
MAILLAYERS_API_KEY=<key> MAILLAYERS_TEST_ORIGIN=https://editor.maillayers.com npm run test:license
```

- `MAILLAYERS_API_KEY` is required for this local test.
- `MAILLAYERS_TEST_ORIGIN` is optional and only used by the Node test script to simulate a browser origin.

## License

MIT
