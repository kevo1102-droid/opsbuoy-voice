import { addNote, allNotes, getNote, updateNote, deleteNote, clearAll, estimateUsage } from './db.js';
import { Recorder } from './recorder.js';
import { transcribe, preloadModel, getModelName, setModelName } from './transcribe.js';
import { summarize, getKey, setKey, loadWebllm, isWebllmReady, listProviders } from './summarize.js';

const $ = (sel) => document.querySelector(sel);
const views = { list: $('#list-view'), record: $('#record-view'), detail: $('#detail-view') };

let recorder = null;
let vizRaf = null;
let timerInterval = null;
let currentNoteId = null;
let currentNoteIsNew = false;
let searchQuery = '';
let cachedNotes = [];

// Long-recording session state
let longSession = null; // { chunks: [], transcripts: [], startedAt, pending: number }

function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('active', k === name));
  $('#fab-cluster').classList.toggle('hidden', name !== 'list');
  window.scrollTo(0, 0);
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._to);
  t._to = setTimeout(() => (t.hidden = true), ms);
}

function fmtDuration(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const isSameDay = d.toDateString() === today.toDateString();
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const isYesterday = d.toDateString() === yest.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isSameDay) return `Today, ${time}`;
  if (isYesterday) return `Yesterday, ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${time}`;
}

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

function derivedTitle(text) {
  if (!text) return 'Untitled note';
  const line = text.split(/[\n.!?]/)[0].trim();
  return line.slice(0, 60) || 'Untitled note';
}

function isTextNote(note) {
  return !note.audioBlob;
}

const ICON_MIC = '<svg class="note-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>';
const ICON_PEN = '<svg class="note-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';

// --- List / search ---------------------------------------------------------

function filterNotes(notes, q) {
  if (!q) return notes;
  const needle = q.toLowerCase();
  return notes.filter((n) => {
    return (
      (n.title || '').toLowerCase().includes(needle) ||
      (n.transcript || '').toLowerCase().includes(needle)
    );
  });
}

async function renderList() {
  cachedNotes = await allNotes();
  paintList();
}

function paintList() {
  const list = $('#notes-list');
  const hero = $('#hero-empty');
  const noResults = $('#no-results');
  const searchWrap = $('#search-wrap');

  searchWrap.hidden = cachedNotes.length === 0;

  const filtered = filterNotes(cachedNotes, searchQuery);
  list.innerHTML = '';

  if (cachedNotes.length === 0) {
    hero.hidden = false;
    noResults.hidden = true;
    return;
  }
  hero.hidden = true;

  if (filtered.length === 0) {
    noResults.hidden = false;
    $('#no-results-q').textContent = `"${searchQuery}"`;
    return;
  }
  noResults.hidden = true;

  const frag = document.createDocumentFragment();
  for (const n of filtered) {
    const li = document.createElement('li');
    li.className = 'note-card';
    li.dataset.id = n.id;

    const titleRow = document.createElement('div');
    titleRow.className = 'note-title-row';
    titleRow.innerHTML = isTextNote(n) ? ICON_PEN : ICON_MIC;
    const titleSpan = document.createElement('div');
    titleSpan.className = 'note-title';
    titleSpan.textContent = n.title || derivedTitle(n.transcript);
    titleRow.appendChild(titleSpan);
    li.appendChild(titleRow);

    const preview = document.createElement('div');
    preview.className = 'note-preview';
    preview.textContent = n.transcript || '(no content)';
    li.appendChild(preview);

    const meta = document.createElement('div');
    meta.className = 'note-meta';
    const dateSpan = document.createElement('span');
    dateSpan.textContent = fmtDate(n.createdAt);
    meta.appendChild(dateSpan);
    if (!isTextNote(n)) {
      const dot = document.createElement('span'); dot.className = 'dot'; dot.textContent = '·';
      const dur = document.createElement('span'); dur.textContent = fmtDuration(n.duration || 0);
      meta.appendChild(dot); meta.appendChild(dur);
    }
    li.appendChild(meta);

    li.addEventListener('click', () => openDetail(n.id));
    frag.appendChild(li);
  }
  list.appendChild(frag);
}

// --- Recording -------------------------------------------------------------

