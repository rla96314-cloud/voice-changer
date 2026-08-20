/* VoiceChanger — 실시간 음성변조 + 녹음 */
'use strict';

/* ── 파라미터 정의 ───────────────────────────── */
const DEFAULTS = {
  inGain: 1, outGain: 1,
  gateOn: false, gateTh: -50,
  eqLow: 0, eqMid: 0, eqHigh: 0,
  hp: 20, lp: 20000,
  pitch: 0,           // 반음 (-12 ~ +12)
  ringMix: 0, ringFreq: 50,
  dist: 0,
  dlyTime: 0.3, dlyFb: 0.35, dlyMix: 0,
  revMix: 0,
};

const PRESETS = [
  { name: '원본',     icon: '🎤', params: {} },
  { name: '헬륨',     icon: '🎈', params: { pitch: 7 } },
  { name: '저음 괴물', icon: '👹', params: { pitch: -6, dist: 0.25, eqLow: 4 } },
  { name: '로봇',     icon: '🤖', params: { pitch: -2, ringMix: 0.85, ringFreq: 50 } },
  { name: '외계인',   icon: '👽', params: { pitch: 4, ringMix: 0.6, ringFreq: 140, dlyTime: 0.09, dlyFb: 0.3, dlyMix: 0.35 } },
  { name: '동굴 에코', icon: '🕳️', params: { dlyTime: 0.35, dlyFb: 0.45, dlyMix: 0.45, revMix: 0.5 } },
  { name: '무전기',   icon: '📻', params: { hp: 400, lp: 2800, dist: 0.5, eqMid: 3 } },
  { name: '다람쥐',   icon: '🐿️', params: { pitch: 12 } },
];

const SLIDERS = [
  { id: 'inGain',  sec: 'sec-input', label: '입력 게인', min: 0, max: 2, step: 0.01, fmt: v => Math.round(v * 100) + '%' },
  { id: 'gateTh',  sec: 'sec-input', label: '게이트 임계값', min: -80, max: -10, step: 1, fmt: v => v + ' dB' },
  { id: 'eqLow',   sec: 'sec-eq', label: '저음 (250Hz)', min: -15, max: 15, step: 0.5, fmt: v => (v > 0 ? '+' : '') + v + ' dB' },
  { id: 'eqMid',   sec: 'sec-eq', label: '중음 (1kHz)', min: -15, max: 15, step: 0.5, fmt: v => (v > 0 ? '+' : '') + v + ' dB' },
  { id: 'eqHigh',  sec: 'sec-eq', label: '고음 (4kHz)', min: -15, max: 15, step: 0.5, fmt: v => (v > 0 ? '+' : '') + v + ' dB' },
  { id: 'hp',      sec: 'sec-eq', label: '하이패스', min: 20, max: 1000, step: 10, fmt: v => v + ' Hz' },
  { id: 'lp',      sec: 'sec-eq', label: '로우패스', min: 1000, max: 20000, step: 100, fmt: v => (v >= 20000 ? '끔' : v + ' Hz') },
  { id: 'pitch',   sec: 'sec-pitch', label: '피치', min: -12, max: 12, step: 1, fmt: v => (v > 0 ? '+' : '') + v + ' 반음' },
  { id: 'ringMix', sec: 'sec-pitch', label: '로봇 강도', min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' },
  { id: 'ringFreq', sec: 'sec-pitch', label: '로봇 주파수', min: 10, max: 400, step: 5, fmt: v => v + ' Hz' },
  { id: 'dist',    sec: 'sec-pitch', label: '디스토션', min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' },
  { id: 'dlyTime', sec: 'sec-space', label: '에코 간격', min: 0.05, max: 1, step: 0.01, fmt: v => Math.round(v * 1000) + ' ms' },
  { id: 'dlyFb',   sec: 'sec-space', label: '에코 반복', min: 0, max: 0.85, step: 0.01, fmt: v => Math.round(v * 100) + '%' },
  { id: 'dlyMix',  sec: 'sec-space', label: '에코 양', min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' },
  { id: 'revMix',  sec: 'sec-space', label: '리버브 양', min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' },
  { id: 'outGain', sec: 'sec-output', label: '출력 게인', min: 0, max: 2, step: 0.01, fmt: v => Math.round(v * 100) + '%' },
];

/* ── 상태 ───────────────────────────────────── */
const state = {
  params: { ...DEFAULTS },
  presetIndex: 0,
  bypass: false,
  monitor: true,
  recording: false,
  recStart: 0,
  recChunks: [],
  playingPath: null,
  reversePath: null, // 거꾸로 재생 중인 녹음 파일 경로
};

let ctx, stream, srcNode;
let nodes = {};
const $ = (id) => document.getElementById(id);

/* ── 오디오 그래프 ───────────────────────────── */
async function buildAudio(inputDeviceId) {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('worklets/pitch-shifter.js');
    await ctx.audioWorklet.addModule('worklets/noise-gate.js');
    await ctx.audioWorklet.addModule('worklets/recorder.js');
    createGraph();
  }
  if (ctx.state === 'suspended') await ctx.resume();

  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  if (srcNode) srcNode.disconnect();
  srcNode = ctx.createMediaStreamSource(stream);
  srcNode.connect(nodes.inGain);
}

function createGraph() {
  const n = {};
  n.inGain = ctx.createGain();
  n.inAnalyser = ctx.createAnalyser();
  n.inAnalyser.fftSize = 1024;

  n.gate = new AudioWorkletNode(ctx, 'noise-gate');
  n.hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: 0.7 });
  n.lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.7 });
  n.eqLow = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250 });
  n.eqMid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 1 });
  n.eqHigh = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000 });
  n.pitch = new AudioWorkletNode(ctx, 'pitch-shifter');

  // 링 모듈레이터 (로봇 목소리): osc가 게인 파라미터를 ±1로 흔들어 곱셈 효과
  n.ringDry = ctx.createGain();
  n.ringWet = ctx.createGain();
  n.ringMod = ctx.createGain();
  n.ringMod.gain.value = 0;
  n.ringOsc = ctx.createOscillator();
  n.ringOsc.type = 'sine';
  n.ringOsc.frequency.value = DEFAULTS.ringFreq;
  n.ringOsc.connect(n.ringMod.gain);
  n.ringOsc.start();
  n.ringSum = ctx.createGain();

  n.shaper = ctx.createWaveShaper();
  n.shaper.oversample = '2x';

  // 에코(딜레이+피드백)
  n.dlyInput = ctx.createGain();
  n.dlyDry = ctx.createGain();
  n.dlyWet = ctx.createGain();
  n.dly = ctx.createDelay(2);
  n.dlyFb = ctx.createGain();
  n.spaceSum = ctx.createGain();

  // 리버브 (생성된 임펄스)
  n.revDry = ctx.createGain();
  n.revWet = ctx.createGain();
  n.conv = ctx.createConvolver();
  n.conv.buffer = makeImpulse(2.2, 3.5);
  n.post = ctx.createGain();

  n.fxOut = ctx.createGain();     // 변조 경로 (bypass 시 0)
  n.bypassGain = ctx.createGain(); // 원본 경로 (bypass 시 1)
  n.bypassGain.gain.value = 0;
  n.outGain = ctx.createGain();
  n.outAnalyser = ctx.createAnalyser();
  n.outAnalyser.fftSize = 1024;

  n.msDest = ctx.createMediaStreamDestination();
  n.recorder = new AudioWorkletNode(ctx, 'recorder');
  n.recSink = ctx.createGain();
  n.recSink.gain.value = 0;

  // 연결
  // TTS 입력 (게이트 뒤에 합류 → 게이트에 잘리지 않고 나머지 이펙트는 적용)
  n.ttsIn = ctx.createGain();
  n.ttsIn.connect(n.hp);

  n.inGain.connect(n.inAnalyser);
  n.inGain.connect(n.gate);
  n.gate.connect(n.hp).connect(n.lp)
    .connect(n.eqLow).connect(n.eqMid).connect(n.eqHigh)
    .connect(n.pitch);

  n.pitch.connect(n.ringDry).connect(n.ringSum);
  n.pitch.connect(n.ringMod);
  n.ringMod.connect(n.ringWet).connect(n.ringSum);

  n.ringSum.connect(n.shaper).connect(n.dlyInput);
  n.dlyInput.connect(n.dlyDry).connect(n.spaceSum);
  n.dlyInput.connect(n.dly);
  n.dly.connect(n.dlyFb).connect(n.dly);
  n.dly.connect(n.dlyWet).connect(n.spaceSum);

  n.spaceSum.connect(n.revDry).connect(n.post);
  n.spaceSum.connect(n.conv).connect(n.revWet).connect(n.post);

  n.post.connect(n.fxOut).connect(n.outGain);
  n.inGain.connect(n.bypassGain).connect(n.outGain);

  n.outGain.connect(n.outAnalyser);
  n.outGain.connect(n.msDest);
  n.outGain.connect(n.recorder);
  n.recorder.connect(n.recSink).connect(ctx.destination);

  nodes = n;

  const monitorEl = $('monitorEl');
  monitorEl.srcObject = n.msDest.stream;
  monitorEl.play().catch(() => {});

  n.recorder.port.onmessage = (e) => {
    if (e.data.type === 'chunk') state.recChunks.push(e.data.data);
    else if (e.data.type === 'done') finalizeRecording();
  };
}

