'use strict';
const APP_VERSION = '0.1';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------- Lưu trữ (localStorage, riêng từng máy) ----------
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('eh.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('eh.' + k, JSON.stringify(v)); } catch (e) { toast('Không lưu được dữ liệu trên máy này.'); }
  }
};
const settings = Object.assign({ key: '', model: 'gemini-2.5-flash', rate: 0.9, voice: '', showVi: true }, store.get('settings', {}));
const lessons = store.get('lessons', []);
let vocab = store.get('vocab', []);
let cache = store.get('lookup', {});
const saveSettings = () => store.set('settings', settings);
const saveLessons = () => store.set('lessons', lessons);
const saveVocab = () => store.set('vocab', vocab);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- Điều hướng ----------
let current = null;
function show(view) {
  for (const v of ['library', 'reader', 'vocab', 'settings']) $('#' + v).hidden = v !== view;
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  $('#player').hidden = view !== 'reader';
  if (view !== 'reader') { pause(); closeSheet(); }
  if (view === 'library') renderLibrary();
  if (view === 'vocab') renderVocab();
  if (view === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

// ---------- Tách câu, tách từ ----------
const ABBR = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|Inc|Ltd|Co|No|U\.S|a\.m|p\.m)\.$/i;
function splitSentences(text) {
  const out = [];
  text.replace(/\r/g, '').split(/\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .forEach((para, p) => {
      const parts = para.split(/(?<=[.!?…]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/);
      let buf = '';
      for (const part of parts) {
        buf = buf ? buf + ' ' + part : part;
        if (ABBR.test(buf)) continue;
        out.push({ en: buf, vi: '', p }); buf = '';
      }
      if (buf) out.push({ en: buf, vi: '', p });
    });
  return out;
}
function tokenize(s) {
  const out = []; const re = /[A-Za-z0-9][A-Za-z0-9'’\-]*/g; let m, last = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: s.slice(last, m.index) });
    out.push({ t: m[0], w: true, c: m.index });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: s.slice(last) });
  return out;
}

// ---------- Nhập bài ----------
async function importFile(file) {
  let text;
  try {
    if (/\.docx$/i.test(file.name)) {
      if (!window.mammoth) throw new Error('chưa tải được thư viện đọc Word, kiểm tra mạng');
      const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      text = r.value;
    } else if (/\.txt$/i.test(file.name)) {
      text = await file.text();
    } else {
      toast('Chỉ đọc được file .docx hoặc .txt (file .doc cũ: mở bằng Word rồi lưu lại dạng .docx).');
      return;
    }
  } catch (e) { toast('Không đọc được file: ' + e.message); return; }
  createLesson(file.name.replace(/\.[^.]+$/, ''), text);
}
function createLesson(title, text) {
  const sentences = splitSentences(text);
  if (!sentences.length) { toast('Không tìm thấy nội dung tiếng Anh trong file.'); return; }
  const L = { id: Date.now().toString(36), title: title || sentences[0].en.slice(0, 50), created: Date.now(), pos: 0, sentences };
  lessons.unshift(L); saveLessons();
  openLesson(L);
  translateLesson(L);
}

// ---------- Dịch ----------
async function gemini(prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(settings.model) + ':generateContent';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, ''));
}
function decodeEntities(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }
async function myMemory(q) {
  const r = await fetch('https://api.mymemory.translated.net/get?langpair=en|vi&q=' + encodeURIComponent(q.slice(0, 480)));
  const j = await r.json();
  if (Number(j.responseStatus) !== 200) throw new Error(j.responseDetails || 'MyMemory lỗi');
  return decodeEntities(j.responseData.translatedText).replace(/^[-–\s]+/, '').trim();
}