function drawViz() {
  const canvas = $('#viz');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const bars = 48;
  const barW = w / bars;
  const history = drawViz._history || (drawViz._history = new Array(bars).fill(0));
  const level = recorder ? recorder.getLevel() : 0;
  history.push(level);
  if (history.length > bars) history.shift();

  ctx.clearRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#00e5a0');
  grad.addColorStop(0.5, '#00c9d4');
  grad.addColorStop(1, '#4d8eff');
  ctx.fillStyle = grad;
  for (let i = 0; i < history.length; i++) {
    const lv = history[i];
    const barH = Math.max(2, lv * h * 2.5);
    const x = i * barW + 2;
    const y = (h - barH) / 2;
    ctx.fillRect(x, y, barW - 4, barH);
  }
  vizRaf = requestAnimationFrame(drawViz);
}

async function startRecording({ long = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Microphone not available in this browser.');
    return;
  }
  recorder = new Recorder();
  longSession = long ? { chunks: [], transcripts: [], startedAt: Date.now(), pending: 0 } : null;

  try {
    await recorder.start(long ? {
      chunked: true,
      chunkSeconds: 30,
      onChunk: handleLongChunk,
    } : {});
  } catch (e) {
    console.error(e);
    toast('Mic permission denied.');
    recorder = null;
    longSession = null;
    return;
  }
  showView('record');
  $('#record-status').textContent = 'Recording';
  $('#record-status').classList.add('recording');
  $('#record-stop').hidden = false;
  $('#record-cancel').hidden = false;
  $('#record-timer').textContent = '00:00';
  $('#record-mode-badge').hidden = !long;
  $('#record-chunks').hidden = !long;
  if (long) {
    $('#record-chunk-count').textContent = '0';
    $('#record-mode-badge').textContent = 'Long session · chunked';
  }

  timerInterval = setInterval(() => {
    if (recorder) $('#record-timer').textContent = fmtDuration(recorder.elapsed());
  }, 500);
  drawViz._history = null;
  drawViz();
}

async function handleLongChunk({ index, blob, mimeType, final }) {
  if (!longSession) return;
  longSession.chunks.push(blob);
  longSession.pending++;
  const doneCount = longSession.transcripts.filter((t) => t != null).length;
  $('#record-chunk-count').textContent = `${doneCount}/${longSession.chunks.length}`;
  try {
    const text = await transcribe(blob);
    longSession.transcripts[index] = text || '';
  } catch (e) {
    console.error('[long chunk transcribe]', e);
    longSession.transcripts[index] = '';
  } finally {
    longSession.pending--;
    const doneCount2 = longSession.transcripts.filter((t) => t != null).length;
    $('#record-chunk-count').textContent = `${doneCount2}/${longSession.chunks.length}`;
  }
}

