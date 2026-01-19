const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const { dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Handle account launch requests from renderer
ipcMain.handle('launch-account', async (accountData) => {
  const { account, riotClientPath, psFilePath, nircmdPath, windowTitle } = accountData;

  // Resolve absolute paths for PowerShell script and nircmd
  let absolutePsFilePath, absoluteNircmdPath;

  if (app.isPackaged) {
    // In production, these files should be in the resources/data directory
    const dataPath = path.join(process.resourcesPath, 'data');
    absolutePsFilePath = path.join(dataPath, 'core-actions', 'login-action.ps1');
    absoluteNircmdPath = path.join(dataPath, 'core-actions', 'nircmdc.exe');
  } else {
    // In development, use the paths as provided
    absolutePsFilePath = path.resolve(__dirname, psFilePath);
    absoluteNircmdPath = path.resolve(__dirname, nircmdPath);
  }

  // Check if files exist
  if (!fs.existsSync(absolutePsFilePath)) {
    const error = `PowerShell script not found: ${absolutePsFilePath}`;
    console.error(error);
    return { success: false, error };
  }

  if (!fs.existsSync(absoluteNircmdPath)) {
    const error = `NirCmd executable not found: ${absoluteNircmdPath}`;
    console.error(error);
    return { success: false, error };
  }

  return new Promise((resolve) => {
    // Launch Riot Client
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

        // Run PowerShell script for auto-login
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
});

// Open file dialog for selecting executables (from renderer)
ipcMain.handle('open-file-dialog', async (options = {}) => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: options.title || 'Select Riot Client executable',
      defaultPath: options.defaultPath || undefined,
      properties: ['openFile'],
      filters: [
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

// Helper function to get the correct data path
function getDataPath() {
  if (app.isPackaged) {
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
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath, { recursive: true });
    }

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
ipcMain.handle('save-accounts', async (accounts) => {
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
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath, { recursive: true });
    }

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
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath, { recursive: true });
    }

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
ipcMain.handle('save-boards', async (boards) => {
  try {
    if (!Array.isArray(boards)) {
      console.error('save-boards received non-array data, rejecting save.');
      return { success: false, error: 'Invalid data: boards must be an array' };
    }

    const dataPath = getDataPath();
    const boardsPath = path.join(dataPath, 'boards.json');

    // Ensure the data directory exists
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath, { recursive: true });
    }

    fs.writeFileSync(boardsPath, JSON.stringify(boards, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Error saving boards:', error);
    return { success: false, error: error.message };
  }
});
