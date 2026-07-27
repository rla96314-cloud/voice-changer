// 로컬 TTS 서버(수퍼토닉 / GPT-SoVITS) HTTP 호출 — 보안상 localhost 전용
const http = require('http');

function fetchLocal({ url, method = 'GET', json = null, timeoutMs = 180000 }) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: '잘못된 주소: ' + url }); }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) {
      return resolve({ ok: false, error: '로컬(127.0.0.1) http 주소만 허용됩니다' });
    }
    const body = json ? Buffer.from(JSON.stringify(json)) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ ok: res.statusCode === 200, status: res.statusCode, buffer: Buffer.concat(chunks) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('응답 시간 초과')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { fetchLocal };
