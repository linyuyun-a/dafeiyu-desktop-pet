import { app } from 'electron'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 会话与转录落盘（规划 §4.5：不用 SQLite，JSON + JSONL 就够）。
 * - `state.json`：只放需要"重启还记得"的少量状态（当前是 conversation_id）
 * - `chat.jsonl`：一行一条，追加写，坏了也不影响别的
 */

interface State {
  conversationId?: string
}

const statePath = (): string => join(app.getPath('userData'), 'state.json')
const chatPath = (): string => join(app.getPath('userData'), 'chat.jsonl')

function readState(): State {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as State
  } catch {
    return {}
  }
}

function writeState(patch: State): void {
  try {
    writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }, null, 2))
  } catch (err) {
    console.warn('[chat] 写 state.json 失败:', err)
  }
}

/** 第一次用就生成一个，之后一直续着聊 */
export function getConversationId(): string {
  const cur = readState().conversationId
  if (typeof cur === 'string' && cur.length > 0) return cur
  const id = `pet-${Date.now().toString(36)}`
  writeState({ conversationId: id })
  return id
}

/** 读最近 N 条（自检/调试用；正常聊天不读文件） */
export function readChat(limit = 20): Array<{ role: string; text: string; at: number }> {
  try {
    const lines = readFileSync(chatPath(), 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).map((l) => JSON.parse(l) as { role: string; text: string; at: number })
  } catch {
    return []
  }
}

export function appendChat(entry: { role: 'user' | 'pet'; text: string; at?: number }): void {
  if (!entry.text.trim()) return
  try {
    appendFileSync(chatPath(), JSON.stringify({ ...entry, at: entry.at ?? Date.now() }) + '\n')
  } catch (err) {
    console.warn('[chat] 写 chat.jsonl 失败:', err)
  }
}
