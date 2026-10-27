'use strict';
const APP_VERSION = '0.8';
const DEFAULT_MODEL = 'gemini-3.8-flash';

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
const settings = Object.assign({ key: '', model: DEFAULT_MODEL, rate: 0.9, voice: '', showVi: true }, store.get('settings', {}));
if (!settings.model || settings.model === 'gemini-2.5-flash') settings.model = DEFAULT_MODEL;
// v0.6: chuyển mặc định sang giọng AI (giọng máy iPhone không dùng được bản Cao cấp, tắt màn hình thì ngừng đọc).
if (settings.voiceV !== 6) { settings.voice = 'ai:af_heart'; settings.voiceV = 6; }
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
const GAPI = 'https://generativelanguage.googleapis.com/v1beta/models';
// fetch có giới hạn thời gian chờ.
async function fetchT(url, opt, ms, what) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opt, { signal: ctl.signal })); }
  catch (e) { throw new Error(e.name === 'AbortError' ? what + ' không trả lời sau ' + ms / 1000 + ' giây' : 'không kết nối được ' + what + ' (' + e.message + ')'); }
  finally { clearTimeout(timer); }
}
// Danh sách mô hình khóa được dùng: Gemini Flash (chất lượng cao, chỉ ~20 lượt/ngày mỗi mô hình) trước,
// rồi Gemma (hạn mức miễn phí lớn, hàng nghìn lượt/ngày) làm nguồn dự phòng chính.
const isGemma = n => /^gemma-/.test(n);
async function listModels() {
  const r = await fetchT(GAPI + '?pageSize=200', { headers: { 'x-goog-api-key': settings.key } }, 20000, 'Google');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  const names = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''));
  const re = /^gemini-([\d.]+)-flash(-lite)?$/;
  const key = n => { const m = n.match(re); const v = m[1].split('.').map(Number); return [m[2] ? 1 : 0, -v[0], -(v[1] || 0)]; };
  const flash = names.filter(n => re.test(n))
    .sort((a, b) => { const x = key(a), y = key(b); return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); });
  // Gemma bản lớn (vd gemma-3-27b-it): phiên bản mới trước, cỡ lớn trước; lấy 2 mô hình.
  const gre = /^gemma-(\d+)-(\d+)b-it$/;
  const gemma = names.filter(n => gre.test(n) && +n.match(gre)[2] >= 12)
    .sort((a, b) => { const x = a.match(gre), y = b.match(gre); return (y[1] - x[1]) || (y[2] - x[2]); })
    .slice(0, 2);
  return flash.concat(gemma);
}
// Mỗi mô hình có hạn mức miễn phí riêng: hết lượt ngày thì đánh dấu và chuyển mô hình,
// hết lượt theo phút thì chờ rồi gọi lại chính mô hình đó.
const isQuota = msg => /quota|exceeded|resource.?exhausted|rate limit|HTTP 429/i.test(msg);
const isSkip = msg => /no longer available|not found|not supported|deprecated|không trả lời sau/i.test(msg);
const isPerMinute = msg => /PerMinute/i.test(msg) || (!/PerDay/i.test(msg) && waitMs(msg) <= 90000);
function waitMs(msg) {
  const m = msg.match(/retry(?: in|Delay[":\s]*)\s*(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  return m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : 0;
}
// Hạn mức ngày của Google đặt lại lúc 0 giờ giờ Thái Bình Dương (khoảng 14–15 giờ Viêng Chăn).
function nextReset() {
  const d = new Date(); d.setUTCHours(7, 5, 0, 0);
  if (d <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function modelList(refresh) {
  if (!refresh && settings.models && settings.modelsV === 2 && Date.now() - (settings.modelsAt || 0) < 864e5) return settings.models;
  settings.models = await listModels(); settings.modelsAt = Date.now(); settings.modelsV = 2; saveSettings();
  return settings.models;
}
function modelOrder(names) {
  return [settings.model].filter(n => names.includes(n)).concat(names.filter(n => n !== settings.model));
}
// Thử lần lượt từng mô hình, giữ lại mô hình đầu tiên trả lời được.
async function findWorkingModel(onStep) {
  const names = await modelList(true);
  if (!names.length) throw new Error('khóa này không có mô hình Gemini Flash / Gemma nào');
  const fails = [], ex = settings.exhausted || (settings.exhausted = {});
  for (const m of modelOrder(names).slice(0, 10)) {
    if (ex[m] > Date.now()) { fails.push(m + ': đang hết lượt'); continue; }
    if (onStep) onStep(m);
    try {
      const r = await geminiCall('Trả về JSON {"ok": true}', m, isGemma(m) ? 40000 : 25000);
      if (r && r.ok) { settings.model = m; saveSettings(); return { model: m, fails }; }
      fails.push(m + ': trả lời sai dạng');
    } catch (e) {
      if (isQuota(e.message)) {
        if (!isPerMinute(e.message)) { ex[m] = nextReset(); saveSettings(); }
        fails.push(m + ': hết lượt miễn phí');
      } else fails.push(m + ': ' + e.message);
    }
  }
  throw new Error('không mô hình nào trả lời được.\n' + fails.join('\n'));
}
// onWait(msg): báo trạng thái khi phải chờ hạn mức theo phút.
async function gemini(prompt, ms, onWait) {
  let names = [];
  try { names = await modelList(); } catch (e) { /* vẫn thử mô hình đang chọn */ }
  const ex = settings.exhausted || (settings.exhausted = {});
  let lastErr = null, soonest = Infinity;
  for (const m of modelOrder(names.length ? names : [settings.model])) {
    if (ex[m] > Date.now()) { soonest = Math.min(soonest, ex[m]); continue; }
    for (let tries = 0; ; tries++) {
      try {
        const r = await geminiCall(prompt, m, isGemma(m) ? Math.max(ms || 0, 180000) : ms);
        // Gemma chỉ là dự phòng: không lưu làm mô hình chính để hôm sau vẫn ưu tiên Flash.
        if (m !== settings.model && !isGemma(m)) { settings.model = m; saveSettings(); }
        return r;
      } catch (e) {
        lastErr = e;
        if (isQuota(e.message) && isPerMinute(e.message) && tries < 4) {
          const w = Math.min(Math.max(waitMs(e.message), 5000) + 2000, 90000);
          if (onWait) onWait('chờ ' + Math.ceil(w / 1000) + ' giây (giới hạn lượt/phút của ' + m + ')');
          await sleep(w); continue;
        }
        if (isQuota(e.message)) { ex[m] = isPerMinute(e.message) ? Date.now() + 300000 : nextReset(); soonest = Math.min(soonest, ex[m]); saveSettings(); }
        else if (!isSkip(e.message) && !/JSON|định dạng/i.test(e.message)) throw e;
        break;
      }
    }
  }
  if (soonest < Infinity) throw new Error('QUOTA: đã hết lượt miễn phí của mọi mô hình, có lại sau khoảng ' + Math.ceil((soonest - Date.now()) / 60000) + ' phút');
  throw lastErr || new Error('không gọi được Gemini');
}
// Lấy phần JSON trong câu trả lời (Gemma không có chế độ JSON, đôi khi kèm chữ hoặc ```).
function parseJson(t) {
  t = t.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(t); } catch (e) { /* tìm khối JSON bên trong */ }
  const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (a < 0 || b <= a) throw new Error('mô hình trả về sai định dạng JSON');
  return JSON.parse(t.slice(a, b + 1));
}
async function geminiCall(prompt, model, ms) {
  model = model || settings.model;
  const url = GAPI + '/' + encodeURIComponent(model) + ':generateContent';
  const cfg = { temperature: 0.2 };
  if (!isGemma(model)) {
    cfg.responseMimeType = 'application/json';
    // Giảm "suy nghĩ" để trả lời nhanh (tham số khác nhau theo thế hệ mô hình).
    if (!settings.noThinkCfg) {
      if (/^gemini-2\./.test(model)) cfg.thinkingConfig = { thinkingBudget: 0 };
      else cfg.thinkingConfig = { thinkingLevel: 'low' };
    }
  }
  const r = await fetchT(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: cfg })
  }, ms || 90000, 'Gemini');
  if (r.status === 400 && cfg.thinkingConfig) {
    const e = await r.clone().json().catch(() => ({}));
    if (/thinking/i.test((e.error && e.error.message) || '')) { settings.noThinkCfg = true; saveSettings(); return geminiCall(prompt, model, ms); }
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Ghép thêm loại hạn mức (PerMinute / PerDay) và thời gian chờ từ phần chi tiết lỗi.
    const det = (j.error && j.error.details) || [];
    const ids = det.flatMap(d => (d.violations || []).map(v => v.quotaId || '')).filter(Boolean).join(',');
    const delay = (det.find(d => d.retryDelay) || {}).retryDelay;
    throw new Error(((j.error && j.error.message) || '') + ' (HTTP ' + r.status + ')' + (ids ? ' [' + ids + ']' : '') + (delay ? ' retryDelay ' + delay : ''));
  }
  const t = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  return parseJson(t);
}
function decodeEntities(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }
async function myMemory(q) {
  const r = await fetch('https://api.mymemory.translated.net/get?langpair=en|vi&q=' + encodeURIComponent(q.slice(0, 480)));
  const j = await r.json();
  if (Number(j.responseStatus) !== 200) throw new Error(j.responseDetails || 'MyMemory lỗi');
  return decodeEntities(j.responseData.translatedText).replace(/^[-–\s]+/, '').trim();
}

const translating = new Set();
const normKey = w => String(w).toLowerCase().replace(/’/g, "'").trim();
// Dịch câu và soạn sẵn từ điển cho mọi từ trong câu, 10 câu mỗi lượt gọi Gemini.
const GLOSS_PROMPT = 'Bạn soạn bài học cho người Việt học tiếng Anh (giọng Anh–Mỹ). Với MỖI câu trong mảng đầu vào, trả về một đối tượng JSON:\n' +
  '{"vi": bản dịch tiếng Việt tự nhiên, sát nghĩa, giữ mạch văn của cả bài,\n' +
  ' "w": {"từ viết thường đúng như trong câu": ["IPA Anh–Mỹ trong /…/", "từ loại tiếng Việt ngắn", "nghĩa tiếng Việt đúng trong câu này", "dạng gốc nếu khác, không thì \\"\\""]},\n' +
  ' "ph": [["cụm động từ / thành ngữ / cụm cố định có trong câu", "IPA", "loại", "nghĩa trong câu"]]}\n' +
  '"w" phải có MỌI từ trong câu (kể cả a, the, is, số). "ph" có thể rỗng. Chỉ trả về một mảng JSON đúng số phần tử, cùng thứ tự.\n';
async function translateLesson(L) {
  if (translating.has(L.id)) return;
  const need = s => !s.vi || (settings.key && !s.g);
  const todo = L.sentences.map((s, i) => i).filter(i => need(L.sentences[i]));
  if (!todo.length) return;
  translating.add(L.id);
  let done = L.sentences.length - todo.length, useFree = !settings.key;
  const step = () => { if (current === L) $('#trStatus').textContent = `Đang dịch & soạn từ điển ${done}/${L.sentences.length}…`; };
  step();
  try {
    if (settings.key) {
      try {
        for (let k = 0; k < todo.length; k += 8) {
          const idx = todo.slice(k, k + 8);
          const res = await gemini(GLOSS_PROMPT + JSON.stringify(idx.map(i => L.sentences[i].en)), 120000,
            msg => { if (current === L) $('#trStatus').textContent = `Đã dịch ${done}/${L.sentences.length} — ${msg}…`; });
          if (!Array.isArray(res)) throw new Error('Gemini trả về sai định dạng');
          idx.forEach((i, j) => {
            const x = res[j] || {}, s = L.sentences[i];
            if (x.vi) s.vi = String(x.vi);
            s.g = {};
            for (const [w, v] of Object.entries(x.w || {})) if (Array.isArray(v)) s.g[normKey(w)] = v.map(String);
            s.ph = Array.isArray(x.ph) ? x.ph.filter(a => Array.isArray(a) && a[0]).map(a => a.map(String)) : [];
          });
          done += idx.length; saveLessons(); refreshVi(L, idx); step();
        }
      } catch (e) {
        useFree = true;
        toast((isQuota(e.message) ? e.message.replace(/^QUOTA: /, 'Gemini ') : 'Lỗi Gemini: ' + e.message) + '. Tạm dịch bằng nguồn miễn phí.');
      }
    }
    if (useFree) {
      for (const i of L.sentences.map((s, i) => i).filter(i => !L.sentences[i].vi)) {
        L.sentences[i].vi = await myMemory(L.sentences[i].en);
        saveLessons(); refreshVi(L, [i]);
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
// Tra trong từ điển đã soạn sẵn của câu (không tốn lượt Gemini).
function quickLookup(phrase, si) {
  const s = current.sentences[si], key = normKey(phrase);
  const p = (s.ph || []).find(x => normKey(x[0]) === key);
  if (p) return { ipa: p[1], pos: p[2], meaning: p[3], lemma: '', other: '' };
  if (s.g && s.g[key]) { const [ipa, pos, meaning, lemma] = s.g[key]; return { ipa, pos, meaning, lemma: lemma && normKey(lemma) !== key ? lemma : '', other: '' }; }
  const k = (settings.key ? 'g|' : 'f|') + phrase.toLowerCase() + '|' + s.en;
  return cache[k] || null;
}
async function freeLookup(phrase) {
  const ipas = await Promise.all(phrase.split(/\s+/).map(dictIpa));
  return {
    ipa: ipas.filter(Boolean).length ? '/' + ipas.map(x => x.replace(/^\/|\/$/g, '') || '?').join(' ') + '/' : '',
    pos: '', lemma: '', meaning: await myMemory(phrase), other: ''
  };
}
async function lookup(phrase, si) {
  const quick = quickLookup(phrase, si);
  if (quick) return quick;
  const sentence = current.sentences[si].en;
  const k = (settings.key ? 'g|' : 'f|') + phrase.toLowerCase() + '|' + sentence;
  let res;
  if (settings.key) {
    try { res = await gemini(
      'Bạn là từ điển Anh–Việt cho người Việt học tiếng Anh.\n' +
      'Từ/cụm từ: ' + JSON.stringify(phrase) + '\nCâu ngữ cảnh: ' + JSON.stringify(sentence) + '\n' +
      'Trả về JSON với các khóa: "ipa" (phiên âm IPA giọng Anh–Mỹ, đặt trong /…/), ' +
      '"pos" (từ loại bằng tiếng Việt, vd: danh từ, động từ, tính từ, cụm động từ, thành ngữ), ' +
      '"lemma" (dạng gốc nếu khác, vd became → become; nếu giống thì để rỗng), ' +
      '"meaning" (nghĩa tiếng Việt đúng trong câu này, ngắn gọn), ' +
      '"other" (1–3 nghĩa phổ biến khác, ngắn, có thể rỗng).', 25000); }
    catch (e) {
      if (!isQuota(e.message) && !isSkip(e.message)) throw e;
      res = await freeLookup(phrase);
      res.note = 'Gemini đang hết lượt — nghĩa lấy từ nguồn dự phòng.';
      return res;
    }
  } else res = await freeLookup(phrase);
  cache[k] = res;
  const keys = Object.keys(cache);
  if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(x => delete cache[x]);
  store.set('lookup', cache);
  return res;
}

// ---------- Giọng đọc ----------
let voices = [];
// Giọng hiệu ứng của Apple (không phải giọng người đọc bình thường).
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Princess|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const PREFERRED = /Samantha|Ava|Allison|Susan|Zoe|Nicky|Evan|Nathan|Tom|Aaron|Aria|Jenny|Guy|Google US/i;
function loadVoices() {
  voices = speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang) && !NOVELTY.test(v.name));
  if (!$('#settings').hidden) renderSettings();
}
function getVoice() {
  const us = voices.filter(v => /en[-_]US/i.test(v.lang));
  return voices.find(v => v.name === settings.voice)
    || us.find(v => /Premium|Cao cấp/i.test(v.name))
    || us.find(v => /Enhanced|Natural|Nâng cao/i.test(v.name))
    || us.find(v => PREFERRED.test(v.name))
    || us[0] || voices[0] || null;
}
function utter(text, rate) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = rate;
  const v = getVoice(); if (v) u.voice = v;
  return u;
}
let playing = false, finished = false, runId = 0, curUtter = null;
function stopSpeech() {
  runId++; switchedAt = Date.now();
  if (!au.paused) au.pause();
  if (window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
}
// Đọc một từ/cụm từ: giọng AI nếu đã sẵn sàng, chưa thì tạm dùng giọng của máy.
async function speakOnce(text, rate) {
  if (playing) pause(); else stopSpeech();
  const id = runId;
  if (isAi() && tts) {
    try {
      const k = aiVoice() + '|' + text.toLowerCase();
      let pcm = wordClips.get(k);
      if (!pcm) { pcm = await synth(text, true); wordClips.set(k, pcm); if (wordClips.size > 200) wordClips.delete(wordClips.keys().next().value); }
      if (id !== runId) return;
      auMode = 'word'; seg = null;
      setAuSrc(wavUrl([pcm]));
      au.playbackRate = rate || settings.rate;
      au.play().catch(() => {});
      return;
    } catch (e) { /* lỗi giọng AI: dùng giọng máy */ }
  }
  if (!window.speechSynthesis) return;
  curUtter = utter(text, rate || settings.rate);
  speechSynthesis.speak(curUtter);
}

// ---------- Giọng AI (Kokoro, chạy ngay trong trình duyệt, miễn phí) ----------
// Tạo sẵn âm thanh từng câu, ghép thành một file phát liền mạch nên vẫn đọc khi tắt màn hình.
const SR = 24000;
const AI_VOICES = [['af_heart', 'Heart — nữ, tự nhiên nhất'], ['af_bella', 'Bella — nữ'], ['af_sarah', 'Sarah — nữ'],
  ['am_michael', 'Michael — nam'], ['am_fenrir', 'Fenrir — nam'], ['am_puck', 'Puck — nam']];
const isAi = () => /^ai:/.test(settings.voice);
const aiVoice = () => settings.voice.slice(3);
const au = new Audio();
au.preservesPitch = true; au.webkitPreservesPitch = true;
let auMode = '', seg = null, auUrl = '';
const wordClips = new Map();
function setAuSrc(url) { if (auUrl) URL.revokeObjectURL(auUrl); auUrl = url; au.src = url; }

// Mô hình chạy trong tts-worker.js; ở đây chỉ gửi yêu cầu và nhận âm thanh về.
let worker = null, tts = false, ttsP = null, reqId = 0;
const reqs = new Map();
function voiceMsg(msg) { const p = $('#voiceStatus'); if (p) { p.hidden = !msg; p.textContent = msg || ''; } }
function ttsCall(msg) {
  if (!worker) {
    worker = new Worker('tts-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        const m = `Đang tải giọng AI ${data.pct}% (lần đầu khoảng 90 MB)…`;
        voiceMsg(m); auMsg(m); return;
      }
      const q = reqs.get(data.id); if (!q) return;
      reqs.delete(data.id);
      data.ok ? q.res(data.pcm) : q.rej(new Error(data.err));
    };
    worker.onerror = e => {
      const err = new Error('không chạy được giọng AI trên trình duyệt này (' + (e.message || 'lỗi luồng') + ')');
      for (const q of reqs.values()) q.rej(err);
      reqs.clear(); worker = null; ttsP = null; tts = false;
    };
  }
  return new Promise((res, rej) => { const id = ++reqId; reqs.set(id, { res, rej }); worker.postMessage(Object.assign({ id }, msg)); });
}
function loadTts() {
  if (!ttsP) {
    voiceMsg('Đang tải giọng AI…');
    ttsP = ttsCall({ type: 'load', prio: true }).then(() => {
      tts = true; voiceMsg('✅ Giọng AI đã sẵn sàng.');
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    }).catch(e => { ttsP = null; voiceMsg('❌ Không tải được giọng AI: ' + e.message + '. Đang dùng giọng của máy.'); throw e; });
  }
  return ttsP;
}
// prio: từ anh vừa chạm (làm ngay), không thì xếp hàng sau.
const synth = (text, prio) => ttsCall({ type: 'gen', text, voice: aiVoice(), prio: !!prio });
// Ghép các đoạn PCM 16-bit thành một file WAV.
function wavUrl(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const p of parts) { new Int16Array(buf, o, p.length).set(p); o += p.length * 2; }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// Lưu âm thanh từng câu trong IndexedDB để lần sau mở bài không phải tạo lại.
let dbP = null;
function db() {
  return dbP || (dbP = new Promise((res, rej) => {
    const r = indexedDB.open('doc-anh-ngu', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('audio');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('audio', mode), q = fn(tx.objectStore('audio'));
    tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error);
  });
}
const clipKey = (L, i) => L.id + '|' + aiVoice() + '|' + i;
function deleteAudio(L) {
  idb('readwrite', s => s.delete(IDBKeyRange.bound(L.id + '|', L.id + '|￿'))).catch(() => {});
}

// clips: âm thanh các câu của bài đang mở (với giọng đang chọn).
let clips = new Map(), clipsFor = '', waiters = [], preparing = '';
function auMsg(msg) { if (current) $('#auStatus').textContent = msg || ''; }
function waitClip(i) { return clips.has(i) ? Promise.resolve() : new Promise(r => waiters.push({ i, r })); }
// i = -1: chờ câu bất kỳ vừa tạo xong.
function gotClip(i, pcm) { clips.set(i, pcm); waiters = waiters.filter(w => (w.i === i || w.i === -1 ? (w.r(), false) : true)); }
const nextClip = () => new Promise(r => waiters.push({ i: -1, r }));
// Tốc độ tạo giọng đo thực tế trên máy này: gen = giây tạo / giây âm thanh, spc = giây âm thanh mỗi ký tự.
const ttsStat = () => settings.ttsStat || { gen: 2.5, spc: 0.065 };
// Bỏ khoảng lặng đầu/cuối mỗi câu (mô hình tự thêm), giữ lại 40 ms cho tự nhiên.
function trim(c) {
  const th = 330, m = Math.round(SR * 0.04);
  let a = 0, b = c.length - 1;
  while (a < b && Math.abs(c[a]) < th) a++;
  while (b > a && Math.abs(c[b]) < th) b--;
  return c.subarray(Math.max(0, a - m), Math.min(c.length, b + m));
}
async function prepareAudio(L) {
  const tag = L.id + '|' + aiVoice();
  if (!isAi() || preparing === tag) return;
  if (clipsFor !== tag) { clips = new Map(); clipsFor = tag; }
  preparing = tag;
  const alive = () => current === L && clipsFor === tag && isAi();
  let wake = null;
  try {
    const n = L.sentences.length;
    const stored = await idb('readonly', s => s.getAll(IDBKeyRange.bound(tag + '|', tag + '|￿')));
    const keys = await idb('readonly', s => s.getAllKeys(IDBKeyRange.bound(tag + '|', tag + '|￿')));
    keys.forEach((k, j) => { const i = Number(k.slice(tag.length + 1)); if (L.sentences[i] && L.sentences[i].en) gotClip(i, new Int16Array(stored[j])); });
    if (clips.size >= n) { auMsg(''); return; }
    try { wake = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) { wake = null; }
    await loadTts();
    // Tạo từ câu đang đọc trở đi, rồi quay lại đầu bài.
    const order = [];
    for (let k = 0; k < n; k++) order.push((L.pos + k) % n);
    for (const i of order) {
      if (!alive()) return;
      if (clips.has(i)) continue;
      auMsg(`Đang tạo giọng AI ${clips.size}/${n} câu — giữ màn hình sáng…`);
      const t0 = Date.now(), pcm = await synth(L.sentences[i].en);
      if (!alive()) return;
      // Cập nhật tốc độ tạo giọng (trung bình trượt) để biết khi nào đủ âm thanh phát liền mạch.
      const sec = pcm.length / SR, st = ttsStat();
      if (sec > 0.5) {
        settings.ttsStat = { gen: st.gen * 0.7 + ((Date.now() - t0) / 1000 / sec) * 0.3, spc: st.spc * 0.7 + (sec / L.sentences[i].en.length) * 0.3 };
        saveSettings();
      }
      gotClip(i, pcm);
      idb('readwrite', s => s.put(pcm.buffer, tag + '|' + i)).catch(() => {});
    }
    auMsg('✅ Giọng AI cả bài đã sẵn sàng — có thể tắt màn hình để nghe.');
    setTimeout(() => { if ($('#auStatus').textContent.startsWith('✅')) auMsg(''); }, 6000);
  } catch (e) {
    auMsg('Lỗi giọng AI: ' + e.message + ' — tạm đọc bằng giọng của máy.');
    const ws = waiters; waiters = []; ws.forEach(w => w.r());
  } finally {
    if (preparing === tag) preparing = '';
    if (wake) wake.release().catch(() => {});
  }
}

// Âm thanh đã có liền từ câu `from` có đủ dài để phát hết trong lúc máy tạo nốt phần còn lại không.
function bufferEnough(from) {
  const S = current.sentences, st = ttsStat();
  let have = 0, i = from;
  for (; i < S.length && clips.has(i); i++) have += clips.get(i).length / SR + 0.3;
  if (i >= S.length) return { ok: true };
  let rest = 0;
  for (let k = i; k < S.length; k++) if (!clips.has(k)) rest += S[k].en.length * st.spc;
  const needGen = rest * st.gen * 1.15, playTime = have / settings.rate;
  return { ok: playTime >= needGen, wait: Math.max(0, needGen - playTime) };
}
// Phát liền mạch từ câu `from`. Nếu máy tạo giọng chậm hơn tốc độ đọc, chờ tạo đủ trước
// để không bị ngắt quãng giữa các câu.
async function aiPlayFrom(from) {
  const id = runId;
  prepareAudio(current);
  for (;;) {
    const b = bufferEnough(from);
    if (b.ok) break;
    if (!preparing) { if (!clips.has(from)) { speakSentence(true); return; } break; }
    const done = current.sentences.filter((s, i) => clips.has(i)).length;
    auMsg(`Đang tạo giọng AI ${done}/${current.sentences.length} câu — khoảng ${Math.max(1, Math.ceil(b.wait / 60))} phút nữa sẽ đọc liền mạch (giữ màn hình sáng)…`);
    await Promise.race([nextClip(), sleep(5000)]);
    if (id !== runId || !playing) return;
  }
  const S = current.sentences, parts = [], offs = [];
  let t = 0;
  for (let i = from; i < S.length && clips.has(i); i++) {
    const c = trim(clips.get(i));
    // Nghỉ ngắn giữa các câu trong một đoạn, dài hơn khi sang đoạn mới.
    const gap = new Int16Array(Math.round(SR * (i + 1 < S.length && S[i + 1].p !== S[i].p ? 0.65 : 0.28)));
    offs.push({ i, start: t, end: t + c.length / SR });
    parts.push(c, gap); t += (c.length + gap.length) / SR;
  }
  if (!offs.length) return;
  if (!preparing || clips.size >= S.length) auMsg('');
  seg = { offs }; auMode = 'lesson'; switchedAt = Date.now();
  setAuSrc(wavUrl(parts));
  au.playbackRate = settings.rate;
  setPos(from);
  try { await au.play(); } catch (e) { if (id === runId) { playing = false; updatePlay(); toast('Không phát được âm thanh: ' + e.message); } }
  mediaSession();
}
au.addEventListener('timeupdate', () => {
  if (auMode !== 'lesson' || !seg || !current) return;
  const t = au.currentTime, o = seg.offs.filter(x => x.start <= t + 0.05).pop() || seg.offs[0];
  if (o.i !== current.pos) setPos(o.i);
  const len = current.sentences[o.i].en.length;
  markWord(t >= o.end ? -1 : Math.floor((t - o.start) / (o.end - o.start) * len));
});
au.addEventListener('ended', () => {
  if (auMode !== 'lesson' || !playing || !seg) return;
  const next = seg.offs[seg.offs.length - 1].i + 1;
  if (next < current.sentences.length) aiPlayFrom(next);
  else if (settings.loop) loopAgain();
  else { playing = false; finished = true; updatePlay(); markWord(-1); }
});
// Bị hệ thống dừng (cuộc gọi, tai nghe rút ra…): cập nhật nút Phát.
let switchedAt = 0;
au.addEventListener('pause', () => {
  if (auMode === 'lesson' && playing && !au.ended && Date.now() - switchedAt > 800) { playing = false; updatePlay(); markWord(-1); }
});
// Mở khóa âm thanh trên iPhone ngay lần chạm đầu tiên.
function unlockAudio() {
  if (au.src) return;
  setAuSrc(wavUrl([new Int16Array(240)]));
  au.play().catch(() => {});
}
// Nút điều khiển trên màn hình khóa.
function mediaSession() {
  if (!('mediaSession' in navigator) || !current) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: current.title, artist: 'Đọc Anh Ngữ',
    artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }]
  });
  const h = { play: () => play(), pause: () => pause(), previoustrack: () => jump(current.pos - 1), nexttrack: () => jump(current.pos + 1) };
  for (const [k, f] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, f); } catch (e) { /* không hỗ trợ */ } }
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
  if (L.sentences.some(s => !s.vi || (settings.key && !s.g))) translateLesson(L);
  $('#auStatus').textContent = '';
  if (isAi()) prepareAudio(L);
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
// sysVoice: bỏ qua giọng AI (khi giọng AI lỗi).
function speakSentence(sysVoice) {
  stopSpeech();
  if (isAi() && !sysVoice) { aiPlayFrom(current.pos); return; }
  const id = runId, i = current.pos;
  setPos(i);
  const u = utter(current.sentences[i].en, settings.rate);
  u.onboundary = e => { if (id === runId && e.name !== 'sentence') markWord(e.charIndex); };
  u.onend = () => {
    if (id !== runId || !playing) return;
    if (current.pos < current.sentences.length - 1) { current.pos++; speakSentence(); }
    else if (settings.loop) loopAgain();
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
  playing = true; updatePlay();
  // Giọng AI đang tạm dừng giữa chừng: phát tiếp đúng chỗ.
  if (isAi() && auMode === 'lesson' && seg && au.paused && !au.ended && seg.offs.some(o => o.i === current.pos)) {
    switchedAt = Date.now(); au.play().catch(() => {}); return;
  }
  speakSentence();
}
// Nút lặp: đọc hết bài thì quay lại đọc từ đầu, cho tới khi anh bấm dừng.
let loopCount = 1;
function loopAgain() {
  loopCount++;
  toast('Nghe lại lần ' + loopCount);
  current.pos = 0; speakSentence();
}
function updateLoop() {
  const b = $('#loop');
  b.classList.toggle('on', !!settings.loop);
  b.title = settings.loop ? 'Đang lặp lại cả bài (bấm để tắt)' : 'Lặp lại cả bài';
}
function pause() { playing = false; stopSpeech(); updatePlay(); markWord(-1); }
function updatePlay() { $('#play').textContent = playing ? '⏸' : '▶'; }
function jump(i) {
  if (!current) return;
  i = Math.max(0, Math.min(current.sentences.length - 1, i));
  if (!playing) { setPos(i); return; }
  // Giọng AI: câu đã nằm trong đoạn đang phát thì chỉ tua tới, không dựng lại.
  const o = isAi() && auMode === 'lesson' && seg && seg.offs.find(x => x.i === i);
  if (o) { au.currentTime = o.start; setPos(i); return; }
  current.pos = i; speakSentence();
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
let lookTimer;
function showSel(speak, delay) {
  document.querySelectorAll('.w.sel').forEach(x => x.classList.remove('sel'));
  selSpans().forEach(x => x.classList.add('sel'));
  const phrase = selText(), si = selN.si;
  $('#sheet').hidden = false;
  $('#shText').textContent = phrase;
  $('#shIpa').textContent = '';
  $('#shLeft').disabled = selN.a === 0;
  $('#shRight').disabled = selN.b === selN.n - 1;
  const body = $('#shBody'); body.textContent = 'Đang tra…';
  if (speak) speakOnce(phrase);
  const seq = ++lookSeq;
  clearTimeout(lookTimer);
  // Khi đang nối thêm từ, chờ anh dừng tay rồi mới tra để đỡ tốn lượt Gemini.
  const run = () => lookup(phrase, si);
  const p = delay && !quickLookup(phrase, si) ? new Promise(res => { lookTimer = setTimeout(() => res(run()), delay); }) : run();
  p.then(r => {
    if (seq !== lookSeq) return;
    selN.result = r;
    $('#shIpa').textContent = r.ipa || '';
    body.textContent = '';
    const pos = [r.pos, r.lemma ? 'gốc: ' + r.lemma : ''].filter(Boolean).join(' · ');
    if (pos) body.appendChild(el('div', 'pos', pos));
    body.appendChild(el('div', 'm', r.meaning || '(không có nghĩa)'));
    if (r.other) body.appendChild(el('div', 'o', 'Nghĩa khác: ' + r.other));
    if (r.note) body.appendChild(el('div', 'pos', r.note));
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
      lessons.splice(lessons.indexOf(L), 1); saveLessons(); deleteAudio(L); renderLibrary();
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
  $('#setModel').value = settings.model || DEFAULT_MODEL;
  $('#setVi').checked = settings.showVi;
  const sel = $('#setVoice'); sel.textContent = '';
  const ga = el('optgroup'); ga.label = 'Giọng AI — giống người, đọc khi tắt màn hình';
  for (const [id, name] of AI_VOICES) {
    const o = el('option', null, name); o.value = 'ai:' + id;
    if (settings.voice === o.value) o.selected = true;
    ga.appendChild(o);
  }
  sel.appendChild(ga);
  const gs = el('optgroup'); gs.label = 'Giọng của máy — dừng khi tắt màn hình';
  const us = voices.filter(v => /en[-_]US/i.test(v.lang)), rest = voices.filter(v => !/en[-_]US/i.test(v.lang));
  const cur = isAi() ? null : getVoice();
  for (const v of us.concat(rest)) {
    const o = el('option', null, `${v.name} (${v.lang})`); o.value = v.name;
    if (cur && v.name === cur.name) o.selected = true;
    gs.appendChild(o);
  }
  if (voices.length) sel.appendChild(gs);
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
  $('#rate').oninput = e => { settings.rate = Number(e.target.value); $('#rateLbl').textContent = settings.rate.toFixed(1) + '×'; saveSettings(); if (auMode === 'lesson') au.playbackRate = settings.rate; };
  $('#loop').onclick = () => {
    settings.loop = !settings.loop; saveSettings(); updateLoop(); loopCount = 1;
    toast(settings.loop ? 'Bật lặp: đọc hết bài sẽ đọc lại từ đầu.' : 'Tắt lặp.');
  };
  updateLoop();
  $('#viToggle').onclick =() => { settings.showVi = !settings.showVi; saveSettings(); applyVi(); };

  $('#shLeft').onclick = () => { if (selN.a > 0) { selN.a--; showSel(true, 1200); } };
  $('#shRight').onclick = () => { if (selN.b < selN.n - 1) { selN.b++; showSel(true, 1200); } };
  $('#shSpeak').onclick = () => selN && speakOnce(selText());
  $('#shSlow').onclick = () => selN && speakOnce(selText(), 0.6);
  $('#shSave').onclick = saveWord;
  $('#shClose').onclick = closeSheet;

  $('#exportCsv').onclick = exportCsv;
  $('#setKey').onchange = e => { settings.key = e.target.value.trim(); saveSettings(); };
  $('#setModel').onchange = e => { settings.model = e.target.value.trim() || DEFAULT_MODEL; saveSettings(); };
  $('#setVoice').onchange = e => {
    settings.voice = e.target.value; saveSettings();
    if (isAi()) loadTts().catch(() => {}); else voiceMsg('');
  };
  $('#setVi').onchange = e => { settings.showVi = e.target.checked; saveSettings(); applyVi(); };
  $('#testVoice').onclick = async () => {
    unlockAudio();
    if (isAi() && !tts) { try { await loadTts(); } catch (e) { /* dùng giọng máy */ } }
    speakOnce('Hello! This is how I will read your lessons.');
  };
  document.addEventListener('click', unlockAudio, { once: true, capture: true });
  $('#testKey').onclick = async () => {
    const btn = $('#testKey'), st = $('#keyStatus');
    const say = msg => { st.hidden = false; st.textContent = msg; };
    settings.key = $('#setKey').value.trim(); settings.model = $('#setModel').value.trim() || DEFAULT_MODEL; saveSettings();
    if (!settings.key) { say('Chưa nhập khóa.'); return; }
    btn.disabled = true; say('Bước 1/2: kiểm tra khóa…');
    const t0 = Date.now();
    try {
      const r = await findWorkingModel(m => say('Bước 2/2: thử mô hình ' + m + '… (tối đa 25 giây)'));
      $('#setModel').value = settings.model;
      say('✅ Khóa hoạt động tốt — dùng mô hình ' + r.model + ' (' + Math.round((Date.now() - t0) / 1000) + ' giây).' +
        (r.fails.length ? '\nĐã bỏ qua: ' + r.fails.join('; ') : ''));
    } catch (e) { say('❌ Lỗi: ' + e.message); }
    finally { btn.disabled = false; }
  };

  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  if (isAi()) loadTts().catch(() => {});
  applyVi();
  show('library');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
});
