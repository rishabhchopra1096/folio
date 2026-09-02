/*
 * =============================================================================
 * MAIN.JS — Electron Main Process for Folio Desktop Panel
 * =============================================================================
 * FILE OVERVIEW:
 * This is the Electron main process. It creates a side panel that lives at
 * the right edge of the screen — always accessible via a global hotkey or
 * by clicking a thin edge tab that's always visible.
 *
 * HOW IT WORKS:
 * 1. On app ready: hide Dock icon, create the panel window
 * 2. The window is always "shown" but only 8px wide when collapsed (the edge tab)
 * 3. Cmd+Shift+N or clicking the edge tab expands it to 400px
 * 4. Tray icon provides a context menu with Show/Hide, New Page, Quit
 * 5. Single-instance lock prevents multiple copies running
 * 6. Notion API calls are proxied through main process (CORS)
 * =============================================================================
 */

const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
} = require("electron");

/* Reading a selection from any other application. */
const { captureSelection, stopHook } = require("./capture.js");

/*
 * ==========================================================================
 * THE READER'S CONTROLS
 * ==========================================================================
 * A small always-on-top pill, not the panel. The point of reading a selection
 * is that it does not take over the screen, so the controls must not either.
 *
 * NEVER FOCUSABLE, and always shown with showInactive(): you keep typing in
 * whatever you were reading from. `"floating"` rather than `"screen-saver"`
 * because the higher level drags full-screen Spaces around when it appears.
 */
let controlsWin = null;

function createControls() {
  if (controlsWin && !controlsWin.isDestroyed()) return controlsWin;
  controlsWin = new BrowserWindow({
    width: 300,
    height: 44,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    focusable: false,              // must never steal the keyboard
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  controlsWin.setAlwaysOnTop(true, "floating", 1);
  controlsWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  controlsWin.loadFile(path.join(__dirname, "controls.html"));
  controlsWin.on("closed", () => { controlsWin = null; });
  return controlsWin;
}

function showControls() {
  const w = createControls();
  if (w.isVisible()) return;
  // Bottom-centre of the display the cursor is on, out of the way of text.
  const { screen } = require("electron");
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  w.setBounds({
    x: Math.round(area.x + (area.width - 300) / 2),
    y: Math.round(area.y + area.height - 76),
    width: 300, height: 44,
  });
  w.showInactive();               // never takes focus
}

function hideControls() {
  if (controlsWin && !controlsWin.isDestroyed() && controlsWin.isVisible()) {
    controlsWin.hide();
  }
}

function sendReaderState(state) {
  if (controlsWin && !controlsWin.isDestroyed()) {
    controlsWin.webContents.send("reader-state", state || {});
  }
}

/*
 * Whether a selection is currently being read. Held here rather than in the
 * renderer because the shortcut is a toggle and the main process is what sees
 * the keypress.
 */
let readingNow = false;

/*
 * Say something without opening anything. The reader is deliberately invisible,
 * so a failure has nowhere on screen to appear — a notification is the only
 * honest way to report one.
 */
function notify(message) {
  try {
    const { Notification } = require("electron");
    if (Notification.isSupported()) {
      new Notification({ title: "Folio", body: String(message) }).show();
      return;
    }
  } catch { /* fall through */ }
  console.warn("[folio]", message);
}
const path = require("path");

// =============================================================================
// SINGLE INSTANCE LOCK — Prevent multiple copies of the app running
// =============================================================================

/*
 * If another instance is already running, this one will quit immediately.
 * The existing instance gets focus instead. We wrap this in a try/catch
 * because it can fail in sandboxed environments.
 */
try {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  }
} catch {
  // Lock creation failed (e.g., sandboxed environment) — continue anyway
}

// =============================================================================
// GLOBALS — Window, tray, and state references
// =============================================================================

// The main panel window
let win = null;
// The menu bar tray icon
let tray = null;
// Whether the panel is currently expanded (showing full content)
let isExpanded = false;
// Panel dimensions
const PANEL_WIDTH = 400;
const EDGE_TAB_WIDTH = 8;

// =============================================================================
// WINDOW CREATION — The panel window, always present at the right screen edge
// =============================================================================

function createWindow() {
  // Get the primary display dimensions
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const { x: workX, y: workY } = display.workArea;

  /*
   * The window starts collapsed — only 8px visible at the right edge.
   * This thin strip acts as the "edge tab" you can click to expand.
   * When expanded, it grows to 400px wide.
   */
  win = new BrowserWindow({
    width: EDGE_TAB_WIDTH,
    height: screenHeight,
    x: workX + screenWidth - EDGE_TAB_WIDTH,
    y: workY,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: true,
    show: true,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the Electron-specific HTML file
  win.loadFile(path.join(__dirname, "..", "index-electron.html"));

  // Prevent the window from being closed — just collapse it instead
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      collapsePanel();
    }
  });

  // Ignore mouse events on the transparent parts (so clicks pass through)
  // but allow clicks on the edge tab
  win.setIgnoreMouseEvents(false);
}

