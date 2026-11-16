/**
 * 画面效果层（FX）：把「能用现成代码就用现成代码」落成插件表。
 *
 * 设计约束（与 docs/设计-播放器UI.md 一致）：
 *  - 只画在 clip 区域（歌名下方 → 进度条上方），不遮唱片/标题/控件
 *  - 一屏最多同时 1–2 个效果
 *  - 每个效果自己管入场/退场，时长 ≤ 300ms 量级
 *
 * 坐标约定：效果内部的绘制坐标一律是 1920×1080（上游 fifi-video 的原生画布），
 * 由本模块负责缩放进 clip。
 *
 * 来源标注：
 *  - ink-doodle / paper-grain 使用 huiq777/fifi-video 的 XM 运行时（MIT），
 *    代码在 ./vendor/fifi/，未做修改，仅由本文件调用。
 */
// 上游运行时（lib/timeline/xk/xm-*）是 classic script，必须在 player.html 里用 <script> 先加载，
// 这里只读取它挂在全局词法作用域上的 XM / XK。
function getXM() {
  try { return typeof XM === 'undefined' ? null : XM } catch { return null }
}

const W = 1920
const H = 1080

/** 家族：决定「这个效果适合什么样的歌」，不决定长什么样 */
export const FAMILIES = {
  ink: { id: 'ink', name: '水墨 / 手绘' },
  blueprint: { id: 'blueprint', name: '图纸 / 几何' },
  paper: { id: 'paper', name: '纸感 / 印刷' },
  neon: { id: 'neon', name: '赛博 / 故障' },
}

function tone(hue) {
  const XM = getXM()
  const P = XM?.DS?.tone ? XM.DS.tone('ink') : { bg: '#0b1520', text: '#e8f3ff', accent: '#4dd0e1', mute: '#5b7a8c' }
  return { ...P, accent: `hsl(${hue} 85% 62%)` }
}

/** 把 1920×1080 的坐标系铺进 clip（cover，居中裁切） */
function withSpace(ctx, clip, fn) {
  const k = Math.max(clip.w / W, clip.h / H)
  ctx.save()
  ctx.beginPath()
  ctx.rect(clip.x, clip.y, clip.w, clip.h)
  ctx.clip()
  ctx.translate(clip.x + (clip.w - W * k) / 2, clip.y + (clip.h - H * k) / 2)
  ctx.scale(k, k)
  try { fn() } finally { ctx.restore() }
}

// ---------------------------------------------------------------- 手绘墨线
function makeInkDoodle(log) {
  let layer = null
  let builtFor = ''
  function build(clip, hue) {
    const XM = getXM()
    if (!XM?.doodle?.layer) return null
    const key = `${Math.round(clip.w)}x${Math.round(clip.h)}`
    if (layer && builtFor === key) return layer
    // 只放三笔：左侧光芒、右下火花、底部下划线——都在「围绕主体」，不压文字
    const items = [
      { kind: 'rays', at: 0.2, x: W * 0.14, y: H * 0.44, s: 150, n: 8, r0: 56, r1: 210, dir: -90, spread: 165 },
      { kind: 'spark', at: 1.4, x: W * 0.86, y: H * 0.4, s: 44, n: 5, len: 96, rot: -12 },
      { kind: 'underline', at: 2.6, x: W * 0.30, y: H * 0.70, s: 1, w: W * 0.40, lw: 11, double: true },
    ]
    layer = XM.doodle.layer({ items, col: `hsl(${hue} 80% 62%)`, boil: false, grain: 0.06 })
    builtFor = key
    log?.('[fx] ink-doodle 重建', key)
    return layer
  }
  return {
    id: 'ink-doodle',
    name: '手绘墨线',
    family: 'ink',
    when: { mood: ['sleepy', 'missing'], bpm: [0, 105] },
    draw(ctx, s) {
      const L = build(s.clip, s.hue)
      if (!L) return
      withSpace(ctx, s.clip, () => L.draw(ctx, s.t, tone(s.hue)))
    },
  }
}

// ---------------------------------------------------------------- 纸张 / 网格质感
function makePaperGrain(log) {
  return {
    id: 'paper-grain',
    name: '纸纹与网格',
    family: 'paper',
    when: { bpm: [75, 118] },
    draw(ctx, s) {
      const XM = getXM()
      if (!XM?.tex) return
      const P = tone(s.hue)
      withSpace(ctx, s.clip, () => {
        try { XM.tex.wash(ctx, s.t, { ...P, bg: '#0d1a26' }, { a: 0.5 }) } catch {}
        try { XM.tex.grid(ctx, s.t, P, { a: 0.16 }) } catch {}
      })
    },
  }
}

