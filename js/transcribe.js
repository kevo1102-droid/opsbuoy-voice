// Whisper WASM transcription via @huggingface/transformers.
// Loaded from CDN (jsdelivr). Model weights fetched from HuggingFace and cached
// by the browser (Cache API) after first download. All inference is on-device.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

let _lib = null;
let _pipelines = new Map();

async function lib() {
  if (_lib) return _lib;
  _lib = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  _lib.env.allowLocalModels = false;
  _lib.env.useBrowserCache = true;
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
      if (!onProgress) return;
      if (data.status === 'progress' && typeof data.progress === 'number') {
        onProgress({ stage: 'download', pct: data.progress, file: data.file });
      } else if (data.status === 'ready') {
        onProgress({ stage: 'ready', pct: 100 });
      } else if (data.status === 'initiate' || data.status === 'download') {
        onProgress({ stage: 'download', pct: 0, file: data.file });
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