// =============================================================================
// PANEL EXPAND/COLLAPSE — Resize the window to show/hide the panel content
// =============================================================================

function expandPanel() {
  if (!win || isExpanded) return;

  // Get current screen dimensions (may have changed due to monitor changes)
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const { x: workX, y: workY } = display.workArea;

  // Expand the window from 8px (edge tab) to 400px (full panel)
  win.setBounds({
    x: workX + screenWidth - PANEL_WIDTH,
    y: workY,
    width: PANEL_WIDTH,
    height: screenHeight,
  });

  // Tell the renderer to show the content
  win.webContents.send("panel-expand");
  win.focus();
  isExpanded = true;
  updateTrayMenu();
}

function collapsePanel() {
  if (!win || !isExpanded) return;

  // Tell the renderer to hide content first (for smooth transition)
  win.webContents.send("panel-collapse");

  // After a brief delay for the CSS transition, shrink the window back to the edge tab
  setTimeout(() => {
    if (win && !isExpanded) {
      const display = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = display.workAreaSize;
      const { x: workX, y: workY } = display.workArea;

      win.setBounds({
        x: workX + screenWidth - EDGE_TAB_WIDTH,
        y: workY,
        width: EDGE_TAB_WIDTH,
        height: screenHeight,
      });
    }
  }, 200);

  isExpanded = false;
  updateTrayMenu();
}

function togglePanel() {
  if (isExpanded) {
    collapsePanel();
  } else {
    expandPanel();
  }
}

// =============================================================================
// TRAY ICON — Menu bar presence with context menu
// =============================================================================

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("Folio");

  // Click tray icon to toggle panel
  tray.on("click", () => {
    togglePanel();
  });

  updateTrayMenu();
}

// Build the tray context menu
function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isExpanded ? "Hide Panel" : "Show Panel",
      click: togglePanel,
    },
    {
      /*
       * The reader is deliberately invisible while it plays. This is how you
       * get at it when you want the transport controls or want to see where it
       * has got to.
       */
      label: "Show reader",
      click: () => {
        expandPanel();
        if (win && win.webContents) {
          win.webContents.executeJavaScript(
            "typeof ReadAloud !== 'undefined' && ReadAloud.reveal()").catch(() => {});
        }
      },
    },
    {
      label: "New Page",
      click: () => {
        if (!isExpanded) expandPanel();
        setTimeout(() => {
          win.webContents.send("new-page");
        }, 300);
      },
    },
    { type: "separator" },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    {
      label: "Quit Folio",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

/*
 * Creates a tray icon from the PNG template file.
 * macOS template images auto-adapt to menu bar light/dark mode.
 */
function createTrayIcon() {
  const iconPath = path.join(__dirname, "tray-iconTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  return icon;
}

// =============================================================================
// IPC HANDLERS — Communication between main and renderer
// =============================================================================

function setupIPC() {
  // Edge tab was clicked — expand the panel
  ipcMain.on("expand-panel", () => {
    expandPanel();
  });

  // Renderer requests to collapse (close button, Escape key)
  ipcMain.on("collapse-panel", () => {
    collapsePanel();
  });

  // Notion API proxy — all calls go through main process to avoid CORS
  /* The renderer reports when reading ends, so the toggle does not get stuck. */
  ipcMain.on("reading-ended", () => {
    readingNow = false;
    hideControls();
  });

  /* A button on the pill. The reader lives in the panel renderer, not here. */
  ipcMain.on("reader-control", (_event, msg) => {
    if (msg && msg.action === "stop") {
      readingNow = false;
      hideControls();
    }
    if (win && win.webContents) win.webContents.send("reader-control", msg);
  });

  /* The reader telling the pill what to display. */
  ipcMain.on("reader-state", (_event, state) => sendReaderState(state));

  ipcMain.handle("notion:search", async (_event, token, query) => {
    return notionFetch(token, "POST", "/v1/search", {
      query: query || "",
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 50,
    });
  });

  ipcMain.handle("notion:fetch-page", async (_event, token, pageId) => {
    return notionFetch(token, "GET", `/v1/pages/${pageId}/markdown`);
  });

  ipcMain.handle("notion:push-page", async (_event, token, pageId, markdown) => {
    return notionFetch(token, "PATCH", `/v1/pages/${pageId}/markdown`, {
      markdown,
    });
  });

  ipcMain.handle("notion:get-meta", async (_event, token, pageId) => {
    return notionFetch(token, "GET", `/v1/pages/${pageId}`);
  });
}

// =============================================================================
// NOTION API — HTTP client for Notion's REST API
// =============================================================================

async function notionFetch(token, method, endpoint, body) {
  const url = `https://api.notion.com${endpoint}`;

  try {
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
    };

    if (body && (method === "POST" || method === "PATCH")) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      return { error: true, status: response.status, message: data.message || "API error" };
    }

    return { error: false, data };
  } catch (err) {
    return { error: true, status: 0, message: err.message };
  }
}

