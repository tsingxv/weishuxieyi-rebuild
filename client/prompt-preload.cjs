// client/prompt-preload.cjs — the bridge for the one-click invite prompt.
//
// Same posture as client/preload.cjs: a sandboxed CommonJS preload exposing a tiny, fixed surface over
// `contextBridge`. The prompt page gets no Node, no `require`, no `ipcRenderer` — only the five
// functions below, each of which talks to one `sp:*` handler in client/main.js.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spPrompt', {
  /**
   * The invite this prompt window is showing.
   * @returns {Promise<{code: string, server: string|null, hostNote: string|null, source: string}|null>}
   */
  info: () => ipcRenderer.invoke('sp:prompt-info'),
  /** 进入房间: configure the host (if the link named a new one) and open the game's `?room=CODE` link. */
  accept: () => ipcRenderer.invoke('sp:prompt-accept'),
  /** 忽略: hide the prompt; the same clipboard text will not prompt again. */
  ignore: () => ipcRenderer.invoke('sp:prompt-ignore'),
  /** 不再提示: turn clipboard watching off for good (the settings checkbox reflects it). */
  never: () => ipcRenderer.invoke('sp:prompt-never'),
  /** Main-process pushes a new invite into an already-open prompt window. */
  onInvite: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('sp:prompt', handler);
    return () => ipcRenderer.removeListener('sp:prompt', handler);
  },
});
