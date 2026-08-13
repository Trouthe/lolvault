const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const { dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const db = require('./database');
const { startLcuMonitor, stopLcuMonitor, getLcuState } = require('./lcu-monitor');
const riotApi = require('./riot-api.service');
const rateLimiter = require('./rate-limiter');

const GOOGLE_SYSTEM_AUTH_TIMEOUT_MS = 3 * 60 * 1000;
const GOOGLE_SYSTEM_AUTH_CALLBACK_HOST = 'localhost';
const GOOGLE_SYSTEM_AUTH_CALLBACK_BIND_ADDRESS = '127.0.0.1';
const DEFAULT_GOOGLE_SYSTEM_AUTH_CALLBACK_PORT = 51793;
const parsedGoogleSystemAuthCallbackPort = Number.parseInt(
  process.env.GOOGLE_SYSTEM_AUTH_CALLBACK_PORT || `${DEFAULT_GOOGLE_SYSTEM_AUTH_CALLBACK_PORT}`,
  10
);
const GOOGLE_SYSTEM_AUTH_CALLBACK_PORT =
  Number.isInteger(parsedGoogleSystemAuthCallbackPort) &&
  parsedGoogleSystemAuthCallbackPort > 0 &&
  parsedGoogleSystemAuthCallbackPort <= 65535
    ? parsedGoogleSystemAuthCallbackPort
    : DEFAULT_GOOGLE_SYSTEM_AUTH_CALLBACK_PORT;

const RIOT_PROFILE_DIR_NAME = 'Riot Client';
const RIOT_SESSION_VAULT_DIR_NAME = 'riot-session-vault';
const RIOT_LOCAL_CLIENT_DIR_SEGMENTS = ['Riot Games', 'Riot Client'];
const RIOT_LOCAL_DATA_DIR_NAME = 'Data';
const RIOT_LOCAL_CONFIG_DIR_NAME = 'Config';
const RIOT_LOCAL_CONFIG_SETTINGS_FILE_NAME = 'RiotClientSettings.yaml';
const RIOT_SESSION_SNAPSHOT_ROAMING_SUBDIR = 'roaming-profile';
const RIOT_SESSION_SNAPSHOT_LOCAL_DATA_SUBDIR = 'local-data';
const RIOT_SESSION_SNAPSHOT_LOCAL_CONFIG_SUBDIR = 'local-config';
const RIOT_SESSION_SNAPSHOT_META_FILE = 'session-meta.json';
const RIOT_SESSION_EXCLUDED_TOP_LEVEL = new Set([
  'blob_storage',
  'cache',
  'code cache',
  'dawncache',
  'gpucache',
  'videodecodestats',
]);
const RIOT_SESSION_EXCLUDED_FILE_NAMES = new Set([
  'lock',
  'lock-journal',
  'singletoncookie',
  'singletonlock',
  'singletonsocket',
  'devtoolsactiveport',
  'chrome_debug.log',
]);
const RIOT_WINDOWS_PROCESS_NAMES = [
  'RiotClientServices.exe',
  'RiotClientUx.exe',
  'RiotClientUxRender.exe',
  'LeagueClient.exe',
  'LeagueClientUx.exe',
  'LeagueClientUxRender.exe',
];
const RIOT_LAUNCH_ARGS = ['--launch-patchline=live'];

function encrypt(text) {
  if (!text) return text;

  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('Encryption not available on this system');
    return text;
  }

  const buffer = safeStorage.encryptString(text);
  return buffer.toString('base64');
}

function decrypt(encryptedText) {
  if (!encryptedText) return encryptedText;

  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('Encryption not available on this system');
    return encryptedText;
  }

  try {
    const buffer = Buffer.from(encryptedText, 'base64');
    return safeStorage.decryptString(buffer);
  } catch (error) {
    console.warn(
      'Decryption failed, returning original value (might be plaintext):',
      error.message
    );
    return encryptedText;
  }
}

function encryptAccount(account) {
  return { ...account, username: encrypt(account.username), password: encrypt(account.password) };
}

function decryptAccount(account) {
  try {
    return { ...account, username: decrypt(account.username), password: decrypt(account.password) };
  } catch (error) {
    console.error('Error decrypting account:', error);
    return account;
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load the Angular app
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:4200');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = path.join(__dirname, 'dist', 'lolvault', 'browser', 'index.html');
    console.log('Loading from:', indexPath);
    console.log('File exists:', fs.existsSync(indexPath));
    mainWindow.loadFile(indexPath);

    //! Uncomment for debugging
    // mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  const dataPath = getDataPath();
  if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });
  db.initDatabase(dataPath);
  db.setEncryptionHelpers(encrypt, decrypt);

  createWindow();
  setupAutoUpdater();
  startLcuMonitor(mainWindow, getDataPath, decryptAccount);

  // Re-emit current LCU state after the renderer finishes loading so Angular
  // can seed its live state even if the LCU connected before it bootstrapped.
  mainWindow.webContents.on('did-finish-load', () => {
    const state = getLcuState();
    if (state.activeVaultId) {
      mainWindow.webContents.send('lcu:account-identified', {
        vaultId: state.activeVaultId,
        puuid: state.puuid,
        displayName: state.displayName,
      });
      if (state.phase && state.phase !== 'None') {
        mainWindow.webContents.send('lcu:phase-change', {
          vaultId: state.activeVaultId,
          phase: state.phase,
        });
      }
    }
  });
});

app.on('before-quit', () => stopLcuMonitor());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Auto-Updater ──

let downloadedUpdateFile = null;

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  // GitHub's releases/latest/download routing 404s when a ?noCache query
  // param is appended — disable it so the URL is clean for the redirect
  autoUpdater.isAddNoCacheQuery = false;

  // Use generic provider so electron-updater fetches the yml directly
  // instead of using the GitHub provider which hits github.com/releases
  // with Accept: application/json and gets a 406
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://github.com/Trouthe/lolvault/releases/latest/download',
  });

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-available', info.version);
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-progress', progress.percent);
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateFile = info.downloadedFile || null;
    mainWindow?.webContents.send('update-downloaded');
  });

  autoUpdater.on('error', (error) => {
    // On macOS we do our own install via shell script, so ignore the
    // ShipIt signature validation error that fires after the download
    // completes — the file is already saved and ready to use.
    if (process.platform === 'darwin' && downloadedUpdateFile) return;
    mainWindow?.webContents.send('update-error', error?.message || 'Unknown error');
  });

  // Only check for updates in production, wait for renderer to be ready
  if (app.isPackaged) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch((err) => {
          console.error('Auto-update check failed:', err);
        });
      }, 2000);
    });
  }
}

