export interface PetInfo {
  assetsDir: string
  electron: string
  chrome: string
  node: string
  packaged: boolean
}

export interface PetWindowSize {
  width: number
  height: number
  x: number
  y: number
}

export interface PetWindowState {
  x?: number
  y?: number
  zoom?: number
}

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

/** 主进程推给渲染层的大脑海事件 */
export type ChatEvent =
  | { t: 'delta'; text: string }
  | { t: 'segment'; text: string }
  | { t: 'emotion'; emotion: EmotionId }
  | { t: 'motion'; group: string; no?: number }
  | { t: 'done'; full: string }
  | { t: 'error'; message: string; recoverable: boolean }
  | { t: 'state'; v: 'thinking' | 'speaking' | 'idle' | 'interrupted' }

export interface PetBrainInfo {
  id: 'platform' | 'astrbot' | 'mock'
  capabilities: { stream: boolean; memory: boolean; tools: boolean; proactive: boolean }
  sessionId: string
}

export interface PetApi {
  quit: () => Promise<void>
  info: () => Promise<PetInfo>
  savePng: (dataUrl: string, name: string) => Promise<string>
  log: (msg: string) => Promise<void>
  setSize: (aspect: number, height: number) => Promise<PetWindowSize | null>

  dragStart: (anchorX?: number, anchorY?: number) => Promise<boolean>
  dragEnd: () => Promise<boolean>
  getWindowState: () => Promise<PetWindowState>
  saveWindowState: (patch: PetWindowState) => Promise<boolean>
  setClickThrough: (next: boolean) => Promise<boolean>
  getClickThrough: () => Promise<boolean>
  onSetZoom: (cb: (zoom: number) => void) => () => void
  onClickThrough: (cb: (on: boolean) => void) => () => void

  chat: (text: string) => Promise<{ ok: boolean; full?: string; reason?: string }>
  /** 弹出原生右键菜单，resolve 用户点中的 id；点外面/取消 = null */
  menu: (spec: unknown) => Promise<string | null>
  interrupt: () => Promise<boolean>
  brainInfo: () => Promise<PetBrainInfo>
  /** 最近 N 条聊天（自检/调试用） */
  chatHistory: (limit?: number) => Promise<Array<{ role: string; text: string; at: number }>>
  onChatEvent: (cb: (ev: ChatEvent) => void) => () => void
  /** 系统状态：锁屏 / 解锁 / 长时间无输入 */
  onSystem: (cb: (kind: 'idle' | 'active' | 'lock' | 'unlock') => void) => () => void
  onBrainChanged: (cb: (info: { id: string }) => void) => () => void
}

declare global {
  interface Window {
    pet: PetApi
  }
}

export {}
