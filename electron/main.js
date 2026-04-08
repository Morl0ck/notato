const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  globalShortcut,
  Tray,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs").promises;
const os = require("os");

/** Match `directories::ProjectDirs::from("com", "Notato", "Notato").data_dir()` */
function projectDataDir() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "Notato", "Notato", "data");
  }
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Notato",
      "Notato",
      "data",
    );
  }
  return path.join(home, ".local", "share", "notato", "data");
}

app.setPath("userData", projectDataDir());

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;

/** When false, clicks pass through (drawing off). */
let drawingEnabled = true;
/** Soft visibility (window hidden vs shown). */
let overlayVisible = true;

/** Full-screen bounds of the display that contains the mouse cursor (the “active” screen at launch). */
function getActiveScreenBounds() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  return display.bounds;
}

/** Place the overlay on whichever display the cursor is on (call before showing after hide or on first paint). */
function moveOverlayToActiveScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBounds(getActiveScreenBounds());
}

/** Cancels any in-flight overlay fade when a new show starts. */
let overlayFadeGeneration = 0;

const OVERLAY_FADE_MS = 220;

/** Ease-out cubic: smoother stop than linear. */
function fadeInMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const win = mainWindow;
  const gen = ++overlayFadeGeneration;
  const start = Date.now();

  const tick = () => {
    if (gen !== overlayFadeGeneration || win.isDestroyed()) return;
    const t = Math.min(1, (Date.now() - start) / OVERLAY_FADE_MS);
    const eased = 1 - (1 - t) ** 3;
    win.setOpacity(eased);
    if (t < 1) {
      setTimeout(tick, 16);
    } else {
      win.setOpacity(1);
    }
  };
  tick();
}

/**
 * Hide overlay without `BrowserWindow.hide()` on Windows/macOS so a later “show” does not replay
 * the OS open animation. Linux keeps `hide()` because `setOpacity` is often a no-op there.
 */
function hideOverlayWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  lastCursorInsideOverlay = undefined;
  overlayFadeGeneration += 1;
  if (process.platform === "linux") {
    mainWindow.hide();
  } else {
    mainWindow.setOpacity(0);
  }
}

/**
 * Show the overlay on the active display. Fades opacity 0→1. Calls `show()` only when the native
 * window is not yet visible (first paint after create, or Linux after `hide()`).
 */
function showOverlayWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  lastCursorInsideOverlay = undefined;
  moveOverlayToActiveScreen();
  mainWindow.setOpacity(0);
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  applyOverlayStacking();
  applyMousePassthrough();
  notifyRendererRefreshCursor();
  fadeInMainWindow();
  if (process.platform === "darwin") {
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      moveOverlayToActiveScreen();
    }, 0);
  }
}

/**
 * After resolution/DPI changes, keep the overlay on the same monitor by finding the display
 * that contains the window center, then matching that display’s bounds.
 */
function syncOverlayBoundsToContainingDisplay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const r = mainWindow.getBounds();
  const cx = r.x + Math.floor(r.width / 2);
  const cy = r.y + Math.floor(r.height / 2);
  const display = screen.getDisplayNearestPoint({ x: cx, y: cy });
  mainWindow.setBounds(display.bounds);
}

function applyMousePassthrough() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!overlayVisible) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    return;
  }
  if (drawingEnabled) {
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

/**
 * Re-apply native Z-order. On Windows, a plain always-on-top frameless window often drops behind
 * normal windows after focus moves to another monitor; macOS already uses screen-saver level.
 */
function applyOverlayStacking() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (process.platform === "darwin") {
    mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
  } else if (process.platform === "win32") {
    mainWindow.setAlwaysOnTop(true, "screen-saver");
  } else {
    mainWindow.setAlwaysOnTop(true);
  }
}

/** Coalesce: move/resize can spam; one IPC per tick is enough to fix stuck CSS cursors. */
let refreshCursorSendScheduled = false;
function notifyRendererRefreshCursor() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  if (refreshCursorSendScheduled) return;
  refreshCursorSendScheduled = true;
  queueMicrotask(() => {
    refreshCursorSendScheduled = false;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send("refresh-cursor");
  });
}

/**
 * macOS: after another app becomes key on another display, the panel stays visually on top but is
 * inactive — WebKit will not reliably apply CSS cursors until the window is re-stacked / focused.
 * Pointer DOM events also often skip pointerenter across displays, so we detect OS cursor vs bounds.
 * (Darwin only; other platforms rely on window focus/move handlers.)
 */
let lastCursorInsideOverlay = undefined;
/** @type {ReturnType<typeof setInterval> | null} */
let cursorReenterPollInterval = null;

function handleCursorReenteredNotatoDisplay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  applyOverlayStacking();
  applyMousePassthrough();
  try {
    mainWindow.moveTop();
  } catch {
    /* ignore */
  }
  if (process.platform === "darwin" && drawingEnabled) {
    mainWindow.focus();
  }
  notifyRendererRefreshCursor();
}

function tickCursorReenterPoll() {
  if (process.platform !== "darwin") return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!overlayVisible) {
    lastCursorInsideOverlay = undefined;
    return;
  }
  const p = screen.getCursorScreenPoint();
  const b = mainWindow.getBounds();
  const inside =
    p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (lastCursorInsideOverlay === undefined) {
    lastCursorInsideOverlay = inside;
    return;
  }
  if (lastCursorInsideOverlay === false && inside) {
    handleCursorReenteredNotatoDisplay();
  }
  lastCursorInsideOverlay = inside;
}

