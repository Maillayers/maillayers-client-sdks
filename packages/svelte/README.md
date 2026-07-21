# @maillayers/svelte-email-editor

Svelte SDK for embedding the hosted [MailLayers](https://maillayers.com) email editor.

The package loads `https://editor.maillayers.com` inside a secured iframe and speaks the same exact-origin message protocol as `@maillayers/react-email-editor`. It does **not** include the private in-process editor.

## Install

```bash
npm install @maillayers/svelte-email-editor
```

Peer dependency: `svelte` ≥ 4.

## Usage

```svelte
<script lang="ts">
  import { MailLayersEmailEditor } from '@maillayers/svelte-email-editor';
  let editor: MailLayersEmailEditor;
</script>

<MailLayersEmailEditor
  bind:this={editor}
  apiKey="ml_live_..."
  initialHtml="<p>Hello</p>"
  on:change={(event) => console.log(event.detail)}
  on:save={(event) => console.log('save', event.detail)}
  on:ready={() => console.log('ready')}
  on:authError={(event) => console.error(event.detail)}
/>
```

## Props

Matches the React/Vue SDK surface: `apiKey`, `src`, `allowedOrigin`, `initialHtml`, `theme`, `mergeTags`, `config`, footer options, asset callbacks (`upload`, `listAssets`, `deleteAsset`), license bindings, and iframe presentation props.

Content props are staged and applied on mount / `reload()` only.

## Events

`change`, `load`, `save`, `ready`, `statusChange`, `authError`

## Instance methods

- `reload()` — starts a new handshake with the latest staged content props

## Security

- Fail-closed license validation
- Exact iframe origin and window enforcement
- No `postMessage` wildcard targets
- Strict runtime message schemas and bounded inputs
- No raw API keys in errors
- Exact-once READY/INIT lifecycle
- No posts after destroy

## License

MIT
