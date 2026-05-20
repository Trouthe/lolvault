const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchAccount: (accountData) => ipcRenderer.invoke('launch-account', accountData),
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
});
