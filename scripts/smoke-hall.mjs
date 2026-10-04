// Browser smoke test for 大厅 (public/js/screens/hall.js): real server + real Chrome, three clients.
//
//   node scripts/smoke-hall.mjs                       # CHROME_PATH optional on Windows (see below)
//   CHROME_PATH=/path/to/chrome node scripts/smoke-hall.mjs
//
// Unlike test/ui/*.e2e.test.js this is a plain script, not a `node --test` suite: it needs a running
// server, three browser pages and ~1 minute, so it stays out of `npm test`. Everything it asserts is
// observed through the real DOM against the real frozen hall protocol — mounts, roster with room codes,
// the open-rooms list, Enter-to-send (and Enter *not* sending while an IME composes), a code click
// joining a room, 返回 unmounting and unsubscribing (`hall.leave`), a finished match rendering in 最近战绩
// with every player's 评语 resolved from data/config.json, the 3→2 column responsive grid, and zero
// console / page errors / failed requests on any page. Screenshots land in test/e2e/out/ (gitignored).
//
// Exit code is 0 only when every check passed.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test/e2e/out');
/** Windows Chrome by default (this machine); everywhere else pass CHROME_PATH. */
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const { startServer } = await import('../server/index.js');
const { StubMatch } = await import('../server/match/StubMatch.js');
const puppeteer = (await import('puppeteer-core')).default;

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} — set CHROME_PATH to a Chrome/Chromium binary.`);
  process.exit(2);
}
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch });
const base = `http://127.0.0.1:${srv.port}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });

/** A page with console/pageerror/requestfailed collection.
 *  `instrument` wraps WebSocket before the app boots: it counts hall.* frames per page and can rewrite one
 *  `hall.state` so the render of a 评语 can be exercised (the StubMatch always reports `title: null`, so no
 *  real title can reach the client — the injected one keeps `title.id` ONLY, forcing the client to resolve
 *  the name through data/config.json `titles`, which is exactly the code path under test). */
async function openPage({ instrument = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { if (r.url().startsWith(base)) problems.push(`requestfailed: ${r.url()}`); });
  if (instrument) {
    await page.evaluateOnNewDocument(() => {
      window.__hallFrames = 0;
      window.__patchedHallResults = 0;
      const Native = window.WebSocket;
      window.WebSocket = function (...args) {
        const ws = new Native(...args);
        // Registered before net.js assigns `ws.onmessage`, so this runs first and can rewrite `ev.data`
        // (MessageEvent.data is a read-only accessor — shadow it with an own property).
        ws.addEventListener('message', (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (!msg || typeof msg.t !== 'string' || !msg.t.startsWith('hall.')) return;
          window.__hallFrames++;
          if (msg.t !== 'hall.state' || !Array.isArray(msg.results)) return;
          let touched = false;
          for (const r of msg.results) {
            for (const p of Array.isArray(r.players) ? r.players : []) {
              if (!p.title) { p.title = { id: 'comment_1' }; touched = true; } // id ONLY: no name
            }
          }
          if (!touched) return;
          window.__patchedHallResults++;
          Object.defineProperty(ev, 'data', { value: JSON.stringify(msg), configurable: true });
        });
        return ws;
      };
      window.WebSocket.prototype = Native.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = Native[k];
    });
  }
  return { page, problems };
}

/** Enter the game with a callsign and wait for the lobby.
 *  Selector strategy: each step tries a name, a title-screen input and a matching button — so this keeps
 *  working if screens/title.js is restyled by another task (task-2 owns that file) as long as the flow
 *  still exists. A step that cannot find its target fails loudly rather than hanging on a selector. */
