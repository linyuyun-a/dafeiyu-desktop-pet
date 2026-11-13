/**
 * 歌词 PV —— 把 JIZURA（MIT，852wa/JIZURA）的引擎接到唱片机上。
 *
 * 设计见 docs/设计-歌词PV.md。这里只做一层薄封装：
 *   createPv({ canvas, log })     建渲染器（引擎缺失时返回 null，调用方回退旧样式）
 *   pv.setLyrics([{t:ms,text}])   重建分镜（每首歌一次）
 *   pv.setStyle('ocean')          换配色（重新 plan，不重载）
 *   pv.draw(seconds)              用 audio.currentTime 驱动
 *   pv.setVisible(bool)           手动关闭
 *
 * 约束（都是踩过的点）：
 * - canvas 像素尺寸必须等于 plan.W * scale，因为引擎用 setTransform(scale…) 画；
 * - 传 transparent:true 才不会被刷成它自己的底色；
 * - 同一首中途换 style 会重新 plan（几百 ms），只在换歌/手动切时做。
 */

const SUPPORTED = ['16:9', '9:16', '4:3', '3:4', '1:1', '4:5', '21:9']

/** 把容器比例映射到引擎支持的画幅（选最接近的）。 */
function pickAspect(w, h) {
  if (!w || !h) return '1:1'
  const r = w / h
  let best = SUPPORTED[0]
  let bestDiff = Infinity
  for (const a of SUPPORTED) {
    const [aw, ah] = a.split(':').map(Number)
    const d = Math.abs(r - aw / ah)
    if (d < bestDiff) {
      bestDiff = d
      best = a
    }
  }
  return best
}

