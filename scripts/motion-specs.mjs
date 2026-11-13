// 手势动作的「声明式」定义 + motion3.json 生成器（单一事实源）。
//
// ── 为什么长这样 ───────────────────────────────────────────────────────────
// 上一版把所有关键帧用 type 0 线性连起来（点很密），结果还是「像做操」。原因是
// 密点只解决了采样率，没解决**速度曲线**：线性段 = 匀速直线，转折处速度突变，
// 人体动作不可能这样。
//
// 官方《提高动态质量的技巧》(docs/live2d.com .../motion-hint) 把"机器人感"的
// 成因说得很直白，这里逐条对上：
//   ① 「只动脸像机器人，要按脸的动作带身体」      → 每条动作都给 Angle* / Position* 配对
//   ② 「脸和身体同时动仍像机器人，转脸时身体稍后跟随」→ 身体通道整体滞后 2–4 帧
//   ③ 「后坐力、踩刹车：想停时会稍微冲过一点再回来」→ 主峰过冲 6–12%，末端二次回落
//   ④ 「换视线时经常眨眼」                        → 换视线的动作里插一次眨眼
//   ⑤ 「加微妙的眉毛动作」                        → 每条表情类动作都带一点眉
//   ⑥ 「大动作明显、等待时安静」                  → 小动作慢而小，大动作快进慢出
//
// 所以这里的曲线不是「关键帧 + 线性」，而是「关键帧 + 每段缓动」，再由 track()
// 采样成 60fps 密点（Live2D 只吃线性段，缓动必须在生成期烘进去）。
//
// ── 硬约束（踩过的坑，别改回去）─────────────────────────────────────────────
//   · 只写 OP 参数（AngleX/Y/Z、PositionX/Y/Z）、自由参数（眼/眉/嘴/脸/特效开关）
//   · 绝不写 ParamAngle* / ParamBodyAngle* / 头发·裙子·尾巴 —— 那些是物理输出，写了被覆盖
//   · 绝不写手部开关 Param59/60/61/62 与手指开关 Param37/38/40 —— 引擎的状态机会在播放
//     中途把它拉回去；抬手/放手一律用原厂 TapBody#0/#1 串接（见 behaviour.ts）
//   · 值域必须落在 scripts/params.json 的 min..max 里（ParamEyeLOpen 可以到 1.5）
//
// curves: { 参数id: [[秒, 值, 缓动名?], …] }   —— 缓动名写在这一段的**终点**帧上

const FPS = 60

/** 缓动：t∈[0,1] → 进度 */
const EASE = {
  lin: (t) => t,
  /** 慢起慢收，最像"人发力" */
  io: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  /** 快起慢收：急停/定位（「踩刹车」） */
  out: (t) => 1 - Math.pow(1 - t, 3),
  /** 慢起快收：预备动作 */
  in: (t) => t * t * t,
  sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  /** 冲过头再回来（过冲 8%），主峰用 */
  back: (t) => {
    const c = 1.35
    const u = t - 1
    return 1 + (c + 1) * u * u * u + c * u * u
  },
  /** 极快起步：惊吓/突然睁眼 */
  snap: (t) => 1 - Math.pow(1 - t, 6),
}

/**
 * 关键帧 → 60fps 密点。
 * keys: [[t, v, easeOfThisSegment], …]；缓动缺省 io。
 * 末尾不补到 duration —— buildMotion 的 normalize() 会平铺补到时长。
 */
function track(keys, tolRatio = 0.004, from = 0) {
  const ks = keys.map(([t, v, e]) => ({ t, v, e: e ?? 'io' })).sort((a, b) => a.t - b.t)
  // 首帧必须从「静止值」出发：否则动作一上来就停在第一个位移上，预备动作就没了
  if (ks[0].t > 0) ks.unshift({ t: 0, v: from, e: 'lin' })
  const end = ks[ks.length - 1].t
  if (end <= 0) return [[0, ks[0].v]]

  const n = Math.max(2, Math.round(end * FPS * 2))
  const pts = []
  let seg = 0
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * end
    while (seg < ks.length - 2 && t > ks[seg + 1].t) seg++
    const a = ks[seg]
    const b = ks[seg + 1]
    const span = b.t - a.t
    const u = span <= 1e-9 ? 1 : Math.min(1, Math.max(0, (t - a.t) / span))
    const f = EASE[b.e] ?? EASE.io
    pts.push([t, a.v + (b.v - a.v) * f(u)])
  }
  return decimate(pts, tolRatio)
}

