import { sleep, type BrainAdapter, type BrainCapabilities, type BrainEvent } from './types'

/**
 * AstrBotBrain：**大肥鱼**的人格与记忆在 AstrBot 里（不是 LAPlatform ——
 * 那是蓝冰柚柠，两个人，别接错）。
 *
 * 接口（AstrBot ≥ 4.18 的 OpenAPI）：
 *   POST /api/v1/chat
 *   Authorization: Bearer abk_xxx   （也支持 X-API-Key）
 *   { username, session_id?, message: [{type:'plain',text}] | "…", enable_streaming: true }
 * 响应是 SSE（`data: {…}`），逐块吐。
 *
 * 两个坑：
 * ① `username` 不能填管理员 ID（默认 `admins_id=["astrbot"]`），否则 403；
 *    这里固定 `desktop_pet`，它是"这个人"在 AstrBot 里的身份。
 * ② `session_id` 是她的**记忆槽**：落盘到 state.json 一直复用，换一个就是失忆。
 */

const DEFAULT_URL = 'http://127.0.0.1:6185'
const USERNAME = 'desktop_pet'

/**
 * 推理泄漏过滤。
 *
 * 实测（远程 AstrBot，2026-11-04）：流里先吐一段英文内心独白
 * 「User says hi. Simple greeting, keep in character, short. It's 2:21 AM.…」
 * 再接正文「本鲸在呢。……」。这段独白是 reasoning 被当成 `plain` 事件推了出来，
 * 直接进气泡就是"她先用英文自言自语"。
 *
 * 处理：正文出现第一个中日韩字符之前，先把内容扣住；一旦见到 CJK，就从那个
 * 段落开头开始放行（前面的英文独白整段丢掉）。如果一直没有 CJK（她在说英文），
 * 超过 240 字或 1.5s 就原样放行，不会吞掉正常回复。
 */
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/

export function stripLeadingReasoning(text: string): string {
  const idx = text.search(CJK)
  if (idx <= 0) return text // 全是中文，或压根没有中文 → 不动
  const nl = text.lastIndexOf('\n', idx)
  if (nl < 0) return text // 没有换行就没法安全切，宁可留着
  return text.slice(nl + 1)
}

/** SSE 帧 → 文本。AstrBot 不同版本的形状略有差异，这里按「能认的都认」处理 */
function textFromEvent(obj: unknown): { kind: 'delta' | 'final' | 'error' | 'ignore'; text?: string } {
  if (!obj || typeof obj !== 'object') return { kind: 'ignore' }
  const o = obj as Record<string, unknown>
  const pick = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v
    if (v && typeof v === 'object') {
      const inner = v as Record<string, unknown>
      for (const k of ['text', 'content', 'message', 'data']) {
        if (typeof inner[k] === 'string') return inner[k] as string
      }
    }
    return undefined
  }

  const type = typeof o['type'] === 'string' ? (o['type'] as string).toLowerCase() : ''
  const text = pick(o['data']) ?? pick(o['text']) ?? pick(o['content'])

  if (type === 'error' || o['error']) {
    return { kind: 'error', text: text ?? (typeof o['error'] === 'string' ? (o['error'] as string) : 'AstrBot 报错') }
  }
  if (type === 'complete' || type === 'done' || type === 'end' || type === 'message_saved' || type === 'final') {
    return { kind: 'final', text }
  }
  if (type === 'plain' || type === 'text' || type === 'delta' || type === 'chunk') {
    return { kind: 'delta', text }
  }
  // OpenAI 兼容形状（部分版本会走这里）
  const choices = o['choices']
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>
    const delta = first['delta'] as Record<string, unknown> | undefined
    if (delta && typeof delta['content'] === 'string') return { kind: 'delta', text: delta['content'] as string }
    if (typeof first['text'] === 'string') return { kind: 'delta', text: first['text'] as string }
  }
  if (text) return { kind: 'delta', text }
  return { kind: 'ignore' }
}

export class AstrBotBrain implements BrainAdapter {
  readonly id = 'astrbot' as const
  capabilities: BrainCapabilities = { stream: true, memory: true, tools: true, proactive: false }

