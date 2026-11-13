import type { BrainAdapter } from './types'
import { AstrBotBrain } from './astrbot'
import { MockBrain } from './mock'
import { PlatformBrain } from './platform'

export type { BrainAdapter, BrainEvent, BrainCapabilities, EmotionId } from './types'
export { AstrBotBrain } from './astrbot'
export { MockBrain } from './mock'
export { PlatformBrain } from './platform'
export { loadBrainConfig, type BrainConfig } from './config'
import type { BrainConfig } from './config'

/**
 * 选大脑。
 *
 * 默认是 **AstrBot** —— 大肥鱼的人格与记忆都在那边（`username=desktop_pet`，
 * `session_id` 落 state.json 当记忆槽）。**AstrBot 跑在服务器上**，地址和 Key 不是
 * 本地端口，从 `brain.config.json` / `_data/brain.config.json` / 环境变量读（见 config.ts）。
 * `:8765` 的 LAPlatform 是**蓝冰柚柠**，另一个人；要显式 `brain: "platform"` 才会用，
 * 免得接错人。都不在就用 mock，她照样能说话。
 *
 * `brain` 字段（或 `PET_BRAIN`）填 `astrbot|platform|mock` 可强制指定。
 */
export async function pickBrain(config: BrainConfig = {}): Promise<BrainAdapter> {
  const want = config.brain
  const astrbotOpts = { url: config.astrbotUrl, apiKey: config.astrbotKey }

  if (want === 'mock') {
    console.log('[brain] brain=mock，使用本地 mock')
    return new MockBrain()
  }
  if (want === 'platform') {
    console.log('[brain] brain=platform，强制走 LAPlatform（蓝冰柚柠那边，注意不是大肥鱼）')
    return new PlatformBrain()
  }
  if (want === 'astrbot') {
    console.log(`[brain] brain=astrbot，强制走 AstrBot（大肥鱼）：${config.astrbotUrl ?? '默认地址'}`)
    return new AstrBotBrain(astrbotOpts)
  }

  const astrbot = new AstrBotBrain(astrbotOpts)
  if (astrbot.configured) {
    const health = await astrbot.health()
    if (health.ok) {
      console.log('[brain] 连上 AstrBot（大肥鱼的人格与记忆在这里）', health.detail ?? '')
      return astrbot
    }
    console.warn(`[brain] AstrBot 不可用（${health.detail ?? '?'}），先回落 mock；她照样能说话`)
  } else {
    console.warn(
      '[brain] 没有 AstrBot API Key，先回落 mock —— 在 brain.config.json 里填 astrbotUrl + astrbotKey（WebUI → 设置 → OpenAPI 建 Key）'
    )
  }
  return new MockBrain()
}
