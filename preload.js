const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  launchAccount: (accountData) =>
    ipcRenderer.invoke("launch-account", accountData),
  loadAccounts: () => ipcRenderer.invoke("load-accounts"),
});
