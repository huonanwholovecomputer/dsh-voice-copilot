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
  // 页面挂好监听后要一次当前快照：history 可能比订阅先到，那几帧不能丢
  snapshot: () => ipcRenderer.invoke('xiaoyin:snapshot'),
  send: (text) => ipcRenderer.invoke('xiaoyin:send', String(text ?? '')),
  hide: () => ipcRenderer.invoke('xiaoyin:hide'),
  // 拖把手改窗口尺寸（width/height 是想要的绝对像素，edge 决定哪条边跟着动）
  resize: (width, height, edge) =>
    ipcRenderer.send('xiaoyin:resize', Number(width) || 0, Number(height) || 0, String(edge || 'se')),
  focusSession: () => ipcRenderer.invoke('xiaoyin:focus-session'),
  setWake: (on) => ipcRenderer.invoke('xiaoyin:set-wake', Boolean(on)),
  cancel: () => ipcRenderer.invoke('xiaoyin:cancel'),
  stopRecording: () => ipcRenderer.invoke('xiaoyin:stop-recording'),
  // 声纹：只认机主。status 给面板显示，enroll 连录 3 句，accept/drop 处理「不像你」的那句
  voiceprint: {
    status: () => ipcRenderer.invoke('xiaoyin:voiceprint-status'),
    enroll: (want) => ipcRenderer.invoke('xiaoyin:voiceprint-enroll', Number(want) || 3),
    cancel: () => ipcRenderer.invoke('xiaoyin:voiceprint-cancel'),
    accept: () => ipcRenderer.invoke('xiaoyin:voiceprint-accept'),
    drop: () => ipcRenderer.invoke('xiaoyin:voiceprint-drop'),
    remove: () => ipcRenderer.invoke('xiaoyin:voiceprint-remove'),
    onEvent: (callback) => subscribe('xiaoyin:voiceprint', callback),
  },
  audio: {
    start: () => ipcRenderer.invoke('xiaoyin:audio-start'),
    stop: () => ipcRenderer.invoke('xiaoyin:audio-stop'),
    push: (samples, sampleRate) => ipcRenderer.send('xiaoyin:audio', samples, sampleRate),
    // 启动时先问一句「现在该不该开麦」：策略要求释放麦克风时，连 getUserMedia 都不发
    state: () => ipcRenderer.invoke('xiaoyin:mic-state'),
  },
})
