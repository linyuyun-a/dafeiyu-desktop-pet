/**
 * 大脑配置：**AstrBot 跑在服务器上**，地址与 Key 不能写死成本地端口。
 *
 * 读取顺序（后者覆盖前者）：
 *   1. 工程根目录的 `brain.config.json`（仓库里那份，含 Key，别提交）
 *   2. `_data/brain.config.json`（跟着应用走的一份）
 *   3. 环境变量 `ASTRBOT_URL` / `ASTRBOT_API_KEY` / `PET_BRAIN`
 *
 * 文件长这样：
 *   { "brain": "astrbot", "astrbotUrl": "http://1.2.3.4:6185", "astrbotKey": "abk_xxx" }
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES = ['brain.config.json', join('_data', 'brain.config.json')]

function readJson(path) {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'))
    if (!o || typeof o !== 'object') return null
    const pick = (k) => (typeof o[k] === 'string' && o[k].trim() ? o[k].trim() : undefined)
    return {
      brain: pick('brain'),
      astrbotUrl: pick('astrbotUrl'),
      astrbotKey: pick('astrbotKey'),
      platformUrl: pick('platformUrl'),
      astrbotConfig: pick('astrbotConfig'),
    }
  } catch (err) {
    console.warn(`[brain] 读 ${path} 失败：`, err?.message || err)
    return null
  }
}

export function loadBrainConfig(root) {
  const merged = {}
  for (const name of FILES) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    const cfg = readJson(path)
    if (!cfg) continue
    for (const [k, v] of Object.entries(cfg)) if (v !== undefined) merged[k] = v
  }
  if (process.env.ASTRBOT_URL) merged.astrbotUrl = process.env.ASTRBOT_URL
  if (process.env.ASTRBOT_API_KEY) merged.astrbotKey = process.env.ASTRBOT_API_KEY
  if (process.env.PET_BRAIN) merged.brain = process.env.PET_BRAIN
  if (process.env.ASTRBOT_CONFIG) merged.astrbotConfig = process.env.ASTRBOT_CONFIG
  return merged
}
