import type { Action, Behaviour } from './behaviour'
import { ZONE_IDS } from './zones'

/**
 * 触发层：归一化 → 门控 → 执行 → 广播。
 *
 * 为什么拆成这样（而不是继续在 main.ts 里写 if）：
 *   1. 归一化：指针命中 / 长按 / 拖拽 / 悬停 / 系统状态 / 对话 / 时钟，
 *      全部先变成同一套 `TriggerKey`，下游只写一遍门控。
 *   2. 门控是纯函数：只读上下文、不改状态，返回「放不放行 + 冷却时间要不要更新」。
 *      顺序从便宜到贵：勿扰时段 → 关系/忙碌 → 冷却 → 查表。
 *   3. 执行器故意做笨：只 switch 分发到 behaviour.perform()，不在这里做节流，
 *      否则会出现「门控放行、执行器又拦」的双重状态。
 *   4. 广播：执行完把事件抛给订阅方（统计/以后的亲密度），异步旁路，不影响反馈速度。
 *
 * 动作表是纯数据（RULES）：想加一种反应 = 加一行，不改流程。
 */

export type PointerKind = 'tap' | 'double' | 'rapid' | 'hold' | 'holdEnd'
export type SystemKind = 'idle' | 'active' | 'lock' | 'unlock' | 'blur' | 'focus'
export type ChatKind = 'thinking' | 'speaking' | 'done' | 'error'
export type DragPhase = 'start' | 'end'

export interface TriggerEvent {
  key: string
  at: number
  detail?: string
}

export interface TriggerHost {
  behaviour: Behaviour
  log: (msg: string) => void
  /** 勿扰：由上层（设置/跨夜时段）决定，门控只读 */
  isQuiet?: () => boolean
  /** 事件广播（统计、以后的关系系统） */
  onEvent?: (ev: TriggerEvent) => void
}

export interface Triggers {
  pointer: (area: string, kind?: PointerKind) => void
  drag: (phase: DragPhase, speed?: number) => void
  hover: (area: string | null, inside: boolean) => void
  system: (kind: SystemKind) => void
  chat: (kind: ChatKind) => void
  /** 外部定时器每 ~5s 调一次：负责"没人理"的时钟 */
  tick: () => void
  isQuiet: () => boolean
  setQuiet: (quiet: boolean) => void
  stats: () => Record<string, number>
  dispose: () => void
}

interface Rule {
  actions: Action[]
  cooldownMs: number
  /** 3 = 可以不理会"正在演别的动作"，其余动作播放期间让路 */
  priority: number
}

/** 命中区名（来自 zones.ts 分区 / 引擎 HitAreas）→ 统一的分区 id */
const ZONE_SET = new Set<string>(ZONE_IDS)
const normalizeArea = (area: string): string => {
  if (ZONE_SET.has(area)) return area
  if (area === 'Head' || area === 'Body') return area
  // 引擎可能给出 drawable 名（脸/眼睛/头发…），归到头；其余当归到身体
  return /head|face|eye|hair|hat|ear|mimi|tou/i.test(area) ? 'Head' : 'Body'
}

/** 分区没有专门规则时，退回到"头 / 身"这两条通用规则 */
const FALLBACK_ZONE: Record<string, string> = {
  Face: 'Head',
  EarL: 'Head',
  EarR: 'Head',
  Head: 'Head',
  Chest: 'Body',
  Skirt: 'Body',
  Legs: 'Body',
  Feet: 'Body',
  Tail: 'Body',
  HandL: 'Body',
  HandR: 'Body',
  Body: 'Body'
}

const RAPID_WINDOW_MS = 1300
const HOVER_DWELL_MS = 1300
const IDLE_FIDGET_MS = 75000
const IDLE_SLEEPY_MS = 210000

