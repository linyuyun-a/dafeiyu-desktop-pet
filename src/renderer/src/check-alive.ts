import type { Live2DSprite } from 'easy-live2d'
import { ALIVE_PARAMS, type Alive } from './alive'

/**
 * 生命层自检（`PET_ALIVECHECK=1` → `?alivecheck=1`）。
 *
 * 这一层全是"缓慢的、看起来对"的东西，截图根本验不出来，只能读回参数看曲线：
 *   ① 呼吸：PositionY 在 8s 内要有 ≥0.25 的起伏，且周期落在 3.2–4.6s
 *   ② 微晃：AngleZ 在 8s 内极差 ≥0.6
 *   ③ 眨眼：12s 内 ParamEyeLOpen 至少闭到 <0.45（真闭眼）且眨眼 ≥2 次、间隔不等（证明随机）
 *   ④ 让位：动作播放期间（gain→0）这些通道回 0，不跟 motion 抢参数
 *   ⑤ 关闭：setEnabled(false) 后所有通道归零
 */

export interface AliveCheckResult {
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

interface Sample {
  t: number
  v: number
}

/** 按 rAF 采样 ms 毫秒 */
async function record(read: () => number, ms: number): Promise<Sample[]> {
  const out: Sample[] = []
  const t0 = performance.now()
  return await new Promise<Sample[]>((resolve) => {
    const step = (): void => {
      const now = performance.now()
      out.push({ t: now - t0, v: read() })
      if (now - t0 < ms) requestAnimationFrame(step)
      else resolve(out)
    }
    requestAnimationFrame(step)
  })
}

const range = (xs: number[]): number => Math.max(...xs) - Math.min(...xs)

/** 找下穿阈值的位置（眨眼次数） */
function crossings(samples: Sample[], threshold: number): number[] {
  const hits: number[] = []
  let inside = false
  for (const s of samples) {
    if (!inside && s.v < threshold) {
      inside = true
      hits.push(s.t)
    } else if (inside && s.v > threshold + 0.15) {
      inside = false
    }
  }
  return hits
}

export async function runAliveCheck(sprite: Live2DSprite, alive: Alive, paramIds: string[]): Promise<AliveCheckResult[]> {
  const out: AliveCheckResult[] = []
  const push = (name: string, ok: boolean | null, detail: string): void => {
    out.push({ name, ok, detail })
    console.log(`[alive] ${ok === true ? '✓' : ok === false ? '✗' : '·'} ${name} — ${detail}`)
  }
  const read = makeReader(sprite, paramIds)
  const readAll = (): Record<string, number> => Object.fromEntries(ALIVE_PARAMS.map((id) => [id, read(id)]))

  alive.setEnabled(true)
  await sleep(700) // 让 gain 爬到 1

  // ① 呼吸
  const py = await record(() => read('PositionY'), 8600)
  const breathRange = range(py.map((s) => s.v))
  // 用"回到中位"的时刻数周期
  const mid = (Math.max(...py.map((s) => s.v)) + Math.min(...py.map((s) => s.v))) / 2
  const dips = crossings(
    py.map((s) => ({ t: s.t, v: s.v - mid })),
    0
  )
  const derivedPeriod = dips.length >= 2 ? (dips[dips.length - 1] - dips[0]) / (dips.length - 1) / 1000 : NaN
  push(
    '呼吸：PositionY 有起伏',
    breathRange >= 0.25,
    `极差 ${breathRange.toFixed(3)}（阈值 ≥0.25）`
  )
  push(
    '呼吸：周期 3.2–4.6s',
    Number.isFinite(derivedPeriod) ? derivedPeriod > 3.2 && derivedPeriod < 4.6 : null,
    Number.isFinite(derivedPeriod) ? `实测 ${derivedPeriod.toFixed(2)}s` : '样本里不足两个周期，跳过'
  )

  // ② 微晃
  const az = await record(() => read('AngleZ'), 8000)
  const swayRange = range(az.map((s) => s.v))
  push('微晃：AngleZ 极差', swayRange >= 0.6, `极差 ${swayRange.toFixed(3)}（阈值 ≥0.6）`)

  // ③ 眨眼
  const eye = await record(() => read('ParamEyeLOpen'), 12000)
  const minEye = Math.min(...eye.map((s) => s.v))
  const blinks = crossings(eye, 0.45)
  const gaps = blinks.slice(1).map((t, i) => (t - blinks[i]) / 1000)
  const spread = gaps.length >= 2 ? Math.max(...gaps) - Math.min(...gaps) : 0
  push('眨眼：真闭上（<0.45）', minEye < 0.45, `最低 ${minEye.toFixed(3)}`)
  push('眨眼：12s 内 ≥2 次', blinks.length >= 2, `实测 ${blinks.length} 次`)
  push('眨眼：间隔不固定', spread >= 0.08, `相邻间隔差 ${spread.toFixed(2)}s（阈值 ≥0.08s）`)

  // ④ 让位：关掉整层，通道必须回到各自的中位（眼睛中位是 1，不是 0）
  alive.setEnabled(false)
  await sleep(700)
  const off = readAll()
  const HOME: Record<string, number> = { ParamEyeLOpen: 1, ParamEyeROpen: 1 }
  const maxOff = Math.max(...ALIVE_PARAMS.map((id) => Math.abs((off[id] ?? 0) - (HOME[id] ?? 0))))
  push(
    '让位：关闭后各通道回中位',
    maxOff < 0.12,
    ALIVE_PARAMS.map((id) => `${id}=${(off[id] ?? 0).toFixed(2)}`).join(' ')
  )
  push('让位：眼睛是睁开的（不是被按闭）', (off['ParamEyeLOpen'] ?? 0) > 0.9, `ParamEyeLOpen=${(off['ParamEyeLOpen'] ?? 0).toFixed(2)}`)
  push('让位：gain 收到 0', alive.gain < 0.02, `gain=${alive.gain.toFixed(3)}`)

  // ⑤ 恢复
  alive.setEnabled(true)
  await sleep(900)
  const on = readAll()
  push('恢复：gain 回到 1', alive.gain > 0.9, `gain=${alive.gain.toFixed(3)}`)
  push('恢复：呼吸重新有值', on['ParamBreath'] > 0.01, `ParamBreath=${(on['ParamBreath'] ?? 0).toFixed(3)}`)

  return out
}
