import { addNote, allNotes, getNote, updateNote, deleteNote, clearAll, estimateUsage } from './db.js';
import { Recorder } from './recorder.js';
import { transcribe, preloadModel, getModelName, setModelName } from './transcribe.js';

const $ = (sel) => document.querySelector(sel);
const views = { list: $('#list-view'), record: $('#record-view'), detail: $('#detail-view') };

let recorder = null;
let vizRaf = null;
let timerInterval = null;
let currentNoteId = null;

function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('active', k === name));
  $('#fab').classList.toggle('hidden', name !== 'list');
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

async function renderList() {
  const notes = await allNotes();
  const list = $('#notes-list');
  const hero = $('#hero-empty');
  list.innerHTML = '';
  if (notes.length === 0) {
    hero.hidden = false;
    return;
  }
  hero.hidden = true;
  const frag = document.createDocumentFragment();
  for (const n of notes) {
    const li = document.createElement('li');
    li.className = 'note-card';
    li.dataset.id = n.id;
    li.innerHTML = `
      <div class="note-title"></div>
      <div class="note-preview"></div>
      <div class="note-meta">
        <span></span><span class="dot">·</span><span></span>
      </div>
    `;
    li.querySelector('.note-title').textContent = n.title || derivedTitle(n.transcript);
    li.querySelector('.note-preview').textContent = n.transcript || '(no transcript)';
    const spans = li.querySelectorAll('.note-meta span');
    spans[0].textContent = fmtDate(n.createdAt);
    spans[2].textContent = fmtDuration(n.duration || 0);
    li.addEventListener('click', () => openDetail(n.id));
    frag.appendChild(li);
  }
  list.appendChild(frag);
}

// Recording flow
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

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Microphone not available in this browser.');
    return;
  }
  recorder = new Recorder();
  try {
    await recorder.start();
  } catch (e) {
    console.error(e);
    toast('Mic permission denied.');
    recorder = null;
    return;
  }
  showView('record');
  $('#record-status').textContent = 'Recording';
  $('#record-status').classList.add('recording');
  $('#record-stop').hidden = false;
  $('#record-cancel').hidden = false;
  $('#record-timer').textContent = '00:00';

  timerInterval = setInterval(() => {
    if (recorder) $('#record-timer').textContent = fmtDuration(recorder.elapsed());
  }, 500);
  drawViz._history = null;
  drawViz();
}

async function stopRecording() {
  if (!recorder) return;
  clearInterval(timerInterval);
  cancelAnimationFrame(vizRaf);
  $('#record-status').textContent = 'Processing…';
  $('#record-stop').hidden = true;
  $('#record-cancel').hidden = true;
  const { blob, duration, mimeType } = await recorder.stop();
  recorder = null;

  showTranscribeOverlay(true, 'Loading model…');
  let transcript = '';
  try {
    transcript = await transcribe(blob, (p) => {
      $('#tx-status').textContent = p.message || 'Working…';
      $('#tx-fill').style.width = `${Math.min(100, p.pct || 0)}%`;
    });
  } catch (e) {
    console.error(e);
    toast('Transcription failed — note saved without transcript.');
  }
  showTranscribeOverlay(false);

  const id = crypto.randomUUID();
  const note = {
    id,
    title: derivedTitle(transcript),
    transcript,
    audioBlob: blob,
    mimeType,
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
  showView('list');
}

// Detail view
async function openDetail(id) {
  const n = await getNote(id);
  if (!n) return;
  currentNoteId = id;
  $('#detail-title').value = n.title || derivedTitle(n.transcript);
  $('#detail-date').textContent = fmtDate(n.createdAt);
  $('#detail-duration').textContent = fmtDuration(n.duration || 0);
  const audio = $('#detail-audio');
  if (audio.dataset.url) URL.revokeObjectURL(audio.dataset.url);
  const url = URL.createObjectURL(n.audioBlob);
  audio.src = url;
  audio.dataset.url = url;
  $('#detail-transcript').value = n.transcript || '';
  showView('detail');
}

async function saveDetailEdits() {
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
  const n = await getNote(currentNoteId);
  if (!n) return;
  const date = new Date(n.createdAt).toISOString().slice(0, 10);
  const md = `# ${n.title}\n\n_${new Date(n.createdAt).toLocaleString()} · ${fmtDuration(n.duration || 0)}_\n\n${n.transcript || ''}\n`;
  const safe = n.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 40) || 'note';
  download(`${date}-${safe}.md`, md, 'text/markdown');
}

async function exportAudio() {
  const n = await getNote(currentNoteId);
  if (!n) return;
  const ext = (n.mimeType || '').includes('mp4') ? 'm4a' : (n.mimeType || '').includes('ogg') ? 'ogg' : 'webm';
  const date = new Date(n.createdAt).toISOString().slice(0, 10);
  const safe = n.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 40) || 'note';
  download(`${date}-${safe}.${ext}`, n.audioBlob);
}

async function deleteCurrent() {
  if (!currentNoteId) return;
  if (!confirm('Delete this note? This cannot be undone.')) return;
  await deleteNote(currentNoteId);
  currentNoteId = null;
  await renderList();
  showView('list');
  toast('Deleted.');
}

// Settings
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

// Wire up
function init() {
  $('#fab').addEventListener('click', startRecording);
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
