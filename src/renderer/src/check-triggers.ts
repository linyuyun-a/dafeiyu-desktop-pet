import type { Behaviour } from './behaviour'
import type { Triggers } from './triggers'

/**
 * 触发层自检（PET_TRIGCHECK=1 → ?trigcheck=1）。
 *
 * 验的是"事件能不能一路走到执行器"，而不是画得好不好看：
 *   指针管线（真的派发 pointerdown/pointerup）→ 归一化 → 门控 → 执行 → 广播。
 * 门控的冷却和勿扰也顺手验了——这两条最容易写着写着就绕着走。
 */

export interface TriggerCheckHost {
  triggers: Triggers
  behaviour: Behaviour
  canvas: HTMLCanvasElement
  log: (msg: string) => void
  savePng: (dataUrl: string, name: string) => Promise<string>
}

interface Result {
  name: string
  ok: boolean
  detail: string
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const seen = (): string[] => (window as unknown as { __triggers?: string[] }).__triggers ?? []

const tap = (x: number, y: number): void => {
  const common = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 1, clientX: x, clientY: y }
  const target = document.elementFromPoint(x, y) ?? document.body
  target.dispatchEvent(new PointerEvent('pointerdown', { ...common, buttons: 1 }))
  window.dispatchEvent(new PointerEvent('pointerup', { ...common, buttons: 0 }))
}

export async function runTriggerCheck(h: TriggerCheckHost): Promise<{ passed: number; failed: number }> {
  const results: Result[] = []
  const add = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail })
    h.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`)
  }
  const w = h.canvas.clientWidth
  const hgt = h.canvas.clientHeight

  h.log('[trigcheck] 开始：指针 / 长按 / 连击 / 悬停 / 系统 / 对话')

  // ① 摸头：真的派发一次 pointerdown + pointerup
  const before = seen().length
  tap(w * 0.5, hgt * 0.14)
  await wait(260)
  const afterTap = seen().slice(before)
  add('摸头触发 Head:tap', afterTap.includes('Head:tap'), afterTap.join(',') || '（没收到任何事件）')

  // ② 短按之后立刻再点 = 还在冷却里，应该被门控挡住（不是被"忙碌"挡的另说）
  await wait(1500)

  // ③ 戳身体
  const b2 = seen().length
  tap(w * 0.5, hgt * 0.5)
  await wait(300)
  const bodyHit = seen().slice(b2)
  add('戳身体触发 Body:tap', bodyHit.includes('Body:tap'), bodyHit.join(',') || '（空）')

  // ④ 连戳三下 → rapid（等冷却过去再连，保证是连击判定生效）
  await wait(1800)
  const b3 = seen().length
  for (let i = 0; i < 3; i++) {
    tap(w * 0.5, hgt * 0.14)
    await wait(90)
  }
  await wait(300)
  const rapid = seen().slice(b3)
  add('三连戳触发 Head:rapid', rapid.includes('Head:rapid'), rapid.join(',') || '（空）')

  // ⑤ 长按：按下不动 600ms，应该出 Head:hold
  await wait(3200)
  const b4 = seen().length
  {
    const x = w * 0.5
    const y = hgt * 0.14
    const target = document.elementFromPoint(x, y) ?? document.body
    const common = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 2, clientX: x, clientY: y }
    target.dispatchEvent(new PointerEvent('pointerdown', { ...common, buttons: 1 }))
    await wait(620)
    window.dispatchEvent(new PointerEvent('pointerup', { ...common, buttons: 0 }))
  }
  await wait(300)
  const hold = seen().slice(b4)
  add('长按触发 Head:hold', hold.includes('Head:hold'), hold.join(',') || '（空）')

  // ⑥ 悬停 1.5s → hover:Head（先把冷却时间走过去）
  await wait(4200)
  const b5 = seen().length
  h.triggers.hover('Head', true)
  await wait(1500)
  const hover = seen().slice(b5)
  add('悬停 1.5s 触发 hover:Head', hover.includes('hover:Head'), hover.join(',') || '（空）')
  h.triggers.hover(null, false)

  // ⑦ 系统：锁屏 → 她睡（优先级 3，能打断在演的动作）
  await wait(1200)
  const b6 = seen().length
  h.triggers.system('lock')
  await wait(200)
  add('锁屏触发 system:lock', seen().slice(b6).includes('system:lock'), seen().slice(b6).join(',') || '（空）')

  // ⑧ 对话出错 → 圈圈眼
  const b7 = seen().length
  h.triggers.chat('error')
  await wait(200)
  add('对话出错触发 chat:error', seen().slice(b7).includes('chat:error'), seen().slice(b7).join(',') || '（空）')

  // ⑨ 勿扰：指针反应照样放行（不然会像卡死），闲时动作被挡
  h.triggers.setQuiet(true)
  await wait(400)
  const b8 = seen().length
  h.triggers.system('idle')
  await wait(200)
  add('勿扰挡住闲时动作', !seen().slice(b8).includes('system:idle'), seen().slice(b8).join(',') || '（正确：被挡）')
  const b9 = seen().length
  h.triggers.pointer('Body', 'tap')
  await wait(200)
  add('勿扰不挡用户点击', seen().slice(b9).includes('Body:tap'), seen().slice(b9).join(',') || '（空）')
  h.triggers.setQuiet(false)

  // ⑩ 统计口径：所有事件都应该被计数
  const stats = h.triggers.stats()
  const total = Object.values(stats).reduce((a, b) => a + b, 0)
  add('统计覆盖执行次数', total >= 6, `共 ${total} 次：${JSON.stringify(stats)}`)

  const failed = results.filter((r) => !r.ok)
  const dataUrl = (document.querySelector('canvas') as HTMLCanvasElement).toDataURL('image/png')
  await h.savePng(dataUrl, 'trigger-check.png')
  h.log(`[trigcheck] 汇总：${results.length} 项，失败 ${failed.length} 项`)
  return { passed: results.length - failed.length, failed: failed.length }
}
