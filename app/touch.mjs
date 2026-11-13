/**
 * 触摸层：把手势（tap / rapid / hold / stroke）翻译成「动作 + 表情 + 一句台词」。
 *
 * 设计边界：
 *   - 不碰渲染细节，只产出 action 对象，由 renderer 执行（motion / face / pose）
 *   - 不决定「能不能摸」——没有等级门槛；只有「同一处刚摸过」的冷却，防止刷屏
 *   - 台词按心情给变体（tone 由 mood.toneOf 决定），每句都能不带标记
 *
 * 原桌宠已有的 tap / pet 逻辑仍在 renderer 里（用 DEFAULT_REACTIONS），
 * 这一层只补它没有的：连点、长按、头发区、以及跨区域连点彩蛋。
 */

export const RAPID_WINDOW = 1300
export const HOLD_MS = 1200
const COOLDOWN = {
  头发: 1500, 头: 1200, 额头: 1500, 左脸: 1600, 右脸: 1600,
  左手: 1500, 右手: 1500, 胸: 3000, 腰: 2000, 裙摆: 3000,
  腿: 2000, 脚: 2000, 尾巴: 2000, 胯: 1600,
}

/** 每个动作：{motion, face, pose, say:[tone → 句子]} */
const R = (o) => o

/** 区域 → 手势 → 动作 */
export const TOUCH_RULES = {
  头发: {
    tap: R({ motion: 'tilt', say: { plain: ['头发要乱啦。'], joy: ['嗯……再摸摸也行。'] } }),
    stroke: R({ motion: 'pat_shy', face: 'expr_blush', say: { plain: ['这样捋下去会睡着的。'], shy: ['……别顺着摸。'] } }),
    hold: R({ motion: 'look_around', say: { plain: ['头上没有东西。'], sleepy: ['困……别按我头。'] } }),
    rapid: R({ motion: 'shake', face: 'expr_sweat', say: { plain: ['别当本鲸是猫。'], irk: ['够了。'] } }),
  },
  头: {
    hold: R({ motion: 'look_around', say: { plain: ['手拿开，看不见了。'], joy: ['往下一点。'] } }),
    rapid5: R({ motion: 'hop', face: 'expr_heart', say: { plain: ['好啦好啦，本鲸知道你喜欢我。'], shy: ['……差不多得了。'] } }),
    rapid8: R({ motion: 'dizzy', face: 'expr_dizzy', say: { plain: ['慢点——鱼鱼要转圈了。'], irk: ['再点我要咬人了。'] } }),
  },
  胸: {
    rapid: R({ motion: 'angry', face: 'expr_sneer', say: { plain: ['喂！'], irk: ['手，放哪儿呢。'] } }),
    hold: R({ motion: 'shake', face: 'expr_blackface', say: { plain: ['本鲸数到三。'], irk: ['一。'] } }),
  },
  腰: {
    rapid: R({ motion: 'hop', face: 'expr_sneer', say: { plain: ['别挠了！'], joy: ['哈哈哈别……'] } }),
    hold: R({ motion: 'pout', say: { plain: ['放开。'], irk: ['别架着。'] } }),
  },
  裙摆: {
    rapid: R({ motion: 'angry', face: 'expr_blackface', say: { plain: ['你是故意的吧。'], irk: ['再说一遍试试。'] } }),
    hold: R({ motion: 'shake', say: { plain: ['本鲸要生气了。'], irk: ['放开。'] } }),
  },
  腿: {
    rapid: R({ motion: 'pout', face: 'expr_sweat', say: { plain: ['别戳了，站不稳。'] } }),
    hold: R({ motion: 'tilt', face: 'expr_blush', say: { plain: ['……你到底想干嘛。'] } }),
  },
  脚: {
    rapid: R({ motion: 'shake', face: 'expr_sneer', say: { plain: ['踩到你的鼠标。'], joy: ['痒！哈哈哈……'] } }),
    hold: R({ motion: 'pout', say: { plain: ['不许碰脚。'] } }),
  },
  左手: {
    hold: R({ motion: 'hand_up', face: 'expr_blush', say: { plain: ['……牵着吧。'], shy: ['就一会儿。'] } }),
    rapid: R({ motion: 'hand_down', say: { plain: ['打你。'] } }),
  },
  右手: {
    hold: R({ motion: 'hand_up', face: 'expr_blush', say: { plain: ['……牵着吧。'], shy: ['就一会儿。'] } }),
    rapid: R({ motion: 'hand_down', say: { plain: ['打你。'] } }),
  },
  尾巴: {
    rapid: R({ motion: 'shake', face: 'expr_angry', say: { plain: ['尾巴不能一直抓。'], irk: ['松手。'] } }),
    hold: R({ motion: 'escape', face: 'expr_surprise', say: { plain: ['……本鲸先走了。'], irk: ['别拽。'] } }),
  },
  胯: {
    // 永远可以碰，只是每摸一次话说得更重（不设上限、不接服务器）
    tap: R({ pose: '护胯', face: 'expr_blackface', say: { plain: ['变态。'] } }),
    rapid: R({ pose: '护胯', face: 'expr_blackface', say: { plain: ['……你还真敢。'], irk: ['你还来。'] } }),
    hold: R({ pose: '护胯', face: 'expr_blackface', say: { plain: ['手拿开。'], irk: ['听见没有。'] } }),
  },
}

