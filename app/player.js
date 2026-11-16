// 唱片机：只负责「放 + 显示」。歌在哪儿、放哪首由主进程决定。
const $ = (id) => document.getElementById(id)
const audio = $('audio')
const disc = $('disc')
const discWrap = $('discWrap')
const spectra = []

let cfg = { stage: '', token: '' }
let song = null
let lines = []
let curLine = -1
let queuePos = { i: 0, n: 1 }
// 拖动进度条：拖动期间只动视觉，松手才 seek（照卡西米尔的 SliderPlus）
let seeking = false
let seekWasPlaying = false

const fmt = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function setProgress(ratio) {
  const el = $('seek')
  const v = Math.max(0, Math.min(1, Number(ratio) || 0))
  el.value = String(Math.round(v * 1000))
  el.style.background = `linear-gradient(90deg, rgba(111,211,255,0.85) ${v * 100}%, rgba(255,255,255,0.14) ${v * 100}%)`
}

function paintQueue() {
  const prev = $('prev')
  const next = $('next')
  if (prev) prev.disabled = queuePos.i <= 0
  if (next) next.disabled = queuePos.n <= 1 || queuePos.i >= queuePos.n - 1
}

// ---------- 频谱 ----------
for (let i = 0; i < 44; i++) {
  const bar = document.createElement('i')
  $('spectrum').appendChild(bar)
  spectra.push(bar)
}

let ac = null
let analyser = null
let freq = null
let rafId = 0

// 全局兜底：未捕获异常只留一行 message 定位不到引擎里的具体行，
// 把 stack 也打出来（会被 main.mjs 的 console-message 转发进 main.log）。
addEventListener('error', (e) => {
  console.log('[pv] ERR ' + (e?.message || '') + ' @ ' + (e?.filename || '') + ':' + (e?.lineno || 0) + '\n' + String(e?.error?.stack || '').slice(0, 800))
})
addEventListener('unhandledrejection', (e) => {
  const r = e?.reason
  console.log('[pv] REJECT ' + (r?.message || r) + '\n' + String(r?.stack || '').slice(0, 1200))
})

// ---------- 歌词 PV（JIZURA 引擎，见 docs/设计-歌词PV.md） ----------
let pv = null
let pvTried = false
let bootPromise = null
let pvStyle = 'ocean'
let pvAuto = true          // 本首是否还由「自动」决定（点过色点就变 false，下一首恢复）
let pvMood = ''
let pvMod = null           // 动态 import 后的 pv.mjs 模块（用 pickStyle/analyse）

// 默认池：5 套覆盖常见情绪（引擎里还有 sakura/forest/vapor/synth80/kraft/candy/gold）
const PV_STYLES = [
  // 引擎里 24 套（MIT，852wa/JIZURA）：从左到右 = 冷 → 暖 → 噪
  { id: 'noir', name: 'ノワール' },
  { id: 'crimson', name: 'クリムゾン' },
  { id: 'caution', name: 'コーション' },
  { id: 'magenta', name: 'マゼンタ' },
  { id: 'paper', name: 'ペーパー' },
  { id: 'hud', name: 'HUD' },
  { id: 'mint', name: 'ミント' },
  { id: 'specimen', name: 'スペシメン' },
  { id: 'transit', name: 'トランジット' },
  { id: 'blueprint', name: 'ブループリント' },
  { id: 'rouge', name: 'ルージュ' },
  { id: 'mono', name: 'モノRGB' },
  { id: 'sakura', name: 'サクラ' },
  { id: 'ocean', name: '深海' },
  { id: 'sunset', name: '夕焼け' },
  { id: 'forest', name: '森の手帖' },
  { id: 'vapor', name: 'ヴェイパー' },
  { id: 'newsprint', name: '新聞' },
  { id: 'synth80', name: 'シンセ80s' },
  { id: 'kraft', name: 'クラフト紙' },
  { id: 'candy', name: 'キャンディ' },
  { id: 'acid', name: 'アシッド' },
  { id: 'sumi', name: '墨と朱' },
  { id: 'gold', name: '金夜' },
]

// 每个样式的代表色：优先取引擎里 scheme 的 accent / bg，取不到就用灰
function styleSwatch(id) {
  const sc = globalThis.J?.STYLES?.[id]?.schemes?.[0]
  return { c: sc?.accent || sc?.fg || '#8aa0b6', c2: sc?.bg || '#0b1520' }
}

function renderDots() {
  const box = $('pvDots')
  if (!box || box.dataset.ready) return
  box.dataset.ready = '1'
  for (const st of PV_STYLES) {
    const sw = styleSwatch(st.id)
    const b = document.createElement('button')
    b.className = 'pvbtn'
    b.type = 'button'
    b.dataset.id = st.id
    b.title = st.name
    b.style.setProperty('--c', sw.c)
    b.style.setProperty('--c2', sw.c2)
    const dot = document.createElement('i')
    dot.className = 'pvdot'
    const nm = document.createElement('span')
    nm.textContent = st.name
    b.append(dot, nm)
    b.addEventListener('click', () => chooseStyle(st.id))
    box.appendChild(b)
  }
  paintDots()
}

