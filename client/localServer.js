// client/localServer.js — the desktop client's loopback web server.
//
// Why it exists: the whole game is a static site whose every resource URL is root-relative
// (`/assets/...`, `/js/...`, `/data.js`, `/sim/...`), so the renderer cannot be loaded from `file://`.
// This server mounts the exact same static handler as `server/index.js` (single source of truth for
// MIME types, gzip, ETag/304, byte ranges, traversal/dotfile protection and the browser stand-in for
// `server/data.js`), pointed at the payload bundled with the app.
//
// It also owns the one thing that is NOT local: `/ws`. The renderer derives its socket URL from
// `location` (`public/js/net.js` → `defaultWsUrl()`), so it dials `ws://127.0.0.1:<port>/ws` and this
// server transparently tunnels it to the host address the player configured. Two consequences:
//   * no game source has to know it is running inside a desktop shell;
//   * the renderer and the payload share one origin, so there is no CORS/`file://` special case.
//
// Plain Node (no Electron import) so `node --test` can exercise it; see test/client-local-server.test.js.

import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createStaticHandler } from '../server/index.js';

/** Inbound (renderer → server) frame cap; mirrors `WS_MAX_PAYLOAD` in server/index.js. */
export const WS_MAX_PAYLOAD = 64 * 1024;
/** Outbound (server → renderer) cap: generous, a `b.snap` in SP_COMBAT=server mode is large. */
export const UPSTREAM_MAX_PAYLOAD = 4 * 1024 * 1024;
/** How long the tunnel waits for the host's socket before telling the renderer the server is down. */
export const PROXY_HANDSHAKE_TIMEOUT_MS = 8000;
/** Longest request line accepted (mirrors MAX_URL_LENGTH in server/index.js). */
export const MAX_URL_LENGTH = 4096;

const noop = () => {};

/** WebSocket close codes a peer is allowed to send (RFC 6455 §7.4.1 + the private range we use). */
function sendableClose(code) {
  if (!Number.isInteger(code)) return false;
  if (code >= 3000 && code <= 4999) return true;
  return code === 1000 || code === 1001 || code === 1002 || code === 1003
    || (code >= 1007 && code <= 1011);
}

function closeQuietly(ws, code, reason) {
  if (!ws) return;
  try {
    if (ws.readyState === ws.OPEN && sendableClose(code)) ws.close(code, typeof reason === 'string' ? reason.slice(0, 120) : undefined);
    else ws.terminate();
  } catch { try { ws.terminate(); } catch { /* ignore */ } }
}

