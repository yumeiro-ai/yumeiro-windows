const { contextBridge, ipcRenderer } = require('electron');
// 桌宠窗口的 preload：只暴露拖动、点穿、菜单、打开主窗口和接收事件
contextBridge.exposeInMainWorld('yumeiroPetHost', {
  ignore: value => ipcRenderer.send('pet:ignore', Boolean(value)),
  open: () => ipcRenderer.send('pet:open'),
  menu: () => ipcRenderer.send('pet:menu'),
  aiLine: (kind, hint) => ipcRenderer.send('pet:ai-line', String(kind || '').slice(0, 20), String(hint || '').slice(0, 80)),
  memory: json => ipcRenderer.send('pet:memory', String(json || '').slice(0, 20000)),
  starter: text => ipcRenderer.send('pet:starter', String(text || '').slice(0, 200)),
  onEvent: callback => ipcRenderer.on('pet:event', (event, payload) => callback(payload || {}))
});