const mmss = (ms) => {
  const t = Math.max(0, ms) / 1000
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

/** [{t,text}] → LRC 文本。引擎认 [mm:ss.xx]，时间戳行才有真实时序。 */
function toLrc(lines) {
  const out = []
  for (const l of lines) {
    const text = String(l?.text ?? '').trim()
    if (!text) continue
    if (typeof l.t === 'number' && isFinite(l.t)) out.push(`[${mmss(l.t)}]${text}`)
    else out.push(text)
  }
  return out.join('\n')
}

export function createPv({ canvas, log = null } = {}) {
  const J = globalThis.J
  if (!canvas || !J || typeof J.plan !== 'function' || typeof J.Renderer !== 'function') {
    log?.('[pv] 引擎不可用')
    return null
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const renderer = new J.Renderer()
  // JIZURA 的方案是按"自己的底色"配的字色：白底方案的字是深色，
  // 直接铺到深色唱片机上会看不见。build() 时算一次底色亮度，浅底就在画布上垫一层纸。
  let paper = null
  function schemeBg(id) {
    const st = (globalThis.J && globalThis.J.STYLES && globalThis.J.STYLES[id]) || null
    const sc = st && st.schemes && st.schemes[0]
    return sc ? { bg: sc.bg, ink: sc.ink || sc.fg } : null
  }
  function readLum(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
    if (!m) return 0.5
    const n = parseInt(m[1], 16)
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const x = v / 255
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  let plan = null
  let styleId = 'ocean'
  let lyricLines = []
  let visible = true
  let scale = 1

  function build() {
    if (!lyricLines.length) {
      plan = null
      return
    }
    const box = canvas.parentElement?.getBoundingClientRect?.() || { width: 320, height: 300 }
    const aspect = pickAspect(box.width, box.height)
    const project = Object.assign(J.defaultProject(), {
      lyrics: toLrc(lyricLines),
      style: styleId,
      aspect,
      res: 720,
      fps: 30,
      seed: 20260922,
      mood: null,
      unify: true,
      typeset: true,
      extra: false,
      extra2: false,
      horror: false,
      wa: false,
      kinetic: true,
      typo: true,
      centerFree: false,
      title: '',
      artist: '',
    })
    const t0 = performance.now()
    plan = J.plan(project, null)
    // canvas 像素尺寸 = 设计尺寸 × scale（引擎用 setTransform(scale) 绘制）
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    const targetW = Math.max(160, Math.round(box.width))
    scale = (targetW / plan.W) * dpr
    canvas.width = Math.round(plan.W * scale)
    canvas.height = Math.round(plan.H * scale)
    // 判据不是"方案底色亮不亮"，而是"字色在我们的深底上还看得见吗"：
    // JIZURA 的字色是按它自己底色配的，深字色铺到深蓝上就等于隐形。
    const sch = schemeBg(styleId)
    const inkLum = sch ? readLum(sch.ink || sch.bg) : 0.5
    const darkInk = inkLum < 0.4
    paper = darkInk ? { bg: sch?.bg || '#F7F2E8' } : null
    log?.(`[pv] plan 完成 ${aspect} ${plan.W}x${plan.H} scale=${scale.toFixed(2)} 用时 ${Math.round(performance.now() - t0)}ms 行数 ${lyricLines.length}${paper ? ' 深字→垫纸' : ''}`)
  }

  return {
    get ready() {
      return !!plan
    },
    get style() {
      return styleId
    },
    /** 纯音乐：用歌曲信息本身当"歌词"，反复滚动播放（用户定的方案）。 */
    setInfo(info = {}) {
      const title = String(info.title || '').trim()
      const artist = String(info.artist || info.artists || '').trim()
      const album = String(info.album || '').trim()
      const dur = Number(info.dur) > 20 ? Number(info.dur) : 180
      const seq = []
      if (title) seq.push(title)
      if (artist) seq.push(artist)
      if (album && album !== title) seq.push(album)
      if (!seq.length) seq.push('纯音乐')
      const step = 6000
      const out = []
      let t = 400
      let i = 0
      while (t < dur * 1000 - 2000) {
        out.push({ t, text: seq[i % seq.length] })
        i++
        t += step
      }
      lyricLines = out
      build()
    },
    setLyrics(lines) {
      lyricLines = Array.isArray(lines) ? lines.filter((l) => l && String(l.text || '').trim()) : []
      build()
    },
    setStyle(id) {
      const next = String(id || 'ocean')
      if (next === styleId && plan) return
      styleId = next
      build()
    },
    draw(t) {
      if (!plan || !visible) return false
      if (!(t >= 0) || !isFinite(t)) return false
      try {
        if (paper) {
          const r = 14 * scale
          const pad = 8 * scale
          ctx.save()
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          ctx.beginPath()
          ctx.roundRect(pad, pad, canvas.width - pad * 2, canvas.height - pad * 2, r)
          ctx.fillStyle = paper.bg
          ctx.globalAlpha = 0.94
          ctx.fill()
          ctx.globalAlpha = 1
          ctx.restore()
        }
        renderer.frame(ctx, plan, t, { transparent: true, scale, fast: false })
        return true
      } catch (e) {
        log?.(`[pv] 绘制异常 ${e.message}`)
        return false
      }
    },
    setVisible(on) {
      visible = !!on
      if (!visible) ctx.clearRect(0, 0, canvas.width, canvas.height)
    },
    get visible() {
      return visible
    },
    clear() {
      plan = null
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    },
  }
}

/* ------------------------------------------------------------------
 * P2：按歌自动配色（见 docs/设计-歌词PV.md「三级决定」）
 * 输入只用可测量的信号：BPM、归一化能量、歌名/歌手/专辑文字、当前心情、钟点。
 * 规则按顺序命中即返回；都不中则默认深海。
 * ------------------------------------------------------------------ */
const HINTS = [
  { re: /古风|国风|中国风|民谣|诗歌|宋词|唐诗/, style: 'sumi' },
  { re: /摇滚|电音|电子|DJ|嘻哈|rap|说唱|金属|崩坏|核类/i, style: 'acid' },
  { re: /钢琴|纯音乐|轻音乐|古典|器乐|原声|OST|配乐/i, style: 'newsprint' },
  { re: /樱花|和风|日系|动漫|二次元|galgame|vocaloid/i, style: 'sakura' },
]

export function pickStyle({ bpm = 0, energy = 0, text = '', mood = '', hour = 12 } = {}) {
  const t = String(text || '')
  const h = Number(hour) >= 0 ? Number(hour) : new Date().getHours()
  const m = String(mood || '')

  // 1) 文字显式线索优先（歌名/歌手/专辑/歌单名里带了风格词）
  for (const rule of HINTS) if (rule.re.test(t)) return rule.style

  // 2) 深夜/困倦：安静的一套
  if (h >= 23 || h < 6 || m === 'sleepy') return 'ocean'

  // 3) 能量 + 速度
  if (bpm >= 118 && energy >= 0.55) return 'acid'
  if (energy >= 0.58 && bpm >= 85) return 'acid'   // 电子/舞曲：能量高但速度未必快
  if (bpm >= 100) return 'sunset'
  if (bpm > 0 && bpm < 80 && energy < 0.4) return 'newsprint'
  if (energy >= 0.75) return 'sunset'

  return 'ocean'
}

/** 取均值，把 analyzeAudio 的 energyN 包络压成一个 0..1 的数。 */
function meanEnergy(arr) {
  if (!arr || !arr.length) return 0
  let sum = 0
  for (let i = 0; i < arr.length; i++) sum += arr[i]
  return sum / arr.length
}

/**
 * 用引擎自带的分析器算 BPM 与平均能量（要拿整首音频，只做一次并缓存）。
 * 失败返回 null —— 调用方回退到默认配色。
 */
export async function analyse(url, log = null) {
  try {
    const J = globalThis.J
    if (!J || typeof J.analyzeAudio !== 'function') return null
    const res = await fetch(url, { cache: 'force-cache' })
    if (!res.ok) return null
    const blob = await res.blob()
    const file = new File([blob], 'song.mp3', { type: blob.type || 'audio/mpeg' })
    const a = await J.analyzeAudio(file)
    const out = { bpm: Math.round(a.bpm * 10) / 10, energy: Math.round(meanEnergy(a.energy) * 1000) / 1000, dur: Math.round(a.duration) }
    log?.(`[pv] 分析 bpm=${out.bpm} energy=${out.energy} dur=${out.dur}s`)
    return out
  } catch (e) {
    log?.(`[pv] 分析失败 ${e.message}`)
    return null
  }
}

