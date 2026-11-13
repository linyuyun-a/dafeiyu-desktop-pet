// Live2D Stage —— 应用渲染层（透明窗口里的角色）。
// 只做「角色 + 互动 + 设置」，验证台的调试面板不在这里。
import { createStage } from '../src/stage/engine.js'
import { createLayerStack } from '../src/stage/layers.js'
import { createViewport } from '../src/stage/viewport.js'
import { createGaze } from '../src/stage/gaze.js'
import { createPoseBus } from '../src/stage/pose-bus.js'
import { createIdleMotions } from '../src/stage/idle-motions.js'
import { createTickle } from '../src/stage/tickle.js'
import { createRegionStore, createRegionInput, seedRegions, faceRegions, foreheadRegion, createFaceZoneReader, createHandZoneReader } from '../src/stage/regions.js'
import { createReactions, DEFAULT_REACTIONS } from '../src/stage/reactions.js'
import { createPetSway } from '../src/stage/pet-sway.js'
import { createFacePinch } from '../src/stage/face-pinch.js'
import { createLife } from '../src/stage/life.js'
import { createMouth } from '../src/stage/mouth.js'
import { createVoice } from './voice.mjs'
import { peakLine } from './peak.mjs'
import { createIdleFaces } from '../src/stage/idle-faces.js'
import { createCapture } from '../src/stage/capture.js'
import { createPosture } from '../src/stage/posture.js'
import { createPoses, POSES, OFFICIAL_POSES } from '../src/stage/poses.js'
import { PHRASES } from '../src/stage/phrases.js'
import { createBubble } from '../src/stage/bubble.js'
import { createAgentLink } from '../src/stage/agent-link.js'
import { createProfiler } from '../src/stage/perf.js'
import { DEFAULT_LOOK, normalizeLook, lookExpressions, parseWear, describeLook, sizeZoom } from './look.mjs'
import { createMood, createDayLog, toneOf, intentOf, motionScale, describeMood } from './mood.mjs'
import { createTouch } from './touch.mjs'

const $ = (s) => document.querySelector(s)
const perf = createProfiler()
const TOGGLE_SET = new Set(['胸口衣服', '裙子切换', '脱鞋', '尾巴开关'])

/**
 * 分区互动时的嘴形（情绪覆盖）。
 * 表情包只驱动眼/脸，嘴由 mouth.js 单独驱动 —— 所以「被摸到哪个部位」的差别主要靠这里表达。
 * 字段是**相对待机嘴的偏移**：open 张开、form 嘴形（负=下撇/嫌弃，正=笑）、smile 嘴角、funnel 圆唇。
 */
const REGION_MOUTH = {
  胸: { open: 0.04, form: -0.45, ms: 2400 },
  腰: { open: 0.42, form: 0.5, smile: 0.8, ms: 2800 },    // 被挠痒：和脚一样忍不住笑
  裙摆: { open: 0.08, form: -0.62, ms: 3200 },          // 嫌弃：嘴角下撇、不情愿地微张嘴
  腿: { open: 0.26, form: 0.10, funnel: 0.30, ms: 2600 }, // 发晕：嘴微微张开、有点呆
  脚: { open: 0.50, form: 0.55, smile: 0.85, ms: 3200 },  // 被挠痒：忍不住笑出来
  头: { open: 0.10, form: 0.22, smile: 0.30, ms: 2200 },
  // 手被碰：小小的不好意思（嘴微微张开、笑意一点点），跟脚那种「被挠痒」区分开
  左手: { open: 0.12, form: 0.26, smile: 0.32, ms: 2000 },
  右手: { open: 0.12, form: 0.26, smile: 0.32, ms: 2000 },
  // 摸到胯：嘴上不情愿（下撇、抿着），配黑脸
  胯: { open: 0.08, form: -0.55, ms: 3600 },
}

/** 浏览器里打开 /app/ 时没有 Electron 预加载：给一套空壳，方便无头验证渲染 */
const shell = window.shell || {
  get: async () => ({ width: 520, height: 760, zoom: 1, gaze: true, strength: 1, alwaysOnTop: false, clickThrough: false }),
  set: async (patch) => patch,
  moveBy: () => {},
  dragBegin: () => {},
  dragEnd: () => {},
  setPassThrough: () => {},
  fit: () => {},
  openSettings: () => {},
  onSettings: () => {},
  stageRpc: async () => ({ ok: false }),
  center: () => {},
  quit: () => {},
  devtools: () => {},
  openHarness: () => {},
  onClickThrough: () => {},
}

const state = {
  caps: null, stage: null, layers: null, viewport: null, gaze: null,
  store: null, regionInput: null, reactions: null, settings: null,
  mask: null, maskAt: 0, maskPending: false, windowDragging: false, middleDragging: false,
  ignoring: false, pointerDown: false,
  physics: { inputs: new Set(), outputs: new Set() },
}

function toast(text, ms = 1800) {
  let el = $('#toast')
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el) }
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.remove('show'), ms)
}

// ---------- 性能浮层（F3 开关；统计常驻，探针用 window.__perf.snapshot()） ----------
window.__perf = perf
function bootPerfOverlay() {
  state.stage?.ticker?.add?.(() => perf.frame())
  let el = null
  let timer = 0
  const paint = () => {
    if (!el) return
    const s = perf.snapshot(false)
    const row = (k, label) => (s[k] ? `<span>${label} <b>${s[k].avg.toFixed(1)}</b>ms · max ${s[k].max.toFixed(1)} · ${s[k].n}次</span>` : '')
    el.innerHTML = `<b>${s.fps.toFixed(1)} fps</b><br>` +
      row('dt', '帧间隔') + row('pre', '每帧逻辑') + row('pass', '穿透判定') +
      row('mask', '遮罩重建') + row('face', '脸部热区')
  }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F3') return
    e.preventDefault()
    if (el) { el.remove(); el = null; clearInterval(timer); timer = 0; return }
    el = document.createElement('div')
    el.id = 'perf'
    document.body.appendChild(el)
    timer = setInterval(paint, 250)
    paint()
  })
}

// ---------- 控制总线：agent / 脚本 → 舞台，舞台 → agent ----------
// 下行：SSE /api/events 收动作；上行：POST /api/feedback 报互动、POST /api/snapshot 报状态。
// 舞台不认「agent 是谁」——DSH 插件、命令行、别的脚本走同一个入口。
const BUS_HOLD_MS = 2500

function postJSON(url, body, token) {
  try {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stage-token': token },
      body: JSON.stringify(body),
    }).catch(() => null)
  } catch { return null }
}

/** 上行反馈：只报「真的发生了什么」，悬停/移动不刷日志 */
function emitFeedback(ev, token) {
  if (!token) return
  postJSON('/api/feedback', ev, token)
}

/** 下行动作：kind 见 docs/PROTOCOL.md。改这里 = 扩协议，记得同步文档。 */
function applyAction(msg) {
  const a = msg.action || {}
  const action = String(a.action || a.kind || '')
  const fade = Number(msg.fade ?? a.fade ?? 0.3)
  const agent = state.settings?.token
  switch (action) {
    case 'say': {
      const text = String(a.text ?? '')
      if ((!text && !a.image) || !state.bubble) break
      const image = a.image ? `/api/meme/${encodeURIComponent(String(a.image))}` : ''
      // owner:'agent' —— 显式指令要能顶掉「工作状态」气泡（否则 agent 干活期间这句话说不出来）
      state.bubble.show(text, { state: a.state || 'idle', image, owner: 'agent' })
      state.agentLink?.cancelHide?.()
      const ms = Number(a.ms ?? 0)
      // 显式指令优先于「工作状态」气泡：否则 DSH 状态轮询两秒后就把这句话盖掉
      state.busOwnUntil = performance.now() + Math.max(ms, 2500)
      if (ms > 0) setTimeout(() => { if (state.bubble?.text === text) state.bubble.hide() }, ms)
      break
    }
    case 'expression': {
      const name = a.name ? String(a.name) : ''
      state.layers?.removeSource('bus')
      if (!name) break
      const def = (state.caps.expressions || []).find((e) => e.name === name)
      if (!def) { console.warn('[bus] 没有这个表情:', name); break }
      state.layers?.addExpression(name, def.params, { source: 'bus', fade })
      break
    }
    case 'pose': {
      if (!a.name) { state.poses?.release(Number(fade) * 1000 || 240); break }
      state.poses?.set(String(a.name), Number(a.ms) || 320)
      break
    }
    case 'look': {
      // 临时接管视线：hold 结束前不再跟鼠标（否则下一帧就被桌面坐标盖掉）
      state.agentLookUntil = performance.now() + (Number(a.ms) || BUS_HOLD_MS)
      state.gaze?.setTarget(Number(a.x ?? 0), Number(a.y ?? 0))
      break
    }
    case 'idle': {
      const mode = String(a.mode || (a.name ? 'play' : 'pause'))
      if (mode === 'play') state.idle?.trigger(a.name ? String(a.name) : undefined)
      else if (mode === 'pause') state.idle?.pause(Number(a.ms) || 5000)
      else if (mode === 'resume') state.idle?.resume?.()
      break
    }
    case 'state': {
      // 显式台词还没到期：状态联动别盖掉它（回合结束时桥接先说总结，状态更新往往晚到）
      if (performance.now() < (state.busOwnUntil || 0)) break
      // 复用 DSH 联动那条路：气泡文案 / 表情 / 小动作的映射都在 agent-link.js
      state.agentLink?.apply({ state: a.state ?? null, at: Date.now(), task: a.task ?? null })
      break
    }
    case 'stop': {
      const scope = String(a.scope || 'all')
      if (scope === 'all' || scope === 'expression') state.layers?.removeSource('bus')
      if (scope === 'all') { state.poses?.release(); state.bubble?.hide() }
      break
    }
    default: break
  }
  // 动作执行完立刻刷新快照 + 打一条回执，agent 侧不用等下一次心跳
  state.busSnap?.()
  emitFeedback({ type: 'action-done', gesture: action, detail: msg.id || null, at: null }, agent)
}

