// scripts/smoke-client.mjs — end-to-end smoke test of the built desktop client against a real server.
//
// Starts the game server on a free loopback port, launches the packaged client pointed at it, and checks
// the three things that can only be verified with both halves running:
//   1. the loopback payload server answers with the game page, and the payload mounts behave exactly like
//      the server's (`/sim/` is ES modules only, `nodeData.js` is never served);
//   2. the renderer boots far enough to open its socket — the host reports a connected client;
//   3. the shell's own log names the tunnel it opened to the host.
//
// Child output goes to files, never pipes.
//
// Usage:
//   node scripts/smoke-client.mjs [--app=dist/Stronghold-Protocol-win64] [--run-from=E:\_sp-client-run]
//                                 [--default-server=host:port] [--timeout=45] [--keep]
//
// `--run-from` copies the app there and runs it from that copy. It exists because a folder inside a
// sandboxed workspace (DSH applies low-integrity ACLs to E:\tools\workingspace) makes Chromium's
// sandbox fail to initialise — the same binary runs fine anywhere else.

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
const buildDir = path.resolve(ROOT, value('app', path.join('dist', 'Stronghold-Protocol-win64')));
const runFrom = value('run-from', '');
const productExe = path.join(buildDir, 'StrongholdProtocol.exe');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-client-smoke-'));
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
 * Probe the sandbox exactly the way the shipped launcher does: the client's own `--sandbox-probe`
 * reaches `app.whenReady()` and exits 0 when Chromium's sandbox works, and dies with a non-zero status
 * before any JS runs when it does not. (A packaged Electron app ignores `--version`, so that cannot be
 * used as a probe: it would launch the game and never return.)
 */
function sandboxWorks(exe) {
  const r = spawnSync(exe, ['--sandbox-probe'], { stdio: 'ignore', env: cleanEnv(), windowsHide: true, timeout: 20000 });
  return r.status === 0;
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
let clientProc = null;

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

async function main() {
  if (!fs.existsSync(productExe)) {
    throw new Error(`no built client at ${productExe}\n    build it first: node scripts/build-client.mjs`);
  }
  let appDir = buildDir;
  if (runFrom) {
    appDir = stageApp();
    log(`app dir: ${appDir}`);
  }
  const exe = path.join(appDir, 'StrongholdProtocol.exe');

  const gamePort = await freePort();
  const localPort = await freePort();
  log(`game server :${gamePort}   client loopback :${localPort}`);

  const serverOut = fs.openSync(path.join(TMP, 'server.log'), 'a');
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: cleanEnv({ PORT: String(gamePort), HOST: '127.0.0.1', SP_NO_BROWSER: '1' }),
    stdio: ['ignore', serverOut, serverOut],
    windowsHide: true,
  });
  await waitFor(async () => await getJson(`http://127.0.0.1:${gamePort}/healthz`), { seconds: 30, label: 'the game server' });
  log('game server is up');

  const needsNoSandbox = !sandboxWorks(exe);
  log(`sandbox: ${needsNoSandbox ? 'unavailable → ELECTRON_DISABLE_SANDBOX=1' : 'ok'}`);

  const userData = path.join(TMP, 'userdata');
  const clientOut = fs.openSync(path.join(TMP, 'client.log'), 'a');
  clientProc = spawn(exe, [
    `--server=127.0.0.1:${gamePort}`,
    `--local-port=${localPort}`,
    `--client-data-dir=${userData}`,
  ], {
    cwd: appDir,
    env: cleanEnv({ ...(needsNoSandbox ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}) }),
    stdio: ['ignore', clientOut, clientOut],
    windowsHide: true,
  });
  log(`client pid ${clientProc.pid}`);

  // 1. the loopback payload server
  const page = await waitFor(async () => {
    if (clientProc.exitCode !== null) throw new Error(`the client exited with ${clientProc.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${localPort}/`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      if (String(e.message).startsWith('the client exited')) throw e;
      return null;
    }
  }, { seconds: 30, label: 'the client loopback server' });
  if (!/STRONGHOLD PROTOCOL/.test(page)) throw new Error('the loopback server did not serve the game page');
  log('loopback server serves the game page');

  const sim = await fetch(`http://127.0.0.1:${localPort}/sim/spec.js`, { signal: AbortSignal.timeout(2000) });
  if (!sim.ok) throw new Error(`/sim/spec.js answered ${sim.status}`);
  const denied = await fetch(`http://127.0.0.1:${localPort}/sim/nodeData.js`, { signal: AbortSignal.timeout(2000) });
  if (denied.status !== 404) throw new Error(`/sim/nodeData.js answered ${denied.status} (must be 404)`);
  const shim = await fetch(`http://127.0.0.1:${localPort}/data.js`, { signal: AbortSignal.timeout(2000) });
  if (!shim.ok || !/getSimData/.test(await shim.text())) throw new Error('/data.js is not the browser shim');
  log('payload mounts behave like the server (/sim/ is ES modules only, /data.js shim present)');

  // 2./3. the renderer booted and tunnelled to the game server
  const health = await waitFor(async () => {
    const h = await getJson(`http://127.0.0.1:${gamePort}/healthz`);
    return h && Number(h.sockets) >= 1 ? h : null;
  }, { seconds: timeoutSec, label: 'the client socket to reach the host' });
  log(`host reports ${health.sockets} socket(s), ${health.rooms ?? 0} room(s)`);

  const appLog = path.join(userData, 'client.log');
  const text = fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8') : '';
  const tunnel = text.split(/\r?\n/).find((l) => l.includes('[ws] tunnel open'));
  if (!tunnel) throw new Error(`the client log has no tunnel entry:\n${text}`);
  log(tunnel.replace(/^\S+ /, ''));
  if (/\[net\] blocked https?:\/\//.test(text)) log('external requests were blocked (offline client)');

  console.log('\n  ✓ smoke test passed\n');
}

try {
  await main();
  process.exitCode = 0;
} catch (e) {
  console.error(`\n  ✗ smoke test failed: ${e.message}\n`);
  for (const file of [path.join(TMP, 'server.log'), path.join(TMP, 'client.log'), path.join(TMP, 'userdata', 'client.log')]) {
    if (!fs.existsSync(file)) continue;
    console.error(`  --- ${path.relative(TMP, file)} ---`);
    console.error(fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-25).join('\n'));
  }
  process.exitCode = 1;
} finally {
  if (!keep) {
    killTree(clientProc);
    killTree(serverProc);
    await sleep(500);
    fs.rmSync(TMP, { recursive: true, force: true });
  } else {
    console.log(`  --keep: leaving processes running (logs in ${TMP})`);
  }
}
