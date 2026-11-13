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

export function createFx({ log } = {}) {
  const all = [makeInkDoodle(log), makePaperGrain(log), makeGeoBrut()]
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
