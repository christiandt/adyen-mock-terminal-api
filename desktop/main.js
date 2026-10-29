// The Adyen mock terminal as a desktop app: the mock runs in this process and a window shows
// its page, with the address to point a POS at. If the port is taken (another mock, a Docker
// container), the next free one is used; the window title and the device panel show the one
// in use. Made like the virtual thermal printer's desktop app.
const { app, BrowserWindow, dialog, nativeTheme, shell } = require('electron');
const path = require('node:path');

/** The port the mock starts on, and how many to try counting up from it. */
const PORT = 3000;
const PORT_ATTEMPTS = 20;

let terminal = null;
let mainWindow = null;

function baseUrl() {
    return `http://localhost:${terminal.port}`;
}

async function start() {
    // The page and payloads: in the app's resources when packaged, the repository otherwise.
    process.env.MOCK_TERMINAL_ROOT = app.isPackaged
        ? path.join(process.resourcesPath, 'app-files')
        : path.join(__dirname, '..', '..');

    try {
        const { startServer } = require('../src/server');
        terminal = await startServer({ port: PORT, portAttempts: PORT_ATTEMPTS });
    } catch (error) {
        dialog.showErrorBox('The Adyen mock terminal could not start', error instanceof Error ? error.message : String(error));
        app.quit();
        return;
    }
    createWindow();
}

function createWindow() {
    const window = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 420,
        minHeight: 560,
        title: `Adyen Mock Terminal — ${baseUrl()}/sync`,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#121212' : '#f0f0f0',
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    mainWindow = window;
    // Keep the address in the title rather than the page's own.
    window.on('page-title-updated', (event) => event.preventDefault());
    // Links leave the app for the system browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(baseUrl())) {
            event.preventDefault();
            void shell.openExternal(url);
        }
    });
    window.on('closed', () => {
        mainWindow = null;
    });
    void window.loadURL(`${baseUrl()}/`);
}

// One terminal per machine: a second launch shows the first one's window.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });
    app.whenReady().then(start);
    // The terminal lives as long as its window, on macOS too: a terminal running with no
    // window would be easy to forget.
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', () => {
        void terminal?.close();
    });
}
