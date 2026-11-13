// 录音 worklet：把麦克风输入转成 16k 单声道 int16 块，回传给主线程。
// 放在 worklet 里而不是用 MediaRecorder：省掉 webm/opus 解码，拿到的是裸 PCM。
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.on = true
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.on = false
    }
  }
  process(inputs) {
    if (!this.on) return true
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    // 已经是 16k（AudioContext 指定了采样率），直接转 int16
    const buf = new Int16Array(ch.length)
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]))
      buf[i] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
    this.port.postMessage(buf.buffer, [buf.buffer])
    return true
  }
}
registerProcessor('recorder', Recorder)
