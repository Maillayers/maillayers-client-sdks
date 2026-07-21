# Contributing

Thanks for helping improve MailLayers client SDKs.

## Development

```bash
npm ci
npm run lint -w @maillayers/react-email-editor
npm run typecheck -w @maillayers/react-email-editor
npm test -w @maillayers/react-email-editor
npm run build:publish -w @maillayers/react-email-editor
```

Keep changes scoped to public client SDK code. Do not add private product code, deployment configuration, customer data, credentials, environment files, generated tarballs, or the proprietary MailLayers editor implementation.

## Pull Requests

- Include a clear description and test results.
- Keep public APIs backward compatible unless a breaking change is intentional and documented.
- Add or update deterministic tests for behavior changes.
- Do not include secrets, customer content, private URLs, or confidential vulnerability details.

Security issues must be reported privately using `SECURITY.md`.
