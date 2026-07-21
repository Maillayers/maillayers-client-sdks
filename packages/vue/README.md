# @maillayers/vue-email-editor

Vue 3 SDK for embedding the hosted [MailLayers](https://maillayers.com) email editor.

The package loads `https://editor.maillayers.com` inside a secured iframe and speaks the same exact-origin message protocol as `@maillayers/react-email-editor`. It does **not** include the private in-process editor.

## Install

```bash
npm install @maillayers/vue-email-editor
```

Peer dependency: `vue` ≥ 3.4.

## Usage

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { MailLayersEmailEditor, type MailLayersEmailEditorInstance } from '@maillayers/vue-email-editor';

const editor = ref<MailLayersEmailEditorInstance | null>(null);
</script>

<template>
  <MailLayersEmailEditor
    ref="editor"
    api-key="ml_live_..."
    :initial-html="'<p>Hello</p>'"
    @change="(html) => console.log(html)"
    @save="(html) => console.log('save', html)"
    @ready="() => console.log('ready')"
    @auth-error="(message) => console.error(message)"
  />
</template>
```

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `apiKey` | `string` | Required for license validation |
| `licenseValidationUrl` | `string` | Optional API base or exact validate URL |
| `expectedOrganizationId` / `expectedLicenseId` | `string` | Optional fail-closed bindings |
| `src` / `allowedOrigin` | `string` | Defaults to the managed editor; origin must match `src` |
| `initialHtml` / `templateId` / `mergeTags` / `theme` / `themeMode` / `config` / `tenantId` / footer options | various | Staged content; applied on mount and `reload()` only |
| `upload` / `listAssets` / `deleteAsset` | functions | Host-owned asset callbacks |
| `iframeTitle` / `sandbox` / `hideLoadingOverlay` | various | Iframe presentation |

## Events

`change`, `load`, `save`, `ready`, `status-change`, `auth-error`

## Instance methods

- `reload()` — starts a new handshake with the latest staged content props

## Security

- Fail-closed license validation
- Exact iframe origin and window enforcement
- No `postMessage` wildcard targets
- Strict runtime message schemas and bounded inputs
- No raw API keys in errors
- Exact-once READY/INIT lifecycle
- No posts after unmount

## License

MIT
