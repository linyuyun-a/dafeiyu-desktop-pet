/**
 * 装扮（look）：她自己能改的「持久外观」。
 *
 * 和「表情」的区别：
 *   - 表情是瞬时的（脸红 3 秒就散），走 source 'agent' / 'reaction'；
 *   - 装扮是持久的（戴上眼镜，一直到摘下来），走 source 'look'，并且**落盘**。
 *
 * 每个槽位独立、互斥：同一槽位只能有一个值。模型里这些能力本来就是 exp3
 * （glasses / monocle / shoes_off / skirt / body1 / body2 / tail_off / tooth /
 * basin / finger_on / chest），我们只是给它一层「状态」，不要每次现编参数。
 */

/** slot → 允许的取值、对应的 exp3 名字、中文名 */
export const SLOTS = {
  glasses: { values: ['none', 'glasses', 'monocle'], expr: { glasses: 'glasses', monocle: 'monocle' }, label: '眼镜' },
  shoes: { values: ['on', 'off'], expr: { off: 'shoes_off' }, label: '鞋' },
  skirt: { values: ['short', 'long'], expr: { long: 'skirt' }, label: '裙长' },
  body: { values: ['1', '2', '3'], expr: { '2': 'body1', '3': 'body2' }, label: '形态' },
  size: { values: ['small', 'normal', 'large'], label: '大小' },
  tail: { values: ['on', 'off'], expr: { off: 'tail_off' }, label: '尾巴' },
  tooth: { values: ['normal', 'big'], expr: { big: 'tooth' }, label: '牙' },
  accessory: { values: ['none', 'basin', 'finger'], expr: { basin: 'basin', finger: 'finger_on' }, label: '配件' },
  chest: { values: ['normal', 'boost'], expr: { boost: 'chest' }, label: '胸' },
}

export const SLOT_NAMES = Object.keys(SLOTS)

/**
 * 体型 → 窗口倍数。
 * 模型里的 body1 / body2 不是"等比变大"，是**换成 Q 版小只**（实测轮廓只有原来的
 * 三成多），所以这里给的是缩小系数：窗口跟着缩，她才始终填满画布。
 * 数值按截图实测（正常 1005px、体型2 约 620px、体型3 约 380px）取近似。
 */
export const SIZE_ZOOM = { small: 0.55, normal: 1, large: 1.2 }
export const sizeZoom = (look) => SIZE_ZOOM[String(look?.size || 'normal')] || 1

/** 默认那一身：眼镜无、穿着鞋、短裙、体型 1、有尾巴、正常牙、无配件、胸默认 */
export const DEFAULT_LOOK = {
  glasses: 'none',
  shoes: 'on',
  skirt: 'short',
  body: '1',
  size: 'normal',
  tail: 'on',
  tooth: 'normal',
  accessory: 'none',
  chest: 'normal',
}

const ALIAS = {
  // 中文 / 同义词 → 槽位名
  眼镜: 'glasses', glasses: 'glasses', 镜: 'glasses',
  鞋: 'shoes', shoes: 'shoes', 鞋子: 'shoes',
  裙: 'skirt', skirt: 'skirt', 裙子: 'skirt', 裙长: 'skirt',
  体型: 'body', body: 'body', 身材: 'body', 形态: 'body', form: 'body',
  大小: 'size', 尺寸: 'size', 身形: 'size', size: 'size',
  尾巴: 'tail', tail: 'tail',
  牙: 'tooth', tooth: 'tooth', 牙齿: 'tooth',
  配件: 'accessory', accessory: 'accessory', prop: 'accessory',
  胸: 'chest', chest: 'chest',
}

