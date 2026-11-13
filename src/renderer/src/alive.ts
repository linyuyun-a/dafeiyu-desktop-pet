import type { Live2DSprite } from 'easy-live2d'

/**
 * 生命层（待基层）。
 *
 * 为什么需要它：原厂 IDLE 动作（`motions/idle.motion3.json`，6.0s 循环）里
 * **没有任何身体曲线** —— 21 条曲线全是泪花 / 高光 / 星星闪烁 + 呆滞度，
 * 没有 Angle* / Position* / 呼吸，也没有眨眼（`ParamEyeLOpen/ROpen` 不在里面）。
 * 也就是说：不演动作的时候，她是**一尊雕像**（只有物理在动头发）。
 *
 * 这一层补三件最小的事，全部是程序化的、不占 motion 文件：
 *   1. 呼吸：正弦，周期 3.8s 且每周期 ±8% 抖动（定周期会像节拍器）。
 *      官方 Breath 组件就是 Offset/Peak/Cycle/Weight 的正弦，见
 *      https://docs.live2d.com/zh-CHS/cubism-sdk-manual/breath-unity-sample/
 *   2. 重心微晃：两条不同周期的正弦叠加（9.7s / 4.13s）+ PositionX 慢漂（12.4s），
 *      让"站姿"永远不完全静止 —— 官方《提高动态质量的技巧》第 1、6 条（张弛、不要机器人）。
 *   3. 眨眼：随机间隔 2.5s ± 2.0s（=0.5–4.5s），闭 90ms / 停 30ms / 睁 150ms 并带 3.7% 过冲；
 *      间隔与幅度取自官方自动眨眼组件的 Mean / Maximum Deviation
 *      （https://docs.live2d.com/zh-CHS/cubism-sdk-tutorials/eyeblink/ ），
 *      文档原文就说"周期完全均匀会显得不自然，所以要加随机波动"。
 *      12% 概率连眨两下（人类常见），右眼比左眼晚 0–22ms 闭合（真实人脸不是同时闭的）。
 *
 * 让位规则（ownership）：动作播放期间（`isBusy()`）本层整体淡出到 0 ——
 * 否则会和 motion 抢 AngleZ / PositionY / ParamEyeLOpen，动作会被抹成半截。
 * 这与官方"多个 CubismMotionManager 后执行覆盖先执行，必须约定谁负责哪些参数"是同一个问题
 * （https://docs.live2d.com/zh-CHS/cubism-sdk-tutorials/multi-motion-management/ ）。
 */

export interface Alive {
  update: (dt: number) => void
  setEnabled: (on: boolean) => void
  /** 强制眨一次（动作起点、表情切换、被戳时用） */
  blink: () => void
  /** 调试/自检用：这一层现在实际输出多少（0 = 完全让位） */
  readonly gain: number
  readonly enabled: boolean
}

export interface AliveHost {
  sprite: Live2DSprite
  log?: (msg: string) => void
  /** 动作正在演 = 本层让位 */
  isBusy?: () => boolean
}

const TAU = Math.PI * 2

/** 呼吸 */
const BREATH_PERIOD = 3.8
const BREATH_JITTER = 0.08
const BREATH_POS_Y = 0.55
const BREATH_PARAM = 0.55

/** 重心微晃：两条不成整数倍关系的周期，叠起来不会每 10 秒精确重复 */
const SWAY_Z = [
  { period: 9.7, amp: 1.05, phase: 0.35 },
  { period: 4.13, amp: 0.34, phase: 2.2 }
]
const SWAY_X = { period: 12.4, amp: 0.55, phase: 1.1 }
// 前后慢漂走 PositionZ。
// ⚠️ 原来用的是 LeanInput，但它被 `expr_lean.exp3.json` 独占（Add −30）——
// 这一层每帧覆盖会把那个表情抹掉，所以换成没有任何表情引用的 PositionZ。
const SWAY_ZF = { period: 15.3, amp: 0.35, phase: 0.7 }

/** 眨眼 */
const BLINK_CLOSE = 0.09
const BLINK_HOLD = 0.03
const BLINK_OPEN = 0.15
const BLINK_OVERSHOOT = 0.037
const BLINK_MEAN = 2.5
const BLINK_DEV = 2.0
const DOUBLE_BLINK_CHANCE = 0.12
const EYE_LAG = 0.022

/** 让位/接回的平滑时间常数 */
const GAIN_TAU = 0.18

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const easeOutCubic = (u: number): number => 1 - Math.pow(1 - u, 3)
const easeInCubic = (u: number): number => u * u * u

