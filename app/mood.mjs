/**
 * 心情系统（七轴）
 *
 * 设计前提：她是「已经和你很熟的人」，所以**没有亲密度、没有等级、没有解锁门槛**。
 * 变的只有「今天这会儿的心情」——同一句摸头，心情不同说的话不同。
 *
 * 七轴都是 0–1 的标量，各自有基线与半衰期：
 *   - 基线随钟点走（深夜困、午后精神）
 *   - 事件只改「当前值」，之后按半衰期往基线回落
 *
 * 这一层是纯计算：不碰 DOM、不碰渲染，可以拿假时钟直接测。
 */

export const MOOD_KEYS = ['joy', 'irk', 'sleepy', 'missing', 'clingy', 'bored', 'shy']

/** 各轴的基础值（回落的终点，也会随钟点微调） */
export const MOOD_BASE = {
  joy: 0.55,
  irk: 0.05,
  sleepy: 0.2,
  missing: 0.05,
  clingy: 0.3,
  bored: 0.15,
  shy: 0,
}

/** 半衰期（分钟）：多久回到「离基线一半」的位置 */
export const HALF_LIFE_MIN = {
  joy: 18,
  irk: 9,
  sleepy: 40,
  missing: 25,
  clingy: 30,
  bored: 12,
  shy: 3,
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))

/** 按钟点算某一轴的基线（目前只有困、愉悦、黏人有明显的作息差异） */
export function baseAt(key, hour = 0) {
  const h = ((hour % 24) + 24) % 24
  if (key === 'sleepy') {
    if (h < 6) return 0.85
    if (h < 9) return 0.35
    if (h < 17) return 0.12
    if (h < 22) return 0.3
    return 0.6
  }
  if (key === 'joy') return h >= 9 && h < 17 ? 0.6 : 0.52
  if (key === 'clingy') return h < 6 ? 0.2 : h >= 22 ? 0.45 : 0.3
  return MOOD_BASE[key]
}

/** 区域 → 心情增量（一次互动）。数值是「一次」的量，连击由 touch 层折算。 */
export const ZONE_MOOD = {
  头发: { joy: 0.08, shy: 0.05 },
  头: { joy: 0.1, shy: 0.05 },
  额头: { joy: 0.06 },
  左脸: { joy: 0.05, shy: 0.12 },
  右脸: { joy: 0.05, shy: 0.12 },
  左手: { joy: 0.1, shy: 0.1 },
  右手: { joy: 0.1, shy: 0.1 },
  胸: { joy: 0.04, shy: 0.5, irk: 0.05 },
  腰: { joy: 0.15, shy: 0.1 },
  裙摆: { shy: 0.4, irk: 0.15 },
  腿: { joy: 0.08, shy: 0.1 },
  脚: { joy: 0.15, shy: 0.08 },
  尾巴: { joy: 0.06, shy: 0.15 },
  胯: { joy: -0.2, shy: 0.6, irk: 0.25 },
}

/** 手势 → 额外倍率（抚摸比点击更"被在意"，连点会招人烦） */
const GESTURE_SCALE = { tap: 1, stroke: 1.3, hold: 1.2, rapid: 0.6, pinch: 1.1 }

export function createMood({ now = () => Date.now(), hour = () => new Date().getHours(), seed = null } = {}) {
  const value = { ...MOOD_BASE }
  let at = now()
  let lastHour = hour()

  /** 把当前值按流逝时间往基线回落 */
  function settle(t = now()) {
    const dtMin = Math.max(0, (t - at) / 60000)
    if (dtMin <= 0) return
    const h = hour()
    for (const key of MOOD_KEYS) {
      const half = HALF_LIFE_MIN[key] || 20
      const keep = Math.pow(0.5, dtMin / half)
      const base = baseAt(key, h)
      value[key] = clamp01(base + (value[key] - base) * keep)
    }
    at = t
    lastHour = h
  }

  function bump(key, delta) {
    value[key] = clamp01((value[key] ?? 0) + delta)
  }

  /**
   * 记一件事。
   *   { kind: 'touch', zone, gesture }
   *   { kind: 'chat' }           一句有内容的对话
   *   { kind: 'idle', idleMin }  系统空闲分钟数
   *   { kind: 'back' }           你回来了
   *   { kind: 'praise' }         被夸
   *   { kind: 'interrupted' }    她说话时被点
   */
  function apply(ev, t = now()) {
    settle(t)
    if (!ev || !ev.kind) return snapshot(t)
    if (ev.kind === 'touch') {
      const table = ZONE_MOOD[ev.zone] || {}
      const scale = GESTURE_SCALE[ev.gesture] ?? 1
      for (const [key, delta] of Object.entries(table)) bump(key, delta * scale)
      // 摸她 = 有人陪着；被冒犯的区同时抬 irk（由 ZONE_MOOD 自己带）
      bump('clingy', 0.04)
      bump('bored', -0.3)
      if (ev.zone === '胯' || ev.zone === '裙摆') bump('missing', -0.1)
    } else if (ev.kind === 'chat') {
      bump('joy', 0.12)
      bump('clingy', 0.08)
      bump('bored', -0.45)
      bump('missing', -0.2)
    } else if (ev.kind === 'idle') {
      const m = Number(ev.idleMin) || 0
      if (m >= 3) bump('missing', m >= 45 ? 0.9 : m >= 15 ? 0.65 : 0.35)
      if (m >= 3) bump('clingy', -0.08)
      else bump('clingy', 0.02)
      if (m < 1) bump('bored', 0.02)
    } else if (ev.kind === 'back') {
      bump('missing', 0.15)
      bump('joy', 0.1)
    } else if (ev.kind === 'praise') {
      bump('joy', 0.18)
      bump('shy', 0.25)
    } else if (ev.kind === 'interrupted') {
      bump('irk', 0.2)
    }
    return snapshot(t)
  }

  /** 慢速心跳：只做时间衰减（长时间没人操作时用来推进 sleep/bored） */
  function tick(t = now(), idleMin = 0) {
    settle(t)
    const dtMin = Math.min(5, Math.max(0, idleMin || 0))
    if (dtMin > 0) {
      bump('bored', 0.08 * dtMin)
      bump('sleepy', 0.01 * dtMin)
    }
    return snapshot(t)
  }

  function snapshot(t = now()) {
    // 取快照也顺手结算一次：不然「停在那儿不动」的时间就没被算进衰减
    settle(t)
    return { ...value, at: t, lastHour }
  }

  function restore(saved, t = now()) {
    if (!saved || typeof saved !== 'object') return snapshot(t)
    for (const key of MOOD_KEYS) {
      const v = Number(saved[key])
      if (Number.isFinite(v)) value[key] = clamp01(v)
    }
    const sAt = Number(saved.at)
    at = Number.isFinite(sAt) ? sAt : t
    settle(t)
    return snapshot(t)
  }

  return { apply, tick, settle, snapshot, restore, get values() { return { ...value } } }
}