function bootBus() {
  const token = state.settings?.token
  const port = state.settings?.port
  if (!token || !port) {
    console.warn('[bus] 缺少 token/port：外部控制不可用')
    return
  }
  const snap = () => {
    if (!state.bubble) return
    postJSON('/api/snapshot', {
      model: state.caps?.model?.name || null,
      agent: state.agentLink?.state() ?? null,
      bubble: state.bubble.state(),
      idle: state.idle?.state() ?? null,
      pose: state.poses?.state() ?? null,
      // 当前挂着的表情层（source=bus 的是外部指令，agent 的是 DSH 状态）
      exprs: (state.layers?.inspect?.()?.layers || []).map((l) => `${l.source}:${l.name}`),
      look: state.agentLookUntil > performance.now() ? 'agent' : 'cursor',
    }, token)
  }
  state.seenActions = state.seenActions || new Set()
  const handle = (msg) => {
    if (!msg || msg.type !== 'action') return
    if (msg.id) {
      if (state.seenActions.has(msg.id)) return
      state.seenActions.add(msg.id)
      if (state.seenActions.size > 120) state.seenActions.delete(state.seenActions.values().next().value)
    }
    try { applyAction(msg) } catch (err) { console.warn('[bus] 动作失败', err) }
  }
  try {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`)
    es.onmessage = (e) => {
      let msg = null
      try { msg = JSON.parse(e.data) } catch { return }
      // hello 带回连接的最近动作（页面刚重载也能补齐）
      if (msg.type === 'hello') { for (const a of msg.actions || []) handle({ ...a, type: 'action' }); return }
      handle(msg)
    }
    es.onerror = () => { /* 服务端 retry:2000，EventSource 自己重连 */ }
    state.bus = es
  } catch (e) { console.warn('[bus] 连接失败', e) }
  state.busSnap = snap
  snap()
  state.busTimer = setInterval(snap, 4000)
}

async function main() {
  try {
    state.settings = await shell.get()
    state.caps = await fetch('/api/capabilities').then((r) => r.json())
    // 先吃「改动补丁」：姿势/台词/反应/热区都能被覆盖，用户拿原模型也能复现我们的改动
    await applyStagePatch()
    await bootStage()
    bootRegions()
    // 窗口尺寸跟角色绑定：模型尺寸拿到了，立刻把窗口收成刚好包住角色的样子
    applyFit(true)
    // 对话气泡：贴窗口右上角（选左侧就贴左上角），窗口本身刚好包住角色，所以等于贴在头斜上方
    state.bubble = createBubble({
      el: $('#bubble'),
      side: 'right',
      // 跟着她的头走（窗口常驻最大、她是可以缩小的，贴窗口角会离人很远）
      anchor: () => headAnchor(),
      // 冒泡时动嘴：按字数估时长（约 145ms/字 + 起止），念完自动收
      onSpeak: (text) => {
        // null = 气泡收起：闭嘴，回到呼吸的常态
        if (text == null) { state.mouth?.stop?.(); return }
        // 真在放语音时，别让「按字数估计的假口型」跟真的电平抢嘴
        if (state.voice?.playing) return
        const n = Array.from(String(text)).length
        const ms = Math.max(600, Math.min(4200, 160 + n * 145))
        state.mouth?.talk?.(ms)
      },
    })
    // 名字在设置里可改，先按当前设置配一次
    state.bubble.configure?.({ name: state.settings?.petName || '大肥鱼' })
    setInterval(() => { if (state.bubble?.visible) state.bubble.reposition() }, 200)

    // ---------- 声音：本地 TTS（app/tts/server.py）→ WebAudio 队列 → 口型 ----------
    // 主进程负责拉流（避开 CORS），这里只负责排队播和读电平。
    state.voice = createVoice({ log: (m) => console.log(m) })
    shell.onTts?.((kind, p) => {
      if (kind === 'error') console.warn('[voice] TTS 失败：', p?.message)
      routeTts(kind, p)
    })
    // 句级同步的心跳：等首块 / 排下一句 / 判断念完
    setInterval(tickFlow, 120)

    // ---------- 互动层：心情七轴 + 手势细分 ----------
    // 没有亲密度、没有等级：设定里她本来就和你很熟，变的只是「这会儿的心情」。
    state.dayLog = createDayLog()
    state.mood = createMood()
    /** 当前心情 → 幅度/速度系数（动作时长、待机频率都按它缩放） */
    const moodScaleNow = () => {
      try {
        return motionScale(state.mood?.snapshot?.() || {}) || { amp: 1, speed: 1 }
      } catch {
        return { amp: 1, speed: 1 }
      }
    }
    state.moodScale = moodScaleNow
    /** 把心情写进待机/呼吸：困了慢下来，高兴了精神一点（走开时另乘 0.55） */
    state.applyBodyMood = () => {
      const sc = moodScaleNow()
      const base = Number(state.settings?.idleSpeed ?? 1)
      const away = state.presence && state.presence !== 'here' ? 0.55 : 1
      try { state.idle?.set({ speed: base * away * sc.speed }) } catch {}
      try { state.life?.set?.({ breath: sc.speed, blink: sc.amp }) } catch {}
      return sc
    }
    setInterval(() => { if (state.mood) state.applyBodyMood() }, 4000)
    state.touch = createTouch({
      mood: state.mood,
      dayLog: state.dayLog,
      play: (a) => {
        // 心情决定「动静多大、停留多久」：困的时候慢而轻，高兴时幅度大、停留久
        const sc = moodScaleNow()
        if (a.pose) state.poses?.set(a.pose, Math.round(320 * sc.speed))
        else if (a.motion) void playMotionByName(a.motion)
        if (a.face) flashExpression(a.face, Math.round(2800 * sc.amp))
      },
      say: (text, ms) => {
        const b = state.bubble
        if (!b) return null
        const token = (state.touchSayToken = (state.touchSayToken || 0) + 1)
        // 摸出来的台词要独占气泡一小会儿，否则刚说完「变态」就被待机小台词顶掉
        state.touchSayUntil = Date.now() + Math.max(1600, Number(ms) || 2600)
        b.show(text, { state: null, owner: 'touch' })
        if (ms) setTimeout(() => { if ((state.touchSayToken || 0) === token) b.hide() }, ms)
        return text
      },
    })
    void (async () => {
      try {
        const saved = await shell.moodLoad?.()
        if (saved && saved.mood) state.mood.restore(saved.mood)
        if (saved && saved.today) state.dayLog.restore(saved.today)
      } catch {}
      window.__mood = () => state.mood.snapshot()
  window.__voice = () => state.voice?.stats ?? null
  window.__mouth = () => state.mouth?.state?.() ?? null
  /** 工作联动调试：注入一次状态（thinking/working/result/waiting/success/error/null） */
  window.__work = (st, silent = false) => {
    const snap = st ? { state: st, task: null, tool: null, detail: null, silent, at: Date.now() } : null
    state.agentLink?.apply(snap)
    return { state: st, bubble: state.bubble?.text || null, locked: state.bubble?.locked || null }
  }
  window.__flow = () => ({
    buf: chatState.buf,
    revealed: chatState.revealed,
    items: (state.ttsFlow?.items || []).map((i) => ({ n: i.text.length, s: !!i.started, e: !!i.ended, shown: i.shown || 0 })),
    active: state.ttsFlow?.active ?? null,
  })
  window.__say = (t) => speakReply(t)
  // 调试：直接往气泡塞一段文字（测滚动/排版用，不经过大脑）
  window.__bubbleShow = (t, st = 'chat', extra = {}) => {
    state.bubble?.lock?.(st, { force: true })
    state.bubble?.show?.(String(t), { state: st, owner: st, ...extra })
    return { scrollable: !!document.getElementById('bubble')?.classList.contains('scrollable') }
  }
  window.__bubbleRect = () => {
    const b = document.getElementById('bubble')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), sh: b.scrollHeight, ch: b.clientHeight, st: b.scrollTop }
  }
      window.__today = () => state.dayLog.summary()
      window.__regions = () => (state.store?.all || []).map((r) => r.name)
      window.__touch = (name, type = 'tap', step) => state.touch?.event({ type, name, step }, 'plain')
      window.__intent = () => intentOf(state.mood.snapshot())
      window.__tone = () => toneOf(state.mood.snapshot())
      window.__idle = () => ({ speed: state.idle?.options?.speed ?? null, presence: state.presence || 'here', scale: state.moodScale?.() || null })
      window.__setMood = (m) => { state.mood.restore(m); const sc = state.applyBodyMood?.(); return { sc, idle: state.idle?.options?.speed } }
    })()
    setInterval(() => { void shell.moodSave?.({ mood: state.mood.snapshot(), today: state.dayLog.summary() }) }, 20000)
    // DSH 联动：状态 → 气泡台词 / 表情 / 小动作（状态文件由主进程轮询后推过来）
    state.agentLink = createAgentLink({
      bubble: state.bubble,
      layers: state.layers,
      expressions: state.caps.expressions || [],
      poses: state.poses,
      life: state.life,
      mouth: state.mouth,
    })
    // 余额 / 今日已用（dsh-pet 的 balance section 经主进程转过来）
    state.balance = null
    shell.onBalance?.((b) => { if (b) { state.balance = b; updateLookStatus() } })
    Promise.resolve(shell.balanceStatus?.()).then((b) => {
      if (b) { state.balance = b; updateLookStatus() }
    }).catch(() => {})
    shell.onAgentStatus?.((snap) => {
      // 外部指令刚说过的台词有优先权（时长见 applyAction 的 say）
      if (performance.now() < (state.busOwnUntil || 0)) return
      state.agentLink?.apply(snap)
    })
    bindSettings()
    bindTools()
    bindChat()
    scheduleChromePos(900)
    bindWindowDrag()
    // Ctrl + 滚轮：平滑缩放（不按住 Ctrl 的滚轮留给页面/输入框）
    window.addEventListener('wheel', (e) => {
      // 落在可滚动的气泡里：让它自己滚，别当成缩放/穿透
      if (e.target instanceof Element && e.target.closest('#bubble')) {
        clearBubbleHide()
        if (!e.ctrlKey) return
      }
      if (!e.ctrlKey) return
      e.preventDefault()
      zoomByWheel(e.deltaY)
    }, { passive: false })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.zoomRaf) { state.zoomTarget = Number(state.settings?.zoom) || 1 }
    })
    bindBubbleHoverPause()
    bindToolsDismiss()
    bindFrame()
    bindPassThrough()
    state.bubble.setScale(bubbleScale())
    applyBorder(!!state.settings.border)
    bootPerfOverlay()
    bootBus()
    document.title = `stage · ${state.caps.model.name}`
  } catch (e) {
    console.error(e)
    toast(`启动失败：${e.message}`, 6000)
  }
}

/**
 * 改动补丁（stage-patch.json）。
 *
 * 定位：我们**不发布改过的模型**，只发布「我们这层加了什么」——
 * 姿势、台词、分区反应、热区几何。下载者拿自己的原模型 + 这个补丁，
 * 行为就和我们改完一样，不需要二次改膜。
 *
 * 注意：moc3 里的绘制顺序、手臂活动范围这类改不了的东西不在补丁范围内，
 * 那必须重新出模型（补丁里只记录 model 名字，做兼容提示）。
 */
async function applyStagePatch() {
  let p = null
  try { p = await shell.patchLoad?.() } catch { p = null }
  if (!p || typeof p !== 'object') return null
  state.patch = p
  if (p.poses && typeof p.poses === 'object') Object.assign(POSES, p.poses)
  if (p.phrases && typeof p.phrases === 'object') Object.assign(PHRASES, p.phrases)
  if (p.reactions && typeof p.reactions === 'object') Object.assign(DEFAULT_REACTIONS, p.reactions)
  if (p.model && state.caps?.model?.name && p.model !== state.caps.model.name) {
    toast(`补丁是为「${p.model}」做的，当前模型是「${state.caps.model.name}」`, 5000)
  }
  return p
}

/** 导出当前改动：姿势 + 台词 + 反应 + 热区（不含模型本体） */
async function exportStagePatch() {
  if (!state.caps) return null
  const data = {
    version: 1,
    model: state.caps.model.name,
    exportedAt: new Date().toISOString(),
    poses: POSES,
    phrases: PHRASES,
    reactions: DEFAULT_REACTIONS,
    regions: state.store ? { schemaVersion: 2, model: state.caps.model.name, regions: state.store.all } : null,
  }
  const r = await shell.patchSave?.(data)
  toast(r?.ok ? '改动补丁已保存（stage-patch.json）' : '补丁保存失败')
  return r
}

async function loadPhysicsFlow() {
  const empty = { inputs: new Set(), outputs: new Set() }
  try {
    const modelUrl = new URL(state.caps.model.url, location.href).href
    const model = await fetch(modelUrl).then((r) => r.json())
    const rel = model?.FileReferences?.Physics
    if (!rel) return empty
    const phys = await fetch(new URL(rel, modelUrl).href).then((r) => r.json())
    const inputs = new Set()
    const outputs = new Set()
    for (const s of phys.PhysicsSettings || []) {
      for (const i of s.Input || []) if (i?.Source?.Id) inputs.add(i.Source.Id)
      for (const o of s.Output || []) if (o?.Destination?.Id) outputs.add(o.Destination.Id)
    }
    return { inputs, outputs }
  } catch { return empty }
}

async function bootStage() {
  const stage = await createStage({
    container: $('#stage'),
    modelUrl: state.caps.model.url,
  })
  state.stage = stage

  state.physics = await loadPhysicsFlow()
  state.layers = createLayerStack({
    param: stage.param,
    part: stage.part,
    isPhysicsInput: (id) => state.physics.inputs.has(id) && !state.physics.outputs.has(id),
  })
  // （姿势与物理输入的写入点在下面统一注册：必须在物理之前）

  state.reactions = createReactions({
    layers: state.layers,
    expressionDefs: state.caps.expressions,
    // 摸她一下给的临时表情留 8s：6s 时还没看清就没了（她自己还有待机表情，不会显得干）
    ttlMs: 8000,
    onEvent: (e) => { if (e.type === 'warn') console.warn('[reaction]', e.text) },
    onClear: () => state.agentLink?.reapply?.(),
  })

  // 姿态总线：头/身角度的唯一写入者（物理前后各写一次，各层只累加）
  state.poseBus = createPoseBus({ param: stage.param })

  state.gaze = createGaze({
    param: stage.param,
    bus: state.poseBus,
    // 身体角度交给 posture 层（脊柱链），视线只管眼珠与头
    options: {
      enabled: state.settings.gaze !== false,
      strength: Number(state.settings.strength ?? 1),
      headGain: Number(state.settings.headGain ?? 1.25),
      body: 0, bodyRoll: 0,
    },
  })

  // 姿态链：头 → 胸 → 腰 逐级跟随（弹簧 + 过冲），并且喂给物理权重最高的输入
  state.posture = createPosture({
    param: stage.param,
    gaze: state.gaze,
    bus: state.poseBus,
    options: { strength: Number(state.settings.strength ?? 1) },
  })

  // 抚摸晃动：蹭头时额外叠一层摆动（gaze 先定方向，这层再叠幅度）
  state.petSway = createPetSway({
    param: stage.param,
    bus: state.poseBus,
    options: { gain: Number(state.settings.petGain ?? 1.6) },
  })

  // 伪面捕驱动：把「我们的姿态」翻译成模型的**面捕捉取通道**
  // （AngleX/Y/Z、PositionX/Y、ParamBreath、JawOpen…），物理链才会整条活起来
  state.capture = createCapture({ param: stage.param, bus: state.poseBus })

  // 活气层：耳朵扑棱 / 头发惯性 / 耳环摆动（读回物理值再叠加，写在物理之后）
  // 要早于捏脸创建 —— 捏脸时借它做「耳朵快速扑棱」
  state.life = createLife({ param: stage.param })

  // 捏脸：按住「脸」热区拖动 → 鼓脸/单边鼓/抖脸盘 + 身体前倾放大
  state.facePinch = createFacePinch({
    param: stage.param,
    bus: state.poseBus,
    life: state.life,
    options: {
      // 用户手动开了「前倾」时，捏脸就不再抢 LeanInput
      leanBlocked: () => !!state.layers?.hasExpression('前倾'),
    },
  })

  // 痒痒的：摸脚 / 摸腰时的躲痒小动作（胸腔骨盆快抖 + 两侧小臂摆 + 两只耳朵扑腾）
  state.tickle = createTickle({
    bus: state.poseBus,
    life: state.life,
    onHold: (id, v) => { if (v == null) state.layers?.release(id); else state.layers?.hold(id, v) },
  })
  // 嘴：呼吸微动 + 说话音节（模型 LipSync 组是空的，这是唯一驱动源）
  state.mouth = createMouth({ param: stage.param })
  // 随机小表情：笑 / 吐舌头 / 吐舌头+单眼笑，待机时自己冒出来
  state.idleFaces = createIdleFaces({ param: stage.param })
  // 终点姿势：举手 / 竖手指 / 狗尾草（数值取自模型自带的 motion3 末帧），过渡自己补
  state.poses = createPoses({ layers: state.layers })

  // 待机动作：桌面没人互动时自己在动（常驻微摆 + 随机成套动作，部分带小台词）
  let idleLineTimer = 0
  state.idle = createIdleMotions({
    bus: state.poseBus,
    param: stage.param,
    life: state.life,
    idleFaces: state.idleFaces,
    options: { enabled: state.settings.idle !== false, speed: Number(state.settings.idleSpeed ?? 1) },
    // 成套动作的「道具」：姿势 / 表情 / 嘴型 / 风，开始时挂上、结束时撤掉
    onStart: (name, r) => {
      if (r.pose) state.poses?.set(r.pose, 360)
      for (const n of r.exprs || []) {
        const def = (state.caps.expressions || []).find((e) => e.name === n)
        if (def) state.layers?.addExpression(n, def.params, { source: 'idle-exp', fade: 0.28 })
      }
      if (r.mouth) state.mouth?.setMood(r.mouth, r.ms)
      if (r.gust) state.life?.gust?.(r.gust, r.ms)
    },
    onFinish: (name, r) => {
      if (r.pose) state.poses?.release(420)
      if (r.exprs?.length) state.layers?.removeSource('idle-exp')
      if (r.mouth) state.mouth?.clearMood()
    },
    // 物理输出参数（左臂 Z 等）用 hold 写绝对值；null = 释放
    onHold: (id, v) => {
      if (v == null) state.layers?.release(id)
      else state.layers?.hold(id, v)
    },
    // 小台词用气泡；正在显示 DSH 状态（thinking/working/…）时不抢话
    onLine: (text, ms = 4200) => {
      const b = state.bubble
      if (!b) return
      if (state.settings.bubble === false) return
      // 主人不在（走开 >3 分钟）：她不对着空屋子演小台词，想说会由主进程单独触发一句
      if (state.presence && state.presence !== 'here') return
      // 刚摸出来一句话，别让待机小台词盖掉
      if (Date.now() < (state.touchSayUntil || 0)) return
      const st = b.state?.()
      if (st?.visible && st.state && st.state !== 'idle') return
      b.show(text, { state: 'idle' })
      emitFeedback({ type: 'idle-line', detail: text }, state.settings?.token)
      clearTimeout(idleLineTimer)
      idleLineTimer = setTimeout(() => { if (b.state?.().state === 'idle') b.hide() }, ms)
    },
  })

  let lastT = performance.now()
  let frameDt = 1000 / 60
  const motionState = { x: null, y: null, vx: 0, vy: 0, ax: 0, ay: 0 }
  // 拖拽物理的身体位移（弹簧状态：rx/ry 当前偏移，vrx/vry 速度）
  const dragShape = { rx: 0, ry: 0, vrx: 0, vry: 0 }
  const tickDt = () => {
    const now = performance.now()
    frameDt = Math.min(120, Math.max(1, now - lastT))
    lastT = now
  }

  /**
   * 窗口/角色的位移加速度 → 惯性冲击。
   * 拖动窗口时（左键按住角色搬窗），角色的头发、耳环、
   * 裙摆会「被甩」——这才是拖动时最出效果的那一下。窗口坐标变化由 screenX/Y 读到。
   */
  const updateMotion = (dtMs) => {
    // 用「角色在屏幕上的位置」做微分：窗口被搬 + 角色在窗口内被挪，两条路都能触发惯性。
    const x = window.screenX + (state.stage?.model?.position?.x || 0)
    const y = window.screenY + (state.stage?.model?.position?.y || 0)
    if (motionState.x == null) { motionState.x = x; motionState.y = y; return }
    // 中键移动不做物理（用户要求：纯位移，不产生惯性冲击）
    if (state.middleDragging) {
      motionState.x = x
      motionState.y = y
      motionState.vx = 0
      motionState.vy = 0
      state.life?.motion(0, 0)
      state.capture?.motion(0, 0)
      return
    }
    const dt = Math.max(0.008, dtMs / 1000)
    // 拖动中优先用「抓取向量」（pointermove 的实时位移速度）；窗口跟着鼠标走时，
    // 用窗口坐标做差分几乎恒为 0，物理自然要等到松手才动 —— 这就是之前「拖完才甩」的原因
    const dragV = state.windowDragging && state.dragVec && performance.now() - state.dragVec.t < 120 ? state.dragVec : null
    const vx = dragV ? dragV.vx : (x - motionState.x) / dt
    const vy = dragV ? dragV.vy : (y - motionState.y) / dt
    const ax = Math.max(-20000, Math.min(20000, (vx - motionState.vx) / dt))
    const ay = Math.max(-20000, Math.min(20000, (vy - motionState.vy) / dt))
    motionState.x = x
    motionState.y = y
    motionState.vx = vx
    motionState.vy = vy
    // 平滑一层：窗口坐标是整数，直接微分会有尖刺
    motionState.ax = motionState.ax * 0.6 + ax * 0.4
    motionState.ay = motionState.ay * 0.6 + ay * 0.4
    state.life?.motion(motionState.ax, motionState.ay)
    state.capture?.motion(motionState.vx, motionState.vy)
    // 拖拽物理演算：拖动速度 → 身体位移（弹簧跟随，松手有余震），
    // 喂给 physics3 的 `ParamBodyAngleRX`（既入又出）→ 模型自带的头发/衣服/耳朵物理整条甩起来。
    if (state.settings.dragPhysics !== false) {
      const targetX = Math.max(-10, Math.min(10, -motionState.vx * 0.02))
      const targetY = Math.max(-7, Math.min(7, -motionState.vy * 0.014))
      // 弹簧-阻尼：stiffness 越大跟得越紧，damping 越大越快停
      // 拖的时候跟得紧（高阻尼），松手后低阻尼自由回弹：余震约 0.5–0.7 秒才收住
      const stiff = 45
      const damp = state.windowDragging ? 18 : 5.5
      dragShape.vrx += ((targetX - dragShape.rx) * stiff - dragShape.vrx * damp) * dt
      dragShape.vry += ((targetY - dragShape.ry) * stiff - dragShape.vry * damp) * dt
      dragShape.rx += dragShape.vrx * dt
      dragShape.ry += dragShape.vry * dt
      state.poseBus?.add('ParamBodyAngleRX', dragShape.rx)
      state.poseBus?.add('ParamBodyAngleRY', dragShape.ry)
    }
  }

  // ① 物理之前：喂物理输入 + 摆姿势。
  // 物理的输入就是「头部角度 / 呼吸 / 前倾」（physics3 实测 19 处引用），
  // 而我们原来在物理**之后**才写这些角度 —— 等于让物理永远在算静止的模型，
  // 头发、耳朵、耳环的物理全部僵死，这就是「没有物理效果」的真正原因。
  stage.onBeforePhysics(() => {
    state.poseBus?.clear()   // 新的一帧：清掉上一帧的姿态累计
    tickDt()
    updateMotion(frameDt)
    // 姿势值要先钉进 layers，applyPhysics 才会把物理输入一起喂进去
    state.poses?.apply(frameDt)
    state.layers.applyPhysics()
    state.facePinch?.applyPhysics()
    perf.time('pre', () => {
      state.gaze?.apply(frameDt)
      state.petSway?.apply(frameDt)
      state.facePinch?.applyPosture(frameDt)
      // 脊柱链：胸/腰跟随（喂给物理权重最高的 ParamBodyAngleX/Z）
      state.posture?.apply(frameDt)
      // 待机动作：常驻微摆 + 随机成套动作（叠加在同一份姿态里）
      state.idle?.apply(frameDt)
      // 痒痒的：躲痒小动作（摸脚/摸腰时）
      state.tickle?.apply(frameDt)
      // 姿态摆好之后，翻译成面捕捉取通道（物理要吃的就是这些）
      state.capture?.apply(frameDt)
    })
    // 各层只累加了增量，这里统一写成参数，物理拿到的就是这份合成姿态
    state.poseBus?.flush()
  })

  // ② 物理之后：表情 / 嘴 / 活气 / 鼓脸。
  // 物理会把 ParamAngle* / ParamBodyAngle* 当输出重算，所以姿态要在这里再写一次 ——
  // 但写的是**同一份合成姿态**（总线里的累计值），不是某一层的旧值，谁也不会盖掉谁。
  stage.onBeforeUpdate(() => {
    perf.time('post', () => {
      state.layers.apply()
      // 语音在放：把这一刻的电平喂给嘴（mouth 内部会平滑 + 叠音节）
      // 语音在放：电平喂嘴。乘 0.75 是为了别把嘴张到「打哈欠」的幅度（实测 0.9 电平会到 0.56 开口）
      if (state.voice?.playing) {
        // 电平原始区间只有 0.01–0.26，直接喂会「几乎不张嘴」。拉成 0..1 再交给 mouth
        const env = Math.max(0, Math.min(1, (state.voice.level() - 0.012) / 0.165))
        state.mouth?.speak(env)
      }
      state.mouth?.apply(frameDt)
      state.idleFaces?.apply(frameDt)
      state.life?.apply(frameDt)
      state.facePinch?.apply(frameDt)
      // 放在最后：表情层可能也写过这些角度，姿态合成值优先级最高
      state.poseBus?.flush()
    })
  })

  // ---------- 标定探针（开发期用：单参数覆写 / 物理读回采样） ----------
  installProbes({ motionState })

  const viewport = createViewport({ model: stage.model, app: stage.app })
  state.viewport = viewport
  viewport.observe($('#stage'))
  const clampOff = (v) => Math.max(-1.5, Math.min(1.5, Number(v) || 0))
  viewport.set({
    zoom: Number(state.settings.zoom) || 1,
    offsetX: clampOff(state.settings.offsetX),
    offsetY: clampOff(state.settings.offsetY),
  })

  // 窗口坐标为「客户端像素」，窗口外的点会是负数/越界值，正是我们要的方向。
  // 参考半径按「半个屏幕」给，所以鼠标跑到窗口外、桌面任何角落都有明确方向感。
  const lookFromClient = (cx, cy) => {
    // agent 正在指定视线（look 动作）时不抢镜，hold 到期自动交还鼠标
    if (performance.now() < (state.agentLookUntil || 0)) return
    // 捏脸时保持正脸：视线不再跟着鼠标转，否则鼓脸会转到侧面看不见
    if (state.facePinch?.state?.()?.side) return
    const r = stage.canvas.getBoundingClientRect()
    const sw = stage.app.screen.width, sh = stage.app.screen.height
    const dpr = sw / Math.max(1, r.width)
    const sx = ((cx - r.left) / Math.max(1, r.width)) * sw
    const sy = ((cy - r.top) / Math.max(1, r.height)) * sh
    const halfW = Math.max(r.width / 2, (window.screen?.width || r.width) / 2) * dpr
    const halfH = Math.max(r.height / 2, (window.screen?.height || r.height) / 2) * dpr
    const m = stage.model
    state.gaze.setTargetFromScreen(sx, sy, m.position.x, m.position.y, halfW, halfH)
    window.__gazeLast = { cx: Math.round(cx), cy: Math.round(cy) }
  }

  window.addEventListener('pointermove', (e) => {
    lookFromClient(e.clientX, e.clientY)
    // 抚摸中的位移（客户端像素）→ 头摆
    const lastC = state.lastClient
    state.lastClient = { x: e.clientX, y: e.clientY }
    if (state.petArmed && lastC) {
      state.petSway?.move(e.clientX - lastC.x, e.clientY - lastC.y, window.innerWidth, window.innerHeight)
    }
  })
  // 桌面级跟随：主进程持续读全局光标位置，窗口外也能看过去
  shell.onCursor?.((p) => {
    window.__cursorLast = p // 诊断用：看主进程推来的到底是什么坐标
    if (!window.__noDesktopGaze) lookFromClient(p.x, p.y)
  })
}

/** 捏脸时的表情反馈：＞＜ + 脸红（独立 source，松手整组撤掉，不干扰分区反应） */const PINCH_EXPRS = ['＞＜', '脸红']
function pinchExpressions(on) {
  if (!state.layers) return
  if (!on) { state.layers.removeSource('pinch'); return }
  for (const n of PINCH_EXPRS) {
    const def = (state.caps.expressions || []).find((e) => e.name === n)
    if (def) state.layers.addExpression(n, def.params, { source: 'pinch' })
  }
}

/**
 * 摸胯时的神态：眼睛只睁一半 + 眯眼 + 眉毛「\ /」+ 瞳孔收紧。
 * （模型没有「瞳孔缩放」参数，只有 PupilX/PupilY 透视位移，所以缩瞳用眯眼 + 收缩上下眼睑近似）
 */
const CROTCH_FACE = [
  { Id: 'ParamEyeLOpen', Value: 0.52, Blend: 'Overwrite' },
  { Id: 'ParamEyeROpen', Value: 0.52, Blend: 'Overwrite' },
  { Id: 'LEyeSquint', Value: 0.35, Blend: 'Add' },
  { Id: 'REyeSquint', Value: 0.35, Blend: 'Add' },
  { Id: 'ParamBrowLY', Value: -0.25, Blend: 'Add' },
  { Id: 'ParamBrowRY', Value: -0.25, Blend: 'Add' },
  { Id: 'ParamBrowLAngle', Value: -0.8, Blend: 'Add' },
  { Id: 'ParamBrowRAngle', Value: 0.8, Blend: 'Add' },
]
function crotchFace(on) {
  if (!state.layers) return
  if (!on) { try { state.layers.removeSource('crotch-face') } catch {}; return }
  try { state.layers.addExpression('胯部神态', CROTCH_FACE, { source: 'crotch-face', fade: 0.28 }) } catch {}
}

/**
 * 模型三态：常态 → 爱心眼 → 黑框眼镜（点额头循环）。
 * source 独立（'mode'），不和分区反应 / agent 表情互相覆盖。
 */
const MODE_LIST = ['常态', '爱心眼', '黑框眼镜']
let modeName = '常态'
function applyMode(name) {
  const next = MODE_LIST.includes(name) ? name : '常态'
  modeName = next
  if (!state.layers) return next
  // 三态互斥：爱心眼 / 眼镜不管来自哪一层（额头循环、点头部的 switch 层、手动按钮）都先清掉，
  // 否则爱心眼会一直挂在脸上，切回常态也消不掉
  for (const n of ['爱心眼', '黑框眼镜']) {
    try { state.layers.removeExpression(n) } catch {}
  }
  try { state.layers.removeSource('mode') } catch {}
  if (next !== '常态') {
    const def = (state.caps?.expressions || []).find((e) => e.name === next)
    if (def) {
      try { state.layers.addExpression(next, def.params, { source: 'mode', fade: 0.22 }) } catch {}
    }
  }
  return next
}
function cycleMode() {
  const i = MODE_LIST.indexOf(modeName)
  return applyMode(MODE_LIST[(i + 1) % MODE_LIST.length])
}

/**
 * 体型：模型用 `Clothes2` 参数切（默认体型 0 / 体型1 0.4 / 体型2 1）。
 * 原包是三个表达式，这里改成连续拉条，设置里拖到哪里就是哪里。
 */
function applyBodyShape(v) {
  const val = Math.max(0, Math.min(1, Number(v) || 0))
  state.bodyShape = val
  if (!state.layers) return val
  try { state.layers.removeSource('body') } catch {}
  try { state.layers.addExpression('体型', [{ Id: 'Clothes2', Value: val, Blend: 'Add' }], { source: 'body', fade: 0.25 }) } catch {}
  return val
}

/** 触摸动作 → 台词档（tap / pet 分开；脚和腰的 pet 由「痒痒的」统一说话，这里不重复） */
const TOUCH_PHRASE = {
  头: { tap: 'head', pet: 'head' },
  胸: { tap: 'chest', pet: 'chest' },
  腰: { tap: 'waistTap' },
  裙摆: { tap: 'skirt', pet: 'skirt' },
  腿: { tap: 'legs', pet: 'legs' },
  脚: { tap: 'foot' },
  左手: { pet: 'handPet' },
  右手: { pet: 'handPet' },
  胯: { tap: 'crotchTap' },
  尾巴: { tap: 'tail', pet: 'tailPet' },
}

/**
 * 热区迁移表。
 * 每条 = 「这几个热区应该有几块、当前版本号是多少、不够或过旧时怎么重建」。
 * 以前是三个手写的 if 链堆在 bootRegions 里（脸 V3 / 手 V1 / 胯 V1），加一个热区就要
 * 再抄一段；现在加新热区只是往表里加一条。
 */
const ZONE_MIGRATIONS = [
  {
    // 脸部热区（捏脸用）：左右各一个，眼睛以上仍归头部；老档案（单个「脸」）自动迁移
    names: ['左脸', '右脸'],
    version: 3,
    build: ({ core, internalModel, displayNames, canvas }) => (
      faceRegions({ core, internalModel, displayNames, canvas }).map((r) => ({ ...r, reaction: {} }))
    ),
  },
  {
    // 手部热区：两只手垂在裙摆两侧、又会随身体摆，固定矩形必然错位，所以按网格周期重算
    names: ['左手', '右手'],
    version: 1,
    build: ({ handReader }) => handReader.read().map((r) => ({ ...r, reaction: DEFAULT_REACTIONS[r.name] || {} })),
  },
  {
    // 额头热区：点一下切换 常态 / 爱心眼 / 眼镜（层级压过「头」，才抢得到点击）
    names: ['额头'],
    version: 1,
    build: ({ core, internalModel, displayNames, canvas }) => (
      foreheadRegion({ core, internalModel, displayNames, canvas }).map((r) => ({ ...r, reaction: {} }))
    ),
  },
  {
    // 头发热区：头部的上半段，压在「头」上面抢点击。
    // 不加这块的话摸头顶和摸脸没有差别，少一档手感。
    names: ['头发'],
    version: 1,
    build: ({ store }) => {
      const head = store?.all?.find((r) => r.name === '头')
      const pts = head?.points || []
      if (!pts.length) return []
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const x0 = Math.min(...xs), x1 = Math.max(...xs)
      const y0 = Math.min(...ys), y1 = Math.max(...ys)
      const w = x1 - x0, h = y1 - y0
      return [{
        name: '头发',
        z: (head.z || 0) + 1,
        points: [
          [Math.round(x0 + w * 0.16), Math.round(y0)],
          [Math.round(x1 - w * 0.16), Math.round(y0)],
          [Math.round(x1 - w * 0.16), Math.round(y0 + h * 0.34)],
          [Math.round(x0 + w * 0.16), Math.round(y0 + h * 0.34)],
        ],
        reaction: {},
      }]
    },
  },
  {
    // 胯部热区：模型自带参数里手臂够不到胯（±1 只能挪 ~400px），所以单独划一块
    names: ['胯'],
    version: 1,
    build: ({ canvas }) => {
      const cx = canvas.width / 2
      const halfW = canvas.width * 0.11
      const x0 = Math.round(cx - halfW), x1 = Math.round(cx + halfW)
      const y0 = Math.round(canvas.height * 0.415), y1 = Math.round(canvas.height * 0.505)
      return [{ name: '胯', z: 6, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], reaction: DEFAULT_REACTIONS['胯'] || {} }]
    },
  },
]

function migrateZones(ctx) {
  for (const m of ZONE_MIGRATIONS) {
    const cur = state.store.all.filter((r) => m.names.includes(r.name))
    const upToDate = cur.length === m.names.length && cur.every((r) => r.v === m.version)
    if (upToDate) continue
    for (const r of cur) state.store.remove(r.id)
    let fresh = []
    try { fresh = m.build(ctx) || [] } catch (e) {
      // 迁移失败不要静默：以前这里 catch 成空数组，直接把热区丢掉且毫无痕迹
      console.warn('[zones] 迁移失败', m.names.join('/'), e)
      continue // 保留旧的热区，下次启动再试
    }
    for (const z of fresh) state.store.add({ ...z, v: m.version })
    if (fresh.length) state.store.save(ctx.key)
  }
}

function bootRegions() {
  const key = state.caps.model.name
  state.store = createRegionStore([])
  const bands = ['头', '胸', '腰', '裙摆', '腿', '脚', '尾巴']
  // 部件 id → 显示名走 Map：原来每次都是一次 148 项线性查找，采样期被调用上百次
  const partNameById = new Map((state.caps.parts || []).map((p) => [p.id, p.name]))
  const names = {
    get: (i) => {
      try { return partNameById.get(state.stage.core.getPartId(i).getString().s) || '' } catch { return '' }
    },
  }
  const loaded = state.store.load(key)
  // 补丁里的热区优先落地（用户拿原模型 + 补丁即可复现同一套热区）
  if (state.patch?.regions?.regions?.length) state.store.loadJSON(state.patch.regions)
  const missing = loaded ? bands.filter((n) => !state.store.all.some((r) => r.name === n)) : bands
  if (!loaded || missing.length) {
    const seeded = seedRegions({
      core: state.stage.core,
      internalModel: state.stage.model.internalModel,
      displayNames: names,
      canvas: state.stage.modelSize(),
    })
    for (const r of state.store.all.slice()) state.store.remove(r.id)
    for (const r of seeded) state.store.add({ ...r, reaction: DEFAULT_REACTIONS[r.name] || {} })
    state.store.save(key)
  }

  // 手部热区读取器：迁移与周期重算共用同一个（索引表内部缓存）
  const handReader = createHandZoneReader({
    core: state.stage.core,
    internalModel: state.stage.model.internalModel,
    displayNames: names,
    canvas: state.stage.modelSize(),
  })
  state.handReader = handReader

  // 热区版本迁移（脸 V3 / 手 V1 / 胯 V1）：缺了就补，版本旧了就重建，不改动其它热区
  migrateZones({
    key,
    handReader,
    store: state.store,
    core: state.stage.core,
    internalModel: state.stage.model.internalModel,
    displayNames: names,
    canvas: state.stage.modelSize(),
  })

  // 左/右脸热区要**跟着变形走**：前倾这类动作会让脸整体下移，
  // 热区若固定在初始位置就会「摸脸点到胸」。这里按当前蒙皮顶点周期重算（只改内存，不改存档）。
  function startFaceRegionTracking(partNames) {
    // 索引表缓存一次，之后每次只取那几个 drawable 的顶点（原来每次都要全量扫 715 个）
    const reader = createFaceZoneReader({
      core: state.stage.core,
      internalModel: state.stage.model.internalModel,
      displayNames: partNames,
      canvas: state.stage.modelSize(),
    })
    state.faceReader = reader
    setInterval(() => {
      const cur = state.store.all.filter((r) => r.name === '左脸' || r.name === '右脸')
      if (cur.length === 2) {
        let fresh = []
        perf.time('face', () => {
          try { fresh = reader.read() } catch { fresh = [] }
        })
        if (fresh.length === 2) {
          for (const r of cur) {
            const f = fresh.find((x) => x.name === r.name)
            if (f) r.points = f.points
          }
        }
      }
      // 额头跟着脸一起重算（前倾/歪头时整张脸会移动）
      const fore = state.store.all.find((r) => r.name === '额头')
      if (fore) {
        try { const pts = reader.readForehead?.(); if (pts) fore.points = pts } catch {}
      }
      // 手和脸用同一个心跳：各自缓存索引表，单次都是亚毫秒级
      const hands = state.store.all.filter((r) => r.name === '左手' || r.name === '右手')
      if (hands.length === 2) {
        let freshHands = []
        perf.time('hand', () => {
          try { freshHands = state.handReader.read() } catch { freshHands = [] }
        })
        if (freshHands.length === 2) {
          for (const r of hands) {
            const f = freshHands.find((x) => x.name === r.name)
            if (f) r.points = f.points
          }
        }
      }
    }, 80)
  }

  state.regionInput = createRegionInput({
    store: state.store,
    viewport: state.viewport,
    canvas: $('#stage'),
    isNear: (sp) => {
      const s = state.stage.size()
      const m = 8
      return sp.x >= -m && sp.y >= -m && sp.x <= s.width + m && sp.y <= s.height + m
    },
    onEvent: (ev) => {
      const rawName = ev.region?.name
      // 额头热区只管「点击切三态」；抚摸/拖动仍按头部处理，否则滑动摸头会被额头吃掉
      const name = rawName === '额头' && ev.type !== 'tap' ? '头' : rawName
      // 上行反馈：真正发生的互动（点 / 摸第一步 / 拖）才报，避免移动刷屏
      if (ev.type === 'tap' || (ev.type === 'pet' && ev.step === 1) || ev.type === 'dragStart' || ev.type === 'dragEnd') {
        const p = ev.point || {}
        emitFeedback({
          type: 'interaction',
          region: name || null,
          gesture: ev.type === 'tap' ? 'click' : ev.type === 'dragStart' || ev.type === 'dragEnd' ? 'drag' : 'pet',
          detail: ev.type === 'pet' ? `step ${ev.step}` : null,
          at: { x: Math.round(p.x ?? 0), y: Math.round(p.y ?? 0) },
        }, state.settings?.token)
      }
      // 互动层：连点 / 长按 / 头发 / 跨区彩蛋（tap、pet 的老逻辑仍在下面，不重复）
      try {
        const snap = state.mood?.snapshot?.()
        state.touch?.event({ type: ev.type, name, step: ev.step }, snap ? toneOf(snap) : 'plain')
        state.applyBodyMood?.()
      } catch (e) { console.warn('[touch]', e) }
      const isHand = name === '左手' || name === '右手'
      // 一互动就让待机动作让位：不是暂停，而是彻底停掉当前动作（撤表情/姿势/固定参数），
      // 否则会出现「黑脸 + 打瞌睡半睁眼」这种叠出来的怪状态。
      // 只认真正的接触（按下 / 抚摸 / 拖拽），hover 不算 —— 鼠标停在角色身上不该冻结待机。
      if (ev.type === 'down' || ev.type === 'pet' || ev.type === 'dragStart') state.idle?.reset?.(2600)
      // 摸到别处就把「摸胯神态」收掉，不然半睁眼会挂到下一个动作上
      if (name !== '胯' && (ev.type === 'down' || ev.type === 'tap' || (ev.type === 'pet' && ev.step === 1))) {
        clearTimeout(state.crotchFaceHold)
        crotchFace(false)
      }
      // 摸胸：右手盖到胸口（举手姿势），表情走分区反应（屑屑眼）
      if (name === '胸' && ev.type === 'pet' && ev.step === 1) {
        state.poses?.set('举手', 320)
        clearTimeout(state.chestHold)
        state.chestHold = setTimeout(() => { state.poses?.release(420) }, 3600)
      }
      // 摸胯：台词/姿势/表情统一交给 touch 层（app/touch.mjs 的 crotchAction），
      // 这里只保留「摸完多久把姿势收掉」这条收尾，避免和 touch 的台词互相覆盖。
      if (name === '胯' && ev.type === 'pet' && ev.step === 1) {
        clearTimeout(state.crotchHold)
        state.crotchHold = setTimeout(() => { state.poses?.release(420) }, 4200)
      }
      // 点额头 = 模型三态循环：常态 → 爱心眼 → 黑框眼镜
      if (ev.type === 'tap' && name === '额头') {
        const m = cycleMode()
        toast(`表情：${m}`)
      // 点手 = 竖手指（抬起/放下），不再走表情反应；摸手还是 ＞＜ + 脸红
      } else if (ev.type === 'tap' && isHand) {
        const next = state.poses?.toggle('竖手指')
        toast(next === '竖手指' ? '竖手指' : '手放下')
        state.bubble?.say('hand', { ms: 2400 })
      } else if (ev.type === 'tap' && name && name !== '脸') {
        state.reactions.apply(ev.region, 'tap')
        const k = TOUCH_PHRASE[name]?.tap
        if (k) state.bubble?.say(k, { ms: 2400 })
      }
      if (ev.type === 'pet' && name && name !== '脸' && ev.step === 1) {
        // 额头抚摸回退成「头」之后，反应表也要按「头」查，否则 ＞＜ / 脸红 出不来
        const rxRegion = ev.region?.name && ev.region.name !== name ? { ...ev.region, name } : ev.region
        state.reactions.apply(rxRegion, 'pet')
        // 脚 / 腰 = 被挠痒：痒痒的动作 + 躲痒台词；其它部位按映射各说一句
        if (name === '脚' || name === '腰') {
          state.tickle?.start()
          state.bubble?.say('tickle', { ms: 2600 })
        } else {
          const k = TOUCH_PHRASE[name]?.pet
          if (k) state.bubble?.say(k, { ms: 2600 })
        }
        // 摸到不同部位，嘴给一个对应的情绪（表情包只改眼/脸，嘴是我们这层驱动的）
        const mood = REGION_MOUTH[name]
        if (mood) state.mouth?.setMood(mood, mood.ms)
      }
      // 被点/被摸的时候，耳朵跟着扑棱一下（平时它自己每 6~13 秒也会扑棱）
      if (name === '头' && (ev.type === 'tap' || (ev.type === 'pet' && ev.step === 1))) {
        state.life?.flap(Math.random() < 0.5 ? 'L' : 'R', 1)
      }
      // 只有头会「跟着手摆」：按下起记位移，滑动按 50% 转成角度；其它部位不再弹
      if (name === '头') {
        if (ev.type === 'down' || (ev.type === 'pet' && !state.petArmed)) {
          state.petArmed = true
          state.lastClient = null
          state.petSway?.start('头')
        } else if (ev.type === 'up' || ev.type === 'petEnd') {
          state.petArmed = false
          state.petSway?.release()
        }
      }
      // 捏脸：按住脸拖 → 鼓脸
      // 捏脸：左右各一半热区，按住哪边捏哪边（方向不再参与判定）
      if (name === '左脸' || name === '右脸') {
        if (ev.type === 'down') {
          state.facePinch?.grab(name === '右脸' ? 'R' : 'L')
          // 正脸：视线回中，鼓脸才看得见
          state.gaze?.setTarget?.(0, 0)
          pinchExpressions(true)
          state.bubble?.say('pinch', { ms: 2000 })
        } else if (ev.type === 'dragMove') {
          // ev.dx/dy 是模型坐标，换成客户端像素再交给捏脸层（maxPull 是按像素定的）
          // 镜像期间 scale.x 是负的，取绝对值，不然拖动方向会反
          const k = Math.abs(state.stage?.model?.scale?.x || 1)
          state.facePinch?.move((ev.dx || 0) * k, (ev.dy || 0) * k)
        } else if (ev.type === 'up') {
          state.facePinch?.release()
          pinchExpressions(false)
        }
      }
      // 手在哪的偏摆已废弃：现在由 pointermove 的位移驱动（见上方 petArmed）
    },
  })
  state.regionInput.attach($('#stage'))
  startFaceRegionTracking(names)
}

/** 通用「按住拖动 = 搬窗口」绑定 */function dragWindow(el, { canStart, ignore } = {}) {
  let dragging = false
  let lastX = 0
  let lastY = 0
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    if (ignore?.(e)) return
    if (canStart && !canStart(e)) return
    dragging = true
    state.windowDragging = true
    lastX = e.screenX
    lastY = e.screenY
    el.classList.add('dragging')
    try { el.setPointerCapture(e.pointerId) } catch {}
  })
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.screenX - lastX
    const dy = e.screenY - lastY
    if (!dx && !dy) return
    lastX = e.screenX
    lastY = e.screenY
    // 抓取向量：按事件时间算实时速度（px/s），拖拽物理直接吃这份，而不是等窗口坐标的帧间差分
    const now = performance.now()
    const dtEv = Math.max(0.004, (now - (state.dragVec?.t || now - 16)) / 1000)
    const cap = 6000
    state.dragVec = { vx: Math.max(-cap, Math.min(cap, dx / dtEv)), vy: Math.max(-cap, Math.min(cap, dy / dtEv)), t: now }
    shell.moveBy(dx, dy)
    // 拖着窗口走的时候输入条得跟着：窗口位置变了，屏幕坐标也跟着变，
    // 直接改 top 就行（不需要重新量包围盒，她相对窗口没动）
    nudgeChatbarForMove()
  })
  const end = (e) => {
    dragging = false
    state.windowDragging = false
    state.dragVec = null
    el.classList.remove('dragging')
    try { el.releasePointerCapture(e.pointerId) } catch {}
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  return el
}

// ---------- 透明处穿透：只让「角色轮廓」接收鼠标 ----------
// 窗口是矩形，透明区本来也吃鼠标：停在空白处，后面的桌面/窗口点不到；
// 空白处按下还能把整块看不见的窗口拖走 —— 这就是「隐藏的窗口边缘」。
// 做法：把当前帧渲染成缩略 alpha 掩码，指针不在角色身上就让点击穿过去。
const MASK_SCALE = 4
// 掩码几乎全空 = 没渲染出来，这种情况下永远保持可点，别把窗口弄成点不动的死窗
const MASK_MIN_COVERAGE = 0.004

let maskSentAt = 0
/** 把掩码压成 1 bit/格传主进程：穿透判定由它做（页面在后台时这里的事件/定时器会被节流） */
function uploadMask(m) {
  if (!m || !m.w || !m.h) return
  const now = performance.now()
  if (now - maskSentAt < 150) return
  maskSentAt = now
  const r = state.stage.canvas.getBoundingClientRect()
  const bits = new Uint8Array(m.w * m.h)
  let on = 0
  for (let i = 0; i < bits.length; i++) {
    const v = m.data[i] > 8 ? 1 : 0
    bits[i] = v
    on += v
  }
  // resize 之后头几帧读到的 alpha 全是 0（GL buffer 失效）。这种空表发过去会让主进程
  // 判定"哪儿都是透明的"，整窗穿透、点击全失效（小豆丁形态缩窗口后最容易遇到）。
  // 直接作废，让主进程退回"整窗可点"，等下一次有效掩码。
  if (on < 8) { shell.setMask({ invalid: true }); return }
  shell.setMask({
    w: m.w, h: m.h,
    x: Math.round(r.left), y: Math.round(r.top),
    cw: Math.max(1, Math.round(r.width)), ch: Math.max(1, Math.round(r.height)),
    bits,
    // Q 版走的是「画布 CSS 放大裁切」，掩码坐标和窗口坐标之间差一个 view 变换
    view: state.view || null,
    box: state.lastInkBox || null,
  })
}

const MASK_TTL = 700
/** 轮廓在掩码里的实际高度（像素）。体型换了（body1/body2 是 Q 版小只，不是等比放大）
 *  只能用实测轮廓算窗口倍数，写死系数一定错。 */
function maskHeight(m) {
  if (!m?.w || !m?.h) return 0
  let top = -1
  let bottom = -1
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (m.data[y * m.w + x] > 8) { if (top < 0) top = y; bottom = y; break }
    }
  }
  return top < 0 ? 0 : bottom - top + 1
}

/** 量到轮廓高度就顺手记基准（只有「正常体型」能当基准，Q 版不能） */
function noteMaskHeight(m) {
  const h = maskHeight(m)
  state.maskH = h
  if (h && !state.baseMaskH && (state.look?.body || '1') === '1') state.baseMaskH = h
  return h
}

/**
 * 量"她实际占了画布多少高"（0–1）。
 * 不用 alphaMask：窗口 resize 之后 GL 的 drawing buffer 会失效，readPixels 读回全 0
 * （实测：resize 一次之后掩码永远是 0，连通用的穿透判定都受影响）。
 * 这里用 Pixi 的 extract 离屏抽一张，和窗口尺寸无关。
 */
async function inkRatio() {
  try {
    const app = state.stage?.app
    if (!app?.renderer?.extract) return 0
    const src = await app.renderer.extract.canvas(app.stage)
    const W = 120
    const H = Math.max(1, Math.round((W * src.height) / Math.max(1, src.width)))
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(src, 0, 0, W, H)
    const d = ctx.getImageData(0, 0, W, H).data
    let top = -1
    let bottom = -1
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > 8) { if (top < 0) top = y; bottom = y; break }
      }
    }
    return top < 0 ? 0 : (bottom - top + 1) / H
  } catch (e) {
    console.warn('[ink] 测量失败', e?.message || e)
    return 0
  }
}

/** 形态变了：量一次「她占画布多高」，按比例改窗口。
 *
 * 为什么要量：`body1/body2` 不是等比缩小，是**另一套 Q 版素材**，只占画布中间约四分之一。
 * 窗口不跟着缩的话，她就变成大窗口正中的一个小点，输入框还留在老远的底部。
 *
 * 用什么量：`inkRatio()`（`renderer.extract` 离屏渲染后扫 alpha 得到"占画布高度的比例"）。
 * 不能用 `alphaMask` —— 换表情会触发全量重绘，那一帧的 GL buffer 是空的，`readPixels` 读回全 0。
 */
async function measureBodyK() {
  const body = state.look?.body || '1'
  // 换形态是 exp3 的 0.25s 过渡，立刻量会量到"上一个人"——等淡入走完再量
  await new Promise((r) => setTimeout(r, 340))
  let ratio = await inkRatio()
  if (!ratio) return
  // 过渡还没走完时量到的是"中间态"（比如从正常切 Q 版会量成 0.6）。
  // 再等 400ms 补量一次，取**小的那个** —— 小只只可能更小，不会更大。
  await new Promise((r) => setTimeout(r, 400))
  const again = await inkRatio()
  if (again) ratio = Math.min(ratio, again)
  // 基准只在「正常比例」且量得合理时更新：Q 版/加载中量出来的值不能当基准，否则一换就是一倍循环
  if (body === '1' && ratio > 0.8) state.inkBase = ratio
  const base = state.inkBase && state.inkBase > 0.8 ? state.inkBase : INK_BASE_FALLBACK
  state.bodyK = Math.max(0.2, Math.min(1, ratio / base))
  applyFit(true)
  console.log('[look] 窗口跟随：占画布', ratio.toFixed(3), '基准', (state.inkBase || 0).toFixed(3), '倍数', Number(state.bodyK || 1).toFixed(2))
}
/** 用离屏渲染量她的包围盒（CSS 像素），给主进程当「没有像素掩码时」的兜底命中区。
 *  resize 之后 `alphaMask` 会一直读到全 0（GL buffer 失效），这时总不能整窗都算她的。 */
async function inkBox() {
  try {
    const app = state.stage?.app
    const canvas = state.stage?.canvas
    if (!app?.renderer?.extract || !canvas) return null
    const src = await app.renderer.extract.canvas(app.stage)
    const W = 96
    const H = Math.max(1, Math.round((W * src.height) / Math.max(1, src.width)))
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(src, 0, 0, W, H)
    const d = ctx.getImageData(0, 0, W, H).data
    let x0 = W, y0 = H, x1 = -1, y1 = -1
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (x1 < 0) return null
    // 用**布局尺寸**而不是 getBoundingClientRect：画布上挂着 CSS 缩放/裁切，
    // rect 是变换后的尺寸，按它算会把缩放算两遍（表现为输入条越缩越往上跑）。
    const cw = canvas.clientWidth || canvas.width || window.innerWidth
    const ch = canvas.clientHeight || canvas.height || window.innerHeight
    return {
      x: Math.round((x0 / W) * cw),
      y: Math.round((y0 / H) * ch),
      w: Math.max(1, Math.round(((x1 - x0 + 1) / W) * cw)),
      h: Math.max(1, Math.round(((y1 - y0 + 1) / H) * ch)),
    }
  } catch { return null }
}

/** 把画布坐标的包围盒换算成窗口坐标（裁切放大时两者差一个 view 变换） */
async function inkBoxWin() {
  const raw = await inkBox()
  if (!raw) return null
  const zv = state.zoomV || 1
  const box = zv === 1 ? raw : scaleBoxAboutCenter(raw, zv, window.innerWidth, window.innerHeight)
  const v = state.view
  if (!v) return box
  return {
    x: Math.round((box.x - v.bx) * v.k),
    y: Math.round((box.y - v.by) * v.k),
    w: Math.round(box.w * v.k),
    h: Math.round(box.h * v.k),
  }
}

function reportHitBox() {
  void inkBoxWin().then((box) => { if (box) shell.setMask?.({ invalid: true, box }) })
}

function refreshMask(force = false) {
  const now = performance.now()
  if (!force) {
    if (state.mask && now - state.maskAt < MASK_TTL) return state.mask
    // 不在这里重画：挂个待办，等这一帧画完之后直接读回来（见 bindPassThrough 里的 afterRender）。
    // 事件回调里插一次渲染会打乱帧节奏，窗口正在拖动时尤其明显（虚影/闪烁）。
    state.maskPending = true
    return state.mask
  }
  const m = perf.time('mask', () => state.stage?.alphaMask?.(MASK_SCALE, (k, ms) => perf.mark(`m.${k}`, ms)))
  if (m) { state.mask = m; state.maskAt = now; state.maskPending = false; noteMaskHeight(m); uploadMask(m) }
  return state.mask
}

/** 客户端坐标是否落在角色身上；拿不到掩码一律当作「在」——宁可点得到 */
function bodyAt(x, y) {
  const m = state.mask
  // 掩码太旧就别拿它做判断：窗口不在前台/被遮挡时渲染会停，掩码停在「上一次鼠标位置」，
  // 于是鼠标明明在她身上，判定却是「透明」→ 整窗穿透 → 点不到也拖不动
  // （表现为「必须先点一下桌宠窗口才能拖」）。宁可暂时当成命中去挡一下鼠标，也不能让她点不到。
  if (m && performance.now() - (state.maskAt || 0) > 1200) return true
  if (!m || m.coverage < MASK_MIN_COVERAGE) return true
  const r = state.stage.canvas.getBoundingClientRect()
  const sx = (x - r.left) / Math.max(1, r.width)
  const sy = (y - r.top) / Math.max(1, r.height)
  if (sx < 0 || sy < 0 || sx > 1 || sy > 1) return false
  const cx = Math.min(m.w - 1, Math.floor(sx * m.w))
  const cy = Math.min(m.h - 1, Math.floor(sy * m.h))
  // 一个小膨胀：边缘抖一两格不算离开角色，免得边沿闪烁
  for (let dy = -1; dy <= 1; dy++) {
    const ny = cy + dy
    if (ny < 0 || ny >= m.h) continue
    for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx
      if (nx < 0 || nx >= m.w) continue
      if (m.data[ny * m.w + nx] > 8) return true
    }
  }
  return false
}

// ---------- 透明处穿透 ----------
// 判据三条：
//   1. 指针落在工具条 / 「恢复鼠标」浮标这些 HTML 控件上 → 一律接收（否则开了穿透连按钮都点不到）
//   2. 手动穿透模式 → 角色也将鼠标穿透（UI 之外一律忽略）
//   3. 常态 → 按住期间不穿透，其余看角色轮廓掩码
// 注意：窗口尺寸不再手拖，所以没有「轮廓把手」这一类必须接收的例外了。
function createPassThrough() {
  let pending = null
  let queued = false
  let timer = 0

  /** 当前指针位置该不该穿透；没坐标时给 null（不改变现状） */
  function decide() {
    if (!pending || !state.settings) return null
    // 显示窗口边框时整窗接收鼠标：边框把手要能拖，不能把鼠标漏给桌面
    if (state.borderOn) return false
    const el = document.elementFromPoint(pending.x, pending.y)
    if (el && el.tagName !== 'CANVAS') return false
    if (state.settings.clickThrough) return true
    return !state.pointerDown && !bodyAt(pending.x, pending.y)
  }

  function applyNow() {
    queued = false
    // 穿透由主进程按「系统光标 + 渲染轮廓掩码」判定（见 main.mjs 的 updateHit）。
    // 这里只保留手动穿透这一条，两边都判会互相覆盖，表现为窗口抖着穿透/不穿透。
    // 手动「穿透模式」由主进程读 settings.clickThrough 决定；自动穿透由 updateHit 决定。
    // 页面这边不再下发，否则两边各写一次同一个开关，会互相覆盖。
    state.ignoring = !!state.settings?.clickThrough
  }

  return {
    track(x, y) {
      pending = { x, y }
      refreshMask()
      if (queued) return
      queued = true
      // 用 16ms 定时而不是 rAF：窗口被完全遮挡时 rAF 会停，判定就永远不更新
      clearTimeout(timer)
      timer = setTimeout(() => perf.time('pass', applyNow), 16)
    },
    /** 勾选/取消穿透、松手之后立刻按当前指针重算，不必等鼠标再晃一下 */
    recompute() { if (pending) perf.time('pass', applyNow) },
    /** 只算不应用（验证/调试用）：给定坐标下的穿透判定结果 */
    decideAt(x, y) {
      const keep = pending
      pending = { x, y }
      const want = decide()
      pending = keep
      return want
    },
  }
}

/**
 * 按住期间一概不穿透：滑出轮廓那一刻若忽略鼠标，pointerup 会丢，抚摸/拖动就卡在按下态。
 */
function bindPointerHeld() {
  const down = () => { state.pointerDown = true }
  const up = () => { state.pointerDown = false }
  window.addEventListener('pointerdown', down, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  // 用户在动（点她/拖她）：把「安静多久」重置，主动开口会往后顺延
  window.addEventListener('pointerdown', () => { shell.proactiveTouch?.() }, true)
  // 「点一下」才算打断（和 Esc 同义）。以前挂在 pointerdown 上，结果**拖动窗口也会把话掐掉**，
  // 所以改成按下→抬起位移小于 8px 才认。
  let tap = null
  // 面板/工具条上的点击，不该当成「点她」
  const hitPanel = (el) => !!el?.closest?.('#look-panel, #tools, #chatbar')
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    tap = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      onPanel: hitPanel(e.target),
      // 按下时面板是否开着：开着的话这一下多半是「点空白关面板」，不该算点她
      panelWasOpen: !$('#look-panel')?.classList.contains('hidden'),
    }
  }, true)
  window.addEventListener('pointerup', (e) => {
    const d = tap
    tap = null
    if (!d || e.button !== 0) return
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y)
    if (moved > 8 || performance.now() - d.t > 600) return   // 拖动/长按不算点
    if (d.onPanel) return                                    // 点在面板/工具条上
    if (d.panelWasOpen) return                               // 右键开面板 → 左键关面板，不打断
    // 只有真的点在她身上才打断：点透明空白处不该把话掐掉
    // 包围盒有时是画布坐标、有时是窗口坐标，判不准就别用它否决（面板那两道闸已经够）
    const box = state.lastInkBox
    const boxOk = !!box && box.x >= 0 && box.x < window.innerWidth && box.y >= 0 &&
      box.y < window.innerHeight && box.w > 0 && box.w <= window.innerWidth && box.h > 0 && box.h <= window.innerHeight
    let inside = true
    if (boxOk) {
      inside = e.clientX >= box.x - 6 && e.clientX <= box.x + box.w + 6 &&
               e.clientY >= box.y - 6 && e.clientY <= box.y + box.h + 6
      if (!inside) return
    }
    window.__tapLast = { x: e.clientX, y: e.clientY, box, inside, panelWasOpen: d.panelWasOpen, suppressed: performance.now() < (state.tapSuppressUntil || 0), playing: !!state.voice?.playing }
    if (performance.now() < (state.tapSuppressUntil || 0)) return
    if (state.voice?.playing) { state.voice.stop(); shell.ttsStop?.(); resetFlow() }
  }, true)
  window.addEventListener('pointercancel', () => { tap = null }, true)
  // 拖动过程中窗口失焦（用户顺手点了别的窗口）时不要清 pointerDown：清了就会重新按掩码判定，
  // 指尖恰好落在轮廓外的话整窗变穿透，pointerup 永远收不到，拖动卡死。
  window.addEventListener('blur', () => { if (!state.windowDragging) up() })
  // 重新获得焦点时把掩码和穿透判定都强制刷一遍：窗口在后台时渲染可能停过，
  // 掩码停在旧位置，判定就会把「她身上」当成透明。
  window.addEventListener('focus', () => { refreshMask(true); state.recomputePass?.() })
}

/** 轮廓掩码读回：挂在「每帧画完」之后，只读像素、不额外渲染；拖窗口期间先攒着 */
function startMaskCapture() {
  // 她一直在晃，轮廓会变：定期标脏重拍（主进程按掩码判穿透，掩码太旧会判错）
  setInterval(() => { state.maskPending = true }, 500)
  state.stage?.afterRender?.(() => {
    if (!state.maskPending || state.windowDragging) return
    state.maskPending = false
    const m = perf.time('mask', () => state.stage.captureMask?.(MASK_SCALE, (k, ms) => perf.mark(`m.${k}`, ms)))
    if (m) { state.mask = m; state.maskAt = performance.now(); noteMaskHeight(m); uploadMask(m) }
  })
}

function bindPassThrough() {
  const pass = createPassThrough()
  state.passThrough = pass // 调试/验证入口（__pass.passAt）
  state.recomputePass = () => pass.recompute()
  bindPointerHeld()
  window.addEventListener('pointermove', (e) => pass.track(e.clientX, e.clientY))
  // 松手时指针可能已经在轮廓外，重算一次才不会停在「按下态不穿透」
  window.addEventListener('pointerup', () => pass.recompute())
  window.addEventListener('resize', () => {
    // 先作废旧掩码：这一刻 GL buffer 已经失效，接着读只会读到全透明
    shell.setMask?.({ invalid: true })
    setTimeout(() => { refreshMask(true); reportHitBox() }, 160)
    setTimeout(reportHitBox, 520)
  })
  startMaskCapture()
  refreshMask(true)
  // 舞台这会儿才齐（layers / caps 都就位），把启动时攒下的那一身穿上
  if (state.pendingLook) { applyLook(state.pendingLook, { persist: false }); state.pendingLook = null }
}

// ---------- 穿透模式 ----------
// 手动穿透时角色区完全不可点（连右键都进不来），所以必须留一个「鼠标也能点到」的退路：
// 面板/工具条本身仍然接收鼠标，再加一个常驻浮标一键恢复。
function setClickThrough(on) {
  applyPassState(on) // 单向落到界面，不触发设置回写（广播那条路自己会进来）
  shell.set({ clickThrough: !!on })
  if (on) toast('穿透已开：角色不可点，点下方「恢复鼠标」或按 Ctrl+Alt+L', 4000)
}

function showPassHint() {
  let el = $('#pass-hint')
  if (!el) {
    el = document.createElement('div')
    el.id = 'pass-hint'
    el.innerHTML = '<span>穿透中</span><button id="pass-restore" type="button">恢复鼠标</button>'
    el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);' +
      'display:flex;gap:8px;align-items:center;padding:7px 10px 7px 14px;border-radius:999px;' +
      'background:rgba(16,20,34,.94);border:1px solid rgba(120,150,255,.45);color:#dfe6ff;' +
      'font:12px/1 system-ui,sans-serif;z-index:9999;white-space:nowrap;box-shadow:0 6px 20px rgba(0,0,0,.45)'
    const btn = el.querySelector('#pass-restore')
    btn.style.cssText = 'all:unset;cursor:pointer;padding:5px 10px;border-radius:999px;' +
      'background:#5a7cff;color:#fff;font:12px/1 system-ui,sans-serif'
    btn.onclick = () => setClickThrough(false)
    document.body.appendChild(el)
  }
  el.style.display = 'flex'
}

function hidePassHint() {
  const el = $('#pass-hint')
  if (el) el.style.display = 'none'
}

// ---------- 窗口跟随角色（尺寸 = 模型画布 × 角色大小）----------
// 视口固定 contain、zoom 恒为 1：窗口多大，角色就多大 —— 「角色大小与窗口大小比例绑定」
// 在数值上的含义是窗口尺寸由模型画布推导，而不是反过来测角色包围盒（后者会形成正反馈）。
const FIT_BASE_W = 540      // zoom = 1 时角色的屏幕宽度（窗口再留出气泡余量）
const FIT_PAD_X = 0.12      // 左右各 6%：够气泡挂在头侧，又不会把角色缩太小
// 上下留白：设置里可调（0–18%）。默认 2% —— 边框刚好包住角色，不再上下各空 9%
const FIT_PAD_Y_DEFAULT = 0.02
const padY = () => {
  const v = Number(state.settings?.padY)
  return Math.max(0, Math.min(0.2, Number.isFinite(v) ? v : FIT_PAD_Y_DEFAULT))
}

function fitSize(zoomOverride) {
  const ms = state.stage?.modelSize?.()
  if (!ms?.width || !ms?.height) return null
  // 窗口尺寸**不再跟着缩放变**：永远按最大档（cap）开窗，滚轮只改画布里的内容倍率。
  // 透明窗口一旦频繁 setBounds 就会闪，这条是根治。
  const z = Number.isFinite(zoomOverride) ? zoomOverride : zoomCap()
  // 形态（Q 版）不参与缩放：窗口跟着缩，她也同比缩，等于没变大还更难看清
  const k = (FIT_BASE_W / ms.width) * z
  let w = ms.width * k * (1 + FIT_PAD_X)
  let h = ms.height * k * (1 + padY())
  // 上限：窗口不能比屏幕可用区还大。否则存下来的高度会超过屏幕，重启后头顶（或脚）被切掉，
  // 看起来就是「只显示半个人」。宽度同理 —— 窗口比屏幕宽时右边同样会被切。
  const scr = (typeof window !== 'undefined' && window.screen) || null
  const maxH = scr ? Math.max(240, (scr.availHeight || scr.height || 0) * 0.94) : Infinity
  const maxW = scr ? Math.max(160, (scr.availWidth || scr.width || 0) * 0.94) : Infinity
  const shrink = Math.min(1, maxH / h, maxW / w)
  if (shrink < 1) { w *= shrink; h *= shrink }
  return { w: Math.round(w), h: Math.round(h) }
}

/** 缩放上限：按屏幕可用区反算（zoom=1 时她多大 → 最多还能放大几倍）。
 *  这台机器她默认已经顶到高度上限，所以 cap 常常是 0.7 左右，往上滚没反应是**预期**。 */
function zoomCap() {
  const ms = state.stage?.modelSize?.()
  const scr = typeof window !== 'undefined' ? window.screen : null
  if (!ms?.width || !ms?.height || !scr) return ZOOM_MAX
  const k = FIT_BASE_W / ms.width
  const w1 = ms.width * k * (1 + FIT_PAD_X)
  const h1 = ms.height * k * (1 + padY())
  const availW = (scr.availWidth || scr.width || 1920) * 0.94
  const availH = (scr.availHeight || scr.height || 1080) * 0.94
  const cap = Math.min(ZOOM_MAX, availW / w1, availH / h1)
  return Math.max(ZOOM_MIN, Math.round(cap * 1000) / 1000)
}

let fitTimer = 0
// 上一次已经下发过的窗口尺寸：尺寸没变就不再发 IPC（以前每 100ms 发一次，主进程每发一次都会把窗口挪 1px）
let lastFitSize = { w: 0, h: 0 }
const BODY_BANDS = ['头', '胸', '腰', '裙摆', '腿', '脚']

/**
 * 身体中心（模型坐标）：只取静态的躯干/四肢热区包围盒，**不含尾巴和手**——
 * 尾巴和头发一直在摆，用真实轮廓去量会把角色越推越偏，而且每次浮动都不一样。
 */
function bodyAnchor() {
  const rs = (state.store?.all || []).filter((r) => BODY_BANDS.includes(r.name) && r.points?.length)
  if (!rs.length) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const r of rs) {
    for (const [x, y] of r.points) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY }
}

/**
 * 居中的归一化偏移——**纯几何算，不做任何运行时测量**。
 *
 * 视口是 contain：scale = min(W/mw, H/mh) × 0.95。窗口的长宽比被 FIT_PAD 固定，
 * 所以永远是「高度受限」那一支，scale/H = 0.95/mh，于是：
 *   offsetY = -2 × (身体中心y/mh − 0.5) × 0.95
 *   offsetX = -2 × (身体中心x/mw − 0.5) × 0.95 × (1+FIT_PAD_Y)/(1+FIT_PAD_X)
 * 全是模型常量，和窗口大小、缩放、测量时机都无关 —— 不会出现「切一次尺寸就偏一次」。
 */
function centerOffsets() {
  const b = bodyAnchor()
  const ms = state.stage?.modelSize?.()
  if (!b || !ms?.width || !ms?.height) return { x: 0, y: 0 }
  const fx = b.x / ms.width - 0.5
  const fy = b.y / ms.height - 0.5
  const k = 2 * 0.95 // 2 × 视口 margin
  const clamp = (n) => Math.max(-0.4, Math.min(0.4, n))
  return {
    x: clamp((-k * fx * (1 + padY())) / (1 + FIT_PAD_X)),
    y: clamp(-k * fy),
  }
}

/** 重算并下发窗口尺寸（连发合并 70ms，滚轮狂滚也不会打爆往主进程的 IPC） */
function applyFit(now = false) {
  const size = fitSize()
  if (!size) return
  const send = () => {
    fitTimer = 0
    const o = centerOffsets()
    state.viewport?.set({ zoom: 1, offsetX: o.x, offsetY: o.y })
    if (size.w !== lastFitSize.w || size.h !== lastFitSize.h) {
      lastFitSize = { w: size.w, h: size.h }
      shell.fit?.(size.w, size.h)
    }
    state.bubble?.reposition()
  }
  clearTimeout(fitTimer)
  if (now) { send(); return }
  fitTimer = setTimeout(send, 70)
}

// ---------- 窗口边框 / 等比缩放 ----------
// 窗口、角色、气泡共用同一比例：窗口高 = 模型高 × (540/宽) × (1+PAD) × zoom，
// 所以「当前 zoom」可以直接由窗口高度反推。拖边框改的是窗口尺寸，三者一起变。
// 气泡比例除以基准 0.8，让默认大小和旧版视觉一致。
const UI_BASE_ZOOM = 0.8

function refWindowHeight() {
  const ms = state.stage?.modelSize?.()
  if (!ms?.width || !ms?.height) return null
  return ms.height * (FIT_BASE_W / ms.width) * (1 + padY())
}
function zoomFromWindow() {
  const ref = refWindowHeight()
  if (!ref) return Number(state.settings?.zoom) || 1
  return window.innerHeight / ref
}
function headAnchor() {
  const box = state.lastInkBox
  if (!box || !box.w || !box.h) return null
  // 头大约在包围盒上沿往下 24% 的位置，横向取中间 40%
  const hh = box.h * 0.24
  const inset = box.w * 0.30
  return {
    left: box.x + inset,
    right: box.x + box.w - inset,
    top: box.y,
    bottom: box.y + hh,
    width: box.w - inset * 2,
    height: hh,
  }
}

function bubbleScale() {
  // ×1.06：比旧版大一号（用户反馈气泡框偏小）
  return Math.max(0.4, Math.min(2.5, (zoomFromWindow() / UI_BASE_ZOOM) * 1.06))
}

function applyBorder(on) {
  state.borderOn = !!on
  $('#frame')?.classList.toggle('hidden', !on)
  if (on) {
    // 边框要能接鼠标：这期间不做「透明处穿透」
    state.ignoring = false
    shell.setPassThrough?.(false)
  }
  state.recomputePass?.()
}

function endScale() {
  if (!state.scaleEdge) return
  state.scaleEdge = null
  shell.scaleEnd?.()
  const z = Math.max(0.2, Math.min(3, Math.round(zoomFromWindow() * 1000) / 1000))
  if (Math.abs(z - (Number(state.settings?.zoom) || 1)) > 0.002) shell.set?.({ zoom: z })
}

function bindFrame() {
  const f = $('#frame')
  if (!f) return
  const edges = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']
  f.innerHTML = edges.map((e) => `<div class="fh ${e}" data-edge="${e}"></div>`).join('')
  for (const h of f.querySelectorAll('.fh')) {
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      state.scaleEdge = h.dataset.edge
      shell.scaleBegin?.(state.scaleEdge)
      try { h.setPointerCapture(e.pointerId) } catch {}
    })
  }
  window.addEventListener('pointerup', endScale)
  window.addEventListener('pointercancel', endScale)
  window.addEventListener('blur', endScale)
  window.addEventListener('resize', () => {
    state.bubble?.setScale(bubbleScale())
    state.bubble?.reposition()
    // 窗口跟着「大小」变了之后，装扮面板要重新夹回来，否则底部会被切掉
    const lp = $('#look-panel')
    if (lp && !lp.classList.contains('hidden')) placeLookPanel(lp)
    reportChrome()
  })
}

/**
 * 左键「直线拖角色」= 搬窗口。
 *
 * 原版只在**没有热区**的身体空隙上允许左键拖动，而自动铺出来的热区几乎盖满整个角色，
 * 实际手感就是「拖不动」（只有中键能搬）。这里补一条判定：位移够远且路径够直 → 认定为搬窗口。
 * 抚摸（在同一个热区里来回划）路径明显更长，比值过不了阈值，仍然走原来的 pet 事件。
 *
 * 走 `shell.moveBy`（事件增量）而不是 `shell.dragBegin`（主进程读全局光标）：全局光标那条路
 * 一旦事件和真实光标不同步（远程桌面、合成事件、高 DPI 缩放）就完全不动，而且没法自测。
 */
function bindRegionDrag(stage) {
  let act = null
  // 搬窗口交给主进程：它读的是**系统光标**（screen.getCursorScreenPoint），是绝对量；
  // 而事件里的 screenX 是「窗口原点 + clientX」算出来的 —— 窗口被我们搬动之后，
  // 下一帧的 screenX 已经把这次位移包含进去了，再拿它算增量就是正反馈：
  // 一帧多走一段、下一帧又补偿回来，表现就是「一闪一闪 + 拖完位置跑偏」。
  const startDrag = () => {
    state.windowDragging = true
    stage.classList.add('dragging')
    shell.dragBegin()
    startChatbarFollow()
  }
  const stopDrag = () => {
    state.windowDragging = false
    stage.classList.remove('dragging')
    shell.dragEnd()
    refreshMask(true)
    stopChatbarFollow()
    scheduleChromePos(120)
  }
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    act = { x: e.screenX, y: e.screenY, lx: e.screenX, ly: e.screenY, walked: 0, started: false }
  })
  stage.addEventListener('pointermove', (e) => {
    if (!act || act.started) return
    // walked = 走过的总路程，dist = 起点到现在的直线距离：
    // 直线拖 walked/dist ≈ 1；来回划 walked ≫ dist —— 后者是抚摸，不搬窗口。
    act.walked += Math.hypot(e.screenX - act.lx, e.screenY - act.ly)
    act.lx = e.screenX
    act.ly = e.screenY
    const dist = Math.hypot(e.screenX - act.x, e.screenY - act.y)
    const min = Math.max(20, (stage.clientWidth || 520) * 0.05)
    if (dist < min) return
    if (act.walked / Math.max(1, dist) > 1.7) return
    act.started = true
    startDrag()
  })
  const end = () => {
    if (act?.started) stopDrag()
    act = null
  }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
  window.addEventListener('pagehide', end)
}

function bindWindowDrag() {
  const stage = $('#stage')
  // 左键搬窗口统一走 bindRegionDrag（直线拖 = 搬窗口，来回划 = 抚摸）。
  // 不要再挂 dragWindow：两条路都在算 screenX 增量，同一次拖动会被搬两遍 —— 窗口一帧往左
  // 120px、下一帧又往右 120px，看起来就是「一闪一闪」，而且拖完位置还会跑偏。
  bindRegionDrag(stage)
  bindMiddleDrag(stage)
  // 兜底：页面卸载/失焦时收不到 pointerup，主进程的拖动定时器必须显式停掉
  window.addEventListener('pagehide', () => shell.dragEnd())
  window.addEventListener('blur', () => shell.dragEnd())
}

/**
 * 中键拖动 = 搬窗口（和左键拖角色同一套：主进程按全局光标锚点搬，不累积漂移）。
 * 中键移动**不喂物理**（不产生惯性冲击），纯位移。
 */
function bindMiddleDrag(stage) {
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return
    e.preventDefault()
    hideTools()
    state.middleDragging = true
    shell.dragBegin()
    startChatbarFollow()
    try { stage.setPointerCapture(e.pointerId) } catch {}
  })
  const end = (e) => {
    if (!state.middleDragging) return
    state.middleDragging = false
    try { stage.releasePointerCapture(e.pointerId) } catch {}
    shell.dragEnd()
    refreshMask(true)
    stopChatbarFollow()
    scheduleChromePos(120)
  }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
}

// ---------- 右键弹窗：设置 / 退出（固定窗口右上角，不挡角色） ----------
function showTools() { $('#tools').classList.remove('hidden') }
function hideTools() { $('#tools').classList.add('hidden') }

/** 客户端坐标 → 命中的热区 */
function regionAtClient(x, y) {
  if (!state.store || !state.viewport) return null
  const p = state.viewport.clientToModel(x, y)
  return state.store.hit(p.x, p.y)
}

/**
 * 热区 → 客户端像素矩形（气泡定位 / 面板联动都用它）。
 * 换算方式与角色在窗口里的实际位置一致：canvas rect + 模型偏移 + 缩放。
 */
function regionScreenBox(name) {
  const r = state.store?.all?.find((x) => x.name === name)
  if (!r || !r.points?.length || !state.stage) return null
  const xs = r.points.map((p) => p[0])
  const ys = r.points.map((p) => p[1])
  const cr = state.stage.canvas.getBoundingClientRect()
  const sc = state.stage.model.scale.x
  const ms = state.stage.modelSize()
  const sx = (mx) => cr.left + state.stage.model.position.x + (mx - ms.width / 2) * sc
  const sy = (my) => cr.top + state.stage.model.position.y + (my - ms.height / 2) * sc
  return {
    left: sx(Math.min(...xs)), top: sy(Math.min(...ys)),
    right: sx(Math.max(...xs)), bottom: sy(Math.max(...ys)),
    width: (Math.max(...xs) - Math.min(...xs)) * sc,
    height: (Math.max(...ys) - Math.min(...ys)) * sc,
  }
}

/**
 * 头部右键：前倾做成**开关**（点一次开、再点一次关）。
 * 以**图层实际状态**为准（不存本地布尔）——否则设置里切过、或者被 exprClear 清掉之后，
 * 开关会显示「关」而模型其实还开着（反过来也有）。
 */
function toggleLean() {
  const def = (state.caps.expressions || []).find((x) => x.name === '前倾')
  if (!def) { toast('模型没有「前倾」表情'); return }
  const on = !!state.layers?.hasExpression?.('前倾')
  if (on) {
    state.layers.removeExpression('前倾')
    toast('前倾：关')
  } else {
    state.layers.addExpression('前倾', def.params, { source: 'lean' })
    toast('前倾：开')
  }
}

/** 点别处关掉弹窗（面板里例外：点面板不该收弹窗） */
function bindToolsDismiss() {
  window.addEventListener('pointerdown', (e) => {
    const t = $('#tools')
    if (t && !t.classList.contains('hidden') && !e.target?.closest?.('#tools')) hideTools()
    // 装扮面板：点面板外任何地方收起（面板内部的点击由它自己的 handler 接）
    const p = $('#look-panel')
    if (p && !p.classList.contains('hidden') && !e.target?.closest?.('#look-panel, #tool-look')) hideLookPanel()
  }, true)
}

// ---------- 分区反应：改的是热区上的 reaction，reactions.apply 优先用它 ----------
// 反应存在热区上（region.reaction），reactions.apply 优先用它，其次才回落到 DEFAULT_REACTIONS。
// 所以这里改完直接 store.save()，重启保留。
function applyReaction(regionName, kind, { exprs = [], mode = 'expr' } = {}) {
  const region = state.store?.all?.find((r) => r.name === regionName)
  if (!region) return false
  const next = { ...(region.reaction || {}) }
  if (!exprs.length) delete next[kind]
  else next[kind] = mode === 'toggle' ? { toggle: exprs[0] } : { expr: exprs }
  region.reaction = next
  state.store.save(state.caps.model.name)
  return true
}

/** 热区反应快照：设置窗口拿它渲染勾选框 */
function reactionsSnapshot() {
  return Object.fromEntries((state.store?.all || []).map((r) => [r.name, r.reaction || {}]))
}

/**
 * 设置窗口 → 舞台窗口的 RPC（主进程用 executeJavaScript 调进来）。
 * 只处理「需要舞台内部状态」的三类事：读快照 / 改热区反应 / 导出补丁。
 * 纯设置项（缩放、跟随、气泡、置顶…）走主进程广播，不经过这里。
 */
async function stageRpc(op, payload) {
  if (op === 'meta') {
    return {
      model: state.caps?.model?.name || '',
      regions: (state.store?.all || []).map((r) => r.name),
      exprs: (state.caps?.expressions || []).map((e) => e.name),
      reactions: reactionsSnapshot(),
      poses: Object.keys(POSES).map((name) => ({ name, official: OFFICIAL_POSES.includes(name) })),
      bodyShape: state.bodyShape ?? 0,
      active: {
        exprs: (state.layers?.inspect?.()?.layers || []).map((l) => l.name),
        pose: state.poses?.state?.()?.active ?? null,
      },
    }
  }
  if (op === 'expr') {
    const name = String(payload?.name || '')
    const def = (state.caps?.expressions || []).find((e) => e.name === name)
    if (!def) return { error: `没有这个表情：${name}` }
    if (state.layers?.hasExpression?.(name)) state.layers.removeExpression(name)
    else state.layers?.addExpression(name, def.params, { source: 'manual', fade: 0.25 })
    return {
      active: {
        exprs: (state.layers?.inspect?.()?.layers || []).map((l) => l.name),
        pose: state.poses?.state?.()?.active ?? null,
      },
    }
  }
  if (op === 'pose') {
    const name = String(payload?.name || '')
    if (!POSES[name]) return { error: `没有这个姿势：${name}` }
    state.poses?.set(name, 320)
    return { active: { exprs: (state.layers?.inspect?.()?.layers || []).map((l) => l.name), pose: state.poses?.state?.()?.active ?? null } }
  }
  if (op === 'exprClear') {
    for (const s of ['manual', 'mode', 'bus', 'agent', 'idle-exp', 'pinch', 'crotch-face']) state.layers?.removeSource(s)
    state.poses?.release(360)
    return { active: { exprs: [], pose: '默认手' } }
  }
  if (op === 'reaction') {
    const { region, kind = 'tap', exprs = [], mode = 'expr' } = payload || {}
    applyReaction(region, kind === 'pet' ? 'pet' : 'tap', { exprs, mode })
    return { reactions: reactionsSnapshot() }
  }
  if (op === 'reactionReset') {
    const region = state.store?.all?.find((r) => r.name === payload?.region)
    if (region) {
      const d = DEFAULT_REACTIONS[payload.region]
      region.reaction = d ? JSON.parse(JSON.stringify(d)) : {}
      state.store.save(state.caps.model.name)
    }
    return { reactions: reactionsSnapshot() }
  }
  if (op === 'body') return { bodyShape: applyBodyShape(payload?.value) }
  if (op === 'patchExport') return exportStagePatch()
  if (op === 'mode') return { mode: applyMode(payload?.name) }
  return null
}
window.__stageRpc = stageRpc

// ---------- 设置同步：主进程广播 → 舞台立即生效 ----------
function applyPassState(on) {
  state.settings = state.settings || {}
  state.settings.clickThrough = !!on
  if (on) showPassHint()
  else hidePassHint()
  state.recomputePass?.()
}

/**
 * 把设置值落到各层。
 * 有意的**单向**：只读 settings、绝不回写 —— 否则「广播 → apply → shell.set → 广播」会打环。
 */
function applySettings(next) {
  if (!next || typeof next !== 'object') return
  state.settings = { ...state.settings, ...next }
  state.bubble?.configure?.({ name: state.settings.petName || '大肥鱼' })

  // zoom 现在是"内容倍率"，窗口恒定按 cap 开：只更新画布变换，不重排窗口
  const zoom = Number(state.settings.zoom)
  if (Number.isFinite(zoom)) {
    const cap = typeof zoomCap === 'function' ? zoomCap() : 1
    if (!state.zoomRaf) {
      state.zoomV = Math.min(1, Math.max(ZOOM_MIN, zoom) / cap)
      state.zoomTarget = zoom
      composeCanvasTransform()
    }
    applyFit()
  }

  const strength = Number(state.settings.strength ?? 1)
  state.gaze?.set({ enabled: state.settings.gaze !== false, strength, headGain: Number(state.settings.headGain ?? 1.25) })
  state.posture?.set({ strength })
  state.petSway?.set({ gain: Number(state.settings.petGain ?? 1.6) })
  state.idle?.set({ enabled: state.settings.idle !== false, speed: Number(state.settings.idleSpeed ?? 1) })

  const bubbleOn = state.settings.bubble !== false
  if (!bubbleOn && state.bubble?.visible) state.bubble.hide()
  else if (bubbleOn && !state.bubble?.visible && state.bubble?.text) state.bubble.show()
  state.bubble?.setScale(bubbleScale())
  applyBorder(state.settings.border === true)
  // 体型（Clothes2）跟设置走：0 默认 / 0.4 体型1 / 1 体型2
  applyBodyShape(state.settings.bodyShape ?? 0)

  // 她那一身（持久装扮）：设置里存着就穿回去。舞台还没起来时先记着，等 bindPassThrough 之后再补
  if (state.settings.look) {
    state.pendingLook = state.settings.look
    if (state.layers && state.caps) applyLook(state.settings.look, { persist: false })
  }

  applyPassState(!!state.settings.clickThrough)
}

function bindSettings() {
  shell.onSettings?.((next) => { applySettings(next); syncVoiceButton() })
  shell.onClickThrough?.((v) => applyPassState(!!v))
}

// ---------- 右键工具条：设置窗口 / 退出（角色铺满窗口后，这是唯一入口） ----------
function bindTools() {
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    state.menuAt = { x: e.clientX, y: e.clientY }
    // 右键直接弹出装扮面板（说话 / 设置 / 前倾 / 退出 都收在面板底部）
    hideTools()
    openLookPanel()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideTools(); hideLookPanel() }
  })
  $('#tool-look')?.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleLookPanel()
  })
  $('#tool-speak')?.addEventListener('click', () => {
    hideTools()
    shell.proactiveForce?.()
  })
  $('#tool-settings')?.addEventListener('click', () => { hideTools(); shell.openSettings?.() })
  $('#tool-quit')?.addEventListener('click', () => shell.quit())
}

/* ===== 装扮面板：右键 →「装扮」→ 直接点选 ===== */
function buildLookPanel() {
  const panel = $('#look-panel')
  if (!panel || panel.dataset.built === '1') return panel
  const rows = [
    ['glasses', '眼镜', { none: '不戴', glasses: '黑框', monocle: '单片' }],
    ['skirt', '裙子', { short: '短裙', long: '长裙' }],
    ['shoes', '鞋', { on: '穿着', off: '光脚' }],
    ['tail', '尾巴', { on: '露着', off: '收着' }],
    ['body', '形态', { 1: '正常', 2: '半Q版', 3: 'Q版' }],
    ['size', '大小', { small: '小', normal: '原尺寸', large: '大' }],
    ['accessory', '配件', { none: '无', basin: '钢盆', finger: '竖手指' }],
    ['tooth', '牙', { normal: '正常', big: '大牙' }],
    ['chest', '上半身', { normal: '默认', boost: '换过' }],
  ]
  const html = rows
    .map(([slot, label, opts]) => {
      const btns = Object.entries(opts)
        .map(([value, text]) => `<button class="opt" data-slot="${slot}" data-value="${value}">${text}</button>`)
        .join('')
      return `<div class="row"><span class="label">${label}</span><div class="opts">${btns}</div></div>`
    })
    .join('')
  const status = '<div class="sep"></div><div class="status" id="look-status"></div>'
  const footer =
    '<div class="sep"></div>' +
    '<div class="row acts">' +
    '<button class="act" id="act-voice" data-act="voice">声音</button>' +
    '<button class="act" data-act="lean">前倾</button>' +
    '<button class="act" data-act="history">记录</button>' +
    '<button class="act" data-act="player">唱片机</button>' +
    '<button class="act" data-act="speak">说话</button>' +
    '<button class="act" data-act="settings">设置</button>' +
    '<button class="act" data-act="quit">退出</button>' +
    '</div>' +
    '<div class="hint">点一下立刻换，会记住 · Esc 收起</div>'
  panel.innerHTML = html + status + footer
  panel.dataset.built = '1'
  panel.addEventListener('click', (e) => {
    const act = e.target.closest('.act')
    if (act) {
      e.stopPropagation()
      const kind = act.dataset.act
      if (kind === 'voice') { toggleVoice(); syncVoiceButton() }
      else if (kind === 'lean') toggleLean()
      else if (kind === 'history') { hideLookPanel(); void shell.openHistory?.() }
      else if (kind === 'player') { hideLookPanel(); void shell.playerOpen?.() }
      else if (kind === 'speak') { hideLookPanel(); shell.proactiveForce?.() }
      else if (kind === 'settings') { hideLookPanel(); shell.openSettings?.() }
      else if (kind === 'quit') shell.quit()
      return
    }
    const btn = e.target.closest('.opt')
    if (!btn) return
    e.stopPropagation()
    applyLook({ [btn.dataset.slot]: btn.dataset.value })
    syncLookPanel()
  })
  return panel
}

/** 把当前这一身的高亮对上 */
function syncLookPanel() {
  const panel = $('#look-panel')
  if (!panel) return
  const cur = state.look || DEFAULT_LOOK
  for (const btn of panel.querySelectorAll('.opt')) {
    btn.classList.toggle('on', String(cur[btn.dataset.slot]) === btn.dataset.value)
  }
}

/** 右键面板底部的「今天摸了哪 / 现在什么心情」 */
function updateLookStatus() {
  const el = $('#look-status')
  if (!el) return
  const today = state.dayLog?.summary?.() || { top: [], total: 0 }
  const m = state.mood?.snapshot?.() || {}
  const bar = (v) => {
    const n = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 8)
    return '▓'.repeat(n) + '░'.repeat(8 - n)
  }
  const top = (today.top || []).map(([z, n]) => `${z} ${n}`).join(' · ')
  const b = state.balance
  const money = (v) => '¥' + (Number(v) || 0).toFixed(2)
  // 余额 / 今日已用：照 dsh-whale-widget 的口径，不显示「比满额少多少」
  const balLine = b
    ? `<div class="line money"><span>余额 ${money(b.total)}</span>` +
      `<span class="dim">今日≈ ${money(b.used)}</span></div>`
    : `<div class="line money dim">余额 —　今日 —</div>`
  // 峰谷：字按状态上色（峰=橙、谷=绿），后面跟距下一次切换的倒计时
  const pl = peakLine()
  const peakLineHtml =
    `<div class="line peak ${pl.peak ? 'is-peak' : 'is-valley'}">` +
    `<span>${pl.label}</span><span class="cd">${pl.countdown}</span>` +
    `<span class="dim">${pl.peak ? '×2 价' : '半价'}</span></div>`
  el.innerHTML =
    balLine + peakLineHtml +
    `<div class="line">今天 ${top || '还没被碰'}　共 ${today.total || 0}</div>` +
    `<div class="line dim">愉悦 ${bar(m.joy)}　恼 ${bar(m.irk)}</div>` +
    `<div class="line dim">困 ${bar(m.sleepy)}　惦记 ${bar(m.missing)}</div>`
}

function openLookPanel() {
  const panel = buildLookPanel()
  if (!panel) return
  hideTools()
  panel.classList.remove('hidden')
  syncLookPanel()
  syncVoiceButton()
  updateLookStatus()
  if (!state.statusTimer) state.statusTimer = setInterval(() => {
    const p = $('#look-panel')
    if (p && !p.classList.contains('hidden')) updateLookStatus()
    else { clearInterval(state.statusTimer); state.statusTimer = null }
  }, 1000)
  placeLookPanel(panel)
  reportChrome()
}

function toggleLookPanel() {
  const panel = buildLookPanel()
  if (!panel) return
  if (panel.classList.contains('hidden')) openLookPanel()
  else hideLookPanel()
}

/** 贴在右键的位置弹出来（不挡住她的脸）：先显示再量尺寸，然后夹进窗口里 */
function placeLookPanel(panel) {
  const at = state.menuAt || { x: window.innerWidth - 260, y: 46 }
  const r = panel.getBoundingClientRect()
  const pad = 8
  const left = Math.max(pad, Math.min(at.x, window.innerWidth - r.width - pad))
  const top = Math.max(pad, Math.min(at.y, window.innerHeight - r.height - pad))
  panel.style.left = `${Math.round(left)}px`
  panel.style.top = `${Math.round(top)}px`
  panel.style.right = 'auto'
}

function hideLookPanel() {
  const panel = $('#look-panel')
  if (!panel || panel.classList.contains('hidden')) return
  panel.classList.add('hidden')
  // 这一下点击是用来「关面板」的，别顺手把她的话打断
  state.tapSuppressUntil = performance.now() + 500
  reportChrome()
}

/**
 * 调试探针（window.__probe / window.__pass）。
 *
 * 从 bootStage 与 bindPassThrough 里搬出来的：它们是开发期工具，不该和启动流程、
 * 穿透状态机缠在同一个函数里。除 motionState（惯性数值）外，全部依赖模块作用域。
 */
function installProbes({ motionState } = {}) {
  window.__probe = {
    /** 覆写一个参数（持续生效，直到 clear） */
    param(id, v, blend = 'Overwrite') {
      state.layers.removeSource('probe')
      state.layers.addExpression('probe', [{ Id: id, Value: v, Blend: blend }], { fade: 0, source: 'probe' })
    },
    /** 一组参数同时覆写 */
    params(list, blend = 'Overwrite') {
      state.layers.removeSource('probe')
      state.layers.addExpression('probe', list.map(([Id, Value]) => ({ Id, Value, Blend: blend })), { fade: 0, source: 'probe' })
    },
    clear() { state.layers.removeSource('probe') },
    /** 诊断：直接写核心参数并立刻读回（判断「写不进去」还是「写完又被覆盖」） */
    setRead(id, v) {
      const idx = state.stage.param.index(id)
      const before = state.stage.param.get(id)
      state.stage.param.set(id, v)
      const after = state.stage.param.get(id)
      return { id, idx, before, after }
    },
    /** 诊断：在 beforeModelUpdate 末尾（各层写完之后）读一次 */
    readAtUpdate(id) {
      return new Promise((resolve) => {
        const off = state.stage.onBeforeUpdate(() => { const v = state.stage.param.get(id); off(); resolve(v) })
      })
    },
    /** 诊断：一次分层写入，在物理前/更新前各读一次值（判断写点与覆盖） */
    traceWrite(id, v) {
      state.layers.removeSource('probe')
      state.layers.addExpression('probe', [{ Id: id, Value: v, Blend: 'Overwrite' }], { fade: 0, source: 'probe' })
      return new Promise((resolve) => {
        const out = []
        const offPre = state.stage.onBeforePhysics(() => out.push(['pre', state.stage.param.get(id)]))
        const offPost = state.stage.onBeforeUpdate(() => out.push(['post', state.stage.param.get(id)]))
        setTimeout(() => {
          offPre(); offPost(); state.layers.removeSource('probe')
          resolve({ out: out.slice(0, 6), isIn: state.physics.inputs.has(id), isOut: state.physics.outputs.has(id) })
        }, 150)
      })
    },
    // ---- 捏脸 / 活气 / 嘴的探针 ----
    pinch(side = 'L', px = 320) { state.facePinch?.grab(side); state.facePinch?.move(px, 0) },
    pinchEnd() { state.facePinch?.release() },
    pinchState: () => state.facePinch?.state() ?? null,
    flap(side = 'L', amp = 1) { state.life?.flap(side, amp) },
    life: () => state.life?.state() ?? null,
    talk(v = 0) { state.mouth?.speak(v) },
    /** 直接触发某个部位的情绪嘴形（截图/验证用，等价于摸到那个部位） */
    mood(name) {
      const m = REGION_MOUTH[name]
      if (m) state.mouth?.setMood(m, m.ms)
      return m ? { name, ...m } : null
    },
    moods: () => Object.keys(REGION_MOUTH),
    clearMood() { state.mouth?.clearMood() },
    faces: () => state.idleFaces?.presets() ?? [],
    face(name) { return state.idleFaces?.trigger(name) ?? null },
    faceState: () => state.idleFaces?.state() ?? null,
    /** 终点姿势：预设清单 / 切换 / 状态（数值来自模型自带 motion3 末帧） */
    poses: () => state.poses?.presets() ?? [],
    /** 待机动作：清单 / 立刻播一个（不传名字则随机）/ 状态 */
    idleList: () => state.idle?.routines() ?? [],
    idlePlay(name) { return state.idle?.trigger(name) ?? null },
    idleState: () => state.idle?.state() ?? null,
    /** 痒痒的：立刻来一段（验证躲痒动作） */
    tickle() { state.tickle?.start(); return state.tickle?.state() ?? null },
    tickleState: () => state.tickle?.state() ?? null,
    /** 模型三态：常态 / 爱心眼 / 黑框眼镜 */
    mode(name) { return { mode: applyMode(name) } },
    modeState: () => ({ mode: modeName, list: MODE_LIST }),
    cycleMode: () => ({ mode: cycleMode() }),
    /** 视口状态（含镜像 flipX，验证镜像摇摆用） */
    viewport: () => ({ ...state.viewport?.view }),
    /** 摸胯神态（半睁眼 + 眯眼 + 八字眉）单独验证 */
    crotchFace(on = true) { crotchFace(on); return true },
    pose(name, ms = 260) { return state.poses?.set(name, ms) ?? false },
    poseState: () => state.poses?.state() ?? null,
    /** 气泡：说一句 / 换文字 / 收起 / 读状态（验证自适应排版用） */
    bubble(text, st) {
      if (!state.bubble) return null
      if (text == null) { state.bubble.hide(); return null }
      state.bubble.show(String(text), { state: st })
      return state.bubble.state()
    },
    bubbleHide() { state.bubble?.hide() },
    bubbleState: () => state.bubble?.state() ?? null,
    /** 说一句预设台词（thinking / working / waiting / success / error / head / hand …） */
    say(key, ms = 0) { return state.bubble?.say(key, { ms }) ?? null },
    /** 模拟一条 DSH 状态（不接插件时也能验证联动） */
    agent(snap) { state.agentLink?.apply(snap) },
    agentState: () => state.agentLink?.state() ?? null,
    // ---- 改动补丁 ----
    patchExport: () => exportStagePatch(),
    patchState: () => state.patch ? { model: state.patch.model, poses: Object.keys(state.patch.poses || {}), phrases: Object.keys(state.patch.phrases || {}), regions: state.patch.regions?.regions?.length ?? 0 } : null,
    /** 读一个像素的 RGBA（判断眼睛有没有闭：虹膜是蓝的，闭眼是皮肤色） */
    pixel: (x, y) => state.stage?.sampleAlpha?.(x, y) ?? null,
    mouth: () => state.mouth?.state() ?? null,
    earNow: () => ['LEar1', 'LEar2', 'LEar3', 'REar1', 'ParamMouthOpenY', 'LeanInput', 'ParamAngleZ']
      .map((id) => `${id}=${Math.round((state.stage.param.get(id) || 0) * 100) / 100}`).join(' '),
    read: (id) => state.stage.param.get(id),
    /** 参数的定义区间（判断某个值是不是「超出范围被钳住」） */
    info: (id) => state.stage.param.info(id),
    /** 当前左右脸热区的包围盒（模型像素）——用来量化「仰头让脸变宽」 */
    faceBox() {
      const rs = (state.store?.all || []).filter((r) => r.name === '左脸' || r.name === '右脸')
      if (!rs.length) return null
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const r of rs) {
        for (const p of r.points || []) {
          if (p[0] < minX) minX = p[0]
          if (p[0] > maxX) maxX = p[0]
          if (p[1] < minY) minY = p[1]
          if (p[1] > maxY) maxY = p[1]
        }
      }
      return { w: Math.round(maxX - minX), h: Math.round(maxY - minY), y: Math.round((minY + maxY) / 2) }
    },
    /** 物理输出参数在 onBeforeUpdate（物理之后）还有没有值？
     *  有值 → 可以「叠加」；读到 0 → 只能整层接管。
     */
    physicsSample(ids = ['LEar1', 'LEar2', 'LEar3', 'FrontHairY1', 'SideHairY1', 'LateHairY1'], frames = 90) {
      return new Promise((resolve) => {
        const acc = {}
        for (const id of ids) acc[id] = { min: Infinity, max: -Infinity, n: 0, last: null }
        let left = frames
        const off = state.stage.onBeforeUpdate(() => {
          for (const id of ids) {
            const v = state.stage.param.get(id)
            if (v == null) continue
            const a = acc[id]
            if (v < a.min) a.min = v
            if (v > a.max) a.max = v
            a.last = Math.round(v * 100) / 100
            a.n += 1
          }
          if (--left <= 0) {
            off()
            for (const id of ids) {
              acc[id].min = Math.round(acc[id].min * 100) / 100
              acc[id].max = Math.round(acc[id].max * 100) / 100
            }
            resolve(acc)
          }
        })
      })
    },
    /** 物理「算之前」这一瞬看到的参数值 —— 判断物理到底吃到了什么 */
    preSample(ids = ['ParamAngleZ', 'ParamAngleY', 'ParamAngleX', 'ParamBreath', 'LeanInput', 'LEar1', 'FrontHairY1'], frames = 60) {
      return new Promise((resolve) => {
        const acc = {}
        for (const id of ids) acc[id] = { min: Infinity, max: -Infinity, n: 0 }
        let left = frames
        const off = state.stage.onBeforePhysics(() => {
          for (const id of ids) {
            const v = state.stage.param.get(id)
            if (v == null) continue
            const a = acc[id]
            if (v < a.min) a.min = v
            if (v > a.max) a.max = v
            a.n += 1
          }
          if (--left <= 0) {
            off()
            for (const id of ids) {
              acc[id].min = Math.round(acc[id].min * 10) / 10
              acc[id].max = Math.round(acc[id].max * 10) / 10
            }
            resolve(acc)
          }
        })
      })
    },
    phys: () => state.stage.physicsInfo(),
    cap: () => state.capture?.state() ?? null,
    posture: () => state.posture?.state() ?? null,
    motion: () => ({
      vx: Math.round(motionState.vx), vy: Math.round(motionState.vy),
      ax: Math.round(motionState.ax), ay: Math.round(motionState.ay),
      life: state.life?.state?.().ext ?? null,
    }),
    /** 用 shell.moveBy 摇窗口，模拟拖动带来的加速度（CDP 移动不了真实窗口） */
    shakeWindow(px = 36, steps = 24, interval = 40) {
      let i = 0
      const id = setInterval(() => {
        shell.moveBy(i % 2 ? px : -px, 0)
        if (++i >= steps) clearInterval(id)
      }, interval)
    },
    /** 关掉桌面光标反馈，让探针的合成鼠标事件不被真实光标覆盖 */
    desktopGaze(on) { window.__noDesktopGaze = !on },
    /** 在物理之前强行钉住某些参数（测物理响应用） */
    holdPre(list) {      state._holdPreOff?.()
      state._holdPreOff = state.stage.onBeforePhysics(() => {
        for (const [id, v] of list) state.stage.param.set(id, v)
      })
    },
    holdPreOff() { state._holdPreOff?.(); state._holdPreOff = null },
    /** 关掉自制活气层，用来单独观察模型自带物理 */
    lifeOff() { state.life.set({ windAmp: 0, windAmpX: 0, earTremor: 0, earAmp: 0, jewelAmp: 0, inertiaX: 0, inertiaY: 0, earMin: 9999, earMax: 9999 }) },
    lifeOn() { state.life.set({ windAmp: 0.035, windAmpX: 0.02, earTremor: 0.012, earAmp: 1, jewelAmp: 0.3, inertiaX: 0.85, inertiaY: 1, earMin: 5.5, earMax: 13 }) },
  }

  window.__pass = {
    bodyAt,
    refreshMask,
    // 表情/姿势层现状（排查「动作被谁盖了」用）
    layers: () => state.layers?.inspect?.() ?? null,
    // 活气层：眨眼计数 / 耳朵 / 风；伪面捕：呼吸值
    life: () => state.life?.state?.() ?? null,
    capture: () => state.capture?.state?.() ?? null,
    // 清掉所有表情来源 + 收回姿势（QA 用，避免上一轮试的参数残留）
    exprClear() {
      for (const s of ['bus', 'agent', 'idle-exp', 'probe', 'lean', 'manual', 'mode', 'body', 'pinch', 'crotch-face']) state.layers?.removeSource(s)
      state.poses?.release(0)
    },
    captureSet: (patch) => state.capture?.set(patch) ?? null,
    blink: () => state.life?.blinkNow?.() ?? null,
    lifeSet: (patch) => state.life?.set?.(patch) ?? null,
    gust: (amp = 2, ms = 2600) => state.life?.gust?.(amp, ms) ?? null,
    sway: (name) => state.petSway?.trigger(name),
    charRight: () => Math.round(charRightClient()),
    face: () => state.facePinch?.state() ?? null,
    faceCenter: () => {
      const r = state.store?.all?.find((x) => x.name === '脸')
      if (!r || !r.points?.length) return null
      const cx = r.points.reduce((s, p) => s + p[0], 0) / r.points.length
      const cy = r.points.reduce((s, p) => s + p[1], 0) / r.points.length
      const st = state.stage
      const cr = st.canvas.getBoundingClientRect()
      const sc = st.model.scale.x
      const ms = st.modelSize()
      return {
        x: cr.left + st.model.position.x + (cx - ms.width / 2) * sc,
        y: cr.top + st.model.position.y + (cy - ms.height / 2) * sc,
      }
    },
    regions: () => (state.store?.all || []).map((r) => ({ name: r.name, z: r.z })),
    /** 当前在场的表情层（验证「摸手不该出竖食指」用） */
    exprs: () => state.layers?.inspect?.() ?? null,
    handBoxes: () => (state.store?.all || []).filter((r) => r.name === '左手' || r.name === '右手').map((r) => {
      const xs = (r.points || []).map((p) => p[0])
      const ys = (r.points || []).map((p) => p[1])
      return { name: r.name, z: r.z, minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
    }),
    handCount: () => state.handReader?.count?.() ?? -1,
    /** 热区 → 客户端像素矩形（调热区位置用） */
    screenBox: (name) => regionScreenBox(name),
    /** 绘制顺序排查：按部件名列出 drawable 的序号与不透明度（判断手有没有被裙子盖住） */
    partOpacity(name) {
      const st = state.stage
      const p = (state.caps.parts || []).find((x) => x.name === name)
      if (!st || !p) return null
      return st.part?.get?.(p.id) ?? null
    },
    partSet(name, v) {
      const st = state.stage
      const p = (state.caps.parts || []).find((x) => x.name === name)
      if (!st || !p) return false
      st.part?.set?.(p.id, v)
      return true
    },
    drawables(filter) {
      const out = []
      const core = state.stage?.core
      if (!core) return out
      for (let i = 0; i < core.getDrawableCount(); i++) {
        let parent = -1
        try { parent = core.getDrawableParentPartIndex(i) } catch { continue }
        if (parent < 0) continue
        let name = ''
        try {
          const pid = core.getPartId(parent).getString().s
          name = state.caps.parts.find((p) => p.id === pid)?.name || ''
        } catch {}
        if (filter && !name.includes(filter)) continue
        out.push({ i, part: name, op: Math.round((core.getDrawableOpacity(i) || 0) * 100) / 100 })
      }
      return out
    },
    leanState: () => {
      const def = (state.caps?.expressions || []).find((x) => x.name === '前倾')
      const keys = def ? Object.keys(def.params) : []
      return {
        def: def ? def.params : null,
        active: !!state.layers?.hasExpression?.('前倾'),
        values: keys.map((k) => [k, state.stage?.param.get(k), state.stage?.param.info(k)?.min, state.stage?.param.info(k)?.max]),
      }
    },
    tryLean: () => toggleLean(),
    cheekTest: (s) => state.facePinch?.test(s),
    faceVerts: () => {
      // 「脸」部件所有网格顶点的平均坐标（看变形是否真的动）
      const core = state.stage.core
      const im = state.stage.model.internalModel
      let sx = 0, sy = 0, n2 = 0
      const n = core.getDrawableCount()
      for (let i = 0; i < n; i++) {
        let parent = -1
        try { parent = core.getDrawableParentPartIndex(i) } catch { continue }
        if (parent < 0) continue
        let name = ''
        try { name = state.caps.parts.find((p) => p.id === core.getPartId(parent).getString().s)?.name || '' } catch {}
        if (!/^脸$|^脸底$/.test(name)) continue
        let v = null
        try { v = im.getDrawableVertices(i) } catch { continue }
        if (!v) continue
        for (let k = 0; k < v.length; k += 2) { sx += v[k]; sy += v[k + 1]; n2++ }
      }
      return n2 ? { x: Math.round(sx / n2), y: Math.round(sy / n2), n: n2 } : null
    },
    regionAt: (x, y) => regionAtClient(x, y)?.name ?? null,
    regionCenter: (name) => {
      const r = state.store?.all?.find((x) => x.name === name)
      if (!r || !r.points?.length) return null
      const mx = r.points.reduce((s, p) => s + p[0], 0) / r.points.length
      const my = r.points.reduce((s, p) => s + p[1], 0) / r.points.length
      return state.viewport.modelToScreen(mx, my)
    },
    regionDebug: (x, y) => {
      const p = state.viewport.clientToModel(x, y)
      const rows = (state.store?.all || []).map((r) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const [px, py] of r.points || []) {
          if (px < minX) minX = px
          if (px > maxX) maxX = px
          if (py < minY) minY = py
          if (py > maxY) maxY = py
        }
        return { name: r.name, z: r.z, minX: Math.round(minX), minY: Math.round(minY), maxX: Math.round(maxX), maxY: Math.round(maxY) }
      })
      return { model: { x: Math.round(p.x), y: Math.round(p.y) }, rows }
    },
    zoom: (z) => state.viewport.set({ zoom: z }),
    pinchTest: (dx, dy) => { state.facePinch.grab(); state.facePinch.move(dx, dy) },
    pinchReset: () => state.facePinch.release(),
    mask: () => state.mask && { w: state.mask.w, h: state.mask.h, coverage: +state.mask.coverage.toFixed(4) },
    /** 视口状态（缩放/偏移/实际像素缩放）—— 排查「窗口跟着角色」时的落点 */
    view: () => (state.viewport ? { ...state.viewport.view, scale: state.stage?.model?.scale?.x ?? null } : null),
    dragState: () => ({ dragging: !!state.windowDragging, vec: state.dragVec || null }),
    leanToggle: () => { toggleLean(); return !!state.layers?.hasExpression?.('前倾') },
    /** 跟随层的内部状态（平滑后的眼/头/身），排查「头不转」时看它到底是没算还是有被覆盖 */
    gazeState: () => state.gaze?.state?.() ?? null,
    gazeOpts: () => (state.gaze?.options ? { ...state.gaze.options } : null),
    /** 姿态总线的当前合成值（排查「写了没生效 / 谁盖了谁」时看这一份） */
    pose: () => state.poseBus?.snapshot?.() ?? null,
    bus: () => state.poseBus?.snapshot?.() ?? null,
    /** 关掉伪面捕通道（排查「写了 ParamAngleX 头不动」时用） */
    captureOff(on = true) {
      state.capture?.set(on
        ? { breathAmp: 0, yawGain: 0, pitchGain: 0, tiltGain: 0, posGain: 0, jawFromMouth: 0 }
        : { breathAmp: 0.4, yawGain: 0.4, pitchGain: 0.4, tiltGain: 1, posGain: 1, jawFromMouth: 1 })
      return state.capture?.options ?? null
    },
    /** 手动给一个跟随目标（-1..1，右/上为正）：不移动真实鼠标也能验证转头幅度 */
    gazeTarget(nx = 0, ny = 0) {
      state.gaze?.setTarget(Number(nx), Number(ny))
      return state.gaze?.state?.().target ?? null
    },
    /** 真实轮廓在窗口里的包围盒（客户端像素）+ 相对窗口中心的偏移 dx/dy */
    maskBox: () => {
      const m = state.mask || refreshMask(true)
      if (!m?.data) return null
      let minX = m.w, maxX = -1, minY = m.h, maxY = -1
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          if (m.data[y * m.w + x] > 8) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX < 0) return null
      const W = window.innerWidth
      const H = window.innerHeight
      const box = {
        left: +((minX / m.w) * W).toFixed(1),
        top: +((minY / m.h) * H).toFixed(1),
        right: +(((maxX + 1) / m.w) * W).toFixed(1),
        bottom: +(((maxY + 1) / m.h) * H).toFixed(1),
      }
      box.w = +(box.right - box.left).toFixed(1)
      box.h = +(box.bottom - box.top).toFixed(1)
      box.dx = +((box.left + box.right) / 2 - W / 2).toFixed(1)
      box.dy = +((box.top + box.bottom) / 2 - H / 2).toFixed(1)
      box.margin = { left: +box.left.toFixed(0), top: +box.top.toFixed(0), right: +(W - box.right).toFixed(0), bottom: +(H - box.bottom).toFixed(0) }
      return box
    },
    state: () => ({ ignoring: state.ignoring, clickThrough: state.settings?.clickThrough, pointerDown: state.pointerDown }),
    /** 给定客户端坐标的穿透判定（只算不应用，不受事件送达影响） */
    passAt: (x, y) => state.passThrough?.decideAt(x, y) ?? null,
  }

  // 装扮验证入口（无头检查用）：__look({ glasses: 'monocle', body: '3' })
  // 调试口：直接把一段带标记的文本喂给扫描器，验证协议链路（不经过大脑）
  window.__scan = (text) => { chatState.tagScan = 0; scanTags(String(text||'')); return window.__lookState?.() }
  window.__look = (patch, persist = true) => applyLook(patch, { persist })
  window.__inkBox = () => inkBox()
  window.__maskAt = (cx, cy) => {
    const m = state.mask
    const r = state.stage?.canvas?.getBoundingClientRect()
    if (!m || !r) return null
    const gx = Math.floor(((cx - r.left) / Math.max(1, r.width)) * m.w)
    const gy = Math.floor(((cy - r.top) / Math.max(1, r.height)) * m.h)
    const i = gy * m.w + gx
    return { gx, gy, bit: i >= 0 && i < m.data.length ? m.data[i] : null, rect: [r.left, r.top, r.width, r.height] }
  }
  window.__maskInfo = () => {
    const m = state.mask
    if (!m) return null
    const r = state.stage?.canvas?.getBoundingClientRect()
    let on = 0
    for (let i = 0; i < m.data.length; i++) if (m.data[i] > 8) on++
    return { w: m.w, h: m.h, on, rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null, view: state.view, zoomV: state.zoomV }
  }
  window.__barDebug = () => ({
    zoomV: state.zoomV,
    zoom: state.settings?.zoom,
    lastInk: state.lastInkBox,
    barTop: Math.round(document.getElementById('chatbar')?.getBoundingClientRect().top || -1),
    inner: [window.innerWidth, window.innerHeight],
  })
  window.__zoomState = () => ({ target: state.zoomTarget, v: state.zoomV, raf: state.zoomRaf, zoom: state.settings?.zoom, cap: (typeof zoomCap === 'function' ? zoomCap() : null) })
  // 临时调试：直接改 Live2D 模型的 PIXI 变换，确认"能不能把她放大填满窗口"
  window.__modelT = (k = 1, dx = 0, dy = 0) => {
    const m = state.stage?.model
    if (!m) return 'no model'
    m.scale?.set?.(k)
    m.x = dx
    m.y = dy
    return { k, x: m.x, y: m.y, w: m.width, h: m.height }
  }
  window.__reportBox = () => reportHitBox()
  window.__ink = () => inkRatio()
  window.__fit = (now = true) => { applyFit(now); return fitSize() }
  window.__lookState = () => ({ ...(state.look || DEFAULT_LOOK), desc: describeLook(state.look), maskH: state.maskH, baseMaskH: state.baseMaskH, bodyK: state.bodyK, zoom: state.settings?.zoom })

  // 布局 / 跟随的验证钩子（和 harness 里的 __reaction 一样，只为无头检查）
  window.__layout = () => ({
    win: [window.innerWidth, window.innerHeight],
    pos: [Math.round(window.screenX), Math.round(window.screenY)],
    offsetX: state.viewport?.view.offsetX ?? null,
    offsetY: state.viewport?.view.offsetY ?? null,
    model: state.stage ? [Math.round(state.stage.model.position.x), Math.round(state.stage.model.position.y)] : null,
    gaze: state.gaze?.state?.().target ?? null,
    sway: state.petSway?.state?.() ?? null,
    angles: state.stage ? ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'].map((id) => Math.round(state.stage.param.get(id) * 10) / 10) : null,
    lean: state.stage ? Math.round(state.stage.param.get('LeanInput') * 10) / 10 : null,
  })
}

main()


// ======================================================================
// 大脑接线：气泡打字机 + 语义标记 → 动作/表情
// ======================================================================
const CHAT_ACTS = {
  nod: 'motion:nod', yes: 'motion:nod',
  shake: 'motion:shake', no: 'motion:shake',
  tilt: 'motion:tilt', bow: 'motion:bow',
  look: 'motion:look_around', peek: 'motion:peek',
  yawn: 'motion:yawn', sleepy: 'face:expr_squint',
  surprise: 'motion:surprise', hop: 'motion:hop',
  angry: 'motion:angry', pout: 'motion:pout',
  shy: 'face:expr_blush', blush: 'face:expr_blush',
  smile: 'face:expr_tooth', laugh: 'face:expr_tooth',
  cry: 'face:expr_cry', sad: 'face:expr_cry',
  think: 'face:expr_loading', confused: 'face:expr_dizzy',
  sweat: 'face:expr_sweat', love: 'face:expr_heart', heart: 'face:expr_heart',
  wave: 'pose:举手', hand: 'pose:竖手指',
}
/** 正常比例下她大概占画布高度的多少（实测 0.95）：量不到基准时的兜底 */
const INK_BASE_FALLBACK = 0.95

const EXPR_HOLD_MS = 7000
// source: 'chat' = 你问她她答；'proactive' = 没人问她，她自己开口（气泡换色）
const chatState = { buf: '', tagScan: 0, muted: false, id: 0, open: false, source: 'chat', doneRound: false }

/** 模型里 motion3 的 (group, index)：按文件名建索引，模型换了也不用改代码 */
async function motionIndex() {
  if (state.motionIdx) return state.motionIdx
  const url = state.caps?.model?.url
  if (!url) return new Map()
  try {
    const j = await fetch(url).then((x) => x.json())
    const idx = new Map()
    for (const [group, list] of Object.entries(j.FileReferences?.Motions || {})) {
      list.forEach((m, i) => {
        const base = String(m.File).split('/').pop().replace(/\.motion3\.json$/, '')
        if (!idx.has(base)) idx.set(base, { group, index: i })
      })
    }
    state.motionIdx = idx
    return idx
  } catch {
    state.motionIdx = new Map()
    return state.motionIdx
  }
}

async function playMotionByName(name) {
  const idx = await motionIndex()
  const hit = idx.get(name)
  if (!hit) return false
  // 3 = MotionPriority.FORCE：她的动作要盖过待机，不然会被待机层吃掉
  state.stage?.motion?.(hit.group, hit.index, { priority: 3 })
  return true
}

function flashExpression(name, ms = EXPR_HOLD_MS, source = 'agent') {
  const defs = state.caps?.expressions || []
  // 名字有两种写法：能力清单里是 exp3 文件名（expr_blush），反应表里写裸名（blush）
  const def = defs.find((e) => e.name === name)
    || defs.find((e) => e.name === `expr_${name}`)
    || defs.find((e) => e.name === name.replace(/^expr_/, ''))
  if (!def) { console.warn('[expr] 模型里没有这个表情：', name); return false }
  // 同一来源只留一个表情：layers.addExpression 只按名字去重，连着做 blush→squint→pout
  // 会三层同时挂在她脸上（眼半闭 + 腮红 + 撇嘴叠在一起，看起来就是"两个表情重合"）
  state.layers?.removeSourceExcept?.(source, new Set([name]))
  state.layers?.addExpression?.(def.name, def.params, { source, fade: 0.2 })
  if (source === 'agent') {
    clearTimeout(flashExpression.t)
    flashExpression.t = setTimeout(() => state.layers?.removeSource?.('agent'), ms)
  }
  return true
}

/**
 * 装扮层（持久）：她自己能改的眼镜/鞋/裙/体型/尾巴/牙/配件。
 * 和表情分开走 source 'look'：表情只是叠上去几秒，装扮要一直挂着、并且落盘。
 * 换体型会改窗口大小（窗口跟着她长高），所以这里同步重算一次尺寸。
 */
function applyLook(patch, { persist = true } = {}) {
  const before = state.look || DEFAULT_LOOK
  const { look, changed } = normalizeLook(patch, before)
  if (!changed.length && state.lookApplied) return { look, changed }

  state.look = look
  state.lookApplied = true

  const names = lookExpressions(look)
  const defs = state.caps?.expressions || []
  // 能力清单里的名字是 exp3 文件名（expr_blush / expr_skirt…），look.mjs 里写的是裸名
  const findDef = (name) => defs.find((e) => e.name === name) || defs.find((e) => e.name === `expr_${name}`) || null
  const resolved = names.map((n) => findDef(n)?.name || n)
  // 同一来源只留当前这一身需要的：先摘掉上一身多出来的，再补上新的
  state.layers?.removeSourceExcept?.('look', new Set(resolved))
  for (const name of names) {
    const def = findDef(name)
    if (def) state.layers?.addExpression?.(def.name, def.params, { source: 'look', fade: 0.25 })
    else console.warn('[look] 模型里没有这个装扮：', name)
  }

  // 大小（size）改成角色缩放，窗口由 applySettings → applyFit 跟着重算
  const zoom = sizeZoom(look)
  if (persist) shell.set({ look, zoom })
  scheduleChromePos(changed.length ? 420 : 120)
  // 形态换了（Q 版 / 半 Q 版）：她那套素材只占画布一小块；窗口**不再**跟着缩
  // （缩了她也同比缩，等于没变大），改成把输入条贴到她脚下 —— 见 positionChatbar()
  if (changed.some((c) => c.slot === 'body' || c.slot === 'size')) scheduleViewCrop(720)
  if (changed.some((c) => c.slot === 'body')) {
    if (look.body === '1') state.bodyK = 1 // 仅作记录；窗口缩放不再看它
    void measureBodyK()
  }
  if (changed.length) console.log('[look]', changed.map((c) => `${c.slot}=${c.value}`).join(' '), '→', describeLook(look))
  syncLookPanel()
  return { look, changed }
}

/** 执行一个语义 key（[[act:nod,blush]] 里的每一项） */
function runAct(key) {
  // 调试用：记下执行过的语义 key（PET_DEBUG 时可在控制台看）
  ;(window.__acts = window.__acts || []).push(key)
  const spec = CHAT_ACTS[key]
  if (!spec) return false
  const [kind, name] = spec.split(':')
  if (kind === 'motion') { void playMotionByName(name); return true }
  if (kind === 'face') return flashExpression(name)
  if (kind === 'pose') { state.poses?.set?.(name, 320); return true }
  return false
}

// 桌宠嘴上的「一百字」：超了截到最近句号，剩下的留在「记录」窗口里
const REPLY_CAP = 100

/** 把模型输出收拾成「能念、能看」的样子（不改原始文本；日志里永远是全文） */
function cleanReply(raw) {
  let out = String(raw ?? '')
    // AstrBot 的检索引用标记（<ref>1.2</ref>）不是台词，别念出来也别显示
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<\/?(?:sup|cite|ref)[^>]*>/gi, '')
    .replace(/\[\[[^\]]*\]\]/g, '')
  // 「来源：https://…」「参考资料：…」这类整行都不该出现在她嘴里
  out = out
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      if (/^(来源|参考资料|参考|出处|链接|参考文献)\s*[:：]/.test(t)) return false
      if (/^https?:\/\/\S+$/i.test(t)) return false
      return true
    })
    .join('\n')
  // markdown 的星号/井号/反引号对她来说只是噪音
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
  // 行内的「；来源：https://…」也要摘掉（模型常把它挂在句子尾巴上，不成行）
  out = out
    .replace(/[；;，,]?\s*(来源|参考资料|参考|出处|链接|参考链接)\s*[:：]\s*https?:\/\/\S+/gi, '')
    .replace(/[（(]\s*来源\s*[:：][^）)]*[）)]/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[；;，,、]\s*$/gm, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** 超长时截到最近句号，保住「说话」而不是「播报」 */
function capReply(text, cap = REPLY_CAP) {
  const t = String(text ?? '')
  if (Array.from(t).length <= cap) return t
  const head = Array.from(t).slice(0, cap).join('')
  const m = head.match(/^[\s\S]*[。！？!?…]/)
  return (m ? m[0] : head).trim()
}

/** 从流式文本里剥掉已完成/未完成的标记，返回可显示的文字 */
function visibleText(buf) {
  let out = cleanReply(buf)
  const cut = out.lastIndexOf('[[')
  if (cut >= 0) out = out.slice(0, cut)  // 半截标记先不显示，等它到齐
  return out
}

/** 扫新出现的 [[…]] 标记并执行 */
function scanTags(buf) {
  const re = /\[\[([^\]]*)\]\]/g
  re.lastIndex = chatState.tagScan
  let m
  while ((m = re.exec(buf))) {
    chatState.tagScan = re.lastIndex
    const body = m[1].trim().toLowerCase()
    // 装扮和动作是两条协议：[[wear:glasses=monocle,shoes=off]] 走持久层
    // 她说「给你放首歌」：[[play:歌名]]——主进程去搜、挑原唱、开唱片机
    if (body.startsWith('play:')) {
      const kw = m[1].slice(m[1].indexOf(':') + 1).trim()
      if (kw) {
        console.log('[play]', kw)
        window.shell?.musicPlay?.({ keyword: kw })?.then?.((r) => {
          if (r && r.ok === false) {
            console.warn('[play] 没放成：', r.error || '')
            // 搜不到别用系统腔告诉她：让 AstrBot 用她自己的话圆回来（换一首 / 说这首没有）
            window.shell?.proactiveForce?.({ kind: 'musicfail', extra: { keyword: kw } })?.catch?.(() => {})
          } else if (r?.song?.name) {
            console.log('[play] 正在放：', r.song.name, '—', r.song.artists || '')
          }
        })
      }
      continue
    }
    if (body.startsWith('wear:')) {
      const patch = parseWear(body.slice(5))
      console.log('[wear]', JSON.stringify(patch))
      if (Object.keys(patch).length) applyLook(patch)
      continue
    }
    const list = body.includes(':') ? [body.slice(body.indexOf(':') + 1)] : body.split(',')
    for (const raw of list) {
      for (const k of String(raw).split(',')) {
        const key = k.trim()
        if (key) runAct(key)
      }
    }
  }
}

function releaseChatBubble(ms = 3500) {
  clearTimeout(releaseChatBubble.t)
  releaseChatBubble.t = setTimeout(() => state.bubble?.unlock?.('chat'), ms)
}

// ---- 气泡自动收起 ----
// 她说完之后气泡一直挂着：挡视线，也让人以为「卡住了」。按字数给一个停留时间就收。
// 只在 done/error 之后计时；还在 thinking/打字的时侯一律取消（见 clearBubbleHide）。
// 鼠标停在气泡上、或在里面滚，就别收它（长文中途消失最气人）
function bindBubbleHoverPause() {
  const el = document.getElementById('bubble')
  if (!el) return
  el.addEventListener('mouseenter', () => clearBubbleHide())
  el.addEventListener('mouseleave', () => {
    if (chatState.open) return
    scheduleBubbleHide(chatState.revealed || chatState.buf)
  })
  el.addEventListener('wheel', () => clearBubbleHide(), { passive: true })
}

const AUTO_HIDE_MIN = 6000
const AUTO_HIDE_MAX = 14000
function clearBubbleHide() {
  clearTimeout(clearBubbleHide.t)
  clearBubbleHide.t = 0
}
/** 直接给一个停留时长（语音模式下按「说完之后再挂 1.2 秒」算，而不是按字数估） */
function holdBubble(ms) {
  clearBubbleHide()
  clearBubbleHide.t = setTimeout(() => {
    clearBubbleHide.t = 0
    state.bubble?.hide?.()
    state.bubble?.unlock?.('chat')
    // 输入条开着就把焦点还给她，可以直接接着打字
    if (chatState.open) document.getElementById('chat-input')?.focus()
  }, ms)
}

function scheduleBubbleHide(text) {
  const len = Array.from(String(text ?? chatState.buf ?? '')).length
  // 读得完再收：6s 起步，每 30 字 +1s，最多 14s（气泡只显示最后 150 字，再长也是 14s）
  holdBubble(Math.min(AUTO_HIDE_MAX, AUTO_HIDE_MIN + Math.floor((len / 30) * 1000)))
}

const CHAT_BUBBLE_MAX = 150
/** 当前心情的主轴 + 强度档位（0.33 / 0.66 分三档），供气泡标标签与装饰用 */
function moodSnapshot() {
  const m = state.mood?.snapshot?.() || {}
  const KEYS = ['joy', 'shy', 'irk', 'sleepy', 'missing', 'clingy', 'bored']
  let key = null
  let top = 0
  for (const k of KEYS) {
    const v = Number(m[k] || 0)
    if (v > top) { top = v; key = k }
  }
  const strength = top >= 0.66 ? 'high' : top >= 0.33 ? 'mid' : 'low'
  return { key: strength === 'low' ? null : key, strength, value: top }
}

function chatRender() {
  // 语音开着时，气泡只显示「已经开口念到的那部分」（chatState.revealed）；
  // 关着就照旧显示全文（由 delta 驱动）。
  const src = flowOn() && chatState.revealed ? chatState.revealed : chatState.buf
  // 先收拾（去 markdown / 去来源行）再封顶：嘴上只留一百字，全文在「记录」里
  let shown = capReply(visibleText(src))
  if (shown.length > CHAT_BUBBLE_MAX) shown = '…' + shown.slice(-CHAT_BUBBLE_MAX)
  const proactive = chatState.source === 'proactive'
  // 这句话的情绪快照：整条消息只取一次，中途不跳
  const mood = moodSnapshot()
  if (shown) {
    state.bubble?.show(shown, {
      owner: proactive ? 'proactive' : 'chat',
      state: proactive ? 'proactive' : 'chat',
      // 出处：她自己说的 → 粉泡（模板台词由 say() 标成 script → 蓝泡）
      src: 'her',
      mood: mood.key,
      strength: mood.strength,
      sticky: true,
    })
  }
}

/** 声音开关：即时生效（关掉立刻停声），并落盘到 settings.voice */
function toggleVoice() {
  const next = state.settings?.voice === false   // 现在是静音 → 打开
  state.settings = { ...(state.settings || {}), voice: next }
  shell.set({ voice: next })
  if (!next) { state.tts?.reset?.(); state.voice?.stop?.(); shell.ttsStop?.() }
  else console.log('[voice] 已打开')
  syncVoiceButton()
}

/** 把面板上那个「声音／静音」按当前状态画好 */
function syncVoiceButton() {
  const b = document.getElementById('act-voice')
  if (!b) return
  const off = state.settings?.voice === false
  b.textContent = off ? '静音' : '声音'
  b.classList.toggle('off', off)
}

/** 当前心情 → 用哪条情绪母带（服务端 app/tts/voices 里的四个名字） */
function voiceForMood() {
  const m = state.mood?.snapshot?.() || {}
  if ((m.irk || 0) >= 0.45) return 'angry'
  if ((m.sleepy || 0) >= 0.55) return 'sleepy'
  if ((m.joy || 0) >= 0.6) return 'happy'
  return 'soft'
}

// ---- 语音 / 文字同步（句级）----
// 文字什么时候出现，由「这一句的音频什么时候开始」决定：TTS 首块到达才把这句写进气泡。
// 这样她说哪句、你看到哪句；关掉语音时退回旧的「delta 驱动打字机」。
const SENT_END = /[。！？!?…]/
const SENT_FIRST = /[，,。！？!?…]/

function ensureFlow() {
  if (!state.ttsFlow) {
    state.ttsFlow = { buf: '', qEnd: 0, items: [], active: -1, token: 0 }
  }
  return state.ttsFlow
}

/** 语音开着才走「句级同步」；关着走旧路径 */
function flowOn() {
  return state.settings?.voice !== false
}

function resetFlow() {
  const f = ensureFlow()
  for (const it of f.items) clearTimeout(it.timer)
  f.buf = ''
  f.qEnd = 0
  f.items = []
  f.active = -1
  chatState.revealed = ''
}

/** 从 f.buf 里切出已经完整的句子，逐句送去合成 */
function pumpSentences(final) {
  const f = ensureFlow()
  let consumed = 0
  for (;;) {
    const rest = f.buf.slice(f.qEnd + consumed)
    if (!rest) break
    // 第一句允许在逗号处切开：否则首字要等她把整句想完 + 合成完（实测 5 秒）
    const re = f.items.length === 0 && !final ? SENT_FIRST : SENT_END
    let cut = -1
    for (let i = 0; i < rest.length; i++) {
      if (!re.test(rest[i])) continue
      // 第一句在逗号处切也要够长，别切成「主人，」
      const strong = '。！？!?…'.includes(rest[i])
      if (re === SENT_FIRST && !strong && i < 6) continue
      cut = i + 1
      break
    }
    if (cut < 0) {
      if (!final) break
      const tail = rest.trim()
      if (tail) speakSentence(tail)
      consumed = f.buf.length - f.qEnd
      break
    }
    const piece = rest.slice(0, cut).trim()
    if (piece) for (const part of splitClauses(piece)) speakSentence(part)
    consumed += cut
    if (final && consumed >= f.buf.length - f.qEnd) break
  }
  f.qEnd += consumed
}

/**
 * 长句在逗号处切成从句：一整句 40 字交给模型，它会把逗号处的停顿压得很短，
 * 切开发音、让每段都带上首尾的自然停顿，听感就慢下来。
 * 切得太碎（「是回话，」这种）反而更赶，所以两边都要够长，短的并回前一段。
 */
function splitClauses(piece) {
  if (piece.length <= 18) return [piece]
  const raw = piece.split(/(?<=[，；])/)
  const out = []
  for (const seg of raw) {
    const t = seg.trim()
    if (!t) continue
    if (out.length && (out[out.length - 1].length < 8 || t.length < 8)) out[out.length - 1] += t
    else out.push(t)
  }
  return out.length ? out : [piece]
}

/** 送一句去合成；回包按 token 认领，避免并发请求串号 */
function speakSentence(raw) {
  const f = ensureFlow()
  // 别把 [[act:nod]] 这种标记念出来：语音和显示都用剥掉标记的干净文本
  const clean = visibleText(raw)
  if (!clean) return
  // 整轮朗读也封顶一百字：超出的只留在记录里，不念
  const used = chatState.spokenChars || 0
  if (used >= REPLY_CAP) return
  const room = REPLY_CAP - used
  const chars = Array.from(clean)
  const text = chars.length > room ? chars.slice(0, room).join('') : clean
  chatState.spokenChars = used + Array.from(text).length
  const item = { text, token: ++f.token, chunks: [], ended: false, started: false, failed: false, shown: 0, t0: 0, durMs: 0, bytes: 0 }
  f.items.push(item)
  const idx = f.items.length - 1
  // 首块 2.5 秒还没来：直接把这句显示出来，别让她卡在「…」
  // 只标记「这句可以念了」，不要直接 startItem：那样会把后面几句的 active 抢到前面，
  // 前面几句的字就永远显示不出来（实测文字卡在 14 字、直到结尾才整段蹦出）
  item.timer = setTimeout(() => { item.ready = true }, 2500)
  Promise.resolve(shell.ttsSpeak?.({ text, voice: voiceForMood(), token: item.token }))
    .then((r) => { if (r && r.ok === false) { item.failed = true; item.ready = true } })
    .catch(() => { item.failed = true; item.ready = true })
}

/** 开始「念」第 i 句：把攒下的音频推进播放器，并把文字写上气泡 */
function startItem(i) {
  const f = ensureFlow()
  const item = f.items[i]
  if (!item || item.started) return
  item.started = true
  clearTimeout(item.timer)
  f.active = i
  for (const c of item.chunks) state.voice?.push(c)
  item.chunks = []
  // 逐字上屏：按「这句大概要念多久」匀速放字（实测中文 TTS ≈ 5.5 字/秒）
  item.t0 = performance.now()
  item.shown = 0
  item.durMs = Math.max(600, item.text.length * 182)
  chatState.revealed = revealedText(f)
  chatRender()
}

/** 按「已念到第几句 + 这一句已放几个字」拼出该显示的文字 */
function revealedText(f) {
  // 一律按「这一句已放几个字」拼：早先的句子在它的音频结束后会被补齐成整句，
  // 所以这里不需要再按 active 区分（分开写会在切句瞬间把整句抖出来）
  let out = ''
  for (let i = 0; i < f.items.length; i++) {
    const it = f.items[i]
    if (i > f.active) break
    out += it.text.slice(0, it.shown || 0)
  }
  return out
}

/** 逐字放字：靠时间推，不靠音频事件（事件会晚到，字会一顿一顿） */
function revealActive() {
  const f = state.ttsFlow
  if (!f || f.active < 0) return
  const it = f.items[f.active]
  if (!it || !it.started) return
  const chars = it.text.length
  if ((it.shown || 0) >= chars) return
  const p = Math.min(1, (performance.now() - it.t0) / it.durMs)
  const want = Math.min(chars, Math.max(1, Math.round(chars * p)))
  if (want > (it.shown || 0)) {
    it.shown = want
    chatState.revealed = revealedText(f)
    chatRender()
  }
}

/** 120ms 一跳：等首块、逐字放字、排下一句、判断「整段念完」 */
function tickFlow() {
  const f = state.ttsFlow
  if (!f || !f.items.length) return
  if (f.active < 0) {
    const first = f.items[0]
    if (first.chunks.length || first.ended || first.failed || first.ready) startItem(0)
    return
  }
  const item = f.items[f.active]
  if (!item) return
  // 还没开念：等首块音频 / 等「2.5 秒兜底」标记
  if (!item.started) {
    if (item.chunks.length || item.ready || item.ended || item.failed) startItem(f.active)
    return
  }
  revealActive()
  // 语音队列可能在网络空隙里瞬间报 0，别急着跳下一句：要连续安静 200ms 才算这句真的念完
  if (item.ended && !state.voice?.playing) {
    if (!f.idleAt) f.idleAt = performance.now()
    if (performance.now() - f.idleAt < 200) return
    f.idleAt = 0
    // 这一句念完了：剩下的字立刻补齐（别留半句）
    if ((item.shown || 0) < item.text.length) {
      item.shown = item.text.length
      chatState.revealed = revealedText(f)
      chatRender()
    }
    const next = f.active + 1
    if (next < f.items.length) {
      // 句间留一口气：句号后面长一点（320ms），逗号切开的短句短一点（150ms）
      // —— 以前统一 120ms，长回复里连着七八句会像没换气
      if (!f.gapUntil) {
        const text = item.text || ''
        const strong = /[。！？!?…]/.test(text.slice(-1))
        // 逗号切开的从句：220ms；句号：短句 380 / 一般 460 / 长句 540
        const n = text.length
        // 比上一版各减约 15%：用户觉得标点处停得略久，只快一点点
        // 再减一点点（约 7%）：325/395/465/190 -> 300/365/430/175
        const pause = strong ? (n <= 8 ? 300 : n >= 24 ? 430 : 365) : 175
        f.gapUntil = performance.now() + pause
        return
      }
      if (performance.now() < f.gapUntil) return
      f.gapUntil = 0
      startItem(next)
    } else {
      // 全念完：把文字补齐（防止尾部没切到），再按语音长度收起
      f.gapUntil = 0
      chatState.revealed = visibleText(f.buf)
      chatRender()
      f.items = []
      f.active = -1
      holdBubble(1200)
    }
  }
}

/** 把 TTS 回包路由到对应的那一句 */
function routeTts(kind, p) {
  const f = state.ttsFlow
  const item = f && f.items.length ? f.items.find((x) => x.token === p?.token) : null
  if (!item) {
    // 没有排队的句子（例如 __say 这类直接念）：直接进播放器
    if (kind === 'chunk') state.voice?.push(p?.pcm)
    return
  }
  if (kind === 'chunk') {
    // 记字节数：等这一句合成完，就能算出它到底要念多久（48k / 16bit / 单声道）
    item.bytes += Math.round(String(p.pcm || '').length * 0.75)
    if (item.started) state.voice?.push(p.pcm)
    else item.chunks.push(p.pcm)
    return
  }
  if (kind === 'end') {
    item.ended = true
    // 真实时长到手：用它校准「逐字」的速度，长句不会再出现「字跑在声音前面」
    const realMs = (item.bytes / 2 / 48000) * 1000
    if (realMs > 300) item.durMs = Math.max(200, realMs)
    return
  }
  if (kind === 'error') {
    item.failed = true
    item.ended = true
    startItem(f.items.indexOf(item))
  }
}

/** 把一句话念出来（气泡里显示的那份文本；标记已经剥掉了） */
function speakReply(text) {
  const t = String(text || '').trim()
  if (!t) return
  if (state.settings?.voice === false) return
  const voice = voiceForMood()
  state.voice?.stop?.()
  console.log('[voice] 念：', t.slice(0, 24), '音色', voice)
  shell.ttsSpeak?.({ text: t, voice })
}

function onBrainEvent(ev) {
  if (!ev || typeof ev !== 'object') return
  const proactive = ev.source === 'proactive'
  if (ev.t === 'state') {
    if (proactive && ev.state === 'thinking') {
      // 她自己开口：不再弹「…」占位，等她真的想出话来再出现（否则空等很吵）
      chatState.source = 'proactive'
      chatState.buf = ''
      chatState.spokenChars = 0
      chatState.revealed = ''
      chatState.tagScan = 0
      chatState.doneRound = false
      resetFlow()
      chatState.id = ev.id
      clearBubbleHide()
      state.bubble?.lock?.('proactive')
      return
    }
    if (ev.state === 'thinking' && !chatState.muted) {
      chatState.source = 'chat'
      // 用户主动开口时把气泡抢过来：否则干活期间 agent 锁着气泡，
      // 她的回答根本显示不出来，屏幕上还挂着「正在敲敲打打」
      state.bubble?.lock?.('chat', { force: true })
      // 新的一轮开始：上一句的残留必须清掉。
      // 不清的话 delta 会追加在旧文本后面，visibleText 把上一条也带上、
      // 队列还会把上一句再念一遍（用户看到的就是「重复一遍」）。
      chatState.buf = ''
      chatState.spokenChars = 0
      chatState.revealed = ''
      chatState.tagScan = 0
      chatState.doneRound = false
      // ↑ 标记扫描游标必须跟着清：现在输入条是独立窗口，
      // 原来 DOM submit 里那句 tagScan=0 永远不跑了；不清就会从旧偏移继续扫，
      // 新句子里的 [[wear:...]] 全部漏掉（表现为「她说换了，但没换」）。
      resetFlow()
      state.bubble?.show('…', { state: 'thinking', owner: 'chat' })
      clearBubbleHide()
      // 思考脸单独一个 source：说完话收它，不连累她正在做的表情
      flashExpression('expr_loading', 20000, 'chat-loading')
    }
    if (ev.state === 'idle') {
      state.layers?.removeSource?.('chat-loading')
      // 不在这里 removeSource('agent')：句末紧跟 idle，会把刚做的表情一秒抹掉
    }
    return
  }
  if (ev.t === 'silent') {
    // 「今天不想说」：气泡不出现、什么都不留，只把锁还回去
    chatState.buf = ''
    state.bubble?.unlock?.('proactive')
    return
  }
  if (ev.t === 'delta') {
    if (chatState.muted) return
    if (!chatState.buf) state.layers?.removeSource?.('chat-loading')
    chatState.id = ev.id
    chatState.buf += ev.text
    scanTags(chatState.buf)
    if (flowOn()) {
      ensureFlow().buf = chatState.buf
      pumpSentences(false)      // 只把完整的句子排队；文字等音频首块到了再显示
    } else {
      chatRender()
    }
    clearBubbleHide()
    return
  }
  if (ev.t === 'done') {
    if (chatState.muted) return
    if (chatState.doneRound) return
    chatState.doneRound = true
    // 不再无条件用 full 覆盖：delta 是过滤过的（工具 JSON / <ref> 都被吞掉），
    // buf 一换、朗读游标 qEnd 还是旧偏移，尾巴就会把已经念过的最后一句再念一遍
    // （用户听到/看到的就是「最后一句重复」）。改成：一个字都没收到才兜底，
    // 否则只在 full 明显更长、且以 delta 为前缀时补尾巴。
    const full = String(ev.full || '')
    if (full) {
      if (!chatState.buf) {
        chatState.buf = full
      } else {
        const cur = visibleText(chatState.buf)
        const fullVis = visibleText(full)
        if (fullVis.length > cur.length && fullVis.startsWith(cur)) {
          chatState.buf += fullVis.slice(cur.length)
        }
      }
    }
    if (!visibleText(chatState.buf).trim()) {
      // 整句只有标记（例如 [[silent]]）：什么都没长出来，就当没发生
      state.bubble?.unlock?.(chatState.source === 'proactive' ? 'proactive' : 'chat')
      return
    }
    state.layers?.removeSource?.('chat-loading')
    if (chatState.source === 'proactive') {
      state.bubble?.unlock?.('proactive')
    } else {
      releaseChatBubble()
    }
    if (flowOn()) {
      const f = ensureFlow()
      f.buf = chatState.buf
      pumpSentences(true)       // 尾巴也切出来；气泡寿命等它念完再算
    } else {
      chatRender()
      scheduleBubbleHide()
    }
    return
  }
  if (ev.t === 'error') {
    state.layers?.removeSource?.('chat-loading')
    state.bubble?.show('连不上她的大脑：' + String(ev.message || '未知错误'), { state: 'error', owner: 'chat' })
    releaseChatBubble(6000)
    scheduleBubbleHide()
  }
}

/**
 * 把「窗口里那些 DOM 浮层」的可点矩形报给主进程。
 * 它们不在画布掩码里，只按轮廓判定穿透的话，鼠标停在她脚下的输入框上会被当成透明，
 * 整窗变成点击穿透 —— 表现就是「必须点她一下，输入框才点得进去」。
 */
/**
 * Q 版（body2/3）在画布里只占一小块，窗口怎么缩她都同比缩。
 * 所以改成「不动窗口、把画布 CSS 放大并平移到她的包围盒」—— 等价于裁切，
 * 屏幕上她就能填满窗口；命中判定由 view 反变换还原到画布坐标。
 */
async function applyViewCrop() {
  const canvas = document.querySelector('#stage canvas')
  if (!canvas) return null
  if (!state.look || state.look.body === '1') { resetViewCrop(); return null }
  const box = await inkBox()
  if (!box || !box.h || box.w < 8) return null
  const W = window.innerWidth
  const H = window.innerHeight
  const k = Math.max(1, Math.min(3.4, Math.min(W / box.w, (H - 6) / box.h)))
  if (k < 1.3) { resetViewCrop(); return null }
  state.view = { k: Number(k.toFixed(4)), bx: box.x, by: box.y }
  composeCanvasTransform()   // 裁切与缩放合成在同一层，别互相覆盖
  state.lastInkBox = { x: 0, y: 0, w: Math.round(box.w * k), h: Math.round(box.h * k) }
  console.log('[look] 裁切放大', k.toFixed(2), '包围盒', box)
  positionChatbar()
  reportChrome()
  shell.setMask({ invalid: true }) // 旧掩码坐标已失效
  return state.view
}

// ---------- Ctrl + 滚轮：平滑缩放（指数趋近 = 起步快、收尾缓） ----------
const ZOOM_MIN = 0.35
const ZOOM_MAX = 2.6
const ZOOM_TAU = 0.11 // 时间常数：越小越"跟手"，越大越有惯性

function clampZoom(z) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) }

function composeCanvasTransform() {
  const canvas = document.querySelector('#stage canvas')
  if (!canvas) return
  const v = state.zoomV || 1
  const cx = window.innerWidth / 2
  const cy = window.innerHeight / 2
  const parts = []
  if (Math.abs(v - 1) > 0.0015) parts.push(`translate(${cx}px, ${cy}px) scale(${v}) translate(${-cx}px, ${-cy}px)`)
  if (state.view) parts.push(`scale(${state.view.k}) translate(${-state.view.bx}px, ${-state.view.by}px)`)
  canvas.style.transformOrigin = '0 0'
  canvas.style.transform = parts.join(' ')
}

/** 包围盒绕窗口中心缩放：动画期间窗口不重排，只做视觉缩放，命中框跟着算 */
function scaleBoxAboutCenter(box, v, w, h) {
  const cx = w / 2
  const cy = h / 2
  return {
    x: Math.round(cx + (box.x - cx) * v),
    y: Math.round(cy + (box.y - cy) * v),
    w: Math.round(box.w * v),
    h: Math.round(box.h * v),
  }
}

/** 常驻最大窗的缩放：窗口尺寸恒定（按 cap 开），滚轮只改画布内容倍率。
 *  全程零 setBounds ⇒ 不会闪、也不会因为重排导致她"移动位置"。 */
function zoomByWheel(deltaY) {
  const cap = zoomCap()
  // 基准必须是"上一次算出的目标"，不能用 settings.zoom（它只在收尾落盘）。
  // 否则动画期间再滚，基准还是旧值，叠加起来目标会来回跳——
  // 表现就是"滚到顶之后又反着缩一点"。
  const base = Number(state.zoomTarget) || Number(state.settings?.zoom) || cap
  const cur = Math.max(ZOOM_MIN, Math.min(cap, base))
  // 单格 deltaY 约 ±100：0.0012 的指数步长 ≈ 每格 12%，比原来 24% 稳得多
  const step = Math.exp(-deltaY * 0.0012)
  const next = Math.max(ZOOM_MIN, Math.min(cap, cur * step))
  // 已经顶到边界就别再动（避免浮点抖动把目标拉回去）
  if (Math.abs(next - cur) < 1e-3) return
  state.zoomTarget = next
  startZoomAnim()
}

function startZoomAnim() {
  if (state.zoomRaf) return
  state.zoomAt = performance.now()
  state.zoomRaf = requestAnimationFrame(tickZoom)
}

function tickZoom(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - (state.zoomAt || now)) / 1000))
  state.zoomAt = now
  const cap = zoomCap()
  const targetV = Math.min(1, (state.zoomTarget ?? cap) / cap)
  const prev = state.zoomV ?? 1
  state.zoomV = prev + (targetV - prev) * (1 - Math.exp(-dt / ZOOM_TAU))
  const settled = Math.abs(targetV - state.zoomV) < 0.003 || Math.abs(targetV - state.zoomV) < Math.abs(targetV - prev) * 0.02
  if (settled) state.zoomV = targetV

  composeCanvasTransform()

  // 画布被缩放了，她的包围盒也要跟着算（命中/输入条都用它）
  void inkBoxWin().then((box) => {
    if (!box) return
    state.lastInkBox = box
    shell.setMask?.({ invalid: true, box })
    if (state.bubble?.visible) state.bubble.reposition()
  })

  if (!settled) { state.zoomRaf = requestAnimationFrame(tickZoom); return }

  // 收尾：只落盘倍率，窗口一动不动
  state.zoomRaf = 0
  state.settings.zoom = Math.max(ZOOM_MIN, Math.min(cap, state.zoomV * cap))
  shell.set({ zoom: state.settings.zoom })
  // 收尾立刻按最终倍率重量一次包围盒：输入条要马上贴回她脚下，
  // 不能等 700ms（那段时间里它会压在她腿上）
  void inkBoxWin().then((box) => {
    if (!box) return
    state.lastInkBox = box
    shell.setMask?.({ invalid: true, box })
  })
  scheduleViewCrop(620)
  scheduleChromePos(520)
  state.bubble?.reposition()
}

function resetViewCrop() {
  const canvas = document.querySelector('#stage canvas')
  if (canvas) { canvas.style.transformOrigin = '' }
  state.view = null
  composeCanvasTransform()   // 只清裁切，缩放那一层要重新合成（否则会瞬间跳回满尺寸）
  if (state.view) console.log('[look] 取消裁切放大')
}

let viewCropTimer = 0
function scheduleViewCrop(ms = 700) {
  clearTimeout(viewCropTimer)
  viewCropTimer = setTimeout(() => { void applyViewCrop() }, ms)
}

/**
 * 输入条贴着她的脚：窗口尺寸跟形态无关（Q 版缩窗口她只会更小），
 * 但输入条要是还钉在窗口底下，就会离她十万八千里。
 */
let chromePosTimer = 0
let chatbarPosToken = 0
async function positionChatbar() {
  const bar = document.getElementById('chatbar')
  if (!bar || bar.classList.contains('hidden')) return
  const token = ++chatbarPosToken
  const box = (await inkBoxWin()) || state.lastInkBox
  if (token !== chatbarPosToken) return   // 期间又量了一次，丢掉旧结果
  if (!box || !box.h) return
  state.lastInkBox = box
  const h = bar.offsetHeight || 48
  const w = bar.offsetWidth || 420
  // ① 默认贴她脚下方
  const want = Math.round(box.y + box.h + 10)
  // 脚下方放不下时的备选：挪到她头顶上方（不遮身体），比钉在屏幕底部被人挡住好
  const wantAbove = Math.round(box.y - h - 10)
  state.chatbarWantTop = want
  state.chatbarWantAbove = wantAbove
  let top = want
  const availTop = window.screen?.availTop ?? 0
  const availH = window.screen?.availHeight ?? window.innerHeight
  const screenBottom = availTop + availH
  const winY = curWinY()
  // ② 屏幕底部还留多少能画：不够就钉在屏幕底部（之后上下拖窗口它都不动）
  const lowestTop = Math.round(screenBottom - winY - h - 8)
  top = resolveChatbarTop(want, lowestTop, screenBottom - h - 8, winY, h, true)
  // ③ 再夹回窗口内；窗口整个在屏幕下方时退回顶部，至少别画到看不见的地方
  top = Math.max(6, Math.min(window.innerHeight - h - 6, top))
  // 水平方向跟着她走（她左右挪，条一起挪），夹在窗口内
  const center = Math.round(box.x + box.w / 2)
  const left = Math.max(w / 2 + 8, Math.min(window.innerWidth - w / 2 - 8, center))
  bar.style.top = top + 'px'
  bar.style.bottom = 'auto'
  bar.style.left = left + 'px'
  bar.style.transform = 'translateX(-50%)'
  if (chatState.open) shell.chatAnchor?.({ cx: Math.round(box.x + box.w / 2), ty: Math.round(box.y + box.h) })
  // 同步平滑状态（记的是「屏幕坐标」）：下一次拖动从这里接着插值，不会突然跳
  state.chatbarScreenY = top + winY
  state.chatbarT = performance.now()
}
/**
 * 拖窗口时同步输入条：她相对窗口没动（想要的位置不变），但窗口在屏幕上挪了，
 * 所以只要按「屏幕底部还剩多少」重新夹一次即可 —— 位置够就完全不动，撞到底线就停住。
 */
/** 拖动期间每帧跟一次输入条：主进程在搬窗口，页面收不到「窗口动了」的事件，只能自己轮询 */
let chatbarFollowRaf = 0
function startChatbarFollow() {
  if (chatbarFollowRaf) return
  state.petWinPos = { x: window.screenX, y: window.screenY }
  const step = () => {
    chatbarFollowRaf = requestAnimationFrame(step)
    nudgeChatbarForMove()
  }
  chatbarFollowRaf = requestAnimationFrame(step)
}
function stopChatbarFollow() {
  if (chatbarFollowRaf) cancelAnimationFrame(chatbarFollowRaf)
  chatbarFollowRaf = 0
}

/**
 * 算出输入条应该在窗口内的 top。
 * 钉住（贴屏幕底）与松开（贴她脚）之间留 24px 滞回 —— 否则窗口在临界点轻微抖动时
 * 会在两种模式之间来回切，看起来就是「一跳一跳」。
 */
function curWinY() {
  return Number.isFinite(state.petWinPos?.y) ? state.petWinPos.y : (window.screenY ?? 0)
}

function resolveChatbarTop(want, lowestTop, pinScreenY, winY, h, fresh) {
  const hysteresis = 24
  // 用户定的策略（m07197 选 B）：窗口绝对不动，空间不够就把条钉在屏幕底。
  // 不翻头顶 —— 她的头本来就贴着窗口上沿，翻上去会跑到窗外。
  if (state.chatbarPin == null) {
    if (want > lowestTop) state.chatbarPin = pinScreenY
  } else if (fresh || want < lowestTop - hysteresis) {
    if (want < lowestTop - hysteresis) state.chatbarPin = null
  }
  let top = state.chatbarPin != null ? Math.round(state.chatbarPin - winY) : want
  return Math.max(6, Math.min(window.innerHeight - h - 6, top))
}

function nudgeChatbarForMove() {
  const bar = document.getElementById('chatbar')
  if (!bar || bar.classList.contains('hidden')) return
  const h = bar.offsetHeight || 48
  const availTop = window.screen?.availTop ?? 0
  const availH = window.screen?.availHeight ?? window.innerHeight
  const screenBottom = availTop + availH
  const want = Number.isFinite(state.chatbarWantTop) ? state.chatbarWantTop : (parseFloat(bar.style.top) || 0)
  const winY = curWinY()
  const lowestTop = Math.round(screenBottom - winY - h - 8)
  let top = resolveChatbarTop(want, lowestTop, screenBottom - h - 8, winY, h, false)
  top = Math.max(6, Math.min(window.innerHeight - h - 6, top))
  // 这里**不做插值**：窗口是主进程搬的，插值只会让条「落后几帧再追上来」，
  // 叠在窗口自身的位移上就成了那种一跳一跳。直接算准，屏幕位置才是真正不动的。
  state.chatbarScreenY = top + winY
  state.chatbarT = performance.now()
  const shown = Math.round(top)
  if (Math.abs(shown - (parseFloat(bar.style.top) || 0)) < 0.5) return
  bar.style.top = shown + 'px'
  // 每帧都发一次 IPC 太浪费，命中区 120ms 刷一次足够
  if (now - (state.chromeSentAt || 0) > 120) { state.chromeSentAt = now; reportChrome() }
}

// 调试口：验证「拖窗口时输入条怎么走」（console / CDP 用）
window.__chatbarNudge = () => nudgeChatbarForMove()
window.__chatbarPlace = () => positionChatbar()
window.__cbInfo = () => ({ want: state.chatbarWantTop, aboveCached: state.chatbarWantAbove, pin: state.chatbarPin, ink: state.lastInkBox, winY: window.screenY })

function scheduleChromePos(ms = 260) {
  clearTimeout(chromePosTimer)
  chromePosTimer = setTimeout(async () => {
    try { const box = await inkBoxWin(); if (box) state.lastInkBox = box } catch {}
    positionChatbar()
    reportChrome()
  }, ms)
}

function reportChrome() {
  const rects = []
  for (const sel of ['#chatbar', '#tools', '#look-panel', '#recover', '#toast']) {
    const el = document.querySelector(sel)
    if (!el || el.classList.contains('hidden')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    rects.push({ x: r.left, y: r.top, w: r.width, h: r.height })
  }
  shell.setChrome?.(rects)
}

/** 输入条的 ✕：只收输入条，不打断她正在说的话（要打断点她或按 Esc） */
function bindChatClose() {
  const btn = document.getElementById('chat-close')
  if (!btn) return
  btn.addEventListener('click', () => {
    const bar = document.getElementById('chatbar')
    bar?.classList.add('hidden')
    state.chatbarPin = null
    chatState.open = false
    document.getElementById('chat-input')?.blur()
    releaseChatBubble(1200)
    reportChrome()
  })
}

function bindChat() {
  const bar = document.getElementById('chatbar')
  if (bar) bar.classList.add('hidden'); bar && (bar.style.display = 'none')
  const input = document.getElementById('chat-input')
  if (!bar || !input) return
  bindChatClose()
  const open = () => {
    // 输入条在独立窗口里（跟着窗口一起被搬就会抖），这里只负责把锚点告诉主进程
    const box = state.lastInkBox
    if (box) shell.chatToggle?.(true, { cx: Math.round(box.x + box.w / 2), ty: Math.round(box.y + box.h) })
    else shell.chatToggle?.(true, null)
    chatState.open = true
  }
  const close = () => {
    shell.chatToggle?.(false)
    state.chatbarPin = null
    chatState.open = false
  }
  state.openChat = open

  window.addEventListener('dblclick', (e) => {
    if (e.target?.closest?.('#tools, #chatbar')) return
    shell.proactiveTouch?.()
    open()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chatState.open) {
      // 先关输入条，再把正在说的那句掐掉：远端已经出队的字不能再往气泡里灌
      chatState.muted = true
      close()
      shell.brainInterrupt?.()
      state.voice?.stop?.()
      shell.ttsStop?.()
      resetFlow()
      state.layers?.removeSource?.('agent')
      releaseChatBubble(1200)
      return
    }
    if (e.key === 'Enter' && !chatState.open && document.activeElement === document.body) open()
  })
  bar.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    chatState.buf = ''
    chatState.tagScan = 0
    chatState.muted = false
    clearBubbleHide()
    input.focus()
    // 说话期间独占气泡：待机台词 / 互动台词都会走 bubble.show，抢不过锁
    state.bubble?.lock?.('chat')
    shell.brainSay?.(text)
  })
  shell.onBrainEvent?.((ev) => onBrainEvent(ev))
  // 拖动期间主进程每搬一次窗口就报一次坐标：用这个代替 window.screenY（后者会晚一两帧）
  shell.onPetPos?.((p) => {
    if (!p || typeof p.y !== 'number') return
    state.petWinPos = { x: p.x, y: p.y }
    const bar = document.getElementById('chatbar')
    if (!bar || bar.classList.contains('hidden')) return
    if (state.chatbarPin == null) return          // 跟着她的情况不需要补偿
    const h = bar.offsetHeight || 48
    const top = Math.round(state.chatbarPin - p.y)
    const shown = Math.max(6, Math.min(window.innerHeight - h - 6, top))
    if (Math.abs(shown - (parseFloat(bar.style.top) || 0)) >= 0.5) bar.style.top = shown + 'px'
  })
  // 在场感：主人走开时把待机调慢、不再自言自语（省得对着空屋子演）；回来恢复
  shell.onPresence?.((p) => {
    const stage = p?.stage || 'here'
    if (stage === state.presence) return
    state.presence = stage
    const awayNow = stage !== 'here'
    state.applyBodyMood?.()
    if (!awayNow && state.mood) {
      // 「你回来了」这一句要带着她此刻的心情去生成，不然刚被摸完说话像失忆
      const d = describeMood(state.mood.snapshot())
      if (d) shell.moodContext?.(d)
    }
    if (awayNow) {
      // 走开一会儿就别让气泡一直挂着（她刚才那句话已经没人看了）
      if (chatState.source !== 'proactive') state.bubble?.hide?.()
    }
  })
  // 浮层位置会随窗口变形/设置面板开关变化，定期回报一次（很便宜，主进程只在判定时用）
  window.addEventListener('resize', reportChrome)
  setInterval(reportChrome, 2000)
  // 点她（tap）也可以说话：空白处双击太隐蔽
  state.openChat = open
}
