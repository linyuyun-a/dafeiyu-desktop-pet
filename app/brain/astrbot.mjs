/**
 * AstrBotBrain：**大肥鱼**的人格与记忆都在 AstrBot 里。
 * （`:8765` 的 LAPlatform 是蓝冰柚柠，另一个人，别接错。）
 *
 * 接口（AstrBot ≥ 4.18 的 OpenAPI）：
 *   POST /api/v1/chat
 *   Authorization: Bearer abk_xxx
 *   { username, session_id, message: [{type:'plain',text}], enable_streaming: true }
 * 响应是 SSE（`data: {…}`）。
 *
 * 三个必须保留的细节：
 * ① `username` 固定 `desktop_pet` —— 填管理员 ID（默认 admins_id=["astrbot"]）会被 403。
 * ② `session_id` 是她的**记忆槽**：一直复用同一个，换一个就是失忆。
 * ③ 远端模型会把 reasoning 当 `plain` 吐出来（"User says hi. Simple greeting…"）。
 *    但 `complete` 事件的 `data` 是**干净全文**。所以：流里的 delta 只攒不用，
 *    以 complete 为准，再由我们自己按节奏逐字喂给气泡 —— 宁可慢 0.5s，也不让她先自言自语。
 */


const USERNAME = 'desktop_pet'
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/

/** 没有 complete 兜底时的抢救：正文出现第一个 CJK 之前，把整段英文独白丢掉 */
export function stripLeadingReasoning(text) {
  const idx = text.search(CJK)
  if (idx <= 0) return text
  const nl = text.lastIndexOf('\n', idx)
  if (nl < 0) return text
  return text.slice(nl + 1)
}

function textFromEvent(obj) {
  if (!obj || typeof obj !== 'object') return { kind: 'ignore' }
  const pick = (v) => {
    if (typeof v === 'string') return v
    if (v && typeof v === 'object') {
      for (const k of ['text', 'content', 'message', 'data']) if (typeof v[k] === 'string') return v[k]
    }
    return undefined
  }
  const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : ''
  const text = pick(obj.data) ?? pick(obj.text) ?? pick(obj.content)
  if (type === 'error' || obj.error) {
    return { kind: 'error', text: text ?? (typeof obj.error === 'string' ? obj.error : 'AstrBot 报错') }
  }
  if (type === 'complete' || type === 'done' || type === 'end' || type === 'message_saved' || type === 'final') {
    return { kind: 'final', text }
  }
  if (type === 'plain' || type === 'text' || type === 'delta' || type === 'chunk') return { kind: 'delta', text }
  const choices = obj.choices
  if (Array.isArray(choices) && choices.length) {
    const first = choices[0]
    if (first?.delta && typeof first.delta.content === 'string') return { kind: 'delta', text: first.delta.content }
    if (typeof first?.text === 'string') return { kind: 'delta', text: first.text }
  }
  if (text) return { kind: 'delta', text }
  return { kind: 'ignore' }
}

/**
 * 剥掉流里的「工具调用 JSON」。
 *
 * AstrBot 开了网页搜索/MCP 之后，会把 tool_call 的 JSON（`{"id": "call_00_...", "name": "web_search", ...}`）
 * 也当成 plain 增量吐出来。直接上屏就会看到她念一串 JSON，TTS 也会读出来。
 * 这里按「字符流」剥离：从一段开头的 `{` / `[` 起进入吞字态，按括号配平退出。
 * 正常文字（包括句中出现的括号）不受影响；末尾的 complete 仍是权威文本。
 */
class ToolNoiseFilter {
  constructor() { this.depth = 0 }

  feed(text) {
    let out = ''
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (this.depth > 0) {
        if (ch === '{' || ch === '[') this.depth++
        else if (ch === '}' || ch === ']') { this.depth--; if (this.depth < 0) this.depth = 0 }
        continue
      }
      // 只把「一段开头」的 { 当成工具 JSON 的起点。
      // 不能吞 [：她的标记 [[play:…]] / [[wear:…]] 都是以 [ 开头，吞了就永远不生效
      if (ch === '{' && out.trim() === '') { this.depth = 1; continue }
      out += ch
    }
    return out
  }
}

export class AstrBotBrain {
  constructor({ url, apiKey, configName } = {}) {
    this.id = 'astrbot'
    this.capabilities = { stream: true, memory: true, tools: true, proactive: false }
    this.url = String(url || 'http://127.0.0.1:6185').replace(/\/+$/, '')
    this.apiKey = apiKey || ''
    // 桌宠专用配置文件（人格「鲸鸢·桌宠」）：QQ 走 default，两边互不串台
    this.configName = String(configName || '').trim()
    this.controller = null
  }

  get configured() {
    return this.apiKey.length > 0
  }

