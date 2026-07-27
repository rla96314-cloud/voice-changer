// 자막 오버레이용 초경량 HTTP + SSE 서버 (무의존성)
// OBS 브라우저 소스가 http://localhost:PORT/overlay 를 열면
// 앱의 TTS 재생에 맞춰 자막이 실시간으로 흘러온다.
const http = require('http');
const fs = require('fs');
const path = require('path');

let clients = [];
let lastShow = null;  // 늦게 접속한 오버레이가 현재 문장을 이어받도록 보관
let lastStyle = null; // 자막 스타일도 보관해 새로 연 오버레이에 바로 적용

function write(res, event) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); return true; }
  catch (e) { return false; }
}

function broadcast(event) {
  clients = clients.filter((res) => write(res, event));
}

// 렌더러에서 온 자막 이벤트를 오버레이들에 중계
function push(event) {
  if (event.type === 'show') lastShow = { type: 'show', words: event.words, chunks: event.chunks, idx: -1 };
  else if (event.type === 'clear') lastShow = null;
  else if (event.type === 'word' && lastShow) lastShow.idx = event.idx;
  else if (event.type === 'style') lastStyle = event;
  broadcast(event);
}

function start(port) {
  const overlayHtml = fs.readFileSync(path.join(__dirname, 'renderer', 'overlay.html'), 'utf8');

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 2000\n\n');
      clients.push(res);
      if (lastStyle) write(res, lastStyle); // 현재 스타일 먼저 적용
      if (lastShow) write(res, lastShow);   // 진행 중이던 자막 즉시 복원
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients = clients.filter((c) => c !== res);
      });
    } else if (url === '/' || url === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(overlayHtml);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });

  server.on('error', (e) => console.error('[overlay] 서버 오류:', e.message));
  server.listen(port, '127.0.0.1', () => console.log(`[overlay] http://localhost:${port}/overlay`));
  return server;
}

module.exports = { start, push, clientCount: () => clients.length };
