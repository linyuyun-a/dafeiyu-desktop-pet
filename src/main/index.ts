import { app, BrowserWindow, ipcMain, Menu, powerMonitor, protocol, screen, session } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installShell } from './shell'
import { pickBrain, loadBrainConfig, MockBrain, type BrainAdapter, type BrainEvent } from './brain'
import { appendChat, getConversationId, readChat } from './chat'

const dirname = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolve(dirname, '../..')

// 桌面快捷方式/DLL 宿主启动时，stdout 可能连着一个已经关掉的管道；这时
// 任何 console.log 都会抛 EPIPE，把主进程整个带崩（弹窗 "A JavaScript error occurred"）。
// 桌宠的日志丢了无所谓，进程不能死。
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', () => {})
}

// Chromium 默认把 profile 写到 %APPDATA%\deepseek-pet。这个目录一旦被沙箱或别的进程
// 抢先建出来，ACL 会变成"只读/只给某个组"，之后每次启动都报
// `Lock file can not be created: 拒绝访问 (0x5)`，然后主进程静默退出（不弹窗、不报错）。
// 所以把 profile 固定放在工程自己的 _data/ 下，跟着应用走，也不怕中文用户名。
const userDataDir = join(projectRoot, '_data', 'profile')
mkdirSync(userDataDir, { recursive: true })
app.setPath('userData', userDataDir)
app.setPath('sessionData', userDataDir)

// 从快捷方式启动时没有可见控制台，出问题只能靠文件留痕：把 console 输出再写一份到
// _data/main.log（超过 512KB 轮转一次）。这样"双击后什么都没发生"至少能查。
const LOG_PATH = join(projectRoot, '_data', 'main.log')
try {
  if (statSync(LOG_PATH).size > 512 * 1024) renameSync(LOG_PATH, LOG_PATH + '.1')
} catch {}
for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    original(...args)
    try {
      const line = args
        .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : String(a)))
        .join(' ')
      appendFileSync(LOG_PATH, `${new Date().toISOString()} [${level}] ${line}\n`)
    } catch {}
  }
}
console.log('[main] boot', process.argv.slice(1).join(' '))

/** 与 renderer 约定的窗口尺寸（透明画布，桌宠本体） */
const WIN_W = 460
const WIN_H = 780

/** 素材根目录：dev 用工程里的 assets/，打包后走 extraResources */
const assetsDir = app.isPackaged ? join(process.resourcesPath, 'assets') : join(projectRoot, 'assets')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
}

// 必须在 app ready 之前声明
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
])

let win: BrowserWindow | null = null

/** 当前大脑：ready 时探测平台，连不上就先 mock */
let brain: BrainAdapter = new MockBrain()
let chatBusy = false
let chatAborted = false

type ChatStateEvent = { t: 'state'; v: 'thinking' | 'speaking' | 'idle' | 'interrupted' }
function sendChatEvent(ev: BrainEvent | ChatStateEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('pet:chat-event', ev)
}

/** 上次的窗口位置（shell.ts 写的 window.json），读不到就返回 null */
function readSavedPosition(): { x?: number; y?: number } | null {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'window.json'), 'utf8')
    const v = JSON.parse(raw) as { x?: number; y?: number }
    return typeof v.x === 'number' && typeof v.y === 'number' ? v : null
  } catch {
    return null
  }
}

function createWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea

  // 上次拖到哪里，这次就站哪里（落在屏幕外则回落到右下角）
  const saved = readSavedPosition()
  const inScreen =
    saved && saved.x! > x - WIN_W / 2 && saved.x! < x + width - WIN_W / 2 && saved.y! > y - WIN_H / 2 && saved.y! < y + height - WIN_H / 2

  const w = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: inScreen ? saved!.x! : x + width - WIN_W - 24,
    y: inScreen ? saved!.y! : y + height - WIN_H - 4,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    title: 'DeepSeek Pet',
    webPreferences: {
      preload: join(dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webgl: true
    }
  })

  w.setAlwaysOnTop(true, 'floating')
  w.setMenuBarVisibility(false)

  w.once('ready-to-show', () => {
    w.showInactive()
    w.setAlwaysOnTop(true, 'floating')
  })


  w.on('closed', () => {
    win = null
  })

  w.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] render-process-gone:', JSON.stringify(details))
  })
  // Electron 36+ 传事件对象，旧版传 (event, level, message, line, sourceId)，两种都兜住
  w.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: unknown; message?: unknown; lineNumber?: number; sourceId?: string }
    const level = typeof first?.level === 'string' ? first.level : typeof args[1] === 'string' ? args[1] : 'info'
    const message = typeof first?.message === 'string' ? first.message : String(args[2] ?? '')
    const where = first?.sourceId ?? String(args[4] ?? '')
    const line = first?.lineNumber ?? Number(args[3] ?? 0)
    if (level === 'error' || level === 'warning') {
      console.error(`[renderer:${level}] ${message} (${where}:${line})`)
    } else {
      console.log(`[renderer] ${message}`)
    }
  })

  // 开发期快捷键：Ctrl+Shift+Q 退出、F12 开控制台
  w.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    if (input.control && input.shift && input.key.toLowerCase() === 'q') app.quit()
    if (input.key === 'F12') w.webContents.toggleDevTools()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  // shot=一张截图；check=M0 验收自检（每个动作/表情各存一张图）
  const query: Record<string, string> = {}
  if (process.env['PET_SHOT']) query['shot'] = '1'
  if (process.env['PET_CHECK']) query['check'] = '1'
  if (process.env['PET_ZOOM']) query['zoom'] = process.env['PET_ZOOM']
  if (process.env['PET_FPS']) query['fps'] = process.env['PET_FPS']
  if (process.env['PET_CHAT']) query['chat'] = '1'
  if (process.env['PET_MARKS']) query['marks'] = '1'
  if (process.env['PET_M3CHECK']) query['m3check'] = '1'
  if (process.env['PET_CHATCHECK']) query['chatcheck'] = '1'
  if (process.env['PET_TRIGCHECK']) query['trigcheck'] = '1'
  if (process.env['PET_SEMCHECK']) query['semcheck'] = '1'
  if (process.env['PET_PROCHECK']) query['procheck'] = '1'
  if (process.env['PET_ALIVECHECK']) query['alivecheck'] = '1'
  // 分区自测：对着每个身体分区的中心发合成点击，看反应是不是对得上
  if (process.env['PET_ZONETEST']) query['zonetest'] = '1'
  // 姿势勘察：把一小段 JSON 传进渲染层，摆好姿势截一张图（造动作前靠它校准数值）
  if (process.env['PET_POSE']) {
    query['pose'] = process.env['PET_POSE']
    // 拍照勘察必须关掉生命层：呼吸/眨眼会让每张都不一样，逐像素对比就定位不到"改了哪里"
    query['alive'] = '0'
    query['proactive'] = '0'
  }
  if (process.env['PET_SAY']) query['say'] = process.env['PET_SAY']
  const qs = new URLSearchParams(query).toString()
  if (devUrl) {
    void w.loadURL(qs ? `${devUrl}?${qs}` : devUrl)
  } else {
    void w.loadFile(join(dirname, '../renderer/index.html'), qs ? { query } : undefined)
  }

  return w
}

/** pet://assets/model/model3.json → <assetsDir>/model/model3.json */
function registerAssetProtocol(): void {
  protocol.handle('pet', async (request) => {
    try {
      const url = new URL(request.url)
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const target = normalize(join(assetsDir, rel))
      if (!target.startsWith(normalize(assetsDir + sep))) {
        return new Response('forbidden', { status: 403 })
      }
      const data = await readFile(target)
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
          // 纹理/JSON 从 pet:// 跨源加载，必须放行
          'access-control-allow-origin': '*'
        }
      })
    } catch (err) {
      console.error('[main] pet:// 失败', request.url, err)
      return new Response('not found', { status: 404 })
    }
  })
}