// ---------------------------------------------------------------- 几何构成（沿用已有的 geo2，家族 blueprint）
function makeGeoBrut() {
  return {
    id: 'geo-brut',
    name: '几何构成',
    family: 'blueprint',
    when: { bpm: [100, 200], energy: [0.42, 1] },
    draw(ctx, s) {
      const clip = s.clip
      const cx = clip.x + clip.w / 2
      const cy = clip.y + clip.h * 0.52
      const base = Math.min(clip.w, clip.h) * 0.42
      const hue = s.hue
      ctx.save()
      ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip()
      // 细网格
      ctx.strokeStyle = `hsla(${hue}, 40%, 70%, 0.06)`
      ctx.lineWidth = 1
      for (let x = clip.x; x < clip.x + clip.w; x += 46) { ctx.beginPath(); ctx.moveTo(x, clip.y); ctx.lineTo(x, clip.y + clip.h); ctx.stroke() }
      for (let y = clip.y; y < clip.y + clip.h; y += 46) { ctx.beginPath(); ctx.moveTo(clip.x, y); ctx.lineTo(clip.x + clip.w, y); ctx.stroke() }
      // 每 3 秒换段落
      const t = s.t
      const seg = Math.floor(t / 3) % 3
      const local = (t % 3) / 3
      const easeOut = 1 - Math.pow(1 - Math.min(1, local * 2.6), 3)
      const fadeOut = local > 0.82 ? 1 - (local - 0.82) / 0.18 : 1
      const amp = 0.55 + 0.45 * easeOut
      ctx.translate(cx, cy)
      ctx.rotate((seg === 1 ? Math.PI / 4 : 0) + Math.sin(t * 0.35) * 0.03)
      ctx.globalAlpha = fadeOut
      if (seg === 0) {
        ctx.strokeStyle = `hsla(${hue}, 55%, 78%, 0.5)`; ctx.lineWidth = 1.5
        ctx.strokeRect(-base * amp, -base * amp, base * 2 * amp, base * 2 * amp)
        ctx.fillStyle = `hsla(${hue}, 30%, 10%, 0.5)`
        ctx.fillRect(-base * 0.86 * amp, -base * 0.86 * amp, base * 1.72 * amp, base * 1.72 * amp)
        ctx.fillStyle = `hsla(${hue}, 80%, 92%, 0.9)`
        ctx.fillRect(-base * 0.34 * amp, -base * 0.34 * amp, base * 0.68 * amp, base * 0.68 * amp)
      } else if (seg === 1) {
        const r = base * 1.05 * amp
        ctx.fillStyle = `hsla(${hue}, 30%, 8%, 0.5)`
        ctx.beginPath(); ctx.moveTo(22, -r + 22); ctx.lineTo(r + 22, 22); ctx.lineTo(22, r + 22); ctx.lineTo(-r + 22, 22); ctx.closePath(); ctx.fill()
        ctx.fillStyle = `hsla(${hue}, 55%, 16%, 0.8)`
        ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath(); ctx.fill()
        ctx.strokeStyle = `hsla(${hue}, 70%, 82%, 0.6)`; ctx.lineWidth = 1.5; ctx.stroke()
      } else {
        ctx.strokeStyle = `hsla(${hue}, 60%, 78%, 0.45)`; ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(0, 0, base * amp, 0, Math.PI * 2); ctx.stroke()
        ctx.strokeStyle = `hsla(${hue}, 60%, 78%, 0.25)`
        ctx.beginPath(); ctx.arc(0, 0, base * 0.72 * amp, 0, Math.PI * 2); ctx.stroke()
        ctx.strokeStyle = `hsla(${hue}, 60%, 80%, 0.3)`
        ctx.beginPath(); ctx.moveTo(-base, 0); ctx.lineTo(base, 0); ctx.moveTo(0, -base); ctx.lineTo(0, base); ctx.stroke()
      }
      ctx.globalAlpha = 1
      // 边缘刻度
      ctx.strokeStyle = `hsla(${hue}, 45%, 80%, 0.32)`
      const tick = 7
      for (let x = clip.x + 12; x < clip.x + clip.w - 12; x += 34) {
        ctx.beginPath(); ctx.moveTo(x, clip.y + 8); ctx.lineTo(x, clip.y + 8 + tick); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(x, clip.y + clip.h - 8); ctx.lineTo(x, clip.y + clip.h - 8 - tick); ctx.stroke()
      }
      for (let y = clip.y + 12; y < clip.y + clip.h - 12; y += 34) {
        ctx.beginPath(); ctx.moveTo(clip.x + 8, y); ctx.lineTo(clip.x + 8 + tick, y); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(clip.x + clip.w - 8, y); ctx.lineTo(clip.x + clip.w - 8 - tick, y); ctx.stroke()
      }
      ctx.restore()
    },
  }
}


