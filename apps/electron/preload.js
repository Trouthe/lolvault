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
  openDirectoryPicker: (options) => ipcRenderer.invoke('open-directory-dialog', options),
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

  // Persistent game settings (League config read-only lock)
  inspectLeagueConfig: (payload) => ipcRenderer.invoke('settings:inspect-league-config', payload),
  setLeagueConfigReadOnly: (payload) =>
    ipcRenderer.invoke('settings:set-league-config-readonly', payload),

  // SQLite — App Settings
  getApiKey: () => ipcRenderer.invoke('db-get-api-key'),
  setApiKey: (key) => ipcRenderer.invoke('db-set-api-key', key),
  getSetting: (key) => ipcRenderer.invoke('db-get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('db-set-setting', key, value),

  // SQLite — LP Snapshots
  getLpSnapshots: (accountId) => ipcRenderer.invoke('db-get-lp-snapshots', accountId),
  saveLpSnapshot: (data) => ipcRenderer.invoke('db-save-lp-snapshot', data),

  // SQLite — Daily rank series
  getRankSnapshots: (accountId, queue) =>
    ipcRenderer.invoke('db-get-rank-snapshots', accountId, queue),
  recordRankSnapshot: (data) => ipcRenderer.invoke('db-record-rank-snapshot', data),

  // SQLite — Match Cache
  getMatchCache: (accountId, limit) => ipcRenderer.invoke('db-get-match-cache', accountId, limit),
  saveMatch: (data) => ipcRenderer.invoke('db-save-match', data),

  // Riot API
  riotGetSummonerByRiotId: (args) => ipcRenderer.invoke('riot:get-summoner-by-riot-id', args),
  riotGetSummonerByPuuid: (args) => ipcRenderer.invoke('riot:get-summoner-by-puuid', args),
  riotGetRankedByPuuid: (args) => ipcRenderer.invoke('riot:get-ranked-by-puuid', args),
  riotGetTopMastery: (args) => ipcRenderer.invoke('riot:get-top-mastery', args),
  riotGetMatchHistory: (args) => ipcRenderer.invoke('riot:get-match-history', args),
  riotGetCachedMatches: (args) => ipcRenderer.invoke('riot:get-cached-matches', args),
  riotPurgeForeignMatches: (args) => ipcRenderer.invoke('riot:purge-foreign-matches', args),
  riotValidateKey: (args) => ipcRenderer.invoke('riot:validate-key', args),
  riotSaveKey: (args) => ipcRenderer.invoke('riot:save-key', args),
  riotGetDDragonVersion: () => ipcRenderer.invoke('riot:get-ddragon-version'),
  riotGetMatchTimeline: (args) => ipcRenderer.invoke('riot:get-match-timeline', args),
  riotGetMatchDetail: (args) => ipcRenderer.invoke('riot:get-match-detail', args),
  riotBackfillMatchData: (args) => ipcRenderer.invoke('riot:backfill-match-data', args),
  riotCancelBackfill: (args) => ipcRenderer.invoke('riot:cancel-backfill', args),
  riotGetBackfillStatus: (args) => ipcRenderer.invoke('riot:get-backfill-status', args),
  onBackfillProgress: (cb) => ipcRenderer.on('riot:backfill-progress', (_e, data) => cb(data)),
  riotFetchYearHistory: (args) => ipcRenderer.invoke('riot:fetch-year-history', args),
  riotCancelYearHistory: (args) => ipcRenderer.invoke('riot:cancel-year-history', args),
  onYearHistoryProgress: (cb) =>
    ipcRenderer.on('riot:year-history-progress', (_e, data) => cb(data)),
  // Rows arrive in batches during the sweep so the page can fill in live.
  onYearHistoryRows: (cb) => ipcRenderer.on('riot:year-history-rows', (_e, data) => cb(data)),

  // Riot API — ladder harvest and the rank cache
  riotHarvestLadder: (args) => ipcRenderer.invoke('riot:harvest-ladder', args),
  riotCancelLadderHarvest: (args) => ipcRenderer.invoke('riot:cancel-ladder-harvest', args),
  riotPlanLadderHarvest: (args) => ipcRenderer.invoke('riot:plan-ladder-harvest', args),
  riotGetPlayerRanks: (args) => ipcRenderer.invoke('riot:get-player-ranks', args),
  onLadderHarvestProgress: (cb) =>
    ipcRenderer.on('riot:ladder-harvest-progress', (_e, data) => cb(data)),

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
