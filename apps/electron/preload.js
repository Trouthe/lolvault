const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchAccount: (accountData) => ipcRenderer.invoke('launch-account', accountData),
  loadAccounts: () => ipcRenderer.invoke('load-accounts'),
  saveAccounts: (accounts) => ipcRenderer.invoke('save-accounts', accounts),
  loadBoards: () => ipcRenderer.invoke('load-boards'),
  saveBoards: (boards) => ipcRenderer.invoke('save-boards', boards),
  openFilePicker: (options) => ipcRenderer.invoke('open-file-dialog', options),
  openExternal: (url) => ipcRenderer.send('open-external-url', url),
});
