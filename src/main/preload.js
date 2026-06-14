const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onGameData: (cb) => ipcRenderer.on('game-data', (_, data) => cb(data)),
  onPlayerLevels: (cb) => ipcRenderer.on('player-levels', (_, updates) => cb(updates)),
  onPlayerCooldowns: (cb) => ipcRenderer.on('player-cooldowns', (_, updates) => cb(updates)),
  onUltLevelUpdate: (cb) => ipcRenderer.on('ult-level-update', (_, data) => cb(data)),
  onSyncCooldownEvent: (cb) => ipcRenderer.on('sync-cooldown-event', (_, data) => cb(data)),
  onSyncCooldownSnapshot: (cb) => ipcRenderer.on('sync-cooldown-snapshot', (_, data) => cb(data)),
  sendUltLevelChanged: (playerIndex, level) =>
    ipcRenderer.send('ult-level-changed', { playerIndex, level }),
  sendSyncCooldownEvent: (payload) => ipcRenderer.send('sync-cooldown-event', payload),
  sendToggleCollapse: () => ipcRenderer.send('toggle-collapse'),
  setFocusable: (v) => ipcRenderer.send('set-focusable', v),
  sendNaturalHeight: (height) => ipcRenderer.send('set-natural-height', height),
  sendQuit: () => ipcRenderer.send('quit-app'),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (s) => ipcRenderer.send('save-settings', s),
});