function bindMore() {
  const btn = $('more')
  const panel = $('morePanel')
  if (!btn || !panel) return
  const close = () => panel.classList.add('hidden')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    panel.classList.toggle('hidden')
  })
  document.addEventListener('pointerdown', (e) => {
    if (panel.classList.contains('hidden')) return
    if (panel.contains(e.target) || btn.contains(e.target)) return
    close()
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
}

function paintDots() {
  const box = $('pvDots')
  if (!box) return
  for (const b of box.querySelectorAll('.pvbtn')) b.classList.toggle('on', b.dataset.id === pvStyle)
}

function chooseStyle(id) {
  if (!PV_STYLES.some((s) => s.id === id)) return
  pvAuto = false // 本首手动覆盖；换歌时恢复自动
  pvStyle = id
  pv?.setStyle(id)
  paintDots()
  window.player?.setStyle?.(id)
}

function songText(s) {
  // 歌单名是很好的风格线索（「古风中文」「纯音顶级」「欧美风」），一起喂给规则
  return [s?.name, s?.artists, s?.album, s?.pl].filter(Boolean).join(' ')
}

async function autoStyleFor(song) {
  if (!pvAuto || !song?.id) return
  try {
    pvMod = pvMod || (await import('./pv.mjs'))
    let info = await window.player?.getAnalysis?.(song.id)
    if (!info) {
      const url = `${cfg.stage}/api/music/stream?token=${encodeURIComponent(cfg.token)}&id=${encodeURIComponent(song.id)}`
      info = await pvMod.analyse(url, (m) => console.log(m))
      if (info) window.player?.setAnalysis?.(song.id, info)
    }
    if (!pvAuto) return
    fxAudio = { bpm: info?.bpm || 0, energy: info?.energy || 0 }
    fx?.setSong({ ...song, bpm: fxAudio.bpm, energy: fxAudio.energy })
    const id = pvMod.pickStyle({ bpm: info?.bpm || 0, energy: info?.energy || 0, text: songText(song), mood: pvMood })
    if (id !== pvStyle) {
      pvStyle = id
      pv?.setStyle(id)
      paintDots()
      console.log('[pv] 自动配色 →', id, JSON.stringify(info || {}))
    }
  } catch (e) {
    console.warn('[pv] 自动配色失败', e.message)
  }
}

function initPvStyle() {
  Promise.resolve(window.player?.getStyle?.())
    .then((id) => {
      if (id && PV_STYLES.some((s) => s.id === id)) pvStyle = id
      renderDots()
      paintDots()
      pv?.setStyle(pvStyle)
    })
    .catch(() => {
      renderDots()
    })
}

function bootPv() {
  if (pv) return Promise.resolve(pv)
  if (bootPromise) return bootPromise
  let canvas = $('pv')
  if (!canvas) {
    // 自愈：万一 #lyrics 的 DOM 被重建（或者老版本 HTML 没有这两个 canvas），
    // 就在这里补出来，而不是让整条 PV 链路直接哑掉。
    const host = $('lyrics')
    console.log('[pv] 没有 #pv 画布 → 自愈',
      '| #lyrics=' + !!host,
      '| children=' + (host ? Array.from(host.children).map((el) => el.id || el.className || el.tagName).join(',') : '-'),
      '| canvases=' + document.querySelectorAll('canvas').length)
    if (host) {
      const fx = document.createElement('canvas')
      fx.id = 'fxCanvas'; fx.setAttribute('aria-hidden', 'true')
      canvas = document.createElement('canvas')
      canvas.id = 'pv'; canvas.className = 'hidden'
      host.insertBefore(fx, host.firstChild)
      host.insertBefore(canvas, fx.nextSibling)
    }
    if (!canvas) return Promise.resolve(null)
  }
  bootPromise = import('./pv.mjs')
    .then((m) => {
      pv = m.createPv({ canvas, log: (msg) => console.log(msg) })
      console.log('[pv] createPv →', pv ? 'ok' : 'null',
        '| J.plan=' + typeof globalThis.J?.plan,
        '| canvas=' + canvas.clientWidth + 'x' + canvas.clientHeight,
        '| cls=' + canvas.className)
      if (!pv) return
      pv.setStyle(pvStyle)
      paintDots()
      console.log('[pv] ready, style=' + pvStyle)
      return pv
    })
    .catch((e) => { console.warn('[pv] 加载失败', e.message); return null })
  return bootPromise
}

// ---------------------------------------------------------------- 装饰特效层（FX）
// 只画在歌词区那块空白里，垫在歌词下面；拿不到 XM 运行时或用户关掉开关就什么都不画。
let fx = null
let fxCtx = null
let fxCanvas = null
let fxEnabled = false
let fxLast = 0

async function bootFx() {
  if (fx) return fx
  try {
    const m = await import('./fx/index.mjs')
    fx = m.createFx({ log: (msg, ...rest) => console.log(msg, ...rest) })
    fxCanvas = $('fxCanvas')
    if (!fxCanvas) return fx
    fxCtx = fxCanvas.getContext('2d')
    const cfg = await window.player?.config?.().catch(() => null)
    fxEnabled = cfg ? cfg.fxOn !== false : true
    resizeFx()
    console.log('[fx] ready, on=' + fxEnabled)
  } catch (e) {
    console.warn('[fx] 加载失败', e.message)
  }
  return fx
}

function resizeFx() {
  if (!fxCanvas || !fxCtx) return
  const r = fxCanvas.getBoundingClientRect()
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  fxCanvas.width = Math.max(1, Math.round(r.width * dpr))
  fxCanvas.height = Math.max(1, Math.round(r.height * dpr))
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function drawFx(bass, mid, t) {
  if (!fx || !fxCtx) return
  const now = performance.now()
  if (now - fxLast < 33) return
  fxLast = now
  const r = fxCanvas.getBoundingClientRect()
  if (r.width < 40 || r.height < 40) return
  fxCtx.clearRect(0, 0, r.width, r.height)
  try {
    fx.draw(fxCtx, { t, hue: viz.hue || 200, clip: { x: 0, y: 0, w: r.width, h: r.height }, bass, mid })
  } catch (e) {
    console.warn('[fx] draw 失败', e.message)
    fxEnabled = false
  }
}

function syncPv() {
  if (!pv || !pv.ready) return
  const on = pv.draw(audio.currentTime)
  const lyrics = $('lyrics')
  if (lyrics) lyrics.classList.toggle('pvon', on)
  $('pv')?.classList.toggle('hidden', !on)
}

function ensureAudioGraph() {
  if (ac) return
  ac = new AudioContext()
  const src = ac.createMediaElementSource(audio)
  analyser = ac.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.75
  src.connect(analyser)
  analyser.connect(ac.destination)
  freq = new Uint8Array(analyser.frequencyBinCount)
  const tick = () => {
    rafId = requestAnimationFrame(tick)
    if (!viz.on) syncPv()
    if (!analyser) return
    analyser.getByteFrequencyData(freq)
    let bass = 0
    for (let i = 1; i < 6; i++) bass += freq[i] / 255
    bass /= 5
    let mids = 0
    for (let i = 10; i < 40; i++) mids += freq[i] / 255
    mids /= 30
    if (viz.on) drawViz(performance.now() / 1000, bass, mids)
    else if (fx && fxEnabled) drawFx(bass, mids, audio.currentTime)
    const n = spectra.length
    for (let i = 0; i < n; i++) {
      // 低频多分几档、高频少一点，看起来才像在「跳」
      const idx = Math.floor(Math.pow(i / n, 1.6) * (freq.length * 0.7))
      const v = freq[idx] / 255
      const h = 2 + Math.pow(v, 1.25) * 30
      spectra[i].style.height = h.toFixed(1) + 'px'
    }
  }
  tick()
}

// ---------- 播放 ----------
async function load(payload) {
  song = payload?.song || null
  cfg = { stage: payload?.stage || '', token: payload?.token || '' }
  queuePos = payload?.pos || { i: 0, n: 1 }
  paintQueue()
// 换歌时封套先淡出再换图再淡入，别硬切
function swapCover(src) {
  const img = $('cover')
  if (!img) return
  if (!src) { img.removeAttribute('src'); return }
  const pre = new Image()
  pre.onload = () => {
    img.style.opacity = '0'
    setTimeout(() => {
      img.src = src
      requestAnimationFrame(() => { img.style.opacity = '1' })
    }, 120)
  }
  pre.onerror = () => { img.src = src }
  pre.src = src
}

  if (!song?.id) return
  // 换歌：进度条先归零，别让上一首的 02:31 闪一下
  seeking = false
  setProgress(0)
  $('cur').textContent = '00:00'
  $('tot').textContent = fmt(song?.dur ? song.dur / 1000 : 0)
  $('name').textContent = song.name || '未知歌曲'
  $('artist').textContent = song.artists ? `${song.artists}${song.album ? ' · ' + song.album : ''}` : song.album || ''
  swapCover(song.pic || '')

  const qs = `token=${encodeURIComponent(cfg.token)}&id=${encodeURIComponent(song.id)}`
  audio.src = `${cfg.stage}/api/music/stream?${qs}`
  pvAuto = true // 换歌恢复自动配色；手动只在当前这首生效
  setTimeout(() => { void autoStyleFor(song) }, 800)
  try {
    ensureAudioGraph()
    await ac.resume()
  } catch {}
  try {
    await audio.play()
  } catch (e) {
    console.warn('[player] 播放被拒', e.message)
  }
  loadLyric(song.id)
  markCurrent()
  paint()
}


/** 纯音乐时用歌曲信息当"歌词"：歌名 → 歌手 → 专辑，每 6 秒一行，循环铺满整首。 */
function infoLines(sg, dur) {
  const cut = (x) => { const t = String(x || '').trim(); return t.length > 16 ? t.slice(0, 16) + '…' : t }
  const seq = [sg?.name, String(sg?.artists || '').split(' / ')[0]]
    .map(cut)
    .filter((x, i, a) => x && a.indexOf(x) === i)
  if (!seq.length) seq.push('纯音乐')
  const out = []
  let t = 400
  let i = 0
  const end = Math.max(60000, dur * 1000 - 2000)
  while (t < end) {
    out.push({ t, text: seq[i % seq.length] })
    i++
    t += 6000
  }
  return out
}

async function loadLyric(id) {
  lines = []
  curLine = -1
  renderLyric()
  try {
    const r = await fetch(`${cfg.stage}/api/music/lyric?token=${encodeURIComponent(cfg.token)}&id=${id}`)
    const j = await r.json()
    lines = Array.isArray(j?.lines) ? j.lines : []
    const tr = Array.isArray(j?.tlyric) ? j.tlyric : []
    if (lines.length && tr.length) {
      for (const l of lines) {
        const hit = tr.find((t) => Math.abs(t.t - l.t) < 400)
        if (hit) l.tr = hit.text
      }
    }
  } catch (e) {
    console.warn('[player] 歌词失败', e.message)
  }
  renderLyric()
  const instrumental = isInstrumental(lines)
  await bootPv()   // 动态 import 是异步的：不等它就 setInfo，会把第一次请求丢掉
  console.log('[pv] setLyrics 前 lines=' + lines.length + ' 纯音=' + instrumental + ' pv=' + !!pv + ' ready=' + !!pv?.ready)
  if (pv && !instrumental) pv.setLyrics(lines)
  if (pv && instrumental) {
    // 纯音乐：模板照常演，把「歌词」换成歌曲信息反复滚（用户定的方案，见 docs/探索-纯音乐画面.md）
    pv.setLyrics(infoLines(song, Number(audio?.duration) > 20 ? Number(audio.duration) : 180))
  }
  console.log('[pv] setLyrics 后 ready=' + !!pv?.ready + ' plan=' + (pv?.ready ? 'yes' : 'no'))
  // 兜底：首次 plan 可能因为画布还没量到尺寸而失败/为空，1.2s 后再喂一次
  if (pv && !pv.ready) {
    setTimeout(() => {
      if (!pv || pv.ready) return
      try {
        pv.setLyrics(instrumental ? infoLines(song, Number(audio?.duration) > 20 ? Number(audio.duration) : 180) : lines)
        console.log('[pv] 重试 setLyrics → ready=' + !!pv.ready)
      } catch (e) { console.warn('[pv] 重试失败', e && e.message) }
    }, 1200)
  }

  // 视觉层：自制动效（viz / FX）已停用 —— 纯音乐也交给 JIZURA 模板反复演歌曲信息。
  // 想再打开自绘层，把下面两行换成 vizResize() + bootViz() + vizModeSet(...) + setVizOn(instrumental)。
  setVizOn(false)
  $('lyrics')?.classList.remove('vizon')
  // FX 只是装饰层：它抛错绝不能让 PV/歌词这条主线跟着断（曾经就是这样丢的 PV）。
  void bootFx().then(() => {
    try { fx?.setSong({ ...(song || {}), mood: '' }) }
    catch (e) { console.warn('[fx] setSong 失败', e && e.message) }
  })
  if (instrumental) coverHue(song?.pic || '')
}

/**
 * 纯音乐判定：网易云对无词曲目会返回一条「纯音乐，请欣赏」，
 * 不能只按 lines.length 判断，否则这类曲子会被当成有词。
 */
function isInstrumental(list) {
  if (!list || !list.length) return true
  const junk = /纯音乐|请欣赏|暂无歌词|没有歌词|instrumental|no lyrics|♪|^\s*$/i
  const real = list.filter((l) => {
    const t = String(l.text || '').trim()
    if (!t || junk.test(t)) return false
    // 「0.0」「……」这类纯数字/纯标点也是脏数据，别当歌词演
    if (/^[\d\s\p{P}\p{S}]+$/u.test(t)) return false
    return true
  })
  return real.length === 0
}

function renderLyric() {
  // 只重画文字层：canvas#pv 与文字层是兄弟，清 lyrics 会把画布一起清掉
  const box = $('lyricsText') || $('lyrics')
  box.textContent = ''
  if (!lines.length) {
    const d = document.createElement('div')
    d.className = 'line dim'
    d.textContent = song?.id ? '（纯音乐 / 没有歌词）' : '（暂无歌词）'
    box.appendChild(d)
    return
  }
  const idx = curLine < 0 ? 0 : curLine
  const from = Math.max(0, idx - 1)
  const to = Math.min(lines.length - 1, idx + 3)
  for (let i = from; i <= to; i++) {
    const l = lines[i]
    const d = document.createElement('div')
    d.className = 'line' + (i === curLine ? ' cur' : i < curLine ? ' dim' : '')
    d.textContent = l.text
    if (l.tr && i === curLine) {
      const t = document.createElement('div')
      t.className = 'line tl'
      t.textContent = l.tr
      d.appendChild(t)
    }
    box.appendChild(d)
  }
}

/* ------------------------------------------------------------------
 * 纯音乐的可视化层（P4）：环形频谱贴唱片 + 低频浮尘 + 封面光晕
 * 只在「没有歌词」时接管画面；有词时让位给 JIZURA 的歌词 PV。
 * ------------------------------------------------------------------ */
const viz = { on: false, cv: null, ctx: null, dpr: 1, w: 0, h: 0, dust: [], hue: 200, glow: 0 }
let vizScene = null
let vizMod = null
let fxAudio = { bpm: 0, energy: 0 }
let vizBeat = 0
let vizLastBass = 0

async function bootViz() {
  if (vizScene || !$('viz')) return
  try {
    vizMod = vizMod || (await import('./viz.mjs'))
    vizScene = vizMod.createScene({ canvas: $('viz'), log: (m) => console.log(m) })
    vizScene?.setPalette(viz.hue)
    vizResize()
  } catch (e) {
    console.warn('[viz] 场景加载失败', e.message)
  }
}

function vizResize() {
  const cv = viz.cv || (viz.cv = $('viz'))
  if (!cv) return
  viz.dpr = Math.min(2, window.devicePixelRatio || 1)
  viz.w = cv.clientWidth || 360
  viz.h = cv.clientHeight || 560
  viz.ctx = cv.getContext('2d')
  // 画布的像素尺寸只由场景自己管（这里再改一次会让 2d 上下文复位、画面全黑）
  if (vizScene) vizScene.resize(viz.w, viz.h, viz.dpr)
  else if (viz.ctx) {
    cv.width = Math.round(viz.w * viz.dpr)
    cv.height = Math.round(viz.h * viz.dpr)
    viz.ctx.setTransform(viz.dpr, 0, 0, viz.dpr, 0, 0)
  }
  setVizOn(viz.on)
}

function vizModeSet(m) {
  try { vizScene?.setMode?.(m) } catch (e) { console.warn('[viz] mode', e.message) }
}

function setVizOn(on) {
  viz.on = !!on
  $('card')?.classList.toggle('viz-on', viz.on)
  if (!viz.on) viz.ctx?.clearRect(0, 0, viz.w, viz.h)
}

/** 从专辑封面取一个主色（hue），给光晕和环形频谱用 */
function coverHue(src) {
  if (!src) return
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    try {
      const c = document.createElement('canvas')
      c.width = c.height = 12
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0, 12, 12)
      const d = g.getImageData(0, 0, 12, 12).data
      let best = null
      let bestScore = -1
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2]
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b)
        const sat = mx === 0 ? 0 : (mx - mn) / mx
        const score = sat * 0.8 + (mx / 255) * 0.2
        if (score > bestScore) { bestScore = score; best = [r, gg, b] }
      }
      if (!best) return
      const [r, gg, b] = best
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b)
      let h = 0
      const dd = mx - mn || 1
      if (mx === r) h = ((gg - b) / dd) % 6
      else if (mx === gg) h = (b - r) / dd + 2
      else h = (r - gg) / dd + 4
      viz.hue = ((h * 60) + 360) % 360
      vizScene?.setPalette(viz.hue)
    } catch {}
  }
  img.src = src
}

