import type { Live2DSprite } from 'easy-live2d'

/**
 * 二次运动层（secondary motion）。
 *
 * 为什么需要它：物理只对「动作把 OP 参数改掉」有反应；我们用覆盖表写
 * `ParamAngleX/Z`（视线跟随、拖拽惯性）时物理完全看不见，头发/尾巴纹丝不动。
 * 所以这几条链（前发/后发/侧发/尾巴/裙摆/袖子/飘带/帽子）由这里用二阶阻尼
 * 振子自己算，直接写渲染参数。
 *
 * 依据与参数来自 docs/学习-动作与物理惯性.md §4。每帧最多写 ~35 个参数。
 */

interface ParamLike {
  id: string
  def: number
}

type Drive = 'headX' | 'headZ' | 'bodyX' | 'bodyZ'

interface ChainSpec {
  name: string
  ids: string[]
  /** 沿链递增的系数：发梢甩得更开 */
  coeff: number[]
  /** 输出上限（发丝 0.6~0.9、尾巴按度） */
  limit: number
  stiffness: number
  zeta: number
  drive: Drive
  gain: number
  /** 输出 = 振子位移 × coeff × scale */
  scale: number
  /** 镜像链的方向：左右两侧的 X 参数轴是反的 */
  sign?: number
}

interface Chain extends ChainSpec {
  x: number
  v: number
  written: boolean
}

const CHAINS: ChainSpec[] = [
  {
    name: '前发',
    ids: ['FrontHairX1', 'FrontHairX2', 'FrontHairX3', 'FrontHairX4'],
    coeff: [0.45, 0.7, 0.9, 1],
    limit: 0.6,
    stiffness: 65,
    zeta: 0.62,
    drive: 'headZ',
    gain: 1,
    scale: 1
  },
  {
    name: '后发',
    ids: ['LateHairX1', 'LateHairX2', 'LateHairX3', 'LateHairX4', 'LateHairX5'],
    coeff: [0.3, 0.5, 0.7, 0.9, 1],
    limit: 0.9,
    stiffness: 45,
    zeta: 0.55,
    drive: 'headZ',
    gain: 1.5,
    scale: 1
  },
  {
    name: '侧发R',
    ids: ['SideHairRX1', 'SideHairRX2', 'SideHairRX3'],
    coeff: [0.5, 0.75, 1],
    limit: 0.7,
    stiffness: 60,
    zeta: 0.6,
    drive: 'headX',
    gain: 1.2,
    scale: 1
  },
  {
    name: '侧发L',
    ids: ['SideHairX1', 'SideHairX2', 'SideHairX3'],
    coeff: [0.5, 0.75, 1],
    limit: 0.7,
    stiffness: 60,
    zeta: 0.6,
    drive: 'headX',
    gain: 1.2,
    scale: 1,
    sign: -1
  },
  {
    name: '尾巴',
    ids: [
      'Param_Angle_Rotation84',
      'Param_Angle_Rotation85',
      'Param_Angle_Rotation86',
      'Param_Angle_Rotation87',
      'Param_Angle_Rotation88',
      'Param_Angle_Rotation89'
    ],
    coeff: [0.25, 0.4, 0.6, 0.75, 0.9, 1],
    limit: 15,
    stiffness: 28,
    zeta: 0.45,
    drive: 'bodyZ',
    gain: 1.6,
    scale: 15
  },
  {
    name: '裙摆',
    ids: ['SkirtX1', 'SkirtX2', 'SkirtX3', 'SkirtX4'],
    coeff: [0.4, 0.7, 0.9, 1],
    limit: 0.7,
    stiffness: 40,
    zeta: 0.6,
    drive: 'bodyX',
    gain: 0.9,
    scale: 1
  },
  {
    name: '左袖',
    ids: ['LSleeveX1', 'LSleeveX2', 'LSleeveX3'],
    coeff: [0.6, 0.8, 1],
    limit: 0.8,
    stiffness: 50,
    zeta: 0.65,
    drive: 'bodyX',
    gain: 1,
    scale: 1
  },
  {
    name: '右袖',
    ids: ['RSleeveX1', 'RSleeveX2', 'RSleeveX3'],
    coeff: [0.6, 0.8, 1],
    limit: 0.8,
    stiffness: 50,
    zeta: 0.65,
    drive: 'bodyX',
    gain: 1,
    scale: 1
  },
  {
    name: '左飘带',
    ids: ['LRibbonX1', 'LRibbonX2', 'LRibbonX3', 'LRibbonX4'],
    coeff: [0.4, 0.65, 0.85, 1],
    limit: 0.7,
    stiffness: 35,
    zeta: 0.5,
    drive: 'bodyX',
    gain: 1,
    scale: 1
  },
  {
    name: '右飘带',
    ids: ['RRibbonX1', 'RRibbonX2', 'RRibbonX3', 'RRibbonX4'],
    coeff: [0.4, 0.65, 0.85, 1],
    limit: 0.7,
    stiffness: 35,
    zeta: 0.5,
    drive: 'bodyX',
    gain: 1,
    scale: 1
  },
  {
    name: '帽子',
    ids: ['Hat_XA', 'Hat_XB', 'Hat_XC'],
    coeff: [0.5, 0.8, 1],
    limit: 0.7,
    stiffness: 70,
    zeta: 0.7,
    drive: 'headZ',
    gain: 1.1,
    scale: 1
  }
]