ipcMain.handle('start-update-download', () => {
  autoUpdater.downloadUpdate().catch((err) => {
    console.error('Download update failed:', err);
    mainWindow?.webContents.send('update-error', err?.message || 'Download failed');
  });
});

ipcMain.handle('install-update', () => {
  if (process.platform === 'darwin') {
    installMacUpdate();
  } else {
    installPortableUpdate();
  }
});

function installMacUpdate() {
  if (!downloadedUpdateFile || !fs.existsSync(downloadedUpdateFile)) {
    mainWindow?.webContents.send('update-error', 'Downloaded update file not found');
    return;
  }

  // app.getPath('exe') = /Applications/LoL Vault.app/Contents/MacOS/LoL Vault
  // Go up 3 levels to reach LoL Vault.app
  const currentAppPath = path.dirname(path.dirname(path.dirname(app.getPath('exe'))));
  const tmpDir = path.join(app.getPath('temp'), `lolvault-update-${Date.now()}`);

  const scriptLines = [
    '#!/bin/bash',
    'sleep 3',
    `mkdir -p "${tmpDir}"`,
    `unzip -o "${downloadedUpdateFile}" -d "${tmpDir}"`,
    `APP_PATH=$(find "${tmpDir}" -name "*.app" -maxdepth 2 | head -1)`,
    'if [ -z "$APP_PATH" ]; then exit 1; fi',
    `rm -rf "${currentAppPath}"`,
    `cp -R "$APP_PATH" "${currentAppPath}"`,
    `open "${currentAppPath}"`,
    `rm -rf "${tmpDir}"`,
  ];

  const scriptPath = path.join(app.getPath('temp'), 'lolvault-update.sh');
  fs.writeFileSync(scriptPath, scriptLines.join('\n'));
  fs.chmodSync(scriptPath, '755');

  const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' });
  child.unref();

  app.quit();
}

function installPortableUpdate() {
  if (!downloadedUpdateFile || !fs.existsSync(downloadedUpdateFile)) {
    mainWindow?.webContents.send('update-error', 'Downloaded update file not found');
    return;
  }

  const currentExe = process.execPath;
  const currentDir = path.dirname(currentExe);
  const batchPath = path.join(currentDir, '_lolvault_update.cmd');

  const script = [
    '@echo off',
    'timeout /t 3 /nobreak > nul',
    `del "${currentExe}.old" 2>nul`,
    `move "${currentExe}" "${currentExe}.old"`,
    `copy /y "${downloadedUpdateFile}" "${currentExe}"`,
    `start "" "${currentExe}"`,
    `del "%~f0"`,
  ].join('\r\n');

  fs.writeFileSync(batchPath, script);

  const child = spawn('cmd', ['/c', batchPath], {
    detached: true,
    stdio: 'ignore',
    cwd: currentDir,
  });
  child.unref();

  app.quit();
}

ipcMain.handle('check-for-updates', () => {
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Manual update check failed:', err);
    });
  }
});

const isMac = process.platform === 'darwin';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stdout, stderr });
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function shouldRetryPathOperation(error) {
  const code = error?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
}

async function removePathWithRetry(targetPath, attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= attempts || !shouldRetryPathOperation(error)) {
        throw error;
      }

      await delay(120 * attempt);
    }
  }
}

async function copyDirectoryFiltered(sourceDir, targetDir, filter) {
  await fs.promises.cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter,
  });
}

async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getRiotProfilePath() {
  return path.join(app.getPath('appData'), RIOT_PROFILE_DIR_NAME);
}

function getRiotSessionVaultPath() {
  return path.join(getDataPath(), RIOT_SESSION_VAULT_DIR_NAME);
}

function getLocalAppDataPath() {
  return process.env.LOCALAPPDATA || app.getPath('appData');
}

function getRiotLocalClientRootPath() {
  return path.join(getLocalAppDataPath(), ...RIOT_LOCAL_CLIENT_DIR_SEGMENTS);
}

function getRiotLocalDataPath() {
  return path.join(getRiotLocalClientRootPath(), RIOT_LOCAL_DATA_DIR_NAME);
}

function getRiotLocalConfigPath() {
  return path.join(getRiotLocalClientRootPath(), RIOT_LOCAL_CONFIG_DIR_NAME);
}

function sanitizePathSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
}

function getAccountSessionKey(account) {
  const fromSyncId = sanitizePathSegment(account?.syncId);
  if (fromSyncId) {
    return fromSyncId;
  }

  const fromNameServer = sanitizePathSegment(`${account?.name || ''}_${account?.server || ''}`);
  if (fromNameServer) {
    return fromNameServer;
  }

  const fromId = sanitizePathSegment(account?.id);
  if (fromId) {
    return fromId;
  }

  return `account_${Date.now()}`;
}

function getAccountSessionSnapshotPath(account) {
  return path.join(getRiotSessionVaultPath(), getAccountSessionKey(account));
}

function shouldIncludeRiotSessionPath(relativePath) {
  if (!relativePath || relativePath === '.') {
    return true;
  }

  const normalized = relativePath.split(path.sep).join('/');
  const firstSegment = normalized.split('/')[0]?.toLowerCase();
  if (firstSegment && RIOT_SESSION_EXCLUDED_TOP_LEVEL.has(firstSegment)) {
    return false;
  }

  const fileName = path.basename(normalized).toLowerCase();
  if (RIOT_SESSION_EXCLUDED_FILE_NAMES.has(fileName)) {
    return false;
  }

  return true;
}

async function terminateRiotProcesses() {
  if (process.platform === 'win32') {
    await Promise.all(
      RIOT_WINDOWS_PROCESS_NAMES.map((processName) =>
        runCommand(`taskkill /T /IM "${processName}"`).catch(() => undefined)
      )
    );

    await delay(500);

    await Promise.all(
      RIOT_WINDOWS_PROCESS_NAMES.map(async (processName) => {
        const result = await runCommand(`tasklist /FI "IMAGENAME eq ${processName}" /NH`).catch(
          () => ({ stdout: '' })
        );
        if (result.stdout.toLowerCase().includes(processName.toLowerCase())) {
          await runCommand(`taskkill /F /T /IM "${processName}"`).catch(() => undefined);
        }
      })
    );

    await delay(250);
    return;
  }

  if (process.platform === 'darwin') {
    await runCommand("pkill -f 'Riot Client|LeagueClient'").catch(() => undefined);
  }
}

