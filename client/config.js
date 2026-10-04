// client/config.js — the desktop client's own settings file (`<userData>/client-config.json`).
//
// Deliberately tiny and forgiving: a corrupt or hand-edited file must never stop the client from
// starting (a friend with a broken config should still get the settings window, not a crash).
//
// Pure module (no Electron) — the file path is passed in.

import fs from 'node:fs';
import path from 'node:path';
import { parseServerAddress } from './serverAddress.js';

/** First choice for the loopback port. A stable origin is what keeps the player name and the
 *  reconnect token in localStorage across launches, so this is persisted once chosen. */
export const DEFAULT_LOCAL_PORT = 41888;

/** How many previously used host addresses the settings window offers. */
export const MAX_RECENT = 5;

/** @typedef {{ server: string, localPort: number, recent: string[], clipboardWatch: boolean, window: { width: number, height: number, x: number|null, y: number|null, maximized: boolean } }} ClientConfig */

/** @returns {ClientConfig} */
export function defaultConfig() {
  return {
    server: '',
    localPort: DEFAULT_LOCAL_PORT,
    recent: [],
    // Settings-window checkbox 自动识别剪贴板中的房间码; on by default (that is the feature).
    clipboardWatch: true,
    window: { width: 1440, height: 860, x: null, y: null, maximized: false },
  };
}

const clampInt = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);

/**
 * Coerce anything read from disk into a usable config (unknown keys are dropped on write, not kept).
 * @param {unknown} raw
 * @returns {ClientConfig}
 */
export function normalizeConfig(raw) {
  const out = defaultConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.server === 'string') out.server = parseServerAddress(raw.server) ? raw.server.trim() : '';
  out.localPort = clampInt(Number(raw.localPort), 1024, 65535, DEFAULT_LOCAL_PORT);
  if (Array.isArray(raw.recent)) {
    const seen = new Set();
    for (const item of raw.recent) {
      if (typeof item !== 'string' || !parseServerAddress(item)) continue;
      const key = parseServerAddress(item).base;
      if (seen.has(key)) continue;
      seen.add(key);
      out.recent.push(item.trim());
      if (out.recent.length >= MAX_RECENT) break;
    }
  }
  // Only an explicit `false` disables clipboard watching: a hand-edited `"clipboardWatch": "no"` or a
  // missing key must leave the feature on, exactly like the checkbox's default.
  out.clipboardWatch = raw.clipboardWatch !== false;
  const w = raw.window && typeof raw.window === 'object' && !Array.isArray(raw.window) ? raw.window : {};
  out.window = {
    width: clampInt(Number(w.width), 900, 8000, 1440),
    height: clampInt(Number(w.height), 560, 8000, 860),
    x: Number.isFinite(w.x) ? Math.round(w.x) : null,
    y: Number.isFinite(w.y) ? Math.round(w.y) : null,
    maximized: w.maximized === true,
  };
  return out;
}

/**
 * Read the config file; a missing/unreadable/corrupt file yields the defaults.
 * @param {string} file
 * @param {{ log?: (...a: any[]) => void }} [opts]
 * @returns {ClientConfig}
 */
export function readConfig(file, { log = () => {} } = {}) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return normalizeConfig(JSON.parse(text));
  } catch (e) {
    if (e && e.code !== 'ENOENT') log(`[config] ignoring ${file}: ${e.message}`);
    return defaultConfig();
  }
}

/**
 * Persist the config (write + rename, so a crash mid-write cannot truncate the file).
 * @param {string} file
 * @param {unknown} config
 * @param {{ log?: (...a: any[]) => void }} [opts]
 * @returns {ClientConfig} the normalised config that was written
 */
export function writeConfig(file, config, { log = () => {} } = {}) {
  const cfg = normalizeConfig(config);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`[config] cannot save ${file}: ${e.message}`);
  }
  return cfg;
}

/**
 * Remember a host address (moves it to the front of `recent`, dedup by origin).
 * @param {ClientConfig} config
 * @param {string} server
 * @returns {ClientConfig}
 */
export function rememberServer(config, server) {
  const parsed = parseServerAddress(server);
  if (!parsed) return normalizeConfig(config);
  const text = server.trim();
  const recent = [text, ...(Array.isArray(config.recent) ? config.recent : []).filter((s) => {
    const p = parseServerAddress(s);
    return p && p.base !== parsed.base;
  })].slice(0, MAX_RECENT);
  return normalizeConfig({ ...config, server: text, recent });
}
