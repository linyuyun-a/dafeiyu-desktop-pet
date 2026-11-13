// 对话记录窗口：只读展示 + 搜索 + 导出 / 清空。
// 数据来自主进程（读 stage-chat.jsonl），这里不写任何文件。
const list = document.getElementById('list')
const emptyEl = document.getElementById('empty')
const countEl = document.getElementById('count')
const qEl = document.getElementById('q')
const olderBtn = document.getElementById('btn-older')

const PAGE = 200
const state = { items: [], hasMore: false, query: '' }

// 记录里存的是原文（含 [[act:…]] / [[wear:…]] 标记），展示前剥掉——她说的和画面上看到的要一致。
const clean = (t) => {
  let out = String(t || '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<\/?(?:sup|cite|ref)[^>]*>/gi, '')
  // 来源行整行删掉（她嘴里不该出现网址）
  out = out
    .replace(/^(?:来源|参考资料|参考|出处|链接|参考文献)\s*[:：].*$/gm, '')
    .replace(/^https?:\/\/\S+$/gmi, '')
  return out
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const dayLabel = (ts) => {
  const d = new Date(ts)
  const today = new Date()
  const same = (a, b) => a.toDateString() === b.toDateString()
  if (same(d, today)) return '今天'
  const y = new Date(today.getTime() - 86400000)
  if (same(d, y)) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
const hhmm = (ts) => {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function render() {
  const q = state.query.trim()
  const shown = q ? state.items.filter((x) => clean(x.text).includes(q)) : state.items

  list.querySelectorAll('.day, .msg').forEach((n) => n.remove())
  emptyEl.classList.toggle('hidden', shown.length > 0)
  emptyEl.textContent = q ? '没有匹配的记录。' : '还没有聊过天。'

  let lastDay = ''
  for (const m of shown) {
    const key = dayKey(m.at)
    if (key !== lastDay) {
      lastDay = key
      const sep = document.createElement('div')
      sep.className = 'day'
      sep.textContent = dayLabel(m.at)
      list.appendChild(sep)
    }
    const row = document.createElement('div')
    row.className = `msg ${m.role === 'user' ? 'me' : 'her'}`
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = clean(m.text)
    const meta = document.createElement('div')
    meta.className = 'meta'
    const searched = Array.isArray(m.tools) && m.tools.some((t) => /search/i.test(t))
    meta.textContent = hhmm(m.at) + (m.proactive ? ' · 她自己说的' : '') + (searched ? ' · 🔍 查过网' : '')
    row.appendChild(bubble)
    row.appendChild(meta)
    list.appendChild(row)
  }

  countEl.textContent = state.items.length ? `（已载入 ${state.items.length}${state.hasMore ? '+' : ''} 条）` : ''
  olderBtn.disabled = !state.hasMore
}

async function load(before = null) {
  const page = await window.historyApi.list({ limit: PAGE, before })
  if (!page) return
  if (before) state.items = [...page.items, ...state.items]
  else state.items = page.items
  state.hasMore = !!page.hasMore
  render()
  // 首次打开滚到底（最新一条）
  if (!before) list.scrollTop = list.scrollHeight
}

olderBtn.addEventListener('click', () => {
  const oldest = state.items[0]?.at
  if (oldest) void load(oldest)
})

qEl.addEventListener('input', () => {
  state.query = qEl.value
  render()
})

document.getElementById('btn-export').addEventListener('click', async () => {
  const r = await window.historyApi.export()
  if (r?.ok) {
    olderBtn.textContent = '已导出'
    setTimeout(() => (olderBtn.textContent = '更早'), 1500)
  }
})

document.getElementById('btn-clear').addEventListener('click', async () => {
  if (!confirm('清空本地对话记录？\n（只删这台电脑上的记录，服务器那边她记得的东西不受影响）')) return
  await window.historyApi.clear()
  state.items = []
  state.hasMore = false
  render()
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.historyApi.close()
})

void load(null)
