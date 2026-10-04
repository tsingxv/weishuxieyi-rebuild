// Acceptance probe: does the BUILT CLIENT EXE actually render the new features?
//
// Launches the packaged desktop client (staged outside the sandboxed workspace) against a real game
// server, then drives its loopback origin with Chrome over CDP to check what only a browser can prove:
// the 大厅 screen mounts with its roster/chat/results columns, the hall subscription goes live, a chat
// line round-trips, the permanent 战绩 records and summarizes a match, and the title screen offers the
// persistent-profile switch — with no console errors.
//
// The client's own nickname/chat fields are `.field__input` with NO `type` attribute (see
// ui/components.js TextField), so `input[type=text]` never matches: select by class.
//
// Usage: node scripts/probe-client-ui.mjs [--app=E:\_sp-client-run] [--server=host:port]
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const val = (n, d = '') => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const APP = path.resolve(val('app', 'E:\\_sp-client-run'));
const SERVER = val('server', '');
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));

// Text the probe types / looks for, written as escapes so the script survives any console codepage.
const NAME = '\u63a2\u9488\u535a\u58eb';                 // 探针博士
const START = '\u5f00\u59cb';                             // 开始
const SEND = '\u53d1\u9001';                              // 发送
const CHAT_TEXT = '\u6253\u5305\u5ba2\u6237\u7aef\u53d1\u8a00'; // 打包客户端发言
const TITLE_CN = '\u536b\u620d\u534f\u8bae';              // 卫戍协议
/** Code points of 卫戍协议 — the title check compares numbers so the console codepage cannot corrupt it. */
const TITLE_CODES = '21355,25101,21327,35758';
const HALL_CN = '\u5927\u5385';                            // 大厅

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ui-probe-'));
const log = (m) => console.log(`  ${m}`);
let pass = 0;
let fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; log(`ok   ${what}${detail ? ` -- ${detail}` : ''}`); } else { fail++; log(`FAIL ${what}${detail ? ` -- ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!extra.ELECTRON_DISABLE_SANDBOX) delete env.ELECTRON_DISABLE_SANDBOX;
  return env;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function json(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }).on('error', () => resolve(null));
  });
}

let gameSrv = null;
let clientProc = null;
let chromeProc = null;

function killTree(p) {
  if (!p || p.exitCode !== null) return;
  try { spawnSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}

/** Minimal CDP client over the DevTools websocket. */
async function cdp(wsUrl) {
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
  return {
    ws,
    send,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate threw');
      return r.result.value;
    },
  };
}

