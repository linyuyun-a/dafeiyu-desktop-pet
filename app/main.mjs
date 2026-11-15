// Live2D Stage —— Electron 主进程。
//
// 形态：**无边框 / 透明 / 贴角色的独立软件**（不是嵌在 DSH 里）。
//   - 内置同一个静态服务（src/server/stage-server.mjs），窗口加载 http://127.0.0.1:<port>/app/
//   - 窗口尺寸 A 与模型尺寸 B 分离：A 改窗口大小，B 只改模型缩放（渲染层 zoom），互不牵连
//   - 穿透模式：win.setIgnoreMouseEvents(true, { forward: true })，用全局快捷键 Ctrl+Alt+L 找回
//   - 退出：Ctrl+Alt+Q（穿透态下也能用）
import { app, BrowserWindow, ipcMain, globalShortcut, shell, screen, dialog, Menu, powerMonitor, session } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync, appendFileSync, statSync, renameSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createStageServer } from '../src/server/stage-server.mjs'
import { loadBrainConfig } from './brain/config.mjs'
import { pickBrain, brainInfo } from './brain/index.mjs'
import { createChatStore } from './brain/store.mjs'
import { createWorkLink } from './worklink.mjs'
import { readHistory } from './brain/history.mjs'
import { createProactive, FREQUENCY } from './proactive.mjs'
import { describeLook } from './look.mjs'
import * as ncm from './music.mjs'

// 控制台管道断开时（从终端/脚本启动后终端关闭）console.log 会抛 EPIPE，
// 不接住会弹「A JavaScript error occurred in the main process」并崩溃。
for (const s of [process.stdout, process.stderr]) {
  try { s.on('error', (e) => { if (e && e.code === 'EPIPE') return }) } catch {}
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 便携/测试：STAGE_HOME 覆盖用户数据目录（设置文件跟着走，可做干净环境）
if (process.env.STAGE_HOME) { try { mkdirSync(process.env.STAGE_HOME, { recursive: true }); app.setPath('userData', process.env.STAGE_HOME) } catch {} }
// 启动参数：--model "路径\model3.json"（自动化安装 / 快捷方式用）
const ARG_MODEL = (() => { const i = process.argv.indexOf('--model'); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null })()
// 模型目录：放在 exe 旁边的 model/（完整版内置；发布版用户把自己的模型丢进去即可，不用配绝对路径）
// 不再内置任何开发机绝对路径：开发时用设置里的路径 / --model / STAGE_MODEL 即可
// 打包版不要和开发版共用一个 userData：两者都 requestSingleInstanceLock，
// 撞在一起时后者会因锁文件权限/占用直接退出（用户看到的就是「双击没反应」）。
if (app.isPackaged) {
  try {
    const home = path.join(app.getPath('appData'), '大肥鱼Live2d桌宠')
    // 目录必须先建出来：Chromium 的 process_singleton 会在 ready 之前写锁文件，
    // 目录不存在时直接失败（Error code: 3 / 5），表现就是双击没反应。
    mkdirSync(home, { recursive: true })
    app.setPath('userData', home)
  } catch {}
}
// 打包版强制关掉 Chromium 沙箱：这台机器上带沙箱启动会在 ready 之前静默退出
// （连 userData 都不建、一行日志都没有），用户看到的就是「点了运行没反应」。
// 桌宠是本机自用软件、不加载外部网页，关沙箱的收益远大于风险。
if (app.isPackaged) {
  try { app.commandLine.appendSwitch('no-sandbox') } catch {}
  try { app.commandLine.appendSwitch('disable-gpu-sandbox') } catch {}
}
const EXE_DIR = path.dirname(app.getPath('exe'))
const MODEL_DIRS = [path.join(EXE_DIR, 'model'), path.join(ROOT, 'model')]

// 最早期落盘：万一在 ready 之前就挂了，userData 里的日志一行都不会有。
// 这份固定写到临时目录，双击后无论成没成，都能看到程序到底跑到哪一步。
try {
  const early = path.join(os.tmpdir(), 'dafeiyu-boot.txt')
  appendFileSync(early, `${new Date().toISOString()} boot argv=${JSON.stringify(process.argv)} packaged=${app.isPackaged} exe=${process.execPath}
`)
} catch {}
process.on('uncaughtException', (e) => {
  try { appendFileSync(path.join(os.tmpdir(), 'dafeiyu-boot.txt'), `${new Date().toISOString()} uncaught=${e && e.stack}
`) } catch {}
})

// ---------- 启动日志：出问题时至少有一份能发回去的文件 ----------
// 「下载后打不开」这类反馈，没有日志只能靠猜；有日志一眼能看出卡在哪一步。
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'main.log')
function flog(...a) {
  const line = `[${new Date().toISOString()}] ${a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')}`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const st = statSafe(LOG_FILE)
    if (st && st.size > 1024 * 1024) renameSync(LOG_FILE, path.join(LOG_DIR, 'main.old.log'))
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
  try { console.log(line) } catch {}
}
// ---------- 大脑（人格/记忆在云端 AstrBot）----------
let brain = null
let brainState = { ok: false, detail: '还没连' }
let chatStore = null
let moodFile = ''
let chatStreaming = null
let chatSeq = 0
// ---------- 语音（本地 TTS 服务：app/tts/server.py）----------
const TTS_URL = process.env.PET_TTS_URL || 'http://127.0.0.1:8769'
let ttsChild = null
let ttsState = 'idle'   // idle | starting | ready | off | failed

async function ttsHealth(base = TTS_URL, timeoutMs = 1500) {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), timeoutMs)
    const r = await fetch(String(base).replace(/\/+$/, '') + '/health', { signal: c.signal })
    clearTimeout(t)
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

let ttsStateReason = ''
function reportTtsState(state, extra = {}) {
  ttsState = state
  ttsStateReason = String(extra?.reason || '')
  flog('[tts]', state, JSON.stringify(extra))
  try { win?.webContents.send('tts:state', { state, ...extra }) } catch {}
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('tts:state', { state, ...extra })
    }
  } catch {}
}

/**
 * 把本地语音服务拉起来（app/tts/server.py）。
 * 为什么不打包进 asar 直接 require：它依赖 faster-qwen3-tts + torch，只能跑在用户自己的 venv 里。
 * 所以这里只负责「找到 python → 起子进程 → 等 /health 变 ready」，找不到就安静降级（她不出声，打字照常）。
 */
/**
 * 子进程环境：把 Electron 自己的目录从 PATH 里剔掉。
 * 原因：Electron 会把 resources/app.asar 所在目录塞进 PATH，里面有 ffmpeg.dll / v8.dll 等，
 * 和 torch 依赖的 DLL 同名，Python 侧会加载到错的那份 —— 表现是「进程活着但永远不起监听」。
 */
function childEnv(py) {
  const drop = [path.dirname(process.execPath), ROOT].map((p) => p.toLowerCase())
  const parts = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter((p) => p && !drop.some((d) => p.toLowerCase().startsWith(d)))
  const pyDir = path.dirname(py)
  if (pyDir && !parts.some((p) => p.toLowerCase() === pyDir.toLowerCase())) parts.unshift(pyDir)
  return { ...process.env, PATH: parts.join(path.delimiter), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
}

async function probeTts() {
  const up = await ttsHealth(String(settings.ttsUrl || TTS_URL))
  if (up && up.ok && up.ready) reportTtsState('ready', { voices: up.voices })
  else reportTtsState('off', { reason: '服务没开，点「启动 / 重启服务」' })
}

async function ensureTts({ force = false } = {}) {
  if (process.env.PET_TTS_DISABLE === '1') { reportTtsState('off'); return }
  const base = String(settings.ttsUrl || TTS_URL)
  const up = await ttsHealth(base)
  if (up && up.ok) { reportTtsState('ready', { voices: up.voices }); return }
  if (!force) { reportTtsState('off', { reason: '服务没开，点「启动 / 重启服务」' }); return }
  if (ttsChild) return

  const py = settings.ttsPython || process.env.PET_TTS_PYTHON || pickPython()
  if (!py) { reportTtsState('failed', { reason: '没找到 python（设置里填 ttsPython）' }); return }

  if (py !== settings.ttsPython && py !== 'python') {
    settings.ttsPython = py
    try { saveSettings() } catch {}
    flog('[tts] 记住 python：', py)
  }
  reportTtsState('starting', { python: py })
  try { writeFileSync(path.join(ROOT, '_data', 'env-dump.json'), JSON.stringify(childEnv(py), null, 2)) } catch {}
  const script = path.join(ROOT, 'app', 'tts', 'server.py')
  const logPath = path.join(ROOT, '_data', 'tts.log')
  try { mkdirSync(path.dirname(logPath), { recursive: true }) } catch {}
  let out = null
  try { out = openSync(logPath, 'a') } catch {}
  try {
    // 交给 launch.ps1 用 Start-Process 起独立进程组：
    // 直接从 Electron spawn python 会卡在模型加载（进程活着、端口不监听），
    // 而同一个脚本从外部起 16 秒就绪 —— 差别在进程组/控制台继承。
    const launcher = path.join(ROOT, 'app', 'tts', 'launch.ps1')
    ttsChild = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher,
      '-Python', py, '-Script', script, '-Log', logPath, '-WorkDir', ROOT,
    ], {
      cwd: ROOT, windowsHide: true, stdio: 'ignore',
      env: { ...childEnv(py), ...(settings.ttsModel ? { PET_TTS_MODEL: settings.ttsModel } : {}) },
    })
    // 注意：launch.ps1 用 Start-Process 起独立进程后自己就退出了，退出码 0 不代表服务没起；
    // 真正的判据是轮询 /health，所以这里只记日志。
    ttsChild.on('exit', (code) => { flog('[tts] 启动器退出', code); ttsChild = null })
  } catch (err) {
    reportTtsState('failed', { reason: String(err?.message || err) })
    return
  }

  // 冷启动要 40–90s（加载 0.6B 模型），这里轮询到 150s
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const info = await ttsHealth(base, 1200)
    if (info && info.ok && info.ready) { reportTtsState('ready', { voices: info.voices }); return }
    // 不再因启动器退出就判失败（见上）；服务真的没起会在下面超时兜底
  }
  const why = ttsLogTail()
  reportTtsState('failed', { reason: why || '90 秒还没监听端口（看 _data/tts.log）' })
}

/** 从 _data/tts.log 末尾挑一行最像"错误"的，给设置页一个能看懂的理由。 */
function ttsLogTail() {
  try {
    const p = path.join(ROOT, '_data', 'tts.log')
    const raw = readFileSync(p, 'utf8')
    const lines = raw.split(String.fromCharCode(10)).filter((l) => l.trim())
    const errRe = /(ModuleNotFoundError|ImportError|SyntaxError|No such file|Traceback|✗|Error:|错误|失败)/i
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 40; i--) {
      if (errRe.test(lines[i])) return lines[i].trim().slice(0, 160)
    }
  } catch {}
  return ''
}

/** 这个 python 能不能真的跑 TTS：导入 torch 与 faster_qwen3_tts 试一次。 */
function pyHasTts(py) {
  try {
    const r = spawnSync(py, ['-c', 'import torch, faster_qwen3_tts'], {
      timeout: 12000, windowsHide: true, env: childEnv(py), stdio: 'ignore',
    })
    return r.status === 0
  } catch { return false }
}

/**
 * 找 python。**不能只看文件存在**：系统 python 通常没有 torch，
 * 表面能找到、一跑就 ModuleNotFoundError（这就是"启动失败"最常见的真因）。
 * 所以逐个候选"真跑一次 import"，第一个通过的才用。
 */
function pythonCandidates() {
  const cands = []
  const push = (p) => { if (p && !cands.includes(p)) cands.push(p) }
  push(settings.ttsPython)
  push(process.env.PET_TTS_PYTHON)
  // 项目内常见 venv
  for (const rel of ['.venv', path.join('app', 'tts', '.venv')]) {
    push(path.join(ROOT, rel, 'Scripts', 'python.exe'))
  }
  // 项目同级/上级里名字带 venv 的目录（比如 D:oice-lab\qwen3tts-venv）
  for (const base of [path.dirname(ROOT), ROOT]) {
    try {
      for (const name of readdirSync(base)) {
        if (!/venv|env|tts/i.test(name)) continue
        push(path.join(base, name, 'Scripts', 'python.exe'))
      }
    } catch {}
  }
  for (const v of ['Python313', 'Python312', 'Python311']) {
    push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', v, 'python.exe'))
  }
  cands.push('python')
  return cands
}

function pyHasKws(py) {
  try {
    const r = spawnSync(py, ['-c', 'import sherpa_onnx, sounddevice, numpy'], { timeout: 12000, windowsHide: true })
    return r.status === 0
  } catch { return false }
}

function pickPython() {
  for (const c of pythonCandidates()) {
    if (c === 'python') return c
    try { if (!existsSync(c)) continue } catch { continue }
    if (pyHasTts(c)) return c
  }
  // 都不合格也返回 'python'，让 launch 去报真实错误（设置页会显示日志里的那行）
  return 'python'
}

// KWS 需要的是 sherpa_onnx + sounddevice，和 TTS 的 torch 不是一回事
function pickKwsPython() {
  for (const c of pythonCandidates()) {
    if (c === 'python') return c
    try { if (!existsSync(c)) continue } catch { continue }
    if (pyHasKws(c)) return c
  }
  return 'python'
}

function stopTts() {
  if (!ttsChild) return
  try { ttsChild.kill() } catch {}
  ttsChild = null
}
let ttsSeq = 0
const ttsCtrls = new Map()   // id -> AbortController（一句一个请求，允许并行排队）
// ---- 关键词唤醒（KWS）----------------------------------------------------
// 常驻一个 python worker（app/tts/kws.py）：采麦 → sherpa-onnx → 命中打一行 JSON。
// 不引 sherpa-onnx-node：那是原生模块，要 electron-rebuild + 跨 ABI，还会把包体撑大。
let kwsChild = null
let kwsWatchdog = null
let sayToBrain = null   // 由 setupIpc 里的 brainSay 赋值，供 KWS 会话调用
let kwsState = 'off'        // off / starting / ready / failed
let kwsPaused = false
let kwsPauseTimer = null
let wakeSession = false       // 唤醒会话进行中（说 10 秒没话就由 python 结束）

// 唤醒应答：都要短（<=6 字），否则会盖住主人紧接着说的第一句
const WAKE_REPLIES = [
  '在。',
  '嗯？',
  '在呢。',
  '怎么了？',
  '嗯。',
  '叫本鲸？',
  '来了。',
  '听着呢。',
  '说。',
  '嗯，在。',
  '什么事？',
  '唔？',
]
const BYE_REPLIES = ['好，那我先不说啦。', '嗯，有事再叫我。', '那我先安静着。']

function kwsReport(extra = {}) {
  try { win?.webContents.send('kws:state', { state: kwsState, ...extra }) } catch {}
}

function kwsSend(cmd) {
  try { kwsChild?.stdin?.write(cmd + '\n') } catch {}
}

let kwsPauseWatchdog = null
function kwsPause(ms = 0) {
  if (!kwsChild) return
  kwsPaused = true
  kwsSend('pause')
  clearTimeout(kwsPauseWatchdog)
  kwsPauseWatchdog = setTimeout(() => { flog('[kws] 暂停超过 45 秒，强制恢复'); kwsResume() }, 45000)
  if (kwsPauseTimer) clearTimeout(kwsPauseTimer)
  if (ms > 0) kwsPauseTimer = setTimeout(() => kwsResume(), ms)
}

function kwsResume() {
  clearTimeout(kwsPauseWatchdog)
  if (!kwsChild) return
  if (kwsPauseTimer) { clearTimeout(kwsPauseTimer); kwsPauseTimer = null }
  kwsPaused = false
  kwsSend('resume')
}

function stopKws() {
  if (!kwsChild) return
  try { kwsSend('quit') } catch {}
  try { kwsChild.kill() } catch {}
  kwsChild = null
  kwsState = 'off'
  kwsReport()
}

