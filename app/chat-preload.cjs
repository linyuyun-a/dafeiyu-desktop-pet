// 输入条独立窗口的 preload：只暴露三条最小接口
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chat', {
  say: (text) => ipcRenderer.send('chatwin:say', String(text || '')),
  close: (interrupt) => ipcRenderer.send('chatwin:close', !!interrupt),
  asr: (pcmB64) => ipcRenderer.invoke('chatwin:asr', String(pcmB64 || '')),
  onShown: (cb) => {
    const h = () => cb()
    ipcRenderer.on('chatwin:shown', h)
    return () => ipcRenderer.removeListener('chatwin:shown', h)
  },
})
