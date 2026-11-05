const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const handler = (_event, payload) => {
    try {
      callback(payload)
    } catch (error) {
      console.error('[xiaoyin] listener failed', error)
    }
  }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('xiaoyin', {
  onState: (callback) => subscribe('xiaoyin:state', callback),
  onMessages: (callback) => subscribe('xiaoyin:messages', callback),
  onToast: (callback) => subscribe('xiaoyin:toast', callback),
  send: (text) => ipcRenderer.invoke('xiaoyin:send', String(text ?? '')),
  hide: () => ipcRenderer.invoke('xiaoyin:hide'),
  focusSession: () => ipcRenderer.invoke('xiaoyin:focus-session'),
  setWake: (on) => ipcRenderer.invoke('xiaoyin:set-wake', Boolean(on)),
  cancel: () => ipcRenderer.invoke('xiaoyin:cancel'),
  audio: {
    start: () => ipcRenderer.invoke('xiaoyin:audio-start'),
    stop: () => ipcRenderer.invoke('xiaoyin:audio-stop'),
    push: (samples, sampleRate) => ipcRenderer.send('xiaoyin:audio', samples, sampleRate),
  },
})
