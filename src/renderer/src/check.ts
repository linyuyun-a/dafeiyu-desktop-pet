import type { Application } from 'pixi.js'
import type { Live2DSprite } from 'easy-live2d'
import type { Manifest } from './panel'

/**
 * M0 验收自检（`?check=1` 时由 main.ts 调用）。
 *
 * 目的：把「模型能显示」升级成「每条验收项都有证据」——
 * 每个动作/表情都存一张 PNG 到 _probe/，结果逐行打到控制台，
 * 之后再人工看图和对照 桌宠开发规划.md §9 的检查表。
 */

export interface CheckResult {
  name: string
  ok: boolean | null
  detail: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function snap(app: Application): HTMLCanvasElement {
  return app.canvas as HTMLCanvasElement
}

/** 两帧之间的像素差异比例（0–1）——用来判断"画面在动" */
async function frameDiff(app: Application): Promise<number> {
  const src = snap(app)
  const step = 4
  const w = Math.floor(src.width / step)
  const h = Math.floor(src.height / step)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return -1
  ctx.drawImage(src, 0, 0, w, h)
  const ratio = diffAgainst(ctx, w, h, baseline ? 'compare' : 'baseline')
  return ratio
}

// 上一帧数据（模块级，够脏但够用：这是个一次性的验收脚本）
let baseline: Uint8ClampedArray | null = null
function diffAgainst(ctx: CanvasRenderingContext2D, w: number, h: number, mode: 'baseline' | 'compare'): number {
  const cur = ctx.getImageData(0, 0, w, h).data
  if (mode === 'baseline' || !baseline) {
    baseline = cur.slice()
    return 0
  }
  let diff = 0
  let counted = 0
  for (let i = 0; i < cur.length; i += 4) {
    counted++
    if (Math.abs(cur[i] - baseline[i]) + Math.abs(cur[i + 1] - baseline[i + 1]) + Math.abs(cur[i + 2] - baseline[i + 2]) > 12) {
      diff++
    }
  }
  baseline = cur.slice()
  return counted > 0 ? diff / counted : 0
}

async function saveShot(app: Application, name: string): Promise<void> {
  const dataUrl = snap(app).toDataURL('image/png')
  await window.pet.savePng(dataUrl, name)
}

/** 画布归一化坐标 → 窗口 CSS 坐标 */
/** 合成一次点击（Pixi 的 PointerHandler 监听在 canvas 上） */
function tap(canvas: HTMLCanvasElement, x: number, y: number): void {
  const rect = canvas.getBoundingClientRect()
  const opts = { bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts))
  canvas.dispatchEvent(new PointerEvent('pointerup', opts))
}

