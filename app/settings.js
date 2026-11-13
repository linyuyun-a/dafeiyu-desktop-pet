// 设置窗口。
//
// 分工：
//   - 纯设置项（尺寸/缩放/跟随/气泡/置顶/穿透）走 shell.set → 主进程存盘并广播 → 覆盖层立即生效；
//     设置窗口自己不持有任何状态，也不直接碰模型。
//   - 需要舞台内部状态的（热区反应表、导出补丁）走 shell.stageRpc，舞台窗口是唯一真相。
const $ = (s) => document.querySelector(s)

const shell = window.shell || {
  get: async () => ({}),
  set: async (p) => p,
  stageRpc: async () => ({ ok: false, error: 'no bridge' }),
  center: () => {},
  openEditor: () => {},
  openHarness: () => {},
  quit: () => {},
}

let settings = {}

function status(text, warn = false) {
  const el = $('#status')
  if (!el) return
  el.textContent = text || ''
  el.classList.toggle('warn', !!warn)
  clearTimeout(status._t)
  if (text) status._t = setTimeout(() => { el.textContent = '' }, 3600)
}

async function rpc(op, payload) {
  const r = await shell.stageRpc?.(op, payload)
  if (!r || r.ok === false) {
    status(r?.error || '舞台窗口没响应，先把角色启动起来', true)
    return null
  }
  return r.value
}

