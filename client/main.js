// client/main.js — Electron main process of the desktop client (desktop shell around the web game).
//
// What the shell does (DESIGN §14 — "client-side combat"):
//   1. serves the bundled payload (public/, data/, shared/, server/sim/) over loopback, reusing the
//      server's own static handler, so every root-relative URL resolves with no network access;
//   2. tunnels the renderer's `/ws` socket to the host address the player configured — all textures,
//      data and combat logic stay on the client, only per-round results and the shared boss pool travel;
//   3. offers the host address dialog, remembers it, and blocks every other outbound HTTP request so an
//      installed client behaves identically offline.
//
// The host still runs the game server exactly as before (`npm start`, see docs/DEPLOY.md); this shell
// never starts a second server.

import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, screen, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalServer } from './localServer.js';
import { DEFAULT_LOCAL_PORT, readConfig, rememberServer, writeConfig } from './config.js';
import { addressError, parseServerAddress, sameAddress } from './serverAddress.js';
import { CODE_LEN, parseInvite, roomQuery } from './invite.js';
import { createClipboardWatcher } from './clipboardWatcher.js';

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** App root: the repository root in development, `<install>/resources/app` when packaged. The payload
 *  keeps the repository layout in both cases, so nothing here needs to know which one it is. */
const APP_DIR = path.resolve(CLIENT_DIR, '..');
const RES = {
  publicDir: path.join(APP_DIR, 'public'),
  dataDir: path.join(APP_DIR, 'data'),
  sharedDir: path.join(APP_DIR, 'shared'),
  simDir: path.join(APP_DIR, 'server', 'sim'),
};

const BUILD_INFO = readBuildInfo();
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'client-config.json');
const LOG_FILE = () => path.join(app.getPath('userData'), 'client.log');
const MAX_LOG_BYTES = 512 * 1024;

// Argument-level setup, before anything may touch the user-data directory.
// `--client-data-dir=` puts the config/log somewhere explicit (the smoke test uses a temp dir);
// `--sandbox-probe` is what 启动游戏.cmd and scripts/smoke-client.mjs start to find out whether
// Chromium's sandbox can initialise here — the process either dies before `whenReady()` (broken
// sandbox: no JS runs at all) or reaches it and exits immediately.
if (process.argv.some((a) => a === '--sandbox-probe')) {
  app.whenReady().then(() => app.exit(0), () => app.exit(1));
} else {
  boot();
}

/** `--invite-probe`: boot normally, then exercise 一键进房 end to end and exit. See runInviteProbe(). */
const INVITE_PROBE = process.argv.some((a) => a === '--invite-probe');

function boot() {
  const dataDirArg = process.argv.find((a) => a.startsWith('--client-data-dir='));
  if (dataDirArg) {
    const dir = path.resolve(dataDirArg.slice('--client-data-dir='.length));
    try { app.setPath('userData', dir); } catch (e) { console.error('[boot] bad --client-data-dir', e); }
  }
  startBoot();
}

/** @type {import('./config.js').ClientConfig} */
let config = null;
/** @type {ReturnType<typeof createLocalServer> | null} */
let local = null;
/** @type {BrowserWindow | null} */ let mainWindow = null;
/** @type {BrowserWindow | null} */ let settingsWindow = null;
/** @type {BrowserWindow | null} */ let promptWindow = null;
/** The invite currently shown by `promptWindow` (also what `sp:prompt-info` answers with). */
/** @type {import('./invite.js').Invite | null} */ let pendingInvite = null;
/** Loopback origin of the current session; the deep link is built from it. */
let loopbackOrigin = '';
/** @type {ReturnType<typeof createClipboardWatcher> | null} */ let watcher = null;
/** Suppress the prompt between "the player accepted" and "the game navigated". */
let promptBusy = false;

// ------------------------------------------------------------------------------------------------
// Logging (a friend on a LAN cannot open devtools over the phone: keep a file they can send back)
// ------------------------------------------------------------------------------------------------

function rotateLog() {
  try {
    const file = LOG_FILE();
    const st = fs.statSync(file);
    if (st.size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* no log yet */ }
}

function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  if (process.env.SP_CLIENT_DEBUG) console.log(line);
  try {
    fs.appendFileSync(LOG_FILE(), `${line}\n`);
  } catch { /* logging must never break the client */ }
}

