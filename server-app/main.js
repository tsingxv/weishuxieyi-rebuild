// server-app/main.js — Electron main process of the standalone Windows game server (开服面板).
//
// What it does, and what it deliberately does NOT do:
//   1. runs the REAL game server in-process by importing `startServer()` from `../server/index.js` — the same
//      code `npm start` runs (docs/DEPLOY.md), bound to 0.0.0.0:3000 by default. There is no second HTTP
//      server and no proxy: the host's friends connect straight to this process.
//   2. opens one small "control panel" window that shows everything needed to invite people: every address
//      a friend can type, the invite link for a room, the firewall/Radmin hints, live counters and a
//      copy-to-clipboard button for each of them.
//
// Closing the panel window stops the server — the panel says so in as many words. The server is in-process,
// so there is no way for it to outlive the window (which is exactly the point: a host must never be left
// wondering whether the game is still reachable).
//
// Arguments / environment (all optional; arguments beat the environment):
//   --port=3001            PORT                    bind port (default 3000)
//   --host=127.0.0.1       HOST                    bind address (default 0.0.0.0 = reachable from the LAN)
//   --server-data-dir=DIR  —                       where server.log and the window position live
//   --sandbox-probe        —                       reach app.whenReady() and exit 0 (see 启动服务器.cmd)
// Any other env var the server reads (SP_VERIFY, TRUST_PROXY, …) is inherited unchanged.

import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { APP_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { firewallCommand, formatShareText, inviteUrl, shareTargets } from './shareInfo.js';

const APP_SHELL_DIR = path.dirname(fileURLToPath(import.meta.url));
/** App root: the repository root in development, `<install>/resources/app` when packaged. Both keep the
 *  repository layout, so `../server/index.js` above and the payload dirs below resolve the same way. */
const APP_DIR = path.resolve(APP_SHELL_DIR, '..');
const RES = {
  publicDir: path.join(APP_DIR, 'public'),
  dataDir: path.join(APP_DIR, 'data'),
  sharedDir: path.join(APP_DIR, 'shared'),
};

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';
const MAX_LOG_BYTES = 512 * 1024;
const STATS_INTERVAL_MS = 2000;
const PANEL_WIDTH = 760;

// ------------------------------------------------------------------------------------------------
// Argument-level setup (before anything touches the user-data directory)
// ------------------------------------------------------------------------------------------------

function argValue(name) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : '';
}

/** `--port=` → `PORT` → 3000. Invalid values are reported, never silently swallowed. */
function preferredPort() {
  const raw = argValue('port') || String(process.env.PORT ?? '');
  if (!raw.trim()) return { port: DEFAULT_PORT, error: null };
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { port: DEFAULT_PORT, error: `端口无效：${raw}（应为 1–65535 的整数）` };
  return { port: n, error: null };
}

function preferredHost() {
  const raw = (argValue('host') || process.env.HOST || '').trim();
  return raw || DEFAULT_HOST;
}

if (process.argv.some((a) => a === '--sandbox-probe')) {
  // 启动服务器.cmd starts this to find out whether Chromium's sandbox can initialise here: a broken
  // sandbox kills the process before any JS runs, a working one reaches whenReady() and exits 0.
  // The server is deliberately NOT started for the probe (it would bind the game port).
  app.whenReady().then(() => app.exit(0), () => app.exit(1));
} else {
  boot();
}

function boot() {
  const dataDirArg = argValue('server-data-dir');
  if (dataDirArg) {
    try { app.setPath('userData', path.resolve(dataDirArg)); } catch (e) { console.error('[boot] bad --server-data-dir', e); }
  }
  startBoot();
}

// ------------------------------------------------------------------------------------------------
// State
// ------------------------------------------------------------------------------------------------

/** @type {Awaited<ReturnType<typeof startServer>> | null} */
let srv = null;
/** @type {BrowserWindow | null} */
let panel = null;
/** Last start failure (shown in the panel instead of an invisible console error). */
let lastError = null;
let starting = false;
let stopping = false;
let quitting = false;
/** Panel geometry, kept between launches (there is no config file: one honest number is enough). */
let windowBounds = null;
/** When the current server instance started listening (uptime in the panel). */
let startedAtMs = 0;
let startedAtIso = null;