async function enter(page, name) {
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  const titleSel = await page.evaluate(() => {
    const el = document.querySelector('.title-screen, .screen.title, .title') || [...document.querySelectorAll('.screen')].find((s) => s.querySelector('input'));
    if (!el) return null;
    el.classList.add('__smoke-title');
    return '.__smoke-title';
  });
  if (!titleSel) throw new Error('no title screen found');
  await page.waitForFunction(() => !document.querySelector('.title-conn')?.textContent.includes('连接中'), { timeout: 15000 }).catch(() => {});
  const typed = await page.evaluate((n) => {
    const i = document.querySelector('.__smoke-title input[type="text"], .__smoke-title input:not([type])');
    if (!i) return 'no input';
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, n);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  }, name);
  if (typed !== 'typed') throw new Error(`title screen has no nickname input (${typed})`);
  await sleep(200);
  const clicked = await page.evaluate(() => {
    const scope = document.querySelector('.__smoke-title');
    const b = [...scope.querySelectorAll('button')].find((x) => !x.disabled && /开始|进入|START/.test(x.textContent));
    if (!b) return 'no start button';
    b.click();
    return b.textContent.trim();
  });
  if (clicked === 'no start button') throw new Error('title screen has no start button');
  console.log(`   enter: typed, pressed 「${clicked}」`);
  await page.waitForSelector('.lobby-screen, .screen.lobby', { timeout: 20000 });
}

/** Click the lobby's 大厅 button and wait for the hall screen. */
async function openHall(page) {
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '大厅');
    if (!b) return false;
    b.click();
    return true;
  });
  if (!clicked) throw new Error('lobby has no 大厅 button');
  await page.waitForSelector('.hall-screen', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.hall-who').length > 0, { timeout: 15000 });
}

