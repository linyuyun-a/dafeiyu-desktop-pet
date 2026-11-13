/**
 * MockBrain：没有服务器也能把整条链路跑通（气泡 / 打字 / 语义标记 / 打断）。
 * 台词带 `[[act:…]]` 标记，正好用来验证「文字 → 动作」那条映射。
 */
import { sleep } from './utils.mjs'

const LINES = [
  '本鲸在呢。[[act:tilt]]',
  '你终于想起我啦？[[act:shy,blush]]',
  '嗯……让我想想哦。[[act:think]]',
  '好耶！[[act:hop,happy]]',
  '哼，才不理你。[[act:pout,annoyed]]',
]

export class MockBrain {
  constructor() {
    this.id = 'mock'
    this.capabilities = { stream: true, memory: false, tools: false, proactive: false }
    this.i = 0
    this.aborted = false
  }

  async health() {
    return { ok: true, detail: 'mock' }
  }

  async *chat({ signal } = {}) {
    this.aborted = false
    const onAbort = () => { this.aborted = true }
    signal?.addEventListener('abort', onAbort, { once: true })
    const text = LINES[this.i++ % LINES.length]
    let full = ''
    try {
      for (const ch of text) {
        if (this.aborted) break
        full += ch
        yield { t: 'delta', text: ch }
        await sleep(45)
      }
      yield { t: 'done', full }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  interrupt() {
    this.aborted = true
  }
}