const LOG_FILE = () => path.join(app.getPath('userData'), 'server.log');
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');

// ------------------------------------------------------------------------------------------------
// Logging (a host cannot open a console on a double-clicked exe: keep a file they can send back)
// ------------------------------------------------------------------------------------------------

function rotateLog() {
  try {
    if (fs.statSync(LOG_FILE()).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE(), `${LOG_FILE()}.1`);
  } catch { /* no log yet */ }
}

function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  if (process.env.SP_SERVER_DEBUG) console.log(line);
  try { fs.appendFileSync(LOG_FILE(), `${line}\n`); } catch { /* logging must never break the server */ }
}

function readWindowBounds() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (Number.isFinite(raw?.width) && Number.isFinite(raw?.height)) windowBounds = raw;
  } catch { /* first run */ }
}

function writeWindowBounds() {
  if (!panel || panel.isDestroyed() || !windowBounds) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), `${JSON.stringify(windowBounds, null, 2)}\n`, 'utf8');
  } catch { /* best effort */ }
}

// ------------------------------------------------------------------------------------------------
// The server
// ------------------------------------------------------------------------------------------------

/** Everything the panel shows, computed from the LIVE objects (`/healthz` reads the same ones). */
function snapshot() {
  const base = {
    version: APP_VERSION,
    protocol: PROTOCOL_VERSION,
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
    logFile: LOG_FILE(),
    port: null,
    host: null,
    running: false,
    starting,
    stopping,
    error: lastError,
    startedAt: null,
    uptimeSec: null,
    sockets: 0,
    sessions: 0,
    rooms: 0,
    matches: 0,
    humans: 0,
    bots: 0,
    hallMembers: 0,
    hallChat: 0,
    hallResults: 0,
    targets: [],
    roomsList: [],
    shareText: '',
    firewallCommand: '',
    localUrl: '',
  };
  if (!srv) {
    const port = preferredPort().port;
    const targets = shareTargets(port).filter((t) => t.kind !== 'linklocal');
    base.targets = targets;
    base.shareText = formatShareText({ port, targets, version: APP_VERSION });
    base.firewallCommand = firewallCommand(port);
    base.roomsList = [];
    return base;
  }
  const stats = srv.lobby.stats();
  const targets = shareTargets(srv.port).filter((t) => t.kind !== 'linklocal');
  const roomsList = [...srv.lobby.rooms.values()].map((r) => ({
    code: r.code,
    mode: r.mode,
    inMatch: !!r.match,
    humans: r.seats.filter((s) => s && !s.isBot && !s.left).length,
  }));
  const newest = roomsList[roomsList.length - 1] ?? null;
  const invite = newest && targets.length ? inviteUrl(targets[0].url, newest.code) : null;
  return {
    ...base,
    port: srv.port,
    host: srv.host,
    running: !stopping,
    startedAt: startedAtIso,
    uptimeSec: Math.round((Date.now() - startedAtMs) / 1000),
    sockets: srv.network.connectionCount,
    sessions: srv.registry.size,
    rooms: stats.rooms,
    matches: stats.matches,
    humans: stats.humans,
    bots: stats.bots,
    hallMembers: stats.hallMembers,
    hallChat: stats.hallChat,
    hallResults: stats.hallResults,
    targets,
    roomsList,
    invite,
    shareText: formatShareText({ port: srv.port, targets, invite, roomCode: newest?.code ?? null, version: APP_VERSION }),
    firewallCommand: firewallCommand(srv.port),
    localUrl: `http://127.0.0.1:${srv.port}/`,
    lanUrls: targets.map((t) => t.url),
    urls: ['http://localhost:' + srv.port + '/', ...targets.slice(0, 4).map((t) => t.url)],
  };
}

/** Push a fresh snapshot to the panel (it may be gone: the window is the server's lifetime). */
function pushState(extra = {}) {
  if (!panel || panel.isDestroyed()) return;
  try { panel.webContents.send('sp:state', { ...snapshot(), ...extra }); } catch { /* window closing */ }
}

/**
 * Start the game server. Resolves true when it is listening; on failure the panel stays open and shows the
 * reason (an EADDRINUSE message a host can act on beats a window that vanishes).
 */