/**
 * 抽稀：误差在曲线幅度 0.15% 以内的点丢掉；**极值点必留**（过冲的峰不能被削平）。
 * 这一步让文件小一半以上，同时不改变"看起来的样子"。
 */
function decimate(pts, tolRatio) {
  let min = Infinity
  let max = -Infinity
  for (const [, v] of pts) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const tol = Math.max(1e-5, (max - min) * tolRatio)
  const keep = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const [t0, v0] = keep[keep.length - 1]
    const [t1, v1] = pts[i]
    const [t2, v2] = pts[i + 1]
    // 只有在「真的回头」时才必留；平的段（斜率 0）可以丢
    const turn = (v1 - v0) * (v2 - v1) < -1e-9
    const u = (t1 - t0) / (t2 - t0 || 1)
    const onLine = v0 + (v2 - v0) * u
    if (turn || Math.abs(v1 - onLine) > tol) keep.push(pts[i])
  }
  keep.push(pts[pts.length - 1])
  return keep
}

/** 左右对称的一对参数（眼、眉） */
const pair = (a, b, keys, tol, from) => ({ [a]: track(keys, tol, from), [b]: track(keys, tol, from) })
/** 眼睛默认从「睁开」=1 出发（眨眼、眯眼都往下走） */
const eyes = (keys, tol) => pair('ParamEyeLOpen', 'ParamEyeROpen', keys, tol, 1)
const brows = (keys, tol) => pair('ParamBrowLAngle', 'ParamBrowRAngle', keys, tol, 0)
const browY = (keys, tol) => pair('ParamBrowLY', 'ParamBrowRY', keys, tol, 0)

/** 每条曲线补齐首尾，并按时间排序（顺手去重、压到 4 位小数） */
function normalize(points, duration) {
  const pts = points
    .map(([t, v]) => [Number(t.toFixed(4)), Number(v.toFixed(4))])
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, arr) => i === 0 || p[0] - arr[i - 1][0] > 1e-4)
  if (pts.length === 0) return [[0, 0], [duration, 0]]
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]])
  if (pts[pts.length - 1][0] < duration) pts.push([duration, pts[pts.length - 1][1]])
  return pts
}

/**
 * 连续参数（会"落位"的那些）——只有它们才该有过冲。
 * 开关类（key 系列、Shock、Clothes、Movement）绝不能有中间值，否则会闪。
 */
const SETTLE = /^(Angle[XYZ]|Position[XYZ]|LeanInput|ParamMouthForm|ParamMouthOpenY|ParamEyeBall[XY]|EyeSmile|BrowInnerUp|ParamBrow[LR](Angle|Y)|PoutOffsetX[LR]|CheeckPuff2?|ParamEye[LR]Open|Param11)$/

/** 下界是 0 的连续参数：过冲不能把它们压到负数 */
const ZERO_FLOOR = /^(ParamMouthOpenY|BrowInnerUp|CheeckPuff2?|PoutOffsetX[LR])$/

/** 局部极值下标（严格转向，平段不算） */
function localExtrema(pts) {
  const out = []
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1][1]
    const b = pts[i][1]
    const c = pts[i + 1][1]
    if ((b - a) * (c - b) < 0) out.push(i)
  }
  return out
}

/**
 * 统一的「落位过冲」：回到静止前，先冲过静止值一点点再回来。
 * 物理上人停不住（官方《提高动态质量的技巧》第③条"后坐力"），
 * 画面上这一下就是"活的"和"像开关"的分界。
 *
 * 只在「摆好 → 一直保持 → 收」的动作上生效：如果最后一个极值之后还在晃，
 * 说明这条曲线本来就编排过回弹了，不再插手。
 *
 * @param {[number,number][]} pts 已采样、已抽稀的点
 * @param {number} duration
 * @param {string} id 参数 id（决定下界钳制）
 */
