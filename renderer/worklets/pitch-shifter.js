// 그래뉼러(듀얼 그레인) 방식 실시간 피치 시프터.
// 링버퍼에 입력을 쓰고, 두 개의 읽기 지점을 사인 윈도우로 크로스페이드하며
// 딜레이를 톱니파로 변조해 재생 속도(=피치)를 바꾼다.
class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchRatio', defaultValue: 1.0, minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.size = 1 << 14; // 16384 샘플 ≈ 341ms @48kHz
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.grain = Math.round(sampleRate * 0.08); // 80ms 그레인
    this.phase = 0;
  }

  read(delay) {
    const pos = this.w - delay;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = this.buf[i0 & this.mask];
    const b = this.buf[(i0 + 1) & this.mask];
    return a + (b - a) * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const inCh = input && input[0];
    const n = output[0].length;
    const ratio = parameters.pitchRatio[0];
    const inc = (1 - ratio) / this.grain;

    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0;
      this.buf[this.w] = x;

      let y;
      if (Math.abs(ratio - 1) < 1e-4) {
        y = x;
        this.phase = 0;
      } else {
        this.phase += inc;
        this.phase -= Math.floor(this.phase);
        const p1 = this.phase;
        const p2 = (this.phase + 0.5) % 1;
        const g1 = Math.sin(Math.PI * p1);
        const g2 = Math.sin(Math.PI * p2);
        y = this.read(p1 * this.grain) * g1 + this.read(p2 * this.grain) * g2;
      }

      for (let ch = 0; ch < output.length; ch++) output[ch][i] = y;
      this.w = (this.w + 1) & this.mask;
    }
    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
