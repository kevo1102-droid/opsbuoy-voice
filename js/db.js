const DB_NAME = 'opsbuoy-voice';
const DB_VERSION = 1;
const STORE = 'notes';

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(mode) {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

export async function addNote(note) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const r = store.add(note);
    r.onsuccess = () => resolve(note.id);
    r.onerror = () => reject(r.error);
  });
}

export async function updateNote(id, patch) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const g = store.get(id);
    g.onsuccess = () => {
      const cur = g.result;
      if (!cur) return reject(new Error('not found'));
      const next = { ...cur, ...patch };
      const p = store.put(next);
      p.onsuccess = () => resolve(next);
      p.onerror = () => reject(p.error);
    };
    g.onerror = () => reject(g.error);
  });
}

export async function getNote(id) {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const r = store.get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function deleteNote(id) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const r = store.delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function allNotes() {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const idx = store.index('createdAt');
    const out = [];
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (c) { out.push(c.value); c.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearAll() {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const r = store.clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