function settle(pts, duration, id) {
  const home = pts[0][1]
  const end = pts[pts.length - 1][1]
  if (Math.abs(end - home) > 1e-6) return pts // 停在终点的动作没有回弹
  let min = Infinity
  let max = -Infinity
  for (const [, v] of pts) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const excursion = max - min
  if (excursion < 0.02) return pts
  const ex = localExtrema(pts)
  if (!ex.length) return pts
  const last = ex[ex.length - 1]
  const [tPrev, vPrev] = pts[last]
  if (Math.abs(vPrev - home) < excursion * 0.2) return pts // 收尾本来就是小晃，不用再冲
  if (duration - tPrev < 0.08) return pts
  const dir = Math.sign(vPrev - home) || 1
  const tHit = tPrev + (duration - tPrev) * 0.55
  const amp = excursion * 0.1
  let bump = home - dir * amp
  if (ZERO_FLOOR.test(id)) bump = Math.max(bump, 0)
  const out = pts.slice(0, last + 1)
  out.push([Number(tHit.toFixed(4)), home], [Number((tPrev + (duration - tPrev) * 0.8).toFixed(4)), Number(bump.toFixed(4))], [duration, home])
  return out
}

/** 把 [[t,v],…] 编成 Segments（type 0 线性，逐段一个点） */
function segments(pts) {
  const out = [pts[0][0], pts[0][1]]
  for (let i = 1; i < pts.length; i++) out.push(0, pts[i][0], pts[i][1])
  return out
}

/**
 * 生成一个 motion3.json 对象。
 * @param {{id:string, duration:number, curves:Record<string, [number,number][]>, loop?:boolean, fadeIn?:number, fadeOut?:number}} spec
 */
