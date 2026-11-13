/**
 * 记忆槽与聊天记录。
 *
 * `sessionId` 就是她在 AstrBot 那边的**会话 id** —— AstrBot 靠它续上下文。
 * 换一个就等于让她失忆，所以落盘、重启复用。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createChatStore(dataDir) {
  const statePath = join(dataDir, 'stage-chat-state.json')
  const logPath = join(dataDir, 'stage-chat.jsonl')
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {}

  let state = {}
  try {
    if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf8')) || {}
  } catch {}

  if (!state.sessionId) {
    state.sessionId = `pet-${Math.random().toString(36).slice(2, 10)}`
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2))
    } catch {}
  }

  return {
    get sessionId() {
      return state.sessionId
    },
    append(entry) {
      try {
        appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...entry }) + '\n')
      } catch (err) {
        console.warn('[chat] 写记录失败', err?.message || err)
      }
    },
    logPath,
  }
}
