/**
 * 读聊天记录（stage-chat.jsonl）。
 *
 * 一行一条：{ at, role: 'user' | 'pet', text, proactive? }
 * 只做「按时间倒着取一页」，不做全文索引 —— 几千条以内够用。
 */
import { existsSync, readFileSync } from 'node:fs'

export function readHistory(logPath, { limit = 200, before = null } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 200))
  if (!existsSync(logPath)) return { items: [], hasMore: false, total: 0 }

  let raw = ''
  try {
    raw = readFileSync(logPath, 'utf8')
  } catch {
    return { items: [], hasMore: false, total: 0 }
  }

  const all = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      if (o && (o.role === 'user' || o.role === 'pet') && typeof o.text === 'string') {
        // tools 只留名字，别把整串 JSON 带到窗口里
        if (Array.isArray(o.tools)) o.tools = o.tools.map(String).slice(0, 4)
        else delete o.tools
        all.push(o)
      }
    } catch {
      // 坏行跳过：宁可少一条，也别让整页打不开
    }
  }

  const pool = before ? all.filter((x) => Number(x.at || 0) < Number(before)) : all
  const items = pool.slice(-cap)
  return { items, hasMore: pool.length > items.length, total: all.length }
}