const RULES: Record<string, Rule> = {
  // ── 指针：摸头 / 戳身体 ──────────────────────────────────────────────
  'Head:tap': {
    priority: 2,
    cooldownMs: 350,
    actions: [
      { type: 'face', id: 'blush', ms: 1700 },
      { type: 'gesture', id: 'pat_shy' },
      { type: 'hand', holdMs: 900 },
      { type: 'impulse', strength: 1.6 }
    ]
  },
  'Body:tap': {
    priority: 1,
    cooldownMs: 260,
    actions: [
      { type: 'face', id: 'sweat', ms: 950 },
      { type: 'group', group: 'TapBody' },
      { type: 'impulse', strength: 2.4 }
    ]
  },
  // ── 分区：同一个"摸"，落在不同部位反应不一样 ─────────────────────────
  // 手指点在哪就该有"哪里的"反应：耳朵会抖、脸会嘟、胸口会护、裙子会护裙摆、
  // 尾巴被碰会整圈弹一下。参数脉冲由 secondary 用覆盖表写（物理之后，能看见）。
  'Face:tap': {
    priority: 2,
    cooldownMs: 400,
    actions: [
      { type: 'face', id: 'blush', ms: 1400 },
      { type: 'gesture', id: 'pout' },
      { type: 'impulse', strength: 0.8 }
    ]
  },
  // 耳鳍是物理输出（LEar1..3）：写 LControl 只会喂给物理、本帧看不见，直接写输出参数
  'EarL:tap': {
    priority: 2,
    cooldownMs: 550,
    actions: [
      { type: 'pulse', ids: ['LEar1', 'LEar2', 'LEar3'], to: 1, ms: 320 },
      { type: 'face', id: 'tooth', ms: 900 },
      { type: 'gesture', id: 'tilt' }
    ]
  },
  'EarR:tap': {
    priority: 2,
    cooldownMs: 550,
    actions: [
      { type: 'pulse', ids: ['REar1', 'REar2', 'REar3'], to: 1, ms: 320 },
      { type: 'face', id: 'tooth', ms: 900 },
      { type: 'gesture', id: 'tilt' }
    ]
  },
  'Chest:tap': {
    priority: 2,
    cooldownMs: 900,
    actions: [
      // 抚胸必须和左臂链同开同关：手不放上去，Movement2 就只是"胸口多一块贴片"（畸形）。
      // 数值是实拍标定的"手停在胸口"（`_probe/grid-chest.png`）：不要全推到 1，袖子会脱肩。
      { type: 'pulse', ids: 'Param62', to: 0.55, ms: 1040 },
      { type: 'pulse', ids: 'Param59', to: 0.35, ms: 1040 },
      { type: 'pulse', ids: 'Param60', to: 0.75, ms: 1040 },
      { type: 'pulse', ids: 'Param61', to: 0.35, ms: 1040 },
      // Movement2 = 抚胸（手放到胸口），原素材自带；比手臂早一点收回，避免手先落下还插着贴片
      { type: 'pulse', ids: 'Movement2', to: 1, ms: 860 },
      { type: 'face', id: 'blush', ms: 1700 },
      { type: 'impulse', strength: 1 }
    ]
  },
  'Skirt:tap': {
    priority: 2,
    cooldownMs: 900,
    actions: [
      { type: 'pulse', ids: ['SkirtX1', 'SkirtX2', 'SkirtX3', 'SkirtX4'], to: 0.45, ms: 520 },
      { type: 'face', id: 'sneer', ms: 1300 },
      { type: 'gesture', id: 'pout' }
    ]
  },
  'Legs:tap': {
    priority: 2,
    cooldownMs: 900,
    actions: [
      // Param33 = 并腿；被戳腿会下意识并一下
      { type: 'pulse', ids: 'Param33', to: -1, ms: 600 },
      { type: 'face', id: 'sweat', ms: 1100 },
      { type: 'gesture', id: 'shake' }
    ]
  },
  'Feet:tap': {
    priority: 2,
    cooldownMs: 700,
    actions: [
      { type: 'face', id: 'tooth', ms: 900 },
      { type: 'gesture', id: 'hop' },
      { type: 'impulse', strength: 1.2 }
    ]
  },
  'Tail:tap': {
    priority: 2,
    cooldownMs: 900,
    actions: [
      {
        type: 'pulse',
        ids: [
          'Param_Angle_Rotation84',
          'Param_Angle_Rotation85',
          'Param_Angle_Rotation86',
          'Param_Angle_Rotation87',
          'Param_Angle_Rotation88',
          'Param_Angle_Rotation89'
        ],
        to: 12,
        ms: 520
      },
      { type: 'face', id: 'tooth', ms: 1000 },
      { type: 'gesture', id: 'surprise' },
      { type: 'impulse', strength: 2.6 }
    ]
  },
  'HandL:tap': {
    priority: 2,
    cooldownMs: 900,
    actions: [{ type: 'pair', group: 'TapBody' }, { type: 'face', id: 'blush', ms: 1400 }]
  },
  'HandR:tap': {
    priority: 2,
    cooldownMs: 900,
    actions: [{ type: 'pair', group: 'Emote' }, { type: 'face', id: 'sneer', ms: 1200 }]
  },
  // 连戳三下：她不高兴了
  'Head:rapid': {
    priority: 3,
    cooldownMs: 2600,
    actions: [
      { type: 'face', id: 'sneer', ms: 1500 },
      { type: 'gesture', id: 'angry', priority: 3 },
      { type: 'impulse', strength: 1.2 }
    ]
  },
  'Body:rapid': {
    priority: 3,
    cooldownMs: 2600,
    actions: [
      { type: 'face', id: 'dizzy', ms: 1500 },
      { type: 'gesture', id: 'shake', priority: 3 }
    ]
  },
  // 按住不放：被摸头摸到乖 / 被捏住
  'Head:hold': {
    priority: 2,
    cooldownMs: 1400,
    actions: [
      { type: 'face', id: 'blush', ms: 2400 },
      { type: 'gesture', id: 'pat_shy' },
      { type: 'impulse', strength: 0.8 }
    ]
  },
  'Body:hold': {
    priority: 2,
    cooldownMs: 1400,
    actions: [
      { type: 'face', id: 'tooth', ms: 1200 },
      { type: 'gesture', id: 'surprise' }
    ]
  },
  // ── 拖拽：被拎起来 / 落地 ────────────────────────────────────────────
  'drag:start': {
    priority: 3,
    cooldownMs: 900,
    actions: [
      { type: 'face', id: 'tooth', ms: 900 },
      { type: 'gesture', id: 'surprise', priority: 3 },
      { type: 'impulse', strength: 3 }
    ]
  },
  'drag:end': {
    priority: 2,
    cooldownMs: 700,
    actions: [
      { type: 'gesture', id: 'hop' },
      { type: 'impulse', strength: 2 }
    ]
  },
  // ── 悬停：她注意到你在看她 ──────────────────────────────────────────
  'hover:Head': {
    priority: 1,
    cooldownMs: 12000,
    actions: [
      { type: 'gesture', id: 'peek' },
      { type: 'face', id: 'blush', ms: 1200 }
    ]
  },
  'hover:Body': {
    priority: 1,
    cooldownMs: 15000,
    actions: [{ type: 'gesture', id: 'tilt' }]
  },
  // ── 系统 ─────────────────────────────────────────────────────────────
  'system:idle': {
    priority: 1,
    cooldownMs: 45000,
    actions: [
      { type: 'face', id: 'squint', ms: 1400 },
      { type: 'gesture', id: 'look_around' },
      { type: 'group', group: 'Prop' }
    ]
  },
  'system:sleepy': {
    priority: 2,
    cooldownMs: 120000,
    actions: [
      { type: 'face', id: 'squint', ms: 3200 },
      { type: 'gesture', id: 'yawn' }
    ]
  },
  'system:lock': {
    priority: 3,
    cooldownMs: 5000,
    actions: [
      { type: 'face', id: 'squint', ms: 60000 },
      { type: 'gesture', id: 'sleepy', priority: 3 }
    ]
  },
  'system:unlock': {
    priority: 3,
    cooldownMs: 3000,
    actions: [
      { type: 'face', id: 'tooth', ms: 900 },
      { type: 'gesture', id: 'look_around' },
      { type: 'impulse', strength: 1.4 }
    ]
  },
  'system:blur': {
    priority: 1,
    cooldownMs: 8000,
    actions: [{ type: 'gesture', id: 'look_around' }]
  },
  'system:focus': {
    priority: 1,
    cooldownMs: 8000,
    actions: [{ type: 'gesture', id: 'peek' }]
  },
  // ── 对话 ─────────────────────────────────────────────────────────────
  'chat:error': {
    priority: 3,
    cooldownMs: 1500,
    actions: [{ type: 'face', id: 'dizzy', ms: 1600 }]
  },
  'chat:done': {
    priority: 1,
    cooldownMs: 4000,
    actions: [{ type: 'impulse', strength: 0.5 }]
  },
  // ── 时钟 ─────────────────────────────────────────────────────────────
  'clock:morning': {
    priority: 1,
    cooldownMs: 6 * 3600_000,
    actions: [
      { type: 'face', id: 'blush', ms: 1600 },
      // 素材里没有"伸懒腰"这个动作（早期这里写的是 id 'stretch'，永远落到随机分支），
      // 改成"元气地蹦一下"：同样带起床气，而且是已有的 Gesture。
      { type: 'gesture', id: 'hop' }
    ]
  },
  'clock:late': {
    priority: 1,
    cooldownMs: 40 * 60_000,
    actions: [
      { type: 'face', id: 'squint', ms: 2600 },
      { type: 'gesture', id: 'yawn' }
    ]
  }
}