export function createAlive({ sprite, log, isBusy }: AliveHost): Alive {
  let enabled = true
  let gain = 0
  let t0 = performance.now()
  let lastNow = t0

  // 呼吸：每个周期换一次周期长度（±8%），换的时候保持相位连续，避免到点跳一下
  let breathPeriod = BREATH_PERIOD
  let breathPhase = 0
  let breathCycles = 0

  // 眨眼状态机
  let blinkStart = -1
  let blinkStrength = 1
  let nextBlinkAt = t0 + 1200 + Math.random() * 800
  let pendingDoubleAt = 0

  const written = new Set<string>()
  const write = (id: string, v: number): void => {
    sprite.setParameterValueById(id, v, 1)
    written.add(id)
  }
  // 归位值 ≠ 0：眼睛的中位是 1（睁眼），写 0 等于把她按成闭眼。
  const HOME: Record<string, number> = {
    ParamEyeLOpen: 1,
    ParamEyeROpen: 1
  }
  const release = (): void => {
    if (written.size === 0) return
    for (const id of written) sprite.setParameterValueById(id, HOME[id] ?? 0, 1)
    written.clear()
  }

  const blinkValue = (now: number, lag: number): number | null => {
    if (blinkStart < 0) return null
    const t = (now - blinkStart) / 1000 - lag
    if (t < 0) return 1
    // strength < 1 = 只眨一半（小动作），闭眼最低点相应抬高
    const floor = 1 - blinkStrength
    if (t < BLINK_CLOSE) return 1 - blinkStrength * easeInCubic(t / BLINK_CLOSE)
    if (t < BLINK_CLOSE + BLINK_HOLD) return Math.max(0, floor)
    const u = (t - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN
    if (u >= 1) return null
    return floor + blinkStrength * easeOutCubic(u) + BLINK_OVERSHOOT * Math.sin(Math.PI * u)
  }

  const scheduleNext = (now: number): void => {
    // 官方 Mean=2.5s、Maximum Deviation=2s → 均匀落在 0.5–4.5s
    const raw = BLINK_MEAN + (Math.random() * 2 - 1) * BLINK_DEV
    nextBlinkAt = now + clamp(raw, 0.5, 4.5) * 1000
  }

  const startBlink = (now: number, strength = 1, delay = 0): void => {
    blinkStart = now + delay
    blinkStrength = clamp(strength, 0.35, 1.15)
  }

  const update = (dtRaw: number): void => {
    const now = performance.now()
    const dt = clamp(dtRaw, 0.001, 1 / 15)
    const busy = isBusy?.() ?? false
    // 让位是"立刻"而不是淡出：motion 的 FadeInTime 只有 0.12s，
    // 如果这一层还以权重 1 写 0.5s，动作前 0.5s 会被压回中位，预备动作直接消失。
    if (!enabled || busy) {
      if (gain !== 0) {
        gain = 0
        release()
      }
      lastNow = now
      return
    }
    gain += (1 - gain) * (1 - Math.exp(-dt / GAIN_TAU))

    // ── 呼吸 ──────────────────────────────────────────────
    breathPhase += (TAU * dt) / breathPeriod
    if (breathPhase >= TAU) {
      breathPhase -= TAU
      breathCycles += 1
      // 每圈换周期：cos 在端点是 0，所以相位连续时数值不动
      breathPeriod = BREATH_PERIOD * (1 + (Math.random() * 2 - 1) * BREATH_JITTER)
    }
    const breath = 0.5 - 0.5 * Math.cos(breathPhase) // 0..1，两端慢、中间快
    write('ParamBreath', breath * BREATH_PARAM * gain)
    // 胸腔起伏会带到肩上：身体略微上浮，用很小的量，避免"弹跳感"
    write('PositionY', -BREATH_POS_Y * breath * gain)

    // ── 重心微晃 ──────────────────────────────────────────
    const s = (period: number, phase: number): number => Math.sin((now / 1000) * (TAU / period) + phase)
    const z = SWAY_Z[0].amp * s(SWAY_Z[0].period, SWAY_Z[0].phase) + SWAY_Z[1].amp * s(SWAY_Z[1].period, SWAY_Z[1].phase)
    write('AngleZ', z * gain)
    write('PositionX', SWAY_X.amp * s(SWAY_X.period, SWAY_X.phase) * gain)
    write('PositionZ', SWAY_ZF.amp * s(SWAY_ZF.period, SWAY_ZF.phase) * gain)

    // ── 眨眼 ──────────────────────────────────────────────
    const l = blinkValue(now, 0)
    const r = blinkValue(now, EYE_LAG)
    if (l === null && r === null) {
      blinkStart = -1
      if (now >= nextBlinkAt) {
        const double = Math.random() < DOUBLE_BLINK_CHANCE
        startBlink(now, double ? 0.75 : 1)
        if (double) pendingDoubleAt = now + 260
        scheduleNext(now + (double ? 620 : 0))
      } else if (pendingDoubleAt && now >= pendingDoubleAt) {
        pendingDoubleAt = 0
        startBlink(now, 0.8)
      }
    }
    // 睁眼基线是 1：gain<1 时向 1 收，写 0 会把她按成闭眼
    write('ParamEyeLOpen', (l ?? 1) * gain + (1 - gain))
    write('ParamEyeROpen', (r ?? 1) * gain + (1 - gain))

    if (lastNow > now) t0 += now - lastNow // 系统时间回拨（极少见）
    lastNow = now
  }

  log?.(`生命层：呼吸 ${BREATH_PERIOD}s / 微晃 / 眨眼 ${BLINK_MEAN}±${BLINK_DEV}s`)

  return {
    update,
    blink(): void {
      startBlink(performance.now(), 1)
    },
    setEnabled(on: boolean): void {
      if (enabled === on) return
      enabled = on
      if (!on) release()
      log?.(`生命层：${on ? '开' : '关'}`)
    },
    get gain(): number {
      return gain
    },
    get enabled(): boolean {
      return enabled
    }
  }
}

/** 自检用：这段代码里被写过的参数（证明覆盖的是哪几个通道） */
export const ALIVE_PARAMS = ['ParamBreath', 'PositionY', 'AngleZ', 'PositionX', 'PositionZ', 'ParamEyeLOpen', 'ParamEyeROpen']