function endUpgrade(socket, status, text) {
  try {
    if (!socket.writable) { socket.destroy(); return; }
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { try { socket.destroy(); } catch { /* ignore */ } }
}

/** `Host` header values a loopback request may carry (defends against DNS rebinding). */
function hostAllowed(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/**
 * Create (but do not start) the client's local server.
 * @param {{ publicDir: string, dataDir: string, sharedDir: string, simDir?: string, log?: (...a: any[]) => void }} opts
 */
export function createLocalServer({ publicDir, dataDir, sharedDir, simDir, log = noop }) {
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, ...(simDir ? { simDir } : {}), log: { error: log, warn: log, info: noop, debug: noop } });
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  wss.on('error', (e) => log(`[ws] local server error: ${e?.message}`));
  /** Live tunnels, so shutdown can drop them (an upgraded socket is not closed by server.close()). */
  const tunnels = new Set();
  /** Every open socket (including upgraded ones and idle keep-alive), so `close()` cannot hang. */
  const sockets = new Set();

  /** @type {string | null} upstream `ws(s)://host:port/ws` of the configured host */
  let target = null;
  let boundPort = 0;

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    handleRequest(req, res).catch((e) => {
      log('[http] request failed', e);
      if (res.headersSent) { res.destroy(); return; }
      const body = Buffer.from('Internal error', 'utf8');
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });

  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (!hostAllowed(req.headers.host, boundPort)) {
      log(`[http] rejecting foreign Host ${req.headers.host}`);
      res.writeHead(403, { 'Content-Length': 0, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (url.length > MAX_URL_LENGTH) {
      res.writeHead(414, { 'Content-Length': 0, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.writeHead(405, { 'Content-Length': 0, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    // Origin-form request line only (no proxy in front of this server): split path and query.
    const q = url.indexOf('?');
    const rawPath = q >= 0 ? url.slice(0, q) : url;
    const query = q >= 0 ? url.slice(q + 1) : '';
    await serveStatic(req, res, rawPath, query);
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('clientError', (err, socket) => {
    if (err && err.code === 'ECONNRESET') { socket.destroy(); return; }
    endUpgrade(socket, 400, 'Bad Request');
  });

  /** One renderer socket ↔ one host socket. The host is dialled first so no message can be lost. */
  function tunnel(req, socket, head, upstreamUrl) {
    const upstream = new WebSocket(upstreamUrl, {
      perMessageDeflate: false,
      maxPayload: UPSTREAM_MAX_PAYLOAD,
      handshakeTimeout: PROXY_HANDSHAKE_TIMEOUT_MS,
    });
    /** Frames the host sent before the renderer side finished its upgrade (e.g. `welcome`). */
    const buffered = [];
    let client = null;
    let done = false;

    const entry = { upstream, client: null, kill() { closeQuietly(upstream, 4000, 'client shutdown'); if (client) closeQuietly(client, 4000, 'client shutdown'); } };
    tunnels.add(entry);

    const finish = () => {
      if (done) return;
      done = true;
      tunnels.delete(entry);
    };

    upstream.on('message', (data, isBinary) => {
      if (client && client.readyState === client.OPEN) {
        try { client.send(data, { binary: isBinary }); } catch (e) { log('[ws] renderer send failed', e?.message); }
      } else if (!done) buffered.push([data, isBinary]);
    });

    upstream.on('error', (err) => {
      if (done) return;
      log(`[ws] cannot reach ${upstreamUrl}: ${err?.message || err}`);
      if (!client) { finish(); endUpgrade(socket, 502, 'Bad Gateway'); return; }
      closeQuietly(client, 1011, 'upstream error');
    });

    upstream.on('close', (code, reason) => {
      if (done) return;
      if (!client) { finish(); endUpgrade(socket, 502, 'Bad Gateway'); log(`[ws] ${upstreamUrl} closed during handshake (${code})`); return; }
      finish();
      closeQuietly(client, code, reason?.toString?.() ?? '');
    });

    upstream.on('open', () => {
      if (done) return;
      try {
        wss.handleUpgrade(req, socket, head, (c) => {
          client = c;
          entry.client = c;
          c.on('message', (data, isBinary) => {
            try {
              if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary });
            } catch (e) { log('[ws] host send failed', e?.message); }
          });
          c.on('close', (code, reason) => {
            finish();
            closeQuietly(upstream, code, reason?.toString?.() ?? '');
          });
          c.on('error', () => { /* the close handler cleans up */ });
          for (const [data, isBinary] of buffered) {
            try { c.send(data, { binary: isBinary }); } catch { /* ignore */ }
          }
          buffered.length = 0;
          log(`[ws] tunnel open → ${upstreamUrl}`);
        });
      } catch (e) {
        log('[ws] upgrade failed', e?.message);
        finish();
        closeQuietly(upstream, 1011, 'upgrade failed');
        endUpgrade(socket, 500, 'Internal Server Error');
      }
    });
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* the tunnel handles the rest */ });
    const url = req.url || '';
    const rawPath = url.split('?')[0];
    if (rawPath !== '/ws') { endUpgrade(socket, 404, 'Not Found'); return; }
    if (!hostAllowed(req.headers.host, boundPort)) { endUpgrade(socket, 403, 'Forbidden'); return; }
    if (!target) { endUpgrade(socket, 503, 'Service Unavailable'); return; }
    tunnel(req, socket, head, target);
  });

  return {
    server,
    /** @returns {number} the port actually bound */
    get port() { return boundPort; },
    /** @returns {string | null} */
    get target() { return target; },
    /** Point the tunnel at `ws(s)://host:port/ws` (null = none configured). Existing tunnels are dropped. */
    setTarget(wsUrl) {
      const next = typeof wsUrl === 'string' && wsUrl ? wsUrl : null;
      if (next === target) return;
      target = next;
      log(`[ws] host → ${target ?? '(unset)'}`);
      for (const t of [...tunnels]) t.kill();
    },
    /**
     * Listen on loopback. `preferred` is tried first (a stable port keeps the page origin — and with it
     * localStorage: player name, session token — stable across launches); a busy port falls back to the
     * next free one, then to an ephemeral port.
     * @param {number} preferred
     * @returns {Promise<number>} bound port
     */
    async listen(preferred) {
      const attempts = [];
      for (let p = preferred; p < preferred + 20; p++) attempts.push(p);
      attempts.push(0);
      let lastError = null;
      for (const p of attempts) {
        try {
          await new Promise((resolve, reject) => {
            const onError = (e) => { server.off('listening', onListening); reject(e); };
            const onListening = () => { server.off('error', onError); resolve(); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(p, '127.0.0.1');
          });
          boundPort = server.address().port;
          log(`[http] serving ${publicDir} on http://127.0.0.1:${boundPort}`);
          return boundPort;
        } catch (e) {
          lastError = e;
          if (e && e.code !== 'EADDRINUSE') throw e;
        }
      }
      throw lastError || new Error('cannot bind a local port');
    },
    /** Stop accepting requests and drop every tunnel. */
    async close() {
      for (const t of [...tunnels]) t.kill();
      tunnels.clear();
      for (const c of wss.clients ? [...wss.clients] : []) { try { c.terminate(); } catch { /* ignore */ } }
      try { wss.close(() => {}); } catch { /* not listening */ }
      await new Promise((resolve) => {
        server.close(() => resolve());
        // Idle keep-alive and upgraded sockets would otherwise keep the server alive forever.
        for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
      });
    },
  };
}
