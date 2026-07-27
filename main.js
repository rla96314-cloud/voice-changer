const { app, BrowserWindow, globalShortcut, ipcMain, shell, systemPreferences, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const overlayServer = require('./overlay-server');
const { fetchLocal } = require('./local-tts');

const OVERLAY_PORT = 8103;
let win = null;

// 중복 실행 방지 — 두 번째 인스턴스는 오버레이 서버 포트를 못 잡아 조용히 고장난다
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function recordDir() {
  return path.join(app.getPath('documents'), 'VoiceChanger녹음');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: '#14161b',
    title: 'VoiceChanger',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch (e) { /* 무시 */ }
  }

  // Edge TTS 웹소켓 핸드셰이크에 Edge 브라우저와 같은 Origin/UA를 실어 보낸다
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['wss://speech.platform.bing.com/*', 'https://speech.platform.bing.com/*'] },
    (details, callback) => {
      details.requestHeaders['Origin'] = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
      details.requestHeaders['User-Agent'] =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/143.0.0.0 Safari/537.36 Edg/143.0.3650.75';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  try { overlayServer.start(OVERLAY_PORT); } catch (e) { console.error('overlay 서버 시작 실패', e); }

  createWindow();

  for (let i = 1; i <= 8; i++) {
    globalShortcut.register(`Control+Alt+${i}`, () => send('hotkey', { type: 'preset', index: i - 1 }));
  }
  // 큐 발사: Ctrl+Shift+1~9 (방송 중 다른 창에 있어도 동작)
  for (let i = 1; i <= 9; i++) {
    globalShortcut.register(`Control+Shift+${i}`, () => send('hotkey', { type: 'cue', index: i - 1 }));
  }
  globalShortcut.register('Control+Alt+R', () => send('hotkey', { type: 'record' }));
  globalShortcut.register('Control+Alt+B', () => send('hotkey', { type: 'bypass' }));

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 끊어읽기 마커 파싱: '/' 개수 × 250ms, 줄바꿈 = 400ms
function parsePauses(text) {
  const parts = [];
  const re = /(\/+|\n+)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ breakMs: m[1][0] === '/' ? Math.min(m[1].length * 250, 5000) : 400 });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// Windows SAPI용: 쉼을 문장부호로 (짧은 쉼=쉼표, 긴 쉼=마침표). SAPI가 plain text에서 자연스러운 쉼 부여
function toPunctuated(text) {
  return parsePauses(text)
    .map((p) => (p.text != null ? p.text : (p.breakMs >= 400 ? '. ' : ', ')))
    .join('');
}

// macOS say용 텍스트 (쉼은 [[slnc ms]] 인라인 명령)
function toSayText(text) {
  return parsePauses(text)
    .map((p) => (p.text != null ? p.text : `[[slnc ${p.breakMs}]]`))
    .join('');
}

ipcMain.handle('save-recording', async (_e, arrayBuffer) => {
  const dir = recordDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `녹음-${stamp()}.wav`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
  return { name, path: filePath };
});

ipcMain.handle('list-recordings', async () => {
  const dir = recordDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.wav'))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { name: f, path: p, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle('delete-recording', async (_e, filePath) => {
  const dir = recordDir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(dir + path.sep)) throw new Error('녹음 폴더 밖의 파일은 삭제할 수 없습니다');
  await shell.trashItem(resolved);
  return true;
});

ipcMain.handle('open-recordings-folder', async () => {
  const dir = recordDir();
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return true;
});

/* ── TTS (OS 내장: Windows SAPI / macOS say) ── */
function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim().slice(0, 300)));
      else resolve(stdout);
    });
  });
}