// 调试/选择用：window.__vizMode('nebula' | 'constellation' | 'geo')
window.__vizMode = (m) => { vizScene?.setMode?.(m); return vizScene?.mode }

function drawViz(t, bass, mids) {
  if (!viz.on) return
  if (fx) {
    if (bass > vizLastBass + 0.12) vizBeat = 1
    vizBeat *= 0.92
    vizLastBass = vizLastBass * 0.7 + bass * 0.3
    const card = $('card')?.getBoundingClientRect()
    const metaB = $('meta')?.getBoundingClientRect()
    const progT = $('prog')?.getBoundingClientRect()
    if (!card || !metaB || !progT) return
    const top = metaB.bottom - card.top + 10
    const bottom = progT.top - card.top - 10
    const clip = { x: 0, y: top, w: viz.w, h: Math.max(60, bottom - top) }
    viz.ctx?.clearRect(0, 0, viz.w, viz.h)
    fx.draw(viz.ctx, { t, hue: viz.hue, clip, bass, mid: mids, w: viz.w, h: viz.h })
    return
  }
  if (!vizScene) return
  // 拍点：低频突然抬起就是一下（简版 onset）
  if (bass > vizLastBass + 0.12) vizBeat = 1
  vizBeat *= 0.92
  vizLastBass = vizLastBass * 0.7 + bass * 0.3
  // 只在她「中间那块空白」里画：上边界在配色点下方，下边界在进度条上方
  const card = $('card')?.getBoundingClientRect()
  const metaB = $('meta')?.getBoundingClientRect()
  const progT = $('prog')?.getBoundingClientRect()
  const sz = vizScene.size || { w: 0, h: 0 }
  // 上边界跟着歌名/歌手走（配色点已经挪进 ⋯ 抽屉，不再是可靠的锚点）
  const top = card && metaB ? metaB.bottom - card.top + 10 : 0
  const bottom = card && progT ? progT.top - card.top - 10 : sz.h
  const clip = sz.w > 0 ? { x: 0, y: top, w: sz.w, h: Math.max(60, bottom - top) } : null
  vizScene.frame(t, { bass, mid: mids, high: Math.min(1, mids * 0.8), beat: vizBeat, clip })
}