async function startGameServer() {
  if (starting || srv) return Boolean(srv);
  starting = true;
  lastError = null;
  pushState();
  const { port, error } = preferredPort();
  const host = preferredHost();
  if (error) lastError = error;
  try {
    const next = await startServer({
      port,
      host,
      publicDir: RES.publicDir,
      dataDir: RES.dataDir,
      sharedDir: RES.sharedDir,
      log: {
        info: (...a) => log('[server]', ...a),
        warn: (...a) => log('[server:warn]', ...a),
        error: (...a) => log('[server:error]', ...a),
        debug: process.env.DEBUG ? (...a) => log('[server:debug]', ...a) : () => {},
      },
    });
    srv = next;
    startedAtMs = Date.now();
    startedAtIso = new Date(startedAtMs).toISOString();
    log(`[boot] listening on ${host}:${next.port} (pid ${process.pid})`);
  } catch (e) {
    lastError = describeStartError(e, port, host);
    log('[boot] failed to start', e);
  } finally {
    starting = false;
    pushState();
  }
  return Boolean(srv);
}

/** Turn a bind failure into the sentence docs/DEPLOY.md §5 uses. */
function describeStartError(e, port, host) {
  if (e && e.code === 'EADDRINUSE') {
    return `端口 ${port} 已被占用（EADDRINUSE）。\n可能已经开着一个服务器（另一个面板 / npm start / 开机自启的计划任务），`
      + `或者别的程序占用了这个端口。\n换端口启动：双击 "启动服务器.cmd --port 3001"，或设置环境变量 PORT。`;
  }
  if (e && e.code === 'EACCES') return `没有权限绑定 ${host}:${port}（EACCES）。换一个 1024 以上的端口，或用管理员身份运行。`;
  return `${e?.message || e}`;
}

/** Stop the server (keeps the panel open so the host can start it again). */
async function stopGameServer() {
  if (!srv || stopping) return;
  stopping = true;
  pushState();
  const cur = srv;
  srv = null;
  try {
    await cur.close();
    log('[shutdown] server stopped');
  } catch (e) {
    log('[shutdown] close failed', e);
  } finally {
    stopping = false;
    pushState();
  }
}

// ------------------------------------------------------------------------------------------------
// Window
// ------------------------------------------------------------------------------------------------

/** Keep a remembered position only when it still lands on a connected display. */
function usableBounds() {
  const b = { width: PANEL_WIDTH, height: 720 };
  const w = windowBounds || {};
  b.width = Math.min(Math.max(Number(w.width) || PANEL_WIDTH, 560), 1600);
  b.height = Math.min(Math.max(Number(w.height) || 720, 480), 1400);
  if (Number.isFinite(w.x) && Number.isFinite(w.y)) {
    const visible = screen.getAllDisplays().some((d) => {
      const db = d.bounds;
      return w.x < db.x + db.width - 40 && w.x + 120 > db.x && w.y < db.y + db.height - 40 && w.y + 60 > db.y;
    });
    if (visible) { b.x = w.x; b.y = w.y; }
  }
  return b;
}

