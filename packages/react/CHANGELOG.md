# Changelog

## 0.2.2

- Added imperative `getHtml()` and `getJson()` ref methods for retrieving the
  current hosted editor HTML and structured template JSON
- Separated handshake readiness from export/data-request status so Export, Copy
  HTML, and data retrieval never show the loading overlay or restart READY/INIT
- Added `exportUi` prop (INIT `features.exportUi`) to optionally show the hosted
  Export UI in embedded mode; default remains hidden for SDK embeds
- Replaced `"Connecting to builder..."` with a neutral built-in loading spinner
- Added `loadingFallback` for custom host loading UI and `loadingLabel` for the
  default spinner's accessible label
- Documented standalone versus embedded Export UI and licensing behavior

## 0.2.1

- Removed obsolete `embedToken` setup from documentation and examples
- API key is now the only documented credential
- Existing optional `embedToken` usage remains backward compatible