function makeImpulse(seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function makeDistCurve(amount) {
  if (amount <= 0) return null;
  const k = amount * 60;
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

/* ── 파라미터 적용 ───────────────────────────── */
function applyParams() {
  if (!ctx) return;
  const p = state.params;
  const t = ctx.currentTime;
  const set = (param, v, tc = 0.02) => param.setTargetAtTime(v, t, tc);

  set(nodes.inGain.gain, p.inGain);
  set(nodes.outGain.gain, p.outGain);
  nodes.gate.parameters.get('enabled').value = p.gateOn ? 1 : 0;
  nodes.gate.parameters.get('threshold').value = p.gateTh;
  set(nodes.hp.frequency, p.hp);
  set(nodes.lp.frequency, p.lp);
  set(nodes.eqLow.gain, p.eqLow);
  set(nodes.eqMid.gain, p.eqMid);
  set(nodes.eqHigh.gain, p.eqHigh);
  nodes.pitch.parameters.get('pitchRatio').setTargetAtTime(Math.pow(2, p.pitch / 12), t, 0.02);
  set(nodes.ringDry.gain, 1 - p.ringMix);
  set(nodes.ringWet.gain, p.ringMix);
  set(nodes.ringOsc.frequency, p.ringFreq);
  nodes.shaper.curve = makeDistCurve(p.dist);
  set(nodes.dly.delayTime, p.dlyTime);
  set(nodes.dlyFb.gain, p.dlyFb);
  set(nodes.dlyDry.gain, 1);
  set(nodes.dlyWet.gain, p.dlyMix);
  set(nodes.revDry.gain, 1 - p.revMix * 0.5);
  set(nodes.revWet.gain, p.revMix);
  set(nodes.fxOut.gain, state.bypass ? 0 : 1);
  set(nodes.bypassGain.gain, state.bypass ? 1 : 0);
}

function syncUI() {
  const p = state.params;
  for (const s of SLIDERS) {
    const el = $('sl-' + s.id);
    if (el) {
      el.value = p[s.id];
      $('val-' + s.id).textContent = s.fmt(p[s.id]);
    }
  }
  $('gateOn').checked = p.gateOn;
  document.querySelectorAll('.preset-btn[data-builtin]').forEach((b, i) => {
    b.classList.toggle('active', i === state.presetIndex);
  });
}

function applyPreset(index) {
  const preset = PRESETS[index];
  if (!preset) return;
  state.presetIndex = index;
  state.params = { ...DEFAULTS, ...preset.params };
  applyParams();
  syncUI();
  toast(`프리셋: ${preset.icon} ${preset.name}`);
}

/* ── UI 생성 ─────────────────────────────────── */
function buildSliders() {
  for (const s of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `
      <div class="lbl"><span>${s.label}</span><span class="val" id="val-${s.id}"></span></div>
      <input type="range" id="sl-${s.id}" min="${s.min}" max="${s.max}" step="${s.step}" />`;
    document.querySelector(`#${s.sec} .controls`).appendChild(row);
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      state.params[s.id] = parseFloat(input.value);
      $('val-' + s.id).textContent = s.fmt(state.params[s.id]);
      state.presetIndex = -1;
      document.querySelectorAll('.preset-btn[data-builtin]').forEach((b) => b.classList.remove('active'));
      applyParams();
    });
  }
}

function buildPresets() {
  const grid = $('presetGrid');
  PRESETS.forEach((preset, i) => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.dataset.builtin = '1';
    btn.innerHTML = `<span class="num">${i + 1}</span><span class="icon">${preset.icon}</span>${preset.name}`;
    btn.addEventListener('click', () => applyPreset(i));
    grid.appendChild(btn);
  });
}

/* ── 사용자 프리셋 ───────────────────────────── */
function loadUserPresets() {
  try { return JSON.parse(localStorage.getItem('userPresets') || '[]'); }
  catch { return []; }
}

function renderUserPresets() {
  const list = $('userPresetList');
  list.innerHTML = '';
  loadUserPresets().forEach((up, i) => {
    const row = document.createElement('div');
    row.className = 'user-preset-row';
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = up.name;
    btn.addEventListener('click', () => {
      state.params = { ...DEFAULTS, ...up.params };
      state.presetIndex = -1;
      applyParams();
      syncUI();
      document.querySelectorAll('.preset-btn[data-builtin]').forEach((b) => b.classList.remove('active'));
      toast(`내 프리셋: ${up.name}`);
    });
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '삭제';
    del.addEventListener('click', () => {
      const arr = loadUserPresets();
      arr.splice(i, 1);
      localStorage.setItem('userPresets', JSON.stringify(arr));
      renderUserPresets();
    });
    row.appendChild(btn);
    row.appendChild(del);
    list.appendChild(row);
  });
}

/* ── 장치 목록 ───────────────────────────────── */
async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inSel = $('inputSelect');
  const outSel = $('outputSelect');
  const savedIn = localStorage.getItem('inputDevice');
  const savedOut = localStorage.getItem('outputDevice');
  inSel.innerHTML = '';
  outSel.innerHTML = '';
  for (const d of devices) {
    if (d.kind === 'audioinput') {
      const opt = new Option(d.label || `마이크 ${inSel.length + 1}`, d.deviceId);
      inSel.add(opt);
    } else if (d.kind === 'audiooutput') {
      const opt = new Option(d.label || `스피커 ${outSel.length + 1}`, d.deviceId);
      outSel.add(opt);
    }
  }
  if (savedIn && [...inSel.options].some((o) => o.value === savedIn)) inSel.value = savedIn;
  if (savedOut && [...outSel.options].some((o) => o.value === savedOut)) outSel.value = savedOut;
}

async function applyOutputDevice() {
  const id = $('outputSelect').value;
  localStorage.setItem('outputDevice', id);
  try { await $('monitorEl').setSinkId(id); } catch (e) { console.warn('출력 장치 변경 실패', e); }
}

/* ── 녹음 ────────────────────────────────────── */
function toggleRecording() {
  if (!ctx) return;
  if (state.recording) {
    nodes.recorder.port.postMessage({ cmd: 'stop' });
  } else {
    state.recChunks = [];
    state.recording = true;
    state.recStart = Date.now();
    nodes.recorder.port.postMessage({ cmd: 'start' });
    $('recordBtn').textContent = '■ 정지';
    $('recordBtn').classList.add('recording');
    $('recordTime').classList.add('on');
  }
}

async function finalizeRecording() {
  state.recording = false;
  $('recordBtn').textContent = '● 녹음';
  $('recordBtn').classList.remove('recording');
  $('recordTime').classList.remove('on');
  $('recordTime').textContent = '00:00';

  const total = state.recChunks.reduce((s, c) => s + c.length, 0);
  if (total < ctx.sampleRate * 0.2) {
    toast('녹음이 너무 짧아 저장하지 않았습니다');
    state.recChunks = [];
    return;
  }
  const wav = encodeWav(state.recChunks, total, ctx.sampleRate);
  state.recChunks = [];
  try {
    const res = await window.api.saveRecording(wav);
    toast(`저장됨: ${res.name}`);
    renderRecordings();
  } catch (e) {
    toast('저장 실패: ' + e.message);
  }
}

function encodeWav(chunks, totalLen, sr) {
  const buf = new ArrayBuffer(44 + totalLen * 2);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + totalLen * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // 모노
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, totalLen * 2, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return buf;
}

/* ── 녹음 리스트 ─────────────────────────────── */
function fileUrl(p) {
  let norm = p.replace(/\\/g, '/');
  if (norm.startsWith('/')) norm = norm.slice(1);
  return encodeURI('file:///' + norm);
}