// ---------------------------------------------------------------- 批 1：XM 原生滤镜（都是 1920×1080 舞台坐标）
// 这批都刻意「轻」：低透明度、只画背景层，不压字。全部依赖 getXM()，拿不到就静默跳过。

function makeHalftone() {
  return {
    id: 'halftone', name: '网点圆盘', family: 'blueprint',
    when: { bpm: [80, 200], energy: [0.3, 1] },
    draw(ctx, s) {
      const XM = getXM()
      if (!XM?.FX?.halftone) return
      const bass = s.bass || 0
      withSpace(ctx, s.clip, () => {
        ctx.save()
        ctx.globalAlpha = 0.09 + bass * 0.10
        XM.FX.halftone(ctx, W / 2, H * 0.54, Math.min(W, H) * (0.34 + bass * 0.05), `hsl(${s.hue} 80% 72%)`, 28, 9)
        ctx.restore()
      })
    },
  }
}

function makeCorners() {
  return {
    id: 'corners', name: '取景框', family: 'blueprint',
    when: { bpm: [70, 200] },
    draw(ctx, s) {
      const XM = getXM()
      if (!XM?.FX?.bracket) return
      const k = Math.min(1, Math.max(0, s.t / 0.6))
      withSpace(ctx, s.clip, () => {
        ctx.save()
        ctx.globalAlpha = 0.28 * k
        XM.FX.bracket(ctx, 90, 80, W - 180, H - 160, 110, `hsl(${s.hue} 70% 80%)`, 3)
        ctx.globalAlpha = 0.18 * k
        for (let i = 0; i < 9; i++) {
          const x = 90 + (W - 180) * (i / 8)
          ctx.fillStyle = `hsl(${s.hue} 70% 82%)`
          ctx.fillRect(x - 1, 80, 2, 14)
          ctx.fillRect(x - 1, H - 80 - 14, 2, 14)
        }
        ctx.restore()
      })
    },
  }
}

function makeStars() {
  const PTS = [[0.18, 0.3], [0.32, 0.66], [0.55, 0.22], [0.72, 0.58], [0.86, 0.36]]
  return {
    id: 'stars', name: '星屑', family: 'ink',
    when: { bpm: [0, 118], mood: ['sleepy', 'missing', 'joy'] },
    draw(ctx, s) {
      const XM = getXM()
      if (!XM?.FX?.star4) return
      withSpace(ctx, s.clip, () => {
        ctx.save()
        PTS.forEach(([px, py], i) => {
          const tw = 0.5 + 0.5 * Math.sin(s.t * 0.9 + i * 1.7)
          ctx.globalAlpha = 0.10 + tw * 0.14
          XM.FX.star4(ctx, W * px, H * py, 16 + tw * 10, `hsl(${s.hue} 75% 86%)`, 0.2, s.t * 0.1 + i)
        })
        ctx.restore()
      })
    },
  }
}

