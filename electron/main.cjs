const { app, BrowserWindow } = require("electron");
const path = require("path");
const http = require("http");
const { fork } = require("child_process");

const PORT = process.env.CAYA_PORT || 3001;

let serverProcess = null;
let mainWindow = null;

/** app.getAppPath() resolves correctly whether packed in app.asar, unpacked under resources/app, or dev repo root. */
function resourceRoot() {
  return app.getAppPath();
}

function waitForServer(attempt = 0) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/state", timeout: 1000 }, () => resolve());
    req.on("error", () => {
      if (attempt > 60) return reject(new Error("CaYa server did not start in time"));
      setTimeout(() => resolve(waitForServer(attempt + 1)), 250);
    });
    req.end();
  });
}

function startServer() {
  const serverEntry = path.join(resourceRoot(), "server", "dist", "index.js");
  const dataDir = path.join(app.getPath("userData"), "data");

  serverProcess = fork(serverEntry, [], {
    env: { ...process.env, CAYA_PORT: String(PORT), CAYA_HOST: "127.0.0.1", CAYA_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  serverProcess.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on("exit", (code) => {
    if (code && code !== 0) console.error(`CaYa server exited with code ${code}`);
  });

  return waitForServer();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#09090b",
    autoHideMenuBar: true,
    icon: path.join(resourceRoot(), "build", "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error("Failed to start Minecraft CaYa Bot Panel server:", err);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