  async health() {
    if (!this.apiKey) return { ok: false, detail: '没有 API Key（brain.config.json 的 astrbotKey）' }
    try {
      const root = await fetch(`${this.url}/`, { signal: AbortSignal.timeout(4000) })
      if (root.status >= 500) return { ok: false, detail: `服务异常 HTTP ${root.status}` }
    } catch (err) {
      return { ok: false, detail: err?.message || String(err) }
    }
    try {
      const res = await fetch(`${this.url}/api/v1/personas`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(4000),
      })
      if (res.status === 401) return { ok: false, detail: 'API Key 无效（HTTP 401）' }
      // 只给了 chat scope 的 Key 读不了 personas，但**能聊天**，不能判失败
      if (res.status === 403) return { ok: true, detail: 'Key 有效，仅有 chat scope' }
      if (res.status === 404) return { ok: true, detail: '该版本无 personas 接口' }
      if (res.status >= 500) return { ok: false, detail: `AstrBot 异常 HTTP ${res.status}` }
      return { ok: true, detail: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, detail: err?.message || String(err) }
    }
  }

  async *chat({ text, sessionId, signal }) {
    const controller = new AbortController()
    this.controller = controller
    const onOuterAbort = () => controller.abort()
    signal?.addEventListener('abort', onOuterAbort, { once: true })

    let full = ''
    let streamed = ''
    let clean = ''
    const noise = new ToolNoiseFilter()
    try {
      const res = await fetch(`${this.url}/api/v1/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          username: USERNAME,
          session_id: sessionId,
          message: [{ type: 'plain', text }],
          enable_streaming: true,
          ...(this.configName ? { config_name: this.configName } : {}),
        }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        yield { t: 'error', message: `AstrBot HTTP ${res.status}${detail ? `：${detail.slice(0, 120)}` : ''}` }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let pending = []
      const tools = []
      let toldTool = false
      const handleData = (raw) => {
        const payload = raw.trim()
        if (!payload || payload === '[DONE]') return
        let obj
        try {
          obj = JSON.parse(payload)
        } catch {
          streamed += payload
          pending.push(payload)
          return
        }
        // 这个版本会把「内心戏」标成 chain_type: 'reasoning'（实测 39 段 reasoning + 15 段正文）
        if (obj.type === 'plain' && obj.chain_type === 'reasoning') return
        const parsed = textFromEvent(obj)
        if (parsed.kind === 'final') {
          if (parsed.text) clean = parsed.text
        } else if (parsed.kind === 'delta' && parsed.text) {
          streamed += parsed.text
          // 工具调用的 JSON 不上屏，但「她这次搜没搜」要记一笔
          if (!toldTool) {
            const m = /"name"\s*:\s*"([A-Za-z0-9_]*search[A-Za-z0-9_]*)"/.exec(parsed.text)
            if (m) {
              toldTool = true
              tools.push(m[1])
            }
          }
          const kept = noise.feed(parsed.text)
          if (kept) pending.push(kept)
        }
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (line.startsWith('data:')) handleData(line.slice(5))
          nl = buf.indexOf('\n')
        }
        // 边收边吐：首字 latency 从「等 complete」的 ~1.7s 回到 ~1.1s
        if (pending.length) {
          const out = pending.join('')
          pending = []
          full += out
          yield { t: 'delta', text: out }
        }
      }
      if (buf.startsWith('data:')) handleData(buf.slice(5))
      if (pending.length) {
        const out = pending.join('')
        pending = []
        full += out
        yield { t: 'delta', text: out }
      }

      // complete 是服务端认定的整句：和流里拼出来的不一致时以它为准，末尾用 done 覆盖一次
      // <ref>1.2</ref> 是服务端的检索引用标记，不是台词（上屏/落盘/TTS 都不要）
      const text2 = noise
        .feed(clean || stripLeadingReasoning(streamed))
        .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
        .replace(/<\/?(?:sup|cite|ref)[^>]*>/gi, '')
        .trim()
      if (!text2) {
        yield { t: 'done', full: '' }
        return
      }
      if (tools.length) yield { t: 'tool', names: tools.slice() }
      if (text2 !== full.trim()) {
        // 已经流出去的内容可能多了/少了：交给渲染层用 done 里的全文替换
        full = text2
        yield { t: 'done', full }
        return
      }
      yield { t: 'done', full }
    } catch (err) {
      if (controller.signal.aborted) {
        yield { t: 'done', full }
        return
      }
      yield { t: 'error', message: `连不上 AstrBot（${this.url}）：${err?.message || err}` }
    } finally {
      signal?.removeEventListener('abort', onOuterAbort)
      if (this.controller === controller) this.controller = null
    }
  }

  interrupt() {
    this.controller?.abort()
    this.controller = null
  }
}
