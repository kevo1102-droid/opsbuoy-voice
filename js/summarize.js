// Summarization — three backends.
//
// Cloud (BYO key, opt-in):
//   - Anthropic Claude (api.anthropic.com)
//   - OpenAI (api.openai.com)
// On-device (opt-in, ~700MB download):
//   - WebLLM (browser WebGPU/WASM, no network at inference time)
//
// API keys live in localStorage on this device only. We never see them.

const LS_ANTHROPIC = 'opsbuoy-voice.anthropic_key';
const LS_OPENAI = 'opsbuoy-voice.openai_key';
const LS_WEBLLM_MODEL = 'opsbuoy-voice.webllm_model';

const WEBLLM_URL = '/lib/web-llm.js';

const SYSTEM = `You are a note-summarizer. Given a transcript, produce a concise summary as 3-5 bullet points. Include any action items or decisions explicitly. Return ONLY the bullet list, no preamble, no closing remarks.`;

let _webllmEngine = null;
let _webllmLoading = false;

// --- key management ---------------------------------------------------------

export function getKey(provider) {
  const map = { anthropic: LS_ANTHROPIC, openai: LS_OPENAI };
  return map[provider] ? localStorage.getItem(map[provider]) : null;
}

export function setKey(provider, value) {
  const map = { anthropic: LS_ANTHROPIC, openai: LS_OPENAI };
  if (!map[provider]) return;
  if (value) localStorage.setItem(map[provider], value);
  else localStorage.removeItem(map[provider]);
}

export function getWebllmModel() {
  return localStorage.getItem(LS_WEBLLM_MODEL) || 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
}
export function setWebllmModel(id) {
  localStorage.setItem(LS_WEBLLM_MODEL, id);
  _webllmEngine = null;
}

export function isWebllmReady() {
  return !!_webllmEngine;
}

export function listProviders() {
  const out = [];
  if (getKey('anthropic')) out.push({ id: 'anthropic', label: 'Claude API', local: false });
  if (getKey('openai')) out.push({ id: 'openai', label: 'OpenAI API', local: false });
  if (isWebllmReady()) out.push({ id: 'webllm', label: 'On-device (private)', local: true });
  return out;
}

// --- cloud providers --------------------------------------------------------

async function summarizeAnthropic(text, key) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Transcript:\n\n${text}` }],
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${msg.slice(0, 200)}`);
  }
  const data = await res.json();
  const parts = data?.content?.filter?.((c) => c.type === 'text') || [];
  return parts.map((p) => p.text).join('\n').trim();
}

async function summarizeOpenAI(text, key) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Transcript:\n\n${text}` },
      ],
      max_tokens: 1024,
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${msg.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

// --- WebLLM (on-device) -----------------------------------------------------

export async function loadWebllm(onProgress) {
  if (_webllmEngine) return _webllmEngine;
  if (_webllmLoading) throw new Error('Model already loading — please wait.');
  _webllmLoading = true;
  try {
    const modelId = getWebllmModel();
    const mod = await import(/* @vite-ignore */ WEBLLM_URL);
    const CreateMLCEngine = mod.CreateMLCEngine || mod.default?.CreateMLCEngine;
    if (!CreateMLCEngine) throw new Error('WebLLM module did not export CreateMLCEngine.');
    _webllmEngine = await CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        try { console.log('[webllm]', report); } catch {}
        if (onProgress) {
          onProgress({
            pct: Math.round((report.progress || 0) * 100),
            message: report.text || 'Loading model…',
          });
        }
      },
    });
    return _webllmEngine;
  } finally {
    _webllmLoading = false;
  }
}

async function summarizeWebllm(text, onProgress) {
  const engine = await loadWebllm((p) => onProgress?.({ stage: 'load', ...p }));
  onProgress?.({ stage: 'infer', pct: 0, message: 'Generating summary…' });
  const reply = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Transcript:\n\n${text}` },
    ],
    temperature: 0.3,
    max_tokens: 512,
  });
  return (reply?.choices?.[0]?.message?.content || '').trim();
}

// --- entrypoint -------------------------------------------------------------

export async function summarize(text, provider, onProgress) {
  const clean = (text || '').trim();
  if (!clean) throw new Error('Nothing to summarize.');
  onProgress?.({ stage: 'start', pct: 0, message: 'Contacting provider…' });
  if (provider === 'anthropic') {
    const key = getKey('anthropic');
    if (!key) throw new Error('No Anthropic API key set.');
    return summarizeAnthropic(clean, key);
  }
  if (provider === 'openai') {
    const key = getKey('openai');
    if (!key) throw new Error('No OpenAI API key set.');
    return summarizeOpenAI(clean, key);
  }
  if (provider === 'webllm') {
    return summarizeWebllm(clean, onProgress);
  }
  throw new Error(`Unknown provider: ${provider}`);
}
