// 预加载：只暴露壳层能力，渲染层拿不到 node。
//
// 三个页面共用这一份：舞台（覆盖层）/ 设置窗口 / 动作编辑器。
// 舞台窗口额外提供「全局光标 + DSH 状态 + 穿透」；设置窗口只用到 get/set/stageRpc。
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('shell', {
  // ---- 设置（主进程持有，改动会广播给所有窗口）----
  get: () => ipcRenderer.invoke('shell:get'),
  set: (patch) => ipcRenderer.invoke('shell:set', patch),
  onSettings: (fn) => ipcRenderer.on('shell:changed', (_e, s) => fn(s)),

  // ---- 舞台窗口的指令通道（设置窗口用它改反应、读快照、导出补丁）----
  stageRpc: (op, payload) => ipcRenderer.invoke('stage:rpc', op, payload),
  chooseModel: () => ipcRenderer.invoke('model:choose'),

  // ---- 首次运行引导（找不到模型时打开的小窗口）----
  firstRunPaths: () => ipcRenderer.invoke('firstrun:paths'),
  firstRunOpen: (what) => ipcRenderer.invoke('firstrun:open', what),
  firstRunSetModel: (p) => ipcRenderer.invoke('firstrun:set-model', p),
  firstRunChoose: () => ipcRenderer.invoke('firstrun:choose'),
  // 拖进来的文件拿真实路径（Electron 32+ 不再允许直接读 File.path）
  pathForFile: (f) => { try { return webUtils.getPathForFile(f) } catch { return '' } },


  // ---- 窗口搬运 / 尺寸 / 轮廓 ----
  dragBegin: () => ipcRenderer.send('win:drag-begin'),
  dragEnd: () => ipcRenderer.send('win:drag-end'),
  moveBy: (dx, dy, clamp = false) => ipcRenderer.send('win:move', { dx, dy, clamp }),
  // 窗口尺寸跟随角色：渲染层算尺寸，主进程保持中心不变地改
  fit: (w, h) => ipcRenderer.send('win:fit', { w, h }),
  // 拖边框缩放：报告按下的边，主进程按全局光标改 bounds（比例锁定）
  scaleBegin: (edge) => ipcRenderer.send('win:scale-begin', edge),
  scaleEnd: () => ipcRenderer.send('win:scale-end'),
  center: () => ipcRenderer.send('win:center'),
  setPassThrough: (v) => ipcRenderer.send('win:pass-through', v),
  // 掩码上传：主进程据此按**系统光标**判定穿透（渲染层在后台时 rAF 会停，不能只靠页面事件）
  setMask: (m) => ipcRenderer.send('win:mask', m),
  // 可点浮层（输入条/工具栏）的窗口内矩形：不在画布掩码里，但必须永远可点
  setChrome: (list) => ipcRenderer.send('win:chrome', list),
  // 大脑：说一句 / 打断 / 查状态
  brainSay: (text) => ipcRenderer.invoke('brain:say', text),
  brainInterrupt: () => ipcRenderer.invoke('brain:interrupt'),
  brainInfo: () => ipcRenderer.invoke('brain:info'),
  // 语音：把她的话交给本地 TTS，裸 PCM 块回推（CORS 与打断都在主进程处理）
  ttsSpeak: (opts) => ipcRenderer.invoke('tts:speak', opts),
  ttsStop: () => ipcRenderer.invoke('tts:stop'),
  onTts: (cb) => {
    const c = (_e, p) => cb('chunk', p)
    const e = (_e, p) => cb('end', p)
    const x = (_e, p) => cb('error', p)
    ipcRenderer.on('tts:chunk', c)
    ipcRenderer.on('tts:end', e)
    ipcRenderer.on('tts:error', x)
    return () => {
      ipcRenderer.off('tts:chunk', c)
      ipcRenderer.off('tts:end', e)
      ipcRenderer.off('tts:error', x)
    }
  },
  moodLoad: () => ipcRenderer.invoke('mood:load'),
  moodSave: (data) => ipcRenderer.invoke('mood:save', data),
  balanceStatus: () => ipcRenderer.invoke('balance:status'),
  // 主动开口：手动催一句 / 读统计 / 告诉主进程"用户还在动"
  proactiveForce: (opts) => ipcRenderer.invoke('proactive:force', opts),
  moodContext: (text) => ipcRenderer.send('mood:context', text),
  proactiveStats: () => ipcRenderer.invoke('proactive:stats'),
  proactiveTouch: () => ipcRenderer.send('proactive:touch'),
  // 在场感：主人走开 / 回来了（主进程按系统空闲时间判定）
  onPresence: (cb) => {
    const h = (_e, v) => cb(v)
    ipcRenderer.on('presence:change', h)
    return () => ipcRenderer.off('presence:change', h)
  },
  // 调试用：手动演一遍「走开 / 回来」
  testPresence: (kind) => ipcRenderer.invoke('presence:test', kind),
  debugTop: () => ipcRenderer.invoke('debug:top'),
  ttsStatus: () => ipcRenderer.invoke('tts:status'),
  ttsRestart: () => ipcRenderer.invoke('tts:restart'),
  onTtsState: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('tts:state', h)
    return () => ipcRenderer.removeListener('tts:state', h)
  },
  // 唤醒词命中时，主进程让她先说一句（气泡），随后自动弹输入条
  onSay: (cb) => {
    const h = (_e, d) => cb(d)
    ipcRenderer.on('pet:say', h)
    return () => ipcRenderer.removeListener('pet:say', h)
  },
  onKwsState: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('kws:state', h)
    return () => ipcRenderer.removeListener('kws:state', h)
  },
  kwsFake: (w) => ipcRenderer.invoke('kws:fake', w),
  kwsStatus: () => ipcRenderer.invoke('kws:status'),
  kwsSet: (patch) => ipcRenderer.invoke('kws:set', patch),
  openHistory: () => ipcRenderer.invoke('history:open'),  // ---- 音乐 / 唱片机 ----
  musicStatus: () => ipcRenderer.invoke('music:status'),
  musicQr: () => ipcRenderer.invoke('music:qr'),
  musicQrLogin: () => ipcRenderer.invoke('music:qrlogin'),
  musicQrCheck: (key) => ipcRenderer.invoke('music:qrcheck', key),
  musicLogout: () => ipcRenderer.invoke('music:logout'),
  musicSearch: (kw) => ipcRenderer.invoke('music:search', kw),
  musicPlay: (arg) => ipcRenderer.invoke('music:play', arg),
  musicEnqueue: (arg) => ipcRenderer.invoke('music:enqueue', arg),
  musicQueue: () => ipcRenderer.invoke('music:queue'),
  musicClose: () => ipcRenderer.invoke('music:close'),
  playerOpen: () => ipcRenderer.invoke('music:player'),
  onMusicState: (cb) => {
    const onQr = (_e, p) => cb({ type: 'qr', ...p })
    const onNow = (_e, p) => cb({ type: 'now', ...p })
    ipcRenderer.on('music:qrstate', onQr)
    ipcRenderer.on('music:now', onNow)
    return () => { ipcRenderer.removeListener('music:qrstate', onQr); ipcRenderer.removeListener('music:now', onNow) }
  },
  chatToggle: (on, anchor) => ipcRenderer.send('chatwin:toggle', !!on, anchor || null),
  chatAnchor: (anchor) => ipcRenderer.send('chatwin:anchor', anchor || null),
  onPetPos: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('pet:pos', h)
    return () => ipcRenderer.removeListener('pet:pos', h)
  },
  onBrainEvent: (cb) => {
    const h = (_e, ev) => cb(ev)
    ipcRenderer.on('brain:ev', h)
    return () => ipcRenderer.off('brain:ev', h)
  },
  debugHit: (x, y) => ipcRenderer.invoke('shell:debug-hit', x, y),
  onClickThrough: (fn) => ipcRenderer.on('shell:click-through', (_e, v) => fn(v)),

  // ---- 子窗口 ----
  openSettings: () => ipcRenderer.send('shell:settings'),
  openEditor: () => ipcRenderer.send('shell:editor'),
  openHarness: () => ipcRenderer.send('shell:harness'),
  quit: () => ipcRenderer.send('shell:quit'),
  devtools: () => ipcRenderer.send('shell:devtools'),

  // ---- 舞台专用：全局光标位置 + DSH 工作状态 ----
  onCursor: (fn) => ipcRenderer.on('cursor:pos', (_e, p) => fn(p)),
  onBalance: (fn) => ipcRenderer.on('balance:state', (_e, b) => fn(b)),
  onAgentStatus: (fn) => ipcRenderer.on('agent:status', (_e, s) => fn(s)),

  // ---- 文件：动作 JSON / 改动补丁（都放 userData，跟应用一起搬走）----
  actionsSave: (data) => ipcRenderer.invoke('actions:save', data),
  actionsLoad: () => ipcRenderer.invoke('actions:load'),
  patchSave: (data) => ipcRenderer.invoke('patch:save', data),
  patchLoad: () => ipcRenderer.invoke('patch:load'),
})
