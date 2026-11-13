/**
 * 生成式画面（纯音乐时接管歌词位）。
 * 设计：色块 + 光团 + 结构环，少用细线；全部只画在 clip 区域里，不遮挡唱片与控件。
 */
export function createScene({ canvas, log = () => {} } = {}) {
  const g = canvas.getContext('2d', { alpha: true })
  let W = 0, H = 0, dpr = 1
  let hue = 190
  let title = '', artist = ''
  const beats = []
  const stars = []
  let prevBass = 0
  let lastBeat = -99
  let rot = 0
  let mode = 'nebula'
  const nodes = []
  for (let i = 0; i < 90; i++) {
    nodes.push({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.02, vy: (Math.random() - 0.5) * 0.02, r: 0.8 + Math.random() * 2.2, b: Math.random() })
  }
  const blocks = Array.from({ length: 7 }, (_, i) => ({
    i, x: Math.random(), y: Math.random(), w: 0.12 + Math.random() * 0.2, h: 0.10 + Math.random() * 0.22,
    sp: 0.05 + Math.random() * 0.12, ph: Math.random() * 6.28, kind: i % 3,
  }))

  function resize(w, h, d = window.devicePixelRatio || 1) {
    W = Math.max(1, Math.round(w)); H = Math.max(1, Math.round(h)); dpr = d
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    stars.length = 0
    for (let i = 0; i < 46; i++) {
      stars.push({ x: Math.random(), y: Math.random(), r: 0.5 + Math.random() * 1.8, a: 0.15 + Math.random() * 0.5, p: Math.random() * 6.28 })
    }
    log(`[viz] resize ${W}x${H} dpr=${dpr}`)
  }

  const setPalette = (h) => { hue = ((h % 360) + 360) % 360 }
  const setTitle = (n, b) => { title = n || ''; artist = b || '' }
  const showTitle = () => {}


  function frameConstellation(t, clip, bass, mid) {
    const cx = clip.x + clip.w / 2, cy = clip.y + clip.h * 0.46
    g.globalCompositeOperation = 'lighter'
    for (const n of nodes) {
      n.x += n.vx * (1 + bass * 2); n.y += n.vy * (1 + bass * 2)
      if (n.x < 0.02 || n.x > 0.98) n.vx *= -1
      if (n.y < 0.02 || n.y > 0.98) n.vy *= -1
    }
    // 连线：只连够近的，越近越亮
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        const dx = (a.x - b.x) * clip.w, dy = (a.y - b.y) * clip.h
        const d = Math.hypot(dx, dy)
        const lim = 90 + bass * 40
        if (d > lim) continue
        g.strokeStyle = `hsla(${hue}, 80%, 74%, ${(1 - d / lim) * 0.18})`
        g.lineWidth = 0.8
        g.beginPath()
        g.moveTo(clip.x + a.x * clip.w, clip.y + a.y * clip.h)
        g.lineTo(clip.x + b.x * clip.w, clip.y + b.y * clip.h)
        g.stroke()
      }
    }
    for (const n of nodes) {
      const px = clip.x + n.x * clip.w, py = clip.y + n.y * clip.h
      const tw = 0.6 + 0.4 * Math.sin(t * 1.4 + n.b * 6.28)
      orb(px, py, n.r * (3 + bass * 4), hue, 0.16 * tw)
      g.fillStyle = `hsla(${hue}, 85%, 90%, ${0.55 * tw})`
      g.beginPath(); g.arc(px, py, n.r * 0.9, 0, Math.PI * 2); g.fill()
    }
    g.globalCompositeOperation = 'source-over'
    const vg = g.createRadialGradient(cx, cy, Math.min(clip.w, clip.h) * 0.3, cx, cy, Math.max(clip.w, clip.h) * 0.8)
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(2,10,20,0.5)')
    g.fillStyle = vg; g.fillRect(clip.x, clip.y, clip.w, clip.h)
    featherEdges(clip)
  }

  function frameGeo(t, clip, bass, mid) {
    // 大色块 + 多边形，像一整块在动的版式
    g.fillStyle = `hsla(${hue}, 55%, 22%, 0.55)`
    g.fillRect(clip.x, clip.y, clip.w, clip.h)
    for (const b of blocks) {
      const px = clip.x + ((b.x + Math.sin(t * b.sp + b.ph) * 0.18 + 1) % 1) * clip.w
      const py = clip.y + ((b.y + Math.cos(t * b.sp * 0.7 + b.ph) * 0.16 + 1) % 1) * clip.h
      const w = b.w * clip.w * (1 + bass * 0.25)
      const h = b.h * clip.h * (1 + mid * 0.25)
      g.save()
      g.translate(px, py)
      g.rotate(Math.sin(t * b.sp * 1.6 + b.ph) * 0.25)
      g.globalCompositeOperation = b.kind === 1 ? 'screen' : 'lighter'
      g.fillStyle = `hsla(${hue + b.i * 26}, 78%, ${58 + b.i * 3}%, ${0.16 + bass * 0.14})`
      if (b.kind === 0) g.fillRect(-w / 2, -h / 2, w, h)
      else if (b.kind === 1) { g.beginPath(); g.arc(0, 0, Math.min(w, h) / 2, 0, Math.PI * 2); g.fill() }
      else { g.beginPath(); g.moveTo(0, -h / 2); g.lineTo(w / 2, h / 2); g.lineTo(-w / 2, h / 2); g.closePath(); g.fill() }
      g.restore()
    }
    g.globalCompositeOperation = 'source-over'
    // 半调网点：给一点印刷质感
    const step = 9
    for (let y = clip.y; y < clip.y + clip.h; y += step) {
      for (let x = clip.x; x < clip.x + clip.w; x += step) {
        const v = 0.05 + 0.05 * Math.sin(x * 0.05 + t) * Math.cos(y * 0.06 - t)
        g.fillStyle = `hsla(${hue}, 60%, 80%, ${Math.max(0, v)})`
        g.fillRect(x, y, 1, 1)
      }
    }
    featherEdges(clip)
  }

  function featherEdges(clip) {
    g.globalCompositeOperation = 'destination-out'
    const fadeT = Math.min(70, clip.h * 0.22)
    const gt = g.createLinearGradient(0, clip.y, 0, clip.y + fadeT)
    gt.addColorStop(0, 'rgba(0,0,0,1)'); gt.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gt; g.fillRect(clip.x, clip.y, clip.w, fadeT)
    const gb = g.createLinearGradient(0, clip.y + clip.h - fadeT * 0.7, 0, clip.y + clip.h)
    gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, 'rgba(0,0,0,1)')
    g.fillStyle = gb; g.fillRect(clip.x, clip.y + clip.h - fadeT * 0.7, clip.w, fadeT * 0.7)
    g.globalCompositeOperation = 'source-over'
  }

  function orb(cx, cy, r, h2, a) {
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r)
    grad.addColorStop(0, `hsla(${h2}, 78%, 70%, ${a})`)
    grad.addColorStop(0.45, `hsla(${h2}, 74%, 58%, ${a * 0.5})`)
    grad.addColorStop(1, `hsla(${h2}, 82%, 50%, 0)`)
    g.fillStyle = grad
    g.beginPath()
    g.arc(cx, cy, r, 0, Math.PI * 2)
    g.fill()
  }


  // ---- 「几何构成」：巨大图形母题 + 边缘刻度 + 细网格（参考日式 PV 的硬边几何语言） ----
  function frameGeo2(t, clip, bass, mid) {
    if (!clip) return
    const cx = clip.x + clip.w / 2
    const cy = clip.y + clip.h * 0.52
    const base = Math.min(clip.w, clip.h) * 0.42

    // 细网格（很淡，只给「有刻度」的感觉）
    g.save()
    g.beginPath(); g.rect(clip.x, clip.y, clip.w, clip.h); g.clip()
    g.strokeStyle = `hsla(${hue}, 40%, 70%, 0.06)`
    g.lineWidth = 1
    for (let x = clip.x; x < clip.x + clip.w; x += 46) {
      g.beginPath(); g.moveTo(x, clip.y); g.lineTo(x, clip.y + clip.h); g.stroke()
    }
    for (let y = clip.y; y < clip.y + clip.h; y += 46) {
      g.beginPath(); g.moveTo(clip.x, y); g.lineTo(clip.x + clip.w, y); g.stroke()
    }

    // 每 3 秒换一个「段落」：0 边框 1 菱形 2 双环
    const seg = Math.floor(t / 3) % 3
    const local = (t % 3) / 3
    const easeOut = 1 - Math.pow(1 - Math.min(1, local * 2.6), 3)
    const fadeOut = local > 0.82 ? 1 - (local - 0.82) / 0.18 : 1
    const amp = 0.55 + 0.45 * easeOut
    const rot = (seg === 1 ? Math.PI / 4 : 0) + Math.sin(t * 0.35) * 0.03

    g.translate(cx, cy)
    g.rotate(rot)
    g.globalAlpha = fadeOut

    if (seg === 0) {
      // 外框 + 实心块 + 内嵌白块
      g.strokeStyle = `hsla(${hue}, 55%, 78%, 0.5)`
      g.lineWidth = 1.5
      g.strokeRect(-base * amp, -base * amp, base * 2 * amp, base * 2 * amp)
      g.fillStyle = `hsla(${hue}, 30%, 10%, 0.55)`
      g.fillRect(-base * 0.86 * amp, -base * 0.86 * amp, base * 1.72 * amp, base * 1.72 * amp)
      g.fillStyle = `hsla(${hue}, 80%, 92%, 0.92)`
      g.fillRect(-base * 0.34 * amp, -base * 0.34 * amp, base * 0.68 * amp, base * 0.68 * amp)
    } else if (seg === 1) {
      // 菱形 + 硬投影
      const r = base * 1.05 * amp
      g.fillStyle = `hsla(${hue}, 30%, 8%, 0.5)`
      g.beginPath(); g.moveTo(0, -r + 22); g.lineTo(r + 22, 22); g.lineTo(0, r + 22); g.lineTo(-r + 22, 22); g.closePath(); g.fill()
      g.fillStyle = `hsla(${hue}, 55%, 16%, 0.85)`
      g.beginPath(); g.moveTo(0, -r); g.lineTo(r, 0); g.lineTo(0, r); g.lineTo(-r, 0); g.closePath(); g.fill()
      g.strokeStyle = `hsla(${hue}, 70%, 82%, 0.6)`
      g.lineWidth = 1.5
      g.stroke()
    } else {
      // 双环 + 十字
      g.strokeStyle = `hsla(${hue}, 60%, 78%, 0.45)`
      g.lineWidth = 1.5
      g.beginPath(); g.arc(0, 0, base * amp, 0, Math.PI * 2); g.stroke()
      g.strokeStyle = `hsla(${hue}, 60%, 78%, 0.25)`
      g.beginPath(); g.arc(0, 0, base * 0.72 * amp, 0, Math.PI * 2); g.stroke()
      g.strokeStyle = `hsla(${hue}, 60%, 80%, 0.3)`
      g.beginPath(); g.moveTo(-base, 0); g.lineTo(base, 0); g.moveTo(0, -base); g.lineTo(0, base); g.stroke()
    }
    g.globalAlpha = 1
    g.restore()

    // 边缘刻度：像取景框
    g.save()
    g.beginPath(); g.rect(clip.x, clip.y, clip.w, clip.h); g.clip()
    g.strokeStyle = `hsla(${hue}, 45%, 80%, 0.35)`
    g.lineWidth = 1
    const tick = 7
    for (let x = clip.x + 12; x < clip.x + clip.w - 12; x += 34) {
      g.beginPath(); g.moveTo(x, clip.y + 8); g.lineTo(x, clip.y + 8 + tick); g.stroke()
      g.beginPath(); g.moveTo(x, clip.y + clip.h - 8); g.lineTo(x, clip.y + clip.h - 8 - tick); g.stroke()
    }
    for (let y = clip.y + 12; y < clip.y + clip.h - 12; y += 34) {
      g.beginPath(); g.moveTo(clip.x + 8, y); g.lineTo(clip.x + 8 + tick, y); g.stroke()
      g.beginPath(); g.moveTo(clip.x + clip.w - 8, y); g.lineTo(clip.x + clip.w - 8 - tick, y); g.stroke()
    }
    g.restore()

    // 低频呼吸：整块的亮度浮一下
    if (bass > 0.45) {
      g.fillStyle = `hsla(${hue}, 70%, 60%, ${(bass - 0.45) * 0.06})`
      g.fillRect(clip.x, clip.y, clip.w, clip.h)
    }
  }

  function frame(t, opt = {}) {
    if (!W || !H) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    const clip = opt.clip
    const bass = Math.max(0, Math.min(1, opt.bass || 0))
    const mid = Math.max(0, Math.min(1, opt.mid || 0))
    if (!clip) return

    g.save()
    g.beginPath(); g.rect(clip.x, clip.y, clip.w, clip.h); g.clip()

    const cx = clip.x + clip.w / 2
    const cy = clip.y + clip.h * 0.46
    if (mode === 'constellation') { frameConstellation(t, clip, bass, mid); g.restore(); return }
    if (mode === 'geo') { frameGeo(t, clip, bass, mid); g.restore(); return }
    if (mode === 'geo2') { frameGeo2(t, clip, bass, mid); g.restore(); return }
    rot += 0.0016 + bass * 0.004

    // 节拍
    if (bass - prevBass > 0.14 && t - lastBeat > 0.4) { lastBeat = t; beats.push({ t0: t }) }
    prevBass = bass
    for (let i = beats.length - 1; i >= 0; i--) if (t - beats[i].t0 > 1.6) beats.splice(i, 1)

    // ① 底色：两团大面积柔光，慢慢绕，撑住整块区域的「体量」
    g.globalCompositeOperation = 'lighter'
    const a1 = 0.10 + bass * 0.10
    orb(cx + Math.cos(t * 0.13) * clip.w * 0.22, cy + Math.sin(t * 0.17) * clip.h * 0.18, clip.w * 0.62, hue, a1)
    orb(cx + Math.cos(t * 0.11 + 2.1) * clip.w * 0.26, cy + Math.sin(t * 0.15 + 1.3) * clip.h * 0.22, clip.w * 0.5, hue + 42, a1 * 0.85)

    // ② 主光团：三个，随低频放大缩小，一起呼吸
    const orbs = [
      { k: 0, rad: 0.20, sp: 0.31, hue: 0 },
      { k: 1, rad: 0.14, sp: 0.23, hue: 34 },
      { k: 2, rad: 0.11, sp: 0.41, hue: -28 },
    ]
    for (const o of orbs) {
      const ax = Math.cos(t * o.sp + o.k * 2.1) * clip.w * (0.24 - o.k * 0.03)
      const ay = Math.sin(t * o.sp * 0.8 + o.k * 1.7) * clip.h * 0.22
      const r = Math.min(clip.w, clip.h) * o.rad * (1 + bass * 0.5 + mid * 0.2)
      orb(cx + ax, cy + ay, r, hue + o.hue, 0.17 + bass * 0.16)
    }

    // ③ 结构环：一圈有厚度的弧，随节拍轻微扩张，作为「物体感」
    const ringR = Math.min(clip.w, clip.h) * (0.30 + bass * 0.05)
    g.globalCompositeOperation = 'source-over'
    g.lineWidth = 9
    g.strokeStyle = `hsla(${hue}, 80%, 70%, 0.12)`
    g.beginPath(); g.arc(cx, cy, ringR, rot, rot + 2.1); g.stroke()
    g.strokeStyle = `hsla(${hue + 40}, 85%, 72%, 0.08)`
    g.beginPath(); g.arc(cx, cy, ringR * 0.78, -rot * 1.3, -rot * 1.3 + 1.4); g.stroke()

    // ④ 星点（有光晕）：给画面「颗粒」
    for (const s of stars) {
      const px = s.x * clip.w
      const py = s.y * clip.h + Math.sin(t * 0.5 + s.p) * 3
      const tw = 0.55 + 0.45 * Math.sin(t * 1.6 + s.p * 2)
      g.fillStyle = `hsla(${hue}, 70%, 88%, ${s.a * tw})`
      g.beginPath(); g.arc(px, py, s.r, 0, Math.PI * 2); g.fill()
    }

    // ⑤ 节拍涟漪：粗一点、带发光，从中心推出去
    for (const b of beats) {
      const p = (t - b.t0) / 1.6
      const r = ringR * (0.6 + p * 1.5)
      g.strokeStyle = `hsla(${hue}, 88%, 76%, ${(1 - p) * 0.34})`
      g.lineWidth = 2 + (1 - p) * 6
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke()
    }

    // ⑥ 底部一条渐隐的水位线，让画面有个"地平线"
    const hz = clip.y + clip.h * 0.86
    const lg = g.createLinearGradient(clip.x, 0, clip.x + clip.w, 0)
    lg.addColorStop(0, `hsla(${hue}, 80%, 72%, 0)`)
    lg.addColorStop(0.5, `hsla(${hue}, 80%, 72%, ${0.22 + bass * 0.2})`)
    lg.addColorStop(1, `hsla(${hue}, 80%, 72%, 0)`)
    g.strokeStyle = lg
    g.lineWidth = 1.5
    g.beginPath(); g.moveTo(clip.x, hz); g.lineTo(clip.x + clip.w, hz); g.stroke()

    // ⑦ 上下边缘羽化：让这块区域溶进卡片，而不是一条硬边
    g.globalCompositeOperation = 'destination-out'
    const fadeT = Math.min(70, clip.h * 0.22)
    const gt = g.createLinearGradient(0, clip.y, 0, clip.y + fadeT)
    gt.addColorStop(0, 'rgba(0,0,0,1)'); gt.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gt; g.fillRect(clip.x, clip.y, clip.w, fadeT)
    const gb = g.createLinearGradient(0, clip.y + clip.h - fadeT * 0.7, 0, clip.y + clip.h)
    gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, 'rgba(0,0,0,1)')
    g.fillStyle = gb; g.fillRect(clip.x, clip.y + clip.h - fadeT * 0.7, clip.w, fadeT * 0.7)
    const gl = g.createLinearGradient(clip.x, 0, clip.x + 40, 0)
    gl.addColorStop(0, 'rgba(0,0,0,1)'); gl.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gl; g.fillRect(clip.x, clip.y, 40, clip.h)
    const gr = g.createLinearGradient(clip.x + clip.w - 40, 0, clip.x + clip.w, 0)
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)')
    g.fillStyle = gr; g.fillRect(clip.x + clip.w - 40, clip.y, 40, clip.h)
    g.globalCompositeOperation = 'source-over'

    // ⑧ 暗角
    const vg = g.createRadialGradient(cx, cy, Math.min(clip.w, clip.h) * 0.25, cx, cy, Math.max(clip.w, clip.h) * 0.8)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(2,10,20,0.55)')
    g.fillStyle = vg
    g.fillRect(clip.x, clip.y, clip.w, clip.h)

    g.restore()
  }

  return {
    get size() { return { w: W, h: H, dpr } },
    get hue() { return hue },
    get title() { return title },
    get artist() { return artist },
    resize, setPalette, setTitle, showTitle, frame,
    setMode(m) { if (['nebula', 'constellation', 'geo', 'geo2'].includes(m)) { mode = m; log('[viz] mode ' + m) } },
    get mode() { return mode },
    clear() { g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H) },
  }
}
