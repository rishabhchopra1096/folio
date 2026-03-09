/*
 * =============================================================================
 * MAIN.JS — Electron Main Process for Folio Desktop
 * =============================================================================
 * FILE OVERVIEW:
 * This is the Electron main process that creates the slide-in panel window,
 * manages the tray icon, registers the global hotkey, and proxies Notion API
 * calls (to avoid CORS issues in the renderer).
 *
 * HOW IT WORKS:
 * 1. On app ready: hide Dock icon, create frameless window at right screen edge
 * 2. Register Cmd+Shift+N as global hotkey to toggle panel visibility
 * 3. Create tray icon with context menu (Show/Hide, New Page, Quit)
 * 4. Handle IPC from renderer for panel animations and Notion API calls
 * 5. Notion API calls go through main process (renderer can't call due to CORS)
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
const path = require("path");
const { net } = require("electron");

// =============================================================================
// GLOBALS — Window, tray, and state references
// =============================================================================

// The main panel window
let win = null;
// The menu bar tray icon
let tray = null;
// Whether the panel is currently visible
let isVisible = false;

// =============================================================================
// WINDOW CREATION — Frameless panel at right edge of screen
// =============================================================================

function createWindow() {
  // Get the primary display dimensions
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const { x: workX, y: workY } = display.workArea;

  // Panel width — 400px for a compact side panel
  const panelWidth = 400;

  // Create the frameless, always-on-top window
  win = new BrowserWindow({
    width: panelWidth,
    height: screenHeight,
    x: workX + screenWidth - panelWidth,
    y: workY,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: true,
    show: false,
    transparent: false,
    backgroundColor: "#f5f0e8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the Electron-specific HTML file
  win.loadFile(path.join(__dirname, "..", "index-electron.html"));

  // Prevent the window from being closed — just hide it instead
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      hidePanel();
    }
  });

  // Hide panel when it loses focus (clicking elsewhere)
  win.on("blur", () => {
    // Small delay to allow tray click to register before hiding
    setTimeout(() => {
      if (isVisible && !win.isFocused()) {
        hidePanel();
      }
    }, 100);
  });
}

// =============================================================================
// PANEL SHOW/HIDE — Toggle with slide animation
// =============================================================================

function showPanel() {
  if (!win) return;

  // Reposition in case display changed
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const { x: workX, y: workY } = display.workArea;
  win.setBounds({
    x: workX + screenWidth - 400,
    y: workY,
    width: 400,
    height: screenHeight,
  });

  // Show the window and tell renderer to animate in
  win.show();
  win.focus();
  win.webContents.send("panel-show");
  isVisible = true;

  // Update tray menu
  updateTrayMenu();
}

function hidePanel() {
  if (!win) return;

  // Tell renderer to animate out — we'll hide the window after animation
  win.webContents.send("panel-hide");
  isVisible = false;

  // Hide window after the CSS transition completes (300ms)
  setTimeout(() => {
    if (win && !isVisible) {
      win.hide();
    }
  }, 320);

  // Update tray menu
  updateTrayMenu();
}

function togglePanel() {
  if (isVisible) {
    hidePanel();
  } else {
    showPanel();
  }
}

// =============================================================================
// TRAY ICON — Menu bar presence with context menu
// =============================================================================

function createTray() {
  /*
   * Create a tray icon for the macOS menu bar. We use nativeImage to create
   * a simple 16x16 icon. On macOS, "template" images automatically adapt
   * to the menu bar's light/dark appearance.
   *
   * We draw a simple document/notepad icon by creating a 16x16 image buffer.
   * For production, you'd replace this with a proper .png asset file.
   */
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
      label: isVisible ? "Hide Panel" : "Show Panel",
      click: togglePanel,
    },
    {
      label: "New Page",
      click: () => {
        if (!isVisible) showPanel();
        // Small delay to ensure window is ready
        setTimeout(() => {
          win.webContents.send("new-page");
        }, 100);
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
 * Creates a tray icon from the PNG file in the electron directory.
 * On macOS, files named "*Template.png" are automatically treated as
 * template images, which means macOS adapts them for dark/light mode.
 * The @2x variant is for Retina displays.
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
  // Notion API proxy — all calls go through main process to avoid CORS
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

  // Window control — renderer can request hide
  ipcMain.on("hide-panel", () => {
    hidePanel();
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
  // Hide from Dock — this is a panel app, not a regular app
  if (process.platform === "darwin") {
    app.dock.hide();
  }

  // Create the panel window
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

  // Set up IPC handlers for renderer communication
  setupIPC();
});

// Clean up shortcuts when quitting
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// Keep the app running when all windows are closed (tray app behavior)
app.on("window-all-closed", () => {
  // Don't quit — tray icon keeps the app alive
});

// macOS: re-create window if activated with no windows
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