/** 组合 → 行为意图。这是「她像活的」的地方：单轴只影响台词，组合才影响动作。 */
export function intentOf(m) {
  const out = []
  if (m.clingy >= 0.6 && m.bored >= 0.5) out.push('seek')       // 凑过来蹭
  if (m.missing >= 0.5) out.push('welcome')                     // 你回来了，先埋怨再靠
  if (m.irk >= 0.5 && m.clingy >= 0.5) out.push('sulk')         // 生闷气：不理但不走
  if (m.sleepy >= 0.65) out.push('doze')                        // 困：动作变慢、眼半闭
  if (m.shy >= 0.5) out.push('shy')
  if (m.bored >= 0.6 && m.joy < 0.45) out.push('fidget')        // 自己找事做
  if (m.joy >= 0.7 && m.shy >= 0.3) out.push('soft')            // 嘴上嫌弃身体不躲
  return out
}

/** 一句话描述她现在的心情（给服务器旁白用，不超过 60 字；无感返回空串） */
export function describeMood(m) {
  if (!m) return ''
  const bits = []
  if (m.joy >= 0.65) bits.push('心情不错')
  else if (m.joy <= 0.3) bits.push('兴致不高')
  if (m.irk >= 0.5) bits.push('有点恼')
  if (m.sleepy >= 0.65) bits.push('很困')
  if (m.missing >= 0.5) bits.push('有点惦记主人')
  if (m.clingy >= 0.6) bits.push('想黏着人')
  if (m.bored >= 0.6) bits.push('有点腻了')
  if (m.shy >= 0.5) bits.push('有点发窘')
  return bits.join('，')
}

/** 台词变体的选择键：取最突出的两轴 */
export function toneOf(m) {
  // 负向情绪更容易主导语气（生气/困/惦记），所以给权重；否则「黏人 0.7」总会盖掉「恼 0.6」
  const SALIENCE = { irk: 1.3, sleepy: 1.15, missing: 1.2, shy: 1.1, joy: 1, clingy: 0.9, bored: 0.9 }
  const ranked = MOOD_KEYS
    .map((k) => ({ k, v: (Number(m[k]) || 0) * (SALIENCE[k] ?? 1) }))
    .sort((a, b) => b.v - a.v)
  const top = ranked[0]
  if (top.v < 0.45) return 'plain'
  if (top.k === 'irk') return 'irk'
  if (top.k === 'sleepy') return 'sleepy'
  if (top.k === 'missing') return 'missing'
  if (top.k === 'shy') return 'shy'
  if (top.k === 'clingy') return 'clingy'
  if (top.k === 'bored') return 'bored'
  return 'joy'
}

/** 动作幅度/时长的修正（渲染层直接用） */
export function motionScale(m) {
  let amp = 1
  let speed = 1
  if (m.joy >= 0.65) amp *= 1.15
  if (m.irk >= 0.5) amp *= 0.7
  if (m.sleepy >= 0.65) { amp *= 0.8; speed *= 0.75 }
  if (m.shy >= 0.5) amp *= 0.9
  return { amp, speed }
}

/** 今天摸过哪些地方（面板显示用） */
export function createDayLog() {
  let date = ''
  let zones = {}
  let total = 0
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  function roll(d = new Date()) {
    const k = dayKey(d)
    if (k !== date) { date = k; zones = {}; total = 0 }
  }
  function add(zone, n = 1, d = new Date()) {
    roll(d)
    if (!zone) return summary()
    zones[zone] = (zones[zone] || 0) + n
    total += n
    return summary()
  }
  function summary() {
    const top = Object.entries(zones).sort((a, b) => b[1] - a[1]).slice(0, 3)
    return { date, zones: { ...zones }, total, top }
  }
  function restore(saved) {
    if (!saved || typeof saved !== 'object') return summary()
    date = String(saved.date || '')
    zones = { ...(saved.zones || {}) }
    total = Number(saved.total) || 0
    return summary()
  }
  return { add, roll, summary, restore }
}