async function stopRecording() {
  if (!recorder) return;
  clearInterval(timerInterval);
  cancelAnimationFrame(vizRaf);
  $('#record-status').textContent = 'Processing…';
  $('#record-stop').hidden = true;
  $('#record-cancel').hidden = true;

  const isLong = !!longSession;
  const { blob, duration, mimeType } = await recorder.stop();
  recorder = null;

  showTranscribeOverlay(true, isLong ? 'Finalizing long session…' : 'Loading model…');
  let transcript = '';
  let finalBlob = blob;
  let finalMime = mimeType;

  const timeoutMs = 5 * 60 * 1000;
  let timeoutHit = false;
  let errorMessage = '';
  const timeoutId = setTimeout(() => {
    timeoutHit = true;
    $('#tx-status').textContent = 'Stuck for 5 minutes — closing overlay. Check browser console for CSP/network errors.';
  }, timeoutMs);

  try {
    if (isLong) {
      // Wait for any in-flight chunk transcriptions to complete.
      while (longSession && longSession.pending > 0) {
        $('#tx-status').textContent = `Finishing ${longSession.pending} chunk transcription(s)…`;
        await new Promise((r) => setTimeout(r, 500));
      }
      // Concatenate chunks into a single blob for the note's audio.
      const chunks = longSession.chunks;
      finalBlob = new Blob(chunks, { type: chunks[0]?.type || mimeType || 'audio/webm' });
      finalMime = finalBlob.type;
      transcript = longSession.transcripts.filter(Boolean).join(' ').trim();
      longSession = null;
    } else {
      transcript = await Promise.race([
        transcribe(blob, (p) => {
          $('#tx-status').textContent = p.message || 'Working…';
          $('#tx-fill').style.width = `${Math.min(100, p.pct || 0)}%`;
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out after 5 minutes')), timeoutMs)),
      ]);
    }
  } catch (e) {
    console.error('[transcribe error]', e);
    const msg = (e && e.message) ? e.message : String(e);
    errorMessage = msg;
    $('#tx-status').textContent = `Error: ${msg}`;
    toast(`Transcription failed: ${msg.slice(0, 100)}`, 8000);
    await new Promise((r) => setTimeout(r, timeoutHit ? 100 : 2500));
  } finally {
    clearTimeout(timeoutId);
  }
  showTranscribeOverlay(false);

  // If transcription failed, embed the error text in the note itself so it's
  // still visible after the toast disappears. Audio is preserved either way.
  const noteTranscript = transcript || (errorMessage
    ? `[transcription failed — audio saved so you can retry]\n\nError: ${errorMessage}`
    : '');

  const id = crypto.randomUUID();
  const note = {
    id,
    title: transcript ? derivedTitle(transcript) : (errorMessage ? 'Untranscribed note' : 'Untitled note'),
    transcript: noteTranscript,
    audioBlob: finalBlob,
    mimeType: finalMime,
    duration,
    createdAt: Date.now(),
  };
  await addNote(note);
  await renderList();
  showView('list');
  openDetail(id);
  toast('Saved.');
}

function cancelRecording() {
  if (!recorder) return;
  clearInterval(timerInterval);
  cancelAnimationFrame(vizRaf);
  recorder.cancel();
  recorder = null;
  longSession = null;
  showView('list');
}

// --- Typed note ------------------------------------------------------------

function newTypedNote() {
  currentNoteId = null;
  currentNoteIsNew = true;
  $('#detail-title').value = '';
  $('#detail-transcript').value = '';
  $('#detail-date').textContent = fmtDate(Date.now());
  $('#detail-duration').textContent = '';
  $('#detail-dot').hidden = true;
  $('#detail-type-badge').textContent = 'Typed';
  $('#detail-audio').hidden = true;
  $('#detail-audio').src = '';
  $('#detail-transcript-label').textContent = 'Note';
  $('#export-audio').hidden = true;
  $('#delete-note').hidden = true;
  $('#share-note').hidden = !navigator.share;
  showView('detail');
  setTimeout(() => $('#detail-title').focus(), 100);
}

async function saveNewTypedNoteIfNeeded() {
  if (!currentNoteIsNew) return false;
  const title = $('#detail-title').value.trim();
  const transcript = $('#detail-transcript').value;
  if (!title && !transcript.trim()) return false; // discard empty
  const id = crypto.randomUUID();
  const note = {
    id,
    title: title || derivedTitle(transcript),
    transcript,
    mimeType: 'text/plain',
    duration: 0,
    createdAt: Date.now(),
  };
  await addNote(note);
  currentNoteId = id;
  currentNoteIsNew = false;
  return true;
}

// --- Detail view -----------------------------------------------------------

async function openDetail(id) {
  const n = await getNote(id);
  if (!n) return;
  currentNoteId = id;
  currentNoteIsNew = false;

  const isText = isTextNote(n);
  $('#detail-title').value = n.title || derivedTitle(n.transcript);
  $('#detail-date').textContent = fmtDate(n.createdAt);
  $('#detail-duration').textContent = fmtDuration(n.duration || 0);
  $('#detail-dot').hidden = isText;
  $('#detail-type-badge').textContent = isText ? 'Typed' : 'Voice';
  $('#detail-transcript-label').textContent = isText ? 'Note' : 'Transcript';
  $('#delete-note').hidden = false;
  $('#share-note').hidden = !navigator.share;
  $('#summarize-btn').hidden = listProviders().length === 0;

  const audio = $('#detail-audio');
  if (audio.dataset.url) URL.revokeObjectURL(audio.dataset.url);
  if (isText) {
    audio.hidden = true;
    audio.src = '';
    delete audio.dataset.url;
    $('#export-audio').hidden = true;
  } else {
    audio.hidden = false;
    const url = URL.createObjectURL(n.audioBlob);
    audio.src = url;
    audio.dataset.url = url;
    $('#export-audio').hidden = false;
  }
  $('#detail-transcript').value = n.transcript || '';
  showView('detail');
}

async function saveDetailEdits() {
  if (currentNoteIsNew) {
    await saveNewTypedNoteIfNeeded();
    return;
  }
  if (!currentNoteId) return;
  const title = $('#detail-title').value.trim() || 'Untitled note';
  const transcript = $('#detail-transcript').value;
  await updateNote(currentNoteId, { title, transcript });
}

function download(filename, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportMd() {
  await saveDetailEdits();
  if (!currentNoteId) return;
  const n = await getNote(currentNoteId);
  if (!n) return;
  const date = new Date(n.createdAt).toISOString().slice(0, 10);
  const md = `# ${n.title}\n\n_${new Date(n.createdAt).toLocaleString()}${!isTextNote(n) ? ` · ${fmtDuration(n.duration || 0)}` : ''}_\n\n${n.transcript || ''}\n`;
  const safe = n.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 40) || 'note';
  download(`${date}-${safe}.md`, md, 'text/markdown');
}

async function exportAudio() {
  const n = await getNote(currentNoteId);
  if (!n || !n.audioBlob) return;
  const ext = (n.mimeType || '').includes('mp4') ? 'm4a' : (n.mimeType || '').includes('ogg') ? 'ogg' : 'webm';
  const date = new Date(n.createdAt).toISOString().slice(0, 10);
  const safe = n.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 40) || 'note';
  download(`${date}-${safe}.${ext}`, n.audioBlob);
}

async function shareNote() {
  await saveDetailEdits();
  if (!currentNoteId || !navigator.share) return;
  const n = await getNote(currentNoteId);
  if (!n) return;
  try {
    await navigator.share({
      title: n.title,
      text: `${n.title}\n\n${n.transcript || ''}`,
    });
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('Share failed.');
  }
}

async function deleteCurrent() {
  if (!currentNoteId) return;
  if (!confirm('Delete this note? This cannot be undone.')) return;
  await deleteNote(currentNoteId);
  currentNoteId = null;
  currentNoteIsNew = false;
  await renderList();
  showView('list');
  toast('Deleted.');
}

// --- Backup / restore ------------------------------------------------------

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result || '';
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

async function exportAllNotes() {
  toast('Preparing backup…');
  const notes = await allNotes();
  const out = { version: 1, exportedAt: Date.now(), count: notes.length, notes: [] };
  for (const n of notes) {
    const item = {
      id: n.id,
      title: n.title,
      transcript: n.transcript,
      mimeType: n.mimeType,
      duration: n.duration || 0,
      createdAt: n.createdAt,
    };
    if (n.audioBlob) {
      item.audio = await blobToBase64(n.audioBlob);
    }
    out.notes.push(item);
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  download(`opsbuoy-voice-backup-${stamp}.json`, JSON.stringify(out), 'application/json');
  toast(`Backed up ${out.count} note(s).`);
}

async function importBackup(file) {
  if (!file) return;
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    toast('Not a valid backup file.'); return;
  }
  if (!data || !Array.isArray(data.notes)) { toast('Not a valid backup file.'); return; }
  const existing = await allNotes();
  const existingIds = new Set(existing.map((n) => n.id));
  let added = 0, skipped = 0;
  for (const item of data.notes) {
    if (!item || !item.id || existingIds.has(item.id)) { skipped++; continue; }
    const note = {
      id: item.id,
      title: item.title || 'Untitled note',
      transcript: item.transcript || '',
      mimeType: item.mimeType || 'text/plain',
      duration: item.duration || 0,
      createdAt: item.createdAt || Date.now(),
    };
    if (item.audio) {
      note.audioBlob = base64ToBlob(item.audio, item.mimeType);
    }
    try { await addNote(note); added++; } catch { skipped++; }
  }
  await renderList();
  toast(`Restored ${added} · skipped ${skipped}.`);
}

// --- Settings --------------------------------------------------------------

function showTranscribeOverlay(show, status = 'Working…') {
  const o = $('#transcribe-overlay');
  o.hidden = !show;
  if (show) {
    $('#tx-status').textContent = status;
    $('#tx-fill').style.width = '0%';
  }
}

async function openSettings() {
  const modelSel = $('#model-select');
  modelSel.value = await getModelName();
  const usage = await estimateUsage();
  $('#storage-used').textContent = usage
    ? `${fmtBytes(usage.usage)} used${usage.quota ? ` of ${fmtBytes(usage.quota)} available` : ''}`
    : 'Unavailable';
  $('#anthropic-key').value = getKey('anthropic') || '';
  $('#openai-key').value = getKey('openai') || '';
  if (isWebllmReady()) {
    $('#webllm-load').textContent = 'Loaded ✓';
    $('#webllm-load').disabled = true;
  }
  const webllmHelp = $('#webllm-help');
  if (!('gpu' in navigator)) {
    webllmHelp.textContent = 'WebGPU not detected on this browser — will run via slow WASM fallback. Chrome/Edge on desktop or Android with WebGPU flag is recommended.';
  }
  $('#settings-modal').hidden = false;
}

function closeSettings() {
  $('#settings-modal').hidden = true;
  $('#model-progress').hidden = true;
}

async function predownload() {
  $('#model-progress').hidden = false;
  $('#model-progress-fill').style.width = '0%';
  $('#model-progress-pct').textContent = '0%';
  try {
    await preloadModel((p) => {
      const pct = Math.min(100, Math.round(p.pct || 0));
      $('#model-progress-fill').style.width = `${pct}%`;
      $('#model-progress-pct').textContent = `${pct}%`;
    });
    $('#model-progress-fill').style.width = '100%';
    $('#model-progress-pct').textContent = '100%';
    toast('Model ready. Works offline now.');
  } catch (e) {
    console.error(e);
    toast('Model download failed.');
  }
}

// --- Summarize -------------------------------------------------------------

let lastSummary = '';

function openSummarizeModal() {
  const providers = listProviders();
  const sel = $('#summarize-provider');
  sel.innerHTML = '';
  providers.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });
  $('#summary-output').hidden = true;
  $('#summary-output').textContent = '';
  $('#summarize-status').hidden = true;
  $('#summarize-progress-wrap').hidden = true;
  $('#summarize-insert').hidden = true;
  $('#summarize-copy').hidden = true;
  $('#summarize-run').disabled = false;
  $('#summarize-run').textContent = 'Summarize';
  lastSummary = '';
  $('#summarize-modal').hidden = false;
}

