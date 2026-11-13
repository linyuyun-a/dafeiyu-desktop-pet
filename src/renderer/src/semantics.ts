import type { Action } from './behaviour'

/** 与 preload/index.d.ts 的 EmotionId 保持一致（渲染层不跨目录引 .d.ts） */
export type EmotionId =
  | 'neutral'
  | 'happy'
  | 'love'
  | 'shy'
  | 'sad'
  | 'annoyed'
  | 'confused'
  | 'thinking'
  | 'surprised'
  | 'focus'
  | 'proud'
  | 'guard'

/**
 * 语义层：让大脑（AstrBot / 平台 / Mock）用**文字标记**指挥她的身体。
 *
 * 为什么用标记而不是结构化事件：人格与记忆在 AstrBot 那边，它只会吐**文本**。
 * 所以协议必须能塞在文本里，并且对用户不可见 —— 就是 URL 里常见的 `[[act:shy]]` 这种形式。
 *
 * 协议（全部小写，未知 key 静默忽略）：
 *   `[[act:nod]]`            演一个动作（见 SEMANTIC_ACTIONS）
 *   `[[act:shy,blush]]`      多个用逗号，按顺序演（同一回复最多 2 个）
 *   `[[face:blush]]`         只闪表情，不演动作，1.2s 后回 default
 *   `[[nod]]`                省略 kind 时按 `act` 处理
 *
 * 三条防脏规则：
 *   1. 显示前剥掉：正则匹配后整段删除，用户永远看不到标记；
 *   2. **跨流安全**：标记可能被切成 `[[ac` + `t:shy]]` 两段 delta —— 扫描器会把尾巴先扣住，
 *      确认不完整就不显示（否则气泡里会闪一下 `[[ac`）；
 *   3. 限流：同一回复 ≤2 个动作、同一 key 1.5s 内不重复，避免模型连打十个 `[[act:hop]]`。
 *
 * 表情 id 必须来自 model3 的 ascii 名（`blush` 而不是「脸红」），写错引擎**静默失败**。
 */

/** 语义 key → 执行原语。只用这套模型真有的动作/表情。 */
export const SEMANTIC_ACTIONS: Record<string, Action[]> = {
  yes: [{ type: 'gesture', id: 'nod' }],
  nod: [{ type: 'gesture', id: 'nod' }],
  no: [{ type: 'gesture', id: 'shake' }],
  shake: [{ type: 'gesture', id: 'shake' }],
  tilt: [{ type: 'gesture', id: 'tilt' }],
  bow: [{ type: 'gesture', id: 'bow' }],
  look: [{ type: 'gesture', id: 'look_around' }],
  yawn: [{ type: 'gesture', id: 'yawn' }],
  sleepy: [{ type: 'gesture', id: 'sleepy' }],
  surprise: [{ type: 'gesture', id: 'surprise' }],
  angry: [
    { type: 'gesture', id: 'angry' },
    { type: 'face', id: 'sneer', ms: 1600 }
  ],
  hop: [{ type: 'gesture', id: 'hop' }],
  peek: [{ type: 'gesture', id: 'peek' }],
  pout: [{ type: 'gesture', id: 'pout' }],
  shy: [
    { type: 'face', id: 'blush', ms: 2600 },
    { type: 'gesture', id: 'pat_shy' }
  ],
  blush: [{ type: 'face', id: 'blush', ms: 2200 }],
  cry: [{ type: 'face', id: 'cry', ms: 2600 }],
  smile: [{ type: 'face', id: 'tooth', ms: 1400 }],
  laugh: [{ type: 'face', id: 'tooth', ms: 1600 }],
  love: [{ type: 'face', id: 'heart', ms: 2200 }],
  heart: [{ type: 'face', id: 'heart', ms: 2200 }],
  think: [{ type: 'face', id: 'loading', ms: 1500 }],
  confused: [{ type: 'face', id: 'dizzy', ms: 1800 }],
  sweat: [{ type: 'face', id: 'sweat', ms: 1800 }],
  wave: [{ type: 'hand', holdMs: 900 }],
  hand: [{ type: 'hand', holdMs: 900 }]
}

