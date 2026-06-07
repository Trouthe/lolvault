const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchAccount: (accountData) => ipcRenderer.invoke('launch-account', accountData),
  captureAccountSession: (payload) => ipcRenderer.invoke('capture-account-session', payload),
  openCleanRiotClient: (payload) => ipcRenderer.invoke('open-clean-riot-client', payload),
  loadAccounts: () => ipcRenderer.invoke('load-accounts'),
  saveAccounts: (accounts) => ipcRenderer.invoke('save-accounts', accounts),
  loadBoards: () => ipcRenderer.invoke('load-boards'),
  saveBoards: (boards) => ipcRenderer.invoke('save-boards', boards),
  openFilePicker: (options) => ipcRenderer.invoke('open-file-dialog', options),
  openExternal: (url) => ipcRenderer.send('open-external-url', url),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  startGoogleSystemSignIn: (options) => ipcRenderer.invoke('start-google-system-sign-in', options),

  // Auto-update
  onUpdateAvailable: (callback) =>
    ipcRenderer.on('update-available', (_e, version) => callback(version)),
  onUpdateProgress: (callback) =>
    ipcRenderer.on('update-progress', (_e, percent) => callback(percent)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', () => callback()),
  onUpdateError: (callback) => ipcRenderer.on('update-error', (_e, message) => callback(message)),
  startUpdateDownload: () => ipcRenderer.invoke('start-update-download'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // SQLite — App Settings
  getApiKey: () => ipcRenderer.invoke('db-get-api-key'),
  setApiKey: (key) => ipcRenderer.invoke('db-set-api-key', key),
  getSetting: (key) => ipcRenderer.invoke('db-get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('db-set-setting', key, value),

  // SQLite — LP Snapshots
  getLpSnapshots: (accountId) => ipcRenderer.invoke('db-get-lp-snapshots', accountId),
  saveLpSnapshot: (data) => ipcRenderer.invoke('db-save-lp-snapshot', data),

  // SQLite — Match Cache
  getMatchCache: (accountId, limit) => ipcRenderer.invoke('db-get-match-cache', accountId, limit),
  saveMatch: (data) => ipcRenderer.invoke('db-save-match', data),

  // LCU Monitor — pull current state (handles race condition on startup)
  getLcuState: () => ipcRenderer.invoke('lcu:get-state'),

  // LCU Monitor events (main → renderer)
  onLcuAccountIdentified: (cb) => ipcRenderer.on('lcu:account-identified', (_e, data) => cb(data)),
  onLcuAccountUnrecognized: (cb) =>
    ipcRenderer.on('lcu:account-unrecognized', (_e, data) => cb(data)),
  onLcuPhaseChange: (cb) => ipcRenderer.on('lcu:phase-change', (_e, data) => cb(data)),
  onLcuGameEnded: (cb) => ipcRenderer.on('lcu:game-ended', (_e, data) => cb(data)),
  onLcuDisconnected: (cb) => ipcRenderer.on('lcu:disconnected', (_e, data) => cb(data)),
});
