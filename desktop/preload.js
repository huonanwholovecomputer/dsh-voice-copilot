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
  // 拖把手改窗口尺寸（width/height 是想要的绝对像素，edge 决定哪条边跟着动）
  resize: (width, height, edge) =>
    ipcRenderer.send('xiaoyin:resize', Number(width) || 0, Number(height) || 0, String(edge || 'se')),
  focusSession: () => ipcRenderer.invoke('xiaoyin:focus-session'),
  setWake: (on) => ipcRenderer.invoke('xiaoyin:set-wake', Boolean(on)),
  cancel: () => ipcRenderer.invoke('xiaoyin:cancel'),
  stopRecording: () => ipcRenderer.invoke('xiaoyin:stop-recording'),
  audio: {
    start: () => ipcRenderer.invoke('xiaoyin:audio-start'),
    stop: () => ipcRenderer.invoke('xiaoyin:audio-stop'),
    push: (samples, sampleRate) => ipcRenderer.send('xiaoyin:audio', samples, sampleRate),
    // 启动时先问一句「现在该不该开麦」：策略要求释放麦克风时，连 getUserMedia 都不发
    state: () => ipcRenderer.invoke('xiaoyin:mic-state'),
  },
})