function paint() {
  const playing = !audio.paused && !audio.ended
  disc.classList.toggle('spinning', playing)
  discWrap.classList.toggle('playing', playing)
  const pb = $('play')
  if (pb) {
    pb.innerHTML = playing
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.6"/><rect x="13.5" y="5" width="4" height="14" rx="1.6"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.6 4.9v14.2c0 .9 1 1.4 1.7 1l11-7.1c.7-.4.7-1.5 0-1.9l-11-7.1c-.7-.5-1.7 0-1.7 1z"/></svg>`
  }
  window.player?.reportState?.({ playing, id: song?.id || 0 })
}

audio.addEventListener('play', paint)
audio.addEventListener('pause', paint)
audio.addEventListener('ended', paint)
audio.addEventListener('error', () => {
  console.warn('[player] 音频错误', audio.error?.code)
  $('artist').textContent = '这首放不了（可能要会员 / 已下架）'
  paint()
})

audio.addEventListener('timeupdate', () => {
  if (!seeking) {
    const dur = durationSec()
    if (dur > 0) {
      setProgress(audio.currentTime / dur)
      $('cur').textContent = fmt(audio.currentTime)
    }
  }
  if (!lines.length) return
  const t = audio.currentTime * 1000 + 120
  let idx = -1
  for (let i = 0; i < lines.length; i++) if (lines[i].t <= t) idx = i
  if (idx !== curLine) {
    curLine = idx
    renderLyric()
  }
})

// 时长：优先 audio.duration；流式拿不到时退回搜索结果的 dur（毫秒）
function durationSec() {
  const d = Number(audio.duration)
  if (Number.isFinite(d) && d > 0) return d
  const s = Number(song?.dur)
  return Number.isFinite(s) && s > 0 ? s / 1000 : 0
}

audio.addEventListener('durationchange', () => {
  const d = durationSec()
  if (d > 0) $('tot').textContent = fmt(d)
  $('seek').disabled = !(d > 0)
})

// 播完自动下一首（队列由主进程管，这边只报告）
audio.addEventListener('ended', () => {
  paint()
  window.player?.ended?.()
})

// ---------- 播放模式：顺序 / 列表循环 / 随机 ----------
const MODES = [
  { id: 'order', title: '顺序播放（到结尾停）', svg: 'M4 9h10M4 15h10M12 6l3 3-3 3M12 12l3 3-3 3' },
  { id: 'loop', title: '列表循环', svg: 'M4 11a4 4 0 0 1 4-4h9M19 13a4 4 0 0 1-4 4H6M15 4l3 3-3 3M9 20l-3-3 3-3' },
  { id: 'shuffle', title: '随机播放', svg: 'M4 7h3l9 10h3M4 17h3l9-10h3M16 4l3 3-3 3M16 14l3 3-3 3' },
]
let playMode = 'loop'
let roamOn = false
let roamPrev = 'loop'
function paintMode() {
  const roam = $('roam')
  if (roam) { roam.classList.toggle('on', roamOn); roam.title = roamOn ? '漫游中：快放完就自动补歌（再点关闭）' : '漫游：按设置里的源自动续播' }
  const m = MODES.find((x) => x.id === playMode) || MODES[1]
  const btn = $('mode')
  if (!btn) return
  btn.className = 'mode-' + m.id
  btn.title = m.title
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"><path d="${m.svg}"/></svg>`
}
async function loadMode() {
  try {
    const r = await window.player?.getMode?.()
    if (r?.mode) playMode = r.mode
  } catch {}
  paintMode()
}
$('mode')?.addEventListener('click', async () => {
  if (roamOn) { roamOn = false; playMode = roamPrev }
  const i = MODES.findIndex((x) => x.id === playMode)
  playMode = MODES[(i + 1) % MODES.length].id
  paintMode()
  try { await window.player?.setMode?.(playMode) } catch {}
})
// 漫游是独立开关：开=接管（记下原模式），关=还原
$('roam')?.addEventListener('click', async () => {
  if (!roamOn) { roamPrev = playMode; roamOn = true; playMode = 'roam' }
  else { roamOn = false; playMode = roamPrev }
  paintMode()
  try { await window.player?.setMode?.(playMode) } catch {}
})
void loadMode()
// 调试口：window.__setMode('roam')
window.__setMode = async (m) => { playMode = m; roamOn = m === 'roam'; paintMode(); try { await window.player?.setMode?.(m) } catch {}; return playMode }

// ---------- 交互 ----------
$('prev').addEventListener('click', () => window.player?.prev?.())
$('next').addEventListener('click', () => window.player?.next?.())

// 进度条：按下先记下「原本在不在放」，拖动期间暂停音频的心跳感会打断声音，
// 所以不暂停、只标记 seeking；松手才真正改 currentTime。
const seekEl = $('seek')
seekEl.addEventListener('pointerdown', () => {
  seeking = true
  seekWasPlaying = !audio.paused && !audio.ended
})
seekEl.addEventListener('input', () => {
  const r = Number(seekEl.value) / 1000
  setProgress(r)
  $('cur').textContent = fmt(r * durationSec())
})
const commitSeek = () => {
  if (!seeking) return
  seeking = false
  const dur = durationSec()
  if (!(dur > 0)) return
  const r = Number(seekEl.value) / 1000
  try {
    audio.currentTime = r * dur
  } catch (e) {
    console.warn('[player] seek 失败', e.message)
  }
  if (seekWasPlaying) audio.play().catch(() => {})
}
seekEl.addEventListener('change', commitSeek)
seekEl.addEventListener('pointerup', commitSeek)
seekEl.addEventListener('pointercancel', () => { seeking = false })

$('play').addEventListener('click', async () => {
  if (audio.paused) {
    try { await ac?.resume() } catch {}
    audio.play().catch(() => {})
  } else {
    audio.pause()
  }
})
$('close').addEventListener('click', () => window.player?.close?.())
$('discWrap')?.addEventListener('dblclick', () => togglePoster())
// 主进程要求「回到这首开头」（上一首按钮在播了 3 秒后先归零）
window.player?.onSeek?.((p) => {
  try {
    audio.currentTime = Number(p?.at) || 0
  } catch {}
  setProgress(0)
  $('cur').textContent = '00:00'
})
window.player?.onQueue?.((p) => {
  if (!p?.pos) return
  queuePos = p.pos
  paintQueue()
})
// 音量：上方竖直浮条。展开只由「喇叭 / 浮条本身 / 拖拽」决定，不再由整个控制条的 hover 触发。
let mutedBefore = 0.8
function paintVolume() {
  const v = Math.round(baseVol * 100)
  $('vol').value = String(v)
  const tip = $('volTip')
  if (tip) tip.textContent = v + '%'
  const mute = $('mute')
  if (mute) {
    mute.classList.toggle('muted', baseVol <= 0.001)
    mute.classList.toggle('low', baseVol > 0.001 && baseVol < 0.5)
  }
}
$('vol').addEventListener('input', (e) => { baseVol = Number(e.target.value) / 100; applyVolume(); paintVolume() })
{
  const wrap = $('volWrap')
  const pop = $('volPop')
  const open = () => wrap?.classList.add('vol-open')
  const shut = () => { if (!wrap?.classList.contains('vol-drag')) wrap?.classList.remove('vol-open') }
  let shutTimer = 0
  const laterShut = () => { clearTimeout(shutTimer); shutTimer = setTimeout(shut, 140) }
  const keep = () => { clearTimeout(shutTimer); open() }
  wrap?.addEventListener('pointerenter', keep)
  wrap?.addEventListener('pointerleave', laterShut)
  pop?.addEventListener('pointerdown', () => wrap?.classList.add('vol-drag'))
  window.addEventListener('pointerup', () => { wrap?.classList.remove('vol-drag'); laterShut() })
  wrap?.addEventListener('focusin', keep)
  wrap?.addEventListener('focusout', () => { laterShut() })
  // 滚轮微调（在喇叭上滚动 ±5%），不劫持页面其他滚动
  wrap?.addEventListener('wheel', (e) => {
    e.preventDefault()
    baseVol = Math.max(0, Math.min(1, baseVol + (e.deltaY < 0 ? 0.05 : -0.05)))
    applyVolume(); paintVolume(); keep(); laterShut()
  }, { passive: false })
  // 点喇叭 = 静音开关（记住上次音量）
  $('mute')?.addEventListener('click', () => {
    if (baseVol > 0.001) { mutedBefore = baseVol; baseVol = 0 } else { baseVol = mutedBefore || 0.8 }
    applyVolume(); paintVolume()
  })
}
audio.volume = 0.8
// 她开口时压低音乐（main 发 0.28，4.2 秒后回 1）
let duck = 1
function applyVolume() { audio.volume = Math.max(0, Math.min(1, baseVol * duck)) }
let baseVol = 0.8
paintVolume()
window.player.onDuck?.((v) => { duck = v > 0 && v < 1 ? v : 1; applyVolume() })
// 键盘：空格播放暂停、←→ ±5 秒、↑↓ 音量（焦点在输入框里时让开）
const isTyping = () => {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
function nudgeVolume(delta) {
  baseVol = Math.max(0, Math.min(1, baseVol + delta / 100))
  applyVolume(); paintVolume()
}
let posterOn = false
function togglePoster(on) {
  posterOn = typeof on === 'boolean' ? on : !posterOn
  document.getElementById('card').classList.toggle('poster', posterOn)
  window.player?.poster?.(posterOn)
  const hint = document.getElementById('hint')
  if (hint) hint.textContent = posterOn ? '海报模式 · 按 F 或 Esc 回来' : '她挑的歌会用这块小唱片放出来 · Esc 收起'
}

window.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    if (posterOn) { togglePoster(false); return }
    window.player?.close?.()
    return
  }
  if (!isTyping() && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); togglePoster(); return }
  if (isTyping()) return
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault()
    if (audio.paused) { try { await ac?.resume() } catch {} audio.play().catch(() => {}) } else audio.pause()
    return
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    const d = e.key === 'ArrowRight' ? 5 : -5
    const dur = Number.isFinite(audio.duration) ? audio.duration : durationSec()
    audio.currentTime = Math.max(0, Math.min(dur || 0, audio.currentTime + d))
    return
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    nudgeVolume(e.key === 'ArrowUp' ? 5 : -5)
  }
})