const translating = new Set();
async function translateLesson(L) {
  if (translating.has(L.id)) return;
  const todo = L.sentences.map((s, i) => i).filter(i => !L.sentences[i].vi);
  if (!todo.length) return;
  translating.add(L.id);
  let done = L.sentences.length - todo.length;
  const step = () => { if (current === L) $('#trStatus').textContent = `Đang dịch ${done}/${L.sentences.length}…`; };
  step();
  try {
    if (settings.key) {
      for (let k = 0; k < todo.length; k += 25) {
        const idx = todo.slice(k, k + 25);
        const src = idx.map(i => L.sentences[i].en);
        const vis = await gemini(
          'Dịch từng câu tiếng Anh sau sang tiếng Việt tự nhiên, dễ hiểu, sát nghĩa, cho người Việt học tiếng Anh. ' +
          'Các câu thuộc cùng một bài, giữ mạch văn. Trả về đúng một mảng JSON gồm ' + src.length +
          ' chuỗi, cùng thứ tự, không thêm gì khác.\n' + JSON.stringify(src));
        if (!Array.isArray(vis)) throw new Error('Gemini trả về sai định dạng');
        idx.forEach((i, j) => { if (vis[j]) L.sentences[i].vi = String(vis[j]); });
        done += idx.length; saveLessons(); refreshVi(L, idx); step();
      }
    } else {
      for (const i of todo) {
        L.sentences[i].vi = await myMemory(L.sentences[i].en);
        done++; saveLessons(); refreshVi(L, [i]); step();
      }
    }
  } catch (e) {
    toast('Lỗi dịch: ' + e.message);
  } finally {
    translating.delete(L.id);
    if (current === L) {
      const left = L.sentences.filter(s => !s.vi).length;
      $('#trStatus').textContent = left ? `Còn ${left} câu chưa dịch` : '';
    }
  }
}
function refreshVi(L, idx) {
  if (current !== L) return;
  for (const i of idx) {
    const d = document.querySelector(`.sent[data-i="${i}"] .vi`);
    if (d) d.textContent = L.sentences[i].vi || '…';
  }
}

// ---------- Tra từ ----------
async function dictIpa(w) {
  try {
    const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w.toLowerCase()));
    if (!r.ok) return '';
    const j = await r.json();
    const ph = j.flatMap(e => e.phonetics || []).filter(p => p.text);
    const us = ph.find(p => /-us\.mp3$/.test(p.audio || '')) || ph[0] || {};
    return us.text || j[0]?.phonetic || '';
  } catch (e) { return ''; }
}
async function lookup(phrase, sentence) {
  const k = (settings.key ? 'g|' : 'f|') + phrase.toLowerCase() + '|' + sentence;
  if (cache[k]) return cache[k];
  let res;
  if (settings.key) {
    res = await gemini(
      'Bạn là từ điển Anh–Việt cho người Việt học tiếng Anh.\n' +
      'Từ/cụm từ: ' + JSON.stringify(phrase) + '\nCâu ngữ cảnh: ' + JSON.stringify(sentence) + '\n' +
      'Trả về JSON với các khóa: "ipa" (phiên âm IPA giọng Anh–Mỹ, đặt trong /…/), ' +
      '"pos" (từ loại bằng tiếng Việt, vd: danh từ, động từ, tính từ, cụm động từ, thành ngữ), ' +
      '"lemma" (dạng gốc nếu khác, vd became → become; nếu giống thì để rỗng), ' +
      '"meaning" (nghĩa tiếng Việt đúng trong câu này, ngắn gọn), ' +
      '"other" (1–3 nghĩa phổ biến khác, ngắn, có thể rỗng).');
  } else {
    const words = phrase.split(/\s+/);
    const ipas = await Promise.all(words.map(dictIpa));
    res = {
      ipa: ipas.filter(Boolean).length ? '/' + ipas.map(x => x.replace(/^\/|\/$/g, '') || '?').join(' ') + '/' : '',
      pos: '', lemma: '', meaning: await myMemory(phrase), other: ''
    };
  }
  cache[k] = res;
  const keys = Object.keys(cache);
  if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(x => delete cache[x]);
  store.set('lookup', cache);
  return res;
}

// ---------- Giọng đọc ----------
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang));
  if (!$('#settings').hidden) renderSettings();
}
function getVoice() {
  return voices.find(v => v.name === settings.voice)
    || voices.find(v => /en[-_]US/i.test(v.lang) && /Samantha|Aria|Jenny|Google US/i.test(v.name))
    || voices.find(v => /en[-_]US/i.test(v.lang)) || voices[0] || null;
}
function utter(text, rate) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = rate;
  const v = getVoice(); if (v) u.voice = v;
  return u;
}
let playing = false, finished = false, runId = 0, curUtter = null;
function stopSpeech() { runId++; if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel(); }
function speakOnce(text, rate) {
  if (playing) pause(); else stopSpeech();
  curUtter = utter(text, rate || settings.rate);
  speechSynthesis.speak(curUtter);
}

