import type { Live2DSprite } from 'easy-live2d'

/**
 * 衣橱 / 形态（最小接线版）。
 *
 * 为什么写参数而不是用 exp3：
 *   - 原素材里"换装"本来就是一堆 0/1 开关参数（Clothes1..5、key9..12、LeanInput），
 *     exp3 只是把这些开关打包成表情而已（件件都是 `Blend:Add`，一步到位）。
 *   - exp3 是"表情"，会被下一次 setExpression(default) 抹掉，而且多个 exp3 叠加时
 *     谁最后写谁赢，状态难追踪；直接写参数则是一份明确的布尔状态。
 *   - 这些参数都是物理的输入或无关项，**不是物理输出**，所以覆盖表（物理之后写）
 *     压得住物理，也不会被下一帧物理冲掉。
 *
 * 形态 = Clothes2（大小变）：0 = 长身，0.4 = 半身，1 = 豆丁。它同时是尾巴/前发Y
 * 物理的输入，所以切形态时头发尾巴会顺势甩一下——这是好事，别抹平。
 */

export type OutfitId = 'skirt' | 'chest' | 'shoes' | 'tail' | 'tooth' | 'basin' | 'glasses' | 'monocle' | 'lean'
export type FormId = 'long' | 'half' | 'mini'

interface OutfitSpec {
  id: OutfitId
  label: string
  param: string
  /** 打开 = 这个样子。参数上下限见 assets/model/params.json */
  on: number
  off: number
  /** 默认是否打开（跟模型参数的 def 对齐） */
  initial: boolean
}

/** 顺序 = 菜单里的顺序：先衣服，再脸面，最后体态 */
const OUTFITS: OutfitSpec[] = [
  { id: 'skirt', label: '长裙', param: 'Clothes1', on: 0, off: 1, initial: false },
  { id: 'chest', label: '胸口衣服', param: 'Clothes3', on: 1, off: 0, initial: false },
  { id: 'shoes', label: '脱鞋', param: 'Clothes4', on: 1, off: 0, initial: false },
  { id: 'tail', label: '尾巴', param: 'Clothes5', on: 1, off: 0, initial: true },
  { id: 'tooth', label: '兔牙', param: 'key9', on: 1, off: 0, initial: false },
  { id: 'basin', label: '大钢盆', param: 'key10', on: 1, off: 0, initial: false },
  { id: 'glasses', label: '黑框眼镜', param: 'key11', on: 1, off: 0, initial: false },
  { id: 'monocle', label: '单片眼镜', param: 'key12', on: 1, off: 0, initial: false },
  { id: 'lean', label: '前倾', param: 'LeanInput', on: -30, off: 0, initial: false }
]

const FORMS: Array<{ id: FormId; label: string; value: number }> = [
  { id: 'long', label: '长身（默认）', value: 0 },
  { id: 'half', label: '体型1（六成）', value: 0.4 },
  { id: 'mini', label: '体型2（豆丁）', value: 1 }
]

export interface Wardrobe {
  isOn: (id: OutfitId) => boolean
  /** 翻转一件配件，返回翻转后的状态 */
  toggle: (id: OutfitId) => boolean
  setForm: (id: FormId) => void
  form: () => FormId
  /** 全部回到模型默认（短裙 / 有尾巴 / 长身） */
  reset: () => void
  items: () => Array<{ id: OutfitId; label: string; on: boolean }>
  forms: () => Array<{ id: FormId; label: string; active: boolean }>
}

export function createWardrobe(sprite: Live2DSprite): Wardrobe {
  const on = new Map<OutfitId, boolean>(OUTFITS.map((o) => [o.id, o.initial]))
  let form: FormId = 'long'

  const apply = (spec: OutfitSpec, value: boolean): void => {
    on.set(spec.id, value)
    sprite.setParameterValueById(spec.param, value ? spec.on : spec.off, 1)
  }

  // 启动时把初始状态写一遍：模型自带的默认值跟这里的 initial 一致，
  // 但显式写一次能保证"菜单上的勾"跟画面对得上（覆盖表优先于 exp3）。
  for (const spec of OUTFITS) apply(spec, spec.initial)
  sprite.setParameterValueById('Clothes2', 0, 1)

  return {
    isOn: (id) => on.get(id) ?? false,
    toggle(id) {
      const spec = OUTFITS.find((o) => o.id === id)
      if (!spec) return false
      const next = !(on.get(id) ?? spec.initial)
      apply(spec, next)
      return next
    },
    setForm(id) {
      const target = FORMS.find((f) => f.id === id)
      if (!target) return
      form = id
      sprite.setParameterValueById('Clothes2', target.value, 1)
    },
    form: () => form,
    reset() {
      for (const spec of OUTFITS) apply(spec, spec.initial)
      form = 'long'
      sprite.setParameterValueById('Clothes2', 0, 1)
    },
    items: () => OUTFITS.map((o) => ({ id: o.id, label: o.label, on: on.get(o.id) ?? false })),
    forms: () => FORMS.map((f) => ({ id: f.id, label: f.label, active: f.id === form }))
  }
}