/** 滑块连续拖动时别每帧写盘：攒 120ms 发一次 */
function debounce(fn, ms = 120) {
  let t = 0
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

const pushSettings = (patch) => shell.set(patch)
const pushSettingsSoon = debounce((patch) => shell.set(patch))

function paint() {
  const zoom = Number(settings.zoom) || 1
  setRange('#zoom', zoom)
  $('#zoom-readout').textContent = `${Math.round(zoom * 100)}%`
  setRange('#strength', Number(settings.strength ?? 1))
  const headGain = Number(settings.headGain ?? 1.25)
  setRange('#head-gain', headGain)
  showHeadGain(headGain)
  setRange('#pet-gain', Number(settings.petGain ?? 1.6))
  setRange('#idle-speed', Number(settings.idleSpeed ?? 1))
  showIdleSpeed(Number(settings.idleSpeed ?? 1))

  setCheck('#gaze', settings.gaze !== false)
  setCheck('#idle', settings.idle !== false)
  setCheck('#bubble-on', settings.bubble !== false)
  setCheck('#border', !!settings.border)
  const padY = Number(settings.padY ?? 0.02)
  setRange('#pad-y', padY)
  $('#pad-y-readout').textContent = `${Math.round(padY * 100)}%`
  const body = Number(settings.bodyShape ?? 0)
  setRange('#body-shape', body)
  $('#body-shape-readout').textContent = body <= 0.01 ? '默认' : body >= 0.99 ? '体型2' : '体型 ' + Math.round(body * 100) + '%'
  setCheck('#drag-physics', settings.dragPhysics !== false)
  setCheck('#top', !!settings.alwaysOnTop)
  setCheck('#click-through', !!settings.clickThrough)
  setCheck('#auto-start', !!settings.autoStart)
}

function setRange(sel, v) {
  const el = $(sel)
  if (el && document.activeElement !== el) el.value = v
}
/** 转头幅度读数：显示参数角度的请求幅度（模型量程 ±30°，超出部分会被夹住） */
function showHeadGain(g) {
  const el = $('#head-gain-readout')
  if (el) el.textContent = `${Math.round(27 * g)}°`
}
/** 待机频率读数：换算成「几秒一段动作」更直观（基础 8–18 秒） */
function showIdleSpeed(s) {
  const el = $('#idle-speed-readout')
  if (el) el.textContent = `${Math.round(8 / s)}–${Math.round(18 / s)}s`
}
function setCheck(sel, on) {
  const el = $(sel)
  if (el) el.checked = !!on
}

// ---------- 事件 ----------
function wire() {
  $('#zoom').oninput = (e) => {
    const zoom = Number(e.target.value)
    $('#zoom-readout').textContent = `${Math.round(zoom * 100)}%`
    pushSettingsSoon({ zoom })
  }
  $('#strength').oninput = (e) => pushSettingsSoon({ strength: Number(e.target.value) })
  $('#head-gain').oninput = (e) => {
    const g = Number(e.target.value)
    showHeadGain(g)
    pushSettingsSoon({ headGain: g })
  }
  $('#pet-gain').oninput = (e) => pushSettingsSoon({ petGain: Number(e.target.value) })
  $('#gaze').onchange = (e) => pushSettings({ gaze: !!e.target.checked })
  $('#idle').onchange = (e) => pushSettings({ idle: !!e.target.checked })
  $('#idle-speed').oninput = (e) => {
    const s = Number(e.target.value)
    showIdleSpeed(s)
    pushSettingsSoon({ idleSpeed: s })
  }
  $('#bubble-on').onchange = (e) => pushSettings({ bubble: !!e.target.checked })
  // 声音：开关 + 自启 + 服务地址 / python 路径 + 状态（状态由主进程推 tts:state）
  const voiceBox = $('#voice')
  if (voiceBox) {
    voiceBox.checked = settings.voice !== false
    voiceBox.onchange = (e) => pushSettings({ voice: !!e.target.checked })
  }
  const ttsUrlInput = $('#tts-url')
  if (ttsUrlInput) {
    ttsUrlInput.value = settings.ttsUrl || 'http://127.0.0.1:8769'
    ttsUrlInput.onchange = (e) => pushSettings({ ttsUrl: e.target.value.trim() || 'http://127.0.0.1:8769' })
  }
  const workLinkEl = $('#work-link')
  if (workLinkEl) {
    workLinkEl.value = settings.workLink || 'full'
    workLinkEl.onchange = (e) => pushSettings({ workLink: e.target.value || 'full' })
  }
  const asrSel = $('#asr-engine')
  if (asrSel) {
    asrSel.value = settings.asrEngine || 'sensevoice'
    asrSel.onchange = (e) => pushSettings({ asrEngine: e.target.value === 'qwen3' ? 'qwen3' : 'sensevoice' })
  }
  const ttsPy = $('#tts-python')
  if (ttsPy) {
    ttsPy.value = settings.ttsPython || ''
    ttsPy.onchange = (e) => pushSettings({ ttsPython: e.target.value.trim() })
  }
  const ttsStateEl = $('#tts-state')
  const paintTts = (p) => {
    if (!ttsStateEl) return
    const label = { idle: '未启动', starting: '正在启动…（冷启动 15–90 秒）', ready: '就绪', off: '未启动', failed: '启动失败' }[p?.state] || p?.state || '未知'
    ttsStateEl.textContent = p?.reason ? `${label}（${p.reason}）` : label
    ttsStateEl.dataset.state = p?.state || ''
  }
  window.shell?.onTtsState?.((p) => paintTts(p))
  window.shell?.ttsStatus?.().then(paintTts).catch(() => {})
  // ---- 音乐 / 唱片机 ----
  const playerOn = $('#player-on')
  if (playerOn) {
    playerOn.checked = settings.player !== false
    playerOn.onchange = (e) => pushSettings({ player: e.target.checked })
  }
  const musicState = $('#music-state')
  const qrBtn = $('#music-qr')
  const qrBox = $('#music-qr-box')
  const qrImg = $('#music-qr-img')
  const qrTip = $('#music-qr-tip')
  const logoutBtn = $('#music-logout')
  const paintMusic = (st) => {
    if (!musicState) return
    if (st?.login) {
      const name = st.profile?.nickname ? `${st.profile.nickname}${st.profile.vipType ? ' · VIP' : ''}` : '已登录'
      musicState.textContent = name
      if (logoutBtn) logoutBtn.classList.remove('hidden')
      qrBox?.classList.add('hidden')
    } else {
      musicState.textContent = '未登录（只能放免费曲）'
      if (logoutBtn) logoutBtn.classList.add('hidden')
    }
  }
  window.shell?.musicStatus?.()?.then?.(paintMusic).catch?.(() => {})
  // 主进程自己也会轮询扫码结果，这里订阅它的广播（两条路都收，谁先到算谁的）
  window.shell?.onMusicState?.((ev) => {
    if (!ev || ev.type !== 'qr') return
    if (ev.code === 803) {
      clearInterval(qrTimer)
      qrBox?.classList.add('hidden')
      window.shell?.musicStatus?.().then(paintMusic)
      status('登录成功' + (ev.profile?.nickname ? '：' + ev.profile.nickname : ''))
    } else if (ev.code === 802 && qrTip) qrTip.textContent = '扫到了，在手机上点确认'
  })
  let qrTimer = 0
  if (qrBtn) qrBtn.onclick = async () => {
    try {
      const r = await window.shell?.musicQr?.()
      if (!r?.key) return status('拿不到二维码', true)
      if (qrImg && r.png) qrImg.src = r.png
      qrBox?.classList.remove('hidden')
      if (qrTip) qrTip.textContent = '在手机网易云里扫这个码（约 2 分钟有效）'
      clearInterval(qrTimer)
      const finishOk = async (profile) => {
        clearInterval(qrTimer)
        qrBox?.classList.add('hidden')
        if (qrTip) qrTip.textContent = ''
        await window.shell?.musicStatus?.().then(paintMusic)
        if (qrBtn) qrBtn.textContent = '已登录'
        status('登录成功' + (profile?.nickname ? '：' + profile.nickname : ''))
      }
      qrTimer = setInterval(async () => {
        try {
          const c = await window.shell?.musicQrCheck?.(r.key)
          if (c?.code === 802 && qrTip) qrTip.textContent = '扫到了，在手机上点确认'
          if (c?.code === 803) { await finishOk(); return }
          if (c?.code === 801 && qrTip) qrTip.textContent = '等你扫码（约 2 分钟有效）'
          if (c?.code === 802 && qrTip) qrTip.textContent = '扫到了，在手机上点确认'
          // 兜底：有的账号 803 返回不稳定，直接看账号状态
          const st = await window.shell?.musicStatus?.()
          if (st?.login) await finishOk(st.profile)
          if (c?.code === 800) { clearInterval(qrTimer); if (qrTip) qrTip.textContent = '二维码过期了，点「扫码登录」重新生成'; if (qrBtn) qrBtn.textContent = '重新扫码' }
          if (c?.code === 0) { /* 查询失败，继续等 */ }
        } catch {}
      }, 2000)
    } catch (e) { status('二维码生成失败', true) }
  }
  if (logoutBtn) logoutBtn.onclick = async () => {
    await window.shell?.musicLogout?.()
    paintMusic({ login: false })
    status('已退出音乐账号')
  }
  const ttsRestart = $('#tts-restart')
  if (ttsRestart) ttsRestart.onclick = () => { paintTts({ state: 'starting' }); window.shell?.ttsRestart?.() }

  // 主动说话：频率 + 勿扰时段（主进程按这个决定"什么时候该开口"）
  const selProactive = $('#proactive')
  if (selProactive) {
    selProactive.value = settings.proactive || 'few'
    selProactive.onchange = (e) => pushSettings({ proactive: e.target.value })
  }
  const qFrom = $('#quiet-from')
  const qTo = $('#quiet-to')
  const awayTalk = $('#away-talk')
  if (awayTalk) {
    awayTalk.checked = settings.awayTalk !== false
    awayTalk.onchange = (e) => pushSettings({ awayTalk: !!e.target.checked })
  }
  if (qFrom && qTo) {
    qFrom.value = settings.quietFrom || '23:30'
    qTo.value = settings.quietTo || '07:30'
    qFrom.onchange = (e) => pushSettings({ quietFrom: e.target.value })
    qTo.onchange = (e) => pushSettings({ quietTo: e.target.value })
  }
  // 模型表情 / 预设动作：列表从舞台的 meta 来（原包全部表情 + 姿势）
  $('#mode-normal').onclick = async () => {
    await rpc('exprClear')
    status('已回到常态')
    await loadModelLists()
  }
  loadModelLists()
  $('#border').onchange = (e) => pushSettings({ border: !!e.target.checked })
  $('#pad-y').oninput = (e) => {
    const v = Number(e.target.value)
    $('#pad-y-readout').textContent = `${Math.round(v * 100)}%`
    pushSettingsSoon({ padY: v })
  }
  $('#body-shape').oninput = (e) => {
    const v = Number(e.target.value)
    $('#body-shape-readout').textContent = v <= 0.01 ? '默认' : v >= 0.99 ? '体型2' : '体型 ' + Math.round(v * 100) + '%'
    pushSettingsSoon({ bodyShape: v })
  }
  $('#drag-physics').onchange = (e) => pushSettings({ dragPhysics: !!e.target.checked })
  $('#top').onchange = (e) => pushSettings({ alwaysOnTop: !!e.target.checked })
  $('#click-through').onchange = (e) => pushSettings({ clickThrough: !!e.target.checked })
  $('#auto-start').onchange = (e) => pushSettings({ autoStart: !!e.target.checked })

  $('#choose-model').onclick = async () => {
    status('正在打开选择框…')
    const r = await shell.chooseModel?.()
    if (r?.ok) status('已切换模型，重启中…')
  }
  $('#open-editor').onclick = () => shell.openEditor?.()
  $('#patch-export').onclick = async () => {
    const v = await rpc('patchExport')
    if (v?.ok) status('改动补丁已保存（stage-patch.json）')
    else if (v) status('补丁保存失败', true)
  }

  $('#win-center').onclick = () => { shell.center?.(); status('覆盖层已居中') }
  $('#open-harness').onclick = () => shell.openHarness?.()
  $('#quit').onclick = () => shell.quit?.()
}

// ---------- 模型表情 / 预设动作 ----------
// 列表来自舞台窗口的 meta（caps.expressions 全量 + POSES），点一下应用/取消，按钮高亮当前生效项。
let activeExprs = []
let activePose = '默认手'

function paintChips() {
  for (const btn of document.querySelectorAll('#expr-list .chip')) {
    btn.classList.toggle('on', activeExprs.includes(btn.dataset.expr))
  }
  for (const btn of document.querySelectorAll('#pose-list .chip')) {
    btn.classList.toggle('on', activePose === btn.dataset.pose)
  }
}

async function loadModelLists() {
  const meta = await rpc('meta')
  if (!meta) return
  activeExprs = meta.active?.exprs || []
  activePose = meta.active?.pose || '默认手'
  const exprBox = $('#expr-list')
  if (exprBox && !exprBox.dataset.built) {
    exprBox.dataset.built = '1'
    const skip = new Set(['体型1', '体型2', '默认体型']) // 体型改成拉条了，不再占按钮
    for (const name of (meta.exprs || []).filter((n) => !skip.has(n))) {
      const btn = document.createElement('button')
      btn.className = 'chip'
      btn.textContent = name
      btn.dataset.expr = name
      btn.onclick = async () => {
        const r = await rpc('expr', { name })
        if (!r) return
        activeExprs = r.active?.exprs || []
        paintChips()
      }
      exprBox.append(btn)
    }
  }
  // 官方动作与我们的预设分两组显示（meta.poses 现在带 official 标记）
  const poses = (meta.poses || []).map((p) => (typeof p === 'string' ? { name: p, official: true } : p))
  for (const [boxSel, wantOfficial] of [['#pose-list', true], ['#pose-custom', false]]) {
    const box = $(boxSel)
    if (!box || box.dataset.built) continue
    box.dataset.built = '1'
    for (const p of poses.filter((x) => !!x.official === wantOfficial)) {
      const btn = document.createElement('button')
      btn.className = 'chip'
      btn.textContent = p.name
      btn.dataset.pose = p.name
      btn.onclick = async () => {
        const r = await rpc('pose', { name: p.name })
        if (!r) return
        activePose = r.active?.pose || p.name
        paintChips()
      }
      box.append(btn)
    }
  }
  paintChips()
}

async function boot() {
  settings = (await shell.get?.()) || {}
  paint()
  shell.onSettings?.((next) => { settings = next || settings; paint() })
  wire()
}

void boot()