function registerIpc(): void {
  ipcMain.handle('pet:quit', () => {
    app.quit()
  })

  ipcMain.handle('pet:info', () => ({
    assetsDir,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged
  }))

  // 渲染进程把 canvas 的 PNG 交上来落盘（spike 用：肉眼验收模型/透明）
  ipcMain.handle('pet:save-png', async (_e, dataUrl: string, name: string) => {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    const outDir = join(projectRoot, '_probe')
    await mkdir(outDir, { recursive: true })
    const file = join(outDir, name.replace(/[^\w.-]/g, '_'))
    await writeFile(file, Buffer.from(base64, 'base64'))
    console.log('[main] 已保存', file)
    return file
  })

  ipcMain.handle('pet:log', (_e, msg: string) => {
    console.log(`[probe] ${msg}`)
  })

  // ── 原生右键菜单 ──────────────────────────────────────────────────────
  // 渲染层把整棵菜单树序列化过来（纯数据），这里翻译成 Electron 的 MenuTemplate。
  // 点击某一项就 resolve 它的 id；菜单在任何地方关掉（点外面/ESC）都 resolve null，
  // 这样渲染层的 await 永远不会悬着。
  ipcMain.handle('pet:menu', async (e, spec: unknown): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    return await new Promise<string | null>((resolve) => {
      let settled = false
      const done = (value: string | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const build = (nodes: unknown): MenuItemConstructorOptions[] => {
        if (!Array.isArray(nodes)) return []
        return nodes.map((raw): MenuItemConstructorOptions => {
          const node = (raw ?? {}) as {
            id?: string
            label?: string
            type?: string
            checked?: boolean
            enabled?: boolean
            children?: unknown
          }
          if (node.type === 'separator') return { type: 'separator' }
          const item: MenuItemConstructorOptions = {
            label: node.label ?? '',
            enabled: node.enabled !== false
          }
          if (node.type === 'checkbox') {
            item.type = 'checkbox'
            item.checked = Boolean(node.checked)
          }
          if (Array.isArray(node.children) && node.children.length > 0) {
            item.submenu = build(node.children)
            // 带子菜单的项只负责展开，不产生选择
            return item
          }
          const id = node.id ?? null
          item.click = () => done(id)
          // 勾选项即使被点掉也要先回传 id，渲染层再翻转自己的状态
          return item
        })
      }
      const menu = Menu.buildFromTemplate(build(spec))
      // Windows 上置顶窗口会把原生菜单盖住（菜单是独立 HWND，层级比 alwaysOnTop 低）。
      // 弹之前临时关掉置顶，关掉菜单再恢复——这是 BongoCat 那套桌宠的既有做法。
      const wasOnTop = win.isAlwaysOnTop()
      if (wasOnTop) win.setAlwaysOnTop(false)
      menu.popup({
        window: win,
        callback: () => {
          if (wasOnTop) win.setAlwaysOnTop(true)
          done(null)
        }
      })
    })
  })

  // ── M2：聊天（大脑 → 流式事件 → 渲染层气泡） ───────────────────────────
  ipcMain.handle('pet:chat', async (_e, text: string) => {
    const clean = String(text ?? '').trim()
    if (!clean) return { ok: false, reason: 'empty' }
    if (chatBusy) return { ok: false, reason: 'busy' }

    chatBusy = true
    chatAborted = false
    const sessionId = getConversationId()
    appendChat({ role: 'user', text: clean })
    sendChatEvent({ t: 'state', v: 'thinking' })

    let full = ''
    let sawFirstDelta = false
    try {
      for await (const ev of brain.chat({ text: clean, sessionId })) {
        if (chatAborted) break
        if (ev.t === 'delta') {
          if (!sawFirstDelta) {
            sawFirstDelta = true
            sendChatEvent({ t: 'state', v: 'speaking' })
          }
          full += ev.text
        } else if (ev.t === 'done' && ev.full) {
          full = ev.full
        }
        console.log('[chat] event', ev.t)
        sendChatEvent(ev)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[chat] 对话出错:', message)
      sendChatEvent({ t: 'error', message, recoverable: true })
    } finally {
      if (full.trim()) appendChat({ role: 'pet', text: full })
      chatBusy = false
      sendChatEvent({ t: 'state', v: chatAborted ? 'interrupted' : 'idle' })
    }
    return { ok: true, full }
  })

  ipcMain.handle('pet:interrupt', () => {
    if (!chatBusy) return false
    chatAborted = true
    brain.interrupt()
    return true
  })

  ipcMain.handle('pet:chat-history', (_e, limit: number) => readChat(Number(limit) || 20))

  ipcMain.handle('pet:brain-info', () => ({
    id: brain.id,
    capabilities: brain.capabilities,
    sessionId: getConversationId()
  }))

  /**
   * 缩放：渲染进程量出角色宽高比后，要求主进程把窗口改成"这个比例 × 目标身高"。
   * 以「脚底中心」为锚点扩缩 —— 缩放时她站的位置不动，不会在屏幕上乱跳。
   */
  ipcMain.handle('pet:set-size', (_e, aspect: number, height: number) => {
    if (!win || win.isDestroyed()) return null
    const bounds = win.getBounds()
    const work = screen.getDisplayMatching(bounds).workArea
    const h = Math.round(Math.min(Math.max(height, 180), work.height * 0.95))
    const w = Math.round(Math.min(Math.max(h * aspect, 100), work.width * 0.8))
    const x = Math.round(bounds.x + bounds.width / 2 - w / 2)
    const y = Math.round(bounds.y + bounds.height - h)
    win.setBounds({ x, y, width: w, height: h })
    return { width: w, height: h, x, y }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    win?.showInactive()
  })

  app.whenReady().then(() => {
    registerAssetProtocol()
    registerIpc()

    // 目前不需要麦克风等权限，一律拒绝（M5 语音再放开）
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      console.log('[main] 权限请求被拒绝:', permission)
      callback(false)
    })

    const brainConfig = loadBrainConfig(projectRoot)
    void pickBrain(brainConfig).then((b) => {
      brain = b
      console.log('[main] brain =', b.id)
      if (win && !win.isDestroyed()) win.webContents.send('pet:brain-changed', { id: b.id })
    })

    win = createWindow()
    installShell({ projectRoot, getWin: () => win })
    installSystemSignals()

    // 性能采样：PET_PERF=1 时每 2s 打印一次各进程 CPU/内存（Electron 自带指标，比外部工具准）
    if (process.env['PET_PERF']) {
      let samples = 0
      const timer = setInterval(() => {
        samples++
        const metrics = app.getAppMetrics()
        const parts = metrics.map((m) => {
          const cpu = Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10
          const ws = Math.round((m.memory?.workingSetSize ?? 0) / 1024)
          return `${m.type}#${m.pid} cpu=${cpu}% ws=${ws}MB`
        })
        const totalCpu = metrics.reduce((sum, m) => sum + (m.cpu?.percentCPUUsage ?? 0), 0)
        console.log(`[perf] ${parts.join(' | ')} | total=${Math.round(totalCpu * 10) / 10}%`)
        if (samples >= 5) {
          clearInterval(timer)
          app.quit()
        }
      }, 2000)
    }

    // 自动化验收：PET_CAPTURE=1 时 6 秒后截图落盘
    if (process.env['PET_CAPTURE']) {
      setTimeout(async () => {
        if (!win || win.isDestroyed()) return
        try {
          const img = await win.webContents.capturePage()
          const outDir = join(projectRoot, '_probe')
          await mkdir(outDir, { recursive: true })
          const file = join(outDir, 'window-capture.png')
          await writeFile(file, img.toPNG())
          console.log('[main] 窗口截图已保存', file)
          app.quit()
        } catch (err) {
          console.error('[main] 截图失败', err)
        }
      }, Number(process.env['PET_CAPTURE_MS'] ?? 6000))
    }

    /**
   * 系统信号：锁屏 / 解锁 / 长时间无键盘鼠标。
   * 桌宠的"触发源"不该只有鼠标——她自己要能察觉你离开、回来、熬夜。
   * 空闲用轮询（powerMonitor.getSystemIdleTime 没有事件），锁屏用事件。
   */
  function installSystemSignals(): void {
    const send = (kind: string): void => {
      if (win && !win.isDestroyed()) win.webContents.send('pet:system', kind)
    }
    powerMonitor.on('lock-screen', () => send('lock'))
    powerMonitor.on('unlock-screen', () => send('unlock'))
    let idle = false
    setInterval(() => {
      const secs = powerMonitor.getSystemIdleTime()
      if (secs >= 180 && !idle) {
        idle = true
        send('idle')
      } else if (secs < 20 && idle) {
        idle = false
        send('active')
      }
    }, 20000)
  }

  app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
