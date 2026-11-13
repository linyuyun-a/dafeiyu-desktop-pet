import { Application } from 'pixi.js'
import { Config, CubismSetting, Live2DSprite } from 'easy-live2d'
import { createPanel, type Manifest, type Panel } from './panel'
import { createBehaviour, type Behaviour } from './behaviour'
import { createTriggers, type Triggers } from './triggers'
import { createProactive, type Proactive } from './proactive'
import { createGaze, type Gaze } from './gaze'
import { createSecondary, type Secondary } from './secondary'
import { createSafety } from './safety'
import { createAlive, type Alive } from './alive'
import { createWardrobe } from './wardrobe'
import { createActionMenu, type ActionMenu } from './action-menu'
import { createSemantics, createTagScanner, splitTags } from './semantics'
import { zoneAt, type ZoneId } from './zones'
import { createBubble, type Bubble } from './bubble'
import './style.css'

const ASSET_BASE = 'pet://assets/'
const MODEL_DIR = `${ASSET_BASE}model/`
const t0 = performance.now()

function fatal(msg: string): void {
  const box = document.createElement('div')
  box.className = 'fatal'
  box.textContent = msg
  document.body.appendChild(box)
  console.error(msg)
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return (await res.json()) as T
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// 只给勘察用：读出"物理算出来的"参数值（头发/尾巴/裙子），证明摆动真的在发生
const SWAY_PROBES = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'LateHairX1', 'FrontHairY4']

function readSway(sprite: Live2DSprite, ids: string[], indexOf: Map<string, number>): string {
  type Core = { parameters?: { values?: Float32Array } }
  const inner = (sprite as unknown as { _model?: { _model?: { getModel?: () => Core } } })._model
  const values = inner?._model?.getModel?.()?.parameters?.values
  if (!values) return '(读不到模型参数)'
  return ids
    .map((want) => {
      const idx = indexOf.get(want)
      return idx === undefined ? `${want}=?` : `${want}=${values[idx].toFixed(2)}`
    }, true)
    .join(' ')
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms))
  ])
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 量出"真正画出来的东西"的包围盒（换算成 sprite 本地单位）。
 *
 * 为什么不能直接用模型画布尺寸：画布是 3749×7697，但角色只占中间一块，
 * 四周全是隐藏配件（钢盆、狗尾草等）留下的空地 —— 按画布缩放会让人物
 * 缩到窗口高度的 1/3。这里先把画布塞进窗口渲染一帧，再把像素读回来量
 * alpha，最后按当前 scale 反算回本地单位。
 */
