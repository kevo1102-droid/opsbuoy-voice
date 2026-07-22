# CLAUDE.md — OpsBuoy Voice

## What this is

A private voice notes PWA. Records audio, transcribes on-device with Whisper WASM, stores everything in IndexedDB on the user's phone. No backend, no account, no upload. Ships to `voice.opsbuoy.com` on Vercel hobby.

## Stack

- Vanilla JS ES modules (no build step, no npm)
- IndexedDB for storage (audio blobs + transcripts)
- MediaRecorder API for capture
- `@huggingface/transformers` v3 (Whisper WASM) loaded from jsdelivr CDN
- Model weights (Xenova/whisper-*.en) fetched from HuggingFace CDN, cached in browser
- Service worker caches app shell for offline shell load
- Vercel static hosting

## Files

- `index.html` — single page, three view sections toggled by JS
- `css/app.css` — full styles, uses OpsBuoy design tokens
- `js/app.js` — controller (routing, list/detail/record flows, settings)
- `js/db.js` — IndexedDB wrapper
- `js/recorder.js` — MediaRecorder + AudioContext analyser for viz
- `js/transcribe.js` — Whisper WASM pipeline wrapper
- `sw.js` — service worker (app shell caching only)
- `manifest.json` — PWA manifest
- `vercel.json` — headers + CSP
- `icons/` — SVG source + generated 192/512 PNGs

## Tech debt / known compromises (v1)

1. **transformers.js loaded from jsdelivr CDN.** Violates the "bundle deps locally" rule, but the library has WASM/worker sub-imports that make vendoring finicky. Revisit if we want stricter supply-chain control.
2. **Model weights from HuggingFace CDN.** First-time transcription requires internet. After that, model is cached in origin. Consider self-hosting weights on Vercel if HF availability becomes a concern.
3. **No COOP/COEP.** Skips multi-threaded WASM (SharedArrayBuffer). Transcription is single-threaded — slower but works everywhere without CORP-tainting third-party fetches.
4. **No live transcription.** Whisper WASM processes audio after stop, not during. UX pattern matches Plaud/Otter, not live dictation.
5. **iOS Safari mic recording quirks.** MediaRecorder support arrived recently; test on real iOS before promoting.

## Local dev

```
cd ~/projects/opsbuoy-voice
python3 -m http.server 8000
# open http://localhost:8000
```

Mic requires `https://` OR `http://localhost` — file:// won't work.

## Deploy

Uses standard OpsBuoy Vercel pattern. See the "pre ship checklist" memory before pushing.

## Security notes

- CSP allows jsdelivr (transformers.js) + HuggingFace CDN (weights). If we drop CDN, tighten.
- Mic permission scoped via `Permissions-Policy: microphone=(self)`.
- All user data stays in IndexedDB on-device. No `fetch()` sends audio or transcripts anywhere.
- Verified: `grep -r "fetch\|XMLHttpRequest" js/` should show zero calls that transmit user data.
