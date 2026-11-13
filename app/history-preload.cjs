// 对话记录窗口的桥：只读列表 + 导出 / 清空 / 关闭，全部经主进程。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('historyApi', {
  list: (opts) => ipcRenderer.invoke('chat:history', opts || {}),
  export: () => ipcRenderer.invoke('chat:export'),
  clear: () => ipcRenderer.invoke('chat:clear'),
  close: () => ipcRenderer.send('chat:close-window'),
})