async function captureRiotSessionSnapshot(account) {
  const roamingSourceDir = getRiotProfilePath();
  const localDataSourceDir = getRiotLocalDataPath();
  const localConfigSourceFile = path.join(
    getRiotLocalConfigPath(),
    RIOT_LOCAL_CONFIG_SETTINGS_FILE_NAME
  );
  const snapshotKey = getAccountSessionKey(account);

  const hasRoamingProfile = await pathExists(roamingSourceDir);
  const hasLocalData = await pathExists(localDataSourceDir);
  const hasLocalConfig = await pathExists(localConfigSourceFile);

  if (!hasRoamingProfile && !hasLocalData && !hasLocalConfig) {
    throw new Error(
      'No Riot session data was found. Sign in once before saving the session snapshot.'
    );
  }

  const snapshotDir = getAccountSessionSnapshotPath(account);
  const tempSnapshotDir = `${snapshotDir}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.log(`[Riot Session] Capturing snapshot for key: ${snapshotKey}`);

  await fs.promises.mkdir(getRiotSessionVaultPath(), { recursive: true });
  await removePathWithRetry(tempSnapshotDir);

  const roamingSnapshotDir = path.join(tempSnapshotDir, RIOT_SESSION_SNAPSHOT_ROAMING_SUBDIR);
  const localDataSnapshotDir = path.join(tempSnapshotDir, RIOT_SESSION_SNAPSHOT_LOCAL_DATA_SUBDIR);
  const localConfigSnapshotDir = path.join(
    tempSnapshotDir,
    RIOT_SESSION_SNAPSHOT_LOCAL_CONFIG_SUBDIR
  );

  if (hasRoamingProfile) {
    await copyDirectoryFiltered(roamingSourceDir, roamingSnapshotDir, (entryPath) => {
      const relative = path.relative(roamingSourceDir, entryPath);
      return shouldIncludeRiotSessionPath(relative);
    });
  }

  if (hasLocalData) {
    await copyDirectoryFiltered(localDataSourceDir, localDataSnapshotDir, () => true);
  }

  if (hasLocalConfig) {
    await fs.promises.mkdir(localConfigSnapshotDir, { recursive: true });
    await fs.promises.copyFile(
      localConfigSourceFile,
      path.join(localConfigSnapshotDir, RIOT_LOCAL_CONFIG_SETTINGS_FILE_NAME)
    );
  }

  const metadata = {
    capturedAt: Date.now(),
    hasRoamingProfile,
    hasLocalData,
    hasLocalConfig,
  };
  await fs.promises.writeFile(
    path.join(tempSnapshotDir, RIOT_SESSION_SNAPSHOT_META_FILE),
    JSON.stringify(metadata, null, 2),
    'utf8'
  );

  await removePathWithRetry(snapshotDir);
  await fs.promises.rename(tempSnapshotDir, snapshotDir);

  console.log(
    `[Riot Session] Snapshot captured for key ${snapshotKey}. Roaming: ${hasRoamingProfile}, LocalData: ${hasLocalData}, LocalConfig: ${hasLocalConfig}`
  );

  return { snapshotDir };
}

async function restoreSnapshotDirectory(snapshotSourceDir, targetDir) {
  const tempRestoreDir = `${targetDir}.restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
  await removePathWithRetry(tempRestoreDir);
  await copyDirectoryFiltered(snapshotSourceDir, tempRestoreDir, () => true);
  await removePathWithRetry(targetDir);
  await fs.promises.rename(tempRestoreDir, targetDir);
}

async function restoreRiotSessionSnapshot(account) {
  const snapshotKey = getAccountSessionKey(account);
  const snapshotDir = getAccountSessionSnapshotPath(account);
  if (!(await pathExists(snapshotDir))) {
    console.warn(`[Riot Session] No snapshot found for key: ${snapshotKey}`);
    return { restored: false };
  }

  console.log(`[Riot Session] Restoring snapshot for key: ${snapshotKey}`);

  const roamingSnapshotDir = path.join(snapshotDir, RIOT_SESSION_SNAPSHOT_ROAMING_SUBDIR);
  const localDataSnapshotDir = path.join(snapshotDir, RIOT_SESSION_SNAPSHOT_LOCAL_DATA_SUBDIR);
  const localConfigSnapshotDir = path.join(snapshotDir, RIOT_SESSION_SNAPSHOT_LOCAL_CONFIG_SUBDIR);
  const localConfigSnapshotFile = path.join(
    localConfigSnapshotDir,
    RIOT_LOCAL_CONFIG_SETTINGS_FILE_NAME
  );

  const hasRoamingProfile = await pathExists(roamingSnapshotDir);
  const hasLocalData = await pathExists(localDataSnapshotDir);
  const hasLocalConfig = await pathExists(localConfigSnapshotFile);

  if (!hasRoamingProfile && !hasLocalData && !hasLocalConfig) {
    console.warn(`[Riot Session] Snapshot exists but no data subfolders for key: ${snapshotKey}`);
    return { restored: false };
  }

  if (hasRoamingProfile) {
    await restoreSnapshotDirectory(roamingSnapshotDir, getRiotProfilePath());
  }

  if (hasLocalData) {
    await restoreSnapshotDirectory(localDataSnapshotDir, getRiotLocalDataPath());
  }

  if (hasLocalConfig) {
    const localConfigTargetDir = getRiotLocalConfigPath();
    await fs.promises.mkdir(localConfigTargetDir, { recursive: true });
    await fs.promises.copyFile(
      localConfigSnapshotFile,
      path.join(localConfigTargetDir, RIOT_LOCAL_CONFIG_SETTINGS_FILE_NAME)
    );
  }

  return {
    restored: true,
    restoredRoamingProfile: hasRoamingProfile,
    restoredLocalData: hasLocalData,
    restoredLocalConfig: hasLocalConfig,
  };
}

async function clearActiveRiotSessionProfile() {
  const roamingProfileDir = getRiotProfilePath();
  await removePathWithRetry(roamingProfileDir);
  await fs.promises.mkdir(roamingProfileDir, { recursive: true });

  const localDataDir = getRiotLocalDataPath();
  await removePathWithRetry(localDataDir);
  await fs.promises.mkdir(localDataDir, { recursive: true });
}

function launchRiotClient(riotClientPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(riotClientPath, RIOT_LAUNCH_ARGS, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    let settled = false;

    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.once('spawn', () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve();
      }
    });

    child.once('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(`Riot launcher exited with code ${code}`));
      }
    });
  });
}

function validateRiotClientPath(riotClientPath) {
  if (!riotClientPath || riotClientPath === 'undefined' || riotClientPath.trim() === '') {
    return 'Riot Client path is not set. Please set it in Settings.';
  }

  if (!fs.existsSync(riotClientPath)) {
    return `Riot Client not found at: ${riotClientPath}. Please update the path in Settings.`;
  }

  return null;
}

// Expose platform to renderer
ipcMain.handle('get-platform', () => process.platform);