function readBuildInfo() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'build-info.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function appVersion() {
  if (typeof BUILD_INFO.version === 'string' && BUILD_INFO.version) return BUILD_INFO.version;
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ------------------------------------------------------------------------------------------------
// Host address
// ------------------------------------------------------------------------------------------------

/** The address to dial: `--server=` beats the saved config beats the build-time default. */
function initialServer() {
  const arg = process.argv.find((a) => a.startsWith('--server='));
  const fromArg = arg ? arg.slice('--server='.length) : '';
  if (parseServerAddress(fromArg)) return fromArg.trim();
  if (parseServerAddress(config?.server)) return config.server;
  if (parseServerAddress(BUILD_INFO.defaultServer)) return BUILD_INFO.defaultServer;
  return '';
}

function argValue(name) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : '';
}

function preferredPort() {
  const fromArg = Number(argValue('local-port'));
  if (Number.isInteger(fromArg) && fromArg >= 1024 && fromArg <= 65535) return fromArg;
  const fromEnv = Number(process.env.SP_CLIENT_PORT);
  if (Number.isInteger(fromEnv) && fromEnv >= 1024 && fromEnv <= 65535) return fromEnv;
  return config?.localPort || DEFAULT_LOCAL_PORT;
}

/** Persist a change and re-point the tunnel; the game window reloads so the new host is dialled. */
function applyServer(server, { reload = true } = {}) {
  const parsed = parseServerAddress(server);
  config = parsed ? rememberServer(config, server) : { ...config, server: '' };
  writeConfig(CONFIG_FILE(), config);
  local?.setTarget(parsed ? parsed.ws : null);
  if (reload && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  updateTitle();
  return parsed;
}

async function probeServer(server) {
  const parsed = parseServerAddress(server);
  if (!parsed) return { ok: false, error: addressError(server) || '地址无效' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await net.fetch(parsed.health, { signal: ac.signal, cache: 'no-store' });
    if (!res.ok) return { ok: false, error: `服务器返回 HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return { ok: false, error: '响应不是游戏服务器（/healthz 无 JSON）' };
    return {
      ok: true,
      protocol: body.version ?? null,
      app: body.app ?? null,
      uptimeSec: Number.isFinite(body.uptimeSec) ? body.uptimeSec : null,
      sockets: Number.isFinite(body.sockets) ? body.sockets : null,
      rooms: Number.isFinite(body.rooms) ? body.rooms : null,
    };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? '连接超时（5 秒）' : (e?.message || String(e));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------------------------------------
// Window
// ------------------------------------------------------------------------------------------------

/** Keep a remembered position only when it still lands on a connected display. */
function usableBounds(w) {
  const bounds = { width: w.width, height: w.height };
  if (Number.isFinite(w.x) && Number.isFinite(w.y)) {
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.bounds;
      return w.x < b.x + b.width - 40 && w.x + 120 > b.x && w.y < b.y + b.height - 40 && w.y + 60 > b.y;
    });
    if (visible) { bounds.x = w.x; bounds.y = w.y; }
  }
  return bounds;
}

function updateTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const parsed = parseServerAddress(config?.server);
  mainWindow.setTitle(`卫戍协议：盟约 · STRONGHOLD PROTOCOL — ${parsed ? parsed.label : '未设置服务器'}`);
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    ...usableBounds(config.window),
    minWidth: 1024,
    minHeight: 600,
    show: false,
    backgroundColor: '#0c0f0e',
    title: '卫戍协议：盟约 · STRONGHOLD PROTOCOL',
    autoHideMenuBar: false,
    webPreferences: {
      // The renderer is the unchanged web game: no bridge, no Node, its own sandbox.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.on('page-title-updated', (e) => { e.preventDefault(); updateTitle(); });
  mainWindow.once('ready-to-show', () => {
    if (config.window.maximized) mainWindow.maximize();
    mainWindow.show();
    updateTitle();
  });
  mainWindow.on('close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const b = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    config = { ...config, window: { width: b.width, height: b.height, x: b.x, y: b.y, maximized } };
    writeConfig(CONFIG_FILE(), config);
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // This window is the game; never let it become a browser for something else.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      log(`[nav] blocked ${target}`);
      if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    }
  });
  mainWindow.on('enter-full-screen', () => mainWindow.setMenuBarVisibility(false));
  mainWindow.on('leave-full-screen', () => mainWindow.setMenuBarVisibility(true));
  mainWindow.loadURL(url);
  log(`[window] loading ${url}`);
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 600,
    height: 660,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: '服务器设置 · 卫戍协议：盟约',
    backgroundColor: '#111614',
    autoHideMenuBar: true,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: {
      preload: path.join(CLIENT_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadFile(path.join(CLIENT_DIR, 'settings.html'));
}

// ------------------------------------------------------------------------------------------------
// 一键进房 — the clipboard invite prompt
//
// The prompt is its own window, not an overlay injected into the game. Three reasons:
//   * the game window must keep `contextIsolation:true / nodeIntegration:false / sandbox:true` and no
//     preload at all, so there is nothing in it to inject through;
//   * a `focusable:false, alwaysOnTop, skipTaskbar` child window cannot steal focus from the match —
//     clicking its buttons leaves the game window focused, so keyboard/mouse play continues;
//   * it is dismissible without touching the game, and it follows the game window.
//
// Placement: bottom-left, *above* the in-match corner row. Evidence from public/css:
//   * `screens/game.css:338` `.gm__corner { left: .24rem; bottom: .24rem }` holds the settings gear
//     and the 表情 button — a `.56rem`-tall row (`game.css:340`, `game.css:348`) — and it is the only
//     bottom-left occupant of a match (everything else anchored bottom-left across public/css is a
//     full-width bar or decoration: `components.css:78`, `screens/game-panels.css` bars,
//     `screens/game-shop.css:216`, `screens/title.css:110`, `screens/lobby.css:182`);
//   * the bottom-centre (`screens/game.css:434` `.chud__bottom`, `components.css:851` `.conn-banner`)
//     and the top-centre toasts (`components.css:807`, lifted to `1.34rem` in a match by
//     `components.css:878`) are the other live regions, and the bottom-right belongs to the shop bar
//     (`screens/game-shop.css:169`). Nothing anchors bottom-left on lobby/title/room either.
// `html { font-size: clamp(40px, min(100vw/19.2, 100vh/10.8), 240px) }` (theme.css:110) is the rem the
// game's CSS is written in, so the prompt computes the same rem and lifts itself by one corner row.
//
// Note the deferral above makes the in-match geometry a safety net rather than the normal case: the
// prompt is held until `sp-in-match` clears, so it lands on the lobby/result screen where the corner
// is empty. It still clears the corner so a stray `.ewheel__panel` (which opens upward from
// `game.css:355`) can never be covered.
// ------------------------------------------------------------------------------------------------

const PROMPT_WIDTH = 350;
/** Fits client/prompt.html exactly: padding 23 + header 23 + body 36.5 + buttons 45.75 ≈ 128.5. */
const PROMPT_HEIGHT = 132;
/** How often a held-back invite is re-checked while a match is on screen. */
const MATCH_POLL_MS = 5000;

/** The `rem` the game's CSS is written in (`theme.css:110`), for the game window's content box. */
function gameRem(content) {
  return Math.max(40, Math.min(Math.min(content.width / 19.2, content.height / 10.8), 240));
}

/** Screen bounds for the prompt, anchored inside the game window's content area. */
function promptBounds(inMatch) {
  const b = mainWindow.getContentBounds();
  const rem = gameRem(b);
  // Out of a match: the plain bottom-left corner. In a match: clear `.gm__corner`, which owns
  // `bottom: .24rem` plus one `.56rem` row, with a hair of margin.
  const inset = inMatch ? rem * (0.24 + 0.56) + 8 : rem * 0.24;
  const height = Math.min(PROMPT_HEIGHT, Math.max(80, b.height - 40));
  const y = b.y + b.height - Math.round(inset) - height;
  return { x: b.x + Math.round(rem * 0.24), y: Math.round(Math.max(b.y + 8, y)), width: PROMPT_WIDTH, height };
}

/** Whether the game says a match is on screen (`useDocClass('sp-in-match')`, game.js:171). */
async function inMatch() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const flagged = await mainWindow.webContents.executeJavaScript(
      "document.documentElement.classList.contains('sp-in-match')", true,
    );
    return flagged === true;
  } catch {
    return false; // no page yet / reloading: the corner is empty then
  }
}

/** What the prompt window needs to render one invite. */
function promptPayload(invite) {
  const current = parseServerAddress(config?.server);
  const incoming = invite.address;
  const differs = Boolean(incoming && !invite.loopback && !sameAddress(invite.server, config?.server));
  return {
    code: invite.code,
    // Only advertise a host when it is a *different* one: an invite pointing at the server the player
    // is already on must not look like it is about to reconfigure anything.
    server: differs ? incoming.label : null,
    current: current ? current.label : null,
    hostNote: differs ? `点「进入房间」会同时把服务器换成 ${incoming.label}` : null,
    source: invite.source,
  };
}

function hidePrompt() {
  pendingInvite = null;
  if (promptWindow && !promptWindow.isDestroyed() && promptWindow.isVisible()) promptWindow.hide();
}

/** Keep the prompt glued to the game window's bottom-left corner. */
async function repositionPrompt() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!promptWindow || promptWindow.isDestroyed() || !promptWindow.isVisible()) return;
  try {
    promptWindow.setBounds(promptBounds(await inMatch()));
  } catch { /* the window went away mid-flight */ }
}

/** Whether it is currently appropriate to put a card on screen at all. */
function canPrompt() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
}

async function showPrompt(invite) {
  if (!canPrompt()) return;
  if (!config || config.clipboardWatch === false) return;
  pendingInvite = invite;
  const payload = promptPayload(invite);
  const bounds = promptBounds(await inMatch());

  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow.setBounds(bounds);
    promptWindow.webContents.send('sp:prompt', payload);
    promptWindow.showInactive();
    log(`[invite] prompting for ${invite.code}`);
    return;
  }

  promptWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // The whole point: visible and clickable, but it never takes focus away from the match.
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: '收到房间邀请',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(CLIENT_DIR, 'prompt-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  promptWindow.setAlwaysOnTop(true, 'floating');
  promptWindow.on('closed', () => { promptWindow = null; });
  promptWindow.once('ready-to-show', () => {
    if (promptWindow && !promptWindow.isDestroyed()) promptWindow.showInactive();
  });
  try {
    await promptWindow.loadFile(path.join(CLIENT_DIR, 'prompt.html'));
  } catch (e) {
    log(`[invite] cannot open the prompt window: ${e && e.message ? e.message : e}`);
    return;
  }
  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow.setBounds(promptBounds(await inMatch()));
    promptWindow.showInactive();
  }
  log(`[invite] prompting for ${invite.code}${payload.server ? ` (host ${payload.server})` : ''}`);
}

/** An invite that arrived while a match was on screen, waiting for the match to end. */
/** @type {import('./invite.js').Invite | null} */ let deferredInvite = null;
let matchTimer = null;
let matchCheckRunning = false;

function stopMatchTimer() {
  if (matchTimer) clearInterval(matchTimer);
  matchTimer = null;
}

function startMatchTimer() {
  if (matchTimer) return;
  matchTimer = setInterval(async () => {
    if (matchCheckRunning) return;
    if (!deferredInvite) { stopMatchTimer(); return; }
    matchCheckRunning = true;
    try {
      if (await inMatch()) return;
      const invite = deferredInvite;
      deferredInvite = null;
      stopMatchTimer();
      log(`[invite] ${invite.code} was held back during a match — prompting now`);
      await showPrompt(invite);
    } finally {
      matchCheckRunning = false;
    }
  }, MATCH_POLL_MS);
  if (typeof matchTimer.unref === 'function') matchTimer.unref();
}

/**
 * An invite was recognised in the clipboard: prompt now, or hold it back until the match is over.
 * Putting this card over a live fight is exactly what the feature must not do, and the player cannot
 * act on an invite mid-round anyway.
 */
async function handleInvite(invite) {
  if (!config || config.clipboardWatch === false || promptBusy) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return;
  if (await inMatch()) {
    deferredInvite = invite;
    startMatchTimer();
    log(`[invite] ${invite.code} held back — a match is on screen`);
    return;
  }
  await showPrompt(invite);
}

/**
 * Join through the game's own deep link: navigate to `<loopback>/?room=CODE` and let
 * `parseRoomParam()` + `schedulePendingJoin()` (public/js/main.js) do the actual join. There is
 * deliberately no second join path, so the client behaves exactly like a browser opening that link.
 */
async function joinRoom(code) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const url = `${loopbackOrigin}/${roomQuery(code)}`;
  log(`[invite] opening ${url}`);
  await mainWindow.webContents.loadURL(url);
  mainWindow.show();
  return true;
}

async function acceptInvite() {
  const invite = pendingInvite;
  if (!invite) return { ok: false, error: '邀请已失效' };
  promptBusy = true;
  try {
    // 由邀请链接自动配置服务器: adopt the host the link names. No reload — the deep-link navigation
    // below is the reload, and it must not be raced by a second one.
    if (invite.address && !invite.loopback && !sameAddress(invite.server, config?.server)) {
      const parsed = applyServer(invite.server, { reload: false });
      log(`[invite] server switched to ${parsed.label}`);
    }
    hidePrompt();
    await joinRoom(invite.code);
    return { ok: true, code: invite.code };
  } catch (e) {
    log(`[invite] join failed: ${e && e.message ? e.message : e}`);
    return { ok: false, error: '打开房间失败，请重试' };
  } finally {
    promptBusy = false;
  }
}

/** 不再提示: the checkbox in the settings window and this button write the same flag. */
function setClipboardWatch(enabled) {
  const on = enabled !== false;
  if (config) {
    config = { ...config, clipboardWatch: on };
    writeConfig(CONFIG_FILE(), config);
  }
  watcher?.setEnabled(on);
  if (!on) {
    deferredInvite = null;
    stopMatchTimer();
    hidePrompt();
  }
  log(`[invite] clipboard watching ${on ? 'enabled' : 'disabled'}`);
  return on;
}

function buildMenu() {
  const template = [
    {
      label: '游戏',
      submenu: [
        { label: '重新载入 (F5)', accelerator: 'F5', click: () => mainWindow?.webContents.reload() },
        { label: '重新连接', click: () => mainWindow?.webContents.executeJavaScript('try{globalThis.__SP__&&globalThis.__SP__.net.reconnectNow()}catch(e){}') },
        { type: 'separator' },
        { label: '服务器设置…', accelerator: 'CommandOrControl+,', click: () => openSettings() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '全屏', role: 'togglefullscreen' },
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
          label: '关于',
          click: () => dialog.showMessageBox(mainWindow ?? undefined, {
            type: 'info',
            title: '关于',
            message: `卫戍协议：盟约 · 桌面客户端 v${appVersion()}`,
            detail: [
              '非官方同人作品，仅供个人非商业联机游玩。',
              `服务器：${parseServerAddress(config?.server)?.label ?? '未设置'}`,
              `本地端口：${local?.port ?? '-'}`,
              `数据目录：${app.getPath('userData')}`,
            ].join('\n'),
            buttons: ['确定'],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------------------------------------
// IPC (settings window)
// ------------------------------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('sp:config', () => ({
    server: config?.server ?? '',
    current: parseServerAddress(config?.server)?.label ?? '',
    recent: config?.recent ?? [],
    defaultServer: BUILD_INFO.defaultServer ?? '',
    connected: Boolean(local?.target),
    localPort: local?.port ?? null,
    version: appVersion(),
    userData: app.getPath('userData'),
    clipboardWatch: config?.clipboardWatch !== false,
  }));

  ipcMain.handle('sp:save', (_e, server) => {
    const error = addressError(server);
    if (error) return { ok: false, error };
    const parsed = applyServer(server);
    log(`[settings] server set to ${parsed.label}`);
    return { ok: true, label: parsed.label };
  });

  ipcMain.handle('sp:test', async (_e, server) => probeServer(server));

  ipcMain.handle('sp:set-clipboard-watch', (_e, enabled) => ({ ok: true, clipboardWatch: setClipboardWatch(enabled) }));

  ipcMain.handle('sp:close-settings', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    return true;
  });

  ipcMain.handle('sp:open-log', () => shell.openPath(app.getPath('userData')));

  // --- the invite prompt window (client/prompt-preload.cjs) -------------------------------------
  ipcMain.handle('sp:prompt-info', () => (pendingInvite ? promptPayload(pendingInvite) : null));
  ipcMain.handle('sp:prompt-accept', () => acceptInvite());
  ipcMain.handle('sp:prompt-ignore', () => { hidePrompt(); return { ok: true }; });
  ipcMain.handle('sp:prompt-never', () => ({ ok: true, clipboardWatch: setClipboardWatch(false) }));
}

// ------------------------------------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------------------------------------

/**
 * Block every outbound request except the loopback payload server. The payload is complete (textures,
 * fonts, data, sim), so the only thing an installed client may reach is its own origin; the Google
 * Fonts links in public/index.html are stopped here instead of hanging on an offline DNS lookup.
 */
function blockExternalRequests(port) {
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `ws://127.0.0.1:${port}`, `ws://localhost:${port}`];
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const url = details.url || '';
    if (allowed.some((p) => url.startsWith(p))) return callback({});
    if (/^(https?|wss?):\/\//i.test(url)) {
      log(`[net] blocked ${url}`);
      return callback({ cancel: true });
    }
    return callback({});
  });
}

async function start() {
  rotateLog();
  log(`--- client v${appVersion()} start (electron ${process.versions.electron}, ${process.platform}) ---`);
  for (const [name, dir] of Object.entries(RES)) {
    if (!fs.existsSync(dir)) log(`[boot] WARNING missing ${name}: ${dir}`);
  }

  config = readConfig(CONFIG_FILE(), { log });
  local = createLocalServer({ ...RES, log });
  const port = await local.listen(preferredPort());
  if (port !== config.localPort) {
    config = { ...config, localPort: port };
    writeConfig(CONFIG_FILE(), config);
  }

  const origin = `http://127.0.0.1:${port}`;
  blockExternalRequests(port);
  registerIpc();
  buildMenu();

  const server = initialServer();
  if (server) {
    // `--server=` / the build-time default become the remembered address, so the settings window shows
    // it as current and it stays put across launches.
    config = rememberServer(config, server);
    writeConfig(CONFIG_FILE(), config);
  }
  local.setTarget(server ? parseServerAddress(server).ws : null);
  loopbackOrigin = origin;
  createMainWindow(`${origin}/`);
  startClipboardWatch();

  if (!server) {
    log('[boot] no host address configured — opening settings');
    openSettings();
  }
}

/**
 * Watch the clipboard for invites (一键进房). Sampling is tied to the window being focused — there is
 * no reason to read somebody's clipboard while they are in another application — and the very first
 * look happens on focus, so a link copied before the client was opened still prompts once.
 */
function startClipboardWatch() {
  watcher = createClipboardWatcher({
    read: () => clipboard.readText(),
    onInvite: (invite) => { handleInvite(invite).catch((e) => log(`[invite] ${e && e.message ? e.message : e}`)); },
    log,
  });
  watcher.setEnabled(config?.clipboardWatch !== false);

  const onFocus = async () => {
    watcher?.start();
    // Electron 44's clipboard.readText() is async, so poll() is a promise; the first look on focus is
    // what makes a link copied *before* the client was opened still prompt once.
    try { await watcher?.poll(); } catch (e) { log(`[invite] ${e && e.message ? e.message : e}`); }
    repositionPrompt();
  };
  const onBlur = () => watcher?.stop();

  mainWindow.on('focus', onFocus);
  mainWindow.on('blur', onBlur);
  mainWindow.on('show', onFocus);
  mainWindow.on('hide', onBlur);
  mainWindow.on('minimize', onBlur);
  mainWindow.on('move', repositionPrompt);
  mainWindow.on('resize', repositionPrompt);
  mainWindow.on('enter-full-screen', repositionPrompt);
  mainWindow.on('leave-full-screen', repositionPrompt);
  mainWindow.on('closed', () => {
    watcher?.stop();
    stopMatchTimer();
    if (promptWindow && !promptWindow.isDestroyed()) promptWindow.destroy();
  });

  if (mainWindow.isFocused()) onFocus();
}

function startBoot() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    log('--- client quit ---');
    local?.close().catch(() => {});
  });

  app.whenReady().then(start).then(() => (INVITE_PROBE ? runInviteProbe() : undefined)).catch((e) => {
    log('[boot] failed', e);
    dialog.showErrorBox('启动失败', String(e?.stack || e));
    app.exit(1);
  });
}

