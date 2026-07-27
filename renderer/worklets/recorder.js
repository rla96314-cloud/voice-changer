// 처리된 오디오(모노)를 Float32 청크로 모아 메인 스레드에 전달하는 녹음 탭.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunk = new Float32Array(16384);
    this.pos = 0;
    this.port.onmessage = (e) => {
      const { cmd } = e.data;
      if (cmd === 'start') {
        this.pos = 0;
        this.recording = true;
      } else if (cmd === 'stop') {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: 'done' });
      }
    };
  }

  flush() {
    if (this.pos > 0) {
      const out = this.chunk.slice(0, this.pos);
      this.port.postMessage({ type: 'chunk', data: out }, [out.buffer]);
      this.pos = 0;
    }
  }

  process(inputs) {
    if (!this.recording) return true;
    const inCh = inputs[0] && inputs[0][0];
    if (!inCh) return true;
    for (let i = 0; i < inCh.length; i++) {
      this.chunk[this.pos++] = inCh[i];
      if (this.pos >= this.chunk.length) {
        this.flush();
        this.chunk = new Float32Array(16384);
      }
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
