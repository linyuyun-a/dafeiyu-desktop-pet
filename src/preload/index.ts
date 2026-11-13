import { contextBridge, ipcRenderer } from 'electron'

const api = {
  quit: () => ipcRenderer.invoke('pet:quit'),
  info: () => ipcRenderer.invoke('pet:info'),
  savePng: (dataUrl: string, name: string) => ipcRenderer.invoke('pet:save-png', dataUrl, name),
  log: (msg: string) => ipcRenderer.invoke('pet:log', msg),
  /** 按角色宽高比 × 目标身高改窗口大小（锚点 = 脚底中心） */
  setSize: (aspect: number, height: number) => ipcRenderer.invoke('pet:set-size', aspect, height),

  // ── M1：外壳（拖动 / 托盘 / 穿透 / 位置记忆） ───────────────────────────
  dragStart: (anchorX?: number, anchorY?: number) => ipcRenderer.invoke('pet:drag-start', anchorX, anchorY),
  dragEnd: () => ipcRenderer.invoke('pet:drag-end'),
  getWindowState: () => ipcRenderer.invoke('pet:get-window-state'),
  saveWindowState: (patch: { x?: number; y?: number; zoom?: number }) => ipcRenderer.invoke('pet:save-window-state', patch),
  setClickThrough: (next: boolean) => ipcRenderer.invoke('pet:set-click-through', next),
  getClickThrough: () => ipcRenderer.invoke('pet:get-click-through'),

  /** 原生右键菜单：菜单树交给主进程，返回点中的 id（点外面/取消 = null） */
  menu: (spec: unknown) => ipcRenderer.invoke('pet:menu', spec),

  // ── M2：聊天 ──────────────────────────────────────────────────────────
  chat: (text: string) => ipcRenderer.invoke('pet:chat', text),
  interrupt: () => ipcRenderer.invoke('pet:interrupt'),
  brainInfo: () => ipcRenderer.invoke('pet:brain-info'),
  chatHistory: (limit?: number) => ipcRenderer.invoke('pet:chat-history', limit ?? 20),

  /** 托盘/快捷键发来的缩放指令 */
  onSetZoom: (cb: (zoom: number) => void) => {
    const handler = (_e: unknown, zoom: number): void => cb(zoom)
    ipcRenderer.on('pet:set-zoom', handler)
    return () => ipcRenderer.off('pet:set-zoom', handler)
  },
  /** 穿透状态变化（托盘勾选时通知渲染层收起面板） */
  onClickThrough: (cb: (on: boolean) => void) => {
    const handler = (_e: unknown, on: boolean): void => cb(on)
    ipcRenderer.on('pet:click-through', handler)
    return () => ipcRenderer.off('pet:click-through', handler)
  },
  /** 大脑流式事件：delta / done / error / state */
  onChatEvent: (cb: (ev: unknown) => void) => {
    const handler = (_e: unknown, ev: unknown): void => cb(ev)
    ipcRenderer.on('pet:chat-event', handler)
    return () => ipcRenderer.off('pet:chat-event', handler)
  },
  /** 系统状态：锁屏 / 解锁 / 长时间无输入（电源与空闲由主进程 powerMonitor 提供） */
  onSystem: (cb: (kind: 'idle' | 'active' | 'lock' | 'unlock') => void) => {
    const handler = (_e: unknown, kind: 'idle' | 'active' | 'lock' | 'unlock'): void => cb(kind)
    ipcRenderer.on('pet:system', handler)
    return () => ipcRenderer.off('pet:system', handler)
  },
  /** 大脑切换（平台起来了 / 掉线回落 mock） */
  onBrainChanged: (cb: (info: { id: string }) => void) => {
    const handler = (_e: unknown, info: { id: string }): void => cb(info)
    ipcRenderer.on('pet:brain-changed', handler)
    return () => ipcRenderer.off('pet:brain-changed', handler)
  }
}

contextBridge.exposeInMainWorld('pet', api)

export type PetApi = typeof api