try {
  // ---- two players: A creates a co-op room (so the roster has a code + the room list has an entry) ----
  const A = await openPage({ instrument: true });
  await enter(A.page, '甲博士');
  await A.page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /创建同盟|创建|新建/.test(b.textContent))?.click());
  await A.page.waitForSelector('.room-screen', { timeout: 20000 });
  // room.js renders the key as `.invite__code` with one <span> per character (aria-label has the text).
  const roomCode = await A.page.evaluate(() => {
    const el = document.querySelector('.invite__code') || document.querySelector('[aria-label^="同盟密钥"]');
    if (el) {
      const fromLabel = (el.getAttribute('aria-label') || '').match(/[A-Z0-9]{4}/);
      if (fromLabel) return fromLabel[0];
      const text = (el.textContent || '').trim();
      if (/^[A-Z0-9]{4}$/.test(text)) return text;
    }
    return (document.body.innerText.match(/\b[A-Z0-9]{4}\b/) || [''])[0];
  });
  check('a co-op room was created (code seen on the room screen)', /^[A-Z0-9]{4}$/.test(roomCode), roomCode);

  const B = await openPage({ instrument: true });
  await enter(B.page, '乙博士');

  // ---- (1) the hall is reachable from the lobby and back -------------------------------------------
  await openHall(B.page);
  const hallState = await B.page.evaluate(() => ({
    title: document.querySelector('.hall-screen .topbar__title')?.textContent?.trim(),
    cols: [...document.querySelectorAll('.hall-col')].map((c) => c.className),
    labels: [...document.querySelectorAll('.hall-screen .section-label')].map((l) => l.textContent.trim()),
    roster: [...document.querySelectorAll('.hall-who')].map((r) => r.querySelector('.hall-who__name')?.textContent.trim()),
    rooms: [...document.querySelectorAll('.hall-room')].map((r) => ({
      code: r.querySelector('.hall-code')?.textContent.trim(),
      meta: r.querySelector('.hall-room__meta')?.textContent.replace(/\s+/g, ' ').trim(),
      acts: [...r.querySelectorAll('.hall-room__acts button')].map((b) => b.textContent.trim()),
      note: r.querySelector('.hall-room__note')?.textContent.trim() || '',
    })),
    chatInput: !!document.querySelector('.hall-chat__form input'),
  }));
  check('hall mounts with the 大厅 title', hallState.title === '大厅', JSON.stringify(hallState.title));
  check('three columns render (roster / rooms+chat / results)', hallState.cols.length === 3, hallState.cols.join(' | '));
  check('four sections are labelled 01–04', hallState.labels.length === 4 && /^01/.test(hallState.labels[0]), hallState.labels.join(' / '));
  check('roster lists both online doctors', hallState.roster.length === 2 && hallState.roster.some((n) => n.startsWith('甲博士')) && hallState.roster.some((n) => n.startsWith('乙博士')), hallState.roster.join(', '));
  check('the roster shows A\'s room code', (await B.page.evaluate(() => document.querySelector('.hall-who .hall-code')?.textContent.trim())) === roomCode, roomCode);
  check('the open-rooms list shows code + 复制密钥 + 加入', hallState.rooms.some((r) => r.code === roomCode && r.acts.includes('复制密钥') && r.acts.includes('加入')), JSON.stringify(hallState.rooms));
  check('the room entry carries mode + humans/seats', /博士/.test(hallState.rooms[0]?.meta || ''), hallState.rooms[0]?.meta || '');
  check('the chat input is present', hallState.chatInput);
  await B.page.screenshot({ path: path.join(OUT, 'hall-b.png') });

  // ---- (2) the room code is a button that joins ------------------------------------------------------
  const joined = await B.page.evaluate(() => {
    const btn = document.querySelector('.hall-room__acts button:nth-child(2)');
    if (!btn) return 'no join button';
    btn.click();
    return 'clicked';
  });
  check('the 加入 button is clickable', joined === 'clicked', joined);
  await B.page.waitForSelector('.room-screen', { timeout: 15000 });
  const inRoom = await B.page.evaluate(() => document.querySelector('.room-screen')?.textContent.includes('乙博士'));
  check('clicking 加入 moved the client into that room', inRoom === true);
  // leaving a room is the ⨯ button (room.js leave(); as the joiner there is no confirm dialog)
  const leaveBtn = await B.page.evaluate(() => {
    const b = document.querySelector('.room-screen button[aria-label="离开同盟"]');
    if (!b) return 'no leave button';
    b.click();
    return 'clicked';
  });
  check('the room leave button is present', leaveBtn === 'clicked', leaveBtn);
  // Leaving the room must fall back to whatever screen the player picked before it: the router keeps
  // `ui.screen === 'hall'`, so the hall comes back rather than the lobby (store.selectRoute).
  await B.page.waitForSelector('.hall-screen', { timeout: 15000 });
  check('leaving the joined room returns to the hall (the router keeps ui.screen)', true);

  // ---- (3) chat: Enter sends, IME composing does not -------------------------------------------------
  await B.page.waitForSelector('.hall-screen', { timeout: 15000 });
  const before = await B.page.evaluate(() => document.querySelectorAll('.hall-line').length);
  await B.page.click('.hall-chat__form input');
  await B.page.keyboard.type('大家好');
  // A real IME: keydown Enter with isComposing must NOT send (TextField guards on it).
  await B.page.evaluate(() => {
    const i = document.querySelector('.hall-chat__form input');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  });
  await sleep(700);
  const afterIme = await B.page.evaluate(() => document.querySelectorAll('.hall-line').length);
  check('Enter while an IME is composing does not send', afterIme === before, `${before} → ${afterIme}`);

  await B.page.evaluate(() => {
    const i = document.querySelector('.hall-chat__form input');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await B.page.waitForFunction(() => [...document.querySelectorAll('.hall-line__text')].some((x) => x.textContent.includes('大家好')), { timeout: 10000 });
  const line = await B.page.evaluate(() => {
    const el = [...document.querySelectorAll('.hall-line')].at(-1);
    return { name: el.querySelector('.hall-line__name')?.textContent.trim(), text: el.querySelector('.hall-line__text')?.textContent, time: el.querySelector('.hall-line__time')?.textContent };
  });
  check('Enter sends the line and it renders with name + time', line.text === '大家好' && line.name === '乙博士' && /^\d\d:\d\d$/.test(line.time), JSON.stringify(line));
  check('the draft is cleared after a successful send', (await B.page.evaluate(() => document.querySelector('.hall-chat__form input').value)) === '');
  // The channel is opt-in: A sat in its room the whole time and must have received zero hall frames
  // even though its socket is alive and the same server broadcast the chat line to B.
  const aFrames = await A.page.evaluate(() => window.__hallFrames);
  check('A (who never opened the hall) received zero hall frames — the channel is opt-in', aFrames === 0, `A frames=${aFrames}`);
  const aSawIt = await A.page.evaluate(() => [...document.querySelectorAll('.hall-line__text')].some((x) => x.textContent.includes('大家好')));
  check('A rendered no chat line at all', aSawIt === false);

  // ---- (4) whitespace-only input never sends --------------------------------------------------------
  const n1 = await B.page.evaluate(() => document.querySelectorAll('.hall-line').length);
  await B.page.evaluate(() => {
    const i = document.querySelector('.hall-chat__form input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, '   ');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
  const sendDisabled = await B.page.evaluate(() => [...document.querySelectorAll('.hall-chat__form button')].find((b) => b.textContent.includes('发送'))?.disabled);
  check('a blank draft disables 发送', sendDisabled === true);
  check('no line was added for a blank draft', (await B.page.evaluate(() => document.querySelectorAll('.hall-line').length)) === n1);

  // ---- (5) a REAL finished match renders in 最近战绩 with every player's 评语 ------------------------
  // A (still in its own room, alone) starts a co-op run; the StubMatch ends as soon as its humans are
  // ready, which broadcasts m.result → the hall mirrors it (server/hall.js). This is the *render* of a
  // real resultEntry, not a fabricated one: the frame comes from the server. C is a fresh client that
  // only enters the hall afterwards, so it takes the result from the hall.state snapshot.
  if (roomCode) {
    await A.page.evaluate(() => [...document.querySelectorAll('.room-screen button')].find((b) => /开始|出击|准备/.test(b.textContent))?.click());
    await sleep(500);
    for (let i = 0; i < 14; i++) {
      const clicked = await A.page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /完成|确认|开始模拟|准备就绪|出击|下一/.test(x.textContent) && !x.disabled);
        if (b) { b.click(); return b.textContent.trim(); }
        return null;
      });
      if (clicked) console.log(`   A clicked: ${clicked}`);
      await sleep(700);
      if (await A.page.evaluate(() => !!document.querySelector('.result-screen'))) break;
    }
    await sleep(1000);
  }
  const C = await openPage({ instrument: true });
  await enter(C.page, '丙博士');
  await openHall(C.page);
  await C.page.waitForFunction(() => document.querySelectorAll('.hall-res').length > 0, { timeout: 15000 }).catch(() => {});
  const res = await C.page.evaluate(() => {
    const rows = [...document.querySelectorAll('.hall-res')];
    return rows.map((r) => ({
      cls: r.className,
      state: r.querySelector('.hall-res__state')?.textContent.trim(),
      dtag: r.querySelector('.dtag')?.textContent.replace(/\s+/g, ' ').trim() || '',
      meta: r.querySelector('.hall-res__meta')?.textContent.replace(/\s+/g, ' ').trim(),
      code: r.querySelector('.hall-res__meta .hall-code')?.textContent.trim() || '',
      players: [...r.querySelectorAll('.hall-res__who')].map((w) => ({
        name: w.querySelector('b')?.textContent.trim(),
        title: w.querySelector('.hall-res__title')?.textContent.trim(),
        win: w.classList.contains('is-win'),
      })),
    }));
  });
  check('a finished match renders in 最近战绩', res.length >= 1, JSON.stringify(res));
  const r0 = res[0] || {};
  check('the result row shows 完成/失败 + difficulty + rounds + duration', /模拟(完成|失败)/.test(r0.state || '') && /回合/.test(r0.meta || '') && /耗时/.test(r0.meta || ''), `${r0.state} | ${r0.dtag} | ${r0.meta}`);
  check('the result row carries its 同盟密钥', r0.code === roomCode || /^[A-Z0-9]{4}$/.test(r0.code || ''), r0.code);
  check('the row is tinted by outcome (is-win / is-lose)', /hall-res is-(win|lose)/.test(r0.cls || ''), r0.cls);
  // The 评语 name must be resolved through config.titles when the frame carries only `title.id`
  // (the real server does send {id, name}, but result.js resolves ids too and the client must not
  // depend on the name being present).
  const patched = await C.page.evaluate(() => ({ n: window.__patchedHallResults, frames: window.__hallFrames }));
  check('the browser really saw a hall.state carrying a 评语 id (harness sanity)', patched.n >= 1, JSON.stringify(patched));
  check('every player line shows a name and a resolved 评语 name', (r0.players || []).length >= 1 && r0.players.every((p) => p.name && p.title && p.title !== '—' && p.title !== 'comment_1'), JSON.stringify(r0.players));
  await C.page.screenshot({ path: path.join(OUT, 'hall-results.png') });

  // ---- (5b) layout: the 3-column grid at 1920×1080, the 2-col breakpoint, and no overflow -----------
  const geom = await C.page.evaluate(() => {
    const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const cols = [...document.querySelectorAll('.hall-col')].map((c) => { const r = c.getBoundingClientRect(); return { cls: c.className.replace('hall-col', '').trim(), x: Math.round(r.x), w: Math.round(r.width) }; });
    return {
      body: box('.hall-body'), cols,
      scroll: box('.hall-col--main .hall-chat__log'),
      doc: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth },
      font: getComputedStyle(document.querySelector('.hall-screen')).fontSize,
    };
  });
  const [c0, c1, c2] = geom.cols;
  check('the three columns sit side by side, left to right', !!c0 && !!c1 && !!c2 && c0.x < c1.x && c1.x < c2.x, JSON.stringify(geom.cols));
  check('the hall is laid out at the 1rem=100px scale (no overflow at 1920)', geom.doc.sw <= geom.doc.cw && geom.body.w === 1920, `sw=${geom.doc.sw} cw=${geom.doc.cw} body=${geom.body.w} font=${geom.font}`);
  check('the chat log is a bounded, scrollable box (not full height)', !!geom.scroll && geom.scroll.h > 100 && geom.scroll.h < 400, JSON.stringify(geom.scroll));

  await C.page.setViewport({ width: 700, height: 900 });
  await sleep(400);
  const narrow = await C.page.evaluate(() => {
    const cols = [...document.querySelectorAll('.hall-col')].map((c) => { const r = c.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; });
    return { cols, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  });
  check('at 700px the grid collapses to 2 columns without horizontal overflow', narrow.cols.length === 3 && narrow.cols[0].x === narrow.cols[1].x && narrow.cols[2].x > narrow.cols[0].x && narrow.sw <= narrow.cw, JSON.stringify(narrow));
  await C.page.screenshot({ path: path.join(OUT, 'hall-narrow.png') });
  await C.page.setViewport({ width: 1920, height: 1080 });
  await sleep(300);

  // ---- (6) back to the lobby, and the subscription is really dropped --------------------------------
  await B.page.evaluate(() => [...document.querySelectorAll('.hall-screen .topbar__left button')].find((b) => b.textContent.includes('返回'))?.click());
  await B.page.waitForSelector('.lobby-screen', { timeout: 15000 });
  check('返回 goes back to the lobby', true);
  const enteredAfterLeave = await B.page.evaluate(() => ({
    hallGone: !document.querySelector('.hall-screen'),
    screen: document.querySelector('.screen')?.className,
  }));
  check('the hall screen is unmounted after 返回', enteredAfterLeave.hallGone === true, enteredAfterLeave.screen || '');
  // `hall.leave` on unmount: after 返回, a fresh chat line from someone else must NOT arrive any more.
  // (The roster is server-wide *presence*, so B stays listed there — that is the server's contract, not
  // the subscription's. Counting frames is the only honest test of the unsubscribe.)
  const framesBefore = await B.page.evaluate(() => window.__hallFrames);
  const framesCBefore = await C.page.evaluate(() => window.__hallFrames);
  check('B received hall frames while the hall was open (hall.enter subscribed)', framesBefore > 0, `B frames=${framesBefore}`);
  await C.page.evaluate(() => {
    const i = document.querySelector('.hall-chat__form input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, '离开后不该再收到');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await C.page.evaluate(() => document.querySelector('.hall-chat__form input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await C.page.waitForFunction(() => [...document.querySelectorAll('.hall-line__text')].some((x) => x.textContent.includes('离开后不该再收到')), { timeout: 10000 });
  await sleep(900);
  const framesAfter = await B.page.evaluate(() => window.__hallFrames);
  const framesC = await C.page.evaluate(() => window.__hallFrames);
  check('no hall frame reaches the client after 返回 (hall.leave on unmount)', framesAfter === framesBefore, `B ${framesBefore} → ${framesAfter}`);
  check('the client that stayed in the hall kept receiving frames (counter is live)', framesC > framesCBefore, `C ${framesCBefore} → ${framesC}`);

  // ---- (7) no console errors anywhere ---------------------------------------------------------------
  for (const [label, p] of [['A', A], ['B', B], ['C', C]]) {
    check(`${label}: no console errors / page errors (${p.problems.length})`, p.problems.length === 0, p.problems.slice(0, 3).join(' | '));
  }
  await C.page.screenshot({ path: path.join(OUT, 'hall-c.png') });
} catch (err) {
  check('smoke run completed without throwing', false, err.message);
} finally {
  await browser.close().catch(() => {});
  await srv.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('failed:', failed.map((f) => f.name).join(' | ')); process.exitCode = 1; }
