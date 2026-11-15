/**
 * 对话气泡（DOM 浮层）。
 *
 * 位置与尺寸都按「漫画式短句气泡」定：
 *   - 贴在头的左上/右上外角（设置里可切），不压脸；
 *   - 短句用大字（20px 起），字多一点逐档降到 14px，框最宽约 250px；
 *   - 只在极端长文本时才长高/滚动（正常走 phrases.js 的预设短句，不该触发）。
 *
 * 气泡只负责「显示」，说什么由调用方（phrases.js / agent-link）决定。
 */

import { pickPhrase } from './phrases.js'

const FONT_STEPS = [
  [12, 20],   // ≤12 字：20px（漫画泡泡的「大字」档）
  [26, 18],
  [48, 16],
  [90, 15],
  [Infinity, 14],
]

export function createBubble({ el, anchor, side = 'right', corner = false, onSpeak = null }) {
  if (!el) throw new Error('bubble: 缺少容器')
  el.classList.add('bubble')
  let visible = false
  let lastText = ''
  let lastKey = ''
  let hideTimer = 0
  let anchorSide = side === 'left' ? 'left' : 'right'
  // 气泡占用锁：agent 在干活时锁住，别的来源（待机台词 / 互动台词 / 外部 say）说不进去
  let lockOwner = null
  // 粘住：agent 说的话（橙色）显示期间，别的来源（本地台词 / 互动）一律不许顶掉它。
  // 只有它自己 hide()（用户看完/自动收起）或下一条 agent 消息才能换掉。
  let stickyOwner = null
  // 与窗口/角色同一比例：窗口变大，气泡的字号、内边距、尾巴一起变大
  let scale = 1
  el.style.setProperty('--bs', '1')
  // 表情包配图：AI 发图时由 renderer 传 /api/meme/<名>，图在上、字在下
  let lastImage = ''
  const imgEl = document.createElement('img')
  imgEl.className = 'bubble-img'
  imgEl.alt = ''
  imgEl.draggable = false
  imgEl.addEventListener('load', () => { if (visible) { layout(lastText); place() } })

  // ---- 内部结构（样式全在 style.css 的 #bubble .b-* 里）----
  //   ✦ 装饰 / 名称行（爱心 + 名称 + 情绪标签）/ 正文 / 三颗鱼泡尾
  // 卡片"皮肤"单独一层：这样入场时可以只让框和文字浮现、尾巴的小泡先冒出来
  const skinEl = document.createElement('span')
  skinEl.className = 'b-skin'
  const decoEl = document.createElement('span')
  decoEl.className = 'b-deco'
  const headEl = document.createElement('span')
  headEl.className = 'b-head'
  const markEl = document.createElement('span')
  markEl.className = 'b-mark'
  markEl.textContent = '♡'
  const nameEl = document.createElement('span')
  nameEl.className = 'b-name'
  const tagEl = document.createElement('span')
  tagEl.className = 'b-tag'
  headEl.append(markEl, nameEl, tagEl)
  const bodyEl = document.createElement('span')
  bodyEl.className = 'b-body'
  const strEl = document.createElement('span')
  strEl.className = 'b-str'
  bodyEl.append(imgEl, strEl)
  const tailEl = document.createElement('span')
  tailEl.className = 'b-tail'
  tailEl.append(document.createElement('i'), document.createElement('i'), document.createElement('i'))
  el.append(skinEl, decoEl, headEl, bodyEl, tailEl)

  // 出处：her = 她自己说的（粉） / script = 模板台词（蓝） / system = 系统态（灰）
  const SYS_STATES = new Set(['thinking', 'working', 'waiting', 'success', 'error'])
  const MOOD_TAG = { joy: '开心', shy: '害羞', irk: '不爽', sleepy: '困', missing: '惦记', clingy: '黏人', bored: '闲着' }
  const MOOD_DECO = { joy: '♡', shy: '❀', irk: '✧', sleepy: 'Zzz', missing: '·', clingy: '♡', bored: '·' }
  let petName = '大肥鱼'

  const inferSrc = (st) => (!st ? 'her' : SYS_STATES.has(st) ? 'system' : st === 'chat' || st === 'proactive' ? 'her' : 'script')

  /** 按出处 + 情绪刷名称行/标签/装饰；文字长短决定名称行出不出 */
  function applyMeta({ src, mood, strength, name } = {}) {
    const kind = src || inferSrc(el.dataset.state)
    const s = Math.max(0, Math.min(1, Number(strength) || 0))
    const key = mood && MOOD_TAG[mood] ? mood : ''
    el.dataset.src = kind
    el.dataset.strength = s >= 0.66 ? 'high' : s >= 0.33 ? 'mid' : 'low'
    if (key) el.dataset.mood = key
    else delete el.dataset.mood
    if (name) petName = String(name)

    const len = Array.from(lastText).length
    // 名称行：只在她自己说话、且是长句时署名（短句和模板台词不署名）
    const showHead = kind === 'her' && len > 18
    headEl.hidden = !showHead
    if (showHead) nameEl.textContent = petName

    // 情绪标签/装饰：她说话时中档就出；模板台词要强档才出（不假装有情绪）
    const need = kind === 'her' ? 0.33 : 0.66
    const on = !!key && s >= need
    tagEl.hidden = !on
    if (on) tagEl.textContent = MOOD_TAG[key]
    decoEl.hidden = !on
    if (on) {
      decoEl.textContent = MOOD_DECO[key] || '✦'
      // 换一个 data-k 让它重新闪一次（CSS 用 animation，不循环）
      decoEl.dataset.k = String(Date.now())
    }
  }

  const viewport = () => ({ w: window.innerWidth, h: window.innerHeight })

  /** 按字数选字号 */
  const fontFor = (len) => {
    for (const [max, px] of FONT_STEPS) if (len <= max) return px
    return 13
  }

  /**
   * 排版：紧凑漫画泡泡。宽度上限按窗口窄算（≈250px），字号按字数降档；
   * 只在极端长文本时才让它长高/滚动 —— 正常走预设短句，不该出现滚动。
   */
  function layout(text) {
    const vp = viewport()
    // 长文要给得下：原来只留窗口高的 26%，一百字得滚好几屏
    const maxH = Math.max(120 * scale, vp.h * 0.4)
    el.style.maxWidth = `${Math.round(Math.min(268 * scale, vp.w * 0.62))}px`
    el.style.maxHeight = `${Math.round(maxH)}px`

    const len = Array.from(text).length
    let fs = Math.round(fontFor(len) * scale * 10) / 10
    el.style.fontSize = `${fs}px`
    el.style.overflowY = 'visible'
    el.style.height = 'auto'

    // 极长文本兜底（预设短句一般到不了这里）
    let guard = 0
    const floor = 13 * scale
    while (el.scrollHeight > maxH && fs > floor && guard++ < 8) {
      fs = Math.round((fs - 1) * 10) / 10
      el.style.fontSize = `${fs}px`
    }
    el.classList.toggle('scrollable', el.scrollHeight > maxH)
    if (el.scrollHeight > maxH) {
      el.style.height = `${Math.round(maxH)}px`
      el.style.overflowY = 'auto'
    }
    return { fs, maxH }
  }

  /**
   * 漫画式定位：泡泡贴在「头的右上方 / 左上方」外角，不压脸。
   *   右侧：左边缘落在头的 right 外一点点；左侧镜像。
   * 放不下自动翻边；顶部空间不够就往头侧下方挪。
   */
  function place() {
    const a = anchor?.()
    const vp = viewport()
    const w = el.offsetWidth || 200
    let h = el.offsetHeight || 60
    let side = anchorSide
    let x, y
    if (corner) {
      // 默认形态：贴窗口右上角（选左侧就贴左上角）。
      // 留白按窗口高度给（约 2.5%），窗框收窄后气泡跟着往里、不贴边。
      const PAD = Math.round(Math.max(10, vp.h * 0.025))
      x = side === 'right' ? vp.w - w - PAD : PAD
      y = PAD
    } else if (a) {
      // 用户定的规则：永远挂在头顶正中，不往两侧摆。
      // 头顶真放不下时只做两件事——缩字号、必要时内部滚动，绝不压脸、也不去两侧。
      side = 'center'
      x = (a.left + a.right) / 2 - w / 2
      y = a.top - h - 22
      if (y < 6) {
        const room = Math.round(vp.h * 0.38)
        let fs = parseFloat(el.style.fontSize) || 14
        let guard = 0
        while (el.scrollHeight > room && fs > 11 && guard++ < 8) {
          fs = Math.max(11, Math.round((fs - 1) * 10) / 10)
          el.style.fontSize = `${fs}px`
        }
        if (el.scrollHeight > room) {
          el.style.maxHeight = `${Math.round(room)}px`
          el.style.overflowY = 'auto'
          el.classList.add('scrollable')
        } else {
          el.style.maxHeight = ''
          el.style.overflowY = 'visible'
          el.classList.remove('scrollable')
        }
        h = el.offsetHeight || h
        y = Math.max(6, a.top - h - 22)
      }
    } else {
      x = vp.w / 2 - w / 2
      y = vp.h * 0.16
    }
    x = Math.max(6, Math.min(vp.w - w - 6, x))
    y = Math.max(6, Math.min(vp.h - h - 6, y))
    el.style.left = `${Math.round(x)}px`
    el.style.top = `${Math.round(y)}px`
    el.dataset.anchor = corner ? `corner-${side}` : side
    // 尾巴点点的方向：点点要指向角色。
    //   贴角模式：气泡在窗口顶部、角色在下面 → 点点朝下（above = 点点在气泡底边外侧）
    //   跟随模式：按气泡在头顶上方还是下方决定
    el.dataset.side = (corner || (a && y + h + 2 <= a.top)) ? 'above' : 'below'
    // 气泡被顶到窗口最上沿时，尾巴朝上会被裁掉；这时把点点翻到下面（指向角色）
    if (el.dataset.side === 'below' && y < 22) el.dataset.side = 'above'
  }

  return {
    /** 换文字（不闪不重建）；state 用来染色：thinking / working / waiting / success / error */
    set(text, { state: st, image, src, mood, strength, name } = {}) {
      const t = String(text ?? '')
      // st = undefined 表示"这次不改状态"；st = null 表示"清掉状态色"（普通回话要把主动开口的淡青底还原）
      if (st !== undefined) {
        if (st) el.dataset.state = st
        else delete el.dataset.state
      }
      const img = image === undefined ? lastImage : String(image || '')
      const same = t === lastText && img === lastImage
      lastText = t
      lastImage = img
      if (!same) {
        strEl.textContent = t
        if (lastImage) {
          if (imgEl.getAttribute('src') !== lastImage) imgEl.src = lastImage
          imgEl.hidden = false
        } else {
          imgEl.hidden = true
        }
        el.classList.toggle('empty', t.length === 0 && !lastImage)
        // 短句居中、长句左对齐（CSS 用 [data-len="long"] 切）
        el.dataset.len = Array.from(t).length > 18 ? 'long' : 'short'
      }
      applyMeta({ src, mood, strength, name })
      if (visible) { layout(t); place() }
    },
    show(text, opts = {}) {
      // force：唤醒这类「必须先让她应一声」的场合，允许越过锁与粘住。
      // 只给唤醒用——其他本地台词没有这个豁免，免得又把 agent 的进度顶掉。
      if (!opts.force) {
        // 被锁住时：只有锁的主人能改字（防止待机台词 / 互动台词把 agent 的进度顶掉）
        if (lockOwner && opts.owner !== lockOwner) return
        // 粘住的台词同理：她还在说话/刚说完还没收起，本地台词不许抢
        if (stickyOwner && opts.owner !== stickyOwner) return
      }
      if (opts.force) { lockOwner = ''; stickyOwner = '' }
      if (opts.sticky) stickyOwner = opts.owner || 'agent'
      // 只在「新一条」时播入场动画：隐藏→出现，或状态变了（thinking → chat）。
      // 流式逐字会同一状态反复 show，不能每次都让气泡重播。
      const wasVisible = visible
      const prevState = el.dataset.state || ''
      const changed = text != null && String(text) !== lastText
      if (text != null) this.set(text, opts)
      visible = true
      el.classList.add('on')
      // 入场顺序：先让尾巴的小泡从下往上冒，最后大气泡框浮现（见 style.css 里 230ms 的延迟）。
      const fresh = !wasVisible || (opts.state && opts.state !== prevState)
      if (fresh) {
        el.classList.remove('tail-in')
        void el.offsetWidth
        el.classList.add('tail-in')
        // 大气泡框最后浮现：先等尾巴三颗泡冒完（230ms），再用 260ms 弹进来。
        // 用内联 transition 而不是 keyframes —— 情绪动效同样占着这个元素的 transform，
        // 两套 animation 会互相顶掉（试过，框会立刻弹出来）。
        const EASE = 'cubic-bezier(.34, 1.2, .64, 1)'
        const parts = [skinEl, decoEl, headEl, bodyEl]
        for (const n of parts) {
          n.style.transition = 'none'
          n.style.opacity = '0'
        }
        skinEl.style.scale = '0.94'
        // 角标的「闪一次」也是 CSS animation，会盖掉内联 opacity —— 入场这一刻先按住
        decoEl.style.animation = 'none'
        requestAnimationFrame(() => {
          for (const n of parts) {
            n.style.transition = `opacity 260ms ${EASE} 230ms, scale 260ms ${EASE} 230ms`
            n.style.opacity = '1'
            n.style.scale = '1'
            setTimeout(() => {
              n.style.transition = ''
              n.style.opacity = ''
              n.style.scale = ''
              if (n === decoEl) n.style.animation = ''
            }, 760)
          }
        })
      }
      layout(lastText)
      place()
      // 冒泡时让她动嘴：按字数估一个时长（含标点停顿），看起来像在念这句话
      if (changed && lastText) {
        try { onSpeak?.(lastText) } catch {}
      }
      // 量完再定一次位（首帧字号还没生效时高度会差一点）
      requestAnimationFrame(() => { if (visible) place() })
    },
    hide() {
      visible = false
      stickyOwner = null
      el.classList.remove('on')
      // 气泡收起来就闭嘴，别让嘴一直动
      try { onSpeak?.(null) } catch {}
    },
    /** 说一句预设台词（key 见 phrases.js：thinking / working / waiting / success / error / head / hand …） */
    say(key, { ms = 0, owner = null } = {}) {
      if (lockOwner && owner !== lockOwner) return null
      const line = pickPhrase(key, lastKey === key ? lastText : '')
      lastKey = key
      this.show(line, { state: key, owner, src: 'script' })
      if (ms > 0) {
        clearTimeout(hideTimer)
        hideTimer = setTimeout(() => { if (lastKey === key) this.hide() }, ms)
      }
      return line
    },
    /** 占用气泡（agent 干活期间）：别人说不进来，直到 unlock */
    // 默认「不抢占」：干活期间 agent 占着锁时，用户开口要用 force 才能夺过来
    lock(owner = 'agent', { force = false } = {}) {
      if (force || !lockOwner || lockOwner === owner) lockOwner = owner
    },
    unlock(owner = 'agent') { if (lockOwner && owner === lockOwner) lockOwner = null },
    get locked() { return lockOwner },
    get sticky() { return stickyOwner },
    /** 设置里改名/改风格时同步（现在只用到 name） */
    configure(next = {}) {
      if (next.name) petName = String(next.name)
      applyMeta({})
      if (visible) { layout(lastText); place() }
    },
    /** 位置依赖角色位置，角色一动（拖窗口/换尺寸）就重排 */
    reposition() { if (visible) place() },
    /** 挂在头的左侧还是右侧（设置里可切） */
    setSide(s) {
      anchorSide = s === 'left' ? 'left' : 'right'
      if (visible) place()
    },
    /** 与窗口/角色联动的比例（窗口缩放时由 renderer 调用） */
    setScale(s) {
      const next = Math.min(2.5, Math.max(0.4, Number(s) || 1))
      if (Math.abs(next - scale) < 0.002) return
      scale = next
      el.style.setProperty('--bs', String(scale))
      if (visible) { layout(lastText); place() }
    },
    get scale() { return scale },
    get side() { return anchorSide },
    get visible() { return visible },
    get text() { return lastText },
    state() { return { visible, text: lastText, state: el.dataset.state ?? null, src: el.dataset.src ?? null, mood: el.dataset.mood ?? null, strength: el.dataset.strength ?? null, name: petName, w: el.offsetWidth, h: el.offsetHeight, fs: parseFloat(el.style.fontSize) || 0, scroll: el.style.overflowY === 'auto' } },
  }
}
