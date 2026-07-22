# OpsBuoy Voice

Private voice notes with on-device transcription. Nothing leaves your phone.

- Record with one tap
- Transcribed on-device via Whisper WASM
- Notes stored in browser IndexedDB
- Export as `.md` or download original audio
- Works offline after first model download
- No account, no backend, no upload

## Stack

Vanilla JS PWA, `@huggingface/transformers` for Whisper WASM, IndexedDB for storage, deployed on Vercel.

## Dev

```
python3 -m http.server 8000
# open http://localhost:8000
```

See `CLAUDE.md` for architecture and known compromises.
See `SECURITY.md` for the threat model.
