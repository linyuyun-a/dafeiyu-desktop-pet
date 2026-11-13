import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * M1 的"外壳"：托盘、原生拖动、点击穿透、位置记忆、全局快捷键。
 *
 * 为什么拖动不用 `-webkit-app-region: drag`：它会把鼠标事件从渲染层吞掉，
 * Live2D 的 hit 判定（摸头/戳身体）就全废了。这里改成渲染层报 pointerdown，
 * 主进程用 `screen.getCursorScreenPoint()` 轮询跟随 —— 指针移出窗口也不会断，
 * 这是无边框透明窗口里最稳的做法。
 */

interface ShellOptions {
  projectRoot: string
  getWin: () => BrowserWindow | null
}

interface WindowState {
  x?: number
  y?: number
  zoom?: number
}

const DRAG_INTERVAL = 16

export function installShell({ projectRoot, getWin }: ShellOptions): void {
  const stateFile = join(app.getPath('userData'), 'window.json')
  const readState = (): WindowState => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8')) as WindowState
    } catch {
      return {}
    }
  }
  const writeState = (patch: WindowState): void => {
    try {
      writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch }, null, 2))
    } catch (err) {
      console.warn('[shell] 保存窗口状态失败:', err)
    }
  }

  // ── 原生拖动 ──────────────────────────────────────────────────────────────
  let dragTimer: NodeJS.Timeout | null = null
  let dragOffset = { x: 0, y: 0 }

  const stopDrag = (): void => {
    if (dragTimer) {
      clearInterval(dragTimer)
      dragTimer = null
      const w = getWin()
      if (w && !w.isDestroyed()) {
        const b = w.getBounds()
        writeState({ x: b.x, y: b.y })
      }
    }
  }

  ipcMain.handle('pet:drag-start', (_e, anchorX?: number, anchorY?: number) => {
    const w = getWin()
    if (!w || w.isDestroyed() || dragTimer) return false
    const b = w.getBounds()
    const c = screen.getCursorScreenPoint()
    // 用"按下那一刻的指针位置"算偏移：等到移动超过阈值才开始拖时，
    // 指针已经偏了几像素，用当前指针会把窗口拽一下。
    const ax = typeof anchorX === 'number' ? anchorX : c.x
    const ay = typeof anchorY === 'number' ? anchorY : c.y
    // 整数化：Electron 的 setPosition 只吃整数，传小数会抛
    // "Error processing argument at index 1, conversion failure from 585.14"（DIP 缩放会带小数）
    dragOffset = { x: Math.round(ax) - b.x, y: Math.round(ay) - b.y }
    // 尺寸在拖拽期间钉死：frameless 透明窗口每搬一次位置会被系统按 DPI 微调
    // 尺寸（实测每次 move +1px），只改位置会「越拖越大」。
    const size = { width: b.width, height: b.height }
    dragTimer = setInterval(() => {
      const win = getWin()
      if (!win || win.isDestroyed()) return stopDrag()
      const p = screen.getCursorScreenPoint()
      const nx = Math.round(p.x - dragOffset.x)
      const ny = Math.round(p.y - dragOffset.y)
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return
      const cur = win.getBounds()
      if (cur.x === nx && cur.y === ny) return
      try {
        win.setBounds({ x: nx, y: ny, width: size.width, height: size.height }, false)
      } catch (err) {
        console.warn('[drag] setBounds 失败', nx, ny, err)
      }
    }, DRAG_INTERVAL)
    return true
  })

  ipcMain.handle('pet:drag-end', () => {
    stopDrag()
    return true
  })

  // ── 位置记忆 ──────────────────────────────────────────────────────────────
  ipcMain.handle('pet:get-window-state', () => readState())
  ipcMain.handle('pet:save-window-state', (_e, patch: WindowState) => {
    writeState(patch ?? {})
    return true
  })

  // ── 点击穿透 ──────────────────────────────────────────────────────────────
  let clickThrough = false
  const applyClickThrough = (next: boolean): boolean => {
    const w = getWin()
    if (!w || w.isDestroyed()) return false
    clickThrough = next
    w.setIgnoreMouseEvents(next, { forward: true })
    w.webContents.send('pet:click-through', next)
    return true
  }
  ipcMain.handle('pet:set-click-through', (_e, next: boolean) => applyClickThrough(Boolean(next)))
  ipcMain.handle('pet:get-click-through', () => clickThrough)

  // ── 托盘 ──────────────────────────────────────────────────────────────────
  let tray: Tray | null = null
  const toggleVisible = (): void => {
    const w = getWin()
    if (!w || w.isDestroyed()) return
    if (w.isVisible()) w.hide()
    else {
      w.showInactive()
      w.setAlwaysOnTop(true, 'floating')
    }
    refreshMenu()
  }

  const sendZoom = (zoom: number): void => {
    writeState({ zoom })
    getWin()?.webContents.send('pet:set-zoom', zoom)
  }

  const refreshMenu = (): void => {
    if (!tray) return
    const w = getWin()
    const visible = Boolean(w && !w.isDestroyed() && w.isVisible())
    const menu = Menu.buildFromTemplate([
      { label: visible ? '隐藏她' : '显示她', click: toggleVisible },
      { type: 'separator' },
      {
        label: '大小',
        submenu: [
          { label: '小（0.7×）', click: () => sendZoom(0.7) },
          { label: '中（1×）', click: () => sendZoom(1) },
          { label: '大（1.5×）', click: () => sendZoom(1.5) }
        ]
      },
      {
        label: '点击穿透（她只负责站着）',
        type: 'checkbox',
        checked: clickThrough,
        click: (item) => applyClickThrough(item.checked)
      },
      {
        label: '总在最前',
        type: 'checkbox',
        checked: Boolean(w && !w.isDestroyed() && w.isAlwaysOnTop()),
        click: (item) => {
          const win = getWin()
          if (win && !win.isDestroyed()) win.setAlwaysOnTop(item.checked, 'floating')
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
    tray.setContextMenu(menu)
    tray.setToolTip(visible ? 'DeepSeek 桌宠 · 在屏幕上' : 'DeepSeek 桌宠 · 已隐藏')
  }

  const createTray = (): void => {
    const iconPath = join(projectRoot, 'resources', 'tray.png')
    if (!existsSync(iconPath)) {
      console.warn('[shell] 缺托盘图标，跳过托盘:', iconPath)
      return
    }
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }))
    tray.on('click', toggleVisible)
    refreshMenu()
    console.log('[shell] 托盘已创建')
  }

  createTray()

  // ── 全局快捷键 ───────────────────────────────────────────────────────────
  const ok = globalShortcut.register('Control+Alt+P', toggleVisible)
  if (!ok) console.warn('[shell] Ctrl+Alt+P 注册失败（可能被别的程序占用）')

  app.on('will-quit', () => {
    stopDrag()
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
  })

  // 拖完/挪完顺手记一下位置
  app.on('browser-window-created', (_e, w) => {
    w.on('moved', () => {
      const b = w.getBounds()
      writeState({ x: b.x, y: b.y })
    })
  })
}
