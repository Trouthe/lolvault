const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { exec } = require("child_process");
const fs = require("fs");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Load the Angular app
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL("http://localhost:4200");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(
      path.join(__dirname, "dist/lolvault/browser/index.html")
    );
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Handle account launch requests from renderer
ipcMain.handle("launch-account", async (event, accountData) => {
  const { account, riotClientPath, psFilePath, nircmdPath, windowTitle } =
    accountData;

  // Resolve absolute paths for PowerShell script and nircmd
  const absolutePsFilePath = path.resolve(__dirname, psFilePath);
  const absoluteNircmdPath = path.resolve(__dirname, nircmdPath);

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
    console.log("Executing Riot Client command...");
    exec(
      `"${riotClientPath}" --launch-product=league_of_legends --launch-patchline=live`,
      (err) => {
        if (err) {
          console.error("Riot Client launch error:", err);
          resolve({
            success: false,
            error: "Failed to launch Riot Client: " + err.message,
          });
          return;
        }

        console.log(
          "Riot Client launched successfully, running PowerShell script..."
        );

        // Run PowerShell script for auto-login
        const psCommand = `powershell -ExecutionPolicy Bypass -Command "& { . '${absolutePsFilePath}' -nircmd '${absoluteNircmdPath}' -windowTitle '${windowTitle}' -username '${account.username}' -password '${account.password}' }"`;
        console.log("PowerShell command:", psCommand);

        exec(psCommand, (error, stdout, stderr) => {
          if (error) {
            console.error("PowerShell script error:", error);
            console.error("stderr:", stderr);
            resolve({
              success: false,
              error: "Auto-login failed: " + error.message,
            });
          } else {
            console.log("PowerShell script completed successfully");
            console.log("stdout:", stdout);
            resolve({ success: true });
          }
        });
      }
    );
  });
});

// Handle loading accounts
ipcMain.handle("load-accounts", async () => {
  try {
    const accountsPath = path.join(__dirname, "src/app/data/accounts.json");
    const data = fs.readFileSync(accountsPath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error loading accounts:", error);
    return [];
  }
});