export async function runSelfCheck(
  app: Application,
  sprite: Live2DSprite,
  manifest: Manifest | null,
  setMouth: (v: number) => void
): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const push = (name: string, ok: boolean | null, detail: string): void => {
    out.push({ name, ok, detail })
    console.log(`[check] ${ok === true ? '✓' : ok === false ? '✗' : '·'} ${name} — ${detail}`)
  }

  const canvas = snap(app)
  canvas.style.pointerEvents = 'auto'

  // ① 待机动画是否存在（两帧像素差异）
  await sleep(600)
  const d0 = await frameDiff(app)
  void d0
  await saveShot(app, 'check-idle-a.png')
  await sleep(800)
  await saveShot(app, 'check-idle-b.png')
  const d1 = await frameDiff(app)
  const idleOk = d1 > 0.002
  push('待机动作', idleOk, `两帧差异 ${(d1 * 100).toFixed(2)}%${idleOk ? '（在动）' : '（没动，可能 IDLE 没跑）'}`)

  // ② fps
  await sleep(800)
  // 桌上版本默认把 ticker 压在 30fps（省电，见 main.ts 的 IDLE_FPS），所以这里按 25 判
  const fps = app.ticker.FPS
  const fpsCap = app.ticker.maxFPS === 0 ? '不限' : `${app.ticker.maxFPS} fps 上限`
  push('帧率', fps > 25, `${fps.toFixed(1)} fps（${fpsCap}；判定线 25）`)
  await saveShot(app, 'check-00-idle.png')

  // ③ 表情（5 个）
  // 注意：Cubism 表情的淡出默认 1s，连续切表情会叠在一起（上一张的 key 还没归零），
  // 所以每次先切回 default 等淡出，再上目标表情。
  const exprIds = ['heart', 'cry', 'dizzy', 'blush', 'squint']
  for (const id of exprIds) {
    sprite.setExpression({ expressionId: 'default' })
    await sleep(1150)
    sprite.setExpression({ expressionId: id })
    await sleep(900)
    await saveShot(app, `check-expr-${id}.png`)
    push(`表情 ${id}`, null, '已截图，待人工确认')
  }
  sprite.setExpression({ expressionId: 'default' })
  await sleep(1150)

  // ④ 动作（3 个一次性手势）
  const motions: Array<{ group: string; no: number; name: string }> = [
    { group: 'TapBody', no: 0, name: 'hand_up' },
    { group: 'Prop', no: 0, name: 'grass_out' },
    { group: 'Emote', no: 0, name: 'point_out' }
  ]
  for (const m of motions) {
    try {
      await sprite.startMotion({ group: m.group, no: m.no, priority: 2 })
      await sleep(450)
      await saveShot(app, `check-motion-${m.name}.png`)
      push(`动作 ${m.name}`, null, `已截图（group=${m.group} no=${m.no}）`)
      await sleep(900)
    } catch (err) {
      push(`动作 ${m.name}`, false, `startMotion 失败：${String(err)}`)
    }
  }

  // ⑤ 口型
  setMouth(1)
  await sleep(260)
  await saveShot(app, 'check-mouth-open.png')
  setMouth(0)
  await sleep(200)
  await saveShot(app, 'check-mouth-closed.png')
  push('口型 ParamMouthOpenY', null, '已截开/合两张，待人工对比')

  // ⑥ 视线跟随：上下、左右各截一张（上下方向曾经反过，必须能看出来）
  const rect = canvas.getBoundingClientRect()
  const look = (nx: number, ny: number): void => {
    canvas.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: rect.left + rect.width * nx,
        clientY: rect.top + rect.height * ny,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      })
    )
  }
  look(0.5, 0.06)
  await sleep(420)
  await saveShot(app, 'check-gaze-up.png')
  look(0.5, 0.94)
  await sleep(420)
  await saveShot(app, 'check-gaze-down.png')
  look(0.08, 0.5)
  await sleep(420)
  await saveShot(app, 'check-gaze-left.png')
  look(0.92, 0.5)
  await sleep(420)
  await saveShot(app, 'check-gaze-right.png')
  push('视线跟随', null, '已截上/下/左/右四张，待人工对比（上下方向曾经相反）')

  // ⑦ 命中区：按"内容分区"判断（引擎 HitAreas 与模型对不上，见 main.ts 注释）
  const contentRectOf = (): { x: number; y: number; w: number; h: number } | null => {
    const el = (window as unknown as { __pet?: { contentBox?: { x: number; y: number; w: number; h: number } | null; sprite: Live2DSprite } }).__pet
    const cb = el?.contentBox
    if (!cb) return null
    const k = el.sprite.scale.x
    return { x: el.sprite.x + cb.x * k, y: el.sprite.y + cb.y * k, w: cb.w * k, h: cb.h * k }
  }
  const tapContent = (nx: number, ny: number): boolean => {
    const r = contentRectOf()
    if (!r) {
      const pet = (window as unknown as { __pet?: Record<string, unknown> }).__pet
      console.log('[hit] no content rect', JSON.stringify(pet ? Object.keys(pet) : 'no __pet'), JSON.stringify(pet?.contentBox))
      return false
    }
    tap(canvas, r.x + nx * r.w, r.y + ny * r.h)
    return true
  }
  const hitLog: string[] = []
  const lastHit = (): string | undefined => (window as unknown as { __lastHit?: string }).__lastHit
  for (const [name, nx, ny] of [['Head', 0.5, 0.12], ['Body', 0.5, 0.5]] as const) {
    ;(window as unknown as { __lastHit?: string }).__lastHit = undefined
    tapContent(nx, ny)
    await sleep(320)
    if (lastHit() === name) hitLog.push(name)
    console.log(`[hit] ${name} @ content(${nx},${ny}) → ${lastHit() ?? '无'}`)
  }
  const hitOk = hitLog.length === 2
  push('命中区', hitOk, `捏头/戳身子 → ${JSON.stringify(hitLog)}（内容分区判定）`)
  await saveShot(app, 'check-hit.png')

  // ⑦.5 命中反应（behaviour 层：摸头出爱心眼、戳身体脸红）
  tapContent(0.5, 0.12)
  await sleep(520)
  await saveShot(app, 'check-react-head.png')
  push('摸头反应', null, '已截图（应为爱心眼 + 小动作）')
  await sleep(1400)
  tapContent(0.5, 0.5)
  await sleep(520)
  await saveShot(app, 'check-react-body.png')
  push('戳身体反应', null, '已截图（应脸红）')

  // ⑧ 外壳 IPC（拖动 / 穿透 / 位置记忆）
  try {
    const st = await window.pet.getWindowState()
    const drag = await window.pet.dragStart()
    await sleep(320)
    await window.pet.dragEnd()
    const ctOn = await window.pet.setClickThrough(true)
    const ctOff = await window.pet.setClickThrough(false)
    push('外壳 IPC', Boolean(drag && ctOn && ctOff), `拖动=${drag} 穿透开=${ctOn} 关=${ctOff} 记忆=${JSON.stringify(st)}`)
  } catch (err) {
    push('外壳 IPC', false, String(err))
  }

  // ⑨ 内存（JS 堆，够粗糙但能看出量级）
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  if (mem) push('JS 堆', null, `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`)

  console.log('[check] done', JSON.stringify(out))
  return out
}
