import type { Live2DSprite } from 'easy-live2d'
import type { Gaze } from './gaze'
import type { Secondary } from './secondary'

/**
 * 执行层（故意做笨）。
 *
 * 纪律：这里只负责「把一个已经决定好的动作放出来」，不判断该不该放、不节流、不排优先级。
 * 所有"该不该"的逻辑都在 triggers.ts 里（归一化 → 门控 → 执行 → 广播），
 * 因为节流散到两处会出现「门控放行、执行器又拦」的双重状态，最难调。
 *
 * 执行原语：
 *   - face     临时表情（到点回 default，Cubism 表情不会自己消失）
 *   - gesture  我们的 13 个手势动作（Gesture / TapHead 组）
 *   - group    原厂动作组（TapBody / Prop / Emote / Special；后两组会自动成对播，见 pair）
 *   - pair     成对开关动作：组内 #0 播完接着播 #1（原厂手部/道具是「进 → 出」两段，
 *              单播会让手停在半空、道具挂在那儿不收回；按 VTS 的"一次性动画必须能淡回"规则办）
 *   - motion   指定组里的第 N 个（右键菜单用：菜单项就是「组 + 组内序号」）
 *   - any      从所有"可以单播"的动作里随机（排除 Idle 循环与成对组）
 *   - hand     pair(TapBody) 的别名（抬手 → 放下）
 *   - pulse    参数脉冲（摸耳朵抖一下、戳裙子荡一下）；直接写覆盖表，物理之后生效
 */

export type Action =
  | { type: 'face'; id: string; ms?: number }
  | { type: 'gesture'; id?: string; priority?: number }
  | { type: 'group'; group: 'TapBody' | 'Prop' | 'Emote' | 'Special' }
  | { type: 'pair'; group: string; holdMs?: number }
  | { type: 'motion'; group: string; no: number; priority?: number }
  | { type: 'any'; groups?: string[] }
  | { type: 'hand'; holdMs?: number }
  | { type: 'impulse'; strength: number }
  | { type: 'pulse'; ids: string | string[]; to: number; ms?: number }

export interface BehaviourHost {
  sprite: Live2DSprite
  log: (msg: string) => void
  gaze?: Gaze
  secondary?: Secondary
  /** 动作真实时长（秒）：manifest 里有，用来让"忙多久"跟动作对齐 */
  durationOf?: (group: string, no: number) => number
  /** 动作 id（nod / pat_shy …）。引擎给的 name 是 `组_序号`（Gesture_3），不能拿它当名字用 */
  idOf?: (group: string, no: number) => string | undefined
}

export interface Behaviour {
  /** 统一执行口。返回 false = 没有可执行的内容（比如那个组里没动作）。 */
  perform: (action: Action) => boolean
  /** 正在演一个有时长的动作（执行器自己记，给门控参考） */
  isBusy: () => boolean
  /** 最近一次指针是否在窗口内（由上层在 hover 时同步进来） */
  setPointerInside: (inside: boolean) => void
  isPointerInside: () => boolean
  /** 立刻收掉临时表情（勿扰 / 收尾时用） */
  clearFace: () => void
  dispose: () => void
}

/** 一个动作大概多久演完（没有真实时长时用这个估） */
const GESTURE_MS = 2200

