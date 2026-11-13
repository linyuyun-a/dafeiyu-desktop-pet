import type { Live2DSprite } from 'easy-live2d'

/**
 * 防畸形层（safety net）。
 *
 * 为什么需要它：参数的"合法区间"不等于"安全区间"。
 *   1. `Clothes2`（大小变）是**关键帧参数**，keys = [0, 0.4, 1]，对应三套画好的网格。
 *      写到 0.5 这种中间值，网格会被线性插值拉开 —— 实测整个人是"头大身子塌"的畸形。
 *      表情 `体型1/体型2` 有 1s 淡入，淡入过程必然经过中间值，所以这个参数必须每帧吸附。
 *      ⚠ 只有 Clothes2 要吸附：LHand / Movement2 这类参数虽然也有 keys，但它们由物理或
 *      补间写成小数值，吸附会把自然的抖动掐死（第一版踩过，日志刷屏 Movement2=0.04→0）。
 *   2. `Movement1/2/3`（狗尾草 / 抚胸 / 竖食指）是**半身开关**：原作里它们永远和手臂链
 *      （`Param36/39/41/42` 或 `Param62/59/60/61`）一起动。动作被打断就会出现
 *      "手已经放下、道具还挂在身上"的畸形状态。这里检测到半开状态就强制关掉。
 *   3. 越界写入（比如 0..1 的参数被写成 1.4）会把网格拉伸，夹回 min/max。
 *
 * 这个层只做"擦屁股"，不做决策：不记录、不排队、不参与优先级。
 * 10Hz 足够：人眼看到畸形时，100ms 内被修回来等于没发生。
 */

type ParamRow = { id: string; min: number; max: number; def: number; keys?: number[] }

export interface Safety {
  update: (dt: number) => void
  /** 一共修过几次（调试/验收用） */
  readonly repairs: number
}

export interface SafetyHost {
  sprite: Live2DSprite
  params: ParamRow[] | null
  log?: (msg: string) => void
}

/** 我们（动作 / 表情 / 配件 / 脉冲）会写的参数。只盯这些，不做全局扫描。 */
const WATCH = [
  'Clothes1',
  'Clothes2',
  'Clothes3',
  'Clothes4',
  'Clothes5',
  'Movement1',
  'Movement2',
  'Movement3',
  'Param38',
  'Param40',
  'LeanInput',
  'CheeckPuff'
]

/** 必须吸附到关键帧的参数：中间值 = 网格被拉伸 = 畸形。只有形态参数有这个性质。 */
const SNAP_KEYS: Record<string, number[]> = {
  Clothes2: [0, 0.4, 1]
}

const INTERVAL = 0.1
const EPS = 0.01

export function createSafety({ sprite, params, log }: SafetyHost): Safety {
  const rows = new Map<string, ParamRow>((params ?? []).map((p) => [p.id, p]))
  const indexOf = new Map<string, number>((params ?? []).map((p, i) => [p.id, i]))

  const model = sprite as unknown as {
    _model?: { _model?: { getModel?: () => { parameters?: { values?: Float32Array } } } }
  }
  const readValues = (): Float32Array | null =>
    model._model?._model?.getModel?.()?.parameters?.values ?? null

  const read = (id: string): number | null => {
    const values = readValues()
    const i = indexOf.get(id)
    if (!values || i === undefined) return null
    return values[i]
  }

  const nearestKey = (keys: number[], v: number): number => {
    let best = keys[0]
    for (const k of keys) if (Math.abs(k - v) < Math.abs(best - v)) best = k
    return best
  }

  const armChain = (side: 'L' | 'R'): number => {
    if (side === 'R') return Math.max(read('Param36') ?? 0, read('Param39') ?? 0)
    return Math.max(read('Param62') ?? 0, read('Param59') ?? 0)
  }

  let repairs = 0
  let acc = 0
  let lastLog = 0
  const note = (msg: string): void => {
    if (performance.now() - lastLog < 3000) return
    lastLog = performance.now()
    log?.(msg)
  }

  const tick = (): void => {
    // ① 关键帧参数吸附（形态）
    for (const [id, keys] of Object.entries(SNAP_KEYS)) {
      const v = read(id)
      if (v === null) continue
      const best = nearestKey(keys, v)
      if (Math.abs(best - v) > EPS) {
        sprite.setParameterValueById(id, best, 1)
        repairs++
        note(`[safety] ${id}=${v.toFixed(2)} 落在关键帧之间（会畸形），吸附到 ${best}`)
      }
    }

    // ② 越界夹回
    for (const id of WATCH) {
      const row = rows.get(id)
      const v = read(id)
      if (!row || v === null) continue
      if (v > row.max + 0.001 || v < row.min - 0.001) {
        const fixed = Math.min(row.max, Math.max(row.min, v))
        sprite.setParameterValueById(id, fixed, 1)
        repairs++
        note(`[safety] ${id}=${v.toFixed(2)} 越界，夹回 ${fixed.toFixed(2)}`)
      }
    }

    // ③ 半身开关：手放下了但道具还挂着 → 强制收回
    const prop13 = Math.max(read('Movement1') ?? 0, read('Movement3') ?? 0)
    if (prop13 > 0.05 && armChain('R') < 0.25) {
      if ((read('Movement1') ?? 0) > 0.05) sprite.setParameterValueById('Movement1', 0, 1)
      if ((read('Movement3') ?? 0) > 0.05) sprite.setParameterValueById('Movement3', 0, 1)
      repairs++
      note('[safety] 右臂已放下，狗尾草/竖食指强制收回')
    }
    if ((read('Movement2') ?? 0) > 0.05 && armChain('L') < 0.25) {
      sprite.setParameterValueById('Movement2', 0, 1)
      repairs++
      note('[safety] 左臂已放下，抚胸强制收回')
    }
  }

  return {
    update(dt: number) {
      acc += dt
      if (acc < INTERVAL) return
      acc = 0
      tick()
    },
    get repairs() {
      return repairs
    }
  }
}
