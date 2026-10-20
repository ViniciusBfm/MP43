const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const tools = require('./src/tools');
const { Downloader, getInfo } = require('./src/downloader');

// A interface é servida em app://mp43/ (origem própria, sem file://).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

// ---------- configurações e histórico ----------
const dataFile = (name) => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 1));
  } catch (err) {
    console.error('Falha ao salvar', name, err);
  }
}

let settings = { outDir: path.join(os.homedir(), 'Downloads', 'MP43'), type: 'mp4', videoQuality: '720', audioQuality: '320' };
const downloader = new Downloader(() => settings.outDir);
let mainWindow = null;
let saveTimer = null;
let toolsReady = Promise.resolve([]);

function saveHistorySoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson('history.json', downloader.history()), 500);
}

downloader.on('update', (job) => mainWindow?.webContents.send('job:update', job));
downloader.on('removed', (id) => {
  mainWindow?.webContents.send('job:removed', id);
  saveHistorySoon();
});
downloader.on('finished', (job) => {
  saveHistorySoon();
  if (job.status === 'pronto' && mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
});

// ---------- janela ----------
function registerAppProtocol() {
  protocol.handle('app', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const file = path.join(__dirname, rel);
    if (!file.startsWith(__dirname + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    if (!res.ok) return res;
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(res.body, { status: 200, headers: { 'content-type': type } });
  });
}

function createWindow() {
  const icon = path.join(__dirname, 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    title: 'MP43',
    backgroundColor: '#0a0a14',
    autoHideMenuBar: true,
    icon: fs.existsSync(icon) ? icon : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL('app://mp43/renderer/index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('focus', () => {
    mainWindow.flashFrame(false);
    mainWindow.webContents.send('app:focus');
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Links soltos na janela não devem navegar para fora do app.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.on('close', (e) => {
    const active = downloader.activeCount();
    if (!active) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Cancelar downloads e sair', 'Continuar baixando'],
      defaultId: 1,
      cancelId: 1,
      title: 'MP43',
      message: `Há ${active} download${active > 1 ? 's' : ''} em andamento.`,
      detail: 'Se sair agora, eles serão cancelados.',
    });
    if (choice === 1) e.preventDefault();
    else downloader.cancelAll();
  });
  if (!app.isPackaged && process.env.MP43_DEBUG) attachDebug(mainWindow);
}

// Ajuda no desenvolvimento: MP43_DEBUG=1 mostra o console da interface no terminal;
// MP43_SHOT=<arquivo.png> salva uma captura da janela e fecha (MP43_EVAL roda JS antes).
function attachDebug(win) {
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[renderer:${level}] ${message} (${source}:${line})`);
  });
  const shot = process.env.MP43_SHOT;
  if (!shot) return;
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      if (process.env.MP43_EVAL) {
        try {
          console.log('[eval]', await win.webContents.executeJavaScript(process.env.MP43_EVAL));
        } catch (err) {
          console.log('[eval error]', err.message);
        }
        await new Promise((r) => setTimeout(r, Number(process.env.MP43_WAIT || 2000)));
      }
      fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      downloader.cancelAll();
      app.exit(0);
    }, Number(process.env.MP43_DELAY || 2500));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    tools.init({
      vendorDir: app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, 'vendor'),
      userBin: path.join(app.getPath('userData'), 'bin'),
    });
    toolsReady = tools.detect();
    settings = { ...settings, ...readJson('settings.json', {}) };
    if (!app.isPackaged && process.env.MP43_DIR) settings.outDir = process.env.MP43_DIR;
    downloader.load(readJson('history.json', []));
    registerAppProtocol();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------- IPC ----------
const errorMessage = (err) => String(err?.message || err);

ipcMain.handle('tools:detect', () => toolsReady);

ipcMain.handle('tools:update', async () => {
  const send = (line) => mainWindow?.webContents.send('tools:log', line);
  try {
    await toolsReady;
    const res = await tools.updateYtdlp(send);
    toolsReady = tools.detect();
    return { ok: true, upToDate: res.upToDate, status: await toolsReady };
  } catch (err) {
    toolsReady = tools.detect();
    return { ok: false, error: errorMessage(err), status: await toolsReady };
  }
});

ipcMain.handle('licenses:open', () => {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'AVISOS-DE-LICENCA.txt')
    : path.join(__dirname, 'vendor', 'AVISOS-DE-LICENCA.txt');
  return shell.openPath(file);
});

ipcMain.handle('info', async (_e, url) => {
  try {
    await toolsReady;
    return { ok: true, info: await getInfo(url) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});

ipcMain.handle('jobs:list', () => downloader.list());
ipcMain.handle('jobs:add', async (_e, req) => {
  try {
    await toolsReady;
    return { ok: true, job: downloader.add(req) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});
// Playlist: um download por vídeo, todos na mesma subpasta.
ipcMain.handle('jobs:add-many', async (_e, { items, type, quality, folder }) => {
  try {
    await toolsReady;
    let added = 0;
    for (const it of (Array.isArray(items) ? items : []).slice(0, 5000)) {
      downloader.add({ url: it.url, title: it.title, thumbnail: it.thumbnail, duration: it.duration, type, quality, folder });
      added++;
    }
    return { ok: true, added };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
});
ipcMain.handle('jobs:cancel', (_e, id) => downloader.cancel(id));
ipcMain.handle('jobs:retry', (_e, id) => downloader.retry(id));
ipcMain.handle('jobs:remove', (_e, id) => downloader.remove(id));
ipcMain.handle('jobs:clear', () => {
  for (const j of downloader.list()) if (!['na fila', 'baixando', 'convertendo'].includes(j.status)) downloader.remove(j.id);
});

ipcMain.handle('file:open', async (_e, p) => {
  if (!p || !fs.existsSync(p)) return 'O arquivo não existe mais (foi movido ou apagado).';
  const err = await shell.openPath(p);
  return err || null;
});
ipcMain.handle('file:show', (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  else {
    fs.mkdirSync(settings.outDir, { recursive: true });
    shell.openPath(settings.outDir);
  }
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = ['type', 'videoQuality', 'audioQuality'];
  for (const k of allowed) if (k in patch) settings[k] = String(patch[k]);
  writeJson('settings.json', settings);
  return settings;
});
ipcMain.handle('settings:choose-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolha onde salvar os downloads',
    defaultPath: settings.outDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!res.canceled && res.filePaths[0]) {
    settings.outDir = res.filePaths[0];
    writeJson('settings.json', settings);
  }
  return settings;
});

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('open:external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});