async function renderRecordings() {
  const list = $('recList');
  const items = await window.api.listRecordings();
  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<div class="rec-empty">녹음 파일이 없습니다. ● 녹음 버튼(Ctrl+Alt+R)으로 시작하세요.</div>';
    return;
  }
  const playbackEl = $('playbackEl');
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'rec-row';
    const d = new Date(item.mtime);
    const info = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${(item.size / 1024 / 1024).toFixed(1)}MB`;
    row.innerHTML = `<span class="name">${item.name}</span><span class="info">${info}</span>`;
    const playBtn = document.createElement('button');
    playBtn.textContent = state.playingPath === item.path ? '⏸' : '▶';
    if (state.playingPath === item.path) playBtn.classList.add('playing');
    playBtn.addEventListener('click', () => {
      if (state.playingPath === item.path) {
        playbackEl.pause();
        state.playingPath = null;
      } else {
        playbackEl.src = fileUrl(item.path);
        playbackEl.play();
        state.playingPath = item.path;
      }
      renderRecordings();
    });
    // 거꾸로 재생 (이펙트 체인 통과 — 재생 중 ● 녹음을 누르면 뒤집힌 소리를 새 파일로 녹음 가능)
    const revBtn = document.createElement('button');
    revBtn.textContent = state.reversePath === item.path ? '⏹' : '◀';
    revBtn.title = '거꾸로 재생 (변조 이펙트 적용)';
    if (state.reversePath === item.path) revBtn.classList.add('playing');
    revBtn.addEventListener('click', () => {
      if (state.reversePath === item.path) { stopTts(); return; }
      playRecordingReversed(item);
    });

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑';
    delBtn.title = '휴지통으로 이동';
    delBtn.addEventListener('click', async () => {
      await window.api.deleteRecording(item.path);
      if (state.playingPath === item.path) { playbackEl.pause(); state.playingPath = null; }
      renderRecordings();
    });
    row.appendChild(playBtn);
    row.appendChild(revBtn);
    row.appendChild(delBtn);
    list.appendChild(row);
  }
}

/* ── TTS ─────────────────────────────────────── */
let ttsSource = null;
let ttsBusy = false;
// 자막 동기화 상태
const caption = { words: [], chunks: [], startTime: 0, active: false, lastIdx: -2, curChunk: -1 };

// 단어들을 글자수 제한에 맞춰 여러 줄(청크)로 나눔. 0이면 한 줄.
function chunkWords(words, maxChars) {
  if (!maxChars || maxChars <= 0) return [{ start: 0, end: words.length }];
  const chunks = [];
  let start = 0, len = 0;
  for (let i = 0; i < words.length; i++) {
    const wlen = words[i].text.length + (i > start ? 1 : 0);
    if (len + wlen > maxChars && i > start) { chunks.push({ start, end: i }); start = i; len = words[i].text.length; }
    else len += wlen;
  }
  chunks.push({ start, end: words.length });
  return chunks;
}

// 입력 텍스트의 '/' 마커 위치를 단어 인덱스 구간으로 변환 (사용자가 직접 나눈 자막 구간)
function manualSegments(text, wordCount) {
  const segs = [];
  let start = 0;
  for (const part of text.split(/\/+/)) {
    const n = part.trim().split(/\s+/).filter(Boolean).length;
    if (n === 0) continue;
    const end = Math.min(start + n, wordCount);
    if (start < end) segs.push({ start, end });
    start = end;
    if (start >= wordCount) break;
  }
  if (segs.length === 0) return [{ start: 0, end: wordCount }];
  // 정렬이 어긋나 남은 단어가 있으면 마지막 구간에 붙임
  if (segs[segs.length - 1].end < wordCount) segs[segs.length - 1].end = wordCount;
  return segs;
}

// 자막 청크 = '/'로 직접 나눈 구간(우선). 글자수(maxChars)가 설정돼 있으면 긴 구간을 추가로 나눔.
function buildChunks(words, text, maxChars) {
  const segs = manualSegments(text, words.length);
  if (!maxChars || maxChars <= 0) return segs;
  const out = [];
  for (const s of segs) {
    for (const c of chunkWords(words.slice(s.start, s.end), maxChars)) {
      out.push({ start: s.start + c.start, end: s.start + c.end });
    }
  }
  return out;
}

function chunkOf(idx) {
  if (idx < 0) return 0;
  const ci = caption.chunks.findIndex((c) => idx >= c.start && idx < c.end);
  return ci < 0 ? caption.curChunk : ci;
}

function renderChunk(ci) {
  const bar = $('captionBar');
  bar.innerHTML = '';
  const { start, end } = caption.chunks[ci];
  for (let i = start; i < end; i++) {
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = caption.words[i].text;
    span.dataset.i = i;
    bar.appendChild(span);
    if (i < end - 1) bar.appendChild(document.createTextNode(' '));
  }
  caption.curChunk = ci;
}

async function initTtsVoices() {
  const sel = $('ttsVoice');
  sel.innerHTML = '';

  // 자연스러운 신경망 음성 (인터넷 필요)
  const gEdge = document.createElement('optgroup');
  gEdge.label = '자연스러운 음성 (인터넷)';
  for (const v of EDGE_TTS.VOICES) gEdge.appendChild(new Option(v.label, 'edge:' + v.name));
  sel.appendChild(gEdge);

  // 로컬 엔진 (직접 설치, ⚙ 설정 필요)
  const gLocal = document.createElement('optgroup');
  gLocal.label = '로컬 엔진 (직접 설치 · 오프라인)';
  gLocal.appendChild(new Option('수퍼토닉 (로컬 서버)', 'st:supertonic'));
  gLocal.appendChild(new Option('GPT-SoVITS 목소리 클론 (로컬 서버)', 'gsv:sovits'));
  sel.appendChild(gLocal);

  // OS 내장 음성 (오프라인)
  let voices = [];
  try { voices = await window.api.ttsVoices(); } catch { /* 무시 */ }
  voices.sort((a, b) => {
    const ak = a.lang.toLowerCase().startsWith('ko') ? 0 : 1;
    const bk = b.lang.toLowerCase().startsWith('ko') ? 0 : 1;
    return ak - bk || a.name.localeCompare(b.name);
  });
  if (voices.length > 0) {
    const gOs = document.createElement('optgroup');
    gOs.label = '기기 내장 음성 (오프라인)';
    for (const v of voices) gOs.appendChild(new Option(`${v.name} (${v.lang})`, 'os:' + v.name));
    sel.appendChild(gOs);
  }

  sel.value = 'edge:ko-KR-SunHiNeural';
  const saved = localStorage.getItem('ttsVoice');
  if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
  sel.addEventListener('change', () => localStorage.setItem('ttsVoice', sel.value));
}

function captionMax() {
  return parseInt($('captionMax').value, 10) || 0;
}

/* ── 자막 스타일 ─────────────────────────────── */
function captionStyle() {
  const fsel = $('stFont').value;
  return {
    h: $('stH').value,
    v: $('stV').value,
    layout: $('stLayout').value,
    size: parseInt($('stSize').value, 10) || 46,
    accent: $('stAccent').value,
    reveal: $('stReveal').checked,
    font: fsel === 'custom' ? $('stFontCustom').value.trim() : fsel,
    weight: parseInt($('stWeight').value, 10) || 800,
  };
}

// 스타일 변경을 오버레이에 즉시 반영 (OBS에서 바로 보임) + 앱 자막바에도 폰트 적용
function pushStyle() {
  const style = captionStyle();
  localStorage.setItem('captionStyle', JSON.stringify(style));
  const bar = $('captionBar');
  bar.style.fontFamily = style.font ? style.font + ', Pretendard, "Malgun Gothic", sans-serif' : '';
  bar.style.fontWeight = style.weight;
  window.api.caption({ type: 'style', style });
}

function restoreStyle() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('captionStyle') || 'null'); } catch { saved = null; }
  if (saved) {
    if (saved.h) $('stH').value = saved.h;
    if (saved.v) $('stV').value = saved.v;
    if (saved.layout) $('stLayout').value = saved.layout;
    if (saved.size) $('stSize').value = saved.size;
    if (saved.accent) $('stAccent').value = saved.accent;
    if (typeof saved.reveal === 'boolean') $('stReveal').checked = saved.reveal;
    if (saved.weight) $('stWeight').value = String(saved.weight);
    if (saved.font != null) {
      // 저장된 폰트가 프리셋에 있으면 선택, 아니면 '직접 입력'으로 복원
      const opt = [...$('stFont').options].find((o) => o.value === saved.font);
      if (opt) $('stFont').value = saved.font;
      else if (saved.font) { $('stFont').value = 'custom'; $('stFontCustom').value = saved.font; }
    }
  }
  const syncFontCustom = () => {
    $('stFontCustom').style.display = $('stFont').value === 'custom' ? '' : 'none';
  };
  syncFontCustom();
  $('stFont').addEventListener('change', syncFontCustom);
  for (const id of ['stH', 'stV', 'stLayout', 'stSize', 'stAccent', 'stReveal', 'stFont', 'stFontCustom', 'stWeight']) {
    $(id).addEventListener('change', pushStyle);
  }
  pushStyle();
}

function clearCaption() {
  const wasActive = caption.active;
  caption.active = false;
  caption.words = [];
  caption.chunks = [];
  caption.lastIdx = -2;
  caption.curChunk = -1;
  $('captionBar').classList.add('hidden');
  $('captionBar').innerHTML = '';
  if (wasActive) window.api.caption({ type: 'clear' });
}

function showCaption(words, text) {
  caption.words = words;
  caption.chunks = buildChunks(words, text, captionMax());
  caption.startTime = ctx.currentTime;
  caption.active = true;
  caption.lastIdx = -2;
  caption.curChunk = -1;
  renderChunk(0);
  $('captionBar').classList.remove('hidden');
  window.api.caption({ type: 'show', words: words.map((w) => ({ text: w.text })), chunks: caption.chunks });
}

// 재생 경과 시간에 맞춰 현재 단어를 강조 (tick 루프에서 호출) + 오버레이 중계
function updateCaption() {
  if (!caption.active) return;
  const t = ctx.currentTime - caption.startTime;
  let idx = -1;
  for (let i = 0; i < caption.words.length; i++) {
    if (t >= caption.words[i].start) idx = i; else break;
  }
  if (idx === caption.lastIdx) return;
  caption.lastIdx = idx;
  const ci = chunkOf(idx);
  if (ci !== caption.curChunk) renderChunk(ci);
  $('captionBar').querySelectorAll('.w').forEach((s) => {
    const i = +s.dataset.i;
    s.classList.toggle('active', i === idx);
    s.classList.toggle('done', i < idx);
  });
  window.api.caption({ type: 'word', idx });
}

function stopTts() {
  if (ttsSource) {
    try { ttsSource.stop(); } catch { /* 이미 정지됨 */ }
    ttsSource = null;
  }
  setPlayingCue(null);
  clearCaption();
}

// 오디오 버퍼를 거꾸로 뒤집은 사본을 만든다 (역재생용)
function reverseBuffer(buf) {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
  }
  return out;
}

// 녹음 파일을 거꾸로 재생 (이펙트 체인 통과). 이미 뒤집었으므로 역재생 토글과 무관하게 playSynth 직행
async function playRecordingReversed(item) {
  if (!ctx) return;
  try {
    const ab = await window.api.readRecording(item.path);
    const audioBuf = await ctx.decodeAudioData(ab);
    state.reversePath = item.path;
    playSynth({ audioBuf: reverseBuffer(audioBuf), words: [], text: '' }, false, () => {
      // 그 사이 다른 파일의 역재생이 시작됐으면 그쪽 상태를 건드리지 않음
      if (state.reversePath === item.path) {
        state.reversePath = null;
        renderRecordings();
      }
    });
    renderRecordings();
  } catch (e) {
    state.reversePath = null;
    toast('거꾸로 재생 실패: ' + e.message);
  }
}

// playSynth 호출 전에 역재생 토글을 반영하는 래퍼 — TTS·큐·대본·등록큐 공통 진입점
function playEntry(entry, useCaption, onEnd) {
  if ($('revOn').checked) {
    // 거꾸로 재생: 자막은 의미가 없으므로 표시하지 않음
    playSynth({ audioBuf: reverseBuffer(entry.audioBuf), words: [], text: entry.text }, false, onEnd);
  } else {
    playSynth(entry, useCaption, onEnd);
  }
}

// 이미 만들어진 음성(버퍼)을 이펙트 체인으로 재생 + 자막 표시. TTS 입력·큐·대본 재생에서 사용
// onEnd: 재생이 끝나면(또는 중단되면) 호출 — 대본 자동 재생이 다음 줄로 넘어가는 신호
function playSynth(entry, useCaption, onEnd) {
  stopTts();
  const src = ctx.createBufferSource();
  src.buffer = entry.audioBuf;
  src.connect(nodes.ttsIn);
  src.onended = () => {
    // onended는 비동기로 늦게 오므로, 그 사이 새 재생이 시작됐다면
    // (ttsSource가 이미 교체/해제됨) 새 재생의 자막·하이라이트를 지우면 안 된다
    if (ttsSource === src) {
      ttsSource = null;
      setPlayingCue(null);
      clearCaption();
    }
    if (onEnd) onEnd(); // 대본 진행 신호는 항상 전달
  };
  ttsSource = src;
  src.start();
  if (useCaption && entry.words.length > 0) showCaption(entry.words, entry.text);
}

/* ── 로컬 TTS 엔진 (수퍼토닉 / GPT-SoVITS) ────── */
function localTtsSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem('localTts') || 'null'); } catch { s = null; }
  return {
    st: { url: 'http://127.0.0.1:7788', voice: 'F1', ...((s && s.st) || {}) },
    gsv: { url: 'http://127.0.0.1:9880', refAudio: '', promptText: '', promptLang: 'ko', ...((s && s.gsv) || {}) },
    el: { apiKey: '', model: 'eleven_turbo_v2_5', stability: 80, seedLock: true, ...((s && s.el) || {}) },
  };
}

/* ── ElevenLabs ──────────────────────────────── */
function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// 글자 단위 타임스탬프 → 단어 단위. 순수 문장부호 토큰은 버리고,
// 단어에 붙은 문장부호는 표시에서 떼되 타이밍은 유지 (원문 단어 수와 정렬 보장)
function charsToWords(chars, starts, ends) {
  const words = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const clean = cur.text.replace(/^[.,!?…'"“”‘’]+|[.,!?…'"“”‘’]+$/g, '');
    if (clean) words.push({ start: cur.start, end: cur.end, text: clean });
    cur = null;
  };
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) { flush(); continue; }
    if (!cur) cur = { start: starts[i], end: ends[i], text: chars[i] };
    else { cur.text += chars[i]; cur.end = ends[i]; }
  }
  flush();
  return words;
}

async function synthElevenLabs(text, voiceId, rate) {
  const cfg = localTtsSettings().el;
  if (!cfg.apiKey) throw new Error('ElevenLabs API 키가 없습니다 — ⚙ 설정에서 입력하세요');
  const speed = Math.min(1.2, Math.max(0.7, 1 + rate * 0.025));
  // 문장이 부호 없이 끝나면 끝음이 붕 뜸 → 마침표를 붙여 서술형(끝음 내림)으로 끝맺음
  let sendText = pauseToPunct(text).trim();
  if (!/[.!?…]$/.test(sendText)) sendText += '.';
  const body = {
    text: sendText,
    model_id: cfg.model,
    // stability(일관성): 높을수록 톤이 흔들리지 않음 — ⚙ 설정값(0~100) 사용
    voice_settings: {
      stability: Math.min(1, Math.max(0, (Number(cfg.stability) || 80) / 100)),
      similarity_boost: 0.75,
    },
  };
  // 시드 고정: 같은 문장 + 같은 설정 = 항상 같은 억양으로 재현
  if (cfg.seedLock !== false) body.seed = 4242;
  // Turbo/Flash v2.5는 언어 강제 고정 지원 — 한국어로 못박아 언어 표류 원천 차단
  // (Multilingual v2는 이 파라미터를 지원하지 않아 자동 감지에 의존)
  if (/^eleven_(turbo|flash)_v2_5$/.test(cfg.model)) body.language_code = 'ko';
  if (rate !== 0) body.voice_settings.speed = speed;
  const r = await window.api.elevenLabsFetch({
    path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
    method: 'POST',
    apiKey: cfg.apiKey,
    json: body,
    timeoutMs: 180000, // 긴 대본 합성 대비
  });
  if (!r.ok) {
    if (r.error) throw new Error('ElevenLabs 연결 실패: ' + r.error);
    let detail = '';
    try {
      const j = JSON.parse(new TextDecoder().decode(r.data));
      detail = (j.detail && (j.detail.message || j.detail.status)) || j.detail || '';
      if (typeof detail === 'object') detail = JSON.stringify(detail);
    } catch { /* JSON 아님 */ }
    if (r.status === 401) throw new Error('ElevenLabs API 키가 올바르지 않습니다');
    throw new Error(`ElevenLabs 오류 (HTTP ${r.status})${detail ? ': ' + String(detail).slice(0, 120) : ''}`);
  }
  const j = JSON.parse(new TextDecoder().decode(r.data));
  const al = j.alignment || {};
  const words = (al.characters && al.characters.length)
    ? charsToWords(al.characters, al.character_start_times_seconds, al.character_end_times_seconds)
    : null; // 타임스탬프가 없으면 추정으로 폴백
  return { ab: b64ToArrayBuffer(j.audio_base64), words };
}

// 저장된 키로 내 목소리 목록을 불러와 셀렉트에 채움
async function loadElevenLabsVoices() {
  const sel = $('ttsVoice');
  const old = sel.querySelector('optgroup[data-el]');
  if (old) old.remove();
  const cfg = localTtsSettings().el;
  if (!cfg.apiKey) return;
  toast('ElevenLabs 목소리 불러오는 중…');
  try {
    const r = await window.api.elevenLabsFetch({ path: '/v1/voices', apiKey: cfg.apiKey, timeoutMs: 15000 });
    if (!r.ok) {
      if (r.error) throw new Error('연결 실패: ' + r.error);
      let detail = '';
      try {
        const j = JSON.parse(new TextDecoder().decode(r.data));
        detail = (j.detail && (j.detail.message || j.detail.status)) || '';
      } catch { /* JSON 아님 */ }
      throw new Error(detail ? String(detail).slice(0, 140) : 'HTTP ' + r.status);
    }
    const j = JSON.parse(new TextDecoder().decode(r.data));
    const g = document.createElement('optgroup');
    g.label = 'ElevenLabs (인터넷 · 유료)';
    g.dataset.el = '1';
    for (const v of j.voices || []) g.appendChild(new Option(v.name, 'el:' + v.voice_id));
    if (g.children.length > 0) sel.insertBefore(g, sel.firstChild);
    // 저장해둔 선택이 이 그룹이면 복원
    const saved = localStorage.getItem('ttsVoice');
    if (saved && saved.startsWith('el:') && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
    toast(`ElevenLabs 목소리 ${g.children.length}개 불러옴`);
  } catch (e) {
    toast('ElevenLabs 목소리 불러오기 실패: ' + e.message);
  }
}

// 끊어읽기 마커를 문장부호로 (로컬 엔진은 문장부호에서 자연스럽게 쉼)
function pauseToPunct(text) {
  return text.replace(/\/{2,}/g, '. ').replace(/\//g, ', ').replace(/\n+/g, '. ');
}

function localErr(name, r) {
  if (r.error) return `${name} 서버에 연결할 수 없습니다 (${r.error}) — 서버가 켜져 있는지 확인하세요`;
  let msg = '';
  try { msg = JSON.parse(new TextDecoder().decode(r.data)).message || ''; } catch { /* JSON 아님 */ }
  return `${name} 오류 (HTTP ${r.status})${msg ? ': ' + msg.slice(0, 120) : ''}`;
}

async function synthSupertonic(text, rate) {
  const cfg = localTtsSettings().st;
  const speed = Math.min(2, Math.max(0.7, 1 + rate * 0.05));
  const r = await window.api.localTtsFetch({
    url: cfg.url.replace(/\/+$/, '') + '/v1/tts',
    method: 'POST',
    json: { text: pauseToPunct(text), voice: cfg.voice, lang: 'ko', speed },
  });
  if (!r.ok) throw new Error(localErr('수퍼토닉', r));
  return r.data;
}

async function synthGsv(text, rate) {
  const cfg = localTtsSettings().gsv;
  if (!cfg.refAudio) throw new Error('참조 음성 경로가 비어 있습니다 — ⚙ 로컬 TTS 설정에서 지정하세요');
  const speed = Math.min(2, Math.max(0.5, 1 + rate * 0.05));
  const r = await window.api.localTtsFetch({
    url: cfg.url.replace(/\/+$/, '') + '/tts',
    method: 'POST',
    json: {
      text: pauseToPunct(text),
      text_lang: 'ko',
      ref_audio_path: cfg.refAudio,
      prompt_text: cfg.promptText,
      prompt_lang: cfg.promptLang || 'ko',
      speed_factor: speed,
      media_type: 'wav',
    },
  });
  if (!r.ok) throw new Error(localErr('GPT-SoVITS', r));
  return r.data;
}

// 타임스탬프 없는 엔진용 자막 추정: 글자 수 비례 + '/' 쉼 가중치.
// 단어 분해 방식이 manualSegments(자막 구간)와 동일해야 정렬이 맞는다.
function estimateWords(text, duration) {
  const tokens = [];
  const re = /(\/+)|([^/\s]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) tokens.push({ pause: m[1].length });
    else tokens.push({ word: m[2] });
  }
  const wordWeight = (w) => w.length + 0.6;
  let total = 0;
  for (const t of tokens) total += t.word ? wordWeight(t.word) : t.pause * 1.5;
  if (total <= 0) return [];
  const unit = duration / total;
  const words = [];
  let clock = 0;
  for (const t of tokens) {
    if (t.word) {
      const w = wordWeight(t.word) * unit;
      words.push({ start: clock, end: clock + w, text: t.word });
      clock += w;
    } else {
      clock += t.pause * 1.5 * unit;
    }
  }
  return words;
}

// 엔진 공통 합성 진입점. words가 null이면 재생 길이 기준 추정 필요
async function synthesizeFor(sel, text, rate) {
  if (sel.startsWith('edge:')) {
    const res = await EDGE_TTS.synthesize(text, sel.slice(5), rate * 5); // -10~10 → -50%~+50%
    return { ab: res.audio, words: res.words };
  }
  if (sel.startsWith('el:')) return await synthElevenLabs(text, sel.slice(3), rate); // 글자 타임스탬프 → 정밀 자막
  if (sel.startsWith('st:')) return { ab: await synthSupertonic(text, rate), words: null };
  if (sel.startsWith('gsv:')) return { ab: await synthGsv(text, rate), words: null };
  return { ab: await window.api.ttsSpeak({ text, voice: sel.replace(/^os:/, ''), rate }), words: null };
}

/* ── 로컬 TTS 설정 모달 ──────────────────────── */
function openLocalTtsModal() {
  const s = localTtsSettings();
  $('elKey').value = s.el.apiKey;
  $('elModel').value = s.el.model;
  $('elStability').value = s.el.stability;
  $('elSeedLock').checked = s.el.seedLock !== false;
  $('stUrl').value = s.st.url;
  $('stVoice').value = s.st.voice;
  $('gsvUrl').value = s.gsv.url;
  $('gsvRef').value = s.gsv.refAudio;
  $('gsvPrompt').value = s.gsv.promptText;
  $('gsvLang').value = s.gsv.promptLang;
  $('localTtsModal').classList.remove('hidden');
}
function closeLocalTtsModal() { $('localTtsModal').classList.add('hidden'); }
function saveLocalTtsModal() {
  const prevKey = localTtsSettings().el.apiKey;
  const s = {
    el: {
      apiKey: $('elKey').value.trim(),
      model: $('elModel').value,
      stability: Math.min(100, Math.max(0, parseInt($('elStability').value, 10) || 80)),
      seedLock: $('elSeedLock').checked,
    },
    st: {
      url: $('stUrl').value.trim() || 'http://127.0.0.1:7788',
      voice: $('stVoice').value,
    },
    gsv: {
      url: $('gsvUrl').value.trim() || 'http://127.0.0.1:9880',
      refAudio: $('gsvRef').value.trim(),
      promptText: $('gsvPrompt').value.trim(),
      promptLang: $('gsvLang').value,
    },
  };
  localStorage.setItem('localTts', JSON.stringify(s));
  closeLocalTtsModal();
  renderCues(); // 설정이 바뀌면 엔진 캐시 준비 상태 갱신
  // 키가 비어 있으면 바로 알 수 있게 상태를 함께 표시
  toast(s.el.apiKey ? `TTS 설정 저장됨 (ElevenLabs 키 ${s.el.apiKey.length}자)` : 'TTS 설정 저장됨 (ElevenLabs 키 없음)');
  // 키가 있으면 항상 목소리 목록 갱신 (같은 키 재저장 시 건너뛰던 버그 수정)
  if (s.el.apiKey) loadElevenLabsVoices();
  else if (!s.el.apiKey && prevKey) {
    const g = $('ttsVoice').querySelector('optgroup[data-el]');
    if (g) g.remove(); // 키를 지우면 목록에서도 제거
  }
}

async function ttsSpeak() {
  const text = $('ttsText').value.trim();
  if (!text || ttsBusy || !ctx) return;
  ttsBusy = true;
  const btn = $('ttsBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 생성 중…';
  try {
    const sel = $('ttsVoice').value;
    const rate = parseInt($('ttsRate').value, 10);
    const useCaption = $('captionOn').checked;
    const { ab, words } = await synthesizeFor(sel, text, rate);
    const audioBuf = await ctx.decodeAudioData(ab);
    const finalWords = words || estimateWords(text, audioBuf.duration);
    playEntry({ audioBuf, words: finalWords, text }, useCaption);
    $('ttsText').select();
  } catch (e) {
    if ($('ttsVoice').value.startsWith('edge:')) {
      toast('자연스러운 음성 실패: ' + e.message + ' — 기기 내장 음성으로 바꿔보세요');
    } else {
      toast('TTS 실패: ' + e.message);
    }
  } finally {
    ttsBusy = false;
    btn.disabled = false;
    btn.textContent = '🔊 말하기';
  }
}

/* ── 큐 리스트 ───────────────────────────────── */
// 파트별 대본을 미리 만들어 두고, 큐를 누르면 음성+자막이 즉시 나간다.
// 음성은 미리 생성해 캐시하므로 누르는 순간 지연이 없다.
const cueCache = new Map(); // id → { key, audioBuf, words, text }
let playingCueId = null;
let cueEditId = null;
let preparing = false;

function loadCues() {
  try { return JSON.parse(localStorage.getItem('cues') || '[]'); } catch { return []; }
}
function saveCues(cues) {
  localStorage.setItem('cues', JSON.stringify(cues));
}
function defaultGap() {
  return Math.max(0, Number($('cueGapDefault').value) || 0);
}
// 줄에 공백이 지정돼 있지 않으면(예전 데이터) 기본값 사용
function cueGap(cue) {
  return cue.gap == null ? defaultGap() : Math.max(0, Number(cue.gap) || 0);
}

// 목소리·속도(로컬 엔진은 서버 설정까지)가 바뀌면 캐시가 무효가 되도록 키에 포함
function cueKey(cue) {
  const sel = $('ttsVoice').value;
  let extra = '';
  if (sel.startsWith('st:')) extra = JSON.stringify(localTtsSettings().st);
  else if (sel.startsWith('gsv:')) extra = JSON.stringify(localTtsSettings().gsv);
  else if (sel.startsWith('el:')) {
    const e = localTtsSettings().el;
    extra = `${e.model} ${e.stability} ${e.seedLock}`; // 모델·일관성·시드가 바뀌면 재생성
  }
  return `${cue.text} ${sel} ${$('ttsRate').value} ${extra}`;
}
function cueReady(cue) {
  const c = cueCache.get(cue.id);
  return !!c && c.key === cueKey(cue);
}

function setPlayingCue(id) {
  playingCueId = id;
  document.querySelectorAll('.cue-row').forEach((r) => {
    r.classList.toggle('playing', r.dataset.id === id);
  });
}

function renderCues() {
  const list = $('cueList');
  const cues = loadCues();
  list.innerHTML = '';
  if (cues.length === 0) {
    list.innerHTML = '<div class="cue-empty">📄 붙여넣기 또는 ＋ 줄 로 대본을 만들어 두세요. ⚡ 준비 후엔 누르는 즉시 재생됩니다.</div>';
    updateCueStatus();
    return;
  }
  cues.forEach((cue, i) => {
    const row = document.createElement('div');
    row.className = 'cue-row';
    row.dataset.id = cue.id;
    if (cue.id === playingCueId) row.classList.add('playing');

    const num = document.createElement('span');
    num.className = 'cue-num';
    num.textContent = i < 9 ? `⇧⌃${i + 1}` : `${i + 1}`;

    const dot = document.createElement('span');
    dot.className = 'cue-dot' + (cueReady(cue) ? ' ready' : '');
    dot.title = cueReady(cue) ? '준비됨 — 즉시 재생' : '준비 안 됨 — 누르면 생성 후 재생';

    const go = document.createElement('button');
    go.className = 'cue-go';
    go.innerHTML = `<span class="nm"></span><span class="tx"></span>`;
    // 이름을 붙였으면 이름이 제목·대사가 부제, 대본만 붙여넣었으면 대사 자체가 제목
    const named = cue.name && cue.name.trim();
    go.querySelector('.nm').textContent = named ? cue.name : cue.text;
    go.querySelector('.tx').textContent = named ? cue.text : '';
    go.addEventListener('click', () => playCue(cue.id));

    // 이 줄이 끝난 뒤 다음 줄까지 쉬는 시간
    const gap = document.createElement('input');
    gap.className = 'cue-gap';
    gap.type = 'number';
    gap.min = '0'; gap.max = '60'; gap.step = '0.5';
    gap.value = String(cueGap(cue));
    gap.title = '이 줄이 끝나고 다음 줄까지의 공백(초)';
    gap.addEventListener('change', () => {
      const arr = loadCues();
      const t = arr.find((c) => c.id === cue.id);
      if (t) { t.gap = Math.max(0, Number(gap.value) || 0); saveCues(arr); }
    });
    const unit = document.createElement('span');
    unit.className = 'cue-gap-unit';
    unit.textContent = '초';

    const edit = document.createElement('button');
    edit.className = 'mini';
    edit.textContent = '✎';
    edit.title = '편집';
    edit.addEventListener('click', () => openCueModal(cue.id));

    const del = document.createElement('button');
    del.className = 'mini';
    del.textContent = '✕';
    del.title = '삭제';
    del.addEventListener('click', () => {
      const arr = loadCues().filter((c) => c.id !== cue.id);
      saveCues(arr);
      cueCache.delete(cue.id);
      renderCues();
    });

    row.append(num, dot, go, gap, unit, edit, del);
    list.appendChild(row);
  });
  updateCueStatus();
}

function updateCueStatus() {
  const cues = loadCues();
  if (cues.length === 0) { $('cueStatus').textContent = ''; return; }
  const ready = cues.filter(cueReady).length;
  $('cueStatus').textContent = preparing ? '준비 중…' : `준비됨 ${ready}/${cues.length}`;
}

// 큐 하나의 음성을 생성해 캐시 (이미 준비돼 있으면 그대로 사용)
async function prepareCue(cue) {
  const key = cueKey(cue);
  const cached = cueCache.get(cue.id);
  if (cached && cached.key === key) return cached;

  const sel = $('ttsVoice').value;
  const rate = parseInt($('ttsRate').value, 10);
  const { ab, words } = await synthesizeFor(sel, cue.text, rate);
  const audioBuf = await ctx.decodeAudioData(ab);
  const entry = { key, audioBuf, words: words || estimateWords(cue.text, audioBuf.duration), text: cue.text };
  cueCache.set(cue.id, entry);
  return entry;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 전체 준비: 순차 생성 (Edge 서버가 연속 요청을 끊는 일이 있어 간격을 둔다)
async function prepareAllCues() {
  if (preparing) return;
  const cues = loadCues().filter((c) => !cueReady(c));
  if (cues.length === 0) { toast('이미 모두 준비되어 있습니다'); return; }
  preparing = true;
  $('cuePrepareBtn').disabled = true;
  let ok = 0, fail = 0;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const dot = document.querySelector(`.cue-row[data-id="${cue.id}"] .cue-dot`);
    if (dot) dot.classList.add('busy');
    $('cueStatus').textContent = `준비 중… ${i + 1}/${cues.length}`;
    try {
      await prepareCue(cue);
      ok++;
    } catch (e) {
      try { await sleep(1500); await prepareCue(cue); ok++; } // 한 번 재시도
      catch (e2) { fail++; console.warn('큐 준비 실패', cue.name, e2.message); }
    }
    if (dot) dot.classList.remove('busy');
    if (i < cues.length - 1) await sleep(1200); // 레이트리밋 회피
  }
  preparing = false;
  $('cuePrepareBtn').disabled = false;
  renderCues();
  toast(fail === 0 ? `큐 ${ok}개 준비 완료` : `준비 완료 ${ok}개 · 실패 ${fail}개`);
}

async function playCue(id) {
  const cue = loadCues().find((c) => c.id === id);
  if (!cue || !ctx) return;
  if (scriptPlaying) stopScript(); // 수동 발사가 대본 자동재생보다 우선
  const useCaption = $('captionOn').checked;
  try {
    if (cueReady(cue)) {
      playEntry(cueCache.get(cue.id), useCaption);   // 즉시 재생
      setPlayingCue(cue.id);
    } else {
      toast(`"${cue.name || cue.text.slice(0, 12)}" 생성 중…`);
      const entry = await prepareCue(cue);
      playEntry(entry, useCaption);
      setPlayingCue(cue.id);
      renderCues();
    }
  } catch (e) {
    toast('큐 재생 실패: ' + e.message);
  }
}

/* ── 대본 전체 재생 ──────────────────────────── */
// 첫 줄부터 끝까지, 각 줄이 끝나면 지정한 공백만큼 쉬었다가 다음 줄로 넘어간다.
let scriptPlaying = false;
let scriptCancelled = false;
let pendingGap = null; // { timer, resolve } — 정지 시 즉시 깨우기 위해 보관

function waitGap(ms) {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => { pendingGap = null; resolve(); }, ms);
    pendingGap = { timer, resolve };
  });
}

function updateScriptBtn() {
  const btn = $('scriptPlayBtn');
  btn.textContent = scriptPlaying ? '⏹ 정지' : '▶ 재생';
  btn.classList.toggle('stop', scriptPlaying);
}

function stopScript() {
  scriptCancelled = true;
  if (pendingGap) { clearTimeout(pendingGap.timer); pendingGap.resolve(); pendingGap = null; }
  stopTts(); // 재생 중이면 onended가 불려 대기 중인 재생 promise가 풀린다
  scriptPlaying = false;
  updateScriptBtn();
  document.querySelectorAll('.cue-row').forEach((r) => r.classList.remove('waiting'));
  if (activeSetId) { activeSetId = null; renderCueSets(); }
}

async function playScript() {
  if (scriptPlaying) { stopScript(); return; }
  const cues = loadCues();
  if (cues.length === 0) { toast('대본이 비어 있습니다'); return; }
  scriptPlaying = true;
  scriptCancelled = false;
  updateScriptBtn();

  for (let i = 0; i < cues.length; i++) {
    if (scriptCancelled) break;
    const cue = cues[i];
    try {
      const entry = cueReady(cue) ? cueCache.get(cue.id) : await prepareCue(cue);
      if (scriptCancelled) break;
      // playSynth가 내부에서 stopTts()→setPlayingCue(null)을 부르므로 반드시 그 뒤에 하이라이트
      await new Promise((resolve) => {
        playEntry(entry, $('captionOn').checked, resolve);
        setPlayingCue(cue.id);
      });
    } catch (e) {
      toast(`"${cue.name || cue.text.slice(0, 10)}" 실패: ${e.message}`);
    }
    if (scriptCancelled || i === cues.length - 1) break;
    // 다음 줄까지 공백
    const row = document.querySelector(`.cue-row[data-id="${cue.id}"]`);
    if (row) row.classList.add('waiting');
    await waitGap(cueGap(cue) * 1000);
    if (row) row.classList.remove('waiting');
  }

  scriptPlaying = false;
  scriptCancelled = false;
  setPlayingCue(null);
  updateScriptBtn();
}

/* ── 대본 붙여넣기 ───────────────────────────── */
function openScriptModal() {
  $('scriptGap').value = String(defaultGap());
  $('scriptText').value = '';
  $('scriptModal').classList.remove('hidden');
  $('scriptText').focus();
}
function closeScriptModal() { $('scriptModal').classList.add('hidden'); }
function saveScriptModal() {
  const lines = $('scriptText').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) { toast('대본을 입력하세요'); return; }
  const gap = Math.max(0, Number($('scriptGap').value) || 0);
  const replace = $('scriptReplace').checked;
  const base = replace ? [] : loadCues();
  if (replace) cueCache.clear();
  const now = Date.now();
  lines.forEach((text, i) => {
    base.push({ id: `cue${(now + i).toString(36)}`, name: '', text, gap });
  });
  saveCues(base);
  closeScriptModal();
  renderCues();
  toast(`대본 ${lines.length}줄을 넣었습니다 — ⚡ 전체 준비 후 재생하세요`);
}

/* ── 등록 큐 (완성된 대본을 저장해 클릭 한 번으로 발사) ── */
let activeSetId = null;

function loadCueSets() {
  try { return JSON.parse(localStorage.getItem('cueSets') || '[]'); } catch { return []; }
}
function saveCueSets(sets) {
  localStorage.setItem('cueSets', JSON.stringify(sets));
}

function renderCueSets() {
  const grid = $('setList');
  const sets = loadCueSets();
  grid.innerHTML = '';
  if (sets.length === 0) {
    grid.innerHTML = '<div class="set-empty">🎬 대본 탭에서 대본을 완성하고 💾 큐로 등록 하면, 여기서 클릭 한 번에 전체가 재생됩니다.</div>';
    $('setStatus').textContent = '';
    return;
  }
  sets.forEach((set) => {
    const item = document.createElement('div');
    item.className = 'set-item' + (set.id === activeSetId ? ' playing' : '');
    item.dataset.id = set.id;
    const btn = document.createElement('button');
    btn.className = 'set-btn';
    btn.innerHTML = '<span class="nm"></span><span class="cnt"></span>';
    btn.querySelector('.nm').textContent = set.name;
    const first = set.lines[0] ? set.lines[0].text.slice(0, 16) : '';
    btn.querySelector('.cnt').textContent = `${set.lines.length}줄 · ${first}…`;
    btn.title = set.lines.map((l) => l.text).join('\n');
    btn.addEventListener('click', () => playCueSet(set.id));
    const del = document.createElement('button');
    del.className = 'set-del';
    del.textContent = '✕';
    del.title = '등록 큐 삭제';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      saveCueSets(loadCueSets().filter((s) => s.id !== set.id));
      renderCueSets();
    });
    item.append(btn, del);
    grid.appendChild(item);
  });
  $('setStatus').textContent = activeSetId ? '재생 중…' : `등록 큐 ${sets.length}개`;
}

const setLineCue = (set, i) => ({ id: `set_${set.id}_${i}`, text: set.lines[i].text });

// 등록 큐 재생: 현재 줄을 재생하는 동안 다음 줄을 미리 생성해 끊김 없이 이어간다
async function playCueSet(setId) {
  const set = loadCueSets().find((s) => s.id === setId);
  if (!set || !ctx || set.lines.length === 0) return;
  stopScript(); // 다른 재생이 있으면 정지하고 이어서 시작
  scriptPlaying = true;
  scriptCancelled = false;
  activeSetId = setId;
  renderCueSets();
  updateScriptBtn();

  let ahead = null; // { i, p } — 다음 줄 미리 생성 중인 promise
  for (let i = 0; i < set.lines.length; i++) {
    if (scriptCancelled) break;
    const cue = setLineCue(set, i);
    try {
      let entry = null;
      if (cueReady(cue)) entry = cueCache.get(cue.id);
      else if (ahead && ahead.i === i) entry = await ahead.p;
      if (!entry) entry = await prepareCue(cue);
      if (i + 1 < set.lines.length) {
        const nc = setLineCue(set, i + 1);
        ahead = cueReady(nc) ? null : { i: i + 1, p: prepareCue(nc).catch(() => null) };
      }
      if (scriptCancelled) break;
      await new Promise((resolve) => { playEntry(entry, $('captionOn').checked, resolve); });
    } catch (e) {
      toast(`${i + 1}번째 줄 실패: ${e.message}`);
    }
    if (scriptCancelled || i === set.lines.length - 1) break;
    await waitGap((Number(set.lines[i].gap) || 0) * 1000);
  }
  scriptPlaying = false;
  scriptCancelled = false;
  activeSetId = null;
  setPlayingCue(null);
  renderCueSets();
  updateScriptBtn();
}

function openSetModal() {
  const cues = loadCues();
  if (cues.length === 0) { toast('등록할 대본이 없습니다 — 🎬 대본 탭에서 먼저 작성하세요'); return; }
  $('setInfo').textContent = `현재 대본 ${cues.length}줄을 등록합니다 — "${cues[0].text.slice(0, 24)}…" (같은 이름이면 덮어쓰기)`;
  $('setName').value = '';
  $('setModal').classList.remove('hidden');
  $('setName').focus();
}
function closeSetModal() { $('setModal').classList.add('hidden'); }
function saveSetModal() {
  const name = $('setName').value.trim();
  if (!name) { toast('큐 이름을 입력하세요'); return; }
  const cues = loadCues();
  if (cues.length === 0) { closeSetModal(); return; }
  const sets = loadCueSets();
  const set = {
    id: 'set' + Date.now().toString(36),
    name,
    lines: cues.map((c) => ({ text: c.text, gap: cueGap(c) })),
  };
  const existing = sets.findIndex((s) => s.name === name);
  if (existing >= 0) { set.id = sets[existing].id; sets[existing] = set; } // 같은 이름 → 덮어쓰기
  else sets.push(set);
  saveCueSets(sets);
  closeSetModal();
  renderCueSets();
  toast(`등록됨: ${name} (${set.lines.length}줄) — 🎯 등록 큐 탭에서 클릭 한 번으로 재생`);
}

function openCueModal(id) {
  cueEditId = id || null;
  const cue = id ? loadCues().find((c) => c.id === id) : null;
  $('cueModalTitle').textContent = cue ? '큐 편집' : '큐 추가';
  $('cueName').value = cue ? cue.name : '';
  $('cueText').value = cue ? cue.text : '';
  $('cueModal').classList.remove('hidden');
  $('cueName').focus();
}
function closeCueModal() {
  $('cueModal').classList.add('hidden');
  cueEditId = null;
}
function saveCueModal() {
  const name = $('cueName').value.trim();
  const text = $('cueText').value.trim();
  if (!text) { toast('내용을 입력하세요'); return; }
  const cues = loadCues();
  if (cueEditId) {
    const cue = cues.find((c) => c.id === cueEditId);
    if (cue) { cue.name = name; cue.text = text; } // 이름을 비우면 대사가 제목으로 표시됨
  } else {
    cues.push({ id: 'cue' + Date.now().toString(36), name, text, gap: defaultGap() });
  }
  saveCues(cues);
  closeCueModal();
  renderCues();
}

/* ── 레벨 미터 / 타이머 ──────────────────────── */
const meterBufIn = new Uint8Array(1024);
const meterBufOut = new Uint8Array(1024);

function levelOf(analyser, buf) {
  analyser.getByteTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  return peak;
}

function tick() {
  if (nodes.inAnalyser) {
    $('meterIn').style.width = Math.min(100, levelOf(nodes.inAnalyser, meterBufIn) * 130) + '%';
    $('meterOut').style.width = Math.min(100, levelOf(nodes.outAnalyser, meterBufOut) * 130) + '%';
  }
  if (state.recording) {
    const sec = Math.floor((Date.now() - state.recStart) / 1000);
    $('recordTime').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }
  updateCaption();
  requestAnimationFrame(tick);
}

/* ── 기타 UI ─────────────────────────────────── */
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

function setStatus(on, text) {
  $('statusDot').className = 'dot ' + (on ? 'on' : 'off');
  $('statusText').textContent = text;
}

function updateMonitorBtn() {
  const btn = $('monitorBtn');
  btn.classList.toggle('active', state.monitor);
  btn.textContent = state.monitor ? '🎧 모니터 켬' : '🎧 모니터 끔';
  $('monitorEl').muted = !state.monitor;
}

function updateBypassBtn() {
  const btn = $('bypassBtn');
  btn.classList.toggle('active', state.bypass);
  btn.textContent = state.bypass ? '원본 통과 중' : '원본 통과 꺼짐';
}

/* ── 초기화 ──────────────────────────────────── */
async function init() {
  buildSliders();
  buildPresets();
  renderUserPresets();
  syncUI();

  // 마이크가 없어도 TTS·대본·오버레이는 동작해야 하므로 실패해도 초기화를 계속한다.
  // (ctx와 오디오 그래프는 getUserMedia 전에 만들어지므로 TTS 경로는 살아 있다)
  let micErr = null;
  try {
    await buildAudio(localStorage.getItem('inputDevice') || undefined);
  } catch (e) {
    console.error('마이크 초기화 실패', e);
    micErr = e;
  }
  try { await refreshDevices(); } catch (e) { console.warn(e); }
  try { await applyOutputDevice(); } catch (e) { console.warn(e); }
  if (ctx) applyParams();

  if (!ctx) {
    // 워크릿 로드조차 실패한 경우 — 여기서만 완전 차단
    $('overlay').classList.remove('hidden');
    $('overlayMsg').textContent = '오디오 엔진을 시작할 수 없습니다. 앱을 다시 실행해 주세요.';
    setStatus(false, '오디오 엔진 오류');
    return;
  }
  if (micErr) {
    setStatus(false, '마이크 없음 — TTS·대본은 사용 가능');
    $('overlay').classList.remove('hidden');
    $('overlayMsg').textContent =
      '마이크 권한을 확인해 주세요. 시스템 설정에서 마이크 접근을 허용한 뒤 앱을 다시 실행하면 됩니다. ' +
      '마이크 없이도 TTS와 대본 기능은 사용할 수 있습니다. (' + micErr.message + ')';
  } else {
    setStatus(true, '작동 중 · ' + Math.round(ctx.sampleRate / 1000) + 'kHz');
  }
  $('overlayCloseBtn').addEventListener('click', () => $('overlay').classList.add('hidden'));

  $('inputSelect').addEventListener('change', async () => {
    localStorage.setItem('inputDevice', $('inputSelect').value);
    try {
      await buildAudio($('inputSelect').value);
      applyParams();
      toast('입력 장치 변경됨');
      setStatus(true, '작동 중 · ' + Math.round(ctx.sampleRate / 1000) + 'kHz');
    } catch (e) {
      toast('입력 장치를 열 수 없습니다: ' + e.message);
    }
  });
  $('outputSelect').addEventListener('change', applyOutputDevice);

  $('monitorBtn').addEventListener('click', () => {
    state.monitor = !state.monitor;
    updateMonitorBtn();
  });
  $('bypassBtn').addEventListener('click', () => {
    state.bypass = !state.bypass;
    updateBypassBtn();
    applyParams();
  });
  $('gateOn').addEventListener('change', () => {
    state.params.gateOn = $('gateOn').checked;
    applyParams();
  });
  $('recordBtn').addEventListener('click', toggleRecording);
  $('openFolderBtn').addEventListener('click', () => window.api.openRecordingsFolder());

  $('userPresetSaveBtn').addEventListener('click', () => {
    const name = $('userPresetName').value.trim();
    if (!name) { toast('프리셋 이름을 입력하세요'); return; }
    const arr = loadUserPresets();
    const existing = arr.findIndex((u) => u.name === name);
    const entry = { name, params: { ...state.params } };
    if (existing >= 0) arr[existing] = entry;
    else arr.push(entry);
    localStorage.setItem('userPresets', JSON.stringify(arr));
    $('userPresetName').value = '';
    renderUserPresets();
    toast(`내 프리셋 저장됨: ${name}`);
  });

  initTtsVoices();
  restoreStyle();
  $('ttsBtn').addEventListener('click', ttsSpeak);
  $('ttsStopBtn').addEventListener('click', stopTts);
  $('overlayBtn').addEventListener('click', async () => {
    const base = await window.api.overlayUrl();
    const s = captionStyle();
    const p = new URLSearchParams({
      h: s.h, v: s.v, layout: s.layout,
      size: String(s.size),
      accent: s.accent.replace('#', ''),
      reveal: s.reveal ? '1' : '0',
      weight: String(s.weight),
    });
    if (s.font) p.set('font', s.font);
    const max = captionMax();
    if (max > 0) p.set('max', String(max));
    const url = `${base}?${p.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      toast(`오버레이 주소 복사됨: ${url}`);
    } catch {
      toast(`오버레이 주소: ${url}`);
    }
  });
  $('ttsText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) ttsSpeak();
  });

  // 대본 / 큐
  const savedGapDefault = localStorage.getItem('cueGapDefault');
  if (savedGapDefault != null) $('cueGapDefault').value = savedGapDefault; // renderCues 전에 복원
  renderCues();
  $('cueAddBtn').addEventListener('click', () => openCueModal(null));
  $('cuePrepareBtn').addEventListener('click', prepareAllCues);
  $('scriptPlayBtn').addEventListener('click', playScript);
  $('scriptPasteBtn').addEventListener('click', openScriptModal);
  $('scriptSaveBtn').addEventListener('click', saveScriptModal);
  $('scriptCancelBtn').addEventListener('click', closeScriptModal);
  $('scriptModal').addEventListener('click', (e) => { if (e.target === $('scriptModal')) closeScriptModal(); });
  $('cueGapDefault').addEventListener('change', () => {
    localStorage.setItem('cueGapDefault', $('cueGapDefault').value);
    renderCues(); // 공백이 지정 안 된 줄들의 표시값 갱신
  });
  $('cueSaveBtn').addEventListener('click', saveCueModal);
  $('cueCancelBtn').addEventListener('click', closeCueModal);
  $('cueModal').addEventListener('click', (e) => { if (e.target === $('cueModal')) closeCueModal(); });
  $('cueName').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) $('cueText').focus(); });

  // 저장된 ElevenLabs 키가 있으면 목소리 목록 로드
  if (localTtsSettings().el.apiKey) loadElevenLabsVoices();

  // TTS 엔진 설정
  $('ttsCfgBtn').addEventListener('click', openLocalTtsModal);
  $('localTtsSaveBtn').addEventListener('click', saveLocalTtsModal);
  $('localTtsCancelBtn').addEventListener('click', closeLocalTtsModal);
  // 주의: 엔진 설정 모달은 바깥 클릭으로 닫지 않음 — API 키 입력이 날아가는 사고 방지 (취소/Esc/저장만)
  // 입력칸에서 Enter = 저장
  for (const id of ['elKey', 'stUrl', 'gsvUrl', 'gsvRef', 'gsvPrompt']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) saveLocalTtsModal();
    });
  }
  // GPT-SoVITS를 처음 고르면 참조 음성 설정이 필요하다고 안내
  $('ttsVoice').addEventListener('change', () => {
    if ($('ttsVoice').value.startsWith('gsv:') && !localTtsSettings().gsv.refAudio) {
      openLocalTtsModal();
      toast('GPT-SoVITS는 클론할 참조 음성 경로가 필요합니다');
    }
  });

  // 등록 큐
  renderCueSets();
  $('cueRegisterBtn').addEventListener('click', openSetModal);
  $('setStopBtn').addEventListener('click', stopScript);
  $('setSaveBtn').addEventListener('click', saveSetModal);
  $('setCancelBtn').addEventListener('click', closeSetModal);
  $('setModal').addEventListener('click', (e) => { if (e.target === $('setModal')) closeSetModal(); });
  $('setName').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) saveSetModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('cueModal').classList.contains('hidden')) closeCueModal();
    else if (!$('scriptModal').classList.contains('hidden')) closeScriptModal();
    else if (!$('setModal').classList.contains('hidden')) closeSetModal();
    else if (!$('localTtsModal').classList.contains('hidden')) closeLocalTtsModal();
    else if (scriptPlaying) stopScript();
  });
  // 목소리·속도가 바뀌면 준비 상태(캐시)가 무효 → 표시 갱신
  $('ttsVoice').addEventListener('change', renderCues);
  $('ttsRate').addEventListener('change', renderCues);

  // 탭 전환 (대본 / 등록 큐 / 녹음)
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      for (const key of ['cues', 'sets', 'recs']) {
        $('tab-' + key).classList.toggle('hidden', name !== key);
      }
      $('cueActions').classList.toggle('hidden', name !== 'cues');
      $('setActions').classList.toggle('hidden', name !== 'sets');
      $('recActions').classList.toggle('hidden', name !== 'recs');
      if (name === 'recs') renderRecordings();
      if (name === 'sets') renderCueSets();
    });
  });

  $('playbackEl').addEventListener('ended', () => {
    state.playingPath = null;
    renderRecordings();
  });

  window.api.onHotkey((h) => {
    if (h.type === 'preset') applyPreset(h.index);
    else if (h.type === 'cue') {
      const cues = loadCues();
      if (cues[h.index]) playCue(cues[h.index].id);
    } else if (h.type === 'record') toggleRecording();
    else if (h.type === 'bypass') {
      state.bypass = !state.bypass;
      updateBypassBtn();
      applyParams();
    }
  });

  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

  updateMonitorBtn();
  updateBypassBtn();
  applyPreset(0);
  renderRecordings();
  tick();
}

// 조용히 죽는 오류를 화면에 드러냄 (디버깅용)
window.addEventListener('error', (e) => toast('오류: ' + e.message));
window.addEventListener('unhandledrejection', (e) => {
  toast('오류: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
});

init();