/** 大脑的 emotion 事件 → 表情 id（契约里有这个事件，之前一直没人接） */
export const EMOTION_FACE: Record<EmotionId, string> = {
  neutral: 'default',
  happy: 'tooth',
  love: 'heart',
  shy: 'blush',
  sad: 'cry',
  annoyed: 'sneer',
  confused: 'dizzy',
  thinking: 'loading',
  surprised: 'tooth',
  focus: 'squint',
  proud: 'squint',
  guard: 'blackface'
}

export interface TagHit {
  kind: 'act' | 'face'
  key: string
}

const TAG_RE = /\[\[(act|face)?:?([a-z0-9_,\s]+)\]\]/gi

/** 纯函数版本：一次性把文本拆成「看得见的文字」+「标记」。 */
export function splitTags(text: string): { text: string; tags: TagHit[] } {
  const tags: TagHit[] = []
  const clean = text.replace(TAG_RE, (_m: string, kind?: string, list?: string) => {
    for (const raw of (list ?? '').split(',')) {
      const key = raw.trim().toLowerCase()
      if (key) tags.push({ kind: kind?.toLowerCase() === 'face' ? 'face' : 'act', key })
    }
    return ''
  })
  return { text: clean, tags }
}

export interface TagScanner {
  /** 喂一段增量文本，返回**可以立刻显示**的部分（可能为空串） */
  push: (chunk: string) => string
  /** 一轮对话结束时清空（未闭合的半个标记直接丢掉） */
  reset: () => void
}

/**
 * 流式扫描器：标签可能被切在任意两个 delta 之间，所以尾巴上的 `[[` 必须先扣住。
 * 例：push("你好[[ac") → 返回 "你好"，扣着 "[[ac"；push("t:nod]]呀") → 返回 "呀"。
 */
export function createTagScanner(onTags: (tags: TagHit[]) => void): TagScanner {
  let buf = ''
  return {
    push(chunk: string): string {
      buf += chunk
      const tags: TagHit[] = []
      // 先把完整的标记吃掉（全局替换，允许一条里多个）
      buf = buf.replace(TAG_RE, (_m: string, kind?: string, list?: string) => {
        for (const raw of (list ?? '').split(',')) {
          const key = raw.trim().toLowerCase()
          if (key) tags.push({ kind: kind?.toLowerCase() === 'face' ? 'face' : 'act', key })
        }
        return ''
      })
      // 尾巴上可能是半个标记：`[[` 之后还没有 `]]`
      let head = buf
      const open = buf.lastIndexOf('[[')
      if (open >= 0 && buf.indexOf(']]', open) < 0) {
        head = buf.slice(0, open)
        buf = buf.slice(open)
      } else if (buf.endsWith('[')) {
        head = buf.slice(0, -1)
        buf = '['
      } else {
        buf = ''
      }
      if (tags.length) onTags(tags)
      return head
    },
    reset(): void {
      buf = ''
    }
  }
}

/**
 * 台词推断：人格提示词不能改，她永远不会吐 `[[act:...]]` 标记。
 * 所以改成从**她自己的台词**里读情绪：语气词、标点、关键词 —— 全在客户端完成，
 * 不需要服务器配合。命中规则按数组顺序优先，一轮最多取 2 条。
 */
interface Rule {
  key: string
  re: RegExp
}