// Handle account launch requests from renderer
ipcMain.handle('launch-account', async (event, accountData) => {
  const { account, riotClientPath, windowTitle } = accountData;

  const pathError = validateRiotClientPath(riotClientPath);
  if (pathError) {
    console.error(pathError);
    return { success: false, error: pathError };
  }

  if (isMac) return launchAccountMac(account, riotClientPath, windowTitle);
  return launchAccountWindows(account, accountData, riotClientPath, windowTitle);
});

ipcMain.handle('capture-account-session', async (event, payload = {}) => {
  const relaunch = payload?.relaunch !== false;
  const riotClientPath = payload?.riotClientPath;
  const account = payload?.account;

  if (!account || typeof account !== 'object') {
    return { success: false, error: 'Cannot save session without account data.' };
  }

  if (relaunch) {
    const pathError = validateRiotClientPath(riotClientPath);
    if (pathError) {
      console.error(pathError);
      return { success: false, error: pathError };
    }
  }

  try {
    await terminateRiotProcesses();
    await delay(250);
    await captureRiotSessionSnapshot(account);

    if (relaunch) {
      await launchRiotClient(riotClientPath);
    }

    return { success: true, capturedAt: Date.now(), relaunched: relaunch };
  } catch (error) {
    const message = error?.message || 'Unable to save Riot session snapshot.';
    console.error('Failed to capture Riot session snapshot:', error);
    return { success: false, error: message };
  }
});

ipcMain.handle('open-clean-riot-client', async (event, payload = {}) => {
  const riotClientPath = payload?.riotClientPath;
  const pathError = validateRiotClientPath(riotClientPath);
  if (pathError) {
    console.error(pathError);
    return { success: false, error: pathError };
  }

  try {
    await terminateRiotProcesses();
    await delay(250);
    await clearActiveRiotSessionProfile();
    await launchRiotClient(riotClientPath);
    return { success: true };
  } catch (error) {
    const message = error?.message || 'Unable to open Riot Client with a clean profile.';
    console.error('Failed to open clean Riot Client session:', error);
    return { success: false, error: message };
  }
});

// macOS launch using open command + AppleScript for auto-login
function launchAccountMac(account, riotClientPath, windowTitle) {
  const username = account?.username?.trim?.() || '';
  const password = account?.password?.trim?.() || '';
  if (!username || !password) {
    const error =
      'Launch failed on macOS: username/password are required for this flow. Save-session launch is currently Windows-only.';
    console.error(error);
    return { success: false, error };
  }

  return new Promise((resolve) => {
    // Determine launch command based on path type
    const isAppBundle = riotClientPath.endsWith('.app');
    const launchCmd = isAppBundle
      ? `open -a "${riotClientPath}" --args  --launch-patchline=live`
      : `"${riotClientPath}" --launch-patchline=live`;

    exec(launchCmd, (err) => {
      if (err) {
        console.error('Riot Client launch error:', err);
        resolve({
          success: false,
          error: 'Failed to launch Riot Client: ' + err.message,
        });
        return;
      }

      // Resolve path to macOS login script
      let scriptPath;
      if (app.isPackaged) {
        scriptPath = path.join(
          process.resourcesPath,
          'data',
          'core-actions',
          'login-action-mac.sh'
        );
      } else {
        scriptPath = path.resolve(__dirname, 'src/app/data/core-actions/login-action-mac.sh');
      }

      if (!fs.existsSync(scriptPath)) {
        console.warn('macOS login script not found, skipping auto-login:', scriptPath);
        resolve({
          success: true,
          warning:
            'Auto-login script not found. Riot Client launched but credentials were not entered automatically.',
        });
        return;
      }

      // Escape single quotes in args for shell
      const escapeShellArg = (val) => `'${String(val).replace(/'/g, "'\\''")}' `;

      const shCommand = [
        '/bin/bash',
        `"${scriptPath}"`,
        '-windowTitle',
        escapeShellArg(windowTitle || 'Riot Client'),
        '-username',
        escapeShellArg(account.username),
        '-password',
        escapeShellArg(account.password),
      ].join(' ');

      exec(shCommand, (error, stdout, stderr) => {
        if (error) {
          console.error('macOS login script error:', error);
          console.error('stderr:', stderr);
          resolve({
            success: false,
            error: 'Auto-login failed: ' + error.message,
          });
        } else {
          console.log('macOS login script output:', stdout);
          resolve({ success: true });
        }
      });
    });
  });
}

// Windows launch using PowerShell + NirCmd
async function launchAccountWindows(account, accountData, riotClientPath, windowTitle) {
  try {
    await terminateRiotProcesses();
    await delay(250);

    const restoreResult = await restoreRiotSessionSnapshot(account);
    if (restoreResult.restored) {
      await launchRiotClient(riotClientPath);
      return { success: true, usedSavedSession: true };
    }

    const username = account?.username?.trim?.() || '';
    const password = account?.password?.trim?.() || '';
    if (!username || !password) {
      const error =
        'Launch failed: no saved Riot session for this account. Sign in once with Stay signed in enabled, then click Save Session.';
      console.error(error);
      return { success: false, error };
    }

    return launchAccountWindowsWithCredentials(account, accountData, riotClientPath, windowTitle);
  } catch (error) {
    const message = error?.message || 'Failed to launch Riot Client with saved session.';
    console.error('Windows account launch failed:', error);
    return { success: false, error: message };
  }
}

function launchAccountWindowsWithCredentials(account, accountData, riotClientPath, windowTitle) {
  const { psFilePath, nircmdPath } = accountData;

  if (!app.isPackaged && (!psFilePath || !nircmdPath)) {
    const error = 'Launch scripts are missing for credential fallback mode.';
    console.error(error);
    return Promise.resolve({ success: false, error });
  }

  // Resolve absolute paths for PowerShell script and nircmd
  let absolutePsFilePath, absoluteNircmdPath;

  if (app.isPackaged) {
    const dataPath = path.join(process.resourcesPath, 'data');
    absolutePsFilePath = path.join(dataPath, 'core-actions', 'login-action.ps1');
    absoluteNircmdPath = path.join(dataPath, 'core-actions', 'nircmdc.exe');
  } else {
    absolutePsFilePath = path.resolve(__dirname, psFilePath);
    absoluteNircmdPath = path.resolve(__dirname, nircmdPath);
  }

  if (!fs.existsSync(absolutePsFilePath)) {
    const error = `PowerShell script not found: ${absolutePsFilePath}`;
    console.error(error);
    return Promise.resolve({ success: false, error });
  }

  if (!fs.existsSync(absoluteNircmdPath)) {
    const error = `NirCmd executable not found: ${absoluteNircmdPath}`;
    console.error(error);
    return Promise.resolve({ success: false, error });
  }

  return new Promise((resolve) => {
    launchRiotClient(riotClientPath)
      .then(() => {
        const quotePsArg = (value) => `"${String(value).replace(/"/g, '""')}"`;

        const psCommand = [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-STA',
          '-File',
          quotePsArg(absolutePsFilePath),
          '-nircmd',
          quotePsArg(absoluteNircmdPath),
          '-windowTitle',
          quotePsArg(windowTitle),
          '-username',
          quotePsArg(account.username),
          '-password',
          quotePsArg(account.password),
        ].join(' ');

        exec(psCommand, (error, stderr) => {
          if (error) {
            console.error('PowerShell script error:', error);
            console.error('stderr:', stderr);
            resolve({
              success: false,
              error: 'Auto-login failed: ' + error.message,
            });
          } else {
            resolve({ success: true, usedCredentialFallback: true });
          }
        });
      })
      .catch((err) => {
        if (err) {
          console.error('Riot Client launch error:', err);
          resolve({
            success: false,
            error: 'Failed to launch Riot Client: ' + err.message,
          });
          return;
        }
      });
  });
}

