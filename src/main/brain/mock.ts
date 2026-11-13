import type { BrainAdapter, BrainCapabilities, BrainEvent } from './types'
import { sleep } from './types'

/**
 * MockBrain：不依赖任何服务的"自说自话"。
 * 用途有两个——① 平台没启动时桌宠不能变成哑巴；② 开发气泡/口型时不用等后端。
 */

const LINES = [
  '我在的呀，一直在屏幕右下角站着呢。',
  '嗯……这个问题我得想想，你先别急。',
  '今天也和昨天差不多，没什么大新闻。',
  '你刚刚是不是又熬夜了？',
  '要不要摸摸头？我这可是正经的摸头区域。'
]

export class MockBrain implements BrainAdapter {
  readonly id = 'mock' as const
  capabilities: BrainCapabilities = { stream: true, memory: false, tools: false, proactive: false }

  private aborted = false

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: '本地 mock，不连任何服务' }
  }

  async *chat(req: { text: string; sessionId: string; signal?: AbortSignal }): AsyncIterable<BrainEvent> {
    this.aborted = false
    const seed = req.text.trim().length + req.sessionId.length
    const line = LINES[seed % LINES.length]
    // 像真人打字那样一段段吐，方便验证气泡与口型
    let full = ''
    for (const ch of line) {
      if (this.aborted || req.signal?.aborted) {
        yield { t: 'done', full }
        return
      }
      full += ch
      yield { t: 'delta', text: ch }
      await sleep(38)
    }
    yield { t: 'done', full }
  }

  interrupt(): void {
    this.aborted = true
  }
}
