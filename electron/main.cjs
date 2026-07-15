const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { fork } = require("child_process");

const DEFAULT_PORT = Number(process.env.CAYA_PORT || 3001);
const HOST = "127.0.0.1";

let serverProcess = null;
let mainWindow = null;
let splashWindow = null;
let chosenPort = DEFAULT_PORT;
let serverLogPath = null;
const serverLogLines = [];

function resourceRoot() {
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

/** Small splash: “Starting…” + indeterminate progress bar (TR + EN). */
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 220,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    transparent: false,
    backgroundColor: "#09090b",
    alwaysOnTop: true,
    center: true,
    show: false,
    skipTaskbar: false,
    icon: path.join(resourceRoot(), "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const html = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>Starting…</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, Segoe UI, sans-serif;
      background: #09090b;
      color: #e4e4e7;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      -webkit-app-region: drag;
    }
    .card {
      width: 100%;
      padding: 28px 32px 24px;
      text-align: center;
    }
    .logo {
      width: 40px; height: 40px; margin: 0 auto 14px;
      border-radius: 10px;
      background: #18181b;
      border: 1px solid #27272a;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
    }
    h1 {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: #fafafa;
      margin-bottom: 4px;
    }
    .sub {
      font-size: 12px;
      color: #71717a;
      margin-bottom: 18px;
    }
    .status {
      font-size: 12px;
      color: #a1a1aa;
      min-height: 1.25em;
      margin-bottom: 12px;
    }
    .bar {
      height: 6px;
      border-radius: 999px;
      background: #27272a;
      overflow: hidden;
    }
    .bar > i {
      display: block;
      height: 100%;
      width: 40%;
      border-radius: 999px;
      background: linear-gradient(90deg, #4f46e5, #10b981);
      animation: slide 1.1s ease-in-out infinite;
    }
    @keyframes slide {
      0%   { transform: translateX(-120%); }
      100% { transform: translateX(280%); }
    }
    .hint {
      margin-top: 14px;
      font-size: 10px;
      color: #52525b;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">⛏</div>
    <h1>Minecraft CaYa Bot Panel</h1>
    <div class="sub">Starting · Başlatılıyor</div>
    <div class="status" id="s">Preparing…</div>
    <div class="bar"><i></i></div>
    <div class="hint">Portable first launch can take a few seconds</div>
  </div>
  <script>
    window.__setStatus = function (t) {
      var el = document.getElementById('s');
      if (el) el.textContent = t || '';
    };
  </script>
</body>
</html>`;

  splashWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  splashWindow.once("ready-to-show", () => {
    splashWindow?.show();
    splashWindow?.focus();
  });
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

function setSplashStatus(text) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const safe = String(text ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  splashWindow.webContents
    .executeJavaScript(`window.__setStatus && window.__setStatus('${safe}')`)
    .catch(() => {});
  logLine(`splash: ${text}`);
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    try {
      splashWindow.close();
    } catch {
      /* */
    }
  }
  splashWindow = null;
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
    if (attempt === 0 || attempt % 8 === 0) {
      setSplashStatus(`Starting server… (${Math.min(100, Math.round((attempt / 80) * 100))}%)`);
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

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    CAYA_PORT: String(port),
    CAYA_HOST: HOST,
    CAYA_DATA_DIR: dataDir
  };

  setSplashStatus("Launching backend…");

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
  setSplashStatus("Opening panel…");

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
    closeSplash();
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Fallback if ready-to-show is slow
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      closeSplash();
      mainWindow.show();
    }
  }, 8000);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, validatedURL) => {
    logLine(`did-fail-load code=${code} desc=${desc} url=${validatedURL}`);
    closeSplash();
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Show splash immediately so portable doesn't feel frozen
    createSplash();
    setSplashStatus("Checking port…");

    try {
      chosenPort = await pickPort();
      setSplashStatus(`Port ${chosenPort} · starting server…`);
      await startServer(chosenPort);
      setSplashStatus("Server ready · loading UI…");
      createWindow(chosenPort);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine(`FATAL: ${msg}`);
      closeSplash();
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
  closeSplash();
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch {
      /* */
    }
  }
});
