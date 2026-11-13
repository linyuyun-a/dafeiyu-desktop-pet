import type { BrainAdapter, BrainCapabilities, BrainEvent } from './types'

/**
 * PlatformBrain：她的"本人"在 :8765（LAPlatform，带人格/记忆/好感结算）。
 * 协议是 **NDJSON**（一行一个 JSON），不是 SSE：
 *   { "kind": "delta", "text": "…" }
 *   { "kind": "final", "text": "…" }
 * `conversation_id` 由主进程持久化，重启续聊（规划 §5.1）。
 *
 * 用 fetch + ReadableStream 而不是手写 http.request 的队列：
 * 第一版用队列 + wake 做过，出现"拿到 error 之后再也不往下走"的死锁，
 * 流式解析这种地方越朴素越不容易出错。
 */

export const PLATFORM_URL = process.env['LAAP_PLATFORM_URL'] ?? 'http://127.0.0.1:8765'

export class PlatformBrain implements BrainAdapter {
  readonly id = 'platform' as const
  capabilities: BrainCapabilities = { stream: true, memory: true, tools: true, proactive: false }

  private controller: AbortController | null = null

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${PLATFORM_URL}/`, { signal: AbortSignal.timeout(1200) })
      return { ok: res.status < 500, detail: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  async *chat(req: { text: string; sessionId: string; signal?: AbortSignal }): AsyncIterable<BrainEvent> {
    const controller = new AbortController()
    this.controller = controller
    const onOuterAbort = (): void => controller.abort()
    req.signal?.addEventListener('abort', onOuterAbort, { once: true })

    let full = ''
    try {
      const res = await fetch(`${PLATFORM_URL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: req.text, conversation_id: req.sessionId }),
        signal: controller.signal
      })
      if (!res.ok || !res.body) {
        yield { t: 'error', message: `平台返回 HTTP ${res.status}`, recoverable: true }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let sawFinal = false

      const handleLine = (line: string): BrainEvent | null => {
        const text = line.trim()
        if (!text) return null
        try {
          const obj = JSON.parse(text) as { kind?: string; text?: string; message?: string }
          if (obj.kind === 'delta' && typeof obj.text === 'string') {
            full += obj.text
            return { t: 'delta', text: obj.text }
          }
          if (obj.kind === 'final') {
            sawFinal = true
            const whole = obj.text ?? full
            full = whole
            return { t: 'done', full: whole }
          }
          if (obj.kind === 'error') return { t: 'error', message: obj.message ?? '平台报错', recoverable: true }
        } catch {
          // 非 JSON 行（心跳 / 日志）忽略，不让它炸掉整轮
        }
        return null
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          const ev = handleLine(line)
          if (ev) yield ev
          nl = buf.indexOf('\n')
        }
      }
      const tail = handleLine(buf)
      if (tail) yield tail
      if (!sawFinal) yield { t: 'done', full }
    } catch (err) {
      if (controller.signal.aborted) {
        yield { t: 'done', full }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      yield { t: 'error', message: `连不上平台（${PLATFORM_URL}）：${message}`, recoverable: true }
    } finally {
      req.signal?.removeEventListener('abort', onOuterAbort)
      if (this.controller === controller) this.controller = null
    }
  }

  interrupt(): void {
    this.controller?.abort()
    this.controller = null
  }
}
