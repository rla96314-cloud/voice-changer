// 엔벨로프 팔로워 기반 노이즈 게이트.
// 입력 레벨이 임계값(dB) 아래로 내려가면 부드럽게 음소거한다.
class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.env = 0;
    this.gain = 1;
    // 시간 상수 → 1샘플당 계수
    this.envDecay = Math.exp(-1 / (sampleRate * 0.05));  // 50ms 엔벨로프 릴리즈
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.005)); // 5ms 게이트 열림
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.08)); // 80ms 게이트 닫힘
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const inCh = input && input[0];
    const n = output[0].length;
    const enabled = parameters.enabled[0] >= 0.5;
    const thLin = Math.pow(10, parameters.threshold[0] / 20);

    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0;
      const a = Math.abs(x);
      this.env = a > this.env ? a : this.env * this.envDecay;

      let y = x;
      if (enabled) {
        const target = this.env > thLin ? 1 : 0;
        this.gain += (target - this.gain) * (target > this.gain ? this.attack : this.release);
        y = x * this.gain;
      } else {
        this.gain = 1;
      }
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = y;
    }
    return true;
  }
}

registerProcessor('noise-gate', NoiseGateProcessor);