/** 胯：按「今天第几次」逐级加重。永远可以碰，只是话说得越来越重。 */
export const CROTCH_TIERS = [
  { min: 1, lines: ['变态。', '你是变态吗？', '你手放哪儿呢。'] },
  { min: 2, lines: ['……你还真敢。', '别碰那里！', '手。', '别装无辜。'] },
  { min: 4, lines: ['我真得哈气了……', '手、手拿开啦。', '本鲸记着了。', '你怎么还来。'] },
  { min: 7, lines: ['再摸就咬你了。', '……本鲸都懒得说了。', '真的变态。'] },
  { min: 12, lines: ['……随你吧。', '本鲸已经不想说话了。'] },
]

export function crotchLine(count) {
  const tier = CROTCH_TIERS.filter((t) => count >= t.min).pop() || CROTCH_TIERS[0]
  return tier.lines[Math.floor(Math.random() * tier.lines.length)]
}

/** 跨区连点彩蛋 */
export const COMBO = {
  global5: R({ motion: 'hop', face: 'expr_heart', say: { plain: ['好啦好啦。'], joy: ['知道你喜欢我啦。'] } }),
  global8: R({ motion: 'dizzy', face: 'expr_dizzy', say: { plain: ['鱼鱼要转圈了。'] } }),
}

function pickTone(lineMap, tone) {
  if (!lineMap) return null
  const arr = lineMap[tone] || lineMap.plain || Object.values(lineMap)[0]
  if (!arr || !arr.length) return null
  return arr[Math.floor(Math.random() * arr.length)]
}

export function createTouch({ mood, dayLog, play, say, isBusy = () => false } = {}) {
  let lastTapAt = 0
  let tapCount = 0
  let lastZone = ''
  let press = null
  let holdTimer = 0
  const cooldownAt = {}
  // 从当天记录里接着数（不然每次重启她的耐心都回到「第一次」）
  let crotchToday = Number(dayLog?.summary?.()?.zones?.['胯'] || 0)
  let crotchDay = ''

  function resetCrotchIfNewDay() {
    const d = new Date()
    const k = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    if (k !== crotchDay) { crotchDay = k; crotchToday = 0 }
  }

  /** 胯：每摸一次记一笔，台词按今天第几次逐级加重（不设上限、永远可以碰） */
  function crotchAction() {
    resetCrotchIfNewDay()
    crotchToday += 1
    return { ...TOUCH_RULES.胯.tap, gesture: 'tap', say: { plain: [crotchLine(crotchToday)] } }
  }

  function emit(zone, action, toneHint, opts = {}) {
    if (!action) return false
    const now = opts.now ?? Date.now()
    // 连点计数发生在冷却之前；只有「真正演一个反应」才受冷却限制。
    // 否则 8 连点这种彩蛋会在第 2 下就被冷却挡死，永远到不了 5 / 8。
    if (!opts.bypassCooldown && now - (cooldownAt[zone] || 0) < (COOLDOWN[zone] || 1500)) return false
    cooldownAt[zone] = now
    if (play) play({ motion: action.motion, face: action.face, pose: action.pose })
    const text = pickTone(action.say, toneHint)
    if (text && say) say(text, 2600)
    if (mood && mood.apply) mood.apply({ kind: 'touch', zone, gesture: action.gesture || 'tap' })
    return true
  }

  return {
    /** ev: { type, name } 来自 region input */
    event(ev, toneHint = 'plain') {
      const zone = ev?.name
      const type = ev?.type
      if (!zone) return false
      const rules = TOUCH_RULES[zone]
      const now = Date.now()

      if (type === 'down') {
        press = { zone, at: now }
        clearTimeout(holdTimer)
        const holdRule = rules?.hold
        if (holdRule) {
          holdTimer = setTimeout(() => {
            if (!press) return
            if (dayLog && dayLog.add) dayLog.add(zone)
            emit(zone, { ...holdRule, gesture: 'hold' }, toneHint)
            press = null
          }, HOLD_MS)
        }
        return false
      }

      if (type === 'up') {
        clearTimeout(holdTimer)
        press = null
        return false
      }

      if (type === 'tap') {
        // 连点计数：同一区、1.3s 内
        if (zone === lastZone && now - lastTapAt <= RAPID_WINDOW) tapCount += 1
        else { tapCount = 1; lastZone = zone }
        lastTapAt = now

        // 今天被摸了几次：每一下都算，不看反应有没有被冷却挡掉
        if (dayLog && dayLog.add) dayLog.add(zone)
        if (zone === '胯') return emit(zone, crotchAction(), toneHint, { now })
        const opts = { now }
        if (tapCount === 5 && rules?.rapid5) return emit(zone, { ...COMBO.global5, gesture: 'rapid' }, toneHint, { ...opts, bypassCooldown: true })
        if (tapCount === 8 && rules?.rapid8) return emit(zone, { ...COMBO.global8, gesture: 'rapid' }, toneHint, { ...opts, bypassCooldown: true })
        if (tapCount >= 3 && rules?.rapid) return emit(zone, { ...rules.rapid, gesture: 'rapid' }, toneHint, opts)
        if (tapCount === 1 && rules?.tap) return emit(zone, { ...rules.tap, gesture: 'tap' }, toneHint, opts)
        return false
      }

      if (type === 'pet' && (ev.step === 1 || ev.step === undefined)) {
        if (dayLog && dayLog.add) dayLog.add(zone)
        // 真实交互里摸（拖）出来的事件是 pet/step 1，不是 tap —— 胯必须两种都接住，
        // 否则会落到 renderer 里那套旧台词（"你是变态吗？"），看起来像没改一样。
        if (zone === '胯') return emit(zone, crotchAction(), toneHint, { now })
        if (rules?.stroke) return emit(zone, { ...rules.stroke, gesture: 'stroke' }, toneHint)
      }
      return false
    },
    get cooldown() { return { ...cooldownAt } },
    resetCrotch() { crotchToday = 0 },
  }
}