// ---------- Màn hình đọc ----------
function openLesson(L) {
  current = L;
  $('#lessonTitle').textContent = L.title;
  $('#trStatus').textContent = '';
  const box = $('#text'); box.textContent = '';
  L.sentences.forEach((s, i) => {
    const d = el('div', 'sent'); d.dataset.i = i;
    if (i > 0 && s.p !== L.sentences[i - 1].p) d.classList.add('newpara');
    const en = el('div', 'en');
    for (const t of tokenize(s.en)) {
      if (t.w) { const sp = el('span', 'w', t.t); sp.dataset.c = t.c; en.appendChild(sp); }
      else en.appendChild(document.createTextNode(t.t));
    }
    d.append(el('div', 'vi', s.vi || '…'), en);
    box.appendChild(d);
  });
  $('#progress').max = Math.max(0, L.sentences.length - 1);
  show('reader');
  setPos(Math.min(L.pos || 0, L.sentences.length - 1), false);
  if (L.sentences.some(s => !s.vi)) translateLesson(L);
}
function setPos(i, scroll = true) {
  if (!current) return;
  finished = false;
  current.pos = i; saveLessons();
  $('#progress').value = i;
  document.querySelectorAll('.sent.cur').forEach(x => x.classList.remove('cur'));
  markWord(-1);
  const d = document.querySelector(`.sent[data-i="${i}"]`);
  if (d) { d.classList.add('cur'); if (scroll) d.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
function markWord(ci) {
  document.querySelectorAll('.w.reading').forEach(x => x.classList.remove('reading'));
  if (ci < 0 || !current) return;
  const spans = document.querySelectorAll(`.sent[data-i="${current.pos}"] .w`);
  let hit = null;
  for (const sp of spans) { if (Number(sp.dataset.c) <= ci) hit = sp; else break; }
  if (hit) hit.classList.add('reading');
}
function speakSentence() {
  stopSpeech();
  const id = runId, i = current.pos;
  setPos(i);
  const u = utter(current.sentences[i].en, settings.rate);
  u.onboundary = e => { if (id === runId && e.name !== 'sentence') markWord(e.charIndex); };
  u.onend = () => {
    if (id !== runId || !playing) return;
    if (current.pos < current.sentences.length - 1) { current.pos++; speakSentence(); }
    else { playing = false; finished = true; updatePlay(); markWord(-1); }
  };
  u.onerror = e => {
    if (id !== runId || e.error === 'interrupted' || e.error === 'canceled') return;
    playing = false; updatePlay(); toast('Lỗi giọng đọc: ' + e.error);
  };
  curUtter = u;
  speechSynthesis.speak(u);
}
function play() {
  if (!current) return;
  closeSheet();
  if (finished) { current.pos = 0; finished = false; }
  playing = true; updatePlay(); speakSentence();
}
function pause() { playing = false; stopSpeech(); updatePlay(); markWord(-1); }
function updatePlay() { $('#play').textContent = playing ? '⏸' : '▶'; }
function jump(i) {
  if (!current) return;
  i = Math.max(0, Math.min(current.sentences.length - 1, i));
  if (playing) { current.pos = i; speakSentence(); } else setPos(i);
}

// ---------- Bảng tra từ ----------
let selN = null, lookSeq = 0;
function selSpans() {
  return [...document.querySelectorAll(`.sent[data-i="${selN.si}"] .w`)].slice(selN.a, selN.b + 1);
}
function selText() {
  const sp = selSpans(); const s = current.sentences[selN.si].en;
  const first = sp[0], last = sp[sp.length - 1];
  return s.slice(Number(first.dataset.c), Number(last.dataset.c) + last.textContent.length);
}
function openWord(span) {
  const sd = span.closest('.sent'); const si = Number(sd.dataset.i);
  const all = [...sd.querySelectorAll('.w')];
  selN = { si, a: all.indexOf(span), b: all.indexOf(span), n: all.length };
  showSel(true);
}
function showSel(speak) {
  document.querySelectorAll('.w.sel').forEach(x => x.classList.remove('sel'));
  selSpans().forEach(x => x.classList.add('sel'));
  const phrase = selText(), sentence = current.sentences[selN.si].en;
  $('#sheet').hidden = false;
  $('#shText').textContent = phrase;
  $('#shIpa').textContent = '';
  $('#shLeft').disabled = selN.a === 0;
  $('#shRight').disabled = selN.b === selN.n - 1;
  const body = $('#shBody'); body.textContent = 'Đang tra…';
  if (speak) speakOnce(phrase);
  const seq = ++lookSeq;
  lookup(phrase, sentence).then(r => {
    if (seq !== lookSeq) return;
    selN.result = r;
    $('#shIpa').textContent = r.ipa || '';
    body.textContent = '';
    const pos = [r.pos, r.lemma ? 'gốc: ' + r.lemma : ''].filter(Boolean).join(' · ');
    if (pos) body.appendChild(el('div', 'pos', pos));
    body.appendChild(el('div', 'm', r.meaning || '(không có nghĩa)'));
    if (r.other) body.appendChild(el('div', 'o', 'Nghĩa khác: ' + r.other));
    const vi = current.sentences[selN.si].vi;
    if (vi) body.appendChild(el('div', 'ex', vi));
  }).catch(e => { if (seq === lookSeq) body.textContent = 'Lỗi tra từ: ' + e.message; });
}
function closeSheet() {
  $('#sheet').hidden = true; lookSeq++;
  document.querySelectorAll('.w.sel').forEach(x => x.classList.remove('sel'));
  selN = null;
}
function saveWord() {
  if (!selN) return;
  const text = selText(), r = selN.result || {};
  if (vocab.some(v => v.text.toLowerCase() === text.toLowerCase())) { toast('Từ này đã có trong sổ.'); return; }
  vocab.unshift({
    id: Date.now().toString(36), text, ipa: r.ipa || '', pos: r.pos || '', meaning: r.meaning || '',
    sentence: current.sentences[selN.si].en, lesson: current.title, added: Date.now()
  });
  saveVocab(); toast('Đã lưu “' + text + '” vào sổ từ.');
}

// ---------- Thư viện, sổ từ, cài đặt ----------
function renderLibrary() {
  $('#keyHint').hidden = !!settings.key;
  const ul = $('#lessonList'); ul.textContent = '';
  if (!lessons.length) { ul.appendChild(el('li', 's', 'Chưa có bài học. Bấm “Tải file Word” để bắt đầu.')); return; }
  for (const L of lessons) {
    const li = el('li'); const m = el('div', 'main');
    const left = L.sentences.filter(s => !s.vi).length;
    m.append(el('div', 't', L.title),
      el('div', 's', `${L.sentences.length} câu · ${new Date(L.created).toLocaleDateString('vi-VN')}` + (left ? ` · còn ${left} câu chưa dịch` : '')));
    m.onclick = () => openLesson(L);
    const del = el('button', 'del', '🗑'); del.title = 'Xóa bài';
    del.onclick = () => {
      if (!confirm('Xóa bài “' + L.title + '”?')) return;
      lessons.splice(lessons.indexOf(L), 1); saveLessons(); renderLibrary();
    };
    li.append(m, del); ul.appendChild(li);
  }
}
function renderVocab() {
  const ul = $('#vocabList'); ul.textContent = '';
  if (!vocab.length) { ul.appendChild(el('li', 's', 'Chưa có từ nào. Khi đọc, chạm vào từ rồi bấm ★ Lưu.')); return; }
  for (const v of vocab) {
    const li = el('li', 'vw'); const m = el('div', 'main');
    const head = el('div', 't', v.text + ' '); head.appendChild(el('span', 'ipa', v.ipa));
    m.append(head, el('div', 'm', (v.pos ? v.pos + ' · ' : '') + v.meaning), el('div', 'ex', v.sentence));
    m.onclick = () => speakOnce(v.text);
    const del = el('button', 'del', '🗑'); del.title = 'Xóa từ';
    del.onclick = () => { vocab = vocab.filter(x => x !== v); saveVocab(); renderVocab(); };
    li.append(m, del); ul.appendChild(li);
  }
}
function exportCsv() {
  const q = s => '"' + String(s || '').replace(/"/g, '""') + '"';
  const rows = [['Từ', 'Phiên âm', 'Từ loại', 'Nghĩa', 'Câu ví dụ', 'Bài', 'Ngày lưu']]
    .concat(vocab.map(v => [v.text, v.ipa, v.pos, v.meaning, v.sentence, v.lesson, new Date(v.added).toLocaleDateString('vi-VN')]));
  const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = 'so_tu_vung.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function renderSettings() {
  $('#setKey').value = settings.key;
  $('#setModel').value = settings.model;
  $('#setVi').checked = settings.showVi;
  const sel = $('#setVoice'); sel.textContent = '';
  const us = voices.filter(v => /en[-_]US/i.test(v.lang)), rest = voices.filter(v => !/en[-_]US/i.test(v.lang));
  const cur = getVoice();
  for (const v of us.concat(rest)) {
    const o = el('option', null, `${v.name} (${v.lang})`); o.value = v.name;
    if (cur && v.name === cur.name) o.selected = true;
    sel.appendChild(o);
  }
  if (!voices.length) sel.appendChild(el('option', null, 'Đang tải giọng đọc…'));
  $('#ver').textContent = APP_VERSION;
}
function applyVi() { document.body.classList.toggle('hide-vi', !settings.showVi); }

// ---------- Gắn sự kiện ----------
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav').forEach(b => b.onclick = () => show(b.dataset.view));
  $('#file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
  $('#pasteToggle').onclick = () => { $('#pasteBox').hidden = !$('#pasteBox').hidden; };
  $('#pasteSave').onclick = () => {
    const t = $('#pasteText').value.trim(); if (!t) return;
    createLesson($('#pasteTitle').value.trim(), t);
    $('#pasteText').value = ''; $('#pasteTitle').value = ''; $('#pasteBox').hidden = true;
  };

  $('#text').addEventListener('click', e => {
    const w = e.target.closest('.w');
    if (w) { openWord(w); return; }
    const vi = e.target.closest('.vi');
    if (vi) { const i = Number(vi.parentElement.dataset.i); closeSheet(); current.pos = i; playing = true; updatePlay(); speakSentence(); }
  });
  $('#play').onclick = () => (playing ? pause() : play());
  $('#prev').onclick = () => jump(current.pos - 1);
  $('#next').onclick = () => jump(current.pos + 1);
  $('#progress').oninput = e => jump(Number(e.target.value));
  $('#rate').value = settings.rate;
  $('#rateLbl').textContent = settings.rate.toFixed(1) + '×';
  $('#rate').oninput = e => { settings.rate = Number(e.target.value); $('#rateLbl').textContent = settings.rate.toFixed(1) + '×'; saveSettings(); };
  $('#viToggle').onclick = () => { settings.showVi = !settings.showVi; saveSettings(); applyVi(); };

  $('#shLeft').onclick = () => { if (selN.a > 0) { selN.a--; showSel(true); } };
  $('#shRight').onclick = () => { if (selN.b < selN.n - 1) { selN.b++; showSel(true); } };
  $('#shSpeak').onclick = () => selN && speakOnce(selText());
  $('#shSlow').onclick = () => selN && speakOnce(selText(), 0.6);
  $('#shSave').onclick = saveWord;
  $('#shClose').onclick = closeSheet;

  $('#exportCsv').onclick = exportCsv;
  $('#setKey').onchange = e => { settings.key = e.target.value.trim(); saveSettings(); };
  $('#setModel').onchange = e => { settings.model = e.target.value.trim() || 'gemini-2.5-flash'; saveSettings(); };
  $('#setVoice').onchange = e => { settings.voice = e.target.value; saveSettings(); };
  $('#setVi').onchange = e => { settings.showVi = e.target.checked; saveSettings(); applyVi(); };
  $('#testVoice').onclick = () => speakOnce('Hello! This is how I will read your lessons.');
  $('#testKey').onclick = async () => {
    settings.key = $('#setKey').value.trim(); settings.model = $('#setModel').value.trim() || 'gemini-2.5-flash'; saveSettings();
    if (!settings.key) { toast('Chưa nhập khóa.'); return; }
    try { const r = await gemini('Trả về JSON {"ok": true}'); toast(r && r.ok ? 'Khóa hoạt động tốt.' : 'Khóa phản hồi bất thường.'); }
    catch (e) { toast('Khóa lỗi: ' + e.message); }
  };

  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  } else toast('Trình duyệt này không hỗ trợ đọc giọng nói.');
  applyVi();
  show('library');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
});
