// Whisper WASM transcription via @huggingface/transformers.
// Library + ORT WASM are vendored under /lib/ (same-origin) so we don't
// depend on jsdelivr at runtime. Model weights are still fetched from
// HuggingFace and cached in the browser after first download; those are
// inert inference data, not executable code.

const TRANSFORMERS_URL = '/lib/transformers.min.mjs';

let _lib = null;
let _pipelines = new Map();

async function lib() {
  if (_lib) return _lib;
  _lib = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  _lib.env.allowLocalModels = false;
  _lib.env.useBrowserCache = true;
  // Point ORT at the vendored WASM binary + loader so nothing runtime-fetches
  // from jsdelivr.
  _lib.env.backends.onnx.wasm.wasmPaths = '/lib/';
  return _lib;
}

export async function getModelName() {
  return localStorage.getItem('opsbuoy-voice.model') || 'Xenova/whisper-tiny.en';
}

export async function setModelName(name) {
  localStorage.setItem('opsbuoy-voice.model', name);
  _pipelines.delete(name);
}

async function getPipeline(modelName, onProgress) {
  if (_pipelines.has(modelName)) return _pipelines.get(modelName);
  const { pipeline } = await lib();
  const p = pipeline('automatic-speech-recognition', modelName, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (data) => {
      // Log everything for debugging — the callback fires with several event shapes.
      try { console.log('[whisper]', data); } catch {}
      if (!onProgress) return;
      const file = data.file || data.name || '';
      const status = data.status;
      if (status === 'progress' && typeof data.progress === 'number') {
        onProgress({ stage: 'download', pct: data.progress, file, message: `Downloading ${file}… ${Math.round(data.progress)}%` });
      } else if (status === 'ready' || status === 'done') {
        onProgress({ stage: 'ready', pct: 100, message: 'Ready' });
      } else if (status === 'initiate') {
        onProgress({ stage: 'download', pct: 0, file, message: `Starting ${file || 'download'}…` });
      } else if (status === 'download') {
        onProgress({ stage: 'download', pct: 0, file, message: `Fetching ${file || 'model'}…` });
      }
    },
  });
  _pipelines.set(modelName, p);
  return p;
}

export async function preloadModel(onProgress) {
  const modelName = await getModelName();
  await getPipeline(modelName, onProgress);
}

async function blobToFloat32(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 16000 });
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    // Downmix to mono if needed and resample to 16k (AudioContext will resample on decode).
    let channelData;
    if (audioBuffer.numberOfChannels === 1) {
      channelData = audioBuffer.getChannelData(0);
    } else {
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      channelData = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) channelData[i] = (left[i] + right[i]) / 2;
    }
    return channelData;
  } finally {
    ctx.close().catch(() => {});
  }
}

export async function transcribe(blob, onProgress) {
  const modelName = await getModelName();
  onProgress?.({ stage: 'model', pct: 0, message: 'Loading model…' });
  const transcriber = await getPipeline(modelName, (p) => {
    if (p.stage === 'download') onProgress?.({ stage: 'model', pct: p.pct, message: 'Downloading model…' });
  });
  onProgress?.({ stage: 'decode', pct: 30, message: 'Decoding audio…' });
  const audio = await blobToFloat32(blob);
  onProgress?.({ stage: 'transcribe', pct: 50, message: 'Transcribing…' });
  const result = await transcriber(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  });
  onProgress?.({ stage: 'done', pct: 100, message: 'Done' });
  return (result?.text || '').trim();
}