let ttsVoicesCache = null;
async function getTtsVoices() {
  if (ttsVoicesCache) return ttsVoicesCache;
  let voices = [];
  try {
    if (process.platform === 'win32') {
      const out = await execFileP('powershell.exe', ['-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Speech; ' +
        '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
        'ForEach-Object { $v = $_.VoiceInfo; "$($v.Name)`t$($v.Culture.Name)" }']);
      voices = out.split(/\r?\n/).filter(Boolean).map((l) => {
        const [name, lang] = l.split('\t');
        return { name: name.trim(), lang: (lang || '').trim() };
      });
    } else if (process.platform === 'darwin') {
      const out = await execFileP('say', ['-v', '?']);
      voices = out.split('\n').map((l) => {
        const m = l.match(/^(.+?)\s+([a-z]{2}[_-][A-Z]{2})\s/);
        return m ? { name: m[1].trim(), lang: m[2].replace('_', '-') } : null;
      }).filter(Boolean);
    }
  } catch (e) {
    voices = [];
  }
  ttsVoicesCache = voices;
  return voices;
}

ipcMain.handle('tts-voices', () => getTtsVoices());

ipcMain.handle('overlay-url', () => `http://localhost:${OVERLAY_PORT}/overlay`);
ipcMain.on('caption', (_e, event) => overlayServer.push(event));

// 로컬 TTS 서버(수퍼토닉/GPT-SoVITS) 프록시 — 렌더러의 CORS 제약 우회, localhost 전용
ipcMain.handle('local-tts-fetch', async (_e, opts) => {
  const r = await fetchLocal(opts || {});
  if (r.error) return { ok: false, error: r.error };
  return {
    ok: r.ok,
    status: r.status,
    data: r.buffer.buffer.slice(r.buffer.byteOffset, r.buffer.byteOffset + r.buffer.byteLength),
  };
});

let ttsSeq = 0;
ipcMain.handle('tts-speak', async (_e, { text, voice, rate }) => {
  text = String(text || '').slice(0, 2000);
  if (!text.trim()) throw new Error('내용이 없습니다');
  const voices = await getTtsVoices();
  const voiceName = voices.some((v) => v.name === voice) ? voice : null;
  const r = Math.max(-10, Math.min(10, Math.round(Number(rate) || 0)));
  const tmp = app.getPath('temp');
  const id = `voicechanger-tts-${process.pid}-${ttsSeq++}`;
  const txtFile = path.join(tmp, id + '.txt');
  const wavFile = path.join(tmp, id + '.wav');
  try {
    if (process.platform === 'win32') {
      fs.writeFileSync(txtFile, toPunctuated(text), 'utf8'); // 쉼은 문장부호로
      const q = (s) => s.replace(/'/g, "''");
      const psVoice = voiceName ? `$null = $s.SelectVoice('${q(voiceName)}'); ` : '';
      const script =
        'Add-Type -AssemblyName System.Speech; ' +
        `$t = [IO.File]::ReadAllText('${q(txtFile)}', [Text.Encoding]::UTF8); ` +
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
        psVoice +
        `$s.Rate = ${r}; ` +
        `$s.SetOutputToWaveFile('${q(wavFile)}'); ` +
        '$s.Speak($t); $s.Dispose()';
      await execFileP('powershell.exe', ['-NoProfile', '-Command', script]);
    } else if (process.platform === 'darwin') {
      fs.writeFileSync(txtFile, toSayText(text), 'utf8'); // 쉼은 [[slnc]]
      const wpm = 180 + r * 12; // -10~10 → 60~300 단어/분
      const args = ['-o', wavFile, '--file-format=WAVE', '--data-format=LEI16@22050', '-r', String(wpm), '-f', txtFile];
      if (voiceName) args.unshift('-v', voiceName);
      await execFileP('say', args);
    } else {
      throw new Error('이 플랫폼에서는 TTS를 지원하지 않습니다');
    }
    const buf = fs.readFileSync(wavFile);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } finally {
    try { fs.unlinkSync(txtFile); } catch (e) { /* 무시 */ }
    try { fs.unlinkSync(wavFile); } catch (e) { /* 무시 */ }
  }
});
