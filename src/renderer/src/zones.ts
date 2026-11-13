/**
 * 点击分区（zones）。
 *
 * 为什么不用模型的 HitAreas：`model3.json` 里只有 Head / Body 两个，而且引擎是按
 * drawable 包围盒算的，实测点上去会落在头发外侧。所以命中判断改由"内容框归一化坐标"
 * 负责：contentBox 是从 alpha 包围盒量出来的，nx/ny ∈ [0,1] 就是"从头顶到脚底"。
 *
 * 坐标都是内容框内的归一化值（0=左/上，1=右/下）。比例按 `_probe/pose-base.png`
 * （403×842）逐块量出来后用 `_probe/zone-overlay.mjs` 叠图核对过。
 * 判定顺序 = 数组顺序：越具体的越先判（耳朵/手/尾巴鳍 > 脸 > 头 > 躯干）。
 */

export type ZoneId =
  | 'Head'
  | 'Face'
  | 'EarL'
  | 'EarR'
  | 'Chest'
  | 'Skirt'
  | 'Legs'
  | 'Feet'
  | 'Tail'
  | 'HandL'
  | 'HandR'

export const ZONE_IDS: ZoneId[] = [
  'Head',
  'Face',
  'EarL',
  'EarR',
  'Chest',
  'Skirt',
  'Legs',
  'Feet',
  'Tail',
  'HandL',
  'HandR'
]

interface Box {
  zone: ZoneId
  x0: number
  x1: number
  y0: number
  y1: number
}

const BOXES: Box[] = [
  // 兽耳：头两侧的鳍，颧骨一带
  { zone: 'EarL', x0: 0.22, x1: 0.365, y0: 0.195, y1: 0.31 },
  { zone: 'EarR', x0: 0.635, x1: 0.78, y0: 0.195, y1: 0.31 },
  // 脸：五官区域（含下巴）
  { zone: 'Face', x0: 0.36, x1: 0.64, y0: 0.18, y1: 0.31 },
  // 头顶 / 女仆帽 / 呆毛
  { zone: 'Head', x0: 0.2, x1: 0.8, y0: 0.075, y1: 0.18 },
  // 手：垂在身侧那一截（袖口到指尖）
  { zone: 'HandL', x0: 0.27, x1: 0.385, y0: 0.455, y1: 0.555 },
  { zone: 'HandR', x0: 0.615, x1: 0.73, y0: 0.455, y1: 0.555 },
  // 尾巴的鳍（在右侧、跟裙摆重叠，所以排在裙子前面）
  { zone: 'Tail', x0: 0.655, x1: 0.82, y0: 0.555, y1: 0.755 },
  // 胸口 / 围裙上缘
  { zone: 'Chest', x0: 0.37, x1: 0.63, y0: 0.305, y1: 0.5 },
  // 裙子（含两侧白色裙片）
  { zone: 'Skirt', x0: 0.18, x1: 0.82, y0: 0.5, y1: 0.625 },
  // 尾巴环：身体两侧那两条
  { zone: 'Tail', x0: 0.0, x1: 0.235, y0: 0.58, y1: 0.97 },
  { zone: 'Tail', x0: 0.765, x1: 1.0, y0: 0.58, y1: 0.97 },
  // 腿
  { zone: 'Legs', x0: 0.33, x1: 0.67, y0: 0.625, y1: 0.93 },
  // 脚 / 鞋
  { zone: 'Feet', x0: 0.32, x1: 0.68, y0: 0.93, y1: 0.985 }
]

/** 归一化坐标 → 分区。落在空白处返回 null（点空不放动作）。 */
export function zoneAt(nx: number, ny: number): ZoneId | null {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null
  if (nx < -0.02 || nx > 1.02 || ny < -0.02 || ny > 1.02) return null
  for (const b of BOXES) {
    if (nx >= b.x0 && nx <= b.x1 && ny >= b.y0 && ny <= b.y1) return b.zone
  }
  return null
}

/** 给验收/叠图用的分区清单 */
export function zoneBoxes(): ReadonlyArray<{ zone: ZoneId; x0: number; x1: number; y0: number; y1: number }> {
  return BOXES
}
