import type { Live2DSprite } from 'easy-live2d'
import type { Gaze } from './gaze'
import type { Secondary } from './secondary'

/**
 * M3 验收：手势动作 / 二次运动 / 视线跟随（`?m3check=1`）。
 *
 * 这三块都只有"看起来对"没有"数值对"是验不出来的，所以这里读回模型参数：
 *   · 视线跟随：合成 pointermove 到左右两侧 → AngleX 应为负/正
 *   · 关闭跟随：setEnabled(false) → AngleX 回 0
 *   · 二次运动：喂一个拖拽速度 → 头发/尾巴参数非零，停下后衰减
 *   · 手势让位：播 Gesture 期间 AngleX 不应被视线覆盖（≈0）
 */

export interface CheckResult {
  name: string
  ok: boolean | null
  detail: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Core = { parameters?: { values?: Float32Array } }

function makeReader(sprite: Live2DSprite, ids: string[]) {
  const indexOf = new Map(ids.map((id, i) => [id, i]))
  const values = (): Float32Array | undefined =>
    (sprite as unknown as { _model?: { _model?: { getModel?: () => Core } } })._model?._model?.getModel?.()
      ?.parameters?.values
  return (id: string): number => {
    const arr = values()
    const i = indexOf.get(id)
    if (!arr || i === undefined) return NaN
    return arr[i]
  }
}

export async function runM3Check(
  sprite: Live2DSprite,
  gaze: Gaze,
  secondary: Secondary,
  paramIds: string[]
): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const push = (name: string, ok: boolean | null, detail: string): void => {
    out.push({ name, ok, detail })
    console.log(`[m3] ${ok === true ? '✓' : ok === false ? '✗' : '·'} ${name} — ${detail}`)
  }
  const read = makeReader(sprite, paramIds)
  const canvas = document.querySelector('canvas')
  if (!canvas) {
    push('画布', false, '找不到 canvas')
    return out
  }
  const r = canvas.getBoundingClientRect()

  const moveTo = (fx: number, fy: number): void => {
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: r.left + r.width * fx,
        clientY: r.top + r.height * fy,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      })
    )
  }

  // ① 视线跟随：左、右
  gaze.setEnabled(true)
  moveTo(0.08, 0.45)
  await sleep(120)
  moveTo(0.08, 0.45)
  await sleep(560)
  const axLeft = read('AngleX')
  moveTo(0.92, 0.45)
  await sleep(120)
  moveTo(0.92, 0.45)
  await sleep(560)
  const axRight = read('AngleX')
  push(
    '视线跟随（左右）',
    Number.isFinite(axLeft) && Number.isFinite(axRight) && axLeft < -4 && axRight > 4,
    `左 ${axLeft.toFixed(1)}° / 右 ${axRight.toFixed(1)}°（期望左负右正）`
  )

  // ② 眼球也跟（比头部更激进）
  const eyeRight = read('ParamEyeBallX')
  push('眼球跟随', Number.isFinite(eyeRight) && eyeRight > 0.3, `ParamEyeBallX=${eyeRight.toFixed(2)}（期望 > 0.3）`)

  // ③ 关闭后回 0
  gaze.setEnabled(false)
  await sleep(320)
  const axOff = read('AngleX')
  push('关闭跟随→回正', Number.isFinite(axOff) && Math.abs(axOff) < 1.5, `AngleX=${axOff.toFixed(2)}（期望 ≈0）`)
  gaze.setEnabled(true)

  // ④ 二次运动：喂拖拽速度，头发/尾巴应该甩起来
  const peak = { hair: 0, tail: 0 }
  for (let i = 0; i < 8; i++) {
    secondary.setDragVelocity(1600, 0)
    await sleep(45)
    peak.hair = Math.max(peak.hair, Math.abs(read('LateHairX5')))
    peak.tail = Math.max(peak.tail, Math.abs(read('Param_Angle_Rotation86')))
  }
  secondary.setDragVelocity(0, 0)
  await sleep(250)
  const hairAfter = Math.abs(read('LateHairX5'))
  await sleep(700)
  const hairSettle = Math.abs(read('LateHairX5'))
  push(
    '二次运动（后发）',
    peak.hair > 0.05 && hairSettle < Math.max(0.05, peak.hair * 0.7),
    `峰值 ${peak.hair.toFixed(2)} → 250ms ${hairAfter.toFixed(2)} → 950ms ${hairSettle.toFixed(2)}`
  )
  push('二次运动（尾巴）', peak.tail > 0.3, `峰值 ${peak.tail.toFixed(1)}°（参数单位）`)

  // ⑤ 手势动作组
  const gestures = sprite.getMotions().filter((m) => m.group === 'Gesture')
  const tapHead = sprite.getMotions().filter((m) => m.group === 'TapHead')
  push(
    '手势动作组',
    gestures.length + tapHead.length >= 11,
    `Gesture ${gestures.length} 个 / TapHead ${tapHead.length} 个（合计 ${gestures.length + tapHead.length}；手部动作另走 TapBody 序列）`
  )

  // ⑥ 手势播放时视线让位：播 nod 期间 AngleX 不应被覆盖（ogon 应接近 0 / 由物理决定）
  const nod = gestures.find((m) => m.name.includes('nod')) ?? gestures[0]
  if (nod) {
    moveTo(0.9, 0.4)
    await sleep(200)
    gaze.suspendHead(1200)
    await sprite.startMotion({ group: gestureGroupOf(nod), no: nod.no, priority: 3 })
    await sleep(260)
    const axDuring = read('AngleX')
    push('动作期间视线让位', Number.isFinite(axDuring) && Math.abs(axDuring) < 6, `AngleX=${axDuring.toFixed(1)}（期望 <6，交给动作）`)
  }

  await sleep(1600)
  console.log('[m3] done')
  return out
}

function gestureGroupOf(m: { group: string; no: number; name: string }): string {
  return m.group
}