function closeSummarizeModal() {
  $('#summarize-modal').hidden = true;
}

async function runSummarize() {
  const provider = $('#summarize-provider').value;
  if (!provider) return;
  const text = $('#detail-transcript').value.trim();
  if (!text) { toast('Nothing to summarize.'); return; }
  const runBtn = $('#summarize-run');
  runBtn.disabled = true;
  runBtn.textContent = 'Working…';
  const status = $('#summarize-status');
  const fillWrap = $('#summarize-progress-wrap');
  const fill = $('#summarize-fill');
  status.hidden = false;
  status.textContent = 'Starting…';
  fillWrap.hidden = false;
  fill.style.width = '0%';
  try {
    const summary = await summarize(text, provider, (p) => {
      status.textContent = p.message || 'Working…';
      fill.style.width = `${Math.min(100, p.pct || 0)}%`;
    });
    lastSummary = summary;
    $('#summary-output').textContent = summary || '(empty)';
    $('#summary-output').hidden = false;
    $('#summarize-insert').hidden = false;
    $('#summarize-copy').hidden = false;
    status.hidden = true;
    fillWrap.hidden = true;
  } catch (e) {
    console.error('[summarize]', e);
    status.textContent = `Error: ${e.message || e}`;
    fillWrap.hidden = true;
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'Summarize';
  }
}

