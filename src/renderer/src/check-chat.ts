import type { Bubble } from './bubble'
import type { CheckResult } from './check'

/**
 * M2 自检：气泡 / 流式 / 打断 / 落盘。
 * 用 mock 大脑跑（`PET_BRAIN=mock PET_CHATCHECK=1`），不依赖平台。
 * 这里只判定能机器判定的事；"像不像她"仍然要人看截图。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    if (pred()) return true
    await sleep(stepMs)
  }
  return pred()
}

const textOf = (): string => document.getElementById('bubble-text')?.textContent ?? ''

export async function runChatCheck(bubble: Bubble): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const push = (name: string, ok: boolean | null, detail: string): void => {
    results.push({ name, ok, detail })
    console.log(`[check] ${ok === true ? '✓' : ok === false ? '✗' : '·'} ${name} — ${detail}`)
  }

  // ① 发一句 → 气泡里出现文字（流式）
  bubble.open()
  await sleep(200)
  void bubble.send('你好呀')
  const gotText = await waitFor(() => textOf().length > 0, 9000)
  push('气泡出现文字', gotText, gotText ? `首个片段「${textOf().slice(0, 12)}」` : '4s 内没有文字')
  const grew = await waitFor(() => textOf().length > 3, 6000)
  push('逐字流式', grew, `当前「${textOf().slice(0, 16)}」`)

  // ② 打断：说完之前停下，文字不再增长，状态离开 busy
  const before = textOf()
  bubble.interrupt()
  await sleep(500)
  const after = textOf()
  const stopped = await waitFor(() => !bubble.isBusy(), 1500)
  push('打断生效', stopped && after.length === before.length, `打断前 ${before.length} 字 → 500ms 后 ${after.length} 字，idle=${!bubble.isBusy()}`)

  // ③ 完整一轮：能说完并落到 busy=false
  void bubble.send('再说一句')
  const done = await waitFor(() => !bubble.isBusy() && textOf().length > 0, 20000)
  push('完整一轮', done, done ? `全文 ${textOf().length} 字` : '8s 内没结束')

  // ④ 落盘：chat.jsonl 里有 user 与 pet 各一条
  await sleep(300)
  const history = await window.pet.chatHistory(8)
  const hasUser = history.some((h) => h.role === 'user')
  const hasPet = history.some((h) => h.role === 'pet')
  push('聊天落盘', hasUser && hasPet, `最近 ${history.length} 条，user=${hasUser} pet=${hasPet}`)

  bubble.close()
  return results
}
