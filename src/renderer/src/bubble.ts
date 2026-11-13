import type { Live2DSprite } from 'easy-live2d'
/** 与 preload/index.d.ts 的 ChatEvent 保持一致（渲染层不跨目录引 .d.ts） */
type ChatEvent =
  | { t: 'delta'; text: string }
  | { t: 'segment'; text: string }
  | { t: 'emotion'; emotion: string }
  | { t: 'motion'; group: string; no?: number }
  | { t: 'done'; full: string }
  | { t: 'error'; message: string; recoverable: boolean }
  | { t: 'state'; v: 'thinking' | 'speaking' | 'idle' | 'interrupted' }

/**
 * M2 气泡：把"大脑吐出来的字"变成看得见的东西。
 *
 * 三个状态要能一眼看出来（规划 §5.4）：
 *   thinking  → 「加载」表情 + 气泡里三个点
 *   speaking  → 文字逐字长出来 + 口型跟着抖
 *   idle      → 口型归零，文字留着（她说的话不该自己消失）
 */

export interface BubbleHost {
  sprite: Live2DSprite
  log: (msg: string) => void
  /** 聊天时在窗口上方腾出 px 高的气泡区（角色不缩小，只往下让位） */
  setTopSpace: (px: number) => void
}

const BUBBLE_SPACE = 120

export interface Bubble {
  open: () => void
  close: () => void
  toggle: () => void
  isOpen: () => boolean
  isBusy: () => boolean
  send: (text: string) => Promise<void>
  /** 她自己说一句（不经过大脑）：显示 ms 毫秒后自己收起。返回 false = 现在接不了 */
  say: (text: string, ms?: number) => boolean
  interrupt: () => void
  handleEvent: (ev: ChatEvent) => void
  dispose: () => void
}

// 注意：这里要填 model3 里的 ascii 表情 id，不是规划里的情绪名
// （情绪 → 表情的映射见规划 §5.5：confused→圈圈眼 dizzy，annoyed→屑屑眼 sneer）
const THINKING_FACE = 'loading'
const INTERRUPT_FACE = 'sneer'
const ERROR_FACE = 'dizzy'