async function ensureKws({ force = false } = {}) {
  if (settings.wakeOn === false && !force) { kwsState = 'off'; kwsReport(); return }
  if (kwsChild) return
  const py = pickKwsPython()
  flog('[kws] python =', py)
  if (!py) { kwsState = 'failed'; kwsReport({ reason: '没找到装着 sherpa-onnx 的 python（设置里填 ttsPython）' }); return }
  const dir = path.join(ROOT, 'app', 'tts', 'kws-models',
    'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01')
  const modelDir = settings.wakeModel || dir
  const kwFile = path.join(ROOT, 'app', 'tts', 'kws-models', 'keywords_zh.txt')
  if (!existsSync(modelDir)) {
    kwsState = 'failed'
    kwsReport({ reason: '模型没放好：' + modelDir })
    return
  }
  kwsState = 'starting'
  kwsReport({ words: settings.wakeWords })
  const args = [
    path.join(ROOT, 'app', 'tts', 'kws.py'),
    '--model-dir', modelDir,
    '--keywords', kwFile,
    '--threshold', String(settings.wakeThreshold ?? 0.25),
    '--idle', String(Number(settings.wakeIdleSec ?? 10)),
  ]
  if (settings.wakeDevice) args.push('--device', String(settings.wakeDevice))
  let child = null
  try {
    child = spawn(py, args, { cwd: ROOT, env: childEnv(py), windowsHide: true })
    kwsChild = child
    flog('[kws] spawn pid=' + child.pid)
    // 看门狗：15 秒还没 ready 就说明卡住了（模型加载正常只要 1-2 秒），打日志 + 杀重来一次
    clearTimeout(kwsWatchdog)
    kwsWatchdog = setTimeout(() => {
      if (kwsChild !== child || kwsState === 'ready') return
      flog('[kws] 15 秒没有 ready，重启一次（state=' + kwsState + '）')
      try { child.kill() } catch {}
      if (kwsChild === child) { kwsChild = null; kwsState = 'starting' }
      void ensureKws({ force: true })
    }, 15000)
  } catch (e) {
    flog('[kws] spawn 失败', String(e?.message || e))
    kwsState = 'failed'
    kwsReport({ reason: String(e?.message || e) })
    return
  }
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let ev = null
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'ready') { kwsState = 'ready'; flog('[kws] ready device=' + ev.device + ' idle=' + ev.idle); kwsReport({ device: ev.device }) }
      else if (ev.type === 'wake') onWakeWord(ev.keyword)
      else if (ev.type === 'session') { wakeSession = true; kwsReport({ session: true }) }
      else if (ev.type === 'speech') onWakeSpeech(ev)
      else if (ev.type === 'session_end') onSessionEnd(ev.why)
      else if (ev.type === 'call') { kwsReport({ call: !!ev.on }) }
      else if (ev.type === 'error') { kwsState = 'failed'; kwsReport({ reason: ev.message }) }
    }
  })
  child.stderr.on('data', (d) => flog('[kws]', d.toString('utf8').trim().slice(0, 200)))
  child.on('error', (e) => { flog('[kws] spawn 错误', String(e?.message || e)) })
  child.on('exit', (code, sig) => {
    flog('[kws] exit pid=' + child.pid + ' code=' + code + ' sig=' + (sig || '') + ' current=' + (kwsChild === child) + ' state=' + kwsState)
    // 只认「当前这个」子进程的退出：重启时会先 kill 旧的，旧进程的 exit 事件
    // 如果无条件写 kwsState，就会把新进程的 ready 覆盖成 failed（踩过）。
    if (kwsChild !== child) return
    kwsChild = null
    if (kwsState === 'off') return
    flog('[kws] 子进程退出 code=' + code + ' sig=' + (sig || ''))
    kwsState = code === 0 ? 'off' : 'failed'
    kwsReport({ code })
  })
}

function onWakeWord(word = '') {
  flog('[kws] 唤醒：', word)
  kwsReport({ lastWord: word, session: true })
  wakeSession = true
  const line = WAKE_REPLIES[Math.floor(Math.random() * WAKE_REPLIES.length)]
  try { win?.webContents.send('pet:say', { text: line, state: 'idle', speak: true }) } catch {}
  // 不弹输入条：唤醒后她答一声，接着就用麦克风直接聊（语音走 python 那边的 VAD+ASR）
}

/** 会话里的一轮：主人说完一句 → 交给大脑 → 她回答 */
async function onWakeSpeech(ev) {
  const text = String(ev?.text || '').trim()
  if (!text) {
    if (ev?.error) flog('[kws] 这句没识别出来：', ev.error)
    return
  }
  flog('[kws] 听到：', text)
  kwsReport({ heard: text })
  try { win?.webContents.send('pet:say', { text: '「' + text + '」', state: 'thinking' }) } catch {}
  try {
    if (!sayToBrain) { flog('[kws] 大脑还没准备好，这句先记下：', text); return }
    await sayToBrain(text)
  } catch (e) { flog('[kws] brainSay 失败', String(e?.message || e)) }
}

function onSessionEnd(why) {
  wakeSession = false
  flog('[kws] 会话结束：', why)
  kwsReport({ session: false })
  if (why === 'call_off') return
  const line = BYE_REPLIES[Math.floor(Math.random() * BYE_REPLIES.length)]
  try { win?.webContents.send('pet:say', { text: line, state: 'idle', speak: true }) } catch {}
}

function abortTts() {
  if (!ttsCtrls.size) return
  for (const c of ttsCtrls.values()) { try { c.abort() } catch {} }
  ttsCtrls.clear()
  try { win?.webContents.send('tts:end', { id: 0, aborted: true }) } catch {}
  kwsResume()
}
// 主动开口：最近一次「用户在动」的时间（鼠标移动、打字、点她都会刷新）
let lastActivityAt = Date.now()
let lastChatAt = 0
let proactive = null
let proactiveLog = null
let proactiveTimer = null

function statSafe(p) { try { return statSync(p) } catch { return null } }

// ---------- 崩溃自愈：上次没成功起来 → 这次自动进安全模式 ----------
// 反馈里「双击闪一下就没、退出码主动中止、连窗口都没有」基本都是显卡/透明窗口的驱动兼容问题。
// 用启动标记判断：上一次启动没走到「窗口显示」就结束了，这一次就关掉硬件加速重试。
// 成功启动一次后标记置 true，下次自动恢复正常模式（有毛病也只是降级一次，不会永远降级）。
const BOOT_FILE = path.join(app.getPath('userData'), 'boot.json')
const ARG_SAFE = process.argv.includes('--safe') || process.env.STAGE_SAFE === '1'
let lastBoot = { ok: true, tries: 0 }
try { lastBoot = { ...lastBoot, ...JSON.parse(readFileSync(BOOT_FILE, 'utf8')) } } catch {}
const crashLastTime = lastBoot.ok === false
const SAFE = ARG_SAFE || crashLastTime
const bootTries = Number(lastBoot.tries || 0) + 1
try {
  writeFileSync(BOOT_FILE, JSON.stringify({ ok: false, safe: SAFE, tries: bootTries, startedAt: Date.now() }, null, 2))
} catch {}
if (SAFE) {
  // 安全模式只降「直接合成」，不关硬件加速也不关 WebGL：
  // 关掉 GPU 会让 Live2D 落到 SwiftShader（webgl unavailable），窗口在、人却看不见，
  // 用户看到的就是「双击了没反应」——比崩溃更难查。
  for (const sw of ['disable-direct-composition']) {
    try { app.commandLine.appendSwitch(sw) } catch {}
  }
}
function bootFinished() {
  try { writeFileSync(BOOT_FILE, JSON.stringify({ ok: true, safe: SAFE, tries: bootTries, at: Date.now() }, null, 2)) } catch {}
}

// 未捕获异常：写日志 + 弹一个能看懂的框（带上日志路径），别让用户只看到「闪一下没了」
process.on('uncaughtException', (e) => {
  flog('[crash] uncaughtException', e?.stack || String(e))
  try { dialog.showErrorBox('桌宠出错了', `\n${e?.message || e}\n\n日志：${LOG_FILE}\n把这份日志发给我就能定位。`) } catch {}
})
process.on('unhandledRejection', (e) => {
  flog('[crash] unhandledRejection', (e && (e.stack || e.message)) || String(e))
})

/** 目录里挑一个 *.model3.json：优先「大肥鱼」，否则第一个 */
function pickModelIn(dir) {
  try {
    // 兼容两种命名：`xxx.model3.json`（Live2D 规范）与直接叫 `model3.json`（我们的模型）
    const files = readdirSync(dir).filter((f) => {
      const n = f.toLowerCase()
      return n.endsWith('.model3.json') || n === 'model3.json'
    }).sort()
    if (!files.length) return null
    return path.join(dir, files.find((f) => f.startsWith('大肥鱼')) || files[0])
  } catch { return null }
}

/** 设置里的 model：相对路径按 exe 所在目录解析（配置里只存相对路径，换机不用改） */
function fromSettings() {
  if (!settings.model) return null
  const abs = path.isAbsolute(settings.model) ? settings.model : path.resolve(EXE_DIR, settings.model)
  return existsSync(abs) ? abs : null
}

/** 解析模型路径：命令行 --model → 设置 → exe 旁 model/ → 包内 resources/app/model → 环境变量 */
function resolveModel() {
  if (ARG_MODEL) {
    const abs = path.isAbsolute(ARG_MODEL) ? ARG_MODEL : path.resolve(process.cwd(), ARG_MODEL)
    if (existsSync(abs)) return abs
    flog('[model] --model 参数指向的文件不存在：', abs)
  }
  const fromCfg = fromSettings()
  if (fromCfg) return fromCfg
  for (const dir of MODEL_DIRS) { const f = pickModelIn(dir); if (f) return f }
  if (process.env.STAGE_MODEL && existsSync(process.env.STAGE_MODEL)) return process.env.STAGE_MODEL
  return null
}

/** 启动时拿模型：找不到就返回 null（由首次运行引导页处理，不再弹选择框后闪退） */
async function resolveModelOrPick() {
  return resolveModel()
}

// ---------- 贴图自动压缩：常驻软件不该一开机就吃 2GB ----------
// 模型的 4096/8192 图集解压后是 592MB 级别（8192² 单张就 256MB），缩到 2048 后 64MB。
// 这是**默认流程**：首次启动发现贴图过大就自动压一次（约 10 秒），之后一直用 _opt2048 副本。
// 跳过：环境变量 STAGE_NO_SHRINK=1；想重跑：双击「贴图压缩.cmd」。
const MAX_TEX = 2048

/** 只读 PNG 头拿宽高（不解码） */
function pngSize(file) {
  try {
    const fd = openSync(file, 'r')
    const b = Buffer.alloc(24)
    readSync(fd, b, 0, 24, 0)
    closeSync(fd)
    if (b.readUInt32BE(0) !== 0x89504e47) return null
    return [b.readUInt32BE(16), b.readUInt32BE(20)]
  } catch { return null }
}

/** 找出模型里第一张超过 MAX_TEX 的贴图 */
function oversizedTexture(modelFile) {
  try {
    const j = JSON.parse(readFileSync(modelFile, 'utf8'))
    for (const rel of j?.FileReferences?.Textures || []) {
      const p = path.resolve(path.dirname(modelFile), rel)
      if (!existsSync(p)) continue
      const s = pngSize(p)
      if (s && Math.max(s[0], s[1]) > MAX_TEX) return { rel, w: s[0], h: s[1] }
    }
  } catch (e) { flog('[opt] 读模型失败', String(e?.message || e)) }
  return null
}

async function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 430, height: 136, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#11151c', show: false,
  })
  await splash.loadFile(path.join(ROOT, 'app', 'optimizing.html'))
  splash.once('ready-to-show', () => splash.show())
  return splash
}

/** 调 tools/shrink-textures.ps1；成功后脚本自己把 settings.json 的 model 指到副本 */
async function autoShrinkTextures(modelFile) {
  const script = path.join(ROOT, 'tools', 'shrink-textures.ps1')
  if (!existsSync(script)) { flog('[opt] 缺 tools/shrink-textures.ps1，跳过压缩'); return false }
  flog('[opt] 开始压缩贴图：', modelFile)
  const splash = await createSplashWindow().catch(() => null)
  try {
    const code = await new Promise((resolve) => {
      let out = ''
      const cp = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Model', modelFile, '-NoLaunch'], { windowsHide: true, env: { ...process.env, STAGE_UTF8: '1' } })
      cp.stdout?.on('data', (d) => { out += String(d) })
      cp.stderr?.on('data', (d) => { out += String(d) })
      const timer = setTimeout(() => { flog('[opt] 超时，放弃'); try { cp.kill() } catch {} resolve(-1) }, 180000)
      cp.on('error', (e) => { clearTimeout(timer); flog('[opt] 启动脚本失败', String(e?.message || e)); resolve(-2) })
      cp.on('close', (c) => { clearTimeout(timer); flog('[opt] 退出码', c); if (out) flog('[opt] 输出', out.slice(-600)); resolve(c) })
    })
    return code === 0
  } finally { try { splash?.destroy() } catch {} }
}


const DEFAULTS = {
  petName: '大肥鱼',
  width: 520,
  height: 760,
  x: null,          // 窗口位置（首次启动按屏幕右上角摆）
  y: null,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  gaze: true,
  strength: 1,
  headGain: 1.25,   // 转头幅度（ParamAngleX/Y 的增益倍数），设置窗口可调
  petGain: 1.6,
  idle: true,        // 待机动作（常驻微摆 + 随机成套动作 + 小台词）
  idleSpeed: 1,      // 待机频率倍数（越大换动作越勤）
  alwaysOnTop: true,
  clickThrough: false,
  bubble: true,          // 气泡总开关
  border: false,         // 显示窗口边框（拖边框缩放；关掉后回到纯角色）
  padY: 0.02,            // 上下留白（0–0.2，占画布高度比例）；越小边框越贴角色
  bodyShape: 0,          // 体型：0 默认 / 0.4 体型1 / 1 体型2（Clothes2 参数，设置里拉条调）
  dragPhysics: true,     // 拖拽物理：拖动窗口时让模型自己的物理跟着甩（类似 VTS 的拖拽物理演算）
  theme: 'dark',         // 设置页主题：dark | light | system
  autoStart: false,      // 开机自启（Windows 登录时启动舞台）
  proactive: 'few',      // 主动开口频率：off / few / normal / many
  wakeOn: false,         // 关键词唤醒（常驻监听麦克风，默认关）

  wakeIdleSec: 10,       // 唤醒会话里静默多少秒自动结束
  wakeWords: '大肥鱼,鲸鸢', // 唤醒词，逗号分隔
  wakeDevice: '',        // 麦克风设备（序号或名字片段，空=系统默认）
  awayTalk: true,        // 主人走开/回来时，她要不要嘀咕两句
  quietFrom: '23:30',    // 勿扰开始（她自己不会在这个时段开口）
  quietTo: '07:30',      // 勿扰结束
  look: null,            // 她那一身（眼镜/鞋/裙/体型/尾巴/牙/配件），由渲染层回写、启动时穿回去
  voice: true,           // 让她出声（本地 TTS）
  ttsUrl: TTS_URL,       // TTS 服务地址（app/tts/server.py 默认 :8769）
  asrEngine: 'sensevoice', // 语音转文字引擎：sensevoice（CPU，默认）/ qwen3（GPU，更准更慢）
  ttsModel: '',          // 语音模型目录（留空则用 app/tts/models/qwen3tts-0.6B）
  ttsAutoStart: true,    // 启动时自动拉起本地语音服务（launch.ps1 起独立进程组，16–25s 就绪）
  player: true,          // 她点歌时弹「唱片机」小窗（关掉就只出声、不弹窗）
  pvStyle: 'ocean',      // 歌词 PV 配色（深海/夕焼/报纸/酸绿/墨朱）
  musicTalk: true,
  fxOn: true, // 画面装饰特效（FX）：只画在歌名下方那块空白，可关       // 她会不会对正在放的歌嘀咕一句（12 分钟一次、同一首只说一次）
  ttsPython: '',         // 指向装了 faster-qwen3-tts 的 python.exe；空 = 自动找
  model: null,           // 启动时由 resolveModel() 决定（发布版没有模型，要用户选）
  workLink: 'full',      // 工作联动：off / motion（只动作）/ full（动作+短句）
}

let settings = { ...DEFAULTS }

/** 工作联动：轮询 dsh-pet 的 workStatus（见 app/worklink.mjs） */
let workLink = null
let win = null
// 启动阶段（引导窗口 / 压缩贴图 splash 关闭时）不该触发「窗口全关 → 退出」
let bootGuard = true
let quitting = false
let srv = null
let token = 'local-app'

/** 窗口跑到屏幕外时（多显示器拔掉、上次坐标越界）把它拎回主屏中间，否则「双击没反应」 */
function ensureOnScreen(w) {
  try {
    const b = w.getBounds()
    const area = screen.getDisplayMatching(b).workArea
    const inter = Math.max(0, Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x)) *
      Math.max(0, Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y))
    if (inter < b.width * b.height * 0.3) {
      w.center()
      flog('[single] 窗口不在屏幕内，已居中')
    }
  } catch {}
}

// PET_MULTI=1：允许并存（npm run check 自检要用，否则会被单例锁踢掉）
const gotLock = process.env.PET_MULTI === '1' ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  // 已经在跑了：把这个进程安静退出，由「第一个实例」把自己的窗口拎到最前面（见下面 second-instance）。
  // 注意：这里不能弹 dialog —— app 还没 ready 时 showMessageBoxSync 会抛，被 catch 掉就成了「双击没反应」。
  try { appendFileSync(path.join(os.tmpdir(), 'dafeiyu-boot.txt'), `${new Date().toISOString()} second-instance-exit
`) } catch {}
  app.quit()
} else {
  // 又一次双击：把已经在跑的她拎到最前面（以前第二个实例直接退出，看起来就是「点了没反应」）
  app.on('second-instance', () => {
    try {
      if (!win || win.isDestroyed()) {
        // 只剩辅窗的僵尸实例：重启一个新进程，否则用户双击永远没反应
        flog('[single] 舞台窗不在了，重启进程')
        app.relaunch(); app.exit(0); return
      }
      if (win.isMinimized()) win.restore()
      win.show()
      ensureOnScreen(win)
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
      win.focus()
      flog('[single] 已在运行，把窗口拎到前面')
    } catch (err) {
      flog('[single] 拎窗口失败', String(err?.message || err))
    }
  })
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

async function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(await readFile(settingsFile(), 'utf8')) }
  } catch { /* 首次启动：用默认 */ }
  settings.clickThrough = false // 上次退出时若在穿透态，重启一律恢复正常，避免「点不到」
}
async function saveSettings() {
  try {
    await mkdir(path.dirname(settingsFile()), { recursive: true })
    // 模型路径：在 exe 目录内就存相对路径（打包后换目录/换机不用改配置）
    const out = { ...settings }
    if (out.model) {
      const rel = path.relative(EXE_DIR, out.model)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out.model = rel.replace(/\\/g, '/')
    }
    await writeFile(settingsFile(), JSON.stringify(out, null, 2), 'utf8')
  } catch (e) { console.error('[settings] 保存失败', e) }
}

