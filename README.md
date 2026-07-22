# MailLayers Client SDKs

Public client SDKs for embedding the hosted MailLayers email editor in web applications.

## Packages

| Package | Status | Description |
| --- | --- | --- |
| `@maillayers/react-email-editor` | Release candidate | React 18/19 SDK for the hosted editor |

Angular and Vue client SDKs are planned, but they are not published from this repository yet.

## Architecture

The React SDK embeds the hosted MailLayers editor in an iframe. Your application keeps control of authentication, template persistence, and asset storage through explicit callbacks. The SDK validates the configured editor origin, validates the MailLayers API key against the license endpoint, and only accepts protocol messages from the trusted editor origin.

This repository intentionally does not contain the proprietary in-process MailLayers editor implementation.

## Install

```bash
npm install @maillayers/react-email-editor react react-dom
```

## React Usage

```tsx
import { MailLayersEmailEditor } from "@maillayers/react-email-editor";

export function Editor() {
  return (
    <div style={{ height: "100vh" }}>
      <MailLayersEmailEditor
        apiKey={process.env.NEXT_PUBLIC_MAILLAYERS_API_KEY}
        initialHtml="<h1>Hello from MailLayers</h1>"
        onSave={async (html) => {
          await fetch("/api/templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ html }),
          });
        }}
      />
    </div>
  );
}
```

## Next.js Usage

Use the component from a client component:

```tsx
"use client";

import { MailLayersEmailEditor } from "@maillayers/react-email-editor";

export default function EditorPage() {
  return (
    <main style={{ height: "100vh" }}>
      <MailLayersEmailEditor apiKey={process.env.NEXT_PUBLIC_MAILLAYERS_API_KEY} />
    </main>
  );
}
```

## API Keys and Allowed Domains

`apiKey` is the only required MailLayers credential. Production usage requires a MailLayers API key whose allowed domains include the application origin. Browser exposure of this SDK API key is expected; security is enforced through API-key status and allowed-origin validation. Do not place unrelated backend secrets in client environment variables. Local development origins such as `localhost`, `127.0.0.1`, and `[::1]` are supported for development flows.

## Asset Callbacks

The SDK is storage agnostic. Implement `onUpload`, `onListAssets`, and `onDeleteAsset` to connect the hosted editor to your backend or asset store. Asset URLs must be absolute HTTPS URLs and are validated before they are sent to the editor.

## Security Boundary

The hosted editor origin is trusted to receive initialization data and callback responses. Custom editor URLs must use HTTPS in production, may not include credentials, and can be constrained with `allowedOrigin`. Vulnerabilities should be reported privately using `SECURITY.md`, not public issues.

## Links

- Documentation: https://docs.maillayers.com/react
- Issues: https://github.com/Maillayers/maillayers-client-sdks/issues
- Security: https://github.com/Maillayers/maillayers-client-sdks/security/advisories/new

## License

MIT
