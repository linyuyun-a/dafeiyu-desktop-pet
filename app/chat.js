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
let starting = false      // startRec 还在等权限/建 AudioContext
let wantRec = false       // 用户此刻是否想录音
let latched = false       // 「点一下开始、再点一下停」的锁定态
let downAt = 0

async function startRec() {
  if (rec || starting) return
  starting = true
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
    starting = false
    mic.classList.remove('busy')
    mic.classList.add('rec')
    mic.textContent = '●'
    // 关键：点击发生在「还没建好」的那几百毫秒里的话，pointerup 已经过去了，
    // 这里必须自己收尾，否则会一直录到 30 秒上限（表现就是"点一下没反应，得按住"）
    if (!wantRec && !latched) void stopRec()
  } catch (err) {
    starting = false
    wantRec = false
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
  mic.classList.remove('latched')
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
    mic.classList.remove('latched')
    mic.textContent = '🎤'
    input.placeholder = '太短了，再说一次？'
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

// 两种用法都支持：
//   按住说 → 抬手就停（传统对讲机）
//   点一下 → 锁定录音，再点一下停（省得一直按着）
const HOLD_MS = 400

mic.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  e.stopPropagation()
  if (latched) {
    // 锁定态下再点一次 = 停
    latched = false
    wantRec = false
    void stopRec()
    input.placeholder = '听着呢…'
    return
  }
  wantRec = true
  downAt = performance.now()
  input.placeholder = '听着呢…（松手即停 / 点一下锁定）'
  void startRec()
})

// 监听挂 window：指针滑出按钮也能收到 up，不会漏掉
window.addEventListener('pointerup', (e) => {
  if (!wantRec || latched) return
  const held = performance.now() - downAt
  if (held >= HOLD_MS) {
    wantRec = false
    void stopRec()
  } else {
    // 短点：锁定，继续录，等下一次点击
    latched = true
    input.placeholder = '在听…点麦克风结束'
    mic.classList.add('latched')
  }
})

window.addEventListener('pointercancel', () => {
  wantRec = false
  latched = false
  void stopRec()
})

// 关掉输入条时别留下一个在录的流
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && rec) { wantRec = false; latched = false; void stopRec() }
}, true)