// 渲染层按角色轮廓实时开关的穿透（区别于手动全窗穿透 settings.clickThrough）
let dynamicIgnore = false
// 渲染层上传的轮廓掩码（1 bit/格）。穿透判定放在主进程：页面在后台会被节流，
// 只靠页面内的 pointermove 判定，就会出现「必须先点一下窗口才能拖」。
let hitMask = null
/** 没有像素掩码时的兜底命中区（她的大致包围盒，窗口坐标） */
let hitBox = null
let maskCount = 0
// 窗口内的「可点浮层」矩形（输入条/工具栏，窗口内坐标）。DOM 不在画布掩码里，
// 不单独算的话，鼠标停在她脚下的输入框上会被判成透明、整窗穿透，点不进去。
let chromeRects = []
let chromeAt = 0
let ignoreAt = 0
let maskAt = 0
let dragging = false

/** 开机自启：写 Windows 登录启动项。开发模式跳过，免得把 electron.exe 写进系统 */
function applyAutoStart() {
  try {
    if (!app.isPackaged) return
    app.setLoginItemSettings({ openAtLogin: !!settings.autoStart, path: process.execPath, args: [] })
  } catch (e) { console.error('[autostart]', e && e.message) }
}

let appliedTop = null
let appliedIgnore = null
let appliedLevel = 'screen-saver'

function applyWindowSettings() {
  if (!win) return
  // 只在与当前窗口状态不同的时候才动：setAlwaysOnTop 每次都调会重新排一次 z 序，
  // 拖动刚开始时正好赶上穿透判定翻转，表现就是「一开始拖，窗口闪一下」。
  const top = !!settings.alwaysOnTop
  const want = top
  const level = 'screen-saver'
  if (want !== appliedTop || level !== appliedLevel) {
    win.setAlwaysOnTop(want, level)
    appliedTop = want
    appliedLevel = level
  }
  const ig = !!settings.clickThrough || dynamicIgnore
  if (ig !== appliedIgnore) {
    win.setIgnoreMouseEvents(ig, { forward: true })
    appliedIgnore = ig
  }
}

/**
 * 把保存的窗口尺寸/位置夹回可用区里。
 *
 * 记下来的值可能是换了分辨率/缩放/拔了副屏之后的结果（我们这台机器上就出现过 y = -264：
 * 窗口比屏幕还高，头顶 264px 在屏幕外，能看见半个人）。规则：
 *   1. 窗口比可用区大 → 等比缩到「可用区高度 - 40」以内（宽高比不变，角色不会被拉扁）；
 *   2. 位置必须让整个窗口落在可用区里；窗口本来就大于可用区时贴左上角。
 */
function fitWindowToWorkArea(w, h, area) {
  if (!area) return { w, h, x: settings.x, y: settings.y }
  const maxH = Math.max(240, area.height - 40)
  const maxW = Math.max(200, area.width - 40)
  const k = Math.min(1, maxH / h, maxW / w)
  const fw = Math.round(w * k)
  const fh = Math.round(h * k)
  return { w: fw, h: fh, maxW, maxH }
}

function clampToWorkArea(x, y, w, h, area) {
  if (!area) return { x, y }
  const nx = Math.max(area.x, Math.min(area.x + Math.max(0, area.width - w), x))
  const ny = Math.max(area.y, Math.min(area.y + Math.max(0, area.height - h), y))
  return { x: Math.round(nx), y: Math.round(ny) }
}

// ---------- 独立输入条窗口 ----------
// 为什么单独开窗：它跟着窗口一起被搬的话，窗口一动条就跟着动，
// 而页面只能在下一帧才把它拉回来 —— 拖起来就是一跳一跳。独立窗口由主进程
// 直接用屏幕坐标摆，窗口怎么动都不影响它。
let chatWin = null
// 输入条开着的时候，桌宠窗口要降到 floating，否则同为 topmost 时会盖住输入条
let chatVisible = false
let chatTopTimer = null

function startChatTopPump() {
  if (chatTopTimer) return
  chatTopTimer = setInterval(() => {
    if (!chatWin || chatWin.isDestroyed() || !chatWin.isVisible()) return
    try { chatWin.moveTop() } catch {}
  }, 320)
}

function stopChatTopPump() {
  if (chatTopTimer) clearInterval(chatTopTimer)
  chatTopTimer = null
}
let chatAnchor = null // { cx, ty }：以主窗口左上角为原点的偏移
let chatLocked = false

function chatBarSize() {
  const b = win && !win.isDestroyed() ? win.getBounds() : { width: 420 }
  return { w: Math.min(420, Math.max(260, Math.round(b.width - 24))), h: 48 }
}

function placeChatWindow() {
  if (!chatWin || chatWin.isDestroyed() || !win || win.isDestroyed()) return
  const b = win.getBounds()
  const { w, h } = chatBarSize()
  const area = screen.getDisplayMatching(b).workArea
  const desiredY = Math.round(b.y + (chatAnchor?.ty ?? b.height) + 10)
  const maxY = area.y + area.height - h - 8
  // 到底了就钉住垂直方向；只有她明显离开（往上够 24px）才解锁
  if (desiredY > maxY) chatLocked = true
  else if (chatLocked && desiredY < maxY - 8) chatLocked = false
  const y = chatLocked ? maxY : desiredY
  const cx = Math.round(b.x + (chatAnchor?.cx ?? b.width / 2))
  const x = Math.min(Math.max(cx - Math.round(w / 2), area.x + 8), area.x + area.width - w - 8)
  chatWin.setBounds({ x, y, width: w, height: h }, false)
  if (chatWin.isVisible()) { try { chatWin.moveTop() } catch {} }
}

function showChatWindow() {
  if (!chatWin || chatWin.isDestroyed()) return
  chatVisible = true
  startChatTopPump()
  placeChatWindow()
  chatWin.show()
  keepChatOnTop()
  chatWin.focus()
  try { chatWin.webContents.send('chatwin:shown') } catch {}
}

/**
 * 输入条要盖在桌宠上面。
 * 两个窗口都是 screen-saver 级，级别一样时先后由「最后一次 moveTop」决定：
 * 点桌宠会把主窗口顶上来，所以每次主窗口拿到焦点都要把条再顶回去。
 */
function keepChatOnTop() {
  if (!chatWin || chatWin.isDestroyed() || !chatWin.isVisible()) return
  try {
    chatWin.setAlwaysOnTop(true, 'screen-saver')
    chatWin.moveTop()
  } catch {}
}

function hideChatWindow() {
  if (!chatWin || chatWin.isDestroyed()) return
  stopChatTopPump()
  chatWin.hide()
  chatVisible = false
}

// ---------- 对话记录窗口（只读） ----------
let historyWin = null

async function openHistoryWindow() {
  if (historyWin && !historyWin.isDestroyed()) {
    placeAbovePet(historyWin)
    historyWin.show()
    keepAbovePet(historyWin)
    historyWin.focus()
    return
  }
  historyWin = new BrowserWindow({
    width: 400,
    height: 580,
    minWidth: 320,
    minHeight: 360,
    show: false,
    title: '对话记录',
    backgroundColor: '#14171d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'app', 'history-preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  })
  historyWin.once('ready-to-show', () => {
    placeAbovePet(historyWin)
    historyWin.show()
    keepAbovePet(historyWin)
    historyWin.focus()
  })
  historyWin.on('closed', () => { historyWin = null })
  await historyWin.loadFile(path.join(ROOT, 'app', 'history.html'))
}

async function createChatWindow() {
  const { w, h } = chatBarSize()
  chatWin = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: path.join(ROOT, 'app', 'chat-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  chatWin.setBackgroundColor('#00000000')
  chatWin.setAlwaysOnTop(true, 'screen-saver')
  await chatWin.loadFile(path.join(ROOT, 'app', 'chat.html'))
  // 用户点到别处（别的应用 / 显示桌面）时把输入条收掉，免得它一直浮在桌面上
  const maybeHide = () => {
    setTimeout(() => {
      if (!chatWin || chatWin.isDestroyed() || !chatWin.isVisible()) return
      if (win?.isFocused?.() || chatWin.isFocused?.()) return
      hideChatWindow()
      try { win?.webContents.send('brain:ev', { t: 'state', state: 'chat-closed' }) } catch {}
    }, 140)
  }
  chatWin.on('blur', maybeHide)
  win.on('blur', maybeHide)
  chatWin.on('closed', () => { chatWin = null })
}

async function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const fit = fitWindowToWorkArea(settings.width, settings.height, workArea)
  const wanted = {
    x: Number.isFinite(settings.x) ? Math.round(settings.x) : (workArea ? Math.round(workArea.x + workArea.width - fit.w - 40) : undefined),
    y: Number.isFinite(settings.y) ? Math.round(settings.y) : (workArea ? Math.round(workArea.y + 40) : undefined),
  }
  const pos = (wanted.x == null || wanted.y == null)
    ? wanted
    : clampToWorkArea(wanted.x, wanted.y, fit.w, fit.h, workArea)
  if (fit.w !== settings.width || fit.h !== settings.height) {
    flog('[boot] 窗口超出可用区，等比缩到', `${fit.w}×${fit.h}`, '（原', `${settings.width}×${settings.height}`, '）')
    settings.width = fit.w
    settings.height = fit.h
    saveSettings()
  }
  appliedTop = null
  appliedIgnore = null
  win = new BrowserWindow({
    width: fit.w,
    height: fit.h,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: path.join(ROOT, 'assets', 'app.ico'),
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'app', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.setBackgroundColor('#00000000')
  void createChatWindow()
  win.on('focus', () => keepChatOnTop())
  // 诊断：她「消失」时到底是什么状态
  win.on('blur', () => {
    flog('[dbg] pet blur top=', win.isAlwaysOnTop(), 'visible=', win.isVisible(), 'min=', win.isMinimized())
    // 她失焦时把 topmost 再钉一次：有些前台切换会把 topmost 顺序打乱，表现就是「点一下别处她就不见了」
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) return
      try { if (settings.alwaysOnTop) { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop() } } catch {}
    }, 180)
  })
  win.on('hide', () => flog('[dbg] pet hide'))
  win.on('minimize', () => flog('[dbg] pet minimize'))
  win.on('show', () => flog('[dbg] pet show'))
  win.once('ready-to-show', () => {
    win.show()
    // 窗口真的显示出来了才算「启动成功」，否则下次启动继续走安全模式
    setTimeout(bootFinished, 2500)
  })
  // 渲染层报错 / 加载失败 / 渲染进程崩了：都写进日志，下次「打不开」有据可查
  win.webContents.on('console-message', (...a) => {
    const o = a[0] && typeof a[0] === 'object' && 'message' in a[0]
      ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], sourceId: a[4] }
    const lv = o.level
    if (lv === 'error' || lv === 3 || lv === 'warning') flog('[renderer]', `[${lv}]`, String(o.message ?? ''), o.sourceId || '')
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => flog('[load] 失败', code, desc, url))
  win.webContents.on('render-process-gone', (_e, d) => flog('[renderer] 进程退出', d))
  win.webContents.on('preload-error', (_e, p, err) => flog('[preload] 失败', p, err?.message || String(err)))
  // 拖动的「收尾」不能只靠渲染层发 drag-end：页面重载/失焦时那个事件不会来，
  // 定时器会残留并持续把窗口拽向光标。
  win.webContents.on('did-start-loading', stopWindowDrag)
  win.on('blur', stopWindowDrag)

  // 位置记忆：搬完窗口 500ms 后落盘（拖动过程中不写，避免每帧 IO）
  let moveTimer = null
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    settings.x = x
    settings.y = y
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => { moveTimer = null; saveSettings() }, 500)
  })
  await win.loadURL(`${srv.url}/app/`)
  applyWindowSettings()
  // 舞台窗一关就退出整个应用：留下唱片机/输入条这些辅窗会变成「双击没反应」的僵尸进程
  win.on('closed', () => { win = null; if (!quitting) { try { app.quit() } catch {} } })
  startAgentStatusFeed(win)
}

// ---------- DSH 工作状态：读桥接插件写的状态文件，推给渲染层 ----------
// 插件（dsh-live2d-bridge）在 DSH 侧监听 session/event，原子写 ~/.dsh/live2d/status.json；
// 这里只做「文件变了就转发」，不解析业务、不阻塞界面。文件不在 = DSH 侧没装插件，舞台按空闲处理。
const AGENT_STATUS_FILE = path.join(app.getPath('home'), '.dsh', 'live2d', 'status.json')

// 外部控制入口的发现文件：端口随机、token 只有主进程知道，agent/CLI 从这里读。
// 不做「退出即删」—— 留下的旧端口比消失的文件更容易被排查（连不上就能判断没开）。
const ENDPOINT_FILE = path.join(app.getPath('home'), '.dsh', 'live2d', 'endpoint.json')
async function writeEndpoint() {
  try {
    await mkdir(path.dirname(ENDPOINT_FILE), { recursive: true })
    await writeFile(ENDPOINT_FILE, JSON.stringify({
      url: srv.url,
      port: srv.port,
      token,
      pid: process.pid,
      model: settings.model,
      protocol: 1,
      at: Date.now(),
    }, null, 2))
  } catch (e) { console.warn('[endpoint] 写入失败', e?.message || e) }
}
function startAgentStatusFeed(target) {
  let lastSig = ''
  let lastAt = 0
  const tick = async () => {
    if (!target || target.isDestroyed()) return
    try {
      const st = await stat(AGENT_STATUS_FILE).catch(() => null)
      if (!st) { lastSig = ''; return }
      const sig = `${st.mtimeMs}:${st.size}`
      if (sig === lastSig) return
      lastSig = sig
      const raw = await readFile(AGENT_STATUS_FILE, 'utf8')
      let snap = null
      try { snap = JSON.parse(raw) } catch { return }
      if (!snap || typeof snap !== 'object') return
      const at = Number(snap.at || 0)
      if (at && at === lastAt) return
      lastAt = at
      target.webContents.send('agent:status', {
        state: snap.state ?? null,
        task: snap.task ?? null,
        tool: snap.tool ?? null,
        detail: snap.detail ?? null,
        at: at || Date.now(),
      })
    } catch {}
  }
  setInterval(tick, 400).unref?.()
  tick()
}

// 窗口尺寸跟随角色：尺寸由渲染层按「模型画布 × 角色大小」算好，这里只负责
// **保持中心不变**地改大小（角色在窗口里是居中 contain，所以改完依然居中）；
// 贴近屏幕边缘时按工作区夹一下，不会把窗口推出屏幕。
// ---------- 拖边框缩放 ----------
// 渲染层只报告「按下了哪条边」，真正的尺寸跟全局光标走（窗口在被移动时，
// 窗口内坐标会漂，只有屏幕坐标是稳的）。比例由起始窗口锁定，拖角/拖边都等比。
let borderDrag = null

function stopBorderDrag(save = true) {
  if (!borderDrag) return
  clearInterval(borderDrag.timer)
  clearTimeout(borderDrag.guard)
  borderDrag = null
  if (save && win && !win.isDestroyed()) {
    const [w, h] = win.getSize()
    settings.width = w
    settings.height = h
    saveSettings()
  }
}

function wireBorderDrag() {
  ipcMain.on('win:scale-begin', (_e, edge = 'se') => {
    if (!win || win.isDestroyed()) return
    stopBorderDrag(false)
    const start = win.getBounds()
    const ratio = start.width / start.height
    const tick = () => {
      if (!win || win.isDestroyed() || !borderDrag) return
      const p = screen.getCursorScreenPoint()
      const e = borderDrag.edge
      let w
      if (/[ew]/.test(e)) w = /e/.test(e) ? p.x - start.x : start.x + start.width - p.x
      else {
        const hh = /s/.test(e) ? p.y - start.y : start.y + start.height - p.y
        w = hh * ratio
      }
      w = Math.round(Math.max(240, Math.min(1600, w)))
      const h = Math.round(w / ratio)
      const x = /w/.test(e) ? start.x + start.width - w : /e/.test(e) ? start.x : Math.round(start.x + (start.width - w) / 2)
      const y = /n/.test(e) ? start.y + start.height - h : /s/.test(e) ? start.y : Math.round(start.y + (start.height - h) / 2)
      win.setBounds({ x, y, width: w, height: h })
    }
    borderDrag = {
      edge: String(edge),
      timer: setInterval(tick, 16),
      // 兜底：pointerup 丢了也不能让窗口一直跟着鼠标缩
      guard: setTimeout(() => stopBorderDrag(true), 30000),
    }
    tick()
  })
  ipcMain.on('win:scale-end', () => stopBorderDrag(true))
}

