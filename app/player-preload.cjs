const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('player', {
  config: () => ipcRenderer.invoke('player:config'),
  close: () => ipcRenderer.send('player:close'),
  onLoad: (cb) => {
    const fn = (_e, payload) => cb(payload)
    ipcRenderer.on('player:load', fn)
    return () => ipcRenderer.removeListener('player:load', fn)
  },
  onIdle: (cb) => {
    const fn = (_e, payload) => cb(payload)
    ipcRenderer.on('player:idle', fn)
    return () => ipcRenderer.removeListener('player:idle', fn)
  },
  reportState: (state) => ipcRenderer.send('player:state', state),
  resize: (size) => ipcRenderer.send('player:resize', size),
  poster: (on) => ipcRenderer.send('player:poster', !!on),
  getMode: () => ipcRenderer.invoke('player:get-mode'),
  setMode: (m) => ipcRenderer.invoke('player:set-mode', m),
  next: () => ipcRenderer.send('player:next'),
  prev: () => ipcRenderer.send('player:prev'),
  ended: () => ipcRenderer.send('player:ended'),
  onSeek: (cb) => {
    const fn = (_e, payload) => cb(payload)
    ipcRenderer.on('player:seek', fn)
    return () => ipcRenderer.removeListener('player:seek', fn)
  },
  onQueue: (cb) => {
    const fn = (_e, payload) => cb(payload)
    ipcRenderer.on('player:queue', fn)
    return () => ipcRenderer.removeListener('player:queue', fn)
  },
  playlists: (force) => ipcRenderer.invoke('music:playlists', { force: !!force }),
  playSong: (song) => ipcRenderer.send('player:play-song', song),
  enqueue: (song) => ipcRenderer.send('player:enqueue-song', song),
  getStyle: () => ipcRenderer.invoke('player:get-style'),
  setStyle: (id) => ipcRenderer.send('player:set-style', id),
  tracks: (id) => ipcRenderer.invoke('music:tracks', id),
  getAnalysis: (id) => ipcRenderer.invoke('player:get-analysis', id),
  setAnalysis: (id, info) => ipcRenderer.send('player:set-analysis', { id, info }),
})
