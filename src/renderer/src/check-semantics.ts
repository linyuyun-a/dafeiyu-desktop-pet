import type { Action } from './behaviour'
import { createSemantics, inferReactions } from './semantics'
import type { CheckResult } from './check'

/**
 * 语义层自检（`PET_SEMCHECK=1`）。
 *
 * 人格提示词不能改 ⇒ 她不会输出 `[[act:...]]` 标记 ⇒ 走「从台词推断」。
 * 这里只测两件能机器判定的事：
 *   ① 规则命中对不对（纯函数，无副作用）
 *   ② 真的走一遍执行器：该演的动作有没有交出去、限流有没有生效
 */

const CASES: Array<{ text: string; want: string[] }> = [
  { text: '哈哈，你也太逗了吧', want: ['laugh'] },
  { text: '晚安，我先睡啦', want: ['sleepy'] },
  { text: '哼，才不理你', want: ['angry', 'shake'] },
  { text: '诶？你叫我？', want: ['surprise', 'tilt'] },
  { text: '今天几号？', want: ['tilt'] },
  { text: '才不是呢', want: ['shake'] },
  { text: '不许看，快转过去', want: ['shy'] },
  { text: '嗯，就这样吧', want: ['nod'] }
]

export function runSemanticsCheck(): CheckResult[] {
  const results: CheckResult[] = []
  const push = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail })
    console.log(`[sem] ${ok ? '✓' : '✗'} ${name} — ${detail}`)
  }

  const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

  let wrong = 0
  for (const c of CASES) {
    const got = inferReactions(c.text)
    const ok = same(got, c.want)
    if (!ok) wrong += 1
    push(`推断「${c.text.slice(0, 8)}」`, ok, ok ? got.join('+') : `期望 ${c.want.join('+')}，实际 ${got.join('+') || '无'}`)
  }

  // 最多 2 条
  const many = inferReactions('哈哈，哼，晚安，诶？')
  push('一轮最多 2 条', many.length <= 2, `命中 ${many.length} 条：${many.join('+')}`)

  // 走真执行器：动作真的被交出去
  const out: Action[] = []
  const sem = createSemantics({ perform: (a) => (out.push(a), true), log: () => undefined })
  sem.beginReply()
  const a1 = sem.react('哈哈，好开心')
  push('执行器收到动作', a1.length > 0 && out.length > 0, `key=${a1.join('+') || '无'}，原语 ${out.length} 个`)

  // 冷却：立刻再说一句同样的，不应再演
  const before = out.length
  const a2 = sem.react('哈哈，还是好开心')
  push('冷却生效', a2.length === 0 && out.length === before, `第二次 key=${a2.join('+') || '（空）'}`)

  // 新一轮回复后，**换一个动作**可以再演（同一个 key 仍受冷却约束）
  sem.beginReply()
  const a3 = sem.react('晚安，该睡了')
  push('新一轮解禁', a3.length > 0, `key=${a3.join('+') || '（空）'}`)

  // 空台词 / 无规则命中不能报错
  sem.beginReply()
  const a4 = sem.react('')
  push('空台词安全', a4.length === 0, '没有命中，也没抛异常')

  const failed = results.filter((r) => r.ok === false).length
  console.log(`[sem] 汇总：${results.length} 项，失败 ${failed} 项${wrong ? `（规则不符 ${wrong} 条）` : ''}`)
  return results
}