export function createTriggers({ behaviour, log, isQuiet, onEvent }: TriggerHost): Triggers {
  const cooldownAt = new Map<string, number>()
  const stats: Record<string, number> = {}
  let quiet = false
  let lastInteraction = performance.now()
  let tapAt: number[] = []
  let tapArea = ''
  let hoverTimer: number | null = null
  let holdTimer: number | null = null
  let lastIdleStep = 0

  const now = (): number => performance.now()

  const bump = (key: string): void => {
    stats[key] = (stats[key] ?? 0) + 1
  }

  /**
   * 门控：纯函数式判断，只读不写。
   * 顺序：勿扰 → 忙碌 → 冷却 → 查表（最便宜的在前面）。
   */
  const gate = (key: string, respectQuiet = true): Rule | null => {
    const rule = RULES[key]
    if (!rule) return null
    if (respectQuiet && (quiet || isQuiet?.())) {
      // 勿扰只挡"她主动"的那半边；用户亲手点的不挡，否则会显得卡死
      if (!/:(tap|rapid|hold)$/.test(key) && !key.startsWith('drag:')) return null
    }
    // 用户亲手点的永远优先：动作正在演也接（否则摸完头戳不动，像卡死）
    // 注意要按后缀判，不能只认 Head/Body —— 现在还有 Face/Ear/Chest/Skirt 等分区
    const userInitiated = /:(tap|rapid|hold)$/.test(key) || key.startsWith('drag:')
    if (!userInitiated && behaviour.isBusy() && rule.priority < 3) return null
    const at = cooldownAt.get(key) ?? 0
    if (now() < at) return null
    return rule
  }

  /** 执行 + 记冷却 + 广播。执行完才统一回填冷却，门控保持只读。 */
  const fire = (key: string, detail?: string, respectQuiet = true): boolean => {
    const rule = gate(key, respectQuiet)
    if (!rule) return false
    cooldownAt.set(key, now() + rule.cooldownMs)
    bump(key)
    for (const action of rule.actions) behaviour.perform(action)
    onEvent?.({ key, at: now(), detail })
    return true
  }

  const pointer = (rawArea: string, kind: PointerKind = 'tap'): void => {
    const area = normalizeArea(rawArea)
    lastInteraction = now()
    /** 分区专用规则优先；没有就退回 Head / Body 的通用规则 */
    const fireArea = (suffix: string, why = ''): boolean => {
      const own = fire(`${area}:${suffix}`, why)
      if (own) return true
      const fallback = FALLBACK_ZONE[area] ?? 'Body'
      return fallback !== area ? fire(`${fallback}:${suffix}`, why) : false
    }

    if (kind === 'holdEnd') {
      if (holdTimer) window.clearTimeout(holdTimer)
      holdTimer = null
      return
    }
    if (kind === 'hold') {
      // main.ts 已经等过 420ms，这里直接执行（再套一层定时器会变成 840ms）
      if (fireArea('hold', 'long-press')) log(`长按 ${area}`)
      return
    }

    // 连击判定：同一区域 1.3s 内第 3 下 = rapid；否则按单次 tap 记
    const t = now()
    if (tapArea !== area || t - (tapAt[tapAt.length - 1] ?? 0) > RAPID_WINDOW_MS) tapAt = []
    tapArea = area
    tapAt.push(t)
    if (tapAt.length >= 3) {
      const count = tapAt.length
      const fired = fireArea('rapid', `${count} 连击`)
      tapAt = []
      if (fired) log(`连戳 ${area} ×${count}`)
      return
    }
    if (fireArea('tap')) log(`摸 ${area}`)
  }

  const drag = (phase: DragPhase, speed = 0): void => {
    lastInteraction = now()
    if (phase === 'end') behaviour.setPointerInside(true)
    if (fire(`drag:${phase}`, `速度 ${Math.round(speed)}`)) log(`拖拽 ${phase}`)
  }

  const hover = (area: string | null, inside: boolean): void => {
    behaviour.setPointerInside(inside)
    if (hoverTimer) {
      window.clearTimeout(hoverTimer)
      hoverTimer = null
    }
    if (!inside) return
    const zone = area ? normalizeArea(area) : null
    if (!zone) return
    hoverTimer = window.setTimeout(() => {
      hoverTimer = null
      const own = fire(`hover:${zone}`, 'dwell')
      const fallback = FALLBACK_ZONE[zone] ?? 'Body'
      const fired = own || (fallback !== zone && fire(`hover:${fallback}`, 'dwell'))
      if (fired) log(`悬停注意到 ${zone}`)
    }, HOVER_DWELL_MS)
  }

  const system = (kind: SystemKind): void => {
    if (kind === 'active') {
      lastInteraction = now()
      return
    }
    if (kind === 'unlock') lastInteraction = now()
    // 系统事件不因"勿扰"被挡（锁屏时她本来就该睡）
    if (fire(`system:${kind}`)) log(`系统 ${kind}`)
  }

  const chat = (kind: ChatKind): void => {
    // 只有"出戏/结束"这种零散反馈交给触发器；对话中的表情仍由气泡层掌握
    if (kind === 'thinking' || kind === 'speaking') return
    if (fire(`chat:${kind}`, kind)) log(`对话 ${kind}`)
  }

  const tick = (): void => {
    const idleFor = now() - lastInteraction
    if (behaviour.isPointerInside()) return
    if (idleFor > IDLE_SLEEPY_MS && lastIdleStep < 2) {
      lastIdleStep = 2
      if (fire('system:sleepy', `${Math.round(idleFor / 1000)}s`)) log('太久没人理：犯困')
      return
    }
    if (idleFor > IDLE_FIDGET_MS && lastIdleStep < 1) {
      lastIdleStep = 1
      if (fire('system:idle', `${Math.round(idleFor / 1000)}s`)) log('没人理：自己找点事')
      return
    }
    if (idleFor < 5000) lastIdleStep = 0

    const hour = new Date().getHours()
    if (hour >= 6 && hour < 10) fire('clock:morning', 'morning', false)
    else if (hour >= 23 || hour < 3) fire('clock:late', 'late-night', false)
  }

  return {
    pointer,
    drag,
    hover,
    system,
    chat,
    tick,
    isQuiet: () => quiet || (isQuiet?.() ?? false),
    setQuiet(next: boolean) {
      quiet = next
      if (quiet) behaviour.clearFace()
    },
    stats: () => ({ ...stats }),
    dispose(): void {
      if (hoverTimer) window.clearTimeout(hoverTimer)
      if (holdTimer) window.clearTimeout(holdTimer)
      hoverTimer = null
      holdTimer = null
    }
  }
}