// 右下角把手：透明窗在 Windows 上没有系统边框，自己实现拉伸
const grip = document.getElementById('grip')
if (grip) {
  let start = null
  let raf = 0
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    start = { sx: e.screenX, sy: e.screenY, w: innerWidth, h: innerHeight }
    try { grip.setPointerCapture(e.pointerId) } catch {}
  })
  grip.addEventListener('pointermove', (e) => {
    if (!start) return
    const w = Math.round(start.w + (e.screenX - start.sx))
    const h = Math.round(start.h + (e.screenY - start.sy))
    if (raf) return
    raf = requestAnimationFrame(() => { raf = 0; window.player?.resize?.({ w, h }) })
  })
  const stop = () => { start = null }
  grip.addEventListener('pointerup', stop)
  grip.addEventListener('pointercancel', stop)
}
window.player?.onLoad?.((payload) => { void load(payload) })
// 还没放过歌 / 上次那首已经结束了：摆一个空台面，别显示上一首的残影
window.player?.onIdle?.(() => {
  try { audio.pause(); audio.removeAttribute('src'); audio.load() } catch {}
  const name = document.getElementById('name')
  const artist = document.getElementById('artist')
  const lyrics = document.getElementById('lyrics')
  if (name) name.textContent = '还没点歌'
  if (artist) artist.textContent = '右键 →「唱片机」随时喊回来'
  // 只清文字层，绝不能 innerHTML='' —— 那会把 #fxCanvas / #pv 一起删掉，
  // 之后 bootPv() 拿不到画布，整条 PV 链路就哑了（这就是"没有 PV"的真因）。
  if (lyrics) {
    lyrics.classList.remove('pvon', 'vizon')
    const t = document.getElementById('lyricsText')
    if (t) t.textContent = ''
    const pvc = document.getElementById('pv')
    if (pvc) pvc.classList.add('hidden')
  }
  disc.classList.remove('spinning')
  discWrap.classList.remove('playing')
  queuePos = { i: 0, n: 1 }
  paintQueue()
  setProgress(0)
  $('cur').textContent = '00:00'
  $('tot').textContent = '00:00'
})
window.player?.config?.().then((c) => { cfg = { stage: c?.stage || '', token: c?.token || '' } })