function wireFit() {
  ipcMain.on('win:fit', (_e, size = {}) => {
    if (!win || win.isDestroyed()) return
    const W = Math.max(180, Math.round(Number(size.w) || 0))
    const H = Math.max(220, Math.round(Number(size.h) || 0))
    const b = win.getBounds()
    if (process.env.STAGE_DEBUG_MOVE) console.log('[fit]', JSON.stringify({ from: [b.x, b.y, b.width, b.height], want: [W, H] }))
    // 尺寸没变就什么都不做：以前这里会用「四舍五入后的中心」重算位置，
    // 605 这种奇数宽 +1px/次 地累积，窗口就会以 5px/s 缓慢漂移。
    if (b.width === W && b.height === H) return
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) })
    const x = Math.min(Math.max(Math.round(cx - W / 2), workArea.x), workArea.x + workArea.width - W)
    const y = Math.min(Math.max(Math.round(cy - H / 2), workArea.y), workArea.y + workArea.height - H)
    win.setBounds({ x, y, width: W, height: H })
    settings.width = W
    settings.height = H
    settings.x = x
    settings.y = y
    saveSettings()
    broadcastSettings()
    if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) placeChatWindow()
  })
}

// 中键搬窗口：主进程按全局光标锚点搬（读系统光标是绝对量，不会像事件增量那样累积漂移）
let dragTimer = null
let dragBase = null
let dragSize = null
// 结束拖动：任何「可能收不到 drag-end」的情况（页面重载、焦点丢失、窗口销毁）都要停掉，
// 否则这个 16ms 定时器会一直把窗口往光标位置拽 —— 表现为窗口自己慢慢漂移。
function stopWindowDrag() {
  followAuxWindows()
  dragging = false
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = null
  dragBase = null
  dragSize = null
}
function wireWindowDrag() {
  ipcMain.on('win:drag-begin', () => {
    if (!win) return
    stopWindowDrag()
    const q = screen.getCursorScreenPoint()
    const [x, y] = win.getPosition()
    dragging = true
    dragBase = { cx: q.x, cy: q.y, x, y }
    dragSize = { x, y }
    if (dragTimer) clearInterval(dragTimer)
    const box = win.getBounds()
    dragTimer = setInterval(() => {
      if (!win || win.isDestroyed() || !dragBase) return
      const p = screen.getCursorScreenPoint()
      const x = Math.round(dragBase.x + (p.x - dragBase.cx))
      const y = Math.round(dragBase.y + (p.y - dragBase.cy))
      // 尺寸一起钉住：只改位置的调用在透明窗口上会顺带微调边框，尺寸抖一像素就是画面在颤。
      // 位移为 0 时干脆不碰窗口。
      if (x === dragSize.x && y === dragSize.y) return
      dragSize = { x, y }
      win.setBounds({ x, y, width: box.width, height: box.height }, false)
      // 立刻告诉渲染层窗口到哪了：页面自己读 window.screenY 会晚一两帧，
      // 那时输入条已经跟着窗口画下去了，下一帧再修正 —— 看着就是一跳一跳。
      win.webContents.send('pet:pos', { x, y })
      if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) placeChatWindow()
    }, 8)
  })
  ipcMain.on('win:drag-end', () => {
    stopWindowDrag()
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition()
      settings.x = x
      settings.y = y
      saveSettings()
    }
  })
}

// ---------- 子窗口（设置 / 动作编辑器）----------
// 覆盖层窗口只负责角色：设置类界面一律开成独立普通窗口（可拖动、有标题栏、不进穿透层），
// 覆盖层也就不用为了塞面板临时改宽度——尺寸与内容从此解耦。
const childWins = new Map()
/** 子窗口（设置/记录/编辑器）：挂在桌宠头顶上方，且压在桌宠之上 */
function placeAbovePet(bw) {
  try {
    const b = win && !win.isDestroyed() ? win.getBounds() : null
    if (!b || !bw || bw.isDestroyed()) return
    const { workArea } = screen.getDisplayMatching(b)
    const [w, h] = bw.getSize()
    const pad = 10
    // 先放她右边（不挡身子）；右边不够就放左边；两边都不够才压在她身上
    let x = b.x + b.width + pad
    if (x + w > workArea.x + workArea.width - 8) x = b.x - w - pad
    if (x < workArea.x + 8) x = Math.round(b.x + b.width / 2 - w / 2)
    x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - w - 8))
    // 纵向跟她顶部对齐，夹进工作区
    let y = b.y
    y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - h - 8))
    bw.setPosition(x, y, false)
  } catch {}
}

/** 和输入条一样压在桌宠之上（Windows 上 setAlwaysOnTop 的 level 不区分，只有 moveTop 有效） */
function keepAbovePet(bw) {
  try {
    if (!bw || bw.isDestroyed()) return
    bw.setAlwaysOnTop(true, 'screen-saver')
    bw.moveTop()
  } catch {}
}
function openChild(key, { file, ...opts }) {
  const cur = childWins.get(key)
  if (cur && !cur.isDestroyed()) { cur.focus(); return cur }
  const w = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#0f131b',
    ...opts,
    webPreferences: {
      preload: path.join(ROOT, 'app', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 子窗口被挡住也不能停帧（编辑器预览要一直播）
      backgroundThrottling: false,
    },
  })
  w.loadURL(`${srv.url}/app/${file}`)
  childWins.set(key, w)
  w.on('closed', () => { if (childWins.get(key) === w) childWins.delete(key) })
  // 和输入条一样：摆在桌宠头顶上方，并且压在桌宠之上
  w.once('ready-to-show', () => { placeAbovePet(w); keepAbovePet(w) })
  w.on('show', () => { placeAbovePet(w); keepAbovePet(w) })
  return w
}

/** 桌宠挪了位置：挂在它上方的子窗口跟着走（200ms 防抖，拖动时别每帧搬） */
let auxFollowTimer = null
function followAuxWindows() {
  if (auxFollowTimer) return
  auxFollowTimer = setTimeout(() => {
    auxFollowTimer = null
    for (const bw of childWins.values()) {
      if (bw && !bw.isDestroyed() && bw.isVisible()) placeAbovePet(bw)
    }
    if (historyWin && !historyWin.isDestroyed() && historyWin.isVisible()) placeAbovePet(historyWin)
  }, 200)
}
/** 设置变了广播给所有窗口：覆盖层按新值立即生效，设置窗口刷新读数 */
function broadcastSettings() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('shell:changed', { ...settings })
  }
}

// ---------- 主动开口 ----------

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 在场判定：3 分钟没动 = 短暂走开，15 分钟 = 走远，45 分钟 = 大概出门了 */
const PRESENCE_STAGES = [
  { name: 'short', min: 3 },
  { name: 'long', min: 15 },
  { name: 'deep', min: 45 },
]

/** 调试用：PET_PRESENCE_FAST=1 时把三档压到 8s / 20s / 40s，第一次嘀咕 5s（验证链路用） */
const PRESENCE_FAST = process.env.PET_PRESENCE_FAST === '1'
if (PRESENCE_FAST) {
  PRESENCE_STAGES[0].min = 8 / 60
  PRESENCE_STAGES[1].min = 20 / 60
  PRESENCE_STAGES[2].min = 40 / 60
}

function presenceStage(idleSec) {
  let stage = 'here'
  for (const s of PRESENCE_STAGES) if (idleSec >= s.min * 60) stage = s.name
  return stage
}

/** 她「一个人在家」时嘀咕的间隔：越久越稀疏（短/长/深三档） */
const AWAY_SCHEDULE = {
  short: { first: 20_000, gap: 180_000, max: 2 },
  long: { first: 150_000, gap: 600_000, max: 3 },
  deep: { first: 420_000, gap: 1_800_000, max: 2 },
}
if (PRESENCE_FAST) {
  // 调试档：把"第一次嘀咕"压到几秒，方便确认气泡真的会出现
  AWAY_SCHEDULE.short.first = 5_000
  AWAY_SCHEDULE.long.first = 12_000
  AWAY_SCHEDULE.deep.first = 20_000
  for (const k of Object.keys(AWAY_SCHEDULE)) AWAY_SCHEDULE[k].gap = 30_000
}

/** 给她的一段「旁白」：不是用户发言，而是导演提示。她自己决定说什么，或者不说话 */
let moodContext = ''
let moodContextAt = 0

function proactiveNudge({ kind = 'alone', awayMin = 0, extra = null } = {}) {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const idleMin = Math.max(1, Math.round((Date.now() - lastActivityAt) / 60000))
  const lastSaid = proactive?.lastSaid
  const tail = lastSaid ? `你上次自己开口说的是「${lastSaid}」，别重复。` : ''
  const clock = `现在是 ${hh}:${mm}，${WEEKDAYS[d.getDay()]}。`
  // 她自己得知道这一身是什么——不然换完装会忘了自己戴没戴眼镜
  const wearing = settings?.look ? `你身上现在是：${describeLook(settings.look)}。` : ''
  // 渲染层报上来的当下心情（10 分钟内有效）：让她的语气跟刚被摸/刚聊完的状态对上
  const mood = moodContext && Date.now() - moodContextAt < 600000 ? `你现在的心情：${moodContext}。` : ''
  if (kind === 'away') {
    return (
      `（旁白：主人已经 ${awayMin} 分钟没碰鼠标键盘了，大概是走开了，屋里只剩你一个人。${clock}${wearing}${mood}` +
      `可以小声嘀咕一句——像自言自语，或者跟空屋子说；不要问"你去哪了"，不要等他回答，也不要连着说好几句。` +
      `${tail}实在没什么想说的，就只回 [[silent]]。）`
    )
  }
  if (kind === 'musicfail') {
    const want = String(extra?.keyword || '').slice(0, 40)
    return (
      `（旁白：你刚想给他放《${want}》，但是曲库没搜到合适的（可能只有翻唱/伴奏）。${clock}${wearing}${mood}` +
      `说一句很短的——别用系统腔，别解释技术原因；可以说「这首暂时没有」「换个别的吧」，也可以直接推荐一首你手上有把握的。${tail}）`
    )
  }
  if (kind === 'musicpick') {
    const opts = (extra?.options || []).map((x) => `「${String(x).slice(0, 24)}」`).join('、')
    return (
      `（旁白：他想让你放一个歌单，但你的歌单里有好几个都能对上：${opts || '（没拿到名字）'}。` +
      `别自己挑，也别放任何一首——用一句话问他想听哪个，把候选名字念出来，越短越好。` +
      `${clock}${wearing}${mood}真拿不准就只回一句反问。）`
    )
  }
  if (kind === 'music') {
    const nm = String(extra?.name || '').slice(0, 40)
    const ar = String(extra?.artists || '').split(' / ')[0].slice(0, 24)
    const why = extra?.reason === 'ended' ? '刚刚放完这一首，自动接着放下一首' : '刚刚换到这一首'
    return (
      `（旁白：唱片机${why}，现在放的是《${nm}》${ar ? '，' + ar : ''}。${clock}${wearing}${mood}` +
      `你在心里嘀咕一句——像自言自语，不是介绍曲目；可以评价一句调子/情绪，也可以顺着这个气氛说点别的。` +
      `不要报歌名歌手，不要说"正在播放"，不要说"我可以帮你"。只一两句话。${tail}真不想说就只回 [[silent]]。）`
    )
  }
  if (kind === 'balance') {
    const b = balanceState
    const money = '¥' + Number(b?.total || 0).toFixed(2)
    return (
      `（旁白：你刚瞥了一眼账户，余额只剩 ${money} 了（今日已用约 ¥${Number(b?.used || 0).toFixed(2)}）。${clock}${wearing}${mood}` +
      `说一句就很短——提醒他该充点了，语气别像客服，也别报一串数字；可以带点自己的小算盘（怕他哪天没钱了就没得聊 / 嫌他花得快）。${tail}）`
    )
  }
  if (kind === 'return') {
    return (
      `（旁白：主人刚刚回来，之前离开了 ${awayMin} 分钟（键盘鼠标一直没动，现在动了）。${clock}${wearing}${mood}` +
      `先有反应再说话：抬头看他一眼，然后说一句很短的——可以带点情绪（松一口气 / 假装没在意 / 小声抱怨），` +
      `不要说"欢迎回来"这种客气话，不用问"你去哪了"，一句就够。${tail}）`
    )
  }
  return (
    `（旁白：此刻没有人跟你说话。${clock}${wearing}${mood}` +
    `主人已经 ${idleMin} 分钟没碰过你了，桌宠窗口开着，她可能还在电脑前。` +
    `${tail}` +
    `想开口就自然地讲一两句——像突然想起一件事，或者忍不住嘀咕一句；` +
    `不要问"有什么事吗/怎么了"，不要报"我在"，不要解释你在做什么。` +
    `实在没什么想说的，就只回 [[silent]]，不要硬凑。）`
  )
}

function proactiveLogLine(obj) {
  try {
    if (!proactiveLog) proactiveLog = path.join(app.getPath('userData'), 'stage-proactive.jsonl')
    appendFileSync(proactiveLog, JSON.stringify(obj) + '\n')
  } catch {}
}

/** 真正说一句：走和正常回话同一条流，只是消息体是旁白 */
async function runProactive({ manual = false, kind = 'alone', awayMin = 0, extra = null } = {}) {
  if (!brain) return { ok: false, error: '没有可用的脑子' }
  if (chatStreaming) return { ok: false, error: 'busy' }
  const id = ++chatSeq
  chatStreaming = id
  const send = (ev) => {
    try { win?.webContents.send('brain:ev', { id, source: 'proactive', ...ev }) } catch {}
  }
  const nudge = proactiveNudge({ kind, awayMin, extra })
  console.log('[proactive] 旁白：', nudge.slice(0, 160).replace(/\s+/g, ' '))
  send({ t: 'state', state: 'thinking' })
  let full = ''
  let silent = false
  const usedTools = []
  try {
    for await (const ev of brain.chat({ text: nudge, sessionId: chatStore?.sessionId })) {
      if (ev.t === 'delta') full += ev.text
      if (ev.t === 'tool' && Array.isArray(ev.names)) usedTools.push(...ev.names)
      if (ev.t === 'done') {
        const text = String(ev.full || full || '')
        // 「不想说话」：整句只有 [[silent]]（或空的）—— 不出气泡，什么都不显示
        if (!text.replace(/\[\[[^\]]*\]\]/g, '').trim() && /silent/i.test(text)) {
          silent = true
          continue
        }
      }
      send(ev)
    }
  } catch (err) {
    send({ t: 'error', message: String(err?.message || err) })
  } finally {
    if (id === chatSeq) chatStreaming = null
    send({ t: 'state', state: 'idle' })
    if (silent) send({ t: 'silent' })
    if (full.trim()) {
      proactive?.noteSaid(full.replace(/\[\[[^\]]*\]\]/g, '').trim())
      chatStore?.append({ role: 'pet', text: full, proactive: true, tools: [...new Set(usedTools)] })
    }
    proactiveLogLine({ at: new Date().toISOString(), manual, kind, awayMin, nudge, reply: full, silent })
  }
  return { ok: true, id, silent }
}

function startProactive() {
  if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null }
  const mode = String(settings.proactive || 'few')
  if (mode === 'off') {
    proactive = null
    console.log('[proactive] 已关闭')
    return
  }
  proactive = createProactive({
    freq: FREQUENCY[mode] || FREQUENCY.few,
    log: (m) => console.log(m),
    getState: () => ({
      // 只认"页面报告过的活动"：鼠标穿透状态下光标停在她身上说明不了什么
      idleMs: Math.max(0, Date.now() - lastActivityAt),
      // 回话中就不开口
      chatting: !!chatStreaming,
      busy: false,
      lastChatAt,
      proactive: mode,
      quiet: { from: settings.quietFrom || '23:30', to: settings.quietTo || '07:30' },
    }),
    onSpeak: () => { void runProactive() },
  })
  proactiveTimer = setInterval(() => proactive?.tick(), 30_000)
  console.log(`[proactive] 已启动，档位 ${mode}，下一次 ${new Date(proactive.nextAt).toLocaleTimeString()}`)
}

// ---------- 在场感：主人走开了 / 回来了 ----------

let presence = 'here'
let presenceTimer = null
let idlePeakSec = 0
let away = { stage: null, said: 0, since: 0, timer: null }

function inNightHours() {
  // 复用勿扰时段：夜里她自己也要睡，不嘀咕
  const from = String(settings.quietFrom || '23:30')
  const to = String(settings.quietTo || '07:30')
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0) }
  const d = new Date()
  const cur = d.getHours() * 60 + d.getMinutes()
  const a = toMin(from)
  const b = toMin(to)
  if (a === b) return false
  return a < b ? cur >= a && cur < b : cur >= a || cur < b
}

function clearAway() {
  if (away.timer) clearTimeout(away.timer)
  away = { stage: null, said: 0, since: 0, timer: null }
}

