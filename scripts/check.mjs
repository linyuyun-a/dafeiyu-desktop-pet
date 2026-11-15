#!/usr/bin/env node
/**
 * npm run check —— 一次跑完的冒烟自检
 *
 * 为什么要有它：这几天连续出现「改了 A 悄悄弄坏 B」（点她打断说话、
 * 气泡逐字卡住、界面读到缓存的旧 HTML、TTS 找不到 python）。这些都不是
 * 语法错，`node --check` 抓不到，只能真的把界面跑起来点一遍。
 *
 *   node scripts/check.mjs                 # 端口 9601，没在跑就自己启动
 *   node scripts/check.mjs --port 9555     # 连已经在跑的那个
 *   node scripts/check.mjs --no-spawn      # 只连，不启动
 *
 * 退出码：0 全过；1 有失败。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
const PORT = Number(argVal('--port') || process.env.CHECK_PORT || 9601)
const NO_SPAWN = argv.includes('--no-spawn')
const DEST = process.env.STAGE_APP_DEST || 'D:/大肥鱼桌宠'
const EXE = path.join(DEST, '大肥鱼Live2d桌宠.exe')

const results = []
const ok = (name, extra = '') => results.push({ name, pass: true, extra })
const bad = (name, why) => results.push({ name, pass: false, extra: String(why || '') })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function list() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2500) })
  return r.json()
}
async function up() { try { await list(); return true } catch { return false } }

function open(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  const ready = new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    const q = pend.get(m.id)
    if (q) { pend.delete(m.id); q(m) }
  })
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
    return r?.result?.result?.value
  }
  return { send, ev, ready, close: () => ws.close() }
}

async function connect(match) {
  for (let i = 0; i < 60; i++) {
    let l = []
    try { l = await list() } catch { await sleep(500); continue }
    const t = l.find((x) => x.type === 'page' && x.url.startsWith('http') && x.url.includes(match))
    if (t) return open(t)
    await sleep(500)
  }
  return null
}

let child = null
async function ensureApp() {
  if (await up()) return
  if (NO_SPAWN) throw new Error(`127.0.0.1:${PORT} 没有可连的窗口（--no-spawn 下不自动启动）`)
  if (!fs.existsSync(EXE)) throw new Error(`找不到 ${EXE}；先 npm run pack，或设 STAGE_APP_DEST`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { cwd: DEST, stdio: 'ignore', env })
  for (let i = 0; i < 60; i++) {
    if (await up()) return
    await sleep(1000)
  }
  throw new Error('启动 60 秒仍连不上调试端口')
}

const LONG = '自检用的长句子，一共要跨过好几个逗号，看看气泡会不会从中间开始，或者干脆停在半句不动。'

async function main() {
  console.log(`\n  自检 · 端口 ${PORT}\n`)
  await ensureApp()
  const main = await connect('/app/')
  if (!main) throw new Error('连上了端口，但没找到舞台页面')
  await main.ready

  // 1. 启动
  try {
    const info = await main.ev(`(() => {
      const c = document.querySelector('canvas')
      return { title: document.title, shell: typeof window.shell, w: c ? c.width : 0, h: c ? c.height : 0 }
    })()`)
    if (info.shell !== 'object') throw new Error('window.shell 不存在（preload 没挂上）')
    if (!info.w || info.w < 10) throw new Error(`画布异常 ${info.w}x${info.h}`)
    ok('启动：她的窗口起来了', `canvas ${info.w}x${info.h} · ${info.title}`)
  } catch (e) { bad('启动：她的窗口起来了', e.message) }

  // 2. 气泡出字、头不丢、尾巴三颗
  try {
    await main.ev(`window.__bubbleShow(${JSON.stringify(LONG)}, 'chat', { src: 'her', mood: 'joy', strength: 0.8, name: '自检' })`)
    await sleep(600)
    const t = await main.ev(`(() => {
      const b = document.getElementById('bubble')
      return {
        text: b?.querySelector('.b-str')?.textContent || '',
        tail: b?.querySelectorAll('.b-tail i').length || 0,
      }
    })()`)
    if (t.text.length < 10) throw new Error(`气泡没出字（${t.text.length} 字）`)
    if (!t.text.startsWith(LONG.slice(0, 6))) throw new Error(`不是从开头显示：${t.text.slice(0, 12)}…`)
    ok('气泡：长句从开头显示，没丢头', `${t.text.length} 字`)
    if (t.tail !== 3) bad('气泡：鱼泡尾巴三颗', `实际 ${t.tail} 颗`)
    else ok('气泡：鱼泡尾巴是三颗')
  } catch (e) { bad('气泡：长句从开头显示，没丢头', e.message) }

  // 3. 字会继续长
  try {
    await main.ev(`window.__bubbleShow('这是一句会逐字长出来的话，用来确认气泡不是停在某个位置不动，而是能一路写完。', 'chat', { src: 'her', mood: 'joy', strength: 0.8 })`)
    const a = await main.ev(`document.querySelector('#bubble .b-str')?.textContent.length || 0`)
    await sleep(1400)
    const b = await main.ev(`document.querySelector('#bubble .b-str')?.textContent.length || 0`)
    if (!b) throw new Error('一直是空的')
    if (b < a) throw new Error(`字数反而变少 ${a} → ${b}`)
    ok('气泡：内容不会被清空或变短', `${a} → ${b}`)
  } catch (e) { bad('气泡：内容不会被清空或变短', e.message) }

  // 4. 点她不打断（回归项）
  try {
    const before = await main.ev(`(() => {
      const b = document.getElementById('bubble')
      return { visible: !!b && !b.classList.contains('hidden') }
    })()`)
    if (!before.visible) throw new Error('点之前气泡本来就没显示')
    await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 380, y: 300, button: 'left', clickCount: 1 })
    await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 380, y: 300, button: 'left', clickCount: 1 })
    await sleep(400)
    const after = await main.ev(`(() => {
      const b = document.getElementById('bubble')
      return { visible: !!b && !b.classList.contains('hidden') }
    })()`)
    if (!after.visible) throw new Error('点一下之后气泡消失了（点击仍在打断）')
    ok('交互：点她不会把气泡/说话掐掉')
  } catch (e) { bad('交互：点她不会把气泡/说话掐掉', e.message) }

  // 5. 播放器：音量浮条不挤布局
  try {
    await main.ev(`window.shell.playerOpen?.()`)
    const pl = await connect('/app/player.html')
    if (!pl) throw new Error('唱片机窗口没起来')
    await pl.ready
    await sleep(800)
    const g0 = await pl.ev(`(() => {
      const c = document.getElementById('controls').getBoundingClientRect()
      const pop = document.getElementById('volPop')
      const m = document.getElementById('mute').getBoundingClientRect()
      return {
        controlsW: Math.round(c.width),
        hasPop: !!pop,
        mx: Math.round(m.x + m.width / 2),
        my: Math.round(m.y + m.height / 2),
      }
    })()`)
    if (!g0.hasPop) throw new Error('找不到 #volPop（音量浮条）')
    await pl.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g0.mx, y: g0.my })
    await sleep(400)
    const g1 = await pl.ev(`(() => {
      const c = document.getElementById('controls').getBoundingClientRect()
      return {
        controlsW: Math.round(c.width),
        popOp: getComputedStyle(document.getElementById('volPop')).opacity,
      }
    })()`)
    if (g1.controlsW !== g0.controlsW) throw new Error(`浮条一出现就把控制条挤宽了 ${g0.controlsW} → ${g1.controlsW}`)
    if (!(Number(g1.popOp) > 0.5)) throw new Error(`悬停喇叭后浮条没出现（opacity ${g1.popOp}）`)
    ok('播放器：音量浮条不挤压控制条', `${g0.controlsW}px 不变`)
    pl.close()
  } catch (e) { bad('播放器：音量浮条不挤压控制条', e.message) }

  // 6. TTS（可选）
  try {
    const r = await fetch('http://127.0.0.1:8769/health', { signal: AbortSignal.timeout(2500) })
    const j = await r.json()
    if (j.ok || j.ready) ok('语音：本地 TTS 服务在线', `voices ${(j.voices || []).join('/')}`)
    else bad('语音：本地 TTS 服务在线', JSON.stringify(j).slice(0, 80))
  } catch {
    ok('语音：本地 TTS 服务在线（未开，跳过）', '她只是不出声，不影响其它')
  }

  main.close()
}

function report() {
  const pad = Math.max(...results.map((r) => [...r.name].length), 10)
  console.log('')
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name.padEnd(pad, ' ')}  ${r.extra || ''}`)
  }
  const fail = results.filter((r) => !r.pass).length
  console.log(`\n  ${results.length - fail}/${results.length} 通过${fail ? ` · ${fail} 项失败` : ''}\n`)
  return fail
}

try {
  await main()
} catch (e) {
  bad('自检启动', e.message)
} finally {
  const fail = report()
  try { child?.kill() } catch {}
  process.exit(fail ? 1 : 0)
}