// ---------- 歌单页（P2：左栏列表；右栏曲目留给 P3） ----------
const plState = { loaded: false, items: [], at: 0, active: 0, busy: false, picked: false }

function switchView(name) {
  const disc = $('view-disc')
  const lists = $('view-lists')
  if (!disc || !lists) return
  const toLists = name === 'lists'
  disc.classList.toggle('hidden', toLists)
  lists.classList.toggle('hidden', !toLists)
  for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('on', b.dataset.view === name)
  if (toLists) void loadPlaylists(false)
}

async function loadPlaylists(force) {
  if (plState.busy) return
  plState.busy = true
  $('plRefresh').disabled = true
  try {
    const r = await window.player?.playlists?.(!!force)
    if (r?.ok) {
      plState.items = Array.isArray(r.items) ? r.items : []
      plState.at = Number(r.at) || 0
      plState.loaded = true
      renderPlaylists()
      if (!plState.picked && plState.items.length) {
        plState.picked = true
        selectPlaylist(plState.items[plState.active] || plState.items[0])
      }
      if (r.cached) {
        // 先给缓存的，再静默刷一次（失败就算了，不打扰）
        setTimeout(() => { void loadPlaylists(true) }, 60)
      }
    } else {
      $('plCol').innerHTML = `<div class="pl-empty">${r?.error === '还没登录' ? '还没登录网易云' : '歌单拉取失败'}</div>`
      $('plWho').textContent = r?.error || ''
    }
  } finally {
    plState.busy = false
    $('plRefresh').disabled = false
  }
}

