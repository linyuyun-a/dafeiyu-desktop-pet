import type { Live2DSprite } from 'easy-live2d'

/**
 * 视线跟随鼠标（自己实现）。
 *
 * 这模型有两层参数，必须**两层都写**：
 *   · `ParamAngleX/Y` —— 直接驱动头部网格，写了眼睛看得到"头转过去"；
 *   · `AngleX/AngleY`（cdi3 控制器 OX/OY）—— 物理的输入，写了头发/五官才会有摆动。
 * 只写 `AngleX` 时物理拿到的是上一帧快照，头一动不动（用户实测回馈）；
 * 只写 `ParamAngle` 时头会转但头发是死的。（引擎自带 MouseFollow 只写后者，所以一直无效。）
 *
 * 规则（docs/学习-动作与物理惯性.md §5）：
 *   · 头：±20° / ±14°，一阶平滑 τ=120ms
 *   · 眼：±0.8 / ±0.65，τ=60ms
 *   · 死区 8px；鼠标离开 1.5s 不动 → 100ms 内回正
 *   · 播放动作期间暂停头部跟随（否则每帧覆盖会把动作的转头抹掉），只留眼球
 */

export interface Gaze {
  update: (dt: number) => void
  setEnabled: (on: boolean) => void
  /** 动作播放期间调用：ms 内不写头部参数 */
  suspendHead: (ms: number) => void
  /** 鼠标离开窗口时立刻收回视线 */
  reset: () => void
  readonly enabled: boolean
}

export interface GazeHost {
  sprite: Live2DSprite
  canvas: HTMLCanvasElement
  log?: (msg: string) => void
  /** 视线大幅跳到新目标时回调（用来顺手眨一下眼） */
  onSaccade?: () => void
}