// Open file dialog for selecting executables (from renderer)
ipcMain.handle('open-file-dialog', async (event, options = {}) => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: options.title || 'Select Riot Client executable',
      defaultPath: options.defaultPath || undefined,
      properties: ['openFile'],
      filters: isMac
        ? [
            { name: 'Applications', extensions: ['app'] },
            { name: 'All Files', extensions: ['*'] },
          ]
        : [
            { name: 'Executables', extensions: ['exe'] },
            { name: 'All Files', extensions: ['*'] },
          ],
    });

    if (result.canceled) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: result.filePaths };
  } catch (error) {
    console.error('Error opening file dialog:', error);
    return { canceled: true, filePaths: [] };
  }
});

ipcMain.on('open-external-url', (event, url) => {
  console.log('Main process opening:', url);
  shell.openExternal(url);
});

function createGoogleAuthCallbackPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LoL Vault Sign-In</title>
    <style>
      :root {
        color-scheme: dark;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #111214;
        color: #ece7e2;
        font-family: 'Segoe UI', Roboto, sans-serif;
      }

      .panel {
        width: min(520px, calc(100vw - 28px));
        border-radius: 12px;
        border: 1px solid #3e3e42;
        background: #1a1b1f;
        padding: 20px;
        text-align: center;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 22px;
      }

      p {
        margin: 0;
        color: #bab7b2;
        font-size: 14px;
        line-height: 1.45;
      }

      .error {
        color: #ff8f8f;
      }
    </style>
  </head>
  <body>
    <div class="panel">
      <h1>LoL Vault</h1>
      <p id="status">Finishing sign-in...</p>
    </div>

    <script>
      (async function finalizeOAuth() {
        const status = document.getElementById('status');

        try {
          const hash = window.location.hash && window.location.hash.startsWith('#')
            ? window.location.hash.slice(1)
            : '';

          if (!hash) {
            throw new Error('Missing sign-in token in callback URL.');
          }

          const response = await fetch('/oauth-finish', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: hash,
          });

          if (!response.ok) {
            const details = await response.text();
            throw new Error(details || 'OAuth callback failed.');
          }

          status.textContent = 'Sign-in complete. You can close this tab and return to LoL Vault.';
        } catch (error) {
          status.textContent = error && error.message ? error.message : 'Sign-in failed.';
          status.classList.add('error');
        }
      })();
    </script>
  </body>
</html>`;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    const maxBodySize = 32 * 1024;

    request.on('data', (chunk) => {
      totalLength += chunk.length;
      if (totalLength > maxBodySize) {
        reject(new Error('Callback payload exceeded allowed size.'));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Callback request was aborted.')));
  });
}

async function fetchGoogleAuthUri({ apiKey, continueUri }) {
  if (typeof fetch !== 'function') {
    throw new Error('Network fetch API is unavailable in this environment.');
  }

  const response = await fetch(
    `https://www.googleapis.com/identitytoolkit/v3/relyingparty/createAuthUri?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        continueUri,
        providerId: 'google.com',
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Auth URL request failed with status ${response.status}.`);
  }

  const data = await response.json();
  if (!data || typeof data.authUri !== 'string' || !data.authUri) {
    throw new Error('Auth URL response did not include a valid URL.');
  }

  return data.authUri;
}

function createSignInResult(success, { idToken, error } = {}) {
  return {
    success,
    ...(idToken ? { idToken } : {}),
    ...(error ? { error } : {}),
  };
}

ipcMain.handle('start-google-system-sign-in', async (_event, options = {}) => {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';

  if (!apiKey) {
    return createSignInResult(false, { error: 'Missing Firebase API key for Google sign-in.' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let expectedState = '';
    let timeoutHandle;

    const settle = (result) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }

      if (result.success && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }

      try {
        server.close();
      } catch {
        // ignore close errors
      }

      resolve(result);
    };

    const server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');

        if (request.method === 'GET' && requestUrl.pathname === '/callback') {
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(createGoogleAuthCallbackPage());
          return;
        }

        if (request.method === 'POST' && requestUrl.pathname === '/oauth-finish') {
          const body = await readRequestBody(request);
          const params = new URLSearchParams(body);

          const oauthError = params.get('error');
          const oauthErrorDescription = params.get('error_description');
          const state = params.get('state') || '';
          const idToken = params.get('id_token');

          if (oauthError) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Google sign-in was cancelled or failed.');
            settle(
              createSignInResult(false, {
                error: oauthErrorDescription || oauthError,
              })
            );
            return;
          }

          if (expectedState && state !== expectedState) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('OAuth state validation failed.');
            settle(createSignInResult(false, { error: 'OAuth state validation failed.' }));
            return;
          }

          if (!idToken) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Missing id_token from Google callback.');
            settle(createSignInResult(false, { error: 'Missing id_token in Google callback.' }));
            return;
          }

          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('ok');
          settle(createSignInResult(true, { idToken }));
          return;
        }

        if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
          response.writeHead(204);
          response.end();
          return;
        }

        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Internal callback error.');
        settle(
          createSignInResult(false, {
            error: error instanceof Error ? error.message : 'OAuth callback failed unexpectedly.',
          })
        );
      }
    });

    server.on('error', (error) => {
      const addressInUse =
        !!error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE';

      settle(
        createSignInResult(false, {
          error: addressInUse
            ? `OAuth callback port ${GOOGLE_SYSTEM_AUTH_CALLBACK_PORT} is already in use. Close the other process or set GOOGLE_SYSTEM_AUTH_CALLBACK_PORT to a free port.`
            : error instanceof Error
              ? error.message
              : 'Could not start OAuth callback server.',
        })
      );
    });

    server.listen(
      GOOGLE_SYSTEM_AUTH_CALLBACK_PORT,
      GOOGLE_SYSTEM_AUTH_CALLBACK_BIND_ADDRESS,
      async () => {
        try {
          const address = server.address();
          if (!address || typeof address === 'string') {
            settle(
              createSignInResult(false, { error: 'Could not resolve callback server address.' })
            );
            return;
          }

          const continueUri = `http://${GOOGLE_SYSTEM_AUTH_CALLBACK_HOST}:${GOOGLE_SYSTEM_AUTH_CALLBACK_PORT}/callback`;
          const authUri = await fetchGoogleAuthUri({ apiKey, continueUri });

          try {
            expectedState = new URL(authUri).searchParams.get('state') || '';
          } catch {
            expectedState = '';
          }

          timeoutHandle = setTimeout(() => {
            settle(
              createSignInResult(false, {
                error: `Google sign-in timed out. Verify OAuth redirect URI http://${GOOGLE_SYSTEM_AUTH_CALLBACK_HOST}:${GOOGLE_SYSTEM_AUTH_CALLBACK_PORT}/callback is allowed for the Google client.`,
              })
            );
          }, GOOGLE_SYSTEM_AUTH_TIMEOUT_MS);

          await shell.openExternal(authUri);
        } catch (error) {
          settle(
            createSignInResult(false, {
              error: error instanceof Error ? error.message : 'Failed to start Google sign-in.',
            })
          );
        }
      }
    );
  });
});