function renderPlaylists() {
  const col = $('plCol')
  col.textContent = ''
  if (!plState.items.length) {
    col.innerHTML = '<div class="pl-empty">没有歌单</div>'
    return
  }
  plState.items.forEach((p, i) => {
    const d = document.createElement('div')
    d.className = 'pl-item' + (p.special ? ' special' : '') + (i === plState.active ? ' on' : '')
    d.title = p.name
    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = p.name
    const cnt = document.createElement('span')
    cnt.className = 'n'
    cnt.textContent = String(p.trackCount || 0)
    d.append(nm, cnt)
    d.addEventListener('click', () => {
      plState.active = i
      renderPlaylists()
      selectPlaylist(p)
    })
    col.appendChild(d)
  })
  const who = plState.items.find((p) => p.special)?.creator || '我的歌单'
  $('plWho').textContent = `${who} · ${plState.items.length} 个歌单`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

const trackCache = new Map()

/** 把正在播的那行标出来（列表页） */
function markCurrent() {
  const id = song?.id ? String(song.id) : ''
  for (const r of document.querySelectorAll('.tr')) r.classList.toggle('cur', !!id && r.dataset.id === id)
}

async function selectPlaylist(p) {
  const main = $('plMain')
  main.innerHTML = '<div class="pl-empty">读取中…</div>'
  let list = trackCache.get(p.id)
  if (!list) {
    const r = await window.player?.tracks?.(p.id)
    if (!r?.ok) {
      main.innerHTML = `<div class="pl-empty">拉取失败：${escapeHtml(r?.error || '未知错误')}</div>`
      return
    }
    list = Array.isArray(r.items) ? r.items : []
    trackCache.set(p.id, list)
  }
  renderTracks(p, list)
}

function renderTracks(p, list) {
  const main = $('plMain')
  main.textContent = ''
  if (!list.length) {
    main.innerHTML = '<div class="pl-empty">这个歌单是空的</div>'
    return
  }
  const head = document.createElement('div')
  head.className = 'pl-head'
  head.textContent = `${p.name} · ${list.length} 首`
  main.appendChild(head)
  list.forEach((s, i) => {
    const row = document.createElement('div')
    row.className = 'tr'
    row.title = `${s.name} — ${s.artists}`
    const idx = document.createElement('span')
    idx.className = 'tr-i'
    idx.textContent = String(i + 1)
    const nm = document.createElement('span')
    nm.className = 'tr-nm'
    nm.textContent = s.name
    const ar = document.createElement('span')
    ar.className = 'tr-ar'
    ar.textContent = s.artists || ''
    const du = document.createElement('span')
    du.className = 'tr-du'
    du.textContent = fmt(Math.round((s.duration || 0) / 1000))
    const play = document.createElement('button')
    play.className = 'tr-b'
    play.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.6 4.9v14.2c0 .9 1 1.4 1.7 1l11-7.1c.7-.4.7-1.5 0-1.9l-11-7.1c-.7-.5-1.7 0-1.7 1z"/></svg>`
    play.title = '播放这首（整个歌单进队列）'
    play.addEventListener('click', (e) => {
      e.stopPropagation()
      window.player?.playSong?.({ ...s, queue: list, pl: plState.items[plState.active]?.name || '' })
    })
    const add = document.createElement('button')
    add.className = 'tr-b'
    add.textContent = '+'
    add.title = '加到队尾'
    add.addEventListener('click', (e) => {
      e.stopPropagation()
      window.player?.enqueue?.(s)
    })
    row.dataset.id = String(s.id)
    row.append(idx, nm, ar, du, play, add)
    row.addEventListener('dblclick', () => window.player?.playSong?.({ ...s, queue: list, pl: plState.items[plState.active]?.name || '' }))
    main.appendChild(row)
  })
}

$('tabs')?.addEventListener('click', (e) => {
  const b = e.target.closest('.tab')
  if (b) switchView(b.dataset.view)
})
$('plRefresh')?.addEventListener('click', () => void loadPlaylists(true))

bindMore()
initPvStyle()

window.addEventListener('resize', () => resizeFx())
window.addEventListener('resize', () => vizResize())