export function buildMotion(spec) {
  const duration = spec.duration
  const loop = spec.loop === true
  const ids = Object.keys(spec.curves)
  const curves = []
  let segCount = 0
  let ptCount = 0
  for (const id of ids) {
    let pts = normalize(spec.curves[id], duration)
    if (SETTLE.test(id)) pts = settle(pts, duration, id)
    const segs = segments(pts)
    segCount += pts.length - 1
    ptCount += pts.length
    curves.push({ Target: 'Parameter', Id: id, Segments: segs })
  }
  return {
    Version: 3,
    Meta: {
      Duration: Number(duration.toFixed(3)),
      Fps: FPS,
      Loop: loop,
      FadeInTime: spec.fadeIn ?? 0.12,
      FadeOutTime: spec.fadeOut ?? 0.38,
      AreBeziersRestricted: true,
      CurveCount: curves.length,
      TotalSegmentCount: segCount,
      TotalPointCount: ptCount,
    },
    Curves: curves,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 动作库（顺序即 UI 顺序）
//
// 时间标注（60fps）：1 帧 ≈ 0.017s。下面注释里的「+2f」= 这条通道比主角晚 2 帧。
// ────────────────────────────────────────────────────────────────────────────
export const GESTURES = [
  {
    // 听你说话时的「嗯」：两次点头，第二次幅度更大，末尾一次小回弹
    id: 'nod',
    label: '点头',
    duration: 0.9,
    curves: {
      // 头：预备微抬(-3.5) → 压 18 → 回弹 → 压 20.5 → 抬头过冲 -1.2 → 稳定
      AngleY: track([
        [0.1, -3.5, 'io'],
        [0.22, 18, 'out'],
        [0.28, 15.5, 'io'],
        [0.38, 20.5, 'back'],
        [0.54, 1.5, 'io'],
        [0.66, -1.2, 'io'],
        [0.78, 0.4, 'io'],
        [0.9, 0],
      ]),
      // 身体 +2f 跟随，幅度只有头的 1/8（头部领先是官方第②条）
      PositionY: track([
        [0.14, 0, 'lin'],
        [0.26, 2.2, 'out'],
        [0.32, 1.5, 'io'],
        [0.42, 2.4, 'back'],
        [0.6, 0.3, 'io'],
        [0.75, 0],
      ]),
      ...eyes([
        [0.3, 1, 'lin'],
        [0.35, 0.22, 'out'],
        [0.42, 1, 'io'],
        [0.9, 1],
      ]),
      EyeSmile: track([
        [0.2, 0.25, 'out'],
        [0.55, 0.3, 'io'],
        [0.9, 0],
      ]),
      ...brows([
        [0.1, -0.12, 'out'],
        [0.24, 0.06, 'io'],
        [0.5, 0],
      ]),
      ParamMouthOpenY: track([
        [0.3, 0, 'lin'],
        [0.36, 0.1, 'out'],
        [0.52, 0, 'io'],
      ]),
    },
  },
  {
    // 摇头：左右各一次，幅度递减（真的说"不"就是越摇越小）
    id: 'shake',
    label: '摇头',
    duration: 1.05,
    curves: {
      AngleX: track([
        [0.08, -2.5, 'io'],
        [0.2, 17, 'out'],
        [0.4, -15.5, 'out'],
        [0.58, 11, 'out'],
        [0.72, -4, 'io'],
        [0.86, 1.4, 'io'],
        [1.05, 0],
      ]),
      // 眼球抢跑 2f：眼睛先到，头才跟上（看人的时候就是这样）
      ParamEyeBallX: track([
        [0.16, -0.5, 'out'],
        [0.36, 0.45, 'out'],
        [0.54, -0.3, 'io'],
        [0.72, 0.1, 'io'],
        [0.9, 0],
      ]),
      PositionX: track([
        [0.12, 0, 'lin'],
        [0.24, 2.6, 'out'],
        [0.44, -2.2, 'out'],
        [0.62, 1.5, 'out'],
        [0.85, -0.3, 'io'],
        [1.05, 0],
      ]),
      AngleZ: track([
        [0.2, -3, 'io'],
        [0.42, 3, 'io'],
        [0.6, -1.5, 'io'],
        [0.85, 0],
      ]),
      ...brows([
        [0.22, 0.22, 'out'],
        [0.5, -0.1, 'io'],
        [0.8, 0],
      ]),
      ParamMouthForm: track([
        [0.2, -0.18, 'out'],
        [0.6, -0.12, 'io'],
        [0.9, 0],
      ]),
      ...eyes([
        [0.62, 1, 'lin'],
        [0.68, 0.3, 'out'],
        [0.76, 1, 'io'],
      ]),
    },
  },
  {
    // 歪头：年轻角色的招牌（官方第⑦条：加歪头等可爱动作）
    id: 'tilt',
    label: '歪头',
    duration: 0.85,
    curves: {
      AngleZ: track([
        [0.07, -2, 'io'],
        [0.24, 20, 'out'],
        [0.34, 15.8, 'io'],
        [0.48, 17.6, 'back'],
        [0.62, 16.5, 'io'],
        [0.85, 0],
      ]),
      AngleY: track([
        [0.28, 3, 'io'],
        [0.6, 2.4, 'io'],
        [0.85, 0],
      ]),
      PositionX: track([
        [0.18, 0, 'lin'],
        [0.3, 1.6, 'out'],
        [0.62, 1.4, 'io'],
        [0.85, 0],
      ]),
      EyeSmile: track([
        [0.3, 0.4, 'out'],
        [0.6, 0.35, 'io'],
        [0.85, 0],
      ]),
      BrowInnerUp: track([
        [0.3, 0.3, 'out'],
        [0.65, 0.25, 'io'],
        [0.85, 0],
      ]),
      ParamMouthForm: track([
        [0.35, 0.15, 'out'],
        [0.7, 0.1, 'io'],
        [0.85, 0],
      ]),
    },
  },
  {
    // 鞠躬：先上提 1.8（预备），再压到底，起身时反而更慢（起身比下弯慢）
    id: 'bow',
    label: '鞠躬',
    duration: 1.6,
    curves: {
      PositionY: track([
        [0.12, 1.8, 'io'],
        [0.42, -18, 'out'],
        [0.55, -14.5, 'io'],
        [0.7, -17.5, 'io'],
        [1.25, 0, 'io'],
        [1.38, 1.2, 'io'],
        [1.6, 0],
      ]),
      AngleY: track([
        [0.17, 1.5, 'io'],
        [0.47, -5.5, 'out'],
        [0.75, -4.2, 'io'],
        [1.3, 0, 'io'],
        [1.6, 0],
      ]),
      PositionZ: track([
        [0.4, -2.5, 'out'],
        [0.75, -2, 'io'],
        [1.25, 0],
      ]),
      ...eyes([
        [0.3, 1, 'lin'],
        [0.42, 0.55, 'out'],
        [0.72, 0.6, 'io'],
        [1.05, 1, 'io'],
      ]),
      ...brows([
        [0.35, 0.22, 'out'],
        [0.75, 0.18, 'io'],
        [1.1, 0],
      ]),
      ParamMouthForm: track([
        [0.4, 0.2, 'out'],
        [0.85, 0.15, 'io'],
        [1.2, 0],
      ]),
    },
  },
  {
    // 环视：眼睛先到(+2f 领先头)，头到之后身体才转(+8f)，回正时眨眼
    id: 'look_around',
    label: '环视',
    duration: 2.2,
    curves: {
      AngleX: track([
        [0.1, -1.5, 'io'],
        [0.42, -23, 'out'],
        [0.62, -21.5, 'io'],
        [0.8, 0, 'io'],
        [1.32, 23, 'out'],
        [1.55, 21.5, 'io'],
        [1.95, 0, 'io'],
        [2.2, 0],
      ]),
      ParamEyeBallX: track([
        [0.06, 0, 'lin'],
        [0.36, -0.9, 'out'],
        [0.66, -0.85, 'io'],
        [0.78, 0, 'io'],
        [1.26, 0.9, 'out'],
        [1.6, 0.85, 'io'],
        [1.92, 0, 'io'],
      ]),
      PositionX: track([
        [0.18, 0, 'lin'],
        [0.5, -2.5, 'out'],
        [0.7, -2.2, 'io'],
        [0.88, 0, 'io'],
        [1.4, 2.5, 'out'],
        [1.62, 2.2, 'io'],
        [2.0, 0],
      ]),
      // 官方第④条：换视线时眨眼
      ...eyes([
        [0.74, 1, 'lin'],
        [0.79, 0.25, 'out'],
        [0.87, 1, 'io'],
        [1.86, 1, 'lin'],
        [1.91, 0.25, 'out'],
        [1.99, 1, 'io'],
      ]),
      ...browY([
        [0.4, 0.18, 'out'],
        [0.8, 0.1, 'io'],
        [1.3, 0.18, 'out'],
        [1.9, 0],
      ]),
    },
  },
  {
    // 打哈欠：嘴张到 1.0 持续，眼睛闭到 0.08，头向后仰 —— 全是慢的
    id: 'yawn',
    label: '打哈欠',
    duration: 2.5,
    fadeIn: 0.25,
    fadeOut: 0.5,
    curves: {
      ParamMouthOpenY: track([
        [0.3, 0.2, 'io'],
        [0.62, 0.95, 'out'],
        [1.3, 1, 'io'],
        [1.75, 0.6, 'io'],
        [2.05, 0.12, 'io'],
        [2.3, 0],
      ]),
      ParamMouthForm: track([
        [0.6, -0.35, 'out'],
        [1.3, -0.3, 'io'],
        [1.9, 0, 'io'],
      ]),
      ...eyes([
        [0.25, 0.85, 'io'],
        [0.55, 0.12, 'out'],
        [1.35, 0.08, 'io'],
        [1.75, 0.45, 'io'],
        [2.1, 0.95, 'io'],
        [2.3, 1, 'io'],
      ]),
      AngleY: track([
        [0.25, -3, 'io'],
        [0.7, 12, 'out'],
        [1.3, 14, 'io'],
        [2.0, -2, 'io'],
        [2.3, 0, 'io'],
      ]),
      PositionY: track([
        [0.5, -1.5, 'io'],
        [0.9, -6, 'out'],
        [1.35, -6.5, 'io'],
        [2.0, 0.5, 'io'],
        [2.3, 0],
      ]),
      BrowInnerUp: track([
        [0.5, 0.45, 'out'],
        [1.4, 0.5, 'io'],
        [2.1, 0, 'io'],
      ]),
    },
  },
  {
    // 惊吓：全部用 snap（一帧就起来），后坐是负 Z，眼睛睁到 1.42（上限 1.5）
    id: 'surprise',
    label: '惊讶',
    duration: 0.95,
    fadeIn: 0.06,
    fadeOut: 0.25,
    curves: {
      AngleY: track([
        [0.05, 1.2, 'io'],
        [0.18, -9, 'snap'],
        [0.32, -6.5, 'io'],
        [0.48, -7.8, 'io'],
        [0.95, 0, 'io'],
      ]),
      PositionZ: track([
        [0.09, 0.6, 'io'],
        [0.22, -8, 'snap'],
        [0.32, -5, 'io'],
        [0.48, -6.2, 'io'],
        [0.9, 0, 'io'],
      ]),
      ...eyes([
        [0.07, 1.42, 'snap'],
        [0.45, 1.35, 'io'],
        [0.72, 1, 'io'],
      ]),
      key5: track([
        [0.06, 1, 'snap'],
        [0.42, 1, 'io'],
        [0.68, 0, 'io'],
      ]),
      ShockL: track([
        [0.07, 1, 'snap'],
        [0.35, 0.15, 'io'],
        [0.6, 0],
      ]),
      ShockR: track([
        [0.1, 1, 'snap'],
        [0.4, 0.15, 'io'],
        [0.65, 0],
      ]),
      ParamMouthOpenY: track([
        [0.1, 0.55, 'snap'],
        [0.5, 0.38, 'io'],
        [0.88, 0, 'io'],
      ]),
      ...browY([
        [0.1, 0.5, 'snap'],
        [0.5, 0.4, 'io'],
        [0.85, 0],
      ]),
      ParamEyeBallY: track([
        [0.2, 0.25, 'io'],
        [0.6, 0.15, 'io'],
      ]),
    },
  },
  {
    // 生气：鼓脸起伏两次（CheeckPuff 有节奏地鼓），屑屑眼 0.3s 才出来（不像开关）
    id: 'angry',
    label: '生气',
    duration: 1.45,
    curves: {
      AngleY: track([
        [0.1, 3, 'io'],
        [0.32, 13, 'out'],
        [0.95, 11.5, 'io'],
        [1.4, 0, 'io'],
      ]),
      PositionY: track([
        [0.1, -0.5, 'io'],
        [0.38, -7, 'out'],
        [0.95, -6, 'io'],
        [1.4, 0],
      ]),
      ...brows([
        [0.25, -0.65, 'out'],
        [1.0, -0.58, 'io'],
        [1.4, 0],
      ]),
      CheeckPuff: track([
        [0.35, 1, 'out'],
        [0.65, 0.92, 'io'],
        [0.85, 1, 'io'],
        [1.05, 0.95, 'io'],
        [1.4, 0],
      ]),
      key6: track([
        [0.3, 1, 'out'],
        [1.05, 1, 'io'],
        [1.4, 0],
      ]),
      ParamMouthForm: track([
        [0.35, -0.4, 'out'],
        [1.0, -0.35, 'io'],
        [1.4, 0],
      ]),
      AngleZ: track([
        [0.4, -2, 'io'],
        [0.8, 2, 'io'],
        [1.2, 0],
      ]),
    },
  },
  {
    // 困倦（打盹）：头慢慢低下去 → 猛地一下惊醒 → 又垂下去
    id: 'sleepy',
    label: '困倦',
    duration: 2.6,
    fadeIn: 0.25,
    fadeOut: 0.5,
    curves: {
      AngleY: track([
        [0.55, 4, 'io'],
        [1.25, 14, 'io'],
        [1.48, 15, 'io'],
        [1.66, 2.5, 'out'],
        [1.95, 6, 'io'],
        [2.42, 9, 'io'],
        [2.52, 3.6, 'out'],
        [2.6, 0, 'io'],
      ]),
      ...eyes([
        [0.9, 0.55, 'io'],
        [1.3, 0.12, 'io'],
        [1.5, 0.1, 'io'],
        [1.66, 0.92, 'out'],
        [2.1, 0.5, 'io'],
        [2.5, 1, 'io'],
      ]),
      PositionY: track([
        [1.24, -3, 'io'],
        [1.58, -4, 'io'],
        [1.75, -1, 'io'],
        [2.3, -2, 'io'],
        [2.6, 0],
      ]),
      ParamEyeBallY: track([
        [1.3, -0.3, 'io'],
        [1.66, 0.2, 'io'],
        [2.4, -0.1, 'io'],
      ]),
      BrowInnerUp: track([
        [1.2, 0.3, 'io'],
        [1.6, 0.1, 'io'],
        [2.4, 0.25, 'io'],
      ]),
      ParamMouthOpenY: track([
        [1.3, 0.1, 'io'],
        [1.7, 0.05, 'io'],
        [2.4, 0.08, 'io'],
      ]),
    },
  },
  {
    // 蹦一下：下蹲(预备) → 起跳 → 落地压一下 → 回弹
    id: 'hop',
    label: '蹦一下',
    duration: 0.8,
    fadeIn: 0.08,
    fadeOut: 0.2,
    curves: {
      PositionZ: track([
        [0.1, 1.5, 'io'],
        [0.24, -7, 'out'],
        [0.38, 1.2, 'io'],
        [0.48, 3.6, 'out'],
        [0.64, 0, 'io'],
        [0.71, -0.8, 'io'],
        [0.8, 0],
      ]),
      PositionY: track([
        [0.1, -3.5, 'io'],
        [0.27, 2, 'out'],
        [0.42, 0, 'io'],
        [0.54, -1.2, 'io'],
        [0.72, 0.3, 'io'],
        [0.8, 0],
      ]),
      AngleY: track([
        [0.1, 2, 'io'],
        [0.3, -4, 'out'],
        [0.55, -1, 'io'],
        [0.8, 0],
      ]),
      ...eyes([
        [0.12, 0.9, 'io'],
        [0.3, 0.85, 'io'],
        [0.55, 1, 'io'],
      ]),
      EyeSmile: track([
        [0.12, 0.55, 'out'],
        [0.5, 0.45, 'io'],
        [0.8, 0],
      ]),
      ParamMouthOpenY: track([
        [0.12, 0.3, 'out'],
        [0.45, 0.15, 'io'],
        [0.75, 0],
      ]),
      ...brows([
        [0.12, 0.3, 'out'],
        [0.5, 0.2, 'io'],
        [0.8, 0],
      ]),
    },
  },
  {
    // 被摸头：脸红 + 头往回缩 + 眯眼笑 + 歪头躲。手部动作由 TapBody 序列负责，这里不碰手。
    id: 'pat_shy',
    label: '被摸头',
    group: 'TapHead',
    duration: 1.6,
    curves: {
      key7: track([
        [0.35, 1, 'out'],
        [1.2, 1, 'io'],
        [1.55, 0],
      ]),
      AngleZ: track([
        [0.15, -3, 'io'],
        [0.45, 12, 'out'],
        [0.6, 10, 'io'],
        [1.15, 11, 'io'],
        [1.55, 0, 'io'],
      ]),
      AngleX: track([
        [0.3, 3, 'io'],
        [0.5, 6.5, 'out'],
        [1.15, 6, 'io'],
        [1.5, 0, 'io'],
      ]),
      ...eyes([
        [0.3, 0.95, 'io'],
        [0.6, 0.3, 'out'],
        [1.1, 0.35, 'io'],
        [1.45, 1, 'io'],
      ]),
      EyeSmile: track([
        [0.5, 0.55, 'out'],
        [1.1, 0.5, 'io'],
        [1.45, 0],
      ]),
      ParamMouthForm: track([
        [0.5, 0.3, 'out'],
        [1.2, 0.25, 'io'],
        [1.5, 0],
      ]),
      PositionY: track([
        [0.4, -1.8, 'io'],
        [1.15, -1.5, 'io'],
        [1.55, 0],
      ]),
      ...browY([
        [0.45, 0.2, 'io'],
        [1.2, 0.15, 'io'],
        [1.5, 0],
      ]),
    },
  },
  {
    // 探头（新）：听到动静 → 眼睛先转 → 头转过去 → 再歪一下。收尾眨眼。
    id: 'peek',
    label: '探头',
    duration: 1.3,
    curves: {
      AngleX: track([
        [0.12, -4, 'io'],
        [0.42, -16, 'out'],
        [0.55, -14, 'io'],
        [0.95, -14.5, 'io'],
        [1.28, 0, 'io'],
      ]),
      AngleZ: track([
        [0.5, 7, 'io'],
        [0.9, 6, 'io'],
        [1.28, 0],
      ]),
      ParamEyeBallX: track([
        [0.06, 0, 'lin'],
        [0.34, -0.85, 'out'],
        [0.6, -0.7, 'io'],
        [1.1, 0, 'io'],
      ]),
      // 先睁大（snap），最后收尾眨眼
      ...eyes([
        [0.05, 1.08, 'snap'],
        [0.9, 1.05, 'io'],
        [1.15, 1, 'lin'],
        [1.2, 0.35, 'out'],
        [1.28, 1, 'io'],
      ]),
      ...browY([
        [0.3, 0.38, 'out'],
        [0.95, 0.3, 'io'],
        [1.25, 0],
      ]),
      ParamMouthOpenY: track([
        [0.3, 0.12, 'io'],
        [0.95, 0.08, 'io'],
        [1.25, 0],
      ]),
      PositionX: track([
        [0.2, 0, 'lin'],
        [0.5, -1.6, 'out'],
        [1.0, -1.4, 'io'],
        [1.28, 0],
      ]),
    },
  },
  {
    // 撇嘴（新）：嘴、鼻、脸、眉一起"哼"，扭头 + 眯眼
    id: 'pout',
    label: '撇嘴',
    duration: 1.7,
    curves: {
      ParamMouthForm: track([
        [0.15, -0.12, 'io'],
        [0.5, -0.55, 'out'],
        [1.25, -0.5, 'io'],
        [1.65, 0, 'io'],
      ]),
      PoutOffsetXL: track([
        [0.5, 5, 'out'],
        [1.25, 4.5, 'io'],
        [1.65, 0],
      ]),
      PoutOffsetXR: track([
        [0.5, 5, 'out'],
        [1.25, 4.5, 'io'],
        [1.65, 0],
      ]),
      ...brows([
        [0.35, -0.4, 'out'],
        [1.25, -0.35, 'io'],
        [1.65, 0],
      ]),
      BrowInnerUp: track([
        [0.35, 0.4, 'out'],
        [1.25, 0.35, 'io'],
        [1.65, 0],
      ]),
      AngleX: track([
        [0.15, 2, 'io'],
        [0.55, 9, 'out'],
        [1.3, 8.5, 'io'],
        [1.65, 0, 'io'],
      ]),
      AngleZ: track([
        [0.6, 5, 'io'],
        [1.3, 4.5, 'io'],
        [1.65, 0],
      ]),
      // 身体比头晚 2 帧跟过去（官方第②条：脸可以快，身体不能同时到）
      PositionX: track([
        [0.22, 0, 'lin'],
        [0.62, -1.3, 'out'],
        [1.35, -1.2, 'io'],
        [1.65, 0],
      ]),
      CheeckPuff2: track([
        [0.5, 0.35, 'out'],
        [1.25, 0.3, 'io'],
        [1.65, 0],
      ]),
      ...eyes([
        [0.4, 0.8, 'io'],
        [1.3, 0.82, 'io'],
        [1.65, 1, 'io'],
      ]),
    },
  },
  {
    // 右手抬起来"勾两下食指"——专门练手指：Param43 = R 食指，RHand2 = 右手指补充，
    // RWrist = 手腕。三个都是自由参数（不是物理输出），幅度小、不会把网格拉变形。
    // 手臂链先抬后收：动作结束时手回到默认位（停在一半最容易看出畸形）。
    id: 'finger_tap',
    label: '勾手指',
    duration: 1.6,
    curves: {
      Param36: track([
        [0.12, 0, 'lin'],
        [0.34, 0.72, 'out'],
        [1.24, 0.72, 'io'],
        [1.52, 0],
      ]),
      Param39: track([
        [0.12, 0, 'lin'],
        [0.36, 0.62, 'out'],
        [1.22, 0.62, 'io'],
        [1.5, 0],
      ]),
      Param41: track([
        [0.16, 0, 'lin'],
        [0.4, 0.07, 'out'],
        [1.18, 0.07, 'io'],
        [1.46, 0],
      ]),
      Param42: track([
        [0.18, 0, 'lin'],
        [0.42, 0.06, 'out'],
        [1.16, 0.06, 'io'],
        [1.44, 0],
      ]),
      // 食指两下：压 0.9、松回 -0.35，第二下稍轻
      Param43: track([
        [0.5, 0, 'lin'],
        [0.66, 0.9, 'out'],
        [0.82, -0.35, 'in'],
        [1.0, 0.8, 'out'],
        [1.14, -0.2, 'in'],
        [1.3, 0, 'io'],
      ]),
      RHand2: track([
        [0.5, 0, 'lin'],
        [0.7, 0.35, 'out'],
        [0.9, 0.05, 'in'],
        [1.06, 0.3, 'out'],
        [1.3, 0],
      ]),
      RWrist: track([
        [0.44, 0, 'lin'],
        [0.62, 0.45, 'out'],
        [0.86, 0.05, 'io'],
        [1.04, 0.38, 'out'],
        [1.3, 0],
      ]),
      ...eyes([
        [0.3, 1, 'lin'],
        [0.5, 0.72, 'out'],
        [0.95, 0.7, 'io'],
        [1.3, 1, 'io'],
      ]),
    },
  },
]

/** 每个手势落到哪个动作组（默认 Gesture） */
export function gestureGroup(g) {
  return g.group ?? 'Gesture'
}

export const MOTION_DIR = 'motions'
export function gestureFile(g) {
  return `${g.id}.motion3.json`
}
