/**
 * 主动开口的「什么时候」层（纯逻辑，不碰网络、不碰 DOM，方便单测）。
 *
 * 分工：这一层只决定**现在该不该说**；说什么由 AstrBot 现场生成
 * （见 app/main.mjs 的 brain:proactive —— 往对话里放一段旁白去戳她）。
 *
 * 三条纪律：
 *   1. 不打扰：她正在说话 / 用户正在打字 / 鼠标在她身上 / 深夜，一律不说话。
 *   2. 不追命：说完至少隔 20 分钟（「少」档），一天不超过 6 句。
 *   3. 不像报时：到点后再掷一次骰子（65%），命中才说，避免每个整点都开口。
 */

/** 频率档：first = 启动后多久尝试第一次；gap = 两次之间的间隔；dayCap = 每天上限 */
export const FREQUENCY = {
  few: { first: [3, 8], gap: [20, 40], dayCap: 6, dice: 0.65 },
  normal: { first: [2, 5], gap: [8, 15], dayCap: 12, dice: 0.6 },
  many: { first: [1, 3], gap: [4, 8], dayCap: 20, dice: 0.55 },
}

const MIN = 60_000

const rand = (r, random) => r[0] + random() * (r[1] - r[0])

/** "HH:MM" → 一天中的分钟数 */
function toMin(s) {
  const [h, m] = String(s || '0:0').split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** 现在是不是勿扰时段（支持跨午夜，如 23:30–07:30） */
export function inQuietHours(now, quiet = { from: '23:30', to: '07:30' }) {
  if (!quiet || !quiet.from || !quiet.to) return false
  const from = toMin(quiet.from)
  const to = toMin(quiet.to)
  if (from === to) return false
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  return from < to ? cur >= from && cur < to : cur >= from || cur < to
}

/**
 * 门控：返回 { ok, reason }。任何一条不过就闭嘴，reason 用于日志/单测断言。
 * state = { now, idleMs, busy, chatting, lastSpokeAt, lastChatAt, todayCount, proactive }
 */
export function shouldSpeak(state, freq = FREQUENCY.few) {
  const { now = Date.now() } = state
  if (!state.proactive || state.proactive === 'off') return { ok: false, reason: 'off' }
  if (state.chatting) return { ok: false, reason: 'chatting' }
  if (state.busy) return { ok: false, reason: 'busy' }
  if (inQuietHours(now, state.quiet)) return { ok: false, reason: 'quiet-hours' }
  if ((state.todayCount || 0) >= freq.dayCap) return { ok: false, reason: 'day-cap' }
  const lastChatAt = state.lastChatAt || 0
  if (now - lastChatAt < 90_000) return { ok: false, reason: 'just-talked' }
  const lastSpokeAt = state.lastSpokeAt || 0
  if (lastSpokeAt && now - lastSpokeAt < freq.gap[0] * MIN) return { ok: false, reason: 'too-soon' }
  // 用户可能正在看：至少安静 90 秒再考虑开口
  if ((state.idleMs || 0) < 90_000) return { ok: false, reason: 'user-active' }
  return { ok: true, reason: 'ok' }
}

export function createProactive({
  getState = () => ({}),
  onSpeak = () => {},
  log = () => {},
  now = () => Date.now(),
  random = Math.random,
  freq = FREQUENCY.few,
  quiet = { from: '23:30', to: '07:30' },
  tickMs = 30_000,
} = {}) {
  let nextAt = now() + rand(freq.first, random) * MIN
  let todayKey = new Date(now()).toDateString()
  let todayCount = 0
  let lastSpokeAt = 0
  let lastSaid = ''
  const reasons = []

  function rollDay() {
    const k = new Date(now()).toDateString()
    if (k !== todayKey) {
      todayKey = k
      todayCount = 0
    }
  }

  function snapshot() {
    return {
      now: now(),
      todayCount,
      lastSpokeAt,
      quiet,
      proactive: freq ? 'on' : 'off',
      ...getState(),
    }
  }

  /** 试一次：门控过了才真的让她说 */
  function attempt(force = false) {
    rollDay()
    const st = snapshot()
    if (!force) {
      const g = shouldSpeak(st, freq)
      if (!g.ok) {
        reasons.push(`${new Date(st.now).toISOString()} 跳过 ${g.reason}`)
        if (reasons.length > 60) reasons.shift()
        log(`[proactive] 跳过：${g.reason}`)
        nextAt = st.now + 60_000
        return null
      }
      // 到点也掷一次骰子：避免"每 20 分钟准时报时"的机械感
      if (random() > freq.dice) {
        log('[proactive] 骰子没过，等下个窗口')
        nextAt = st.now + rand(freq.gap, random) * 0.5 * MIN
        return null
      }
    }
    lastSpokeAt = st.now
    todayCount += 1
    nextAt = st.now + rand(freq.gap, random) * MIN
    log(`[proactive] 开口（今天第 ${todayCount} 次）`)
    try {
      onSpeak()
    } catch (err) {
      log(`[proactive] 触发失败：${err?.message || err}`)
    }
    return true
  }

  return {
    /** 每 30s 由主进程调一次 */
    tick() {
      if (now() < nextAt) return false
      return attempt(false)
    },
    /** 手动触发（右键「让她说一句」），不受门控限制，但也不计入频率统计之外的惩罚 */
    force() {
      return attempt(true)
    },
    /** 她说了什么（记下来，旁白里会带上"上次你说的是…"） */
    noteSaid(text) {
      lastSaid = String(text || '').slice(0, 120)
    },
    get lastSaid() {
      return lastSaid
    },
    get nextAt() {
      return nextAt
    },
    get todayCount() {
      return todayCount
    },
    /** 最近为什么没说话（调试/单测用） */
    get reasons() {
      return reasons.slice(-20)
    },
    stats() {
      return { nextAt, todayCount, lastSpokeAt, lastSaid, tickMs }
    },
  }
}