async function insertSummary() {
  if (!lastSummary || !currentNoteId) return;
  const textarea = $('#detail-transcript');
  const cur = textarea.value;
  const stamped = `## Summary\n${lastSummary}\n\n---\n\n${cur}`;
  textarea.value = stamped;
  await saveDetailEdits();
  toast('Summary added to top of note.');
  closeSummarizeModal();
}

async function copySummary() {
  if (!lastSummary) return;
  try { await navigator.clipboard.writeText(lastSummary); toast('Copied.'); }
  catch { toast('Copy failed.'); }
}

async function loadWebllmFromSettings() {
  const btn = $('#webllm-load');
  const prog = $('#webllm-progress');
  const lbl = $('#webllm-progress-label');
  const fill = $('#webllm-progress-fill');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  prog.hidden = false;
  fill.style.width = '0%';

  // Wrap fetch so if a load fails, we can show the exact URL that broke.
  // This is temporary — restore after WebLLM finishes (or fails).
  const failedUrls = [];
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return originalFetch.call(this, input, init).catch((err) => {
      if (url) failedUrls.push(url);
      throw err;
    });
  };

  try {
    if (!('gpu' in navigator)) {
      console.warn('[webllm] navigator.gpu not present — WASM fallback will be extremely slow');
    }
    await loadWebllm((p) => {
      lbl.textContent = p.message || 'Loading…';
      fill.style.width = `${p.pct || 0}%`;
    });
    fill.style.width = '100%';
    lbl.textContent = 'Ready.';
    btn.textContent = 'Loaded ✓';
    toast('On-device model ready.');
  } catch (e) {
    console.error('[webllm load]', e);
    const msg = e.message || String(e);
    const detail = failedUrls.length ? ` (last failed URL: ${failedUrls[failedUrls.length - 1]})` : '';
    toast(`WebLLM load failed: ${msg.slice(0, 80)}${detail}`, 8000);
    btn.disabled = false;
    btn.textContent = 'Load';
    lbl.textContent = `Error: ${msg}${detail}`;
  } finally {
    window.fetch = originalFetch;
  }
}