  private controller: AbortController | null = null
  private readonly url: string
  private readonly apiKey: string

  constructor(opts?: { url?: string; apiKey?: string }) {
    this.url = (opts?.url ?? process.env['ASTRBOT_URL'] ?? DEFAULT_URL).replace(/\/+$/, '')
    this.apiKey = opts?.apiKey ?? process.env['ASTRBOT_API_KEY'] ?? ''
  }

  get configured(): boolean {
    return this.apiKey.length > 0
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.apiKey) return { ok: false, detail: '没有 API Key（brain.config.json 的 astrbotKey）' }
    // ① 服务在不在：根路径不需要 scope，远程最容易在这步暴露端口/反代问题
    try {
      const root = await fetch(`${this.url}/`, { signal: AbortSignal.timeout(4000) })
      if (root.status >= 500) return { ok: false, detail: `服务异常 HTTP ${root.status}` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    // ② Key 认不认。`/personas` 要 persona scope；只给 chat scope 的 Key 会返回
    // 403 "Insufficient API key scope" —— 这种 Key **能聊天**，不能判失败。
    try {
      const res = await fetch(`${this.url}/api/v1/personas`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(4000)
      })
      if (res.status === 401) return { ok: false, detail: 'API Key 无效（HTTP 401）' }
      if (res.status === 403) return { ok: true, detail: 'Key 有效，仅有 chat scope（personas 不可读）' }
      if (res.status === 404) return { ok: true, detail: '该版本无 personas 接口，按可用处理' }
      if (res.status >= 500) return { ok: false, detail: `AstrBot 异常 HTTP ${res.status}` }
      return { ok: true, detail: `HTTP ${res.status}` }
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
    let streamed = '' // 原始流（可能混着推理）
    let clean = '' // complete 事件给的干净全文
    try {
      const res = await fetch(`${this.url}/api/v1/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          accept: 'text/event-stream'
        },
        body: JSON.stringify({
          username: USERNAME,
          session_id: req.sessionId,
          message: [{ type: 'plain', text: req.text }],
          enable_streaming: true
        }),
        signal: controller.signal
      })

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        yield {
          t: 'error',
          message: `AstrBot 返回 HTTP ${res.status}${detail ? `：${detail.slice(0, 120)}` : ''}`,
          recoverable: true
        }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      const handleData = (raw: string): BrainEvent | null => {
        const payload = raw.trim()
        if (!payload) return null
        if (payload === '[DONE]') return null
        let obj: unknown
        try {
          obj = JSON.parse(payload)
        } catch {
          // 不是 JSON 的 data 行：当纯文本增量攒着
          streamed += payload
          return null
        }
        const parsed = textFromEvent(obj)
        if (parsed.kind === 'error') return { t: 'error', message: parsed.text ?? 'AstrBot 报错', recoverable: true }
        if (parsed.kind === 'final') {
          if (parsed.text) clean = parsed.text
          return null
        }
        if (parsed.kind === 'delta' && parsed.text) {
          streamed += parsed.text
          return null
        }
        return null
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (line.startsWith('data:')) {
            const ev = handleData(line.slice(5))
            if (ev) yield ev
          }
          // event:/id:/retry:/注释行一律忽略
          nl = buf.indexOf('\n')
        }
      }
      if (buf.startsWith('data:')) {
        const ev = handleData(buf.slice(5))
        if (ev) yield ev
      }
      // `complete` 给的是**干净全文**（不含推理），流里的 delta 可能混着推理。
      // 所以这里以 complete 为准，再由我们自己按节奏"打字"喂给气泡。
      const text = (clean || stripLeadingReasoning(streamed)).trim()
      if (text) {
        const pace = text.length > 140 ? 6 : text.length > 60 ? 9 : 14
        for (const ch of text) {
          if (controller.signal.aborted) break
          full += ch
          yield { t: 'delta', text: ch }
          await sleep(pace)
        }
      }
      yield { t: 'done', full }
    } catch (err) {
      if (controller.signal.aborted) {
        yield { t: 'done', full }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      yield { t: 'error', message: `连不上 AstrBot（${this.url}）：${message}`, recoverable: true }
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
