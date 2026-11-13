// 独立输入条窗口的渲染脚本（够小，不依赖舞台那一套）
const bar = document.getElementById('bar')
const input = document.getElementById('input')
const mic = document.getElementById('mic')

function close(interrupt = false) {
  window.chat.close(interrupt)
}

bar.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  window.chat.say(text)
})

document.getElementById('close').addEventListener('click', () => close(false))

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); close(true) }
})

window.chat.onShown(() => {
  input.value = ''
  input.focus()
  // 刚显示时窗口可能还没拿到焦点，下一帧再抢一次
  setTimeout(() => input.focus(), 30)
})

// ---------- 长按说话 ----------
// 采样率就按 16k 建 AudioContext：Chromium 会把设备流重采样到 16k，
// 我们拿到的就是 SenseVoice 要的那一档，省掉自己做重采样。
const MIN_MS = 300        // 短于这个时长当误触
const MAX_MS = 30000      // 上限 30 秒，超了自动停

let rec = null            // { ctx, node, stream, chunks, startedAt, timer }

async function startRec() {
  if (rec) return
  mic.classList.add('busy')
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const ctx = new AudioContext({ sampleRate: 16000 })
    // 注意：这是 classic script，不能用 import.meta（会整段语法错误、所有函数都不存在）
    await ctx.audioWorklet.addModule(new URL('./rec-worklet.js', location.href).href)
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'recorder')
    const chunks = []
    node.port.onmessage = (e) => chunks.push(new Int16Array(e.data))
    src.connect(node)
    // 不连到 destination：只听不播，避免把麦克风回放出来
    rec = { ctx, node, stream, chunks, startedAt: performance.now(), timer: 0 }
    rec.timer = setTimeout(() => { void stopRec() }, MAX_MS)
    mic.classList.remove('busy')
    mic.classList.add('rec')
    mic.textContent = '●'
  } catch (err) {
    mic.classList.remove('busy')
    input.placeholder = '麦克风打不开（权限或设备）'
    console.warn('[mic]', err)
  }
}

async function stopRec() {
  if (!rec) return
  const cur = rec
  rec = null
  clearTimeout(cur.timer)
  mic.classList.remove('rec')
  mic.classList.add('busy')
  mic.textContent = '…'
  const held = performance.now() - cur.startedAt
  try {
    cur.node.port.postMessage('stop')
    cur.node.port.onmessage = null
    cur.stream.getTracks().forEach((t) => t.stop())
    await cur.ctx.close()
  } catch {}

  if (held < MIN_MS) {
    mic.classList.remove('busy')
    mic.textContent = '🎤'
    return
  }

  const total = cur.chunks.reduce((n, c) => n + c.length, 0)
  const all = new Int16Array(total)
  let off = 0
  for (const c of cur.chunks) { all.set(c, off); off += c.length }
  const bytes = new Uint8Array(all.buffer)
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
  }
  const b64 = btoa(bin)

  input.placeholder = '听着呢…'
  try {
    const r = await window.chat.asr(b64)
    if (r && r.ok && r.text) {
      input.value = ''
      window.chat.say(r.text)
    } else {
      input.placeholder = (r && r.error && `没听清：${r.error}`) || '没听清，再说一次？'
    }
  } catch (err) {
    input.placeholder = '转写失败（看日志）'
    console.warn('[asr]', err)
  } finally {
    mic.classList.remove('busy')
    mic.textContent = '🎤'
    setTimeout(() => { input.placeholder = '和她说点什么…（Enter 发送 / Esc 关闭）' }, 2200)
  }
}

mic.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  void startRec()
  // 合成事件/某些环境里 setPointerCapture 会抛（pointerId 无效），不能让它挡了录音
  try { mic.setPointerCapture?.(e.pointerId) } catch {}
})
mic.addEventListener('pointerup', (e) => {
  e.preventDefault()
  void stopRec()
})
mic.addEventListener('pointercancel', () => { void stopRec() })
