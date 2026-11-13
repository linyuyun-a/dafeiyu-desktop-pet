/**
 * 流式播放用的 AudioWorklet。
 *
 * 为什么不用「每个块排一个 BufferSource」：块是网络来的，到达时刻不确定，
 * 早到就被塞进同一个时间点、晚到就留空——前者叠出爆音（听感是刺耳的滋滋声），
 * 后者每次断口都「咔」一下。改成环形队列由音频线程自己拉：有多少放多少，
 * 没有就补零，永远不重叠、不留缝。
 *
 * 电平也在这里算，但**先过一层带通再算 RMS**：
 * 全带 RMS 会被「嘶/呲」这类齿音带飞，嘴张得比元音还大，看起来像在惊讶。
 * 人声开口度主要跟 120–1200Hz 的能量走，所以这里高通 120Hz + 低通 1200Hz，
 * 再加一个 attack/release 包络，让口型跟音节而不是跟波形抖。
 */

// RBJ biquad 系数（48kHz 固定，省得每帧重算）
function biquad(type, f0, q, sr) {
  const w0 = (2 * Math.PI * f0) / sr
  const cos = Math.cos(w0), sin = Math.sin(w0)
  const alpha = sin / (2 * q)
  let b0, b1, b2, a0, a1, a2
  if (type === 'hp') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha
  } else {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 }
}

function run(s, x) {
  const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2
  s.x2 = s.x1; s.x1 = x
  s.y2 = s.y1; s.y1 = y
  return y
}

const ATTACK = 1 - Math.exp(-1 / (0.010 * 48000))
const RELEASE = 1 - Math.exp(-1 / (0.075 * 48000))

class StreamPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.head = 0
    this.acc = 0
    this.accN = 0
    this.hp = biquad('hp', 120, 0.707, sampleRate)
    this.lp = biquad('lp', 1200, 0.707, sampleRate)
    this.env = 0
    this.port.onmessage = (e) => {
      const d = e.data
      if (d === null) { this.queue.length = 0; this.head = 0; this.env = 0; return }
      if (d instanceof Float32Array) this.queue.push(d)
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    if (!out) return true
    let i = 0
    while (i < out.length) {
      const cur = this.queue[0]
      if (!cur) {
        for (; i < out.length; i++) out[i] = 0
        break
      }
      const n = Math.min(cur.length - this.head, out.length - i)
      out.set(cur.subarray(this.head, this.head + n), i)
      this.head += n
      i += n
      if (this.head >= cur.length) { this.queue.shift(); this.head = 0 }
    }

    // 带通 → 整流 → attack/release 包络 → 平方和（512 采样一块回传）
    for (let k = 0; k < out.length; k++) {
      const x = run(this.hp, out[k])
      const y = Math.abs(run(this.lp, x))
      const c = y > this.env ? ATTACK : RELEASE
      this.env += (y - this.env) * c
      this.acc += this.env * this.env
      this.accN += 1
    }
    if (this.accN >= 512) {
      this.port.postMessage({ level: Math.sqrt(this.acc / this.accN), queued: this.queue.length })
      this.acc = 0
      this.accN = 0
    }
    return true
  }
}

registerProcessor('stream-player', StreamPlayer)
