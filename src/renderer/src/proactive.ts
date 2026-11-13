import { splitTags, type TagHit } from './semantics'

/**
 * 主动开口：她一个人待久了，自己说一句。
 *
 * 三条纪律（跟触发层一致）：
 *   1. 只在"安静"的时候说 —— 勿扰、正在说话、气泡开着，一律不说。
 *   2. 说得出来才计时 —— 气泡没接住（用户正在聊天）就 30s 后再试，不吞掉这一句。
 *   3. 说完要退避 —— 下一次至少 4 分钟，别变成复读机。
 *
 * 台词走本地库，不走大脑：远程一次对话要 1.7s 才出首字，而且"独自在场"这件事
 * 不需要模型重新推理。台词里带 [[act:…]] 标记，复用语义层那套映射。
 */

export interface ProactiveHost {
  /** 把一句话塞进气泡；返回 false 表示她现在接不了（开着聊天/正在说） */
  say: (text: string) => boolean
  /** 台词里的标记交给语义层 */
  onTags: (tags: TagHit[]) => void
  log: (msg: string) => void
  isQuiet?: () => boolean
  isBusy?: () => boolean
  now?: () => number
  hour?: () => number
  random?: () => number
}

export interface Proactive {
  tick: () => void
  notifyActivity: () => void
  setEnabled: (on: boolean) => void
  stats: () => { said: number; skipped: number; idleMs: number }
}

/** 用户最后一次动她之后，等多久才开口（第一次） */
const FIRST_DELAY = [120_000, 210_000] as const
/** 说完一句之后的下一次间隔 */
const NEXT_DELAY = [240_000, 480_000] as const
/** 气泡接不住时的重试间隔 */
const RETRY_MS = 30_000
/** 超过这个时长没动静，视为"睡着了" */
const DOZE_AFTER = 600_000

type Bucket = 'morning' | 'day' | 'evening' | 'late'

interface Line {
  text: string
}

const LINES: Record<Bucket | 'doze', Line[]> = {
  morning: [
    { text: '早呀。[[act:yawn]] 主人今天也要好好吃饭。' },
    { text: '醒了？[[act:nod]] 本鲸已经把窗外那点阳光看过了。' },
    { text: '太阳都晒到尾巴上了。[[act:tilt]]' },
    { text: '……早上好。[[act:shy]] 别盯着我看。' },
  ],
  day: [
    { text: '这个点最容易犯困。[[act:yawn]]' },
    { text: '主人，喝口水。[[act:nod]]' },
    { text: '……我就看看你在不在。[[act:peek]]' },
    { text: '坐那么久，肩膀要僵了。[[act:tilt]]' },
  ],
  evening: [
    { text: '天黑了。[[act:look]] 要不要开灯？' },
    { text: '今天过得怎么样？[[act:tilt]]' },
    { text: '本鲸在的，随时都在。[[act:smile]]' },
    { text: '外面好像起风了。[[act:look]]' },
  ],
  late: [
    { text: '又是这个点。[[act:pout]] 快去睡。' },
    { text: '主人，再不睡我要生气了。[[act:angry]]' },
    { text: '……我陪你到你说晚安。[[act:sleepy]]' },
    { text: '凌晨的网速倒是很快。[[act:peek]]' },
  ],
  doze: [
    { text: '……（她好像靠着睡着了）[[act:sleepy]]' },
    { text: '唔……主人还不睡吗。[[act:yawn]]' },
  ],
}

function bucketOf(hour: number): Bucket {
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 17) return 'day'
  if (hour >= 17 && hour < 23) return 'evening'
  return 'late'
}

export function createProactive({
  say,
  onTags,
  log,
  isQuiet,
  isBusy,
  now = () => performance.now(),
  hour = () => new Date().getHours(),
  random = Math.random,
}: ProactiveHost): Proactive {
  let enabled = true
  let idleSince = now()
  let due = idleSince + pick(FIRST_DELAY)
  let said = 0
  let skipped = 0
  let lastIndex = -1

  function pick([lo, hi]: readonly [number, number]): number {
    return lo + random() * (hi - lo)
  }

  function chooseLine(): Line {
    const quietFor = now() - idleSince
    const pool = quietFor >= DOZE_AFTER ? LINES.doze : LINES[bucketOf(hour())]
    // 连续两次别挑同一句
    let i = Math.floor(random() * pool.length) % pool.length
    if (pool.length > 1 && i === lastIndex) i = (i + 1) % pool.length
    lastIndex = i
    return pool[i]!
  }

  const notifyActivity = (): void => {
    idleSince = now()
    due = idleSince + pick(FIRST_DELAY)
  }

  const tick = (): void => {
    if (!enabled) return
    const t = now()
    if (t < due) return

    if (isQuiet?.() || isBusy?.()) {
      // 她这会儿不该说话：不消耗这一句，等安静下来马上说
      skipped += 1
      due = t + RETRY_MS
      return
    }

    const line = chooseLine()
    const { text, tags } = splitTags(line.text)
    if (!say(text)) {
      skipped += 1
      due = t + RETRY_MS
      return
    }
    said += 1
    onTags(tags)
    log(`主动开口：${text}`)
    due = t + pick(NEXT_DELAY)
  }

  return {
    tick,
    notifyActivity,
    setEnabled(on: boolean) {
      enabled = on
      if (on) notifyActivity()
    },
    stats: () => ({ said, skipped, idleMs: now() - idleSince }),
  }
}