/**
 * Runtime files that used to live in `src/app/data` and now belong in
 * `.dev-data`. Everything *not* listed here (champions.json, item.json,
 * core-actions/…) is bundled static content and stays in the source tree.
 */
const DEV_RUNTIME_ENTRIES = [
  'lolvault.db',
  'lolvault.db-wal',
  'lolvault.db-shm',
  'accounts.json',
  'boards.json',
  RIOT_SESSION_VAULT_DIR_NAME,
];

const LEGACY_DEV_DATA_PATH = path.join(__dirname, 'src', 'app', 'data');
const DEV_DATA_PATH = path.join(__dirname, '.dev-data');

/**
 * Copies runtime data out of the source tree on first run after the move.
 *
 * Non-destructive on both ends: nothing is copied over an existing file, and
 * the originals are left alone. A dev who rolls back to an older build still
 * finds their vault where it was.
 */
let devDataMigrated = false;

function migrateDevDataOnce() {
  if (devDataMigrated) return;
  devDataMigrated = true;

  try {
    if (!fs.existsSync(LEGACY_DEV_DATA_PATH)) return;
    if (!fs.existsSync(DEV_DATA_PATH)) fs.mkdirSync(DEV_DATA_PATH, { recursive: true });

    for (const entry of DEV_RUNTIME_ENTRIES) {
      const from = path.join(LEGACY_DEV_DATA_PATH, entry);
      const to = path.join(DEV_DATA_PATH, entry);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.cpSync(from, to, { recursive: true });
      console.log('[dev-data] migrated', entry);
    }
  } catch (err) {
    console.warn('[dev-data] migration skipped:', err?.message);
  }
}

// Helper function to get the correct data path
function getDataPath() {
  if (app.isPackaged) {
    if (isMac) {
      // On macOS, always use Application Support for data persistence
      return path.join(app.getPath('userData'), 'data');
    }

    // For portable exe, check if we're running from a temp extracted location
    // If so, use a persistent location instead
    const exeDir = path.dirname(process.execPath);

    // Check if we're in a temp directory (portable exe extracts to temp)
    if (exeDir.includes('\\AppData\\Local\\Temp\\') || exeDir.includes('\\Temp\\')) {
      // Use a persistent location in Local AppData for portable mode
      const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
      return path.join(localAppData, 'LoL Vault', 'data');
    }

    // Otherwise, store data next to the executable
    return path.join(exeDir, 'data');
  }

  // Development. Deliberately NOT `src/app/data`, even though that is where the
  // bundled static JSON lives.
  //
  // `ng serve` watches the whole source tree. The SQLite database is written on
  // every persisted match, so with the database inside `src/` a year backfill
  // — hundreds of writes, one per game — triggered hundreds of dev-server
  // rebuilds, each of which reloads the renderer. The analytics screen appeared
  // to "keep refreshing" for the entire fetch, because it genuinely was being
  // torn down and rebuilt from scratch, over and over.
  //
  // Runtime state therefore lives outside the watched tree entirely.
  //
  // Falls back to userData if that directory cannot be created. `__dirname` is
  // only writable when the app is running from a checkout; load the same code
  // from inside an asar and the mkdir fails with ENOTDIR. Startup must not
  // depend on that — this function is called from an async bootstrap, so
  // throwing here takes down the whole app before it opens a window.
  try {
    migrateDevDataOnce();
    if (!fs.existsSync(DEV_DATA_PATH)) fs.mkdirSync(DEV_DATA_PATH, { recursive: true });
    return DEV_DATA_PATH;
  } catch (err) {
    const fallback = path.join(app.getPath('userData'), 'data');
    console.warn(`[dev-data] ${DEV_DATA_PATH} unusable (${err?.message}); using ${fallback}`);
    return fallback;
  }
}

// Handle loading accounts
ipcMain.handle('load-accounts', async () => {
  try {
    const dataPath = getDataPath();
    const accountsPath = path.join(dataPath, 'accounts.json');

    // Ensure the data directory exists
    if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });

    // If accounts.json doesn't exist, create it with an empty array
    if (!fs.existsSync(accountsPath)) {
      fs.writeFileSync(accountsPath, '[]', 'utf8');
      return [];
    }

    const data = fs.readFileSync(accountsPath, 'utf8');
    const accounts = JSON.parse(data);

    // Try to decrypt accounts, but if all fail, might need to reset
    const decryptedAccounts = accounts.map(decryptAccount);
    return decryptedAccounts;
  } catch (error) {
    console.error('Error loading accounts:', error);
    return [];
  }
});

// Handle saving accounts
ipcMain.handle('save-accounts', async (event, accounts) => {
  try {
    if (!Array.isArray(accounts)) {
      console.error(
        'save-accounts received non-array data, rejecting save. Type:',
        typeof accounts,
        'Keys:',
        Object.keys(accounts || {}).slice(0, 5)
      );
      return { success: false, error: 'Invalid data: accounts must be an array' };
    }

    const dataPath = getDataPath();
    const accountsPath = path.join(dataPath, 'accounts.json');

    // Ensure the data directory exists
    if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });

    const encryptedAccounts = accounts.map(encryptAccount);
    fs.writeFileSync(accountsPath, JSON.stringify(encryptedAccounts, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Error saving accounts:', error);
    return { success: false, error: error.message };
  }
});

