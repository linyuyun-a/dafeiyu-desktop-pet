import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 大脑配置：**AstrBot 现在跑在服务器上**，地址与 Key 不能再写死成 `127.0.0.1:6185`。
 *
 * 读取顺序（后者覆盖前者）：
 *   1. 默认值（本地端口，只在开发机上还有意义）
 *   2. 工程根目录的 `brain.config.json`（推荐；不进 git，里面是 Key）
 *   3. `_data/brain.config.json`（跟着应用走的一份）
 *   4. 环境变量 `ASTRBOT_URL` / `ASTRBOT_API_KEY` / `PET_BRAIN`
 *
 * 文件长这样：
 *   {
 *     "brain": "astrbot",
 *     "astrbotUrl": "https://astrbot.example.com",
 *     "astrbotKey": "abk_xxxxxxxx",
 *     "platformUrl": "http://127.0.0.1:8765"
 *   }
 */

export interface BrainConfig {
  /** astrbot | mock | platform；不填 = 自动（能连上 AstrBot 就用它） */
  brain?: string
  astrbotUrl?: string
  astrbotKey?: string
  platformUrl?: string
}

const FILES = ['brain.config.json', join('_data', 'brain.config.json')]

function readJson(path: string): BrainConfig | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    const pick = (k: string): string | undefined => {
      const v = o[k]
      return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
    }
    return {
      brain: pick('brain'),
      astrbotUrl: pick('astrbotUrl'),
      astrbotKey: pick('astrbotKey'),
      platformUrl: pick('platformUrl')
    }
  } catch (err) {
    console.warn(`[brain] 读 ${path} 失败：`, err instanceof Error ? err.message : err)
    return null
  }
}

export function loadBrainConfig(root: string): BrainConfig {
  const merged: BrainConfig = {}
  for (const name of FILES) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    const cfg = readJson(path)
    if (!cfg) continue
    for (const [k, v] of Object.entries(cfg)) {
      if (v !== undefined) (merged as Record<string, string>)[k] = v
    }
  }
  if (process.env['ASTRBOT_URL']) merged.astrbotUrl = process.env['ASTRBOT_URL']
  if (process.env['ASTRBOT_API_KEY']) merged.astrbotKey = process.env['ASTRBOT_API_KEY']
  if (process.env['PET_BRAIN']) merged.brain = process.env['PET_BRAIN']
  return merged
}