// --- Wire up ---------------------------------------------------------------

function init() {
  // Defensive: force all modals hidden on boot, regardless of any stale state.
  $('#transcribe-overlay').hidden = true;
  $('#settings-modal').hidden = true;
  $('#summarize-modal').hidden = true;

  // Surface CSP violations to a toast — otherwise a blocked fetch shows as
  // a generic "Failed to fetch" with no clue which URL was blocked.
  window.addEventListener('securitypolicyviolation', (e) => {
    const line = `CSP blocked ${e.violatedDirective}: ${e.blockedURI}`;
    console.error('[CSP]', line, e);
    toast(line, 10000);
  });

  $('#fab').addEventListener('click', () => startRecording({ long: false }));
  $('#fab-long').addEventListener('click', () => startRecording({ long: true }));
  $('#fab-text').addEventListener('click', newTypedNote);

  $('#record-stop').addEventListener('click', stopRecording);
  $('#record-cancel').addEventListener('click', cancelRecording);

  $('#detail-back').addEventListener('click', async () => {
    await saveDetailEdits();
    await renderList();
    showView('list');
  });
  $('#detail-title').addEventListener('blur', saveDetailEdits);
  $('#detail-transcript').addEventListener('blur', saveDetailEdits);
  $('#copy-transcript').addEventListener('click', async () => {
    const text = $('#detail-transcript').value;
    try { await navigator.clipboard.writeText(text); toast('Copied.'); }
    catch { toast('Copy failed.'); }
  });
  $('#export-md').addEventListener('click', exportMd);
  $('#export-audio').addEventListener('click', exportAudio);
  $('#delete-note').addEventListener('click', deleteCurrent);
  $('#share-note').addEventListener('click', shareNote);
  $('#summarize-btn').addEventListener('click', openSummarizeModal);
  $('#summarize-close').addEventListener('click', closeSummarizeModal);
  $('#summarize-modal').addEventListener('click', (e) => {
    if (e.target === $('#summarize-modal')) closeSummarizeModal();
  });
  $('#summarize-run').addEventListener('click', runSummarize);
  $('#summarize-insert').addEventListener('click', insertSummary);
  $('#summarize-copy').addEventListener('click', copySummary);

  // Search
  const searchInput = $('#search-input');
  const searchClear = $('#search-clear');
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    searchClear.hidden = !searchQuery;
    paintList();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClear.hidden = true;
    paintList();
    searchInput.focus();
  });

  // Settings
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-modal').addEventListener('click', (e) => {
    if (e.target === $('#settings-modal')) closeSettings();
  });
  $('#model-select').addEventListener('change', async (e) => {
    await setModelName(e.target.value);
    toast('Model changed. Next transcription will download it.');
  });
  $('#predownload').addEventListener('click', predownload);

  // Summarization keys + WebLLM
  $('#anthropic-key').addEventListener('change', (e) => {
    setKey('anthropic', e.target.value.trim());
    toast(e.target.value.trim() ? 'Claude key saved on this device.' : 'Claude key removed.');
  });
  $('#openai-key').addEventListener('change', (e) => {
    setKey('openai', e.target.value.trim());
    toast(e.target.value.trim() ? 'OpenAI key saved on this device.' : 'OpenAI key removed.');
  });
  $('#webllm-load').addEventListener('click', loadWebllmFromSettings);

  // Backup / restore
  $('#export-all').addEventListener('click', exportAllNotes);
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting same file
    if (file) await importBackup(file);
  });

  $('#clear-all').addEventListener('click', async () => {
    if (!confirm('Delete ALL notes? This cannot be undone.')) return;
    await clearAll();
    await renderList();
    closeSettings();
    toast('All notes deleted.');
  });

  window.addEventListener('beforeunload', (e) => {
    if (recorder) { e.preventDefault(); e.returnValue = ''; }
  });

  renderList();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}

init();