const VALUE_ALIAS = {
  glasses: { 无: 'none', none: 'none', 不戴: 'none', off: 'none', 黑框: 'glasses', 眼镜: 'glasses', 单片: 'monocle', 单片镜: 'monocle' },
  shoes: { 穿: 'on', on: 'on', 穿上: 'on', 脱: 'off', off: 'off', 脱掉: 'off', 光脚: 'off' },
  skirt: { 短: 'short', short: 'short', 短裙: 'short', 长: 'long', long: 'long', 长裙: 'long' },
  body: { 1: '1', 2: '2', 3: '3', 正常: '1', Q版: '3', q版: '3', 小只: '3', chibi: '3', 中: '2' },
  size: { 小: 'small', small: 'small', 小号: 'small', 中: 'normal', normal: 'normal', 正常: 'normal', 大: 'large', large: 'large', 大号: 'large' },
  tail: { 有: 'on', on: 'on', 留: 'on', 无: 'off', off: 'off', 收: 'off', 藏: 'off' },
  tooth: { 正常: 'normal', normal: 'normal', 大: 'big', big: 'big', 大牙: 'big' },
  accessory: { 无: 'none', none: 'none', 不用: 'none', off: 'none', 钢盆: 'basin', basin: 'basin', 盆: 'basin', 手指: 'finger', finger: 'finger', 竖手指: 'finger' },
  chest: { 正常: 'normal', normal: 'normal', 默认: 'normal', 大: 'boost', boost: 'boost' },
}

function pickSlot(raw) {
  const key = String(raw || '').trim().toLowerCase()
  return ALIAS[key] || (SLOTS[key] ? key : null)
}

function pickValue(slot, raw) {
  const key = String(raw || '').trim().toLowerCase()
  const map = VALUE_ALIAS[slot] || {}
  if (map[key]) return map[key]
  if (SLOTS[slot].values.includes(key)) return key
  return null
}

/**
 * 把一坨补丁合到当前 look 上。
 * 非法槽位 / 非法取值**静默丢弃**（她乱写不炸），返回真正生效的改动。
 */
export function normalizeLook(patch, base = DEFAULT_LOOK) {
  const look = { ...DEFAULT_LOOK, ...(base || {}) }
  const changed = []
  if (!patch || typeof patch !== 'object') return { look, changed }
  for (const [rawSlot, rawValue] of Object.entries(patch)) {
    const slot = pickSlot(rawSlot)
    if (!slot) continue
    const value = pickValue(slot, rawValue)
    if (!value) continue
    if (look[slot] === value) continue
    look[slot] = value
    changed.push({ slot, value })
  }
  return { look, changed }
}

/** 当前 look 需要的 exp3 名字（去重、保序） */
export function lookExpressions(look) {
  const out = []
  for (const slot of SLOT_NAMES) {
    const v = look?.[slot]
    const name = SLOTS[slot].expr?.[v]
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** "glasses=monocle,shoes=off" / "眼镜:单片" → { glasses: 'monocle', shoes: 'off' } */
export function parseWear(body) {
  const out = {}
  for (const part of String(body || '').split(/[,，;；]/)) {
    const seg = part.trim()
    if (!seg) continue
    const m = seg.match(/^([^=:：]+)\s*[=:：]\s*(.+)$/)
    if (!m) continue
    const slot = pickSlot(m[1])
    if (!slot) continue
    const value = pickValue(slot, m[2])
    if (!value) continue
    out[slot] = value
  }
  return out
}

/** 中文描述，用来给旁白/人格看"她现在穿的什么" */
export function describeLook(look) {
  const l = { ...DEFAULT_LOOK, ...(look || {}) }
  const bits = []
  bits.push(l.glasses === 'monocle' ? '单片眼镜' : l.glasses === 'glasses' ? '黑框眼镜' : '没戴眼镜')
  bits.push(l.shoes === 'off' ? '光着脚' : '穿着鞋')
  bits.push(l.skirt === 'long' ? '长裙' : '短裙')
  bits.push(l.body === '3' ? 'Q版小只' : l.body === '2' ? '半Q版' : '正常比例')
  bits.push(l.size === 'small' ? '缩小' : l.size === 'large' ? '放大' : '原尺寸')
  bits.push(l.tail === 'off' ? '尾巴收着' : '尾巴露着')
  if (l.tooth === 'big') bits.push('大牙')
  if (l.accessory === 'basin') bits.push('顶着钢盆')
  if (l.accessory === 'finger') bits.push('竖着手指')
  if (l.chest === 'boost') bits.push('换了上半身')
  return bits.join('、')
}

/** 她自己的话术里能用的选项清单（也用于注入人格） */
export function wearCatalog() {
  return SLOT_NAMES.map((slot) => {
    const s = SLOTS[slot]
    const opts = s.values.map((v) => (v === 'none' || v === 'normal' || v === 'default' ? `${v}（默认）` : v)).join(' / ')
    return `${s.label}（${slot}）：${opts}`
  }).join('\n')
}
