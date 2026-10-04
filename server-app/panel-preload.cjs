// server-app/panel-preload.cjs — the only bridge the 开服面板 exposes to its own window.
//
// CommonJS on purpose: a sandboxed preload may not be an ES module. The renderer is a local file with no
// remote content, but it still gets no Node: `contextIsolation: true, nodeIntegration: false, sandbox: true`
// (see server-app/main.js) and this narrow, promise-based API.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spServer', {
  /**
   * Current snapshot: port/host, share addresses, live counters, share text, log path.
   * @returns {Promise<object>}
   */
  state: () => ipcRenderer.invoke('sp:state'),
  /** @param {string} text @returns {Promise<{ok: boolean, length?: number, error?: string}>} */
  copy: (text) => ipcRenderer.invoke('sp:copy', text),
  openBrowser: () => ipcRenderer.invoke('sp:open-browser'),
  openFolder: () => ipcRenderer.invoke('sp:open-folder'),
  stop: () => ipcRenderer.invoke('sp:stop'),
  start: () => ipcRenderer.invoke('sp:start'),
  /** Invite link(s) for a room code the host typed. @param {string} code */
  invite: (code) => ipcRenderer.invoke('sp:invite', code),
  quit: () => ipcRenderer.invoke('sp:quit'),
  /**
   * Subscribe to the main process's live pushes (every 2 s).
   * @param {(state: object) => void} fn
   * @returns {() => void} unsubscribe
   */
  onState: (fn) => {
    const listener = (_event, state) => fn(state);
    ipcRenderer.on('sp:state', listener);
    return () => ipcRenderer.removeListener('sp:state', listener);
  },
});
