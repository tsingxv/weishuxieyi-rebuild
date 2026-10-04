// client/preload.cjs — the bridge for the two client-owned windows (settings + invite prompt).
//
// CommonJS on purpose: a sandboxed preload may not be an ES module. The game window has no preload at
// all, so the renderer that runs the game keeps the exact privileges it has in a browser.
//
// The prompt window loads client/prompt-preload.cjs instead, so a page can never reach the settings
// IPC by accident: this file only exposes `spClient`, that one only exposes `spPrompt`.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spClient', {
  /** @returns {Promise<{server: string, current: string, recent: string[], defaultServer: string, connected: boolean, localPort: number|null, version: string, userData: string, clipboardWatch: boolean}>} */
  config: () => ipcRenderer.invoke('sp:config'),
  /** @param {string} server @returns {Promise<{ok: boolean, label?: string, error?: string}>} */
  save: (server) => ipcRenderer.invoke('sp:save', server),
  /** @param {string} server @returns {Promise<{ok: boolean, error?: string, protocol?: number|null, app?: string|null, uptimeSec?: number|null, sockets?: number|null, rooms?: number|null}>} */
  test: (server) => ipcRenderer.invoke('sp:test', server),
  /** 自动识别剪贴板中的房间码 — persisted, and applied to the running watcher immediately. */
  /** @param {boolean} enabled @returns {Promise<{ok: boolean, clipboardWatch: boolean}>} */
  setClipboardWatch: (enabled) => ipcRenderer.invoke('sp:set-clipboard-watch', enabled),
  close: () => ipcRenderer.invoke('sp:close-settings'),
  openLog: () => ipcRenderer.invoke('sp:open-log'),
});
