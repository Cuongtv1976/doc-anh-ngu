// Tạo giọng AI (Kokoro) trong luồng riêng để app không bị đứng khi đang tạo âm thanh.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let ttsP = null, lastPct = -1;
function getTts() {
  return ttsP || (ttsP = KokoroTTS.from_pretrained(MODEL, {
    dtype: 'q8', device: 'wasm',
    progress_callback: p => {
      if (p.status !== 'progress' || !/onnx/.test(p.file || '')) return;
      const pct = Math.floor(p.progress || 0);
      if (pct !== lastPct) { lastPct = pct; self.postMessage({ type: 'progress', pct }); }
    }
  }).catch(e => { ttsP = null; throw e; }));
}

// Hàng đợi: từ/cụm từ anh vừa chạm được làm trước các câu đang tạo sẵn.
const queue = [];
let busy = false;
self.onmessage = ({ data }) => {
  if (data.type === 'cancel') { for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].prio) queue.splice(i, 1); return; }
  if (data.prio) queue.unshift(data); else queue.push(data);
  run();
};
async function run() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const { id, type, text, voice } = queue.shift();
    try {
      const tts = await getTts();
      if (type === 'load') { self.postMessage({ id, ok: true }); continue; }
      const a = await tts.generate(text, { voice });
      const f = a.audio, pcm = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
      self.postMessage({ id, ok: true, pcm }, [pcm.buffer]);
    } catch (e) {
      self.postMessage({ id, ok: false, err: String((e && e.message) || e) });
    }
  }
  busy = false;
}
