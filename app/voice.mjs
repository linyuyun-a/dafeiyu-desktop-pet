/**
 * 语音播放：服务端吐 48k 单声道 int16 原始块 → AudioWorklet 环形队列 → 电平给口型。
 *
 * 为什么不用 <audio>：块是没有容器头的裸 PCM，<audio> 不认；而且需要“边收边播”。
 * 为什么不用「一块一个 BufferSource」：到达时刻不确定，早到会叠在同一个时间点
 * （几块相加 → 削波 → 听感是刺耳的滋滋声），晚到会留缝（咔）。AudioWorklet
 * 由音频线程自己拉队列，有多少放多少，天然不重叠不留缝。
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

export function createVoice({ log } = {}) {
  const say = (m, ...rest) => { try { log?.(m, ...rest) } catch {} }
  let ctx = null
  let node = null
  let ready = null          // Promise
  let queued = 0
  let level = 0
  let lastHeard = 0
  let chunks = 0
  let stoppedAt = 0
  let peak = 0
  let jumps = 0
  let samples = 0
  let lastTail = 0
  const dbg = { sizes: [], jumps: [], first: [] }
  let pending = []          // worklet 还没就绪时先攒着

  function int16ToFloat(b64) {
    const bin = atob(b64 || '')
    const n = bin.length >> 1
    if (!n) return null
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const lo = bin.charCodeAt(i * 2)
      const hi = i * 2 + 1 < bin.length ? bin.charCodeAt(i * 2 + 1) : 0
      let v = (hi << 8) | lo
      if (v >= 0x8000) v -= 0x10000
      out[i] = v / 32768
    }
    return out
  }

  function ensure() {
    if (ready) return ready
    ready = (async () => {
      const AC = window.AudioContext || window.webkitAudioContext
      ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' })
      await ctx.audioWorklet.addModule(new URL('./voice-worklet.js', import.meta.url))
      node = new AudioWorkletNode(ctx, 'stream-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] })
      const gain = ctx.createGain()
      gain.gain.value = 0.9   // 留一点余量，别顶到 0dB
      node.connect(gain)
      gain.connect(ctx.destination)
      node.port.onmessage = (e) => {
        const d = e.data || {}
        if (typeof d.level === 'number') {
          level = d.level
          if (d.level > 0.02) lastHeard = Date.now()
        }
        if (typeof d.queued === 'number') queued = d.queued
      }
      say('[voice] worklet 就绪', ctx.sampleRate)
      for (const p of pending) node.port.postMessage(p)
      pending.length = 0
    })()
    return ready
  }

  /** 一块裸 PCM（base64 的 int16 LE） */
  function push(b64) {
    const f = int16ToFloat(b64)
    if (!f) return
    // 诊断：统计「采样间大跳变」。干净语音几乎不会出现 >0.6 的相邻跳变，
    // 一旦出现就说明字节对齐错了（半采样错位 = 满屏滋滋声）。
    let prev = lastTail
    for (let i = 0; i < f.length; i++) {
      if (Math.abs(f[i] - prev) > 0.6) jumps += 1
      prev = f[i]
    }
    let jc = 0
    for (let i = 0; i < f.length; i++) { const a = i ? f[i - 1] : lastTail; if (Math.abs(f[i] - a) > 0.6) jc += 1 }
    if (dbg.sizes.length < 12) { dbg.sizes.push(f.length); dbg.jumps.push(jc); dbg.first.push([+f[0].toFixed(3), +f[1].toFixed(3), +f[2].toFixed(3)]) }
    lastTail = f[f.length - 1]
    samples += f.length
    chunks += 1
    void ensure().then(() => {
      if (!node) return
      node.port.postMessage(f)
      if (ctx.state === 'suspended') void ctx.resume()
    })
  }

  /** 立刻停：清空队列（打断 / 点她 / Esc） */
  function stop() {
    stoppedAt = Date.now()
    level = 0
    pending.length = 0
    if (node) node.port.postMessage(null)
  }

  /** 0..1 电平（给口型）。停掉 300ms 后强制归零，防残留。 */
  function levelNow() {
    if (!node) return 0
    if (Date.now() - stoppedAt < 300) return 0
    if (!queued && Date.now() - lastHeard > 220) return 0
    // 带通之后的语音 RMS 大约 0.005–0.05，除以 0.03 才铺满 0–1（原来是全带 RMS，量级不同）
    // 带通之后的语音 RMS 大约 0.005–0.05；开方把中间值抬起来，口型才有“张合”而不是微动
    // 带通包络的实测区间：静音 ~0.005，正常说话 0.05–0.30
    const v = Math.pow(clamp((level - 0.012) / 0.22, 0, 1), 0.8)
    peak = Math.max(peak * 0.999, v)
    return v
  }

  return {
    push,
    stop,
    level: levelNow,
    get playing() { return queued > 0 || Date.now() - lastHeard < 180 },
    get stats() { return { chunks, queued, level: Number(level.toFixed(3)), peak: Number(peak.toFixed(3)), state: ctx?.state || 'none', jumps, samples, sec: Number((samples / 48000).toFixed(2)), dbg } },
  }
}
