/**
 * 工作联动：轮询 DSH 的 dsh-pet 插件暴露的工作状态。
 *
 * 数据来源（实测可用，零插件）：
 *   GET http://127.0.0.1:<DSH端口>/dsh-pet-7340/state
 *   → {"sections":{"workStatus":{"counter":<毫秒>, "data":{"state":"thinking|working|result|waiting|success|error","task":null}}}}
 *
 * `counter` 每次变化才算一次新事件：dsh-pet 自己会重复返回同一个状态，
 * 所以下游必须靠 counter 去重，否则会变成弹幕机。
 *
 * 端口不固定（DSH 的 desktop-preferences.json 里 port 是 0 = 自动挑），
 * 所以先试已知端口，失败就扫一遍本机 LISTENING 端口找 `/dsh-pet-7340/state`。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const ROUTE = '/dsh-pet-7340/state'
const PROBE_TIMEOUT = 400
const POLL_MS = 700
const RETRY_MS = 5000
const MAX_MISS = 4

/** 已探到过的端口（跨重连保留），下一个优先试它 */
let cachedPort = 0

/** 列本机 127.0.0.1 上处于 LISTENING 的端口 */
async function listeningPorts() {
  try {
    const { stdout } = await exec('netstat', ['-ano', '-p', 'tcp'], { timeout: 4000, windowsHide: true })
    const ports = new Set()
    for (const line of String(stdout).split(/\r?\n/)) {
      // 例：  TCP    127.0.0.1:10962        0.0.0.0:0              LISTENING       38736
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+\d+\s*$/i)
      if (m) ports.add(Number(m[1]))
    }
    return [...ports]
  } catch {
    return []
  }
}

/** 探一个端口上的 workStatus；不匹配返回 null */
async function probe(port) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT)
  try {
    const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`, { signal: ctrl.signal })
    if (!res.ok) return null
    const body = await res.json()
    const ws = body?.sections?.workStatus
    if (!ws || !ws.data || typeof ws.data.state !== 'string') return null
    return {
      port,
      counter: Number(ws.counter) || 0,
      state: ws.data.state,
      task: ws.data.task ?? null,
      balance: parseBalance(body?.sections?.balance),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 余额段（dsh-pet 的 balance section）：
 *   {"counter":…,"data":{"ok":true,"provider":"deepseek-account","shape":"money",
 *     "data":{"wallets":[{"currency":"CNY","total":"14.01","granted":"0.00","toppedUp":"14.01","fullBalance":"20"}]}}}
 * 只取人民币钱包的 total / fullBalance；拿不到就返回 null。
 */
function parseBalance(sec) {
  const d = sec?.data
  if (!d || d.ok === false) return null
  const wallets = d?.data?.wallets
  if (!Array.isArray(wallets) || !wallets.length) return null
  const w = wallets.find((x) => String(x?.currency || '').toUpperCase() === 'CNY') || wallets[0]
  const total = Number(w?.total)
  if (!Number.isFinite(total)) return null
  const full = Number(w?.fullBalance)
  return {
    total,
    currency: String(w?.currency || 'CNY'),
    full: Number.isFinite(full) ? full : null,
    granted: Number(w?.granted) || 0,
    toppedUp: Number(w?.toppedUp) || 0,
    at: Date.now(),
  }
}

/** 找端口：先缓存 → 常见端口 → 全扫 */
async function discover() {
  if (cachedPort) {
    const hit = await probe(cachedPort)
    if (hit) return hit
    cachedPort = 0
  }
  for (const port of [10962, 7388]) {
    const hit = await probe(port)
    if (hit) { cachedPort = port; return hit }
  }
  for (const port of await listeningPorts()) {
    if (port === 10962 || port === 7388) continue
    const hit = await probe(port)
    if (hit) { cachedPort = port; return hit }
  }
  return null
}

/**
 * @param {object} o
 * @param {(s: {port:number,counter:number,state:string,task:string|null}) => void} o.onState 状态变化时回调
 * @param {(msg: string) => void} [o.log]
 * @param {() => boolean} [o.enabled] 运行期开关（设置页关掉联动时返回 false）
 */
export function createWorkLink({ onState, onBalance, log = () => {}, enabled = () => true } = {}) {
  let timer = null
  let stopped = false
  let lastCounter = 0
  let lastBalance = null
  let misses = 0
  let stats = { polls: 0, hits: 0, state: 'idle', port: 0, lastAt: 0 }

  async function tick() {
    if (stopped) return
    if (!enabled()) {
      stats.state = 'off'
      schedule(RETRY_MS)
      return
    }
    stats.polls++
    const hit = await discover()
    if (!hit) {
      misses++
      stats.state = misses >= MAX_MISS ? 'offline' : 'searching'
      if (misses === MAX_MISS) log('[work] 找不到 DSH（5s 后重试），工作联动先歇着')
      schedule(misses >= MAX_MISS ? RETRY_MS : POLL_MS)
      return
    }
    misses = 0
    stats.hits++
    stats.port = hit.port
    stats.state = hit.state
    stats.lastAt = Date.now()
    if (hit.counter && hit.counter !== lastCounter) {
      lastCounter = hit.counter
      try { onState(hit) } catch (e) { log(`[work] 回调异常：${e?.message ?? e}`) }
    }
    if (hit.balance) {
      const b = hit.balance
      if (!lastBalance || Math.abs(b.total - lastBalance.total) > 0.0001) {
        lastBalance = b
        try { onBalance?.(b) } catch (e) { log(`[balance] 回调异常：${e?.message ?? e}`) }
      }
    }
    schedule(POLL_MS)
  }

  function schedule(ms) {
    if (stopped) return
    clearTimeout(timer)
    timer = setTimeout(() => { void tick() }, ms)
  }

  return {
    start() { stopped = false; void tick() },
    stop() { stopped = true; clearTimeout(timer); timer = null },
    /** 手动重连（设置页「重连」按钮） */
    refresh() { misses = 0; cachedPort = 0; schedule(0) },
    get status() { return { ...stats, counter: lastCounter } },
  }
}