function startCursorReenterPoll() {
  if (process.platform !== "darwin") return;
  if (cursorReenterPollInterval) return;
  cursorReenterPollInterval = setInterval(tickCursorReenterPoll, 200);
}

function broadcastOverlayState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("overlay-state", {
    drawingEnabled,
    overlayVisible,
  });
}

function sendShortcut(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("shortcut-action", action);
}

function registerGlobalShortcuts() {
  const accel = (key) =>
    process.platform === "darwin"
      ? `Command+Shift+${key}`
      : `Control+Shift+${key}`;

  const reg = (key, fn) => {
    const a = accel(key);
    try {
      globalShortcut.register(a, fn);
    } catch {
      console.warn("Failed to register shortcut", a);
    }
  };

  reg("A", () => {
    drawingEnabled = !drawingEnabled;
    applyOverlayStacking();
    applyMousePassthrough();
    broadcastOverlayState();
  });
  reg("D", () => {
    overlayVisible = !overlayVisible;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (overlayVisible) {
        showOverlayWindow();
      } else {
        hideOverlayWindow();
      }
    }
    applyMousePassthrough();
    broadcastOverlayState();
  });
  reg("B", () => sendShortcut("setBackgroundBlackboard"));
  reg("W", () => sendShortcut("setBackgroundWhiteboard"));
  reg("X", () => sendShortcut("clearCanvas"));
  reg("Q", () => app.quit());
}

function buildTrayIcon() {
  const size = 32;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = x - size * 0.5;
      const cy = y - size * 0.5;
      const r = Math.sqrt(cx * cx + cy * cy);
      if (r < 14) {
        canvas[i] = 80;
        canvas[i + 1] = 140;
        canvas[i + 2] = 255;
        canvas[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip("Notato");
  tray.on("click", () => {
    overlayVisible = !overlayVisible;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (overlayVisible) {
        showOverlayWindow();
      } else {
        hideOverlayWindow();
      }
    }
    applyMousePassthrough();
    broadcastOverlayState();
  });
}

function ensureDirsSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "canvases"), { recursive: true });
}

function statePath() {
  return path.join(app.getPath("userData"), "state.json");
}

function canvasPath(id) {
  return path.join(app.getPath("userData"), "canvases", `${id}.json`);
}

function createWindow() {
  const b = getActiveScreenBounds();
  const darwin = process.platform === "darwin";

  mainWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: true,
    thickFrame: false,
    /** Native rounded window clip (macOS / Win 11+); off so full-screen overlay meets display corners. */
    roundedCorners: false,
    ...(darwin
      ? {
          /** Lets the window use full `Display.bounds` (under menu bar), not only `workArea`. */
          enableLargerThanScreen: true,
          /** NSPanel-style float; appears on all Spaces and stacks above normal windows. */
          type: "panel",
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  if (darwin) {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  applyOverlayStacking();

  mainWindow.once("ready-to-show", () => {
    showOverlayWindow();
  });

  mainWindow.on("focus", () => {
    applyOverlayStacking();
    applyMousePassthrough();
    notifyRendererRefreshCursor();
  });

  mainWindow.on("move", notifyRendererRefreshCursor);
  mainWindow.on("resize", notifyRendererRefreshCursor);

  mainWindow.webContents.on("focus", () => {
    notifyRendererRefreshCursor();
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  applyMousePassthrough();
}

function setupIpc() {
  ipcMain.handle("window:getOverlayState", () => ({
    drawingEnabled,
    overlayVisible,
  }));

  ipcMain.handle("window:setDrawingEnabled", (_e, enabled) => {
    drawingEnabled = Boolean(enabled);
    applyOverlayStacking();
    applyMousePassthrough();
    broadcastOverlayState();
  });

  ipcMain.handle("window:setOverlayVisible", (_e, visible) => {
    overlayVisible = Boolean(visible);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (overlayVisible) {
      showOverlayWindow();
    } else {
      hideOverlayWindow();
    }
    applyMousePassthrough();
    broadcastOverlayState();
  });

  ipcMain.handle("persist:loadState", async () => {
    const p = statePath();
    try {
      const data = await fsPromises.readFile(p, "utf8");
      return JSON.parse(data);
    } catch {
      return { schema_version: 1, index: [], active_canvas_id: null, ui: {} };
    }
  });

  ipcMain.handle("persist:saveState", async (_e, state) => {
    ensureDirsSync(app.getPath("userData"));
    await fsPromises.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
  });

  ipcMain.handle("persist:loadCanvas", async (_e, id) => {
    const p = canvasPath(id);
    const data = await fsPromises.readFile(p, "utf8");
    return JSON.parse(data);
  });

  ipcMain.handle("persist:saveCanvas", async (_e, id, file) => {
    ensureDirsSync(app.getPath("userData"));
    await fsPromises.writeFile(canvasPath(id), JSON.stringify(file, null, 2), "utf8");
  });

  ipcMain.handle("persist:deleteCanvas", async (_e, id) => {
    try {
      await fsPromises.unlink(canvasPath(id));
    } catch {
      /* ignore */
    }
  });
}

app.whenReady().then(() => {
  ensureDirsSync(app.getPath("userData"));
  setupIpc();
  createWindow();
  createTray();
  registerGlobalShortcuts();
  startCursorReenterPoll();

  screen.on("display-metrics-changed", () => {
    syncOverlayBoundsToContainingDisplay();
    applyOverlayStacking();
    applyMousePassthrough();
    notifyRendererRefreshCursor();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      applyOverlayStacking();
      applyMousePassthrough();
      notifyRendererRefreshCursor();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (cursorReenterPollInterval) {
    clearInterval(cursorReenterPollInterval);
    cursorReenterPollInterval = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