// ------------------------------------------------------------------------------------------------
// `--invite-probe` — the end-to-end check for 一键进房 that the unit tests cannot make.
//
// The unit tests prove the parser and the sampling policy, and pin the wiring by reading the source.
// None of that can prove that Electron actually accepts `focusable:false` + `showInactive()`, that the
// prompt really lands inside the game window, or that the game's own deep link gets loaded. This probe
// boots the real shell, writes an invite to the real clipboard, and reports what happened as JSON on
// stdout. It restores the user's clipboard before exiting.
// ------------------------------------------------------------------------------------------------

function waitFor(predicate, { seconds = 20, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + seconds * 1000;
    const tick = async () => {
      let ok = false;
      try { ok = await predicate(); } catch { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function runInviteProbe() {
  const report = { checks: {}, ok: false };
  // The clipboard is machine-wide: remember what was there and put it back on the way out.
  const savedClipboard = await Promise.resolve(clipboard.readText()).catch(() => '');
  const check = (name, value, detail) => { report.checks[name] = { ok: Boolean(value), detail }; };
  try {
    await waitFor(() => mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading(), { label: 'the game window' });
    // The clipboard is machine-wide state, so the probe must not depend on what a previous run left in
    // it: park a non-invite there and let the focus handler consume it before writing the real one.
    // `writeText()` is async in Electron 44 — an un-awaited write races the read below.
    await clipboard.writeText('卫戍协议：盟约 · 客户端自检');
    watcher.reset();
    mainWindow.focus();
    await new Promise((r) => setTimeout(r, 400));
    await watcher.poll();
    watcher.reset();

    const probeText = 'http://192.168.9.9:3111/?room=WXYZ';
    await clipboard.writeText(probeText);
    const sample = await watcher.poll();
    report.diag = { sample, watcherEnabled: watcher.enabled, cfgWatch: config && config.clipboardWatch };

    await waitFor(() => promptWindow && !promptWindow.isDestroyed() && promptWindow.isVisible(), { seconds: 20, label: 'the invite prompt' });
    // Rendering is driven by IPC, so wait for the payload to land rather than reading the DOM at once.
    const renderedCode = async () => promptWindow.webContents.executeJavaScript(
      "document.getElementById('code').textContent", true,
    ).catch(() => null);
    await waitFor(async () => (await renderedCode()) === 'WXYZ', { seconds: 15, label: 'the prompt to render the room code' });

    const gb = mainWindow.getContentBounds();
    const pb = promptWindow.getBounds();
    const payload = pendingInvite ? promptPayload(pendingInvite) : null;
    const devs = await promptWindow.webContents.executeJavaScript(
      "({ bridge: typeof window.spPrompt, code: document.getElementById('code').textContent,"
      + " buttons: [...document.querySelectorAll('button')].map((b) => b.textContent) })", true,
    );

    check('prompt_visible', promptWindow.isVisible());
    check('prompt_not_focusable', promptWindow.isFocusable() === false, `isFocusable=${promptWindow.isFocusable()}`);
    check('prompt_always_on_top', promptWindow.isAlwaysOnTop());
    check('prompt_not_resizable', promptWindow.isResizable() === false);
    check('game_still_focused', mainWindow.isFocused() === true, `focused=${mainWindow.isFocused()}`);
    check('prompt_inside_game_window',
      pb.x >= gb.x && pb.y >= gb.y && pb.x + pb.width <= gb.x + gb.width && pb.y + pb.height <= gb.y + gb.height,
      `game=${JSON.stringify(gb)} prompt=${JSON.stringify(pb)}`);
    check('prompt_above_bottom_edge', pb.y + pb.height < gb.y + gb.height, `promptBottom=${pb.y + pb.height} gameBottom=${gb.y + gb.height}`);
    check('prompt_bridge_exposed', devs.bridge === 'object', `typeof=${devs.bridge}`);
    check('prompt_shows_code', devs.code === 'WXYZ', `code=${devs.code}`);
    check('prompt_buttons', ['进入房间', '忽略', '不再提示'].every((l) => devs.buttons.includes(l)), `buttons=${JSON.stringify(devs.buttons)}`);
    check('host_from_link', payload && payload.server === '192.168.9.9:3111', `server=${payload && payload.server}`);
    check('host_differs_noted', payload && Boolean(payload.hostNote), `hostNote=${payload && payload.hostNote}`);

    // 进入房间: the game's own deep link must be what gets loaded.
    const accepted = await acceptInvite();
    await waitFor(() => mainWindow.webContents.getURL().includes('room=WXYZ'), { seconds: 15, label: 'the ?room= deep link' });
    const url = mainWindow.webContents.getURL();
    check('join_used_deep_link', url.includes('room=WXYZ') && url.startsWith(loopbackOrigin), url);
    check('server_reconfigured', (config?.server ?? '').includes('192.168.9.9:3111'), `config.server=${config?.server}`);
    check('accept_returned_ok', accepted?.ok === true, JSON.stringify(accepted));
    check('prompt_hidden_after_accept', !promptWindow || promptWindow.isDestroyed() || !promptWindow.isVisible());

    // 不再提示 must persist the flag.
    const never = setClipboardWatch(false);
    check('never_persists', never === false && config.clipboardWatch === false && watcher.enabled === false, `config=${config.clipboardWatch}`);

    // The settings window: the checkbox must render, default ON, and drive the same flag through IPC.
    setClipboardWatch(true);
    openSettings();
    await waitFor(() => settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.webContents.isLoading(), { seconds: 20, label: 'the settings window' });
    const settings = await settingsWindow.webContents.executeJavaScript(
      `({
         bridge: typeof window.spClient,
         hasCheckbox: Boolean(document.getElementById('clipboardWatch')),
         checked: document.getElementById('clipboardWatch').checked,
         label: document.querySelector('label[for="clipboardWatch"]').textContent,
         help: document.body.textContent.includes('剪贴板与邀请'),
         methods: Object.keys(window.spClient),
       })`, true,
    );
    check('settings_bridge_exposed', settings.bridge === 'object', `typeof=${settings.bridge}`);
    check('settings_checkbox_present', settings.hasCheckbox === true);
    check('settings_checkbox_default_on', settings.checked === true);
    check('settings_checkbox_label', settings.label.includes('自动识别剪贴板中的房间码'), settings.label);
    check('settings_help_section', settings.help === true);
    check('settings_has_setter', settings.methods.includes('setClipboardWatch'), JSON.stringify(settings.methods));

    // Toggling it in the page must reach the main process and come back persisted.
    const off = await settingsWindow.webContents.executeJavaScript(
      "window.spClient.setClipboardWatch(false)", true,
    );
    check('settings_toggle_reaches_main', off?.clipboardWatch === false && config.clipboardWatch === false && watcher.enabled === false,
      `ipc=${JSON.stringify(off)} config=${config.clipboardWatch}`);
    const on = await settingsWindow.webContents.executeJavaScript(
      "window.spClient.setClipboardWatch(true)", true,
    );
    check('settings_toggle_back_on', on?.clipboardWatch === true && watcher.enabled === true);
    settingsWindow.close();

    // A disabled watcher must not prompt, however the clipboard changes.
    setClipboardWatch(false);
    await clipboard.writeText('http://192.168.9.9:3111/?room=QQQQ');
    const quiet = await watcher.poll();
    check('disabled_watcher_reads_nothing', quiet.reason === 'disabled' && quiet.invite === null, JSON.stringify(quiet));
    setClipboardWatch(true);

    report.ok = Object.values(report.checks).every((c) => c.ok);
  } catch (e) {
    report.error = String(e && e.stack ? e.stack : e);
  } finally {
    try { await clipboard.writeText(savedClipboard); } catch { /* the clipboard is a courtesy, not a result */ }
    const json = `INVITE_PROBE ${JSON.stringify(report)}\n`;
    // stdout may be detached when the packaged GUI exe is started without a redirect, so the report
    // always also lands next to the config where the harness can read it.
    try { process.stdout.write(`\n${json}`); } catch { /* no console attached */ }
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'invite-probe.json'), json); } catch { /* best effort */ }
    app.exit(report.ok ? 0 : 1);
  }
}