function measureContent(app: Application, sprite: Live2DSprite, cw: number, ch: number): Box | null {
  const W = window.innerWidth
  const H = window.innerHeight
  const s0 = Math.min(W / cw, H / ch)
  sprite.setSize({ width: cw * s0, height: ch * s0 })
  sprite.position.set(Math.round((W - cw * s0) / 2), Math.round((H - ch * s0) / 2))
  app.render()

  const dpr = app.renderer.resolution || 1
  const src = app.canvas as HTMLCanvasElement
  const step = Math.max(1, Math.round(src.width / 480)) // 降采样，够准且快
  const w = Math.floor(src.width / step)
  const h = Math.floor(src.height / step)
  if (w < 2 || h < 2) return null
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(src, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data

  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  // 降采样坐标 → CSS 像素
  const toCss = (v: number): number => (v * step) / dpr
  // CSS 像素 → sprite 本地单位（减去 sprite 原点、除以当前 scale）
  const s = sprite.scale.x
  return {
    x: (toCss(x0) - sprite.x) / s,
    y: (toCss(y0) - sprite.y) / s,
    w: toCss(x1 - x0 + 1) / s,
    h: toCss(y1 - y0 + 1) / s
  }
}

let contentBox: Box | null = null

// 大小可调：zoom=1 时角色在屏幕上的高度（CSS px）与可调范围
const BASE_HEIGHT = 480
const ZOOM_MIN = 0.55
const ZOOM_MAX = 2
const ZOOM_KEY = 'pet.zoom'

function readZoom(): number {
  const v = Number(localStorage.getItem(ZOOM_KEY))
  return Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX ? v : 1
}

/** 聊天时在窗口上方预留的气泡高度（CSS px）。角色不缩小，只是往下让位。 */
let topSpace = 0

/** 把量出来的内容框填进窗口：底部对齐、水平居中、留一点边距 */
function fitSprite(sprite: Live2DSprite, app: Application): void {
  const cs = sprite.getModelCanvasSize()
  const cw = cs?.width || 3749
  const ch = cs?.height || 7697
  const W = window.innerWidth
  // 可用高度 = 窗口高度 - 上方气泡预留区；但锚点仍然是窗口底边，
  // 否则她会被顶到画面中间（第一版就踩了这个）。
  const Hfull = window.innerHeight
  const Hav = Hfull - topSpace

  const box = contentBox
  if (!box) {
    // 还没量过：先按画布塞进窗口兜底
    const s0 = Math.min(W / cw, Hav / ch)
    sprite.setSize({ width: cw * s0, height: ch * s0 })
    sprite.position.set(Math.round((W - cw * s0) / 2), Math.round(Hfull - ch * s0))
    return
  }

  // 横向不再"对称百分比"：用户要的是**窗口左边（角色右手那边）多留白**，
  // 举手/竖指都往那边伸。所以左边固定留 8% 窗口宽、右边留 3%，多出来的空间落在右边。
  const gapLeft = W * 0.08
  const gapRight = W * 0.03
  const padY = 0.9
  const k = Math.min((W - gapLeft - gapRight) / box.w, (Hav * padY) / box.h)
  sprite.setSize({ width: cw * k, height: ch * k })
  const bottom = box.y + box.h
  // 内容左边缘钉在 gapLeft 处（高度受限时右边会多出一块空白，不影响）
  sprite.position.set(Math.round(gapLeft - box.x * k), Math.round(Hfull - bottom * k))
}

async function boot(): Promise<void> {
  const core = (globalThis as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore
  if (!core) {
    fatal('Live2DCubismCore 没加载：检查 pet://assets/core/live2dcubismcore.min.js')
    return
  }

  // 引擎自带的 MouseFollow 写的是被物理覆盖的参数，对本模型无效 —— 视线跟随自己实现（gaze.ts）
  Config.MouseFollow = false
  Config.MotionGroupIdle = 'Idle'
  Config.crossOrigin = 'anonymous'

  const params = new URLSearchParams(location.search)
  const needsFramebuffer =
    params.has('check') || params.has('shot') || params.has('m1') || params.has('pose') || params.has('zonetest')
  const app = new Application()
  await app.init({
    backgroundAlpha: 0,
    antialias: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    resizeTo: window,
    preference: 'webgl',
    powerPreference: 'high-performance',
    // 只有验收模式需要把 canvas 读回来存 PNG；平时关掉（preserveDrawingBuffer 很贵）
    preserveDrawingBuffer: needsFramebuffer
  })
  const stageEl = document.getElementById('stage')
  if (!stageEl) throw new Error('缺少 #stage')
  // 判断是"真 GPU"还是 SwiftShader 软渲染（软渲染下 CPU 占用会高一个量级）
  const gl = (app.renderer as unknown as { gl: WebGL2RenderingContext }).gl
  const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info')
  const gpuName = dbgInfo ? gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  console.log(`[pet] GL: ${gpuName}`)
  stageEl.appendChild(app.canvas)
  ;(app.canvas as HTMLCanvasElement).style.cssText = 'width:100%;height:100%;'

  const manifest = await fetchJson<Manifest>(`${MODEL_DIR}manifest.json`).catch((err) => {
    console.warn('manifest 读取失败（不影响运行）:', err)
    return null
  })
  const modelJSON = await fetchJson<Record<string, unknown>>(`${MODEL_DIR}model3.json`)

  const setting = new CubismSetting({ modelJSON, prefixPath: MODEL_DIR })
  const sprite = new Live2DSprite({ modelSetting: setting })
  app.stage.addChild(sprite)

  await withTimeout(sprite.ready, 25000, '模型加载')
  const bootMs = performance.now() - t0

  const cs0 = sprite.getModelCanvasSize()
  contentBox = measureContent(app, sprite, cs0?.width || 3749, cs0?.height || 7697)

  // 调试：把内容框与命中区框画成 DOM 边框，肉眼校验坐标是否对得上
  if (params.has('marks') && manifest?.hitAreas && contentBox) {
    const draw = (left: number, top: number, w: number, h: number, color: string, label: string): void => {
      const d = document.createElement('div')
      Object.assign(d.style, { position: 'fixed', left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`, border: `2px dashed ${color}`, color, fontSize: '11px', pointerEvents: 'none', zIndex: '99' } as CSSStyleDeclaration)
      d.textContent = label
      document.body.appendChild(d)
    }
    const k = sprite.scale.x
    // contentBox 用 renderer 局部单位
    draw(sprite.x + contentBox.x * k, sprite.y + contentBox.y * k, contentBox.w * k, contentBox.h * k, '#3c3', 'content')
    const cs = sprite.getModelCanvasSize()
    const cw = cs?.width ?? 3749
    const ch = cs?.height ?? 7697
    for (const a of manifest.hitAreas) {
      const g0 = sprite.toGlobal({ x: a.norm.x * cw, y: a.norm.y * ch })
      const g1 = sprite.toGlobal({ x: (a.norm.x + a.norm.w) * cw, y: (a.norm.y + a.norm.h) * ch })
      draw(g0.x, g0.y, g1.x - g0.x, g1.y - g0.y, '#f33', a.name)
    }
    console.log('[pet] marks drawn')
  }
  console.log('[pet] contentBox', contentBox ? JSON.stringify(contentBox) : '测量失败')
  fitSprite(sprite, app)
  window.addEventListener('resize', () => fitSprite(sprite, app))

  // 引擎不会自己起 IDLE（Config.MotionGroupIdle 只在"动作播完"后接管），
  // 所以这里显式踢一脚待机动作；motion 的 Meta.Loop=true，会自己循环。
  try {
    const idle = sprite.getMotions().filter((m) => m.group === Config.MotionGroupIdle)
    if (idle.length > 0) {
      await sprite.startMotion({ group: Config.MotionGroupIdle, no: idle[0].no, priority: 1 })
      console.log(`[pet] idle motion started: ${idle[0].name} (${idle.length} 个)`)
    } else {
      console.warn('[pet] 没有 IDLE 动作组')
    }
  } catch (err) {
    console.warn('[pet] 启动 IDLE 失败:', err)
  }


  // 参数表：secondary 要用它把参数名换成下标（引擎没有公开 getter）
  const paramsTable = await fetchJson<{
    params: { id: string; def: number; min: number; max: number; keys?: number[] }[]
  }>(`${MODEL_DIR}params.json`).catch(() => null)
  const canvasEl = app.canvas as HTMLCanvasElement
  // 生命层实例（下面才创建；这里先声明，视线大幅切换时要让它顺手眨一下眼）
  let alive: Alive | null = null
  const gaze: Gaze = createGaze({
    sprite,
    canvas: canvasEl,
    log: (m) => panel?.log(m) || console.log(`[pet] ${m}`),
    onSaccade: () => alive?.blink()
  })
  const secondary: Secondary = createSecondary({
    sprite,
    params: paramsTable?.params ?? null,
    log: (m) => panel?.log(m) || console.log(`[pet] ${m}`)
  })
  // 防畸形层：夹越界、吸附关键帧（Clothes2 三档）、半身开关守卫（见 safety.ts 顶部注释）
  const safetyLayer = createSafety({
    sprite,
    params: paramsTable?.params ?? null,
    log: (m) => panel?.log(m) || console.log(`[pet] ${m}`)
  })
  // 视线跟随默认开；?gaze=0 关掉（验收/排障用），Ctrl+Alt+G 切换
  let gazeOn = new URLSearchParams(location.search).get('gaze') !== '0'
  gaze.setEnabled(gazeOn)
  window.addEventListener('keydown', (e) => {
    // 规划里写的是 Ctrl+Shift+M；Ctrl+Alt+G 作为别名一起收
    if ((e.ctrlKey && e.shiftKey && e.code === 'KeyM') || (e.ctrlKey && e.altKey && e.code === 'KeyG')) {
      e.preventDefault()
      gazeOn = !gazeOn
      gaze.setEnabled(gazeOn)
    }
  })
  app.ticker.add(() => {
    const dt = app.ticker.deltaMS / 1000
    gaze.update(dt)
    secondary.update(dt)
    safetyLayer.update(dt)
  })

  let panel: Panel | null = null
  let behaviour: Behaviour | null = null
  let triggers: Triggers | null = null
  let actionMenu: ActionMenu | null = null
  let proactive: Proactive | null = null

  // 命中区：引擎自带的 HitAreas 只有 Head / Body，而且按 drawable 包围盒算，
  // 这个模型的 drawable 跟"头/身子"对不上（实测点上去落在头发外侧）。
  // 所以真正的命中也走 zones.ts 的"内容框归一化分区"（耳朵/脸/胸口/裙子/腿/脚/尾巴/手）。
  // 引擎事件只留给面板显示（不触发反应），否则一次点击会演两遍。
  const fireHit = (area: string): void => {
    ;(window as unknown as { __lastHit?: string }).__lastHit = area
    triggers?.pointer(area, 'tap')
  }
  sprite.onLive2D('hit', ({ hitAreaName, x, y }) => {
    panel?.setHit(hitAreaName, x, y)
  })

  /** 内容框在窗口里的位置（CSS 像素）——命中分区用它，跟缩放/位置解耦 */
  const contentRect = (): { x: number; y: number; w: number; h: number } | null => {
    if (!contentBox) return null
    const k = sprite.scale.x
    return { x: sprite.x + contentBox.x * k, y: sprite.y + contentBox.y * k, w: contentBox.w * k, h: contentBox.h * k }
  }
  /** 屏幕坐标 → 身体分区（归一化坐标交给 zones.ts，比例都集中在那里） */
  const hitZoneAt = (cx: number, cy: number): ZoneId | null => {
    const r = contentRect()
    if (!r || r.w < 1 || r.h < 1) return null
    return zoneAt((cx - r.x) / r.w, (cy - r.y) / r.h)
  }

  panel = createPanel({
    app,
    sprite,
    manifest,
    bootMs,
    setMouth(v: number) {
      sprite.setParameterValueById('ParamMouthOpenY', v, 1)
    },
    async sampleAlpha() {
      return sampleAlpha(app)
    }
  })

  // ── 大小可调 ──────────────────────────────────────────────────────────
  // 窗口 = 角色宽高比 × (基准身高 × zoom)。锚点在脚底中心，缩放时站位不动。
  // Ctrl+= / Ctrl+- / Ctrl+0 或 Ctrl+滚轮；zoom 存在 localStorage，重启还记得。
  const qZoom = Number(new URLSearchParams(location.search).get('zoom'))
  const savedState = await window.pet.getWindowState().catch((): { zoom?: number } => ({}))
  const savedZoom = Number(savedState.zoom)
  let zoom =
    Number.isFinite(qZoom) && qZoom > 0
      ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, qZoom))
      : Number.isFinite(savedZoom) && savedZoom > 0
        ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, savedZoom))
        : readZoom()
  const applyZoom = async (): Promise<void> => {
    localStorage.setItem(ZOOM_KEY, String(zoom))
    void window.pet.saveWindowState({ zoom })
    const csZ = sprite.getModelCanvasSize()
    const aspect = contentBox ? contentBox.w / contentBox.h : csZ ? csZ.width / csZ.height : 0.48
    const size = await window.pet.setSize(aspect, BASE_HEIGHT * zoom + topSpace)
    // setBounds 之后 Pixi 的 resizeTo 可能还没更新到新尺寸，分两拍再摆一次
    fitSprite(sprite, app)
    requestAnimationFrame(() => fitSprite(sprite, app))
    setTimeout(() => fitSprite(sprite, app), 80)
    console.log(`[pet] zoom ${zoom.toFixed(2)}× → 窗口 ${size ? `${size.width}×${size.height}` : '?'}`)
    panel?.log(`大小 ${zoom.toFixed(2)}× · 窗口 ${size ? `${size.width}×${size.height}` : '?'}`)
  }
  const setZoom = (v: number, from = '?'): void => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))
    if (Math.abs(next - zoom) < 0.001) return
    console.log(`[zoom] ${zoom.toFixed(3)} → ${next.toFixed(3)} (${from})`)
    zoom = next
    void applyZoom()
  }
  await applyZoom()
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return
    if (e.key === '=' || e.key === '+') (e.preventDefault(), setZoom(zoom * 1.08, 'key+'))
    else if (e.key === '-') (e.preventDefault(), setZoom(zoom / 1.08, 'key-'))
    else if (e.key === '0') (e.preventDefault(), setZoom(1, 'key0'))
  })
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom(zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06), 'wheel')
    },
    { passive: false }
  )

  // ── M1：拖动 / 双击复位 / 右下角缩放把手 / 托盘指令 ─────────────────────
  const canvas = app.canvas as HTMLCanvasElement
  canvas.style.cursor = 'grab'
  // 拖动阈值：按下先不动，指针移动超过 4px 才真的开始拖。
  // 否则"点一下"会被当成"拖 0 像素"，Windows 上每次都会把窗口挪/长几个像素。
  const DRAG_THRESHOLD = 4
  let press: { x: number; y: number; dragging: boolean; synthetic: boolean } | null = null
  // 捕获阶段 + window：Pixi 在 canvas 上 stopImmediatePropagation，冒泡阶段收不到
  let holdTimer: number | null = null
  let holdFired = false
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    if (e.target !== canvas) return
    // 合成的指针（验收脚本）可以触发命中反应，但绝不能把窗口拖跑
    proactive?.notifyActivity()
    press = { x: e.screenX, y: e.screenY, dragging: false, synthetic: !e.isTrusted }
    const area = hitZoneAt(e.clientX, e.clientY)
    holdFired = false
    if (area && holdTimer === null) {
      holdTimer = window.setTimeout(() => {
        holdTimer = null
        holdFired = true
        triggers?.pointer(area, 'hold')
      }, 420)
    }
  }, true)
  let lastMove: { x: number; y: number; t: number } | null = null
  const onPressMove = (e: PointerEvent): void => {
    if (press?.synthetic) return
    if (press?.dragging) {
      const now = performance.now()
      if (lastMove) {
        const dt = (now - lastMove.t) / 1000
        if (dt > 0.002) secondary.setDragVelocity((e.screenX - lastMove.x) / dt, (e.screenY - lastMove.y) / dt)
      }
      lastMove = { x: e.screenX, y: e.screenY, t: now }
    }
    if (!press || press.dragging) return
    // 用 CSS 像素算距离：screenY 在高 DPI 下是小数，阈值判断会飘
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < DRAG_THRESHOLD) return
    press.dragging = true
    canvas.style.cursor = 'grabbing'
    if (holdTimer) {
      window.clearTimeout(holdTimer)
      holdTimer = null
    }
    triggers?.drag('start')
    void window.pet.dragStart(press.x, press.y)
  }
  window.addEventListener('pointermove', onPressMove)
  document.addEventListener('pointermove', onPressMove)
  const endDrag = (e?: PointerEvent): void => {
    if (holdTimer) {
      window.clearTimeout(holdTimer)
      holdTimer = null
      triggers?.pointer('', 'holdEnd')
    }
    // 没拖动的短按 = 摸她一下：用内容分区判命中；按住 Ctrl = 开对话框（不摸）
    if (press && !press.dragging && !holdFired && e && e.button === 0) {
      if (e.ctrlKey) {
        toggleChat()
      } else {
        const area = hitZoneAt(e.clientX, e.clientY)
        if (area) fireHit(area)
      }
    }
    if (press?.dragging) triggers?.drag('end')
    press = null
    lastMove = null
    secondary.setDragVelocity(0, 0)
    canvas.style.cursor = 'grab'
    void window.pet.dragEnd()
  }
  // 用捕获阶段：Pixi 的 PointerHandler 会在 canvas 上 stopPropagation，冒泡到 window 就收不到了
  window.addEventListener('pointerup', (e) => endDrag(e), true)
  window.addEventListener('pointercancel', () => endDrag(), true)
  // 悬停：指针停在某个命中区上超过 1.3s = 她注意到你了（triggers 里有冷却）
  let hoverZone: string | null = null
  window.addEventListener('pointermove', (e) => {
    const zone = hitZoneAt(e.clientX, e.clientY)
    if (zone === hoverZone) return
    hoverZone = zone
    triggers?.hover(zone, true)
  })
  window.addEventListener('pointerleave', () => {
    hoverZone = null
    triggers?.hover(null, false)
  })
  // 开对话框的三条路：Ctrl+单击、右键菜单第一项、双击空白处。
  // 原来双击任意位置 = 说话，但双击本身就会被连点规则吃掉（Head:rapid / Body:rapid），
  // 一次操作演两遍：先冒表情再弹对话框。所以双击只保留在"没落在任何分区"的空白处。
  const toggleChat = (): void => {
    proactive?.notifyActivity()
    bubble?.toggle()
  }
  canvas.addEventListener('dblclick', (e) => {
    if (hitZoneAt(e.clientX, e.clientY)) return
    toggleChat()
  })

  const handle = document.getElementById('resize')
  if (handle) {
    let dragging = false
    let startScreenY = 0
    let startHeight = 0
    let lastApplied = 0
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      dragging = true
      startScreenY = e.screenY
      startHeight = window.innerHeight
      lastApplied = window.innerHeight
      handle.setPointerCapture(e.pointerId)
    })
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return
      // 用 screenY（绝对坐标）：窗口本身在变高变矮，clientY 会自己打架
      const h = startHeight + (e.screenY - startScreenY)
      if (Math.abs(h - lastApplied) < 6) return
      lastApplied = h
      setZoom(h / BASE_HEIGHT, 'handle')
    })
    const stopResize = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {
        /* 指针可能已经被系统收走 */
      }
    }
    handle.addEventListener('pointerup', stopResize)
    handle.addEventListener('pointercancel', stopResize)
  }

  const setTopSpace = async (px: number): Promise<void> => {
    if (Math.abs(px - topSpace) < 1) return
    topSpace = px
    const csZ = sprite.getModelCanvasSize()
    const aspect = contentBox ? contentBox.w / contentBox.h : csZ ? csZ.width / csZ.height : 0.48
    await window.pet.setSize(aspect, BASE_HEIGHT * zoom + topSpace)
    fitSprite(sprite, app)
    requestAnimationFrame(() => fitSprite(sprite, app))
    setTimeout(() => fitSprite(sprite, app), 120)
  }

  window.pet.onSetZoom((z) => setZoom(z, 'tray'))
  window.pet.onClickThrough((on) => {
    if (on) panel?.toggle(false)
  })

  // 后台省电：失焦 15 fps，窗口隐藏 5 fps，回来恢复
  // ?fps=N 可以压到更低（老机器/笔记本电池模式），默认 30
  const fpsParam = Number(new URLSearchParams(location.search).get('fps'))
  const IDLE_FPS = Number.isFinite(fpsParam) && fpsParam >= 5 && fpsParam <= 60 ? fpsParam : 30
  const setMaxFps = (fps: number): void => {
    app.ticker.maxFPS = fps
  }
  app.ticker.maxFPS = IDLE_FPS
  window.addEventListener('blur', () => {
    setMaxFps(15)
    triggers?.system('blur')
  })
  window.addEventListener('focus', () => {
    setMaxFps(IDLE_FPS)
    triggers?.system('focus')
  })
  document.addEventListener('visibilitychange', () => {
    setMaxFps(document.hidden ? 5 : document.hasFocus() ? IDLE_FPS : 15)
  })

  // ── 触发层：归一化 → 门控 → 执行 → 广播（见 triggers.ts 顶部注释）────────
  const durationsByGroup = new Map<string, number[]>()
  const idsByGroup = new Map<string, string[]>()
  for (const m of manifest?.motions ?? []) {
    const list = durationsByGroup.get(m.group) ?? []
    list.push(m.duration ?? 2.2)
    durationsByGroup.set(m.group, list)
    const ids = idsByGroup.get(m.group) ?? []
    ids.push(m.id)
    idsByGroup.set(m.group, ids)
  }
  behaviour = createBehaviour({
    sprite,
    log: (msg) => panel?.log(msg),
    gaze,
    secondary,
    durationOf: (group, no) => durationsByGroup.get(group)?.[no] ?? 2.2,
    idOf: (group, no) => idsByGroup.get(group)?.[no]
  })
  triggers = createTriggers({
    behaviour,
    log: (msg) => panel?.log(msg),
    onEvent: (ev) => {
      ;(window as unknown as { __triggers?: unknown[] }).__triggers ??= []
      ;(window as unknown as { __triggers?: unknown[] }).__triggers!.push(ev.key)
      // 被碰/被戳的反应通常从"眨一下眼"开始（官方技巧第 4 条：动作开头要有眼部动作）
      if (/^(Head|Body):(tap|hold|rapid)$/.test(ev.key)) alive?.blink()
    }
  })
  // 自检期间不要让闲时触发器插进来演动作（会把生命层的采样打成"让位"）
  if (!params.has('alivecheck'))
    window.setInterval(() => {
      triggers?.tick()
      proactive?.tick()
    }, 5000)

  // ── 右键菜单：素材里的动作 / 表情 / 配件 / 形态全挂上（最小接线）──────────
  // 这是"所有动作都能演"的保险：自动触发器只能覆盖一部分场合，剩下的由用户点名。
  // 菜单项是 manifest 的投影，加动作不用改菜单代码。
  const wardrobe = createWardrobe(sprite)
  actionMenu = createActionMenu({
    sprite,
    manifest,
    wardrobe,
    log: (msg) => panel?.log(msg),
    perform: (action) => behaviour?.perform(action) ?? false,
    onChat: () => toggleChat()
  })
  // 右键必须 preventDefault，否则 Chromium 会弹默认菜单；右键也不该拖动窗口
  //（pointerdown 那边只认 button 0）。
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (actionMenu) void actionMenu.open()
  })
  {
    // 启动时把菜单的可达性算一遍：素材里的每个动作/表情都必须能从这里点到
    const spec = actionMenu.spec()
    const count = (nodes: Array<{ children?: unknown[] }>): number =>
      nodes.reduce((n, node) => n + (Array.isArray(node.children) ? count(node.children as Array<{ children?: unknown[] }>) : 1), 0)
    console.log(`[menu] 可达条目 ${count(spec)} 项（动作 ${manifest?.motions?.length ?? 0} / 表情 ${manifest?.expressions?.length ?? 0}）`)
  }

  // ── 分区自测（?zonetest=1）：对着每个分区的中心发一次合成点击，看反应对不对 ──
  // 合成事件 isTrusted=false，pointerdown 那边会标记 synthetic，所以不会把窗口拖跑。
  if (new URLSearchParams(location.search).has('zonetest')) {
    void (async () => {
      const r = contentRect()
      if (!r) return
      const probes: Array<[string, number, number]> = [
        ['Head', 0.5, 0.12],
        ['Face', 0.5, 0.25],
        ['EarL', 0.29, 0.25],
        ['EarR', 0.71, 0.25],
        ['Chest', 0.5, 0.38],
        ['Skirt', 0.5, 0.55],
        ['Legs', 0.45, 0.8],
        ['Feet', 0.42, 0.955],
        ['Tail', 0.88, 0.75],
        ['HandL', 0.32, 0.5],
        ['HandR', 0.68, 0.5]
      ]
      for (const [name, nx, ny] of probes) {
        const x = r.x + nx * r.w
        const y = r.y + ny * r.h
        canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }))
        canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, button: 0, bubbles: true }))
        const got = (window as unknown as { __lastHit?: string }).__lastHit
        console.log(`[zonetest] 点 ${name} → ${got ?? '无'}${got === name ? '' : ' (不符)'}`)
        // 反应是"瞬间脉冲"，停留 160ms 截图最容易拍到峰值
        await sleep(160)
        try {
          const dataUrl = (app.canvas as HTMLCanvasElement).toDataURL('image/png')
          const file = await window.pet.savePng(dataUrl, `zone-${name}.png`)
          console.log(`[zonetest] 截图 ${name} → ${file}`)
        } catch (err) {
          console.log(`[zonetest] 截图失败 ${name}: ${String(err)}`)
        }
        await sleep(1440)
      }
      console.log('[zonetest] 完成')
    })()
  }

  // ── 生命层：呼吸 / 重心微晃 / 眨眼（见 alive.ts 顶部注释）───────────────
  // 原厂 idle 循环里没有任何身体曲线，不演动作时她其实是一尊雕像，这一层补上。
  // 动作播放期间整层淡出（isBusy），不与 motion 抢 AngleZ / PositionY / ParamEyeLOpen。
  const aliveLayer: Alive = createAlive({
    sprite,
    log: (msg) => panel?.log(msg),
    isBusy: () => behaviour?.isBusy() ?? false
  })
  alive = aliveLayer
  aliveLayer.setEnabled(new URLSearchParams(location.search).get('alive') !== '0')
  app.ticker.add(() => aliveLayer.update(app.ticker.deltaMS / 1000))
  // Ctrl+Alt+B：手动眨一次（调眨眼曲线时用）
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.code === 'KeyB') aliveLayer.blink()
  })

  let bubble: Bubble | null = null
  bubble = createBubble({
    sprite,
    log: (msg) => panel?.log(msg),
    setTopSpace: (px) => void setTopSpace(px)
  })
  // ── 语义层：大脑文本里的 [[act:shy]] 等标记 → 动作/表情（对用户不可见）────────
  const semantics = createSemantics({
    perform: (a) => behaviour?.perform(a) ?? false,
    log: (m) => panel?.log(m)
  })
  const tagScanner = createTagScanner((tags) => semantics.handle(tags))
  // ── 主动开口：安静太久时她自己说一句（台词本地库，走同一套语义标记）──────
  proactive = createProactive({
    say: (t) => bubble?.say(t) ?? false,
    onTags: (tags) => semantics.handle(tags),
    log: (m) => panel?.log(m),
    isQuiet: () => triggers?.isQuiet() ?? false,
    isBusy: () => (bubble?.isBusy() ?? false) || (behaviour?.isBusy() ?? false)
  })
  proactive.setEnabled(new URLSearchParams(location.search).get('proactive') !== '0')


  window.pet.onChatEvent((ev) => {
    proactive?.notifyActivity()
    // 注意：判别字段是 `t`，不是 `kind`/`type`（以前读错了，对话出错/说完的触发从没生效过）
    switch (ev.t) {
      case 'delta':
        bubble?.handleEvent({ t: 'delta', text: tagScanner.push(ev.text) })
        return
      case 'segment':
        tagScanner.reset()
        semantics.beginReply()
        bubble?.handleEvent({ t: 'segment', text: tagScanner.push(ev.text) })
        return
      case 'done': {
        tagScanner.reset()
        // 非流式大脑（或只给全文的实现）标记还没被解释过，这里补一次
        const { text, tags } = splitTags(ev.full ?? '')
        if (!semantics.sawTags()) semantics.handle(tags)
        // 人格不能改 ⇒ 她不会吐标记，那就从她自己的台词里读情绪（客户端推断）
        const applied = semantics.react(text)
        if (applied.length) console.log(`[sem] 台词推断：${applied.join(' + ')} ← ${text.slice(0, 20)}`)
        bubble?.handleEvent({ t: 'done', full: text })
        triggers?.chat('done')
        return
      }
      case 'emotion':
        semantics.emotion(ev.emotion)
        return
      case 'state':
        tagScanner.reset()
        if (ev.v === 'thinking') semantics.beginReply()
        bubble?.handleEvent(ev)
        return
      case 'error':
        bubble?.handleEvent(ev)
        triggers?.chat('error')
        return
      default:
        bubble?.handleEvent(ev)
    }
  })
  window.pet.onSystem((kind) => triggers?.system(kind))
  window.pet.onBrainChanged((info) => {
    panel?.log(`大脑：${info.id}`)
  })
  void window.pet
    .brainInfo()
    .then((info) => panel?.log(`大脑：${info.id}（${info.capabilities.memory ? '带记忆' : '无记忆'}）`))
    .catch(() => undefined)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bubble?.isOpen() && !bubble.isBusy()) bubble.close()
  })

  const exprs = sprite.getExpressions().length
  const motions = sprite.getMotions().length
  const cs = sprite.getModelCanvasSize()
  const coreLabel = manifest?.core?.version ?? 'Cubism Core'
  panel.setReady(
    `${coreLabel} · 模型 ${cs ? `${cs.width}×${cs.height}` : '?'} · 表情 ${exprs} · 动作 ${motions} · 就绪 ${bootMs.toFixed(0)}ms`
  )
  console.log(`[pet] ready in ${bootMs.toFixed(0)}ms, expressions=${exprs}, motions=${motions}`)


  // 主动开口演示（PET_SAY）：只走气泡、不动大脑。
  // 气泡是 DOM（不在 canvas 里，整窗截图是透明的），所以这里用 DOM 状态自证：显示 → 自动收起。
  if (params.has('say') && bubble) {
    const text = params.get('say') || ''
    proactive?.notifyActivity()
    const okSay = bubble.say(text, 1200)
    console.log(`[say] ${okSay ? '说出口' : '气泡忙，没塞进去'}：${text}`)
    const dom = (): string => {
      const b = document.getElementById('bubble')
      const t = document.getElementById('bubble-text')
      return `hidden=${b?.hidden} text="${(t?.textContent ?? '').slice(0, 24)}"`
    }
    await sleep(300)
    console.log(`[say] 显示中 ${dom()}`)
    await sleep(1600)
    console.log(`[say] 收起后 ${dom()}`)
    await sleep(200)
    void window.pet.quit()
  }

  // 姿势勘察（PET_POSE='{"name":"wave","params":{...}}' 或 {"poses":[{...},{...}]}）：
  // 造新动作前先靠它把数值调对 —— 摆姿势、截图、看一眼，再写进 motion3.json
  if (params.has('pose')) {
    type PoseSpec = {
      name?: string
      params?: Record<string, number>
      expr?: string
      motion?: { group: string; no: number }
      hold?: number
      keep?: boolean // 保留上一张动过的参数（不复位）→ 用来拍物理余摆的连续帧
      reset?: boolean // 先把所有参数恢复默认再播（拍多个互不干扰的动作时用）
      poses?: PoseSpec[]
    }
    console.log('[pose] motions:', sprite.getMotions().map((m) => `${m.group}#${m.no}=${m.name}`).join(' '))
    const spec = JSON.parse(params.get('pose') || '{}') as PoseSpec
    const list = spec.poses ?? [spec]
    const table = await fetchJson<{ params: { id: string; def: number }[] }>(`${MODEL_DIR}params.json`).catch(
      () => null
    )
    const defaults = new Map((table?.params ?? []).map((p) => [p.id, p.def]))
    const indexOf = new Map((table?.params ?? []).map((p, i) => [p.id, i]))
    sprite.releaseMotions() // 先停掉 IDLE，否则它会把参数拽回去
    await sleep(150)
    let touched: string[] = []
    for (const item of list) {
      if (item.reset) {
        sprite.releaseMotions()
        await sleep(80)
        for (const [id, v] of defaults) sprite.setParameterValueById(id, v, 1)
        touched = []
        await sleep(120)
      }
      if (!item.keep) {
        for (const id of touched) sprite.setParameterValueById(id, defaults.get(id) ?? 0, 1)
        touched = Object.keys(item.params ?? {})
      }
      for (const [id, v] of Object.entries(item.params ?? {})) sprite.setParameterValueById(id, v, 1)
      if (item.expr) sprite.setExpression({ expressionId: item.expr })
      if (item.motion) {
        const m = sprite.getMotions().find((x) => x.group === item.motion!.group && x.no === item.motion!.no)
        if (m) await sprite.startMotion({ group: m.group, no: m.no, priority: 3 })
        else console.warn(`[pose] 没有动作 ${item.motion.group}#${item.motion.no}`)
      }
      const name = item.name ?? 'pose'
      await sleep(item.hold ?? (item.motion ? 600 : 260))
      // 顺手把几个"物理算出来的"参数值打出来：验证头发/尾巴真的在跟着摆
      const probe = readSway(sprite, SWAY_PROBES, indexOf)
      console.log(`[pose] hand ${readSway(sprite, ['Param59', 'Param60', 'Param61', 'Param62'], indexOf)}`)
      console.log(`[pose] ${name} ${JSON.stringify(item.params ?? {})}${item.expr ? ` expr=${item.expr}` : ''} ${probe}`)
      const dataUrl = (app.canvas as HTMLCanvasElement).toDataURL('image/png')
      const file = await window.pet.savePng(dataUrl, `pose-${name}.png`)
      panel?.log(`姿势 ${name} → ${file}`)
    }
    await sleep(120)
    void window.pet.quit()
  }

  // 验收脚本的取数口：检查模块要读内容框 / 以及最后命中的是哪个分区
  ;(window as unknown as { __pet?: unknown }).__pet = {
    app,
    sprite,
    panel,
    gaze,
    secondary,
    get alive() {
      return alive
    },
    get contentBox() {
      return contentBox
    }
  }

  // M0 验收自检（PET_CHECK=1 → ?check=1）
  if (new URLSearchParams(location.search).has('check')) {
    const { runSelfCheck } = await import('./check')
    const results = await runSelfCheck(app, sprite, manifest, (v) => sprite.setParameterValueById('ParamMouthOpenY', v, 1))
    const failed = results.filter((r) => r.ok === false)
    console.log(`[check] 汇总：${results.length} 项，失败 ${failed.length} 项`)
    await sleep(300)
    void window.pet.quit()
  }

  // M3 自检（PET_M3CHECK=1 → ?m3check=1）：手势 / 二次运动 / 视线跟随
  if (params.has('m3check')) {
    const { runM3Check } = await import('./check-m3')
    const ids = (paramsTable?.params ?? []).map((x) => x.id)
    const results = await runM3Check(sprite, gaze, secondary, ids)
    const failed = results.filter((r) => r.ok === false)
    console.log(`[m3] 汇总：${results.length} 项，失败 ${failed.length} 项`)
    await sleep(300)
    void window.pet.quit()
  }


  // 主动开口自检（PET_PROCHECK=1 → ?procheck=1）：纯假时钟，不碰窗口
  if (params.has('procheck')) {
    const { runProactiveCheck } = await import('./check-proactive')
    runProactiveCheck()
    await sleep(300)
    void window.pet.quit()
  }

  // 语义推断自检（PET_SEMCHECK=1 → ?semcheck=1）
  if (params.has('semcheck')) {
    const { runSemanticsCheck } = await import('./check-semantics')
    runSemanticsCheck()
    await sleep(300)
    void window.pet.quit()
  }

  // 触发层自检（PET_TRIGCHECK=1 → ?trigcheck=1）
  if (params.has('trigcheck') && triggers && behaviour) {
    const { runTriggerCheck } = await import('./check-triggers')
    const t: Triggers = triggers
    const b: Behaviour = behaviour
    const results = await runTriggerCheck({
      triggers: t,
      behaviour: b,
      canvas: app.canvas as HTMLCanvasElement,
      log: (msg) => console.log(`[trig] ${msg}`),
      savePng: (dataUrl, name) => window.pet.savePng(dataUrl, name)
    })
    console.log(`[trig] 汇总：通过 ${results.passed} 项，失败 ${results.failed} 项`)
    await sleep(300)
    void window.pet.quit()
  }

  // 生命层自检（PET_ALIVECHECK=1 → ?alivecheck=1）
  if (params.has('alivecheck') && alive) {
    const { runAliveCheck } = await import('./check-alive')
    const ids = (paramsTable?.params ?? []).map((x) => x.id)
    const aliveRef: Alive = alive
    const results = await runAliveCheck(sprite, aliveRef, ids)
    const failed = results.filter((r) => r.ok === false)
    console.log(`[alive] 汇总：${results.length} 项，失败 ${failed.length} 项`)
    await sleep(300)
    void window.pet.quit()
  }

  // M2 自检（PET_CHATCHECK=1 → ?chatcheck=1）
  if (params.has('chatcheck') && bubble) {
    const { runChatCheck } = await import('./check-chat')
    const results = await runChatCheck(bubble)
    const failed = results.filter((r) => r.ok === false)
    console.log(`[check] 汇总：${results.length} 项，失败 ${failed.length} 项`)
    await sleep(400)
    void window.pet.quit()
  }

  // M2 验收（PET_CHAT=1 → ?chat=1）：自动开气泡、发一句给 mock，截图交给主进程
  if (params.has('chat')) {
    bubble?.open()
    setTimeout(() => {
      void bubble?.send('在吗？今天过得怎么样')
    }, 400)
  }

  // 自动截图（PET_SHOT=1 时 main 会给 renderer 带 ?shot=1）
  if (new URLSearchParams(location.search).has('shot')) {
    setTimeout(async () => {
      const dataUrl = (app.canvas as HTMLCanvasElement).toDataURL('image/png')
      const file = await window.pet.savePng(dataUrl, 'spike-canvas.png')
      const alpha = await sampleAlpha(app)
      console.log('[pet] alpha:', alpha)
      const dbg = sprite as unknown as {
        width: number
        height: number
        scale: { x: number; y: number }
        getLocalModelWidth?: () => number
        getLocalModelHeight?: () => number
        getBounds: (skipUpdate?: boolean) => { x: number; y: number; width: number; height: number }
      }
      const b = dbg.getBounds()
      console.log(
        '[pet] size',
        JSON.stringify({
          width: dbg.width,
          height: dbg.height,
          scale: [dbg.scale.x, dbg.scale.y],
          local: [dbg.getLocalModelWidth?.(), dbg.getLocalModelHeight?.()],
          bounds: { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) },
          screen: [app.screen.width, app.screen.height],
          canvas: [cs?.width, cs?.height]
        })
      )
      panel?.log(`截图 ${file} · ${alpha}`)
      setTimeout(() => void window.pet.quit(), 300)
    }, 2500)
  }

}

/**
 * 透明自检：把 WebGL 画布画进 2D 画布，看四角 alpha 和"不透明像素占比"。
 * 背景透明 ⇒ 四角 alpha 应为 0。
 */
async function sampleAlpha(app: Application): Promise<string> {
  const src = app.canvas as HTMLCanvasElement
  app.render()
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return '透明自检失败：拿不到 2D 上下文'
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.drawImage(src, 0, 0)
  const data = ctx.getImageData(0, 0, c.width, c.height).data
  const at = (x: number, y: number): number => data[(y * c.width + x) * 4 + 3]
  const corners = [at(1, 1), at(c.width - 2, 1), at(1, c.height - 2), at(c.width - 2, c.height - 2)]

  let opaque = 0
  let total = 0
  for (let y = 0; y < c.height; y += 8) {
    for (let x = 0; x < c.width; x += 8) {
      total++
      if (at(x, y) > 8) opaque++
    }
  }
  const ratio = ((opaque / total) * 100).toFixed(1)
  const transparentOk = corners.every((a) => a === 0)
  return `透明自检：四角 alpha=[${corners.join(',')}] · 不透明像素≈${ratio}% → 背景${transparentOk ? '透明 ✓' : '不透明 ✗'}`
}

boot().catch((err: unknown) => {
  fatal(`启动失败：${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}`)
})