export function createBubble({ sprite, log, setTopSpace }: BubbleHost): Bubble {
  const bubble = document.getElementById('bubble') as HTMLDivElement | null
  const textEl = document.getElementById('bubble-text') as HTMLDivElement | null
  const metaEl = document.getElementById('bubble-meta') as HTMLDivElement | null
  const bar = document.getElementById('chatbar') as HTMLFormElement | null
  const input = document.getElementById('chat-input') as HTMLInputElement | null
  if (!bubble || !textEl || !metaEl || !bar || !input) {
    throw new Error('气泡 DOM 缺失（index.html 里的 #bubble / #chatbar）')
  }

  let opened = false
  let busy = false
  let lastError = ''
  let gotFirstDelta = false
  // 打断之后，服务端可能还有几帧已经出队的 delta 在路上（远程尤其明显：
  // 按 Esc 后文字还会自己涨一小段，看着像"没打断"）。这里把它们丢掉。
  let muted = false
  let mouthRaf = 0
  let restoreTimer = 0

  const setFace = (id: string): void => {
    try {
      sprite.setExpression({ expressionId: id })
    } catch (err) {
      log(`表情 ${id} 设置失败：${String(err)}`)
    }
  }

  const flashFace = (id: string, ms: number): void => {
    setFace(id)
    if (restoreTimer) window.clearTimeout(restoreTimer)
    restoreTimer = window.setTimeout(() => setFace('default'), ms)
  }

  const startMouth = (): void => {
    if (mouthRaf) return
    const t0 = performance.now()
    const tick = (): void => {
      const t = (performance.now() - t0) / 1000
      // 两个不通约的正弦叠一起，听感上像在说话，而不是机械抖动
      const v = 0.12 + 0.5 * Math.abs(Math.sin(t * 9.1)) * (0.7 + 0.3 * Math.sin(t * 2.3))
      sprite.setParameterValueById('ParamMouthOpenY', v, 1)
      mouthRaf = requestAnimationFrame(tick)
    }
    mouthRaf = requestAnimationFrame(tick)
  }

  const stopMouth = (): void => {
    if (mouthRaf) {
      cancelAnimationFrame(mouthRaf)
      mouthRaf = 0
    }
    sprite.setParameterValueById('ParamMouthOpenY', 0, 1)
  }

  const setText = (t: string): void => {
    textEl.textContent = t
    bubble.hidden = false
    bubble.classList.toggle('empty', t.length === 0)
  }

  const setMeta = (t: string): void => {
    metaEl.textContent = t
    metaEl.hidden = t.length === 0
    // 有 meta（错误/思考提示）时不要同时显示"●●●"占位
    bubble.classList.toggle('has-meta', t.length > 0)
  }

  const open = (): void => {
    opened = true
    if (toastTimer) {
      window.clearTimeout(toastTimer)
      toastTimer = 0
    }
    bubble.hidden = false
    bar.hidden = false
    setTopSpace(BUBBLE_SPACE)
    document.getElementById('hint')?.classList.remove('show')
    input.focus()
    log('聊天框已打开')
  }

  const close = (): void => {
    opened = false
    input.value = ''
    bar.hidden = true
    if (!busy) {
      bubble.hidden = true
      setMeta('')
      setTopSpace(0)
    }
    log('聊天框已关闭')
  }

  const toggle = (): void => {
    if (opened) close()
    else open()
  }

  const send = async (raw: string): Promise<void> => {
    const text = raw.trim()
    if (!text) return
    if (busy) {
      log('上一句还没说完，先打断')
      interrupt()
      return
    }
    busy = true
    gotFirstDelta = false
    lastError = ''
    muted = false
    setText('')
    setMeta('思考中…')
    setFace(THINKING_FACE)
    input.value = ''
    try {
      const res = await window.pet.chat(text)
      if (!res.ok) {
        setMeta(res.reason === 'busy' ? '她还在说上一句' : '没发出去')
        busy = false
        stopMouth()
      }
    } catch (err) {
      setMeta(`发送失败：${String(err)}`)
      busy = false
      stopMouth()
      flashFace(ERROR_FACE, 1200)
    }
  }

  const handleEvent = (ev: ChatEvent): void => {
    switch (ev.t) {
      case 'state':
        if (ev.v === 'thinking') {
          busy = true
          setMeta('思考中…')
          setFace(THINKING_FACE)
        } else if (ev.v === 'speaking') {
          setMeta('')
          setFace('default')
        } else if (ev.v === 'idle') {
          busy = false
          gotFirstDelta = false
          if (!lastError) setMeta('')
          stopMouth()
          window.setTimeout(() => {
            if (!busy) stopMouth()
          }, 260)
        } else if (ev.v === 'interrupted') {
          busy = false
          muted = true
          setMeta('（被打断）')
          stopMouth()
          flashFace(INTERRUPT_FACE, 1000)
        }
        break
      case 'delta': {
        if (muted) break
        if (!gotFirstDelta) {
          gotFirstDelta = true
          startMouth()
        }
        bubble.hidden = false
        setText((textEl.textContent ?? '') + ev.text)
        break
      }
      case 'segment':
        if (muted) break
        setText(ev.text)
        break
      case 'done':
        if (muted) break
        if (ev.full) setText(ev.full)
        break
      case 'error':
        lastError = ev.message
        setMeta(`没连上她的大脑：${ev.message}`)
        busy = false
        stopMouth()
        flashFace(ERROR_FACE, 1400)
        break
      default:
        break
    }
  }

  bar.addEventListener('submit', (e) => {
    e.preventDefault()
    void send(input.value)
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (busy) {
        interrupt()
      } else close()
    }
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busy && !opened) {
      interrupt()
    }
  })

  const interrupt = (): void => {
    muted = true
    void window.pet.interrupt()
  }

  // —— 她自己开口：气泡里放一句话，不经过聊天框 ——
  let toastTimer = 0
  const say = (text: string, ms = 7000): boolean => {
    if (opened || busy) return false
    setText(text)
    setMeta('')
    bubble.hidden = false
    bar.hidden = true
    setTopSpace(BUBBLE_SPACE)
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toastTimer = 0
      if (opened || busy) return
      setText('')
      bubble.hidden = true
      setTopSpace(0)
    }, ms)
    return true
  }

  return {
    open,
    close,
    toggle,
    isOpen: () => opened,
    isBusy: () => busy,
    send,
    say,
    interrupt,
    handleEvent,
    dispose(): void {
      stopMouth()
      if (restoreTimer) window.clearTimeout(restoreTimer)
      if (toastTimer) window.clearTimeout(toastTimer)
    }
  }
}
