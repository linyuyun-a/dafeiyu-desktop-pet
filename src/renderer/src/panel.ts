import type { Application } from 'pixi.js'
import type { Live2DSprite } from 'easy-live2d'

export interface ManifestExpression {
  id: string
  label: string
  note?: string
}

export interface ManifestMotion {
  id: string
  label: string
  group: string
  note?: string
  loop?: boolean
  duration?: number
}

export interface ManifestHitArea {
  name: string
  drawable: string
  norm: { x: number; y: number; w: number; h: number }
}

export interface Manifest {
  core?: { version?: string; bytes?: number; sha256?: string }
  textureMaxSide?: number
  vram?: { before?: string; after?: string }
  expressions?: ManifestExpression[]
  motions?: ManifestMotion[]
  hitAreas?: ManifestHitArea[]
  warnings?: string[]
}

export interface PanelHost {
  app: Application
  sprite: Live2DSprite
  manifest: Manifest | null
  /** 启动到模型可用的毫秒数 */
  bootMs: number
  /** 口型滑条：0..1 */
  setMouth: (v: number) => void
  /** 采样画布四角 alpha，返回人可读结论 */
  sampleAlpha: () => Promise<string>
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`缺少 DOM 节点 #${id}`)
  return node as T
}

export interface Panel {
  setReady: (bootNote: string) => void
  setHit: (area: string, x: number, y: number) => void
  log: (msg: string) => void
  toggle: (force?: boolean) => void
}

export function createPanel(host: PanelHost): Panel {
  const { app, sprite, manifest } = host
  const panel = el<HTMLDivElement>('panel')
  const dot = el<HTMLSpanElement>('dot')
  const meta = el<HTMLDivElement>('meta')
  const stats = el<HTMLDivElement>('stats')
  const logLine = el<HTMLElement>('log')
  const exprSelect = el<HTMLSelectElement>('expr-select')
  const motionsBox = el<HTMLDivElement>('motions')
  const mouth = el<HTMLInputElement>('mouth')
  const mouthVal = el<HTMLSpanElement>('mouth-val')
  const hitBox = el<HTMLDivElement>('hit')
  const hint = el<HTMLDivElement>('hint')

  const log = (msg: string): void => {
    logLine.textContent = msg
    void window.pet?.log(msg)
  }

  // ── 表情下拉 ──────────────────────────────────────────────
  const exprs: ManifestExpression[] = manifest?.expressions?.length
    ? manifest.expressions
    : sprite.getExpressions().map((e) => ({ id: e.name, label: e.name }))

  for (const e of exprs) {
    const opt = document.createElement('option')
    opt.value = e.id
    opt.textContent = e.label === e.id ? e.id : `${e.label}（${e.id}）`
    exprSelect.appendChild(opt)
  }

  exprSelect.addEventListener('change', () => {
    sprite.setExpression({ expressionId: exprSelect.value })
    log(`表情 → ${exprSelect.value}`)
  })

  el<HTMLButtonElement>('expr-random').addEventListener('click', () => {
    sprite.setRandomExpression()
    log('表情 → 随机')
  })

  el<HTMLButtonElement>('expr-default').addEventListener('click', () => {
    sprite.setExpression({ expressionId: 'default' })
    exprSelect.value = 'default'
    log('表情 → default')
  })

  // ── 动作按钮 ──────────────────────────────────────────────
  const motions: ManifestMotion[] = manifest?.motions?.length
    ? manifest.motions
    : sprite.getMotions().map((m) => ({ id: `${m.group}#${m.no}`, label: m.name, group: m.group }))

  motionsBox.replaceChildren()
  motions.forEach((m, index) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = m.label
    const small = document.createElement('small')
    small.textContent = m.group
    btn.appendChild(small)
    if (m.note) btn.title = `${m.note}${m.duration ? ` · ${m.duration}s` : ''}${m.loop ? ' · 循环' : ''}`
    btn.addEventListener('click', () => {
      // 引擎用 getMotions() 的组内序号，manifest 顺序与之一致；用查找兜底
      const found = sprite.getMotions().filter((x) => x.group === m.group)
      const no = found.findIndex((x) => x.name === m.label)
      void sprite.startMotion({
        group: m.group,
        no: no >= 0 ? no : Math.min(index, Math.max(0, found.length - 1)),
        priority: 2
      })
      log(`动作 → ${m.group}[${no >= 0 ? no : '?'}] ${m.label}`)
    })
    motionsBox.appendChild(btn)
  })

  // ── 口型 ────────────────────────────────────────────────
  mouth.addEventListener('input', () => {
    const v = Number(mouth.value)
    mouthVal.textContent = v.toFixed(2)
    host.setMouth(v)
  })

  // ── 统计 ────────────────────────────────────────────────
  const vram = manifest?.vram
  const statsBase = [
    `纹理上限 ${manifest?.textureMaxSide ?? '?'}px · 显存估算 ${vram?.before ?? '?'} → ${vram?.after ?? '?'}`,
    `启动 ${host.bootMs.toFixed(0)} ms · 表情 ${exprs.length} · 动作 ${motions.length}`
  ].join('\n')

  let lastStats = ''
  setInterval(() => {
    const fps = app.ticker.FPS
    const line = `fps ${fps.toFixed(1)} · 分辨率 ${app.renderer.width}×${app.renderer.height} @${app.renderer.resolution}x`
    const text = `${statsBase}\n${line}`
    if (text !== lastStats) {
      stats.textContent = text
      lastStats = text
    }
  }, 500)

  // ── 按钮 ────────────────────────────────────────────────
  el<HTMLButtonElement>('btn-quit').addEventListener('click', () => void window.pet?.quit())

  el<HTMLButtonElement>('btn-capture').addEventListener('click', async () => {
    const canvas = app.canvas as HTMLCanvasElement
    const dataUrl = canvas.toDataURL('image/png')
    const file = await window.pet.savePng(dataUrl, `canvas-${Date.now()}.png`)
    log(`已保存 ${file}`)
  })

  el<HTMLButtonElement>('btn-alpha').addEventListener('click', async () => {
    const result = await host.sampleAlpha()
    log(result)
  })

  // ── 快捷键 / 提示 ────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      toggle()
    }
  })

  function toggle(force?: boolean): void {
    const next = force ?? panel.hidden
    panel.hidden = !next
    hint.classList.toggle('show', !next)
  }

  setTimeout(() => hint.classList.add('show'), 600)
  setTimeout(() => hint.classList.remove('show'), 4200)

  return {
    setReady(bootNote: string) {
      dot.classList.add('ok')
      meta.textContent = bootNote
    },
    setHit(area: string, x: number, y: number) {
      hitBox.innerHTML = `命中 <b>${area}</b> · 局部坐标 ${x.toFixed(1)}, ${y.toFixed(1)}`
    },
    log,
    toggle
  }
}