function createPanel() {
  panel = new BrowserWindow({
    ...usableBounds(),
    minWidth: 560,
    minHeight: 480,
    show: false,
    backgroundColor: '#0c0f0e',
    title: `开服面板 · 卫戍协议：盟约`,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(APP_SHELL_DIR, 'panel-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  panel.on('page-title-updated', (e) => e.preventDefault());
  panel.once('ready-to-show', () => {
    panel.show();
    pushState();
    log('[panel] window shown');
  });
  panel.on('resize', () => {
    if (!panel || panel.isDestroyed()) return;
    const b = panel.getBounds();
    windowBounds = { width: b.width, height: b.height, x: b.x, y: b.y };
  });
  panel.on('close', () => {
    if (!panel || panel.isDestroyed()) return;
    const b = panel.getBounds();
    windowBounds = { width: b.width, height: b.height, x: b.x, y: b.y };
    writeWindowBounds();
  });
  panel.on('closed', () => { panel = null; });

  // The panel is not a browser: links open outside, navigation away is refused.
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  panel.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith('file://')) {
      e.preventDefault();
      log(`[nav] blocked ${target}`);
      if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    }
  });

  panel.loadFile(path.join(APP_SHELL_DIR, 'panel.html'));
  log(`[panel] opening ${path.join(APP_SHELL_DIR, 'panel.html')}`);
  panel.webContents.once('did-finish-load', () => log('[panel] loaded'));
  panel.webContents.on('render-process-gone', (_e, details) => log('[panel] renderer gone', details));
  panel.webContents.on('console-message', (_e, level, message) => log(`[panel:console:${level}] ${message}`));
  panel.webContents.on('did-fail-load', (_e, code, desc, url) => log(`[panel] load failed ${code} ${desc} ${url}`));

  // QA flags, used to check what the host actually sees on a machine with no interactive session:
  //   --panel-shot=FILE.png  write one screenshot of the panel, then exit
  //   --panel-dump=FILE.txt  write the panel's rendered text + control states as JSON, then exit
  // Both keep the server running while the page is captured, so the capture shows real numbers.
  const shot = argValue('panel-shot');
  const dump = argValue('panel-dump');
  if (shot || dump) {
    panel.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (shot) {
            const image = await panel.webContents.capturePage();
            fs.writeFileSync(path.resolve(shot), image.toPNG());
            log(`[panel] wrote ${path.resolve(shot)}`);
          }
          if (dump) {
            const exercise = /[?&]exercise/.test(dump);
            const data = await panel.webContents.executeJavaScript(`window.__panelDump({ exercise: ${exercise} })`);
            fs.writeFileSync(path.resolve(dump.replace(/[?&]exercise/, '')), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
            log(`[panel] dumped ${path.resolve(dump.replace(/[?&]exercise/, ''))} (exercise=${exercise})`);
          }
        } catch (e) {
          log('[panel] probe failed', e);
          process.exitCode = 1;
        }
        app.exit(process.exitCode || 0);
      }, 2500);
    });
  }
}

function focusPanel() {
  if (panel && !panel.isDestroyed()) {
    if (panel.isMinimized()) panel.restore();
    panel.focus();
  }
}

function openInBrowser() {
  const port = srv?.port ?? preferredPort().port;
  const url = `http://127.0.0.1:${port}/`;
  log(`[panel] open browser ${url}`);
  shell.openExternal(url).catch((e) => log('[panel] openExternal failed', e));
}