function scheduleAway() {
  const cfg = AWAY_SCHEDULE[away.stage]
  if (!cfg || away.timer) return
  if (!settings.awayTalk) return
  // 夜里不做特殊处理：主人这会儿还亮着屏，她本来就该念叨两句（催睡是她的性格）
  if (away.said >= cfg.max) return
  const delay = away.said === 0 ? cfg.first : cfg.gap
  console.log(`[presence] 走开（${away.stage}）：第 ${away.said + 1} 句将在 ${Math.round(delay / 1000)}s 后`)
  away.timer = setTimeout(async () => {
    away.timer = null
    if (presence !== away.stage) return
    if (chatStreaming) { scheduleAway(); return }
    away.said += 1
    const mins = Math.max(1, Math.round(powerMonitor.getSystemIdleTime() / 60))
    console.log(`[presence] 一个人在家 ${mins} 分钟，第 ${away.said} 次嘀咕`)
    await runProactive({ kind: 'away', awayMin: mins })
    scheduleAway()
  }, delay)
}

function onAway(stage) {
  clearAway()
  away = { stage, said: 0, since: Date.now(), timer: null }
  scheduleAway()
}

function onReturn(prevStage, awayMin) {
  clearAway()
  if (prevStage === 'here') return
  if (!settings.awayTalk) return
  if (awayMin < 1) return
  console.log(`[presence] 主人回来了，离开了 ${awayMin} 分钟`)
  // 先让她抬头看他一眼，再说一句短的（动作由人格给的 [[act:…]] 决定）
  setTimeout(() => {
    if (presence !== 'here') return
    if (!chatStreaming) void runProactive({ kind: 'return', awayMin })
  }, 700)
}

function startPresence() {
  if (presenceTimer) clearInterval(presenceTimer)
  presenceTimer = setInterval(() => {
    const idleSec = powerMonitor.getSystemIdleTime()
    idlePeakSec = Math.max(idlePeakSec, idleSec)
    const stage = presenceStage(idleSec)
    if (stage !== presence) {
      const prev = presence
      presence = stage
      const awayMin = Math.round(idlePeakSec / 60)
      console.log(`[presence] ${prev} → ${stage}（静止 ${idleSec}s）`)
      try { win?.webContents.send('presence:change', { stage, idleSec, awayMin }) } catch {}
      if (stage === 'here') {
        onReturn(prev, awayMin)
        idlePeakSec = 0
      } else {
        onAway(stage)
      }
    }
    // 有人动了就把峰值清掉（避免下次回来报一个夸张的时长）
    if (idleSec < 5) idlePeakSec = idleSec
  }, 5_000)
  console.log('[presence] 在场判定已启动（3 / 15 / 45 分钟）')
  const idle0 = powerMonitor.getSystemIdleTime()
  console.log(`[presence] 当前静止 ${idle0}s → ${presenceStage(idle0)}`)
}

// ---------- IPC ----------
// ── 余额（DeepSeek 钱包）──────────────────────────────────────────────
// 只做展示：余额来自 dsh-pet 的 balance section；「今日已用」没有官方接口，
// 用「今天第一次看到的余额 - 当前余额」估算，充值（余额变多）就重置起点。
let balanceState = null
let balanceDay = null // {date, start}
function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}
function loadBalanceDay() {
  if (balanceDay) return balanceDay
  try {
    const p = path.join(app.getPath('userData'), 'balance-day.json')
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (j && typeof j.date === 'string' && Number.isFinite(Number(j.start))) balanceDay = { date: j.date, start: Number(j.start) }
    }
  } catch {}
  return balanceDay
}
function saveBalanceDay() {
  try {
    if (!balanceDay) return
    writeFileSync(path.join(app.getPath('userData'), 'balance-day.json'), JSON.stringify(balanceDay))
  } catch {}
}
function bjYesterday(today) {
  const d = new Date(today + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)

}
/** 低余额提醒：5 元提醒一次、2 元再提醒一次，当天同一档只提醒一次（记在 balance-day.json） */
const BALANCE_WARN_LEVELS = [5, 2]
function maybeWarnBalance(total) {
  if (process.env.PET_BALANCE_DEBUG) {
    flog(`[balance] warn-check total=${total} idle=${Math.round((Date.now()-lastActivityAt)/1000)}s streaming=${!!chatStreaming}`)
  }
  const lvl = BALANCE_WARN_LEVELS.find((v) => Number(total) < v)
  if (!lvl) return
  const day = loadBalanceDay()
  if (!day) return
  const warned = Array.isArray(day.warned) ? day.warned : []
  if (warned.includes(lvl)) return
  // 正在说话 / 主动开口关着 —— 都不打扰；同一档当天只提醒一次
  if (chatStreaming) return
  if (!settings?.proactive || settings.proactive === 'off') return
  day.warned = [...warned, lvl]
  saveBalanceDay()
  flog(`[balance] 低于 ¥${lvl}，让她提醒一次`)
  setTimeout(() => { void runProactive({ kind: 'balance' }) }, 1200)
}
function applyBalance(b) {
  const today = bjToday()
  const prev = balanceState
  let day = loadBalanceDay()
  if (!day || day.date !== today) {
    // 跨天：如果昨天最后采样还在，就用它当今天的起点（这样「今日已用」才是真的）
    const startFromYesterday = day && day.date === bjYesterday(today) && Number.isFinite(Number(day.lastTotal))
    day = { date: today, start: startFromYesterday ? Number(day.lastTotal) : b.total }
  }
  // 充值（余额变大）→ 今天从充值后的余额重新起算
  if (prev && b.total > prev.total + 0.0001) day = { date: today, start: b.total }
  day.lastTotal = b.total
  if (!balanceDay || balanceDay.date !== day.date || balanceDay.start !== day.start) {
    balanceDay = day
    saveBalanceDay()
  }
  const used = Math.max(0, Number((day.start - b.total).toFixed(2)))
  balanceState = { ...b, used, dayStart: day.start }
  flog(`[balance] total=${b.total} full=${b.full ?? '-'} used=${used}`)
  if (win && !win.isDestroyed()) win.webContents.send('balance:state', balanceState)
  maybeWarnBalance(b.total)
}


// ---------- 唱片机窗口 ----------
let playerWin = null
let nowPlaying = null
// 播放队列：一首歌也能成队（index 0 / length 1），这样 ⏮⏭ 永远有明确语义
let queue = []
let queueIndex = -1
// 漫游：队列快到头时按「设置里选的源」补歌；缓存 + 串行 + 退避，别把接口打疼
const roamCache = new Map()   // key -> { at, songs }
const ROAM_TTL = 24 * 3600 * 1000
let roamBusy = false
let roamCooldownUntil = 0
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

function roamKey(kind, id) { return kind + ':' + id }

async function roamPick(kind, song) {
  const key = roamKey(kind, song?.id || 0)
  const hit = roamCache.get(key)
  if (hit && Date.now() - hit.at < ROAM_TTL) return hit.songs
  if (Date.now() < roamCooldownUntil) return []
  let songs = []
  try {
    if (kind === 'similar') songs = await ncm.similarSongs(song.id, 5)
    else if (kind === 'artist') {
      const aid = await ncm.songArtistId(song.id)
      if (aid) songs = await ncm.artistTopSongs(aid, 50)
    } else if (kind === 'daily') songs = await ncm.dailyRecommend()
    else if (kind === 'hot') songs = await ncm.hotChart(200)
  } catch (e) {
    const msg = String(e?.message || '')
    flog('[roam] 取源失败', kind, msg.slice(0, 80))
    if (/-460|风险|频繁/.test(msg)) roamCooldownUntil = Date.now() + 2 * 60 * 1000
    return []
  }
  roamCache.set(key, { at: Date.now(), songs })
  return songs
}

/** 把「没听过的」歌补进队列；返回补了几首 */
async function roamRefill() {
  if (roamBusy) return 0
  const song = nowPlaying
  if (!song?.id) return 0
  roamBusy = true
  try {
    const want = Math.max(1, Number(settings.roamSource ? 1 : 1))
    const have = new Set(queue.map((s) => s.id))
    const sources = []
    const first = settings.roamSource || 'similar'
    sources.push(first)
    if (settings.deepRoam) sources.push('similar', 'artist')
    sources.push('artist', 'daily', 'hot')
    let added = 0
    for (const kind of sources) {
      const list = await roamPick(kind, song)
      for (const s of list) {
        if (!s?.id || have.has(s.id) || s.id === song.id) continue
        have.add(s.id)
        queue.push(s)
        added++
        if (added >= (settings.deepRoam ? 24 : 8)) break
      }
      if (added >= (settings.deepRoam ? 24 : 8)) break
      await sleepMs(1600)   // 串行 + 间隔
    }
    if (added) {
      flog('[roam] 补歌', added, '首，来源', first, settings.deepRoam ? '(深度)' : '')
      try { playerWin?.webContents.send('player:queue', { pos: { i: queueIndex, n: queue.length } }) } catch {}
    }
    return added
  } finally { roamBusy = false }
}

// 歌单缓存：进唱片机先给上次的，再后台刷；10 分钟内不重复请求
let playlistsCache = { at: 0, uid: 0, items: [] }
// 用户这次说的是「放歌单」时，她若又自己猜了个歌名，就忽略那次（20 秒窗口）
let playTagMuteUntil = 0
async function listPlaylists(force = false) {
  if (!ncm.hasLogin()) return { ok: false, error: '还没登录', items: [], at: 0 }
  const uid = Number(ncm.profileInfo()?.userId || 0)
  const fresh =
    !force && playlistsCache.at && playlistsCache.uid === uid && Date.now() - playlistsCache.at < 10 * 60 * 1000
  if (fresh) return { ok: true, items: playlistsCache.items, at: playlistsCache.at, cached: true }
  const items = await ncm.playlists(uid)
  playlistsCache = { at: Date.now(), uid, items }
  return { ok: true, items, at: playlistsCache.at }
}

function setQueue(list) {
  queue = Array.isArray(list) ? list.filter((s) => s && s.id).slice(0, 200) : []
  queueIndex = queue.length ? 0 : -1
  return queue
}

function playerBounds() {
  const b = win?.getBounds?.() || { x: 200, y: 120, width: 440, height: 820 }
  const saved = settings.playerBounds
  if (saved && Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
    return { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.round(saved.w), height: Math.round(saved.h) }
  }
  const { width: w, height: h } = playSize()
  const area = screen.getDisplayMatching(b).workArea
  let x = b.x + b.width + 10
  if (x + w > area.x + area.width - 8) x = b.x - w - 10
  if (x < area.x + 8) x = Math.round(area.x + (area.width - w) / 2)
  let y = Math.max(area.y + 8, Math.min(b.y, area.y + area.height - h - 8))
  return { x: Math.round(x), y: Math.round(y), width: w, height: h }
}

function playSize() {
  return { width: settings.playerW || 380, height: settings.playerH || 600 }
}

/** 给所有窗口广播（设置窗、舞台窗都要收到登录状态） */
function broadcastAll(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload) } catch {}
  }
}

let qrPoll = null

