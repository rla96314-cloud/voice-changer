const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  saveRecording: (arrayBuffer) => ipcRenderer.invoke('save-recording', arrayBuffer),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  deleteRecording: (filePath) => ipcRenderer.invoke('delete-recording', filePath),
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),
  ttsVoices: () => ipcRenderer.invoke('tts-voices'),
  ttsSpeak: (opts) => ipcRenderer.invoke('tts-speak', opts),
  overlayUrl: () => ipcRenderer.invoke('overlay-url'),
  localTtsFetch: (opts) => ipcRenderer.invoke('local-tts-fetch', opts),
  caption: (event) => ipcRenderer.send('caption', event),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, payload) => cb(payload)),
});
