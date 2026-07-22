export class Recorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mimeType = '';
    this.audioContext = null;
    this.analyser = null;
    this._chunked = false;
    this._rotateTimer = null;
    this._chunkIndex = 0;
    this._onChunk = null;
    this._rotating = false;
  }

  static supportedMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) return t;
    }
    return '';
  }

  async start(opts = {}) {
    const { chunked = false, chunkSeconds = 30, onChunk = null } = opts;
    this._chunked = chunked;
    this._onChunk = onChunk;
    this._chunkIndex = 0;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.mimeType = Recorder.supportedMime();
    this._startInnerRecorder();
    this.startedAt = Date.now();

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);

    if (chunked) {
      this._rotateTimer = setInterval(() => this._rotate(), chunkSeconds * 1000);
    }
  }

  _startInnerRecorder() {
    const opts = this.mimeType ? { mimeType: this.mimeType } : {};
    this.mediaRecorder = new MediaRecorder(this.stream, opts);
    this.chunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start(1000);
  }

  async _rotate() {
    if (this._rotating || !this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;
    this._rotating = true;
    const idx = this._chunkIndex++;
    const oldRec = this.mediaRecorder;
    const oldChunks = this.chunks;
    const mimeType = this.mimeType;
    try {
      await new Promise((resolve) => {
        oldRec.onstop = () => resolve();
        oldRec.stop();
      });
      const blob = new Blob(oldChunks, { type: mimeType || 'audio/webm' });
      this._onChunk?.({ index: idx, blob, mimeType: mimeType || blob.type });
      this._startInnerRecorder();
    } finally {
      this._rotating = false;
    }
  }

  getLevel() {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  elapsed() {
    return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
  }

  isChunked() {
    return this._chunked;
  }

  async stop() {
    if (this._rotateTimer) { clearInterval(this._rotateTimer); this._rotateTimer = null; }
    if (!this.mediaRecorder) return null;
    // If a rotate is in progress, wait for it before stopping.
    while (this._rotating) await new Promise((r) => setTimeout(r, 50));
    return new Promise((resolve) => {
      const finalIdx = this._chunkIndex;
      const finalChunks = this.chunks;
      const mimeType = this.mimeType;
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(finalChunks, { type: mimeType || 'audio/webm' });
        const duration = this.elapsed();
        if (this._chunked && blob.size > 0) {
          this._onChunk?.({ index: finalIdx, blob, mimeType: mimeType || blob.type, final: true });
        }
        this.cleanup();
        resolve({ blob, duration, mimeType: mimeType || blob.type });
      };
      this.mediaRecorder.stop();
    });
  }

  cancel() {
    if (this._rotateTimer) { clearInterval(this._rotateTimer); this._rotateTimer = null; }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch {}
    }
    this.cleanup();
  }

  cleanup() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.analyser = null;
    this.mediaRecorder = null;
  }
}