function makeScanlines() {
  return {
    id: 'scanlines', name: '扫描线', family: 'neon',
    when: { bpm: [110, 220], energy: [0.55, 1] },
    draw(ctx, s) {
      const clip = s.clip
      const gap = 7
      ctx.save()
      ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip()
      ctx.globalAlpha = 0.05
      ctx.fillStyle = `hsl(${s.hue} 70% 88%)`
      const off = (s.t * 26) % gap
      for (let y = clip.y - gap + off; y < clip.y + clip.h; y += gap) ctx.fillRect(clip.x, y, clip.w, 1)
      // 一道缓慢下移的亮带
      const bandY = clip.y + ((s.t * 60) % (clip.h + 160)) - 80
      const g = ctx.createLinearGradient(0, bandY - 40, 0, bandY + 40)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(0.5, `hsla(${s.hue} 90% 70% / 0.10)`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = 1
      ctx.fillStyle = g
      ctx.fillRect(clip.x, bandY - 40, clip.w, 80)
      ctx.restore()
    },
  }
}

function makeThirds() {
  return {
    id: 'thirds', name: '三分线', family: 'paper',
    when: { bpm: [60, 130], energy: [0, 0.55] },
    draw(ctx, s) {
      const clip = s.clip
      const k = Math.min(1, Math.max(0, s.t / 0.8))
      ctx.save()
      ctx.globalAlpha = 0.12 * k
      ctx.strokeStyle = `hsl(${s.hue} 55% 82%)`
      ctx.lineWidth = 1
      const xs = [clip.x + clip.w / 3, clip.x + (clip.w * 2) / 3]
      const ys = [clip.y + clip.h / 3, clip.y + (clip.h * 2) / 3]
      xs.forEach((x) => { ctx.beginPath(); ctx.moveTo(x, clip.y); ctx.lineTo(x, clip.y + clip.h); ctx.stroke() })
      ys.forEach((y) => { ctx.beginPath(); ctx.moveTo(clip.x, y); ctx.lineTo(clip.x + clip.w, y); ctx.stroke() })
      ctx.globalAlpha = 0.24 * k
      ctx.fillStyle = `hsl(${s.hue} 60% 86%)`
      xs.forEach((x) => ys.forEach((y) => ctx.fillRect(x - 3, y - 3, 6, 6)))
      ctx.restore()
    },
  }
}

function makeBarcode() {
  return {
    id: 'barcode', name: '条码边', family: 'neon',
    when: { bpm: [90, 200], energy: [0.4, 1] },
    draw(ctx, s) {
      const XM = getXM()
      if (!XM?.FX?.barcode) return
      withSpace(ctx, s.clip, () => {
        ctx.save()
        ctx.globalAlpha = 0.20
        XM.FX.barcode(ctx, W * 0.06, H - 96, W * 0.26, 34, `hsl(${s.hue} 60% 84%)`, Math.floor(s.t / 38) + 1)
        ctx.restore()
      })
    },
  }
}

const EXTRA = []
export function createFx({ log } = {}) {
  // 数组拼接必须用展开：`[...] + EXTRA` 会把数组相加成字符串，
  // 于是后面的 all.map 直接 TypeError —— 曾因为它在 setSong 里抛出、
  // 把 player 的 loadSong 后半段（喂歌词给 PV）整段打断，表现为"播放器没有 PV 动画"。
  const all = [
    // 自动池：只放「气氛型」（点、线、尘），不带任何边框/构图线——它们会和 PV 的文字打架
    makeStars(), makeHalftone(), makeScanlines(),
    // 以下保留给手动指定（[[fx:名字]]）用，不参与自动挑选
    // makeInkDoodle(log), makePaperGrain(log), makeGeoBrut(), makeCorners(), makeThirds(), makeBarcode(),
    ...EXTRA,
  ]
  let current = all[0]
  let currentFor = ''

  function score(fx, song) {
    if (!fx.when) return 1
    let s = 1
    const { bpm = 100, energy = 0.5, mood = '', hour = 12 } = song || {}
    if (fx.when.bpm && (bpm < fx.when.bpm[0] || bpm > fx.when.bpm[1])) s -= 0.5
    if (fx.when.energy && (energy < fx.when.energy[0] || energy > fx.when.energy[1])) s -= 0.4
    if (fx.when.mood && fx.when.mood.length && !fx.when.mood.includes(mood)) s -= 0.3
    return s
  }

  return {
    list: all,
    /** 换歌时选一个；同一首歌保持稳定 */
    setSong(song) {
      const key = song ? `${song.id || song.name}|${Math.round(song.bpm || 0)}|${Math.round((song.energy || 0) * 20)}` : ''
      if (key && key === currentFor) return current
      const ranked = all.map((fx) => ({ fx, s: score(fx, song) })).sort((a, b) => b.s - a.s)
      current = ranked[0].fx
      currentFor = key
      log?.('[fx] 选中', current.id, current.family, JSON.stringify(ranked.map((r) => [r.fx.id, r.s])))
      return current
    },
    /** 手动指定（给 [[fx:名字]] / 界面用） */
    set(id) {
      const fx = all.find((f) => f.id === id || f.family === id)
      if (fx) { current = fx; currentFor = 'manual:' + fx.id; log?.('[fx] 手动', id) }
      return fx
    },
    get current() { return current },
    draw(ctx, s) { try { current.draw(ctx, s) } catch (e) { log?.('[fx] draw 失败 ' + current.id + ': ' + e.message) } },
  }
}