// Handle loading boards
ipcMain.handle('load-boards', async () => {
  try {
    const dataPath = getDataPath();
    const boardsPath = path.join(dataPath, 'boards.json');

    // Ensure the data directory exists
    if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });

    // If boards.json doesn't exist, create it with an empty array
    if (!fs.existsSync(boardsPath)) {
      fs.writeFileSync(boardsPath, '[]', 'utf8');
      return [];
    }

    const data = fs.readFileSync(boardsPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading boards:', error);
    return [];
  }
});

// Handle saving boards
ipcMain.handle('save-boards', async (event, boards) => {
  try {
    if (!Array.isArray(boards)) {
      console.error('save-boards received non-array data, rejecting save.');
      return { success: false, error: 'Invalid data: boards must be an array' };
    }

    const dataPath = getDataPath();
    const boardsPath = path.join(dataPath, 'boards.json');

    // Ensure the data directory exists
    if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });

    fs.writeFileSync(boardsPath, JSON.stringify(boards, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Error saving boards:', error);
    return { success: false, error: error.message };
  }
});

// ── SQLite Database IPC Handlers ──────────────────────────────────────────────

// App Settings — encrypted Riot API key
ipcMain.handle('lcu:get-state', () => getLcuState());

ipcMain.handle('db-get-api-key', () => {
  try {
    return { success: true, value: db.getEncryptedSetting('riot_api_key') };
  } catch (error) {
    console.error('db-get-api-key error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db-set-api-key', (_event, apiKey) => {
  try {
    db.setEncryptedSetting('riot_api_key', apiKey || null);
    return { success: true };
  } catch (error) {
    console.error('db-set-api-key error:', error);
    return { success: false, error: error.message };
  }
});

// Generic setting get/set (plaintext)
ipcMain.handle('db-get-setting', (_event, key) => {
  try {
    return { success: true, value: db.getSetting(key) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db-set-setting', (_event, key, value) => {
  try {
    db.setSetting(key, value);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// LP Snapshots
ipcMain.handle('db-get-lp-snapshots', (_event, accountId) => {
  try {
    return { success: true, snapshots: db.getLpSnapshots(accountId) };
  } catch (error) {
    console.error('db-get-lp-snapshots error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db-save-lp-snapshot', (_event, { accountId, tier, division, lp }) => {
  try {
    db.saveLpSnapshot(accountId, tier, division, lp);
    return { success: true };
  } catch (error) {
    console.error('db-save-lp-snapshot error:', error);
    return { success: false, error: error.message };
  }
});

// Daily rank series
ipcMain.handle('db-get-rank-snapshots', (_event, accountId, queue) => {
  try {
    return { success: true, snapshots: db.getRankSnapshots(accountId, queue ?? 'RANKED_SOLO_5x5') };
  } catch (error) {
    console.error('db-get-rank-snapshots error:', error);
    return { success: false, error: error.message, snapshots: [] };
  }
});

ipcMain.handle('db-record-rank-snapshot', (_event, { accountId, queue, entry }) => {
  try {
    db.recordRankSnapshot(accountId, queue, entry);
    return { success: true };
  } catch (error) {
    console.error('db-record-rank-snapshot error:', error);
    return { success: false, error: error.message };
  }
});

// Match Cache
ipcMain.handle('db-get-match-cache', (_event, accountId, limit) => {
  try {
    return { success: true, matches: db.getMatchCache(accountId, limit) };
  } catch (error) {
    console.error('db-get-match-cache error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db-save-match', (_event, { matchId, accountId, computed, rawJson }) => {
  try {
    db.saveMatchCache(matchId, accountId, computed || {}, rawJson);
    return { success: true };
  } catch (error) {
    console.error('db-save-match error:', error);
    return { success: false, error: error.message };
  }
});

// ── Riot API ──────────────────────────────────────────────────────────────────

ipcMain.handle('riot:get-summoner-by-riot-id', async (_event, { gameName, tagLine, platform }) => {
  try {
    return await riotApi.getSummonerByRiotId(gameName, tagLine, platform);
  } catch (err) {
    console.error('riot:get-summoner-by-riot-id error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
});

ipcMain.handle('riot:get-summoner-by-puuid', async (_event, { puuid, platform }) => {
  try {
    return await riotApi.getSummonerByPuuid(puuid, platform);
  } catch (err) {
    console.error('riot:get-summoner-by-puuid error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
});

ipcMain.handle('riot:get-ranked-by-puuid', async (_event, { puuid, platform }) => {
  try {
    return await riotApi.getRankedByPuuid(puuid, platform);
  } catch (err) {
    console.error('riot:get-ranked-by-puuid error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
});

ipcMain.handle('riot:get-top-mastery', async (_event, { puuid, platform }) => {
  try {
    return await riotApi.getTopMasteryChampions(puuid, platform);
  } catch (err) {
    console.error('riot:get-top-mastery error:', err?.message);
    return [];
  }
});

ipcMain.handle('riot:get-match-history', async (_event, { accountId, puuid, platform, count }) => {
  try {
    return await riotApi.fetchAndCacheMatchHistory(accountId, puuid, platform, count);
  } catch (err) {
    console.error('riot:get-match-history error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
});

ipcMain.handle('riot:purge-foreign-matches', (_event, { accountId, puuid }) => {
  try {
    return { removed: db.purgeForeignMatchRows(accountId, puuid) };
  } catch (err) {
    console.error('riot:purge-foreign-matches error:', err?.message);
    return { removed: 0 };
  }
});

ipcMain.handle('riot:get-cached-matches', (_event, { accountId, limit }) => {
  try {
    return db.getMatchCache(accountId, limit);
  } catch (err) {
    console.error('riot:get-cached-matches error:', err?.message);
    return [];
  }
});

ipcMain.handle('riot:validate-key', async (_event, { key }) => {
  try {
    return await riotApi.validateApiKey(key);
  } catch (err) {
    console.error('riot:validate-key error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
});

ipcMain.handle('riot:save-key', (_event, { key }) => {
  try {
    riotApi.saveApiKey(key);
    return { success: true };
  } catch (err) {
    console.error('riot:save-key error:', err?.message);
    return { success: false, error: err?.message };
  }
});

ipcMain.handle('riot:get-ddragon-version', async () => {
  try {
    return await riotApi.getDDragonVersion();
  } catch (err) {
    console.error('riot:get-ddragon-version error:', err?.message);
    return '15.21.1';
  }
});

ipcMain.handle('riot:get-match-timeline', async (_event, { matchId, platform }) => {
  try {
    return await riotApi.getMatchTimeline(matchId, platform, { interactive: true });
  } catch (err) {
    console.error('riot:get-match-timeline error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
});

ipcMain.handle('riot:get-match-detail', async (_event, { matchId, accountId, puuid, platform }) => {
  try {
    return await riotApi.getMatchDetailCached(matchId, accountId, puuid, platform);
  } catch (err) {
    console.error('riot:get-match-detail error:', err?.message);
    return { error: err?.message || 'unknown' };
  }
});

// Backfill runs for minutes, so progress is pushed to the renderer as it goes
// and cancellation is a flag the loop checks between matches.
const backfillCancelled = new Set();
const yearHistoryCancelled = new Set();

ipcMain.handle('riot:cancel-backfill', (_event, { accountId }) => {
  backfillCancelled.add(accountId);
  return { success: true };
});

ipcMain.handle(
  'riot:backfill-match-data',
  async (event, { accountId, puuid, platform, limit }) => {
    backfillCancelled.delete(accountId);
    try {
      return await riotApi.backfillMatchData(accountId, puuid, platform, {
        limit,
        shouldCancel: () => backfillCancelled.has(accountId),
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('riot:backfill-progress', { accountId, ...progress });
          }
        },
      });
    } catch (err) {
      console.error('riot:backfill-match-data error:', err?.message);
      return { error: err?.message || 'unknown' };
    } finally {
      backfillCancelled.delete(accountId);
    }
  }
);

ipcMain.handle('riot:cancel-year-history', (_event, { accountId }) => {
  yearHistoryCancelled.add(accountId);
  return { success: true };
});

ipcMain.handle(
  'riot:fetch-year-history',
  async (event, { accountId, puuid, platform, year, queue }) => {
    yearHistoryCancelled.delete(accountId);
    try {
      return await riotApi.fetchYearHistory(accountId, puuid, platform, {
        year,
        // Undefined means every mode; the heatmap asks for ranked solo only.
        queue: queue ?? undefined,
        shouldCancel: () => yearHistoryCancelled.has(accountId),
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('riot:year-history-progress', { accountId, year, ...progress });
          }
        },
        // Games are pushed as they land so the page fills in during the sweep
        // rather than replacing everything at the end.
        onRows: (rows) => {
          if (rows?.length && !event.sender.isDestroyed()) {
            event.sender.send('riot:year-history-rows', { accountId, year, rows });
          }
        },
      });
    } catch (err) {
      console.error('riot:fetch-year-history error:', err?.message);
      return { error: err?.message || 'unknown' };
    } finally {
      yearHistoryCancelled.delete(accountId);
    }
  }
);

ipcMain.handle('riot:get-backfill-status', (_event, { accountId }) => {
  try {
    const pending = db.getMatchesNeedingBackfill(accountId, 500);
    const requests = pending.reduce(
      (n, m) => n + (m.has_detail ? 0 : 1) + (m.has_timeline ? 0 : 1),
      0
    );
    return {
      pendingMatches: pending.length,
      pendingRequests: requests,
      etaSeconds: rateLimiter.estimateSeconds(requests),
    };
  } catch (err) {
    console.error('riot:get-backfill-status error:', err?.message);
    return { pendingMatches: 0, pendingRequests: 0, etaSeconds: 0 };
  }
});

// ── Persistent game settings ─────────────────────────────────────────────────
//
// League rewrites its Config files whenever the client signs a different
// account in. Flipping the well-known settings files to read-only keeps the
// user's own configuration in place across account switches.

const LEAGUE_PERSISTENT_SETTINGS_FILES = [
  'PersistedSettings.json',
  'game.cfg',
  'input.ini',
];

function resolveLeagueConfigFiles(configPath) {
  return LEAGUE_PERSISTENT_SETTINGS_FILES.map((name) => path.join(configPath, name)).filter(
    (filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    }
  );
}

function isFileReadOnly(filePath) {
  try {
    // Windows maps the read-only attribute onto the owner-write permission bit.
    return (fs.statSync(filePath).mode & 0o200) === 0;
  } catch {
    return false;
  }
}

ipcMain.handle('settings:inspect-league-config', async (_event, { configPath } = {}) => {
  try {
    if (!configPath) {
      return { success: false, error: 'No League config folder provided.' };
    }

    let exists = false;
    try {
      exists = fs.statSync(configPath).isDirectory();
    } catch {
      exists = false;
    }

    if (!exists) {
      return { success: true, exists: false, files: [], readOnly: false };
    }

    const files = resolveLeagueConfigFiles(configPath);
    return {
      success: true,
      exists: true,
      files: files.map((filePath) => ({
        path: filePath,
        name: path.basename(filePath),
        readOnly: isFileReadOnly(filePath),
      })),
      readOnly: files.length > 0 && files.every((filePath) => isFileReadOnly(filePath)),
    };
  } catch (error) {
    console.error('settings:inspect-league-config error:', error?.message);
    return { success: false, error: error?.message || 'Failed to inspect League config folder.' };
  }
});

ipcMain.handle('settings:set-league-config-readonly', async (_event, payload = {}) => {
  const { configPath, readOnly } = payload;

  try {
    if (!configPath) {
      return { success: false, error: 'No League config folder provided.' };
    }

    let isDirectory = false;
    try {
      isDirectory = fs.statSync(configPath).isDirectory();
    } catch {
      isDirectory = false;
    }

    if (!isDirectory) {
      return {
        success: false,
        error: `League config folder not found at "${configPath}". Pick the correct folder in Settings.`,
      };
    }

    const files = resolveLeagueConfigFiles(configPath);

    if (files.length === 0) {
      return {
        success: false,
        error:
          'No League settings files found in that folder. Launch League once so it writes its config, then try again.',
      };
    }

    const changed = [];
    const failed = [];

    for (const filePath of files) {
      try {
        fs.chmodSync(filePath, readOnly ? 0o444 : 0o666);
        changed.push(path.basename(filePath));
      } catch (error) {
        console.error(`Failed to update read-only flag for ${filePath}:`, error?.message);
        failed.push(path.basename(filePath));
      }
    }

    if (changed.length === 0) {
      return {
        success: false,
        error: `Could not change the read-only flag on ${failed.join(', ')}. Try running LoL Vault as administrator.`,
      };
    }

    return {
      success: true,
      readOnly: !!readOnly,
      files: changed,
      failed,
      warning: failed.length ? `Skipped ${failed.join(', ')} — permission denied.` : undefined,
    };
  } catch (error) {
    console.error('settings:set-league-config-readonly error:', error?.message);
    return { success: false, error: error?.message || 'Failed to update League config files.' };
  }
});

// Directory picker — used to locate the League config folder
ipcMain.handle('open-directory-dialog', async (_event, options = {}) => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: options.title || 'Select folder',
      defaultPath: options.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: result.filePaths };
  } catch (error) {
    console.error('Error opening directory dialog:', error);
    return { canceled: true, filePaths: [] };
  }
});