// =============================================================================
// APP LIFECYCLE — Startup, shortcuts, and cleanup
// =============================================================================

app.whenReady().then(() => {
  // Hide from Dock — this is a panel app, lives in the tray only
  if (process.platform === "darwin") {
    app.dock.hide();
  }

  // Create the panel window (starts as 8px edge tab)
  createWindow();

  // Create tray icon
  createTray();

  // Register global hotkey: Cmd+Shift+N to toggle panel
  const registered = globalShortcut.register("CommandOrControl+Shift+N", () => {
    togglePanel();
  });

  if (!registered) {
    console.error("Failed to register global shortcut Cmd+Shift+N");
  }

  /*
   * Read the selection, from wherever it is.
   *
   * ORDER MATTERS AND IS NOT NEGOTIABLE: capture BEFORE showing the panel.
   * Showing it makes Folio frontmost, and then the accessibility read targets
   * our own window while the synthetic copy cannot work at all — a process
   * cannot Cmd+C itself while it is the one blocked handling the keystroke.
   */
  const readRegistered = globalShortcut.register("CommandOrControl+Shift+R", async () => {
    /*
     * Pressing it again while something is being read means STOP. Reaching for
     * the mouse to silence a shortcut you started with the keyboard is worse
     * than the reading itself.
     */
    if (readingNow) {
      readingNow = false;
      hideControls();
      if (win && win.webContents) win.webContents.send("read-selection", { stop: true });
      return;
    }

    let result;
    try {
      result = await captureSelection();
    } catch (err) {
      result = { error: "Could not read the selection: " + err.message };
    }

    /*
     * Always logged. This path runs with no window on screen, so without it a
     * failure is genuinely invisible — which is exactly how it behaved the
     * first time it broke.
     */
    console.log("[folio] read-selection:", result && result.error
      ? "FAILED — " + result.error
      : `${result.method} · ${result.app} · ${(result.text || "").length} chars`);

    /*
     * DELIBERATELY NOT expandPanel().
     *
     * You asked for a reader, not a place to put your text. The panel stays
     * shut and the audio simply starts; the window is already alive as an 8px
     * edge tab, which is all that is needed to play sound. Reading someone's
     * selection into an app they did not ask to open is the behaviour this
     * replaced.
     */
    if (result && result.error) {
      // Silence would be indistinguishable from a broken shortcut.
      notify(result.error);
      return;
    }

    readingNow = true;
    showControls();
    if (win && win.webContents) win.webContents.send("read-selection", result);
  });

  if (!readRegistered) {
    /*
     * Another application already owns this combination. macOS gives no way to
     * discover which, but the boolean is a real signal and swallowing it would
     * leave a key that silently does nothing.
     */
    console.error("Could not register Cmd+Shift+R — another app already owns it.");
  }

  // Set up IPC handlers
  setupIPC();
});

// If a second instance tries to launch, focus the existing one instead
app.on("second-instance", () => {
  if (!isExpanded) {
    expandPanel();
  } else if (win) {
    win.focus();
  }
});

// Clean up shortcuts when quitting
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopHook();
  if (controlsWin && !controlsWin.isDestroyed()) controlsWin.destroy();
});

// Keep the app running when all windows are closed (tray app behavior)
app.on("window-all-closed", () => {
  // Don't quit — tray icon keeps the app alive
});
