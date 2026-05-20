const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const { dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');

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
  createWindow();
  setupAutoUpdater();
});

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

// Expose platform to renderer
ipcMain.handle('get-platform', () => process.platform);

// Handle account launch requests from renderer
ipcMain.handle('launch-account', async (event, accountData) => {
  const { account, riotClientPath, windowTitle } = accountData;

  // Validate Riot Client path
  if (!riotClientPath || riotClientPath === 'undefined' || riotClientPath.trim() === '') {
    const error = 'Riot Client path is not set. Please set it in Settings.';
    console.error(error);
    return { success: false, error };
  }

  // On macOS, check for .app bundle or direct path
  if (isMac) {
    const isAppBundle = riotClientPath.endsWith('.app');
    const pathToCheck = isAppBundle ? riotClientPath : riotClientPath;
    if (!fs.existsSync(pathToCheck)) {
      const error = `Riot Client not found at: ${riotClientPath}. Please update the path in Settings.`;
      console.error(error);
      return { success: false, error };
    }
  } else {
    if (!fs.existsSync(riotClientPath)) {
      const error = `Riot Client not found at: ${riotClientPath}. Please update the path in Settings.`;
      console.error(error);
      return { success: false, error };
    }
  }

  if (isMac) return launchAccountMac(account, riotClientPath, windowTitle);
  else return launchAccountWindows(account, accountData, riotClientPath, windowTitle);
});

// macOS launch using open command + AppleScript for auto-login
function launchAccountMac(account, riotClientPath, windowTitle) {
  return new Promise((resolve) => {
    // Determine launch command based on path type
    const isAppBundle = riotClientPath.endsWith('.app');
    const launchCmd = isAppBundle
      ? `open -a "${riotClientPath}" --args --launch-product=league_of_legends --launch-patchline=live`
      : `"${riotClientPath}" --launch-product=league_of_legends --launch-patchline=live`;

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
function launchAccountWindows(account, accountData, riotClientPath, windowTitle) {
  const { psFilePath, nircmdPath } = accountData;

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
    exec(
      `"${riotClientPath}" --launch-product=league_of_legends --launch-patchline=live`,
      (err) => {
        if (err) {
          console.error('Riot Client launch error:', err);
          resolve({
            success: false,
            error: 'Failed to launch Riot Client: ' + err.message,
          });
          return;
        }

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
            resolve({ success: true });
          }
        });
      }
    );
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
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EADDRINUSE';

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

    server.listen(GOOGLE_SYSTEM_AUTH_CALLBACK_PORT, GOOGLE_SYSTEM_AUTH_CALLBACK_BIND_ADDRESS, async () => {
      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          settle(createSignInResult(false, { error: 'Could not resolve callback server address.' }));
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
    });
  });
});

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
  } else {
    // In development, use the src/app/data directory
    return path.join(__dirname, 'src/app/data');
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
