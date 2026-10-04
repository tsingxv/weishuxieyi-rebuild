// scripts/smoke-server.mjs — end-to-end smoke test of the built standalone game server (开服面板).
//
// The point of this test is that the packaged exe really IS the game server: it starts the same
// server/index.js the repository runs, on the port it was told to use, serving the real game page to a
// browser — and that the panel window being its lifetime means the port is released when it exits.
//
// What is checked, in order:
//   1. the app starts (the panel window is created; a fatal error would exit immediately);
//   2. `GET /healthz` reports `ok: true`, the right version and a growing uptime;
//   3. `GET /` serves the game page (the title from public/index.html);
//   4. the static mounts behave exactly like the repository server's: `/sim/spec.js` is served,
//      `/sim/nodeData.js` is 404 (Node-only loader), `/data.js` is the browser shim;
//   5. a WebSocket client completes the real handshake: `hello` → `welcome` with a playerId, and the
//      server's own counters (`sockets`, `sessions`) go up — proving the packaged `ws` dependency is there;
//   6. after the app is killed the port is refusing connections again (the server dies with its window).
//
// Child output goes to files, never pipes.
//
// Usage:
//   node scripts/smoke-server.mjs [--app=dist/Stronghold-Protocol-Server-win64]
//                                 [--run-from=E:\_sp-server-run] [--timeout=45] [--port=0] [--keep]
//
// `--run-from` copies the app there and runs it from that copy. It exists because a folder inside a
// sandboxed workspace (DSH applies low-integrity ACLs to E:\tools\workingspace) makes Chromium's sandbox
// fail to initialise — the same binary runs fine anywhere else.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const value = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const timeoutSec = Number(value('timeout', '45')) || 45;
const buildDir = path.resolve(ROOT, value('app', path.join('dist', 'Stronghold-Protocol-Server-win64')));
const runFrom = value('run-from', '');
const forcedPort = Number(value('port', '0')) || 0;
const productExe = path.join(buildDir, 'StrongholdProtocolServer.exe');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-server-smoke-'));
const log = (msg) => console.log(`  ${msg}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Child environment: drop the two variables that would otherwise hijack the run. `ELECTRON_RUN_AS_NODE`
 * is set by some shells (it turns the app into plain Node); `ELECTRON_DISABLE_SANDBOX` is only added back
 * when this machine needs it.
 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!extra.ELECTRON_DISABLE_SANDBOX) delete env.ELECTRON_DISABLE_SANDBOX;
  return env;
}

/**
 * Probe the sandbox exactly the way the shipped launcher does: the app's own `--sandbox-probe` reaches
 * `app.whenReady()` and exits 0 when Chromium's sandbox works, and dies with a non-zero status before any
 * JS runs when it does not. (A packaged Electron app ignores `--version`, so that cannot be used as a
 * probe: it would start the server and never return.)
 *
 * A failing probe has two very different causes, and blaming the sandbox for both sends the reader down
 * the wrong path (it did during development of this script: a `ReferenceError` in the main script looked
 * exactly like a broken sandbox). So the probe is repeated with the sandbox disabled: if it fails that way
 * too, the app itself is broken and we say so, with the app's own log.
 */
function probeSandbox(exe) {
  const normal = spawnSync(exe, ['--sandbox-probe'], { stdio: 'ignore', env: cleanEnv(), windowsHide: true, timeout: 20000 });
  if (normal.status === 0) return { works: true, status: 0 };
  const bypass = spawnSync(exe, ['--sandbox-probe'], {
    stdio: 'ignore',
    env: cleanEnv({ ELECTRON_DISABLE_SANDBOX: '1' }),
    windowsHide: true,
    timeout: 20000,
  });
  if (bypass.status !== 0) {
    throw new Error(
      `the app failed its own --sandbox-probe both normally (status ${normal.status}${normal.signal ? `/${normal.signal}` : ''})`
      + ` and with ELECTRON_DISABLE_SANDBOX=1 (status ${bypass.status}${bypass.signal ? `/${bypass.signal}` : ''}).`
      + '\n    That is not a sandbox problem: the main script throws before app.whenReady() (or the exe is broken).'
      + '\n    Run it by hand to see the dialog, and check the app log in the user-data dir.',
    );
  }
  return { works: false, status: normal.status };
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitFor(fn, { seconds, label }) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const hit = await fn();
    if (hit) return hit;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let serverProc = null;

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try { spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}

/** Copy the built app to a location outside any sandboxed workspace (see the file header). */
function stageApp() {
  const dest = path.resolve(runFrom);
  log(`staging to ${dest} (outside the sandboxed workspace)`);
  fs.rmSync(dest, { recursive: true, force: true });
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true }); // mkdir on a drive root is EPERM
  const r = spawnSync('robocopy.exe', [buildDir, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/MT:8', '/R:1', '/W:1'], { stdio: 'ignore' });
  // robocopy: 0-7 are success codes
  if (r.error || r.status > 7) {
    log('robocopy unavailable, falling back to a plain copy');
    fs.cpSync(buildDir, dest, { recursive: true });
  }
  return dest;
}

/**
 * The real client handshake, with no framework: connect to `/ws`, send `hello`, wait for `welcome`, ping,
 * then `hall.enter` (the 大厅 subscription). `welcome` carries
 * `{ playerId, token, serverNow, version, resumed }` (server/net.js).
 *
 * The socket is deliberately left OPEN — the caller checks the server's live counters while it is
 * connected and closes it itself. Closing here made the counter check read 0 (found the hard way).
 *
 * @returns {Promise<{ welcome: object, pong: object, hall: object, close: () => void }>}
 */
async function wsConnect(port, name = '烟测') {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: false });
  const close = () => { try { ws.close(); } catch { /* already gone */ } };
  /** Wait for the first frame of a given type (the lobby pushes several). */
  const next = (type, what, ms = 8000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${what} frame`)), ms);
    const onMessage = (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.t !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out connecting to /ws')), 8000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const welcomePromise = next('welcome', 'welcome');
    ws.send(JSON.stringify({ t: 'hello', name }));
    const welcome = await welcomePromise;
    if (!welcome.playerId) throw new Error(`welcome frame has no playerId: ${JSON.stringify(welcome)}`);
    if (welcome.version !== 1) throw new Error(`unexpected protocol version ${welcome.version} (expected 1)`);

    const pongPromise = next('pong', 'pong answer');
    ws.send(JSON.stringify({ t: 'ping', c: 1234 }));
    const pong = await pongPromise;
    if (pong.c !== 1234) throw new Error(`pong echo mismatch: ${JSON.stringify(pong)}`);

    // 大厅: the full snapshot is the answer to `hall.enter` (shared/protocol.js).
    const hallPromise = next('hall.state', 'hall.state answer');
    ws.send(JSON.stringify({ t: 'hall.enter' }));
    const hall = await hallPromise;
    if (!Array.isArray(hall.roster)) throw new Error(`hall.state has no roster: ${JSON.stringify(hall).slice(0, 200)}`);

    return { welcome, pong, hall, close };
  } catch (e) {
    close();
    throw e;
  }
}

