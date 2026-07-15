const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { fork } = require("child_process");

const DEFAULT_PORT = Number(process.env.CAYA_PORT || 3001);
const HOST = "127.0.0.1";

let serverProcess = null;
let mainWindow = null;
let chosenPort = DEFAULT_PORT;
let serverLogPath = null;
const serverLogLines = [];

function resourceRoot() {
  // Packaged: .../resources/app  |  Dev: repo root
  return app.getAppPath();
}

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  serverLogLines.push(line);
  if (serverLogLines.length > 400) serverLogLines.shift();
  try {
    if (serverLogPath) fs.appendFileSync(serverLogPath, line + "\n", "utf8");
  } catch {
    /* */
  }
  console.log(line);
}

function writeCrashLog() {
  try {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "last-startup.log");
    fs.writeFileSync(p, serverLogLines.join("\n") + "\n", "utf8");
    return p;
  } catch {
    return null;
  }
}

function showFatal(title, detail) {
  const logFile = writeCrashLog();
  const extra = logFile ? `\n\nLog: ${logFile}` : "";
  try {
    dialog.showErrorBox(title, `${detail}${extra}`);
  } catch {
    console.error(title, detail);
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = require("net").createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, HOST, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function pickPort() {
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 20; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port in ${DEFAULT_PORT}–${DEFAULT_PORT + 19}`);
}

function waitForServer(port, attempt = 0) {
  return new Promise((resolve, reject) => {
    if (serverProcess && serverProcess.exitCode != null) {
      return reject(
        new Error(`Server process exited early (code ${serverProcess.exitCode}). See log.`)
      );
    }
    const req = http.get(
      { host: HOST, port, path: "/api/state", timeout: 1500 },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
        } else if (attempt > 80) {
          reject(new Error(`Server HTTP ${res.statusCode}`));
        } else {
          setTimeout(() => resolve(waitForServer(port, attempt + 1)), 250);
        }
      }
    );
    req.on("error", () => {
      if (attempt > 80) {
        reject(new Error("Server did not become ready in time (~20s)"));
      } else {
        setTimeout(() => resolve(waitForServer(port, attempt + 1)), 250);
      }
    });
    req.on("timeout", () => {
      req.destroy();
    });
  });
}

function startServer(port) {
  const root = resourceRoot();
  const serverEntry = path.join(root, "server", "dist", "index.js");
  const dataDir = path.join(app.getPath("userData"), "data");

  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Server entry not found:\n${serverEntry}`);
  }
  const webIndex = path.join(root, "web", "dist", "index.html");
  if (!fs.existsSync(webIndex)) {
    logLine(`WARN: web dist missing at ${webIndex}`);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  serverLogPath = path.join(app.getPath("userData"), "server-console.log");
  try {
    fs.writeFileSync(serverLogPath, "", "utf8");
  } catch {
    /* */
  }

  logLine(`resourceRoot=${root}`);
  logLine(`serverEntry=${serverEntry}`);
  logLine(`dataDir=${dataDir}`);
  logLine(`port=${port}`);
  logLine(`execPath=${process.execPath}`);

  // Run as Node (not as Electron GUI). Critical for packaged apps.
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    CAYA_PORT: String(port),
    CAYA_HOST: HOST,
    CAYA_DATA_DIR: dataDir
  };

  serverProcess = fork(serverEntry, [], {
    cwd: root,
    env,
    execPath: process.execPath,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });

  serverProcess.stdout?.on("data", (d) => logLine(`[out] ${String(d).trimEnd()}`));
  serverProcess.stderr?.on("data", (d) => logLine(`[err] ${String(d).trimEnd()}`));
  serverProcess.on("error", (err) => logLine(`[fork error] ${err.message}`));
  serverProcess.on("exit", (code, signal) => {
    logLine(`server exit code=${code} signal=${signal}`);
  });

  return waitForServer(port);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#09090b",
    autoHideMenuBar: true,
    show: false,
    icon: path.join(resourceRoot(), "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const url = `http://${HOST}:${port}/`;
  logLine(`loadURL ${url}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, validatedURL) => {
    logLine(`did-fail-load code=${code} desc=${desc} url=${validatedURL}`);
    showFatal(
      "Minecraft CaYa Bot Panel",
      `Failed to load UI.\n\n${desc} (${code})\nURL: ${validatedURL}\n\nIs port ${port} blocked?`
    );
  });

  mainWindow.loadURL(url);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Single instance — second launch focuses the first (avoids port fight)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      chosenPort = await pickPort();
      await startServer(chosenPort);
      createWindow(chosenPort);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine(`FATAL: ${msg}`);
      showFatal(
        "Minecraft CaYa Bot Panel — startup failed",
        `${msg}\n\nPortable and Setup use the same engine.\nIf this keeps happening, close any old CaYa process or free ports ${DEFAULT_PORT}+.`
      );
      app.quit();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(chosenPort);
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch {
      /* */
    }
  }
});
