/**
 * 大脑适配器的公共契约（规划 §5.1）。
 *
 * 纪律：人格、记忆、工具全在平台侧，桌宠这边只负责"把话变成表情和动作"。
 * 所以这里只有流式文本 + 少量元事件，不塞业务。
 */

export type EmotionId =
  | 'neutral'
  | 'happy'
  | 'love'
  | 'shy'
  | 'sad'
  | 'annoyed'
  | 'confused'
  | 'thinking'
  | 'surprised'
  | 'focus'
  | 'proud'
  | 'guard'

export type BrainEvent =
  | { t: 'delta'; text: string }
  | { t: 'segment'; text: string }
  | { t: 'emotion'; emotion: EmotionId }
  | { t: 'motion'; group: string; no?: number }
  | { t: 'done'; full: string }
  | { t: 'error'; message: string; recoverable: boolean }

export interface BrainCapabilities {
  stream: boolean
  memory: boolean
  tools: boolean
  proactive: boolean
}

export interface BrainAdapter {
  readonly id: 'platform' | 'astrbot' | 'mock'
  capabilities: BrainCapabilities
  health(): Promise<{ ok: boolean; detail?: string }>
  chat(req: { text: string; sessionId: string; signal?: AbortSignal }): AsyncIterable<BrainEvent>
  interrupt(): void
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