function buildMenu() {
  const template = [
    {
      label: '服务器',
      submenu: [
        { label: '在浏览器里玩（本机）', accelerator: 'CommandOrControl+O', click: () => openInBrowser() },
        { label: '复制全部分享信息', accelerator: 'CommandOrControl+Shift+C', click: () => copy(snapshot().shareText, '全部分享信息') },
        { type: 'separator' },
        { label: '停止服务器', click: () => stopGameServer() },
        { label: '退出（并停止服务器）', click: () => app.quit() },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新面板 (F5)', role: 'reload' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '重置缩放', role: 'resetZoom' },
        { type: 'separator' },
        { label: '开发者工具', role: 'toggleDevTools' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开日志文件夹', click: () => shell.openPath(app.getPath('userData')) },
        {
          label: '防火墙设置说明',
          click: () => dialog.showMessageBox(panel ?? undefined, {
            type: 'info',
            title: '防火墙',
            message: '朋友连不上时，先检查防火墙',
            detail: [
              '第一次开服时 Windows 会弹出「Windows 安全中心警报」：',
              '勾选「专用网络」并点「允许访问」。',
              '',
              '没弹窗或点错了，用【管理员】PowerShell 执行：',
              firewallCommand(srv?.port ?? preferredPort().port),
              '',
              '家里的网络若是「公用网络」，Windows 会拦截入站连接（管理员 PowerShell）：',
              'Set-NetConnectionProfile -InterfaceAlias "以太网" -NetworkCategory Private',
              '',
              '更完整的说明见 docs/DEPLOY.md（部署指南）第 1.2 节。',
            ].join('\n'),
            buttons: ['确定'],
          }),
        },
        {
          label: '关于',
          click: () => dialog.showMessageBox(panel ?? undefined, {
            type: 'info',
            title: '关于',
            message: `卫戍协议：盟约 · 独立服务器 v${APP_VERSION}`,
            detail: [
              '非官方同人作品，仅供个人非商业联机游玩。',
              `监听：${srv ? `${srv.host}:${srv.port}` : '（未运行）'}`,
              `协议版本：${PROTOCOL_VERSION}`,
              `Electron ${process.versions.electron} · Node ${process.versions.node}`,
              `数据目录：${app.getPath('userData')}`,
              '',
              '把地址发给朋友前请确认：只发给信任的人，不要做端口转发到公网除非你清楚风险。',
            ].join('\n'),
            buttons: ['确定'],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Copy through the main process: a sandboxed renderer cannot reach Electron's clipboard module. */
function copy(text, what = '内容') {
  const value = typeof text === 'string' ? text : '';
  if (!value) return { ok: false, error: '没有可复制的内容' };
  clipboard.writeText(value);
  log(`[panel] copied ${what} (${value.length} chars)`);
  return { ok: true, length: value.length };
}

// ------------------------------------------------------------------------------------------------
// IPC (panel window)
// ------------------------------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('sp:state', () => snapshot());
  ipcMain.handle('sp:copy', (_e, text) => copy(text, 'panel item'));
  ipcMain.handle('sp:open-browser', () => { openInBrowser(); return true; });
  ipcMain.handle('sp:open-folder', () => { shell.openPath(app.getPath('userData')); return true; });
  ipcMain.handle('sp:stop', async () => { await stopGameServer(); return snapshot(); });
  ipcMain.handle('sp:start', async () => { await startGameServer(); return snapshot(); });
  /** The invite link for a code the host typed (same builder the panel's own hint uses). */
  ipcMain.handle('sp:invite', (_e, code) => {
    const value = String(code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(value)) return { ok: false, error: '房间密钥是 4 位字母数字（例如 AB3F）', code: value };
    const targets = shareTargets(srv?.port ?? preferredPort().port);
    const preferred = targets.find((t) => t.kind === 'lan') || targets.find((t) => t.kind === 'radmin') || targets[0];
    if (!preferred) return { ok: false, error: '没有可用的地址（没检测到局域网 / VPN 网卡）', code: value };
    const link = inviteUrl(preferred.url, value);
    const alt = targets.filter((t) => t !== preferred).slice(0, 3).map((t) => inviteUrl(t.url, value));
    return { ok: true, code: value, link, alt, text: [link, ...alt].join('\r\n') };
  });
  ipcMain.handle('sp:quit', () => { app.quit(); return true; });
}

// ------------------------------------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------------------------------------

function startStatsTimer() {
  const timer = setInterval(() => pushState(), STATS_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function startBoot() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // A second double-click must focus the running host, not fight over port 3000.
    app.quit();
    return;
  }
  app.on('second-instance', () => focusPanel());

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    log('--- quit ---');
    if (srv) {
      e.preventDefault();
      const watchdog = setTimeout(() => { log('[shutdown] forced exit'); app.exit(0); }, 5000);
      watchdog.unref?.();
      stopGameServer().finally(() => { clearTimeout(watchdog); app.quit(); });
    }
  });

  app.whenReady().then(async () => {
    rotateLog();
    log(`--- 独立服务器 v${APP_VERSION} start (electron ${process.versions.electron}, node ${process.versions.node}, ${process.platform}) ---`);
    for (const [name, dir] of Object.entries(RES)) {
      if (!fs.existsSync(dir)) log(`[boot] WARNING missing ${name}: ${dir}`);
    }
    readWindowBounds();
    registerIpc();
    buildMenu();
    createPanel();
    startStatsTimer();
    await startGameServer();
    pushState();
  }).catch((e) => {
    log('[boot] fatal', e);
    dialog.showErrorBox('启动失败', String(e?.stack || e));
    app.exit(1);
  });
}

/**
 * Internals, exported only so a plain-Node check can import this module's pure helpers without starting
 * Electron (`node -e "import('./server-app/main.js').then(m => m._internal.preferredPort())"` fails outside
 * Electron, so this exists for the panel/preload test path and for future unit tests).
 */
export const _internal = { snapshot, preferredPort, preferredHost };