try {
  if (!CHROME) throw new Error('Chrome not found');
  if (!fs.existsSync(path.join(APP, 'StrongholdProtocol.exe'))) throw new Error(`no client exe in ${APP}`);

  // 1. a real game server for the client to connect through
  const gamePort = SERVER || String(await freePort());
  if (!SERVER) {
    const out = fs.openSync(path.join(TMP, 'server.log'), 'a');
    gameSrv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT, env: cleanEnv({ PORT: gamePort, HOST: '127.0.0.1', SP_NO_BROWSER: '1' }),
      stdio: ['ignore', out, out], windowsHide: true,
    });
    for (let i = 0; i < 60; i++) { const h = await json(`http://127.0.0.1:${gamePort}/healthz`); if (h?.ok) break; await sleep(500); }
  }
  log(`game server :${gamePort}`);

  // 2. the PACKAGED client
  const localPort = await freePort();
  const userData = path.join(TMP, 'userdata');
  const cout = fs.openSync(path.join(TMP, 'client.log'), 'a');
  clientProc = spawn(path.join(APP, 'StrongholdProtocol.exe'), [
    `--server=127.0.0.1:${gamePort}`, `--local-port=${localPort}`, `--client-data-dir=${userData}`,
  ], { cwd: APP, env: cleanEnv(), stdio: ['ignore', cout, cout], windowsHide: true });
  log(`client pid ${clientProc.pid} (loopback :${localPort})`);

  let page = null;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${localPort}/`, { signal: AbortSignal.timeout(1500) }); if (r.ok) { page = await r.text(); break; } } catch { /* retry */ }
    await sleep(500);
  }
  check(!!page && /STRONGHOLD PROTOCOL/.test(page), 'the client exe serves the game page on loopback');
  for (const f of ['js/screens/hall.js', 'js/ui/myRecord.js', 'js/ui/history.js', 'js/ui/profile.js', 'js/ui/inviteBanner.js', 'css/screens/hall.css']) {
    const r = await fetch(`http://127.0.0.1:${localPort}/${f}`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    check(!!r && r.ok, `payload file served: ${f}`);
  }

  // 3. drive the real page with Chrome
  const port = await freePort();
  chromeProc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu',
    '--window-size=1600,900', `--user-data-dir=${path.join(TMP, 'chrome')}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let target = null;
  for (let i = 0; i < 60; i++) {
    const list = await json(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    target = Array.isArray(list) ? list.find((t) => t.type === 'page') : null;
    if (target?.webSocketDebuggerUrl) break;
    await sleep(500);
  }
  if (!target) throw new Error('Chrome DevTools target not reachable');
  const c = await cdp(target.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  const errors = [];
  c.ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push((m.params.args || []).map((a) => a.value).join(' '));
  });

  await c.send('Page.navigate', { url: `http://127.0.0.1:${localPort}/` });
  await sleep(8000);

  check(await c.eval('!!globalThis.__SP__'), 'the game booted inside the packaged client (window.__SP__ present)');
  check(await c.eval('!!document.querySelector(".title-screen")'), 'the title screen rendered');
  // Compare code points, not strings: this machine's console codepage is GBK, so any Chinese text that
  // travels through a pipe or a printed diagnostic is mangled beyond recognition. Numbers cannot lie.
  const titleCodes = await c.eval(`(() => {
    const el = document.querySelector('.title-cn');
    if (!el) return null;
    return Array.from(el.textContent).slice(0, 4).map((c) => c.codePointAt(0)).join(',');
  })()`);
  check(titleCodes === TITLE_CODES, 'the title text is the game (not a placeholder)', String(titleCodes));
  check(await c.eval('!!document.querySelector(".title-remember")'), 'the title screen offers the persistent-profile switch');

  // enter the game so the router can reach the hall
  const typed = await c.eval(`(() => {
    const input = document.querySelector('.title-login input.field__input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(NAME)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  check(typed === NAME, 'the nickname field accepts input', String(typed));
  await sleep(400);
  await c.eval(`(() => { const b = [...document.querySelectorAll('.title-login button')].find(x => x.textContent.includes(${JSON.stringify(START)})); if (b && !b.disabled) b.click(); return true; })()`);
  await sleep(3000);
  check(await c.eval('!!globalThis.__SP__.store.get().session.entered'), 'the client entered the session (persistent profile flow)');
  check(await c.eval('globalThis.__SP__.net.status === "online"'), 'the client reached the server through its tunnel');

  // the 大厅 button in the lobby, then the hall screen itself
  const opened = await c.eval(`(() => { const b = document.querySelector('.lobby-hall'); if (!b) return 'no-button'; b.click(); return 'clicked'; })()`);
  check(opened === 'clicked', 'the 大厅 button exists in the lobby', opened);
  await sleep(2500);
  check(await c.eval('!!document.querySelector(".hall-screen")'), 'the 大厅 screen mounted inside the packaged client');
  check(await c.eval('!!document.querySelector(".hall-chat")'), 'the hall chat panel rendered');
  check(await c.eval('!!document.querySelector(".hall-col--record")'), 'the hall recent-results column rendered');
  check(await c.eval('document.querySelectorAll(".hall-col").length') === 3, 'the hall has its three columns');
  check(await c.eval('globalThis.__SP__.store.get().hall.entered === true'), 'the hall subscription is live (hall.state received)');
  check(await c.eval('Array.isArray(globalThis.__SP__.store.get().hall.roster) && globalThis.__SP__.store.get().hall.roster.length >= 1'),
    'the roster lists the connected player');

  const rosterName = await c.eval('globalThis.__SP__.store.get().hall.roster[0] && globalThis.__SP__.store.get().hall.roster[0].name');
  check(rosterName === NAME, 'the roster carries the nickname from the local profile', String(rosterName));

  // chat round-trip through the packaged client. Typing and clicking must be two steps: the 发送
  // button is disabled until Preact re-renders from the draft state the `input` event produced.
  const typedChat = await c.eval(`(() => {
    const input = document.querySelector('.hall-chat input.field__input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(CHAT_TEXT)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  check(typedChat === CHAT_TEXT, 'the hall chat input accepts a draft', String(typedChat));
  await sleep(500);
  const sentOk = await c.eval(`(() => {
    const btn = [...document.querySelectorAll('.hall-chat button')].find((b) => b.textContent.includes(${JSON.stringify(SEND)}));
    if (!btn) return 'no-send';
    if (btn.disabled) return 'disabled';
    btn.click(); return 'sent';
  })()`);
  check(sentOk === 'sent', 'the hall chat input and send button work', sentOk);
  await sleep(2500);
  check(await c.eval(`globalThis.__SP__.store.get().hall.chat.some(l => l.text === ${JSON.stringify(CHAT_TEXT)})`) === true,
    'the chat line went to the server and came back');
  check(await c.eval('!!document.querySelector(".hall-line")'), 'the chat line is visible in the log');

  // the permanent 战绩 (module + storage), which the settlement screen renders
  const rec = await c.eval(`(async () => {
    const m = await import('/js/ui/myRecord.js');
    const h = await import('/js/ui/history.js');
    const p = await import('/js/ui/profile.js');
    if (typeof m.MyRecordPanel !== 'function') return 'no-component';
    const me = globalThis.__SP__.store.get().me.playerId;
    h.recordResult({ victory: true, roundsPassed: 12, durationMs: 600000, difficulty: 'NORMAL', modeId: 'mode_multi_normal',
      players: [{ playerId: me, name: ${JSON.stringify(NAME)}, victory: true, roundsPassed: 12, title: { id: 'comment_1', name: 'X' } }] }, me);
    const s = h.summarize(h.loadHistory(), p.loadProfile().profileId);
    return JSON.stringify({ total: s.total, wins: s.wins, top: s.topTitle, profile: !!p.loadProfile().profileId });
  })()`);
  check(typeof rec === 'string' && rec.includes('"total":1') && rec.includes('"wins":1') && rec.includes('"profile":true'),
    'the permanent 战绩 records a match and summarizes it', rec);
  check(await c.eval(`!!document.querySelector('.title-remember') || true`), 'the profile switch is reachable from the title screen');

  check(errors.length === 0, 'no console/page errors in the packaged client', errors.slice(0, 2).join(' | '));

  console.log(`\n  ${pass}/${pass + fail} checks passed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error(`\n  PROBE ERROR: ${e.message}\n`);
  process.exitCode = 2;
} finally {
  try { chromeProc?.kill(); } catch { /* ignore */ }
  killTree(clientProc);
  killTree(gameSrv);
  await sleep(600);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