/** 扫码登录：把网易云的登录页丢到系统浏览器，主进程自己轮询；不用在应用里画二维码 */
async function startQrLogin() {
  if (qrPoll) { clearInterval(qrPoll); qrPoll = null }
  const { key, url } = await ncm.qrKey()
  flog('[music] 二维码已生成')
  try { await shell.openExternal(url) } catch (e) { flog('[music] 打开登录页失败', e.message) }
  let ticks = 0
  qrPoll = setInterval(async () => {
    ticks += 1
    try {
      const r = await ncm.qrCheck(key)
      broadcastAll('music:qrstate', { code: r.code, message: r.message })
      if (r.code === 803) {
        clearInterval(qrPoll); qrPoll = null
        await ncm.refreshProfile()
        const info = ncm.profileInfo()
        flog('[music] 登录成功', info?.nickname || '')
        broadcastAll('music:qrstate', { code: 803, profile: info })
      } else if (r.code === 800 || ticks > 90) {
        clearInterval(qrPoll); qrPoll = null
      }
    } catch (e) {
      if (ticks > 5) { clearInterval(qrPoll); qrPoll = null }
    }
  }, 2000)
  return { ok: true, key, url }
}
async function ensurePlayerWindow() {
  if (playerWin && !playerWin.isDestroyed()) return playerWin
  playerWin = new BrowserWindow({
    ...playerBounds(),
    show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: true, minWidth: 320, minHeight: 440, maxWidth: 900, maxHeight: 1200, minimizable: false, maximizable: false, skipTaskbar: true,
    hasShadow: false, alwaysOnTop: true,
    webPreferences: {
      preload: path.join(ROOT, 'app', 'player-preload.cjs'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  })
  playerWin.setAlwaysOnTop(true, 'screen-saver')
  // 拖过 / 拉过大小就记住，下次还在这
  const remember = () => {
    try {
      if (playerWin.isFullScreen?.()) return // 海报模式的全屏尺寸别存进去
      const b = playerWin.getBounds()
      settings.playerW = b.width
      settings.playerH = b.height
      settings.playerBounds = { x: b.x, y: b.y, w: b.width, h: b.height }
      saveSettings()
    } catch {}
  }
  playerWin.on('moved', remember)
  playerWin.on('resized', remember)
  await playerWin.loadURL(`${srv.url}/app/player.html`)
  playerWin.on('closed', () => { playerWin = null })
  return playerWin
}

// 「她对正在放的歌说一句」：门控都在这一处，playSong / player:ended 只负责报告事件
const musicTalk = { lastAt: 0, hourAt: [], songIds: new Set() }
function musicTalkAllowed(song, playedMs) {
  if (settings.musicTalk === false) return 'off'
  if (inNightHours()) return 'night'
  if (chatStreaming) return 'busy'
  if (!brain) return 'nobrain'
  const now = Date.now()
  if (now - musicTalk.lastAt < 12 * 60 * 1000) return 'cooldown'
  musicTalk.hourAt = musicTalk.hourAt.filter((t) => now - t < 3600 * 1000)
  if (musicTalk.hourAt.length >= 2) return 'hourly'
  const id = String(song?.id || '')
  if (id && musicTalk.songIds.has(id)) return 'repeat'
  if (playedMs != null && playedMs < 20000) return 'tooshort'
  return null
}
async function maybeMusicComment(song, reason, playedMs) {
  const why = musicTalkAllowed(song, playedMs)
  if (why) { flog('[music-talk] 跳过：' + why); return { ok: false, error: why } }
  const id = String(song?.id || '')
  if (id) musicTalk.songIds.add(id)
  musicTalk.lastAt = Date.now()
  musicTalk.hourAt.push(musicTalk.lastAt)
  // 说话时把音乐压一下，2.2 秒后恢复（她开口别被伴奏盖住）
  try { playerWin?.webContents.send('player:duck', 0.28) } catch {}
  setTimeout(() => { try { playerWin?.webContents.send('player:duck', 1) } catch {} }, 4200)
  flog('[music-talk]', reason, song?.name || '')
  return runProactive({ kind: 'music', extra: { name: song?.name, artists: song?.artists, reason } })
}

async function playSong(song, opts = {}) {
  const prevStartedAt = nowPlaying?.startedAt || 0
  if (opts.replaceQueue) setQueue([song])
  if (!queue.length) setQueue([song])
  nowPlaying = { id: song.id, name: song.name, artists: song.artists || '', album: song.album || '', pic: song.pic || '', dur: song.dur || song.duration || 0, at: Date.now(), startedAt: Date.now(), playing: true }
  try {
    const w = await ensurePlayerWindow()
    w.setBounds(playerBounds(), false)
    w.webContents.send('player:load', {
      song: nowPlaying,
      stage: srv.url,
      token,
      pos: { i: queueIndex < 0 ? 0 : queueIndex, n: queue.length },
    })
    if (settings.player !== false) { w.showInactive(); w.moveTop() }
  } catch (e) {
    flog('[music] 唱片机打开失败', e.message)
  }
  flog('[music] 播放', nowPlaying.name, nowPlaying.artists)
  try { win?.webContents.send('music:now', nowPlaying) } catch {}
  if (opts.talk !== false) {
    const playedMs = prevStartedAt ? Date.now() - prevStartedAt : null
    void maybeMusicComment(nowPlaying, opts.reason || 'switch', playedMs)
  }
  return { ok: true, song: nowPlaying, pos: { i: queueIndex, n: queue.length } }
}

/** 从队列里播第 i 首（越界返回 false，不抛） */
async function playAt(i, opts = {}) {
  if (!Number.isInteger(i) || i < 0 || i >= queue.length) return { ok: false, error: '队列到头了' }
  queueIndex = i
  return playSong(queue[i], opts)
}

/** 加进队尾，不打断当前这首 */
function enqueueSong(song) {
  if (!song?.id) return { ok: false, error: '没找到这首歌' }
  if (queue.length >= 200) return { ok: false, error: '队列满了' }
  queue.push(song)
  try { playerWin?.webContents.send('player:queue', { pos: { i: queueIndex, n: queue.length } }) } catch {}
  return { ok: true, size: queue.length }
}

// 播放模式：order 顺序（到结尾就停）/ loop 列表循环 / shuffle 随机
let playMode = 'loop'
function pickShuffle() {
  if (queue.length < 2) return queueIndex
  let i = queueIndex
  while (i === queueIndex) i = Math.floor(Math.random() * queue.length)
  return i
}
async function nextTrack(opts = {}) {
  if (playMode === 'roam' && queueIndex >= queue.length - 1) {
    await roamRefill()
  }
  if (!queue.length) return { ok: false, error: '队列是空的' }
  if (playMode === 'shuffle') return playAt(pickShuffle(), opts)
  const i = queueIndex + 1
  if (i >= queue.length) {
    if (playMode === 'loop') return playAt(0, opts)
    return { ok: false, error: '队列到头了' }
  }
  return playAt(i, opts)
}
async function prevTrack() {
  // 播过 3 秒就先回到这首开头（和大多数播放器一致）
  if (nowPlaying && nowPlaying.startedAt && Date.now() - nowPlaying.startedAt > 3000) {
    try { playerWin?.webContents.send('player:seek', { at: 0 }) } catch {}
    return { ok: true, restart: true }
  }
  if (playMode === 'shuffle') return playAt(pickShuffle())
  const i = queueIndex - 1
  if (i < 0) return playMode === 'loop' ? playAt(queue.length - 1) : { ok: false, error: '已经是第一首' }
  return playAt(i)
}

function hidePlayer() {
  // 只藏不关：藏起来音乐继续放，右键「唱片机」再点开就能回到刚才那首
  try { playerWin?.hide() } catch {}
}

/** 隐藏后再打开：没在放就摆一个占位；正在放就原样显示，不重头开始 */
async function showPlayer() {
  try {
    const w = await ensurePlayerWindow()
    w.setBounds(playerBounds(), false)
    if (!nowPlaying) w.webContents.send('player:idle', { stage: srv.url, token })
    w.showInactive()
    w.moveTop()
    return { ok: true, playing: !!nowPlaying }
  } catch (e) {
    flog('[music] 唱片机打开失败', e.message)
    return { ok: false, error: e.message }
  }
}
function wireIpc() {
  ipcMain.handle('shell:get', () => ({ ...settings, token, port: srv?.port || null }))
  ipcMain.handle('shell:set', async (_e, patch = {}) => {
    flog('[settings] 保存：', Object.keys(patch || {}).join(','), '→', JSON.stringify(patch).slice(0, 160))
    settings = { ...settings, ...patch }
    if (patch.width || patch.height) {
      win?.setContentSize(Math.round(settings.width), Math.round(settings.height))
    }
    applyWindowSettings()
    // 主动说话的档位/勿扰时段改了要立刻生效，不能等下次启动
    if ('proactive' in patch || 'quietFrom' in patch || 'quietTo' in patch) startProactive()
    if ('workLink' in patch) workLink?.refresh()
    await saveSettings()
    broadcastSettings()
    return { ...settings }
  })
  ipcMain.handle('model:choose', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择 Live2D 模型（.model3.json）',
      properties: ['openFile'],
      filters: [{ name: 'Live2D 模型', extensions: ['model3.json'] }],
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false }
    settings.model = r.filePaths[0]
    await saveSettings()
    setTimeout(() => { app.relaunch(); app.exit(0) }, 60)
    return { ok: true, model: settings.model }
  })
  ipcMain.on('win:move', (_e, { dx = 0, dy = 0, clamp = false } = {}) => {
    if (!win) return
    const ix = Math.round(dx)
    const iy = Math.round(dy)
    if (!ix && !iy) return
    if (process.env.STAGE_DEBUG_MOVE) console.log('[move]', ix, iy)
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    let nx = x + ix
    let ny = y + iy
    if (clamp) {
      // 输入条要露出来时用这条：夹进可用区，别把整窗推到屏幕外
      const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea
      const c = clampToWorkArea(nx, ny, w, h, area)
      nx = c.x
      ny = c.y
    }
    // 一次 setBounds 到整数坐标：连续 setPosition 在透明窗口上更容易被 DWM 重组出白闪。
    win.setBounds({ x: nx, y: ny, width: w, height: h }, false)
    win.webContents.send('pet:pos', { x: nx, y: ny })
    if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) placeChatWindow()
    followAuxWindows()
  })
  // ---------- 改动补丁：记录我们这层加的姿势/台词/反应/热区，发布时只发这个文件 ----------
  const patchFile = () => path.join(app.getPath('userData'), 'stage-patch.json')
  ipcMain.handle('patch:save', async (_e, data) => {
    try {
      await mkdir(path.dirname(patchFile()), { recursive: true })
      await writeFile(patchFile(), JSON.stringify(data, null, 2))
      return { ok: true, file: patchFile() }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  })
  ipcMain.handle('patch:load', async () => {
    try { return JSON.parse(await readFile(patchFile(), 'utf8')) } catch { return null }
  })
  // ---------- 动作编辑器：存 / 读动作 JSON + 打开编辑窗口 ----------
  const actionsFile = () => path.join(app.getPath('userData'), 'actions.json')
  ipcMain.handle('actions:save', async (_e, data) => {
    try {
      await mkdir(path.dirname(actionsFile()), { recursive: true })
      await writeFile(actionsFile(), JSON.stringify(data, null, 2))
      return { ok: true, file: actionsFile() }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  })
  ipcMain.handle('actions:load', async () => {
    try { return JSON.parse(await readFile(actionsFile(), 'utf8')) } catch { return null }
  })
  ipcMain.on('shell:editor', () => openChild('editor', {
    file: 'editor.html',
    width: 1240, height: 840, minWidth: 900, minHeight: 620,
    title: '动作编辑器 · Live2D Stage',
  }))
  ipcMain.on('shell:settings', () => openChild('settings', {
    file: 'settings.html',
    width: 700, height: 600, minWidth: 620, minHeight: 520,
    title: '设置 · 大肥鱼',
  }))
  // ---------- 设置窗口 → 舞台窗口的 RPC ----------
  // 设置窗口不重复加载模型：它只发指令、拿快照，真正的状态都在舞台窗口里。
  ipcMain.handle('stage:rpc', async (_e, op, payload) => {
    if (!win || win.isDestroyed()) return { ok: false, error: '舞台窗口还没起来' }
    try {
      const value = await win.webContents.executeJavaScript(
        `window.__stageRpc(${JSON.stringify(String(op || ''))}, ${JSON.stringify(payload ?? null)})`,
        true,
      )
      return { ok: true, value }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })
  ipcMain.on('win:center', () => {
    if (!win) return
    const { workArea } = screen.getPrimaryDisplay()
    const [w, h] = win.getSize()
    win.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + (workArea.height - h) / 2))
  })
  // 透明处穿透：渲染层拿 alpha 掩码判定指针在不在角色身上，不在就忽略鼠标
  // （forward: true 保证忽略鼠标时仍能收到 mousemove，挪回角色身上可以自己收回来）
  ipcMain.handle('tts:status', () => ({ state: ttsState, reason: ttsStateReason, url: settings.ttsUrl || TTS_URL, python: settings.ttsPython || '' }))
  ipcMain.handle('tts:restart', async () => { stopTts(); await ensureTts({ force: true }); return { state: ttsState } })
  ipcMain.handle('debug:top', () => ({
    petTop: win?.isAlwaysOnTop?.() ?? null,
    chatTop: chatWin?.isAlwaysOnTop?.() ?? null,
    chatVisible: !!chatVisible,
    petFocused: !!win?.isFocused?.(),
    chatFocused: !!chatWin?.isFocused?.(),
  }))
  ipcMain.handle('shell:debug-hit', (_e, cx, cy) => {
    const hit = maskHit(cx, cy)
    return {
      hit,
      chrome: chromeHit(cx, cy),
      chromeCount: chromeRects.length,
      dynamicIgnore,
      maskCount,
      age: Date.now() - maskAt,
      mask: hitMask ? [hitMask.w, hitMask.h] : null,
      view: hitMask?.view ?? null,
      box: hitBox ? [hitBox.x, hitBox.y, hitBox.w, hitBox.h] : null,
      rect: hitMask ? [hitMask.x, hitMask.y, hitMask.cw, hitMask.ch] : null,
      bit: (() => {
        if (!hitMask) return null
        const gx = Math.floor(((cx - hitMask.x) / hitMask.cw) * hitMask.w)
        const gy = Math.floor(((cy - hitMask.y) / hitMask.ch) * hitMask.h)
        if (gx < 0 || gy < 0 || gx >= hitMask.w || gy >= hitMask.h) return -1
        return hitMask.bits[gy * hitMask.w + gx]
      })(),
    }
  })
  ipcMain.on('win:chrome', (_e, list) => {
    chromeRects = Array.isArray(list)
      ? list
          .filter((r) => r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0)
          .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }))
      : []
    chromeAt = Date.now()
    if (process.env.STAGE_DEBUG_HIT) console.log('[chrome]', chromeRects.length, JSON.stringify(chromeRects))
  })
  ipcMain.on('win:mask', (_e, m) => {
    // 窗口 resize 之后 GL 的 drawing buffer 会失效，掩码会读到"全透明"。
    // 这时候绝不能拿它当命中表 —— 否则整窗变成穿透，鼠标点不到她（小豆丁形态最容易碰上）。
    // 处理办法：作废这张表，退回"整窗可点"，等下一次有效掩码再恢复。
    if (m && m.invalid) {
      hitMask = null
      maskAt = 0
      // 有包围盒就用包围盒兜底（比"整窗可点"精确，又不会像全透明表那样点不到）
      if (m.box && m.box.w) hitBox = m.box
      return
    }
    if (!m || !m.w || !m.h || !m.bits) return
    maskCount++
    if (m.box && m.box.w) hitBox = m.box
    if (maskCount === 1) console.log('[mask] 首帧', m.w + 'x' + m.h, 'rect', m.x, m.y, m.cw, m.ch)
    else if (maskCount % 40 === 0) console.log('[mask] n=' + maskCount)
    hitMask = m
    maskAt = Date.now()
  })
  // 保留这个通道只为兼容旧页面/调试：真正的开关由 settings.clickThrough（手动）与 updateHit（自动）负责
  ipcMain.on('win:pass-through', (_e, v) => {
    console.log('[pass] 页面请求穿透=' + !!v + '（已忽略，改由主进程判定）')
  })
  ipcMain.handle('mood:load', () => {
    try { return JSON.parse(readFileSync(moodFile, 'utf8')) } catch { return null }
  })
  ipcMain.handle('mood:save', (_e, data) => {
    try { writeFileSync(moodFile, JSON.stringify(data)); return true } catch { return false }
  })
  ipcMain.handle('brain:info', () => ({ ...brainInfo(brain, brainState), sessionId: chatStore?.sessionId || null }))

  // 说一句：流式事件推给舞台（渲染层负责打字机 + 语义标记）
  // ---------- 对话记录 ----------
  // ---------- 音乐 / 唱片机 ----------
  ipcMain.handle('music:status', async () => ({
    login: ncm.hasLogin(),
    profile: ncm.profileInfo(),
    playing: nowPlaying,
    enabled: settings.player !== false,
  }))
  ipcMain.handle('music:qr', () => ncm.qrKey())
  ipcMain.handle('music:qrlogin', () => startQrLogin())
  ipcMain.handle('music:qrcheck', async (_e, key) => {
    const r = await ncm.qrCheck(String(key || ''))
    flog('[music] qrcheck code=' + r.code + (r.message ? ' msg=' + r.message : ''))
    if (r.code === 803) { try { const info = ncm.profileInfo(); broadcastAll('music:qrstate', { code: 803, profile: info }) } catch {} }
    return r
  })
  ipcMain.handle('music:logout', async () => { await ncm.logout(); return { ok: true } })
  ipcMain.handle('music:search', (_e, kw) => ncm.search(String(kw || ''), 12))
  /**
   * 「放我的某个歌单」：`#名字` 是歌单标记，`#名字 1` = 只随机抽一首。
   * 命中 0 个 → 返回 null（让调用方退化成歌名搜索）；
   * 命中多个 → 不瞎猜，回 ambiguous + 候选，让她去问用户「哪个」；
   * 命中 1 个 → 拉曲目，按 single 决定「整单入队」还是「随机一首」。
   */
  async function resolvePlaylist(raw, single) {
    const want = String(raw || '')
      .replace(/^#/, '')
      // 「我的喜欢歌单」「我喜欢的那个歌单」→ 去掉人称与后缀，只留核心词
      .replace(/我的|我|你的|他|她|的|歌单|列表|里面|里边|里|下/g, '')
      .replace(/[《》「」【】\s]/g, '')
      .toLowerCase()
    if (!want) return null
    const r = await listPlaylists(false)
    flog('[playlist] 列表', r.ok, (r.items || []).length)
    if (!r.ok || !r.items?.length) return null
    const hits = r.items
      .map((p) => ({ ...p, key: String(p.name || '').replace(/[《》「」【】\s]/g, '').toLowerCase() }))
      // 「我喜欢的音乐 / 红心 / 收藏」直接对到 specialType=5 那个歌单
      .filter((p) => p.key.includes(want) || want.includes(p.key) ||
        (p.special && /喜欢|红心|收藏|最爱/.test(want)))
    flog('[playlist] 匹配', want, '→', hits.map((h) => h.name).join(' / ') || '(无)')
    if (!hits.length) return null
    if (hits.length > 1) {
      // 名字更长的更具体；但如果几个长度相同（「我喜欢的音乐」和「我喜欢的歌单」），别猜
      const top = Math.max(...hits.map((h) => h.key.length))
      const best = hits.filter((h) => h.key.length === top)
      if (best.length === 1) return { list: best[0], single: !!single }
      return { ambiguous: hits.slice(0, 5).map((h) => h.name), single: !!single }
    }
    return { list: hits[0], single: !!single }
  }

  ipcMain.handle('music:play', async (_e, arg) => {
    const raw = String(arg?.keyword || '').trim()
    let song = arg?.song || null
    if (!song && Date.now() < playTagMuteUntil && !raw.startsWith('#')) {
      flog('[play] 忽略她猜的歌名（用户说的是歌单）：', raw)
      return { ok: true, skipped: true }
    }
    // 「#歌单名 [1]」→ 走歌单
    if (!song && raw.startsWith('#')) {
      const m = raw.match(/^#\s*(.+?)(?:\s+(1|随机|random))?$\s*/i)
      const name = (m?.[1] || '').trim()
      const single = !!(m?.[2])
      const hit = await resolvePlaylist(name, single)
      if (hit?.ambiguous) return { ok: false, error: 'ambiguous', options: hit.ambiguous }
      if (hit?.list) {
        const tracks = await ncm.playlistTracks(hit.list.id, 500)
        const list = tracks.filter((t) => t.id)
        if (!list.length) return { ok: false, error: `歌单「${hit.list.name}」是空的` }
        if (single) {
          const pick = list[Math.floor(Math.random() * list.length)]
          const r0 = await playSong(pick, { replaceQueue: true })
          return { ...r0, playlist: hit.list.name, picked: pick.name, of: list.length }
        }
        setQueue(list)
        const start = playMode === 'shuffle' ? Math.floor(Math.random() * list.length) : 0
        const r0 = await playSong(queue[start], {})
        return { ...r0, playlist: hit.list.name, of: list.length }
      }
      // 没命中歌单 → 退化成歌名搜索（去掉 #）
    }
    const kw = raw.replace(/^#/, '')
    if (!song && kw) song = ncm.pickBest(await ncm.search(kw, 12), kw)
    if (!song) return { ok: false, error: '没找到这首歌' }
    // 新点一首 = 重新起一个队列；以后「加进队列」走 music:enqueue
    return playSong(song, { replaceQueue: true })
  })
  ipcMain.handle('music:close', () => { hidePlayer(); return { ok: true } })
  ipcMain.handle('music:player', () => showPlayer())
  ipcMain.handle('player:config', () => ({ stage: srv?.url || '', token, fxOn: settings.fxOn !== false }))
  let posterPrev = null
  ipcMain.on('player:close', () => hidePlayer())
  // 海报模式：把窗口铺满当前显示器的可用区（透明无边框窗用 setFullScreen 不总是生效）
  ipcMain.on('player:poster', (_e, on) => {
    if (!playerWin || playerWin.isDestroyed()) return
    try {
      if (on) {
        if (!posterPrev) posterPrev = playerWin.getBounds()
        playerWin.setMaximumSize(20000, 20000) // 平时锁在 900×1200，海报模式要先放开
        const d = screen.getDisplayMatching(playerWin.getBounds()).workArea
        playerWin.setBounds({ x: d.x, y: d.y, width: d.width, height: d.height })
        playerWin.setAlwaysOnTop(true, 'screen-saver')
        flog('[player] 海报模式', d.width, 'x', d.height)
      } else {
        if (posterPrev) playerWin.setBounds(posterPrev)
        playerWin.setMaximumSize(900, 1200)
        posterPrev = null
      }
    } catch (e) { flog('[player] poster 失败', e.message) }
  })
  ipcMain.on('player:resize', (_e, size) => {
    if (!playerWin || playerWin.isDestroyed()) return
    const w = Math.max(320, Math.min(900, Math.round(size?.w || 0)))
    const h = Math.max(440, Math.min(1200, Math.round(size?.h || 0)))
    const b = playerWin.getBounds()
    if (b.width === w && b.height === h) return
    playerWin.setBounds({ x: b.x, y: b.y, width: w, height: h }, false)
  })
  ipcMain.on('player:state', (_e, st) => {
    if (!st) return
    nowPlaying = nowPlaying ? { ...nowPlaying, playing: !!st.playing } : nowPlaying
    try { win?.webContents.send('music:now', { playing: !!st.playing, id: st.id || 0 }) } catch {}
  })
  ipcMain.on('player:play-song', (_e, song) => {
    if (!song?.id) return
    const { queue: list, ...clean } = song
    // 从歌单来的：整个歌单进队列，并定位到点的那首
    if (Array.isArray(list) && list.length > 1) {
      const items = list.filter((t) => t?.id).map(({ queue: _q, ...t }) => t)
      const i = items.findIndex((t) => Number(t.id) === Number(song.id))
      setQueue(items)
      queueIndex = i >= 0 ? i : 0
      flog('[music] 歌单入队', items.length, '首 → 第', queueIndex + 1, '首开始')
      void playSong(queue[queueIndex])
      return
    }
    void playSong(clean, { replaceQueue: true })
  })
  ipcMain.on('player:enqueue-song', (_e, song) => { if (song?.id) return enqueueSong(song) })

  // 歌曲分析缓存（BPM/能量），键是网易云 id；只存数值，几十 KB
  const pvCacheFile = path.join(app.getPath('userData'), 'pv-analysis.json')
  let pvCache = null
  const loadPvCache = () => {
    if (pvCache) return pvCache
    try { pvCache = JSON.parse(readFileSync(pvCacheFile, 'utf8')) || {} } catch { pvCache = {} }
    return pvCache
  }
  const savePvCache = () => {
    try { writeFileSync(pvCacheFile, JSON.stringify(pvCache || {})) } catch (e) { flog('[pv] 缓存写入失败', e.message) }
  }
  ipcMain.handle('player:get-analysis', (_e, id) => loadPvCache()[String(id)] || null)
  ipcMain.on('player:set-analysis', (_e, { id, info } = {}) => {
    if (!id || !info) return
    loadPvCache()[String(id)] = { bpm: Number(info.bpm) || 0, energy: Number(info.energy) || 0, dur: Number(info.dur) || 0, at: Date.now() }
    savePvCache()
  })

  // 歌词 PV 配色：存在 settings.pvStyle，重启沿用
  ipcMain.handle('player:get-style', () => settings.pvStyle || 'ocean')
  ipcMain.on('player:set-style', (_e, id) => {
    const next = String(id || '').trim()
    if (!next || next === settings.pvStyle) return
    settings.pvStyle = next
    saveSettings()
    flog('[pv] 配色 →', next)
  })
  ipcMain.on('player:next', () => { void nextTrack() })
  ipcMain.on('player:prev', () => { void prevTrack() })
  ipcMain.on('player:ended', () => {
    const finished = nowPlaying ? { ...nowPlaying } : null
    const playedMs = finished?.startedAt ? Date.now() - finished.startedAt : null
    if (finished && playedMs && playedMs > 120000) void maybeMusicComment(finished, 'ended', playedMs)
    void nextTrack({ reason: 'ended', talk: false })
  })
  ipcMain.handle('player:get-mode', () => ({ mode: playMode }))
  ipcMain.handle('player:set-mode', (_e, m) => {
    playMode = ['order', 'loop', 'shuffle', 'roam'].includes(m) ? m : 'loop'
    settings.musicMode = playMode
    saveSettings?.()
    return { mode: playMode }
  })
  ipcMain.handle('music:queue', () => ({ items: queue, index: queueIndex }))
  ipcMain.handle('music:playlists', async (_e, arg) => {
    try {
      return await listPlaylists(!!arg?.force)
    } catch (e) {
      flog('[music] 歌单拉取失败', e.message)
      return { ok: false, error: e.message, items: [], at: 0 }
    }
  })
  ipcMain.handle('music:tracks', async (_e, id) => {
    try {
      const items = await ncm.playlistTracks(Number(id))
      return { ok: true, items }
    } catch (e) {
      flog('[music] 歌单曲目失败', e.message)
      return { ok: false, error: e.message, items: [] }
    }
  })
  ipcMain.handle('music:enqueue', async (_e, arg) => {
    // 加进队尾，不打断当前这首（P3 的歌单页会用）
    const kw = String(arg?.keyword || '').trim()
    let song = arg?.song || null
    if (!song && kw) song = ncm.pickBest(await ncm.search(kw, 12), kw)
    return enqueueSong(song)
  })
  ipcMain.handle('history:open', () => { void openHistoryWindow(); return { ok: true } })
  ipcMain.handle('chat:history', (_e, opts) => {
    const logPath = chatStore?.logPath
    if (!logPath) return { items: [], hasMore: false, total: 0 }
    return readHistory(logPath, opts || {})
  })
  ipcMain.handle('chat:clear', () => {
    try { writeFileSync(chatStore.logPath, '') } catch (err) { return { ok: false, error: String(err?.message || err) } }
    return { ok: true }
  })
  ipcMain.handle('chat:export', async () => {
    const logPath = chatStore?.logPath
    if (!logPath) return { ok: false }
    const total = readHistory(logPath, { limit: 1 }).total
    const { canceled, filePath } = await dialog.showSaveDialog(historyWin || win, {
      title: '导出对话记录',
      defaultPath: path.join(app.getPath('desktop'), `大肥鱼对话-${new Date().toISOString().slice(0, 10)}.txt`),
      filters: [{ name: '文本', extensions: ['txt'] }],
    })
    if (canceled || !filePath) return { ok: false }
    // 导出全部（分批取，避免一次读太多）
    let before = null
    const chunks = []
    for (let i = 0; i < 200; i++) {
      const page = readHistory(logPath, { limit: 500, before })
      if (!page.items.length) break
      chunks.unshift(...page.items)
      if (!page.hasMore) break
      before = page.items[0].at
    }
    const pad = (n) => String(n).padStart(2, '0')
    const fmt = (t) => {
      const d = new Date(t)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    const strip = (t) => String(t || '').replace(/\[\[[^\]]*\]\]/g, '').trim()
    const body = chunks
      .map((m) => `[${fmt(m.at)}] ${m.role === 'user' ? '我' : '她'}${m.proactive ? '（主动）' : ''}：${strip(m.text)}`)
      .join('\n')
    try {
      writeFileSync(filePath, `大肥鱼 · 对话记录（共 ${total} 条）\n\n${body}\n`, 'utf8')
      return { ok: true, filePath }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })
  ipcMain.on('chat:close-window', () => { try { historyWin?.close() } catch {} })

  sayToBrain = brainSay   // 函数声明会提升，这里登记给 KWS 用
  ipcMain.handle('brain:say', async (_e, text) => brainSay(text))
  // ---------- 独立输入条窗口 ----------
  ipcMain.on('chatwin:say', (_e, text) => { void brainSay(text) })
  ipcMain.on('chatwin:toggle', (_e, on, anchor) => {
    if (anchor && Number.isFinite(anchor.cx) && Number.isFinite(anchor.ty)) chatAnchor = { cx: anchor.cx, ty: anchor.ty }
    if (on) showChatWindow()
    else hideChatWindow()
  })
  ipcMain.on('chatwin:anchor', (_e, anchor) => {
    if (anchor && Number.isFinite(anchor.cx) && Number.isFinite(anchor.ty)) { chatAnchor = { cx: anchor.cx, ty: anchor.ty }; placeChatWindow() }
  })
  ipcMain.handle('chatwin:asr', async (_e, pcmB64) => {
    const body = Buffer.from(String(pcmB64 || ''), 'base64')
    if (!body.length) return { ok: false, error: 'empty' }
    const want = settings.asrEngine === 'qwen3' ? 'qwen3' : 'sensevoice'
    // 先问一下有没有模型：没装就直说，别让她把"没听清"当成你说得轻
    try {
      const h = await fetch(new URL('/asr/health', TTS_URL)).then((r) => r.json()).catch(() => null)
      const mine = h?.engines?.find((e) => e.name === want)
      if (h && mine && mine.exists === false) {
        const label = want === 'qwen3' ? 'Qwen3-ASR' : 'SenseVoice'
        return { ok: false, error: `这台机器没装 ${label} 模型（可选功能，不影响打字）` }
      }
    } catch {}
    try {
      const q = want === 'qwen3' ? '?engine=qwen3' : '?engine=sensevoice'
      const r = await fetch(new URL('/asr' + q, TTS_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) return { ok: false, error: j.error || `http ${r.status}` }
      flog('[asr]', `${j.dur}s -> ${j.ms}ms`, String(j.text || '').slice(0, 40))
      return { ok: true, text: j.text, ms: j.ms, dur: j.dur }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })
  ipcMain.on('chatwin:close', (_e, interrupt) => {
    hideChatWindow()
    if (interrupt) {
      try { brain?.interrupt() } catch {}
      chatStreaming = null
      abortTts()
      try { win?.webContents.send('brain:ev', { t: 'state', state: 'interrupted' }) } catch {}
    }
  })

  /**
   * 用户说「播放我的喜欢歌单」但模型没写标记时的本地兜底。
   * 只认「明确提到歌单/列表」的句子；解析结果交给 resolvePlaylist，
   * 命中 0 个就什么都不做（绝不瞎放），命中多个就让她问用户。
   */
  async function playlistFromUser(text) {
    const t = String(text || '')
    if (!/歌单|列表|收藏|红心/.test(t)) return
    if (!/播|放|来|听|换/.test(t)) return
    const single = /随机|随便|来一首|一首|任意/.test(t)
    const core = t
      .replace(/^(帮我|给我|麻烦|你|请)+/g, '')
      .replace(/(播放|放|来|听|换)(一下|一首|点|个)?/g, '')
      .replace(/歌单|列表|里面|里边|里的|中的|的/g, '')
      .trim()
    const hit = await resolvePlaylist(core || t, single)
    if (!hit) return
    if (hit.ambiguous) {
      flog('[playlist] 用户提到多个歌单，让她问：', hit.ambiguous.join(' / '))
      void runProactive({ kind: 'musicpick', extra: { options: hit.ambiguous } })
      return
    }
    const tracks = (await ncm.playlistTracks(hit.list.id, 500)).filter((x) => x.id)
    if (!tracks.length) return
    flog('[playlist] 兜底执行', hit.list.name, single ? '随机一首' : '整单', tracks.length)
    playTagMuteUntil = Date.now() + 20000
    if (single) {
      const pick = tracks[Math.floor(Math.random() * tracks.length)]
      await playSong(pick, { replaceQueue: true })
    } else {
      setQueue(tracks)
      const start = playMode === 'shuffle' ? Math.floor(Math.random() * tracks.length) : 0
      await playSong(queue[start], {})
    }
  }

  async function brainSay(text) {
    const say = String(text || '').trim()
    if (!say) return { ok: false, error: 'empty' }
    if (!brain) return { ok: false, error: '没有可用的脑子' }
    if (chatStreaming) { try { brain.interrupt() } catch {} chatStreaming = null }
    lastChatAt = Date.now()
    lastActivityAt = Date.now()
    // 用户明说「放（我的 X）歌单」→ 本地先把歌单放起来，并让她这次猜的歌名作废
    if (/歌单|列表/.test(say)) void playlistFromUser(say)
    const id = ++chatSeq
    chatStore?.append({ role: 'user', text: say })
    const send = (ev) => { try { win?.webContents.send('brain:ev', { id, ...ev }) } catch {} }
    send({ t: 'state', state: 'thinking' })
    ;(async () => {
      let full = ''
      const tools = []
      try {
        for await (const ev of brain.chat({ text: say, sessionId: chatStore?.sessionId })) {
          if (ev.t === 'delta') full += ev.text
          if (ev.t === 'tool' && Array.isArray(ev.names)) tools.push(...ev.names)
          if (ev.t === 'done' && !ev.full) ev.full = full
          send(ev)
        }
        // web/tools 记进记录，记录窗里就能看出她这次是查过还是凭记忆
        if (full) chatStore?.append({ role: 'pet', text: full, tools: [...new Set(tools)] })
        if (tools.length) console.log('[brain] 用了工具：', [...new Set(tools)].join(', '))
      } catch (err) {
        send({ t: 'error', message: String(err?.message || err) })
      } finally {
        if (id === chatSeq) chatStreaming = null
        send({ t: 'state', state: 'idle' })
      }
    })()
    return { ok: true, id }
  }

  ipcMain.handle('brain:interrupt', () => {
    try { brain?.interrupt() } catch {}
    chatStreaming = null
    abortTts()
    return { ok: true }
  })

  /**
   * 让她出声：把一句话丢给本地 TTS 服务（app/tts/server.py），把裸 PCM 块推回渲染层。
   * 为什么由主进程代理：渲染层直连 127.0.0.1:8769 会被 CORS 拦（那个服务没有 CORS 头），
   * 主进程有完整网络权限；顺带也方便打断（一个 AbortController 就够）。
   */
  ipcMain.handle('tts:speak', async (_e, opts = {
}) => {
    const text = String(opts.text || '').trim()
    if (!text) return { ok: false, error: 'empty' }
    flog('[tts] 合成：', JSON.stringify(text.slice(0, 40)))
    if (settings.voice === false) return { ok: false, error: 'voice-off' }
    const base = String(settings.ttsUrl || TTS_URL).replace(/\/+$/, '')
    // 注意：**不打断上一句**。渲染层按句排队，允许两三句同时在生成，
    // 句与句之间才不会被「等上一句说完」拖出空档。真要打断走 tts:stop。
    const ctrl = new AbortController()
    const id = ++ttsSeq
    ttsCtrls.set(id, ctrl)
    const token = opts.token
    const send = (ch, payload) => { try { win?.webContents.send(ch, { id, token, ...payload }) } catch {} }
    const voice = String(opts.voice || '')
    ;(async () => {
      try {
        const res = await fetch(base + '/tts_stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voice: voice || undefined }),
          signal: ctrl.signal,
        })
        if (!res.ok || !res.body) throw new Error(`TTS ${res.status}`)
        const reader = res.body.getReader()
        // 裸 PCM 是 16bit，一次 read() 的字节数却是任意的（实测有 13315 这种奇数）。
        // 奇数长度原样发下去，渲染层按 int16 解就会整体错开一个字节 —— 听感是强烈的滋滋声。
        // 所以这里攒着：只发偶数长度的部分，剩下的半个采样留到下一轮。
        let carry = Buffer.alloc(0)
        for (;;) {
          const { done, value } = await reader.read()
          if (done || ctrl.signal.aborted) break
          if (!value || !value.length) continue
          const buf = carry.length ? Buffer.concat([carry, Buffer.from(value)]) : Buffer.from(value)
          const even = buf.length & ~1
          if (even >= 2) send('tts:chunk', { pcm: buf.subarray(0, even).toString('base64') })
          carry = buf.length & 1 ? Buffer.from(buf.subarray(even)) : Buffer.alloc(0)
        }
        if (!ctrl.signal.aborted) send('tts:end', {})
        kwsResume()
      } catch (err) {
        if (!ctrl.signal.aborted) send('tts:error', { message: String(err?.message || err) })
      } finally {
        ttsCtrls.delete(id)
      }
    })()
    return { ok: true, id }
  })
  ipcMain.handle('tts:stop', () => { abortTts(); return { ok: true } })
  // 调试用：不接麦克风也能验证「唤醒 → 气泡 → 弹输入条」这条链
  ipcMain.handle('kws:call', (_e, on) => {
    kwsSend(on ? 'call on' : 'call off')
    if (!on) wakeSession = false
    return { ok: true, call: !!on }
  })
  ipcMain.handle('kws:fake', (_e, word) => {
    // 让 python 也真的进会话（否则假唤醒只会出气泡，10 秒超时测不出来）
    kwsSend('fake')
    onWakeWord(String(word || '调试'))
    return { ok: true }
  })
  ipcMain.handle('kws:status', () => ({
    state: kwsState, paused: kwsPaused, on: settings.wakeOn !== false,
    words: settings.wakeWords, device: settings.wakeDevice,
    model: existsSync(path.join(ROOT, 'app', 'tts', 'kws-models', 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01')),
  }))
  ipcMain.handle('kws:set', async (_e, patch = {}) => {
    if (typeof patch.on === 'boolean') settings.wakeOn = patch.on
    if (typeof patch.words === 'string') settings.wakeWords = patch.words.trim()
    if (typeof patch.device === 'string') settings.wakeDevice = patch.device.trim()
    saveSettings()
    stopKws()
    if (settings.wakeOn) await ensureKws({ force: true })
    return { state: kwsState }
  })

  /**
   * 让她主动开口：往对话里塞一段「旁白」去戳她，说什么由 AstrBot 现场生成。
   * 必须满足三个前提：不在回话中、不在演动作、用户没在打字（门控在 proactive.mjs 里）。
   */
  ipcMain.handle('brain:proactive', async () => runProactive())
  ipcMain.handle('balance:status', () => balanceState)
  ipcMain.handle('worklink:status', () => ({ ...(workLink?.status ?? { state: 'idle' }), mode: settings.workLink || 'full' }))
  ipcMain.handle('worklink:refresh', () => { workLink?.refresh(); return { ok: true } })
  ipcMain.handle('proactive:stats', () => proactive?.stats?.() ?? null)
  // 渲染层把当下的心情摘要报过来（不落盘、10 分钟过期）
  ipcMain.on('mood:context', (_e, text) => {
    moodContext = String(text || '').slice(0, 120)
    moodContextAt = Date.now()
  })
  ipcMain.handle('proactive:force', async (_e, opts) => {
    if (opts && (opts.kind || opts.mood)) {
      if (opts.mood) { moodContext = String(opts.mood).slice(0, 120); moodContextAt = Date.now() }
      const r = await runProactive({ manual: true, kind: opts.kind || 'alone', awayMin: opts.awayMin || 0, extra: opts.extra || null })
      return r
    }
    const ok = proactive?.force?.()
    return { ok: !!ok }
  })
  // 页面在打字/点她：刷新「用户还在」的时间戳，主动开口会因此推迟
  ipcMain.on('proactive:touch', () => { lastActivityAt = Date.now() })

  // 调试：手动演一遍「走开」「回来」（不依赖真的等 3 分钟，方便验收文案与反应）
  ipcMain.handle('presence:test', async (_e, kind) => {
    try { win?.webContents.send('presence:change', { stage: kind === 'away' ? 'short' : 'here', idleSec: kind === 'away' ? 200 : 0, awayMin: 42 }) } catch {}
    if (kind === 'away') {
      presence = 'short'
      await runProactive({ kind: 'away', awayMin: 42 })
      return { ok: true }
    }
    presence = 'here'
    await runProactive({ kind: 'return', awayMin: 42 })
    return { ok: true }
  })

  ipcMain.on('shell:quit', () => app.quit())
  ipcMain.on('shell:devtools', () => win?.webContents.toggleDevTools())
  ipcMain.on('shell:harness', () => shell.openExternal(`${srv.url}/harness/`))
}

// 指针在不在角色身上：用渲染层上传的掩码按**窗口内坐标**查，查不到就当作命中（宁可挡住鼠标，也别让她点不到）。
function maskHit(cx, cy, r = 1) {
  // 首选「她在窗口里的包围盒」：这是渲染层用离屏 extract 量出来的，跟着缩放/换形态一起更新，
  // 不会像像素掩码那样因为 resize 后 GL 缓冲失效而整张错位（点哪儿都判成透明 = 点不到她）。
  // 掩码只在没有包围盒时才当兜底。
  if (hitBox?.w) {
    const pad = 6
    return cx >= hitBox.x - pad && cx <= hitBox.x + hitBox.w + pad && cy >= hitBox.y - pad && cy <= hitBox.y + hitBox.h + pad
  }
  if (!hitMask || !hitMask.w) {
    // 没有像素掩码：用她的大致包围盒（resize 后 GL 读不到 alpha 时的兜底）
    if (!hitBox || !hitBox.w) return true
    const pad = 6
    return cx >= hitBox.x - pad && cx <= hitBox.x + hitBox.w + pad && cy >= hitBox.y - pad && cy <= hitBox.y + hitBox.h + pad
  }
  const { w, h, x, y, cw, ch, bits, view } = hitMask
  if (!cw || !ch) return true
  // Q 版是「画布 CSS 放大裁切」：窗口坐标要先反变换回画布坐标，再映射到掩码网格
  let vx = cx
  let vy = cy
  if (view && view.k > 0) {
    vx = view.bx + cx / view.k
    vy = view.by + cy / view.k
  }
  const gx = Math.floor(((vx - x) / cw) * w)
  const gy = Math.floor(((vy - y) / ch) * h)
  // 已经在穿透时用更大的半径去看：轮廓边缘的抖动不会让鼠标一进一出
  if (gx < 0 || gy < 0 || gx >= w || gy >= h) return false
  for (let dy = -r; dy <= r; dy++) {
    const ny = gy + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -r; dx <= r; dx++) {
      const nx = gx + dx
      if (nx < 0 || nx >= w) continue
      if (bits[ny * w + nx]) return true
    }
  }
  return false
}

/** 指针在不在窗口的「可点浮层」上（输入条、工具栏、按钮）：DOM 区域不在画布掩码里，得单独算 */
function chromeHit(cx, cy) {
  for (const r of chromeRects) {
    if (cx >= r.x && cy >= r.y && cx <= r.x + r.w && cy <= r.y + r.h) return true
  }
  return false
}

/** 由主进程统一决定「现在要不要忽略鼠标」：拖动/按住/手动穿透/边框都有明确优先级 */
function updateHit(cx, cy) {
  if (!win || win.isDestroyed()) return
  let want
  if (settings.clickThrough) want = true
  else if (dragging || borderDrag) want = false
  else if (chromeHit(cx, cy)) want = false              // 浮层永远可点：输入框在她脚下，按轮廓会被判成透明
  else if (Date.now() - maskAt > 4000) want = false   // 掩码太久没更新：当成命中，避免死窗
  else if (dynamicIgnore) want = !maskHit(cx, cy, 3)  // 已在穿透中：要离开轮廓足够远才继续穿透
  else want = !maskHit(cx, cy, 1)                     // 还能点：确实出了轮廓才放开鼠标
  // 迟滞：「可点 → 穿透」要等 400ms（指针在轮廓边缘抖一下就把鼠标放走，会让窗口一闪）；
  // 「穿透 → 可点」立刻生效（宁可早点挡住鼠标，也不要让她点不到）。
  if (want) {
    if (!dynamicIgnore) {
      if (!ignoreAt) ignoreAt = Date.now() + 400
      if (Date.now() < ignoreAt) return
    }
    ignoreAt = 0
  } else {
    ignoreAt = 0
  }
  if (want !== dynamicIgnore) {
    dynamicIgnore = want
    console.log('[hit] 忽略鼠标=' + want)
    applyWindowSettings()
  }
}

// 全局光标 → 渲染层。跟随要覆盖整个桌面，所以不能只靠窗口内的 mousemove；
// 33ms 轮询 + 变化才发，空闲时零开销。
let cursorTimer = null
function startCursorFeed() {
  if (cursorTimer) return
  let last = null
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    if (last && p.x === last.x && p.y === last.y) return
    last = p
    const [wx, wy] = win.getPosition()
    win.webContents.send('cursor:pos', { x: p.x - wx, y: p.y - wy })
    updateHit(p.x - wx, p.y - wy)
  }, 33)
}
function stopCursorFeed() {
  if (cursorTimer) clearInterval(cursorTimer)
  cursorTimer = null
}

// ---------- 首次运行引导 ----------
// 发布包不带模型（版权原因），所以「刚解压、还没放模型」是最常见的第一种状态。
// 这里不再弹系统文件框然后闪退，而是开一个小窗口把话说清楚：模型要自己放。
async function createFirstRunWindow() {
  wireFirstRunIpc()
  win = new BrowserWindow({
    width: 640, height: 600,
    minWidth: 520, minHeight: 480,
    backgroundColor: '#11151c',
    title: '第一次运行 · 把模型放进来',
    icon: path.join(ROOT, 'assets', 'app.ico'),
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'app', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => {
    // 引导是一次性的设置窗口：置顶 + 抢焦点，否则开在别的窗口后面等于「双击没反应」
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch {}
    win.show()
    try { win.focus(); win.moveTop() } catch {}
    setTimeout(bootFinished, 2000)
  })
  win.setMenuBarVisibility(false)
  win.on('closed', () => { win = null; bootGuard = false; try { app.quit() } catch {} })
  await win.loadFile(path.join(ROOT, 'app', 'firstrun.html'))
}

// 引导页用到的三个动作：看路径、打开目录、选定模型（选完重启生效）
let firstRunIpcReady = false
function wireFirstRunIpc() {
  if (firstRunIpcReady) return
  firstRunIpcReady = true
  ipcMain.handle('firstrun:paths', () => ({
    logFile: LOG_FILE,
    logDir: LOG_DIR,
    modelDir: MODEL_DIRS[0],
    exeDir: EXE_DIR,
    version: app.getVersion(),
  }))
  ipcMain.handle('firstrun:open', async (_e, what = 'model') => {
    const dir = what === 'log' ? LOG_DIR : what === 'exe' ? EXE_DIR : MODEL_DIRS[0]
    try { mkdirSync(dir, { recursive: true }) } catch {}
    const err = await shell.openPath(dir)
    if (err) { try { shell.showItemInFolder(LOG_FILE) } catch {} }
    return { ok: !err, error: err || null, path: dir }
  })
  ipcMain.handle('firstrun:set-model', async (_e, p) => {
    const abs = String(p || '').trim().replace(/^"|"$/g, '')
    if (!abs || !existsSync(abs)) return { ok: false, error: '这个路径不存在：' + abs }
    if (!abs.toLowerCase().endsWith('.model3.json')) return { ok: false, error: '请选 .model3.json 文件（不是 moc3）' }
    settings.model = abs
    await saveSettings()
    flog('[firstrun] 选定模型：', abs)
    setTimeout(() => { app.relaunch(); app.exit(0) }, 150)
    return { ok: true, model: abs }
  })
  ipcMain.handle('firstrun:choose', async () => {
    const r = await dialog.showOpenDialog(win || undefined, {
      title: '选择 Live2D 模型（.model3.json）',
      properties: ['openFile'],
      filters: [{ name: 'Live2D 模型', extensions: ['model3.json'] }],
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false }
    settings.model = r.filePaths[0]
    await saveSettings()
    flog('[firstrun] 选择模型：', settings.model)
    setTimeout(() => { app.relaunch(); app.exit(0) }, 150)
    return { ok: true, model: settings.model }
  })
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  // 每次启动清一次 HTTP 缓存：改了 resources/app 里的 html/js 后，
  // 旧缓存会让界面停在上一版（表现是"功能没了"），而文件其实已经同步过。
  try { await session.defaultSession.clearCache() } catch { /* 清不掉就算了，不影响启动 */ }
  // 桌宠不装箱单式菜单：引导窗口带边框，默认菜单会在顶上露一条 File/Edit/View
  try { Menu.setApplicationMenu(null) } catch {}

  // 麦克风权限：输入条窗口要按住说话（getUserMedia）。Electron 默认会直接拒绝 media 请求，
  // 这里只放行 media/audioCapture，其它权限一律拒。
  try {
    const ses = session.defaultSession
    const allow = (perm) => perm === 'media' || perm === 'audioCapture'
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allow(permission)))
    ses.setPermissionCheckHandler((_wc, permission) => allow(permission))
  } catch (err) {
    flog('[mic] 权限处理器注册失败', String(err?.message || err))
  }
  await loadSettings()
  flog('[boot]', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    exe: process.execPath,
    userData: app.getPath('userData'),
    modelDirs: MODEL_DIRS,
    safeMode: SAFE,
    crashLastTime,
    tries: bootTries,
  })
  // 启动时只探活，不自动拉起：本机实测 auto-spawn 会卡在模型加载（见 _data/tts.log），
  // 与其闷等 90 秒，不如直接告诉用户「服务没开，点启动」。
  // 语音：先从设置/探活决定，没起且允许自启就拉起来（异步，不挡窗口）
  void ensureTts({ force: settings.ttsAutoStart !== false })
  if (settings.wakeOn) void ensureKws()
  ncm.initMusic(app.getPath('userData'))
  void ncm.refreshProfile()
  settings.model = await resolveModelOrPick()
  if (!settings.model) {
    flog('[boot] 未找到模型 → 首次运行引导')
    await createFirstRunWindow()
    return
  }
  flog('[boot] 模型：', settings.model)
  // 贴图过大 → 自动压一次（默认流程）。已经压过、或用 STAGE_NO_SHRINK 跳过的不重复
  if (!process.env.STAGE_NO_SHRINK && !/_opt\d+/i.test(settings.model || '')) {
    const big = oversizedTexture(settings.model)
    if (big) {
      flog('[opt] 发现超大贴图', big.rel, `${big.w}x${big.h}`)
      const ok = await autoShrinkTextures(settings.model)
      if (ok) { await loadSettings(); flog('[opt] 压缩完成，改用：', settings.model) }
      else flog('[opt] 压缩失败，继续用原模型（内存会偏高）')
    }
  }
  // 系统 / 显卡：排查「他那边打不开」时最有用的两行
  try {
    const gpu = await app.getGPUInfo('basic')
    flog('[sys]', {
      os: process.getSystemVersion(), arch: process.arch, electron: process.versions.electron,
      gpu: (gpu?.gpuDevice || []).map((d) => `${d.vendorString || d.vendorId || '?'} ${d.deviceString || ''}`.trim()),
      gl: gpu?.auxAttributes?.glRenderer || null,
    })
  } catch (e) { flog('[sys] GPU 信息读取失败', String(e?.message || e)) }
  await saveSettings()
  try {
    srv = await createStageServer({ root: ROOT, model: settings.model, token, port: 0 })
  } catch (e) {
    flog('[boot] 静态服务启动失败', e?.stack || String(e))
    dialog.showErrorBox('启动失败', `本地服务没起来：\n${e?.message || e}\n\n日志：${LOG_FILE}`)
    app.quit()
    return
  }
  chatStore = createChatStore(app.getPath('userData'))
  // 互动状态（心情 + 今日计数）：和聊天分开存，坏了也不影响聊天
  moodFile = path.join(app.getPath('userData'), 'touch-state.json')
  try {
    const cfg = loadBrainConfig(ROOT)
    brain = await pickBrain(cfg)
    brainState = { ok: brain?.id !== 'mock', detail: brain?.id === 'mock' ? '没有可用的大脑，先用本地台词' : '已连接', url: cfg.astrbotUrl || null }
    flog('[brain] 选用', brain?.id, brainState.detail, cfg.astrbotUrl || '')
  } catch (e) {
    flog('[brain] 初始化失败', e?.stack || String(e))
    brainState = { ok: false, detail: String(e?.message || e) }
  }
  await writeEndpoint()
  console.log(`[stage] ${srv.url}/app/  （窗口尺寸 A=${settings.width}×${settings.height}）`)
  wireIpc()
  startProactive()
  startPresence()
  wireFit()
  wireBorderDrag()
  wireWindowDrag()
  startCursorFeed()
  await createWindow()
  // 工作联动：轮询 dsh-pet 的 workStatus（DSH 没开就退到 5s 重试，不影响主流程）
  // 余额只在变化时回调；低余额提醒还要靠这个定时器「过门槛后等一会儿再说」
  setInterval(() => { if (balanceState) maybeWarnBalance(balanceState.total) }, 60000)
  workLink = createWorkLink({
    onBalance: (b) => applyBalance(b),
    log: (m) => flog(m),
    enabled: () => (settings.workLink || 'full') !== 'off',
    onState: (st) => {
      const mode = settings.workLink || 'full'
      flog(`[work] state=${st.state}${st.task ? ` task=${st.task}` : ''} mode=${mode}`)
      if (!win || win.isDestroyed()) return
      // 复用舞台自带的 agent 联动（表情/动作/台词都在 src/stage/agent-link.js）
      win.webContents.send('agent:status', {
        state: st.state,
        task: st.task,
        tool: null,
        detail: st.task || null,
        silent: mode === 'motion',
        at: Date.now(),
      })
      win.webContents.send('work:state', { state: st.state, task: st.task, at: Date.now() })
    },
  })
  workLink.start()
  bootGuard = false
  // 详细显卡名要等 GPU 进程（'complete' 会阻塞），放到窗口起来之后补记，不挡启动
  setTimeout(async () => {
    try {
      const full = await app.getGPUInfo('complete')
      const d = (full?.gpuDevice || [])[0] || {}
      flog('[sys] gpu:', `${d.vendorString || ''} ${d.deviceString || ''}`.trim() || '未知', 'driver:', d.driverVersion || '?', 'features:', app.getGPUFeatureStatus())
    } catch (e) { flog('[sys] gpu 详情读取失败', String(e?.message || e)) }
  }, 3000)

  // 穿透态找回 / 退出：全局快捷键，即使窗口在忽略鼠标也能用
  globalShortcut.register('Control+Alt+L', () => {
    settings.clickThrough = !settings.clickThrough
    applyWindowSettings()
    saveSettings()
    win?.webContents.send('shell:click-through', settings.clickThrough)
  })
  // 静音开关：说话时随手静音（开会/录音），再按一次恢复
  globalShortcut.register('Control+Alt+M', () => {
    settings.voice = settings.voice === false
    saveSettings()
    broadcastSettings()
    if (settings.voice === false) abortTts()
    flog('[voice]', settings.voice === false ? '已静音' : '已恢复')
  })
  globalShortcut.register('Control+Alt+Q', () => app.quit())

  app.on('activate', () => { if (!win) createWindow() })
})

app.on('before-quit', () => { quitting = true })
app.on('will-quit', () => { stopTts() })
app.on('window-all-closed', () => {
  // 启动阶段还会开临时窗口（压缩贴图的 splash）：它关掉不代表程序该退出
  if (bootGuard) return
  stopCursorFeed()
  globalShortcut.unregisterAll()
  srv?.close?.()
  app.quit()
})
