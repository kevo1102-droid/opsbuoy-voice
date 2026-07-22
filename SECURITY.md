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

**Vendored (served from our own origin under `/lib/`):**
- `@huggingface/transformers@3.0.2` — Apache 2.0 — `lib/transformers.min.mjs`
- `onnxruntime-web@1.20.x` WASM binary — MIT — `lib/ort-wasm-simd-threaded.wasm` + `.mjs` loader
- `@mlc-ai/web-llm@0.2.79` — Apache 2.0 — `lib/web-llm.js`

**Runtime-fetched from HuggingFace CDN (cached in browser after first download):**
- Whisper model weights from `Xenova/whisper-*.en` — MIT
- Llama-3.2-1B-Instruct model weights from `mlc-ai/` — Llama community license
- MLC WebLLM WASM shim libraries from `mlc-ai/web-llm-libs`

Model weights are inert inference data — a compromised model can only produce
misleading outputs, it cannot execute code, fetch data, or exfiltrate anything.
Library JS + WASM are the executable pieces and are vendored on our origin so
that a CDN compromise cannot alter them.

**CSP for third-party origins:** Only `huggingface.co`, `raw.githubusercontent.com`
(WebLLM WASM shims), `api.anthropic.com`, and `api.openai.com` (BYO summarization
keys) are allowed for `connect-src`. Everything script/worker executable is
`'self'`.

## Pre-ship checklist

Run through the OpsBuoy "pre ship checklist" memory before every deploy.