export function createBehaviour({ sprite, log, gaze, secondary, durationOf, idOf }: BehaviourHost): Behaviour {
  let pointerInside = false
  let restoreTimer: number | null = null
  let seqTimer: number | null = null
  let busyUntil = 0

  const motionsOf = (group: string): Array<{ group: string; no: number; name: string }> =>
    sprite.getMotions().filter((m) => m.group === group)

  const markBusy = (ms: number): void => {
    busyUntil = Math.max(busyUntil, performance.now() + ms)
  }

  const clearFace = (): void => {
    if (restoreTimer) {
      window.clearTimeout(restoreTimer)
      restoreTimer = null
    }
    sprite.setExpression({ expressionId: 'default' })
  }

  /** 临时表情：到点自动回 default */
  const flash = (id: string, ms: number): void => {
    sprite.setExpression({ expressionId: id })
    if (restoreTimer) window.clearTimeout(restoreTimer)
    restoreTimer = window.setTimeout(() => {
      sprite.setExpression({ expressionId: 'default' })
      restoreTimer = null
    }, ms)
  }

  /** 播一个动作，并在它播放期间把头部视线让开（不然每帧覆盖会抹掉动作转头） */
  const play = (group: string, no: number, ms: number, priority = 2): void => {
    gaze?.suspendHead(ms + 250)
    markBusy(ms)
    void sprite.startMotion({ group, no, priority })
  }

  /** 成对开关动作：组内 #0 播完（holdMs 后）接着播 #1。
   *  原厂 Prop / Emote / TapBody 都是「伸出去 → 收回来」两段，单播会停在半路。 */
  const playPair = (group: string, holdMs?: number): boolean => {
    const list = motionsOf(group).sort((a, b) => a.no - b.no)
    if (list.length === 0) return false
    if (list.length === 1) {
      const ms = Math.round((durationOf?.(group, list[0].no) ?? 1.2) * 1000)
      play(group, list[0].no, ms)
      log(`${group} 只有一段，单播`)
      return true
    }
    const first = list[0]
    const second = list[1]
    const firstMs = Math.round((durationOf?.(group, first.no) ?? 1.2) * 1000)
    const secondMs = Math.round((durationOf?.(group, second.no) ?? 1.2) * 1000)
    const hold = holdMs ?? Math.max(600, firstMs - 150)
    gaze?.suspendHead(hold + secondMs + 250)
    markBusy(hold + secondMs)
    void sprite.startMotion({ group, no: first.no, priority: 2 })
    if (seqTimer) window.clearTimeout(seqTimer)
    seqTimer = window.setTimeout(() => {
      seqTimer = null
      void sprite.startMotion({ group, no: second.no, priority: 2 })
    }, hold)
    log(`${group} 成对动作（${hold}ms 后收回）`)
    return true
  }

  /** 原厂只给了"默认手↔举手"两段开关动画（TapBody#0/#1），串起来才是一条完整动作 */
  const playHandSequence = (holdMs = 900): void => {
    playPair('TapBody', holdMs)
  }

  const perform = (action: Action): boolean => {
    switch (action.type) {
      case 'face':
        flash(action.id, action.ms ?? 1200)
        return true

      case 'impulse':
        secondary?.impulse(action.strength)
        return true

      case 'hand':
        playHandSequence(action.holdMs ?? 900)
        log('抬手')
        return true

      case 'group': {
        // TapBody（抬手/放下）、Prop（狗尾草出/回）、Emote（竖食指出/回）都是两段开关，
        // 单播任一段会让手停在半空、道具挂在身上不收回 —— 一律成对播。
        if (action.group === 'TapBody') {
          playHandSequence(900)
          log('抬手（原厂两段拼接）')
          return true
        }
        if (action.group === 'Prop' || action.group === 'Emote') {
          return playPair(action.group)
        }
        const list = motionsOf(action.group)
        if (list.length === 0) return false
        const pick = list[Math.floor(Math.random() * list.length)]
        const ms = Math.round((durationOf?.(action.group, pick.no) ?? GESTURE_MS / 1000) * 1000)
        play(action.group, pick.no, ms)
        log(`${action.group} 动作 ${pick.name}`)
        return true
      }

      case 'pair':
        return playPair(action.group, action.holdMs)

      case 'pulse': {
        const ms = action.ms ?? 420
        secondary?.pulse(action.ids, action.to, ms)
        log(`参数脉冲 ${Array.isArray(action.ids) ? action.ids.join('+') : action.ids} → ${action.to}`)
        return true
      }

      case 'motion': {
        const pick = motionsOf(action.group).find((m) => m.no === action.no)
        if (!pick) return false
        const ms = Math.round((durationOf?.(pick.group, pick.no) ?? 2.2) * 1000)
        play(pick.group, pick.no, ms, action.priority ?? 3)
        log(`动作 ${idOf?.(pick.group, pick.no) ?? pick.name}`)
        return true
      }

      case 'any': {
        const allow = action.groups?.length ? new Set(action.groups) : null
        const pool = sprite.getMotions().filter((m) => {
          // Idle 是循环待机；TapBody/Prop/Emote 是"进→出"两段开关，单播会停在半路
          if (m.group === 'Idle' || m.group === 'TapBody' || m.group === 'Prop' || m.group === 'Emote') return false
          return allow ? allow.has(m.group) : true
        })
        if (pool.length === 0) return false
        const pick = pool[Math.floor(Math.random() * pool.length)]
        const ms = Math.round((durationOf?.(pick.group, pick.no) ?? 2.2) * 1000)
        play(pick.group, pick.no, ms, 2)
        log(`随机动作 ${pick.group} ${idOf?.(pick.group, pick.no) ?? pick.name}`)
        return true
      }

      case 'gesture': {
        const list = motionsOf('Gesture').concat(motionsOf('TapHead'))
        if (list.length === 0) return false
        const wanted = action.id?.toLowerCase()
        const named = wanted
          ? list.find((m) => (idOf?.(m.group, m.no) ?? '').toLowerCase() === wanted)
          : undefined
        const pick = named ?? list[Math.floor(Math.random() * list.length)]
        if (wanted && !named) log(`没找到动作 ${action.id}，改随机`)
        const ms = Math.round((durationOf?.(pick.group, pick.no) ?? 2.2) * 1000)
        play(pick.group, pick.no, ms, action.priority ?? 2)
        log(`动作 ${idOf?.(pick.group, pick.no) ?? pick.name}`)
        return true
      }
    }
  }

  return {
    perform,
    isBusy: () => performance.now() < busyUntil,
    setPointerInside: (inside: boolean) => {
      pointerInside = inside
    },
    isPointerInside: () => pointerInside,
    clearFace,
    dispose(): void {
      if (restoreTimer) window.clearTimeout(restoreTimer)
      if (seqTimer) window.clearTimeout(seqTimer)
    }
  }
}