const RULES: Rule[] = [
  // 先认强信号（语气词），再认弱信号（标点）
  { key: 'laugh', re: /哈哈|嘿嘿|嘻嘻|噗嗤|笑死|好耶/ },
  { key: 'shy', re: /害羞|脸红|羞|人家|不许看|讨厌啦/ },
  { key: 'angry', re: /哼[！!。]?|生气|不理你|气死|坏蛋/ },
  { key: 'cry', re: /呜呜|哭|委屈|伤心/ },
  { key: 'love', re: /喜欢|爱你|想你|抱抱|蹭蹭/ },
  { key: 'sleepy', re: /好困|困死|打哈欠|晚安|该睡了|去睡|睡吧|熬夜/ },
  { key: 'surprise', re: /诶[？?]|欸[？?]|真的假的|竟然|居然|吓我/ },
  { key: 'peek', re: /偷偷|瞄一眼|探头|看看你/ },
  { key: 'shake', re: /才不|不是啦|没有啦|才没有/ },
  { key: 'nod', re: /^(嗯+|对|是的|好呀|行)[，,。！!]/ },
  { key: 'confused', re: /什么[？?]|为啥|怎么[？?]|听不懂|迷惑/ },
  { key: 'tilt', re: /[？?]$/ },
  { key: 'pout', re: /撇嘴/ }
]

/** 从一段台词里推断该演什么（纯函数，自检直接测这个） */
export function inferReactions(text: string, max = 2): string[] {
  const t = text.trim()
  if (!t) return []
  const hit: string[] = []
  for (const r of RULES) {
    if (hit.length >= max) break
    if (r.re.test(t) && !hit.includes(r.key)) hit.push(r.key)
  }
  return hit
}

export interface Semantics {
  /** 处理一批标记（来自流式扫描器或整段文本） */
  handle: (tags: TagHit[]) => void
  /** 大脑的 emotion 事件 */
  emotion: (id: EmotionId) => void
  /** 新回复开始：清计数，允许再演 */
  beginReply: () => void
  /** 这一轮已经处理过标记了吗（`done` 里就不要再重复解释全文） */
  sawTags: () => boolean
  /** 从她的台词推断动作；返回实际执行的 key */
  react: (text: string) => string[]
  stats: () => { fired: number; skipped: number }
}

export interface SemanticsHost {
  perform: (action: Action) => boolean
  log: (msg: string) => void
  /** 同一 key 的最短间隔 */
  cooldownMs?: number
  /** 每条回复最多执行几个 */
  maxPerReply?: number
}

export function createSemantics({ perform, log, cooldownMs = 1500, maxPerReply = 2 }: SemanticsHost): Semantics {
  const lastFired = new Map<string, number>()
  let fired = 0
  let skipped = 0
  let inReply = 0
  let anyTags = false

  const run = (tag: TagHit): void => {
    anyTags = true
    const actions = SEMANTIC_ACTIONS[tag.key]
    if (!actions) {
      skipped += 1
      log(`语义：未知标记 ${tag.kind}:${tag.key}（忽略）`)
      return
    }
    if (inReply >= maxPerReply) {
      skipped += 1
      return
    }
    const now = performance.now()
    if (now - (lastFired.get(tag.key) ?? -1e9) < cooldownMs) {
      skipped += 1
      return
    }
    lastFired.set(tag.key, now)
    inReply += 1
    fired += 1
    // `face` 标记只留表情，别把动作也放出来
    const list = tag.kind === 'face' ? actions.filter((a) => a.type === 'face') : actions
    if (list.length === 0) return
    for (const a of list) perform(a)
    log(`语义：${tag.kind}:${tag.key} → ${list.map((a) => a.type).join('+')}`)
  }

  return {
    handle(tags: TagHit[]): void {
      for (const t of tags) run(t)
    },
    emotion(id: EmotionId): void {
      const face = EMOTION_FACE[id]
      if (!face || face === 'default') return
      anyTags = true
      perform({ type: 'face', id: face, ms: 1400 })
    },
    beginReply(): void {
      inReply = 0
      anyTags = false
    },
    sawTags: () => anyTags,
    react(text: string): string[] {
      const keys = inferReactions(text, maxPerReply)
      const applied: string[] = []
      for (const k of keys) {
        const before = fired
        run({ kind: 'act', key: k })
        if (fired > before) applied.push(k)
      }
      return applied
    },
    stats: () => ({ fired, skipped })
  }
}
