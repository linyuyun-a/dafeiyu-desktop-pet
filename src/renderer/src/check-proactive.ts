import { createProactive } from './proactive'
import type { TagHit } from './semantics'

/**
 * 主动开口的自检：全部用假时钟 + 假 say，不依赖真窗口。
 * 断言 9 条，任何一条挂掉都直接抛错让上层汇总失败。
 */
export function runProactiveCheck(): boolean {
  let fails = 0
  const push = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails += 1
    console.log(`[pro] ${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`)
  }

  let clock = 0
  let hour = 12
  let allowSay = true
  let quiet = false
  const said: string[] = []
  const tags: TagHit[][] = []

  const p = createProactive({
    say: (t) => {
      if (!allowSay) return false
      said.push(t)
      return true
    },
    onTags: (t) => tags.push(t),
    log: () => {},
    isQuiet: () => quiet,
    now: () => clock,
    hour: () => hour,
    random: () => 0,
  })

  // 1. 刚开始不该说话
  clock = 10_000
  p.tick()
  push('前十秒不开口', said.length === 0)

  // 2. 到点开口（random=0 ⇒ 首次延迟 = 120s）
  clock = 120_100
  p.tick()
  push('到点说了一句', said.length === 1, said[0] ?? '')

  // 3. 台词里不该残留标记
  push('标记已从台词剥掉', !/\[\[/.test(said[0] ?? ''), said[0] ?? '')

  // 4. 标记要交给语义层（至少一个动作）
  push('台词带了动作', (tags[0]?.length ?? 0) > 0, JSON.stringify(tags[0] ?? []))

  // 5. 说完退避，60s 内不重复
  clock += 60_000
  p.tick()
  push('说完不立刻再来', said.length === 1)

  // 6. 用户动了之后重新计时
  p.notifyActivity()
  clock += 30_000
  p.tick()
  push('活动后重新计时', said.length === 1)
  clock += 120_000
  p.tick()
  push('再次到点才说', said.length === 2)

  // 7. 勿扰时不说，而且不消耗这一句
  quiet = true
  clock += 600_000
  p.tick()
  push('勿扰时闭嘴', said.length === 2)
  quiet = false
  clock += 31_000
  p.tick()
  push('解除勿扰后补上', said.length === 3)

  // 8. 气泡接不住时 30s 后重试
  allowSay = false
  clock += 600_000
  p.tick()
  const before = said.length
  clock += 10_000
  p.tick()
  push('接不住时先不硬塞', said.length === before)
  allowSay = true
  clock += 31_000
  p.tick()
  push('安静下来再补一句', said.length === before + 1)

  // 9. 凌晨走深夜台词库
  hour = 2
  said.length = 0
  p.notifyActivity()
  clock += 120_100
  p.tick()
  const latePool = /快去睡|我要生气了|晚安|网速/
  push('凌晨换一套台词', latePool.test(said[0] ?? ''), said[0] ?? '')

  // 10. 关掉之后彻底静音
  p.setEnabled(false)
  clock += 600_000
  p.tick()
  push('关掉后不再开口', said.length === 1)

  console.log(`[pro] 汇总：10 项，失败 ${fails} 项`)
  return fails === 0
}
