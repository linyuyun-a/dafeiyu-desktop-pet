/**
 * 选大脑。默认 **AstrBot**（大肥鱼的人格与记忆在那边，地址/Key 见 config.mjs）。
 * 连不上就回落 Mock —— 她照样能说话，只是没有记忆。
 */
import { AstrBotBrain } from './astrbot.mjs'
import { MockBrain } from './mock.mjs'

export function brainInfo(brain, extra = {}) {
  return {
    id: brain?.id || 'none',
    capabilities: brain?.capabilities || null,
    ...extra,
  }
}

export async function pickBrain(config = {}) {
  const want = config.brain

  if (want === 'mock') {
    console.log('[brain] brain=mock，使用本地 mock')
    return new MockBrain()
  }

  const astrbot = new AstrBotBrain({ url: config.astrbotUrl, apiKey: config.astrbotKey, configName: config.astrbotConfig })

  if (want === 'astrbot') {
    const health = await astrbot.health()
    console.log(`[brain] brain=astrbot 强制：${astrbot.url}`, health.ok ? 'ok' : `不可用（${health.detail}）`)
    return health.ok || astrbot.configured ? astrbot : new MockBrain()
  }

  if (astrbot.configured) {
    const health = await astrbot.health()
    if (health.ok) {
      console.log(`[brain] 连上 AstrBot（大肥鱼的人格与记忆在这里）：${astrbot.url}`, health.detail || '')
      return astrbot
    }
    console.warn(`[brain] AstrBot 不可用（${health.detail}），先回落 mock；她照样能说话`)
  } else {
    console.warn('[brain] 没有 AstrBot API Key，先回落 mock —— 在 brain.config.json 填 astrbotUrl + astrbotKey')
  }
  return new MockBrain()
}
