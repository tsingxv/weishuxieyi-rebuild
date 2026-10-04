// client/serverAddress.js — the host address a player types in the desktop client, normalised into the
// URLs the client needs (DESIGN §14: a browser renderer only ever talks to the host's /ws socket; all
// textures, data and combat logic live in the client itself).
//
// Accepted inputs (case-insensitive scheme, spaces trimmed):
//   192.168.1.2                 26.100.222.17:3000         (Radmin VPN)
//   192.168.1.2:3000            http://192.168.1.2:3000/
//   https://game.example.com    wss://example.com:3000
// The port defaults to 3000 (the server's own default) and a path is ignored: the game is only ever
// served from the root of the host (see docs/DEPLOY.md).
//
// Pure module: no Electron, no I/O — used by the main process, the settings window and the tests.

/** Default port of the game server (`PORT`, see server/index.js). */
export const DEFAULT_PORT = 3000;

/** Longest address we accept (anything longer cannot be a host and is rejected before parsing). */
const MAX_INPUT = 300;

/**
 * @typedef {object} ServerAddress
 * @property {string} hostname  host without port (IPv6 without brackets), e.g. '192.168.1.2'
 * @property {number} port
 * @property {boolean} secure   https/wss
 * @property {string} base      `http(s)://host:port` — the server origin, no trailing slash
 * @property {string} ws        `ws(s)://host:port/ws`
 * @property {string} health    `http(s)://host:port/healthz`
 * @property {string} label     `host:port` (what the UI shows)
 */

/**
 * Normalise a typed host address.
 *
 * Port default: a bare host (`192.168.1.2`) means the game server on its own default port (3000),
 * which is what a player types; an explicit `https://host` means the scheme's default (443), which is
 * what a reverse proxy in front of the server looks like.
 * @param {unknown} input
 * @param {{ defaultPort?: number }} [opts]
 * @returns {ServerAddress | null} null when the input cannot address a host
 */
export function parseServerAddress(input, { defaultPort = DEFAULT_PORT } = {}) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw || raw.length > MAX_INPUT) return null;
  // Pasted addresses sometimes carry the usual invisible junk; a NUL/newline would corrupt a URL.
  raw = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, '');
  if (!raw) return null;
  const schemeGiven = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  // Also accept a socket URL pasted from the host's console (`ws://…/ws`) — same server, same port.
  const normalized = schemeGiven
    ? raw.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://')
    : `http://${raw}`;

  let url;
  try { url = new URL(normalized); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // WHATWG keeps the brackets on an IPv6 hostname; re-add them ourselves so `base` stays valid.
  const bare = (url.hostname || '').replace(/^\[|\]$/g, '');
  if (!bare) return null;
  if (!/^[A-Za-z0-9._~%!$&'()*+,;=:@-]+$/.test(bare)) return null; // no spaces / slashes / delimiters

  // Port: an explicit `:port` always wins; otherwise a bare host means the game server's port (3000)
  // while a written-out scheme means the scheme's conventional port (http 80 / https 443).
  let port = schemeGiven ? (url.protocol === 'https:' ? 443 : 80) : defaultPort;
  if (url.port !== '') port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = bare.includes(':') ? `[${bare}]` : bare;
  const secure = url.protocol === 'https:';
  const base = `${url.protocol}//${host}:${port}`;
  return {
    hostname: bare,
    port,
    secure,
    base,
    ws: `${secure ? 'wss' : 'ws'}://${host}:${port}/ws`,
    health: `${base}/healthz`,
    label: `${host}:${port}`,
  };
}

/** Whether two typed addresses point at the same server (`''`/null are equal to each other). */
export function sameAddress(a, b) {
  const pa = parseServerAddress(a);
  const pb = parseServerAddress(b);
  if (!pa || !pb) return !pa && !pb;
  return pa.base === pb.base;
}

/**
 * Friendly one-line reason for a rejected address (shown in the settings window).
 * @param {unknown} input
 * @returns {string | null} null when the input is acceptable
 */
export function addressError(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '请填写主机地址';
  if (parseServerAddress(raw)) return null;
  if (raw.length > MAX_INPUT) return '地址过长';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^(https?|wss?):\/\//i.test(raw)) return '只支持 http:// / https:// 地址';
  return '地址格式无效（示例：192.168.1.2:3000）';
}