const HEAD_X = 20
const HEAD_Y = 14
const EYE_X = 0.8
const EYE_Y = 0.65
const TAU_HEAD = 0.12
const TAU_EYE = 0.06
const DEAD_ZONE = 8
const IDLE_RESET_MS = 1500

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export function createGaze({ sprite, canvas, log, onSaccade }: GazeHost): Gaze {
  let enabled = true
  let inside = false
  let targetX = 0
  let targetY = 0
  let headX = 0
  let headY = 0
  let eyeX = 0
  let eyeY = 0
  let lastMove = 0
  let suspendUntil = 0
  let headWritten = false
  let eyeWritten = false
  // 上一次触发"眨眼伴随扫视"的目标方向与时间（防止连续 pointermove 触发一片眨眼）
  let saccadeX = 0
  let saccadeY = 0
  let saccadeAt = 0
  const SACCADE_THRESHOLD = 0.38
  const SACCADE_COOLDOWN = 420

  const setTargetFromPointer = (clientX: number, clientY: number): void => {
    const r = canvas.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
    inside = true
    lastMove = performance.now()

    // 死区：正中间一小块不追
    if (Math.abs(dx) < DEAD_ZONE) targetX = 0
    else targetX = clamp(dx / (r.width / 2), -1, 1)
    // 屏幕坐标 y 向下为正，但这个模型的 AngleY/ParamAngleY 正方向是"抬头"，
    // 所以这里要取反：鼠标在上（dy<0）→ targetY>0 → 抬头。左右不需要（X 正方向就是右）。
    if (Math.abs(dy) < DEAD_ZONE) targetY = 0
    else targetY = -clamp(dy / (r.height / 2), -1, 1)

    // 人换注视目标时会顺手眨一下眼（Live2D 动画小技巧：转眼珠的瞬间眨眼最自然），
    // 只在"跳到明显不同的方向"时触发，并且限流，避免鼠标划过去时眨一片。
    const now = performance.now()
    if (
      onSaccade &&
      now - saccadeAt > SACCADE_COOLDOWN &&
      (Math.abs(targetX - saccadeX) > SACCADE_THRESHOLD || Math.abs(targetY - saccadeY) > SACCADE_THRESHOLD)
    ) {
      saccadeX = targetX
      saccadeY = targetY
      saccadeAt = now
      onSaccade()
    }
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (!enabled) return
    if (e.target instanceof HTMLElement && e.target.closest('#panel, #bubble, #chatbar')) return
    setTargetFromPointer(e.clientX, e.clientY)
  }
  const onPointerLeave = (): void => {
    inside = false
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerleave', onPointerLeave)
  // 鼠标回到窗口但只是静止：pointerenter 补一次目标，避免贴着旧方向
  window.addEventListener('pointerenter', onPointerLeave)

  const approach = (cur: number, target: number, tau: number, dt: number): number => {
    const k = dt <= 0 ? 1 : 1 - Math.exp(-dt / tau)
    return cur + (target - cur) * k
  }

  const update = (dtRaw: number): void => {
    const dt = clamp(dtRaw, 0.001, 1 / 20)
    const now = performance.now()

    // 1.5s 没动 / 鼠标不在窗口 → 回正
    const idle = !inside || now - lastMove > IDLE_RESET_MS
    const tx = idle ? 0 : targetX
    const ty = idle ? 0 : targetY

    headX = approach(headX, tx * HEAD_X, TAU_HEAD, dt)
    headY = approach(headY, ty * HEAD_Y, TAU_HEAD, dt)
    eyeX = approach(eyeX, tx * EYE_X, TAU_EYE, dt)
    eyeY = approach(eyeY, ty * EYE_Y, TAU_EYE, dt)

    // 眼球始终跟随（动作不写眼球，安全）
    if (enabled) {
      sprite.setParameterValueById('ParamEyeBallX', eyeX, 1)
      sprite.setParameterValueById('ParamEyeBallY', eyeY, 1)
      eyeWritten = true
    } else if (eyeWritten) {
      sprite.setParameterValueById('ParamEyeBallX', 0, 1)
      sprite.setParameterValueById('ParamEyeBallY', 0, 1)
      eyeWritten = false
    }

    // 头部：动作播放期间让位给动作（物理算出来的转头）
    const suspended = now < suspendUntil
    const headAtRest = Math.abs(headX) < 0.25 && Math.abs(headY) < 0.25
    if (!enabled) {
      if (headWritten) {
        sprite.setParameterValueById('ParamAngleX', 0, 1)
        sprite.setParameterValueById('ParamAngleY', 0, 1)
        sprite.setParameterValueById('AngleX', 0, 1)
        sprite.setParameterValueById('AngleY', 0, 1)
        headWritten = false
      }
      headX = 0
      headY = 0
    } else if (suspended) {
      // 让位：把覆盖撤掉，交回物理（否则动作的转头会被我们压成 0）
      if (headWritten) {
        sprite.setParameterValueById('ParamAngleX', 0, 1)
        sprite.setParameterValueById('ParamAngleY', 0, 1)
        sprite.setParameterValueById('AngleX', 0, 1)
        sprite.setParameterValueById('AngleY', 0, 1)
        headWritten = false
      }
      headX = 0
      headY = 0
    } else if (!headAtRest || headWritten) {
      // 静止时也要"最后写一次 0"再放手，让物理重新接管
      sprite.setParameterValueById('ParamAngleX', headX, 1)
      sprite.setParameterValueById('ParamAngleY', headY, 1)
      // 物理输入（幅度略小一点，避免头发甩过头）
      sprite.setParameterValueById('AngleX', headX * 0.8, 1)
      sprite.setParameterValueById('AngleY', headY * 0.8, 1)
      headWritten = !headAtRest
    }
  }

  return {
    update,
    setEnabled(on: boolean): void {
      if (enabled === on) return
      enabled = on
      if (!on) {
        targetX = 0
        targetY = 0
        headX = 0
        headY = 0
        eyeX = 0
        eyeY = 0
      }
      log?.(`视线跟随：${on ? '开' : '关'}`)
    },
    suspendHead(ms: number): void {
      suspendUntil = performance.now() + ms
      targetX = 0
      targetY = 0
    },
    reset(): void {
      inside = false
      targetX = 0
      targetY = 0
    },
    get enabled(): boolean {
      return enabled
    }
  }
}
