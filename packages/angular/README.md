# @maillayers/angular-email-editor

Angular SDK for embedding the hosted [MailLayers](https://maillayers.com) email editor.

The package loads `https://editor.maillayers.com` inside a secured iframe and speaks the same exact-origin message protocol as `@maillayers/react-email-editor`. It does **not** include the private in-process editor.

## Install

```bash
npm install @maillayers/angular-email-editor
```

Peer dependencies: `@angular/core` and `@angular/common` for Angular 18–20.

## Usage

```ts
import { MailLayersEmailEditorComponent } from '@maillayers/angular-email-editor';

@Component({
  standalone: true,
  imports: [MailLayersEmailEditorComponent],
  template: `
    <maillayers-email-editor
      [apiKey]="apiKey"
      [initialHtml]="html"
      (change)="onChange($event)"
      (save)="onSave($event)"
      (ready)="onReady()"
      (authError)="onAuthError($event)"
    />
  `,
})
export class EditorHostComponent {
  apiKey = 'ml_live_...';
  html = '<p>Hello</p>';
  onChange(html: string) {}
  onSave(html: string) {}
  onReady() {}
  onAuthError(message: string) {}
}
```

Module-based apps can import `MailLayersEmailEditorModule`.

## API

Inputs mirror the React/Vue SDK. Outputs: `change`, `load`, `save`, `ready`, `statusChange`, `authError`.

Public method: `reload()`.

Content inputs are staged and applied on mount / `reload()` only. Zoneless compatible — the shared controller owns the iframe DOM.

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
