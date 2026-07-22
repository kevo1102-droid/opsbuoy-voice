# Security — OpsBuoy Voice

## Reporting

Email `ops@opsbuoy.com` with `[SECURITY]` in the subject. Please don't file public issues for vulnerabilities.

## Threat model

OpsBuoy Voice is a client-only PWA. There is no backend, no user account, and no server-side storage. Audio and transcripts live only in the user's browser (IndexedDB).

### What we protect against

- **Data exfiltration.** No code path uploads audio or transcript to any server. CSP `connect-src` is limited to the app origin, jsdelivr (transformers.js library), and HuggingFace (model weights). Both third parties only serve read-only static assets.
- **Cross-site attack.** Strict CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`.
- **Mic hijacking by embedded content.** `Permissions-Policy: microphone=(self)` prevents cross-origin frames from requesting mic.
- **Supply chain.** transformers.js is pinned to a specific version in `js/transcribe.js`. Update deliberately.

### What we do NOT protect against

- **Device compromise.** If the user's phone is unlocked and accessible, so is their notes DB. IndexedDB is not encrypted by us.
- **Browser vulnerabilities.** We rely on browser sandboxing.
- **User-driven export.** Once a user hits "Copy" or "Download", the data leaves the app under their control.

## Deps

- `@huggingface/transformers@3.0.2` (CDN) — Apache 2.0
- Whisper model weights from `Xenova/whisper-*.en` on HuggingFace — MIT

## Pre-ship checklist

Run through the OpsBuoy "pre ship checklist" memory before every deploy.