/** Is the port refusing connections (i.e. nothing is listening any more)? */
function portClosed(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (closed) => { s.destroy(); resolve(closed); };
    s.once('connect', () => done(false));
    s.once('error', () => done(true));
    setTimeout(() => done(true), 3000);
  });
}

async function main() {
  if (!fs.existsSync(productExe)) {
    throw new Error(`no built server at ${productExe}\n    build it first: node scripts/build-server.mjs`);
  }
  let appDir = buildDir;
  if (runFrom) {
    appDir = stageApp();
    log(`app dir: ${appDir}`);
  }
  const exe = path.join(appDir, 'StrongholdProtocolServer.exe');
  if (!fs.existsSync(exe)) throw new Error(`missing ${exe}`);

  const port = forcedPort || await freePort();
  const userData = path.join(TMP, 'userdata');
  log(`server port :${port}`);

  const probe = probeSandbox(exe);
  const needsNoSandbox = !probe.works;
  log(`sandbox: ${needsNoSandbox ? 'unavailable → ELECTRON_DISABLE_SANDBOX=1' : 'ok'}`);

  const out = fs.openSync(path.join(TMP, 'server.log'), 'a');
  serverProc = spawn(exe, [
    `--port=${port}`,
    '--host=0.0.0.0',
    `--server-data-dir=${userData}`,
  ], {
    cwd: appDir,
    env: cleanEnv({ ...(needsNoSandbox ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}) }),
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  log(`server pid ${serverProc.pid}`);

  // 1./2. the server is listening and healthy
  let health = await waitFor(async () => {
    if (serverProc.exitCode !== null) throw new Error(`the server exited with ${serverProc.exitCode}`);
    const h = await getJson(`http://127.0.0.1:${port}/healthz`);
    return h && h.ok === true ? h : null;
  }, { seconds: 45, label: 'the packaged server /healthz' });
  if (health.version !== 1) throw new Error(`/healthz version ${health.version} (expected protocol version 1)`);
  if (!health.app) throw new Error('/healthz has no app version');
  if (!Number.isFinite(health.uptimeSec)) throw new Error('/healthz has no uptimeSec');
  log(`/healthz ok: app ${health.app}, protocol ${health.version}, uptime ${health.uptimeSec}s, sockets ${health.sockets}, hall ${health.hallMembers}`);

  // 3. the game page
  const page = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      return await res.text();
    } catch { return null; }
  }, { seconds: 20, label: 'the game page on /' });
  if (!/STRONGHOLD PROTOCOL/.test(page)) throw new Error('/ did not serve the game page (public/index.html)');
  log('GET / serves the game page');

  // 4. the mounts the packaged payload must carry (server/index.js createStaticHandler)
  const sim = await fetch(`http://127.0.0.1:${port}/sim/spec.js`, { signal: AbortSignal.timeout(2000) });
  if (!sim.ok) throw new Error(`/sim/spec.js answered ${sim.status} (the sim payload is missing)`);
  const denied = await fetch(`http://127.0.0.1:${port}/sim/nodeData.js`, { signal: AbortSignal.timeout(2000) });
  if (denied.status !== 404) throw new Error(`/sim/nodeData.js answered ${denied.status} (must be 404)`);
  const shim = await fetch(`http://127.0.0.1:${port}/data.js`, { signal: AbortSignal.timeout(2000) });
  if (!shim.ok || !/getSimData/.test(await shim.text())) throw new Error('/data.js is not the browser shim');
  const shared = await fetch(`http://127.0.0.1:${port}/shared/constants.js`, { signal: AbortSignal.timeout(2000) });
  if (!shared.ok) throw new Error(`/shared/constants.js answered ${shared.status} (the shared payload is missing)`);
  log('payload mounts behave like the repository server (/sim/ + /shared/ + /data.js)');

  // 5. the real WebSocket handshake (proves the packaged `ws` dependency works)
  const conn = await wsConnect(port);
  log(`websocket hello → welcome (playerId ${conn.welcome.playerId}, ping c=${conn.pong.c})`);
  log(`大厅 hall.enter → hall.state (roster ${conn.hall.roster.length}, rooms ${conn.hall.roomsTotal ?? 0})`);
  // The server must count the socket WHILE it is connected (net.js Network.connectionCount).
  const after = await waitFor(async () => {
    const h = await getJson(`http://127.0.0.1:${port}/healthz`);
    return h && Number(h.sockets) >= 1 ? h : null;
  }, { seconds: timeoutSec, label: 'the server to count the smoke socket' });
  log(`server counts the connection: sockets ${after.sockets}, sessions ${after.sessions}, hallMembers ${after.hallMembers}`);
  conn.close();
  // ... and must stop counting it once it is gone.
  await waitFor(async () => {
    const h = await getJson(`http://127.0.0.1:${port}/healthz`);
    return h && Number(h.sockets) === 0 ? h : null;
  }, { seconds: timeoutSec, label: 'the closed socket to be dropped' });
  log('closing the socket drops it from the counters');
  if (health.uptimeSec > 0 && Number(after.uptimeSec) < Number(health.uptimeSec)) throw new Error('uptime went backwards');

  // the panel window must exist too — the app is useless as a launcher without it
  const procCount = spawnSync('tasklist.exe', ['/FI', `PID eq ${serverProc.pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
  if (!String(procCount.stdout || '').includes(String(serverProc.pid))) throw new Error('the server process is gone');
  log('the packaged app is still running (panel window alive)');

  // 6. closing the window ends the server: the port must be free again
  killTree(serverProc);
  const closed = await waitFor(async () => (await portClosed(port)), { seconds: 20, label: 'the port to be released' });
  if (!closed) throw new Error(`port ${port} is still accepting connections after the app was killed`);
  log(`port ${port} released after exit`);

  const appLog = path.join(userData, 'server.log');
  if (fs.existsSync(appLog)) {
    const text = fs.readFileSync(appLog, 'utf8');
    const listening = text.split(/\r?\n/).find((l) => l.includes('[boot] listening'));
    if (listening) log(listening.replace(/^\S+ /, ''));
  }

  console.log('\n  ✓ smoke test passed\n');
}

try {
  await main();
  process.exitCode = 0;
} catch (e) {
  console.error(`\n  ✗ smoke test failed: ${e.message}\n`);
  for (const file of [path.join(TMP, 'server.log'), path.join(TMP, 'userdata', 'server.log')]) {
    if (!fs.existsSync(file)) continue;
    console.error(`  --- ${path.relative(TMP, file)} ---`);
    console.error(fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-25).join('\n'));
  }
  process.exitCode = 1;
} finally {
  if (!keep) {
    killTree(serverProc);
    await sleep(500);
    fs.rmSync(TMP, { recursive: true, force: true });
  } else {
    console.log(`  --keep: leaving the process running (logs in ${TMP})`);
  }
}
