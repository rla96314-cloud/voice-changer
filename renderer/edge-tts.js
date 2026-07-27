/* Edge 신경망 TTS 클라이언트 (무의존성)
 * Microsoft Edge '소리내어 읽기'와 같은 엔드포인트를 사용한다.
 * 인터넷 연결 필요. 결과는 MP3 ArrayBuffer로 반환 → decodeAudioData로 디코딩.
 */
'use strict';

const EDGE_TTS = (() => {
  const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const GEC_VERSION = '1-143.0.3650.75';

  const VOICES = [
    // 한국어 네이티브
    { name: 'ko-KR-SunHiNeural', label: '선히 (여성 · 한국어)' },
    { name: 'ko-KR-InJoonNeural', label: '인준 (남성 · 한국어)' },
    { name: 'ko-KR-HyunsuMultilingualNeural', label: '현수 (남성 · 한국어)' },
    // 다국어 음성 — 한국어도 자연스럽게 읽음 (톤이 조금씩 다름)
    { name: 'en-US-AvaMultilingualNeural', label: '에이바 (여성 · 부드러움)' },
    { name: 'en-US-EmmaMultilingualNeural', label: '엠마 (여성 · 밝음)' },
    { name: 'en-US-AndrewMultilingualNeural', label: '앤드류 (남성 · 차분함)' },
    { name: 'en-US-BrianMultilingualNeural', label: '브라이언 (남성 · 따뜻함)' },
    { name: 'de-DE-SeraphinaMultilingualNeural', label: '세라피나 (여성 · 우아함)' },
    { name: 'fr-FR-RemyMultilingualNeural', label: '레미 (남성 · 활기참)' },
    // 다른 언어
    { name: 'en-US-AriaNeural', label: 'Aria (여성 · 영어)' },
    { name: 'en-US-GuyNeural', label: 'Guy (남성 · 영어)' },
    { name: 'ja-JP-NanamiNeural', label: 'Nanami (여성 · 일본어)' },
  ];

  function uuid() {
    return crypto.randomUUID().replace(/-/g, '');
  }

  // Sec-MS-GEC: 5분 단위로 내림한 Windows FILETIME + 토큰의 SHA-256 (대문자 hex)
  async function secMsGec() {
    let sec = BigInt(Math.floor(Date.now() / 1000) + 11644473600);
    sec -= sec % 300n;
    const ticks = sec * 10000000n;
    const data = new TextEncoder().encode(ticks.toString() + TOKEN);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function escapeXml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  // 끊어읽기: Edge 무료 엔드포인트는 <break> 태그를 거부하므로("SSML is invalid")
  // 문장부호로 쉼을 만든다. '/' → 쉼표(짧은 쉼 ~0.25s), '//'+ → 마침표(긴 쉼 ~0.8s), 줄바꿈 → 마침표.
  // WordBoundary는 문장부호를 단어에 포함하지 않으므로 자막은 깨끗하게 유지된다.
  function applyPauseMarks(text) {
    return text
      .replace(/\/{2,}/g, '. ')
      .replace(/\//g, ', ')
      .replace(/\n+/g, '. ');
  }

  // 반환: { audio: ArrayBuffer(mp3), words: [{ start, end, text }] (초 단위) }
  async function synthesize(text, voice, ratePct) {
    const gec = await secMsGec();
    const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
      `?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${uuid()}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const chunks = [];
      const words = [];
      // 긴 텍스트는 스트리밍이 오래 걸리므로 '고정' 타임아웃 대신
      // 데이터가 올 때마다 리셋되는 '유휴' 타임아웃을 쓴다. 절대 상한은 별도.
      let idleTimer;
      const IDLE_MS = 12000;   // 12초간 아무 응답 없으면 멈춘 것으로 간주
      const HARD_MS = 300000;  // 절대 상한 5분
      const bumpIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try { ws.close(); } catch (e) { /* 무시 */ }
          done(reject, new Error('TTS 응답이 멈췄습니다 (서버 무응답)'));
        }, IDLE_MS);
      };
      const hardTimer = setTimeout(() => {
        try { ws.close(); } catch (e) { /* 무시 */ }
        done(reject, new Error('TTS 생성 시간이 너무 깁니다 (텍스트를 나눠보세요)'));
      }, HARD_MS);
      const clearTimers = () => { clearTimeout(idleTimer); clearTimeout(hardTimer); };
      bumpIdle(); // 연결 자체가 안 열리는 경우도 유휴 타임아웃으로 잡는다

      ws.onopen = () => {
        bumpIdle();
        const ts = new Date().toString();
        ws.send(
          `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: { synthesis: { audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
              outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            } } },
          })
        );
        const rate = (ratePct >= 0 ? '+' : '') + ratePct + '%';
        const ssml =
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ko-KR'>` +
          `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
          escapeXml(applyPauseMarks(text)) +
          `</prosody></voice></speak>`;
        ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n${ssml}`);
      };

      ws.onmessage = (ev) => {
        bumpIdle(); // 데이터가 오는 동안은 타임아웃 리셋
        if (typeof ev.data === 'string') {
          if (ev.data.includes('Path:audio.metadata')) {
            const body = ev.data.slice(ev.data.indexOf('\r\n\r\n') + 4);
            try {
              const j = JSON.parse(body);
              for (const m of j.Metadata || []) {
                if (m.Type === 'WordBoundary') {
                  const start = m.Data.Offset / 1e7;
                  words.push({ start, end: start + m.Data.Duration / 1e7, text: m.Data.text.Text });
                }
              }
            } catch (e) { /* 메타데이터 파싱 실패 무시 */ }
          } else if (ev.data.includes('Path:turn.end')) {
            clearTimers();
            ws.close();
            if (chunks.length === 0) return done(reject, new Error('오디오를 받지 못했습니다'));
            const total = chunks.reduce((s, c) => s + c.byteLength, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(new Uint8Array(c), off); off += c.byteLength; }
            done(resolve, { audio: out.buffer, words });
          }
        } else {
          const dv = new DataView(ev.data);
          const hlen = dv.getUint16(0);
          const header = new TextDecoder().decode(ev.data.slice(2, 2 + hlen));
          if (header.includes('Path:audio')) chunks.push(ev.data.slice(2 + hlen));
        }
      };

      ws.onerror = () => { clearTimers(); done(reject, new Error('TTS 서버 연결 실패 (인터넷 연결 확인)')); };
      ws.onclose = () => { clearTimers(); done(reject, new Error('TTS 연결이 끊어졌습니다')); };
    });
  }

  return { VOICES, synthesize };
})();