export interface SecondaryInput {
  /** 拖窗口速度（像素/秒），松手传 0 */
  dragVx: number
  dragVy: number
}

export interface Secondary {
  update: (dt: number) => void
  setEnabled: (on: boolean) => void
  setDragVelocity: (vx: number, vy: number) => void
  /** 被摸到、被戳到时的额外冲量（deg/s 当量） */
  impulse: (strength: number) => void
  /**
   * 参数脉冲：把参数推到 to，hold 一段时间再平滑回原值。
   * 给"摸耳朵→耳鳍抖一下""戳裙子→裙摆荡一下"这类一次性反应用。
   * 写的是覆盖表（在物理之后应用），所以能被看见。
   */
  pulse: (ids: string | string[], to: number, ms: number) => void
  readonly enabled: boolean
}

export interface SecondaryHost {
  sprite: Live2DSprite
  params: ParamLike[] | null
  log?: (msg: string) => void
}

/** 从引擎内部控制器的 parameters.values 里读当前值（没有公开 getter） */
function makeReader(sprite: Live2DSprite, params: ParamLike[] | null) {
  const indexOf = new Map((params ?? []).map((p, i) => [p.id, i]))
  type Core = { parameters?: { values?: Float32Array } }
  const values = (): Float32Array | undefined =>
    (sprite as unknown as { _model?: { _model?: { getModel?: () => Core } } })._model?._model?.getModel?.()
      ?.parameters?.values
  return (id: string): number => {
    const arr = values()
    const i = indexOf.get(id)
    if (!arr || i === undefined || i >= arr.length) return 0
    return arr[i]
  }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export function createSecondary({ sprite, params, log }: SecondaryHost): Secondary {
  const read = makeReader(sprite, params)
  const chains: Chain[] = CHAINS.map((c) => ({ ...c, x: 0, v: 0, written: false }))

  let enabled = true
  let dragVx = 0
  let dragVy = 0
  let prevHeadX = 0
  let prevHeadZ = 0
  let prevBodyX = 0
  let prevBodyZ = 0
  let primed = false
  let impulseDeg = 0
  // 拖拽时的"整只被拽着走"滞后（直接写物理输出参数）
  let lagZ = 0
  let lagY = 0
  let lagWritten = false
  // 一次性参数脉冲（摸耳朵/戳裙子这类）
  const pulses: Array<{ ids: string[]; from: number[]; to: number; ms: number; t: number }> = []

  const applyPulses = (dt: number): void => {
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i]
      p.t += dt
      const tMs = p.t * 1000
      const leadIn = 90
      const leadOut = 180
      let k: number
      if (tMs < leadIn) k = tMs / leadIn
      else if (tMs < p.ms) k = 1
      else if (tMs < p.ms + leadOut) k = 1 - (tMs - p.ms) / leadOut
      else k = 0
      for (let j = 0; j < p.ids.length; j++) {
        sprite.setParameterValueById(p.ids[j], p.from[j] + (p.to - p.from[j]) * k, 1)
      }
      if (k === 0) {
        for (let j = 0; j < p.ids.length; j++) sprite.setParameterValueById(p.ids[j], p.from[j], 1)
        pulses.splice(i, 1)
      }
    }
  }

  const velocity = (cur: number, prev: number, dt: number): number => {
    if (dt <= 0) return 0
    return clamp((cur - prev) / dt, -800, 800)
  }

  const writeChain = (chain: Chain): void => {
    for (let i = 0; i < chain.ids.length; i++) {
      const value = chain.x * chain.coeff[i] * chain.scale * (chain.sign ?? 1)
      sprite.setParameterValueById(chain.ids[i], clamp(value, -chain.limit * 1.4, chain.limit * 1.4), 1)
    }
    chain.written = true
  }

  const clearChain = (chain: Chain): void => {
    if (!chain.written) return
    for (const id of chain.ids) sprite.setParameterValueById(id, 0, 1)
    chain.written = false
  }

  const update = (dtRaw: number): void => {
    const dt = clamp(dtRaw, 0.001, 1 / 20)

    const headX = read('AngleX')
    const headZ = read('AngleY')
    const bodyX = read('ParamBodyAngleX')
    const bodyZ = read('ParamBodyAngleZ')

    if (!primed) {
      prevHeadX = headX
      prevHeadZ = headZ
      prevBodyX = bodyX
      prevBodyZ = bodyZ
      primed = true
      return
    }

    const vx = velocity(headX, prevHeadX, dt)
    const vz = velocity(headZ, prevHeadZ, dt)
    const bx = velocity(bodyX, prevBodyX, dt)
    const bz = velocity(bodyZ, prevBodyZ, dt)
    prevHeadX = headX
    prevHeadZ = headZ
    prevBodyX = bodyX
    prevBodyZ = bodyZ

    // 窗口拖动速度（px/s）换算成角度速度当量
    const dragAngle = clamp(dragVx * 0.02 + dragVy * 0.012, -150, 150)

    // 速度当量统一夹到 ±150 deg/s，否则一次快速点头会直接把振子顶到上限
    const driveOf = (drive: Drive): number => {
      switch (drive) {
        case 'headX':
          return clamp(vx + dragAngle, -150, 150)
        case 'headZ':
          return clamp(vz * 1.1 + dragAngle * 0.7, -150, 150)
        case 'bodyX':
          return clamp(bx + dragAngle * 0.5, -150, 150)
        case 'bodyZ':
          return clamp(bz + dragAngle * 0.8, -150, 150)
      }
    }

    for (const chain of chains) {
      if (!enabled) {
        // 关闭时 60ms 内平滑归零
        chain.x += (0 - chain.x) * Math.min(1, dt / 0.06)
        chain.v = 0
        if (Math.abs(chain.x) < 0.002) {
          clearChain(chain)
        } else {
          writeChain(chain)
        }
        continue
      }

      const drive = driveOf(chain.drive)
      const target = clamp(-drive * 0.008 * chain.gain, -chain.limit, chain.limit) + impulseDeg * chain.gain
      const k = chain.stiffness
      const c = 2 * chain.zeta * Math.sqrt(k)
      // 半步积分，30fps 下也稳定
      const steps = 2
      const h = dt / steps
      for (let s = 0; s < steps; s++) {
        const a = -k * (chain.x - target) - c * chain.v
        chain.v += a * h
        chain.x += chain.v * h
        chain.x = clamp(chain.x, -chain.limit, chain.limit)
      }
      writeChain(chain)
    }

    // 冲量衰减
    impulseDeg *= Math.max(0, 1 - dt / 0.35)
    if (Math.abs(impulseDeg) < 0.01) impulseDeg = 0

    // 整只被拽走的滞后：只在拖动时写，停下 120ms 内归零
    if (enabled) {
      const targetZ = clamp(-dragVx * 0.012, -12, 12)
      const targetY = clamp(dragVy * 0.008, -8, 8)
      lagZ += (targetZ - lagZ) * Math.min(1, dt / 0.08)
      lagY += (targetY - lagY) * Math.min(1, dt / 0.08)
      if (Math.abs(lagZ) > 0.02 || Math.abs(lagY) > 0.02 || lagWritten) {
        sprite.setParameterValueById('ParamBodyAngleZ', lagZ, 1)
        sprite.setParameterValueById('ParamBodyAngleY', lagY, 1)
        lagWritten = Math.abs(lagZ) > 0.02 || Math.abs(lagY) > 0.02
      }
    } else if (lagWritten) {
      sprite.setParameterValueById('ParamBodyAngleZ', 0, 1)
      sprite.setParameterValueById('ParamBodyAngleY', 0, 1)
      lagZ = 0
      lagY = 0
      lagWritten = false
    }

    // 松手后把拖动输入快速衰减，避免残余速度一直推振子
    dragVx *= Math.max(0, 1 - dt / 0.06)
    dragVy *= Math.max(0, 1 - dt / 0.06)
    if (Math.abs(dragVx) < 1) dragVx = 0
    if (Math.abs(dragVy) < 1) dragVy = 0

    applyPulses(dt)
  }

  return {
    update,
    setEnabled(on: boolean): void {
      if (enabled === on) return
      enabled = on
      log?.(`二次运动层：${on ? '开' : '关'}`)
    },
    setDragVelocity(vx: number, vy: number): void {
      dragVx = clamp(vx, -4000, 4000)
      dragVy = clamp(vy, -4000, 4000)
    },
    impulse(strength: number): void {
      impulseDeg = clamp(strength, -6, 6)
    },
    pulse(ids: string | string[], to: number, ms: number): void {
      const list = Array.isArray(ids) ? ids : [ids]
      const from = list.map((id) => read(id))
      // 同一参数已有脉冲时先撤掉，避免两条脉冲互相打架
      for (let i = pulses.length - 1; i >= 0; i--) {
        if (pulses[i].ids.some((id) => list.includes(id))) pulses.splice(i, 1)
      }
      pulses.push({ ids: list, from, to, ms: Math.max(60, ms), t: 0 })
    },
    get enabled(): boolean {
      return enabled
    }
  }
}
