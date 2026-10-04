// Desktop client (client/): the clipboard invite watcher behind "一键进房" — the pure parser, the
// sampling policy, and the settings flag that turns the whole feature off.
//
// The parser is deliberately strict (a false positive throws a prompt over somebody's game), so most
// of this file is about what must NOT match. Every expectation is anchored to code that already
// exists: the room-code alphabet/length live in server/lobby.js + shared/constants.js and the deep
// link is parsed by public/js/screens/lobby.js `parseRoomParam`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_ALPHABET, CODE_LEN, MAX_TEXT, isRoomCode, parseInvite, roomQuery } from '../client/invite.js';
import { DEFAULT_POLL_MS, createClipboardWatcher } from '../client/clipboardWatcher.js';
import { defaultConfig, normalizeConfig } from '../client/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ------------------------------------------------------------------------------------------------
// The code alphabet is a copy of the server's — prove it cannot silently drift
// ------------------------------------------------------------------------------------------------

test('CODE_ALPHABET/CODE_LEN mirror the server that generates room codes', () => {
  const lobby = read(path.join('server', 'lobby.js'));
  const m = lobby.match(/CODE_ALPHABET\s*=\s*'([^']+)'/);
  assert.ok(m, 'server/lobby.js must declare CODE_ALPHABET');
  assert.equal(CODE_ALPHABET, m[1], 'the client copy of the code alphabet drifted from server/lobby.js');

  const constants = read(path.join('shared', 'constants.js'));
  const len = constants.match(/ROOM_CODE_LEN\s*=\s*(\d+)/);
  assert.ok(len, 'shared/constants.js must declare ROOM_CODE_LEN');
  assert.equal(CODE_LEN, Number(len[1]));

  // The whole premise of rejecting digit-bearing tokens: the generator only ever emits letters.
  assert.match(CODE_ALPHABET, /^[A-Z]+$/);
  assert.ok(!CODE_ALPHABET.includes('I') && !CODE_ALPHABET.includes('O'), 'the generator skips I and O');
  assert.equal(new Set(CODE_ALPHABET).size, CODE_ALPHABET.length, 'the alphabet has no repeats');
});

test('roomQuery emits exactly the parameter the game already understands', () => {
  assert.equal(roomQuery('ABCD'), '?room=ABCD');
  // public/js/screens/lobby.js parseRoomParam() reads this parameter out of location.search; the
  // assertion is deliberately loose (the contract is the parameter name, not the expression).
  assert.match(read(path.join('public', 'js', 'screens', 'lobby.js')), /\.get\('room'\)/);
});

// ------------------------------------------------------------------------------------------------
// What IS an invite
// ------------------------------------------------------------------------------------------------

test('parseInvite: a full invite link yields the code and the host', () => {
  const inv = parseInvite('http://192.168.1.2:3000/?room=ABCD');
  assert.equal(inv.code, 'ABCD');
  assert.equal(inv.source, 'link');
  assert.equal(inv.server, '192.168.1.2:3000');
  assert.equal(inv.address.ws, 'ws://192.168.1.2:3000/ws');
  assert.equal(inv.loopback, false);

  // The shape public/js/screens/room.js inviteLink() builds, wrapped in chat text.
  const chat = parseInvite('快来一起打！ http://26.100.222.17:3000/?room=HJKQ 就差你了');
  assert.equal(chat.code, 'HJKQ');
  assert.equal(chat.source, 'link');
  assert.equal(chat.server, '26.100.222.17:3000');

  // A host on a non-default port and extra query parameters survive.
  const extra = parseInvite('https://game.example.com/?room=MNPT&from=qq');
  assert.equal(extra.code, 'MNPT');
  assert.equal(extra.address.secure, true);
  assert.equal(extra.server, 'game.example.com:443');
});

test('parseInvite: room codes are case-insensitive and upper-cased', () => {
  for (const text of ['http://192.168.1.2:3000/?room=abcd', 'http://192.168.1.2:3000/?ROOM=ABCD'.toLowerCase(), 'mnpt']) {
    const inv = parseInvite(text);
    assert.ok(inv, `expected an invite in ${text}`);
    assert.equal(inv.code, inv.code.toUpperCase());
  }
  assert.equal(parseInvite('?room=abcd').code, 'ABCD');
});

test('parseInvite: accepts a bare code, a ?room= fragment and a deep link', () => {
  assert.deepEqual(
    (({ code, source, server }) => ({ code, source, server }))(parseInvite('ABCD')),
    { code: 'ABCD', source: 'code', server: null },
  );
  assert.deepEqual(
    (({ code, source, server }) => ({ code, source, server }))(parseInvite('  ABCD  ')),
    { code: 'ABCD', source: 'code', server: null },
  );

  const frag = parseInvite('房间号 ?room=HJKQ');
  assert.equal(frag.code, 'HJKQ');
  assert.equal(frag.source, 'param');

  // A link whose host is this machine is still a valid invite, but flagged so the client does not
  // "reconfigure" itself to point at its own loopback server.
  for (const host of ['127.0.0.1', 'localhost']) {
    const local = parseInvite(`http://${host}:41888/?room=ABCD`);
    assert.equal(local.code, 'ABCD');
    assert.equal(local.loopback, true, `${host} must be recognised as this machine`);
  }
});

test('parseInvite: a link naming a host lets the client pre-fill the server address', () => {
  // "由邀请链接自动配置服务器": whatever the link names must be a usable address, or null.
  const cases = [
    // inviteLink() in public/js/screens/room.js copies location.origin, so the port is explicit —
    // this is the only shape a real invite for the default port 3000 ever has.
    ['http://192.168.1.2:3000/?room=ABCD', '192.168.1.2:3000'],
    ['http://192.168.1.2:3001/?room=ABCD', '192.168.1.2:3001'],
    ['ws://192.168.1.2:3000/ws?room=ABCD', '192.168.1.2:3000'],
    // A written-out scheme with no port means the scheme's conventional port (the reverse-proxy
    // deployment in docs/DEPLOY.md) — the same rule parseServerAddress already applies everywhere.
    ['http://192.168.1.2/?room=ABCD', '192.168.1.2:80'],
    ['https://box.local/?room=ABCD', 'box.local:443'],
  ];
  for (const [text, label] of cases) {
    assert.equal(parseInvite(text).server, label, `wrong host for ${text}`);
  }
  // A link that carries only the code (no host at all) must not invent one.
  assert.equal(parseInvite('?room=ABCD').server, null);
  assert.equal(parseInvite('ABCD').server, null);
});

test('parseInvite: 5..6 letter codes are accepted from a link but not as bare text', () => {
  // shared/protocol.js room.join accepts ROOM_CODE_LEN..ROOM_CODE_LEN+2 alphanumerics.
  assert.equal(parseInvite('?room=ABCDE').code, 'ABCDE');
  assert.equal(parseInvite('?room=ABCDEF').code, 'ABCDEF');
  // A bare word must have the exact generated shape, or plain prose would trigger the prompt.
  assert.equal(parseInvite('ABCDE'), null);
  assert.equal(parseInvite('ABCDEF'), null);
});

// ------------------------------------------------------------------------------------------------
// What is NOT an invite — the important half
// ------------------------------------------------------------------------------------------------

test('parseInvite: rejects digits, I/O and wrong lengths', () => {
  // No code the server can generate contains a digit, an I or an O (server/lobby.js CODE_ALPHABET).
  for (const bad of ['AB1D', '1234', '?room=AB1D', 'http://192.168.1.2:3000/?room=AB1D',
    'ABID', 'ABOD', '?room=ABID', 'ABC', '?room=ABC', '?room=ABCDEFG', 'ABCDEFG']) {
    assert.equal(parseInvite(bad), null, `expected no invite in ${JSON.stringify(bad)}`);
  }
  assert.ok(isRoomCode('ABCD'));
  assert.ok(!isRoomCode('abc'));
  assert.ok(!isRoomCode(12));
});

test('parseInvite: ordinary text, empty input and junk never match', () => {
  const notInvites = [
    '', '   ', '\n\t ', null, undefined, 42, {}, [], Symbol('x'),
    '你好，今天天气不错',
    'hello world',
    'this is fine',
    'password',
    'https://example.com/',
    'https://example.com/?room=',
    '?room=',
    '?room',
    'room=ABCD',
  ];
  for (const bad of notInvites) {
    assert.equal(parseInvite(bad), null, `expected no invite in ${JSON.stringify(String(bad))}`);
  }
});

test('parseInvite: a room link for a foreign service is parsed, and its host is not trusted blindly', () => {
  // It *is* code-shaped and carries `?room=`, so it parses — the client decides whether the host is
  // usable (this is the documented boundary, asserted here so it is a contract and not an assumption).
  const foreign = parseInvite('https://meet.example.com/?room=ABCD');
  assert.equal(foreign.code, 'ABCD');
  assert.equal(foreign.source, 'link');
  assert.equal(foreign.server, 'meet.example.com:443');
  assert.equal(foreign.address.secure, true);
  assert.equal(foreign.loopback, false);
});

test('parseInvite: a bare code must be the WHOLE text', () => {
  assert.equal(parseInvite('abcd 你好'), null, 'a code inside a sentence is not a bare code');
  assert.equal(parseInvite('code: ABCD'), null);
  assert.equal(parseInvite('[ABCD]'), null);
  assert.equal(parseInvite('ABCD\nABCD'), null);
  // …but a sentence *around a link* is fine (that is how people actually share invites).
  assert.equal(parseInvite('房间： http://192.168.1.2:3000/?room=ABCD 速来').code, 'ABCD');
});

test('parseInvite: hostile and oversized input is refused, never thrown on', () => {
  // A clipboard holding a document is not an invite; scanning it must be cheap and silent.
  // The filler has to be non-whitespace, otherwise trim() legitimately shrinks it back to an invite.
  assert.equal(parseInvite(`http://192.168.1.2:3000/?room=ABCD${'x'.repeat(MAX_TEXT)}`), null);
  assert.equal(parseInvite(`http://192.168.1.2:3000/?room=ABCD${'\u0000'.repeat(MAX_TEXT)}`), null);
  assert.equal(parseInvite('A'.repeat(MAX_TEXT + 1)), null);
  // Trailing whitespace, on the other hand, is not part of the invite.
  assert.equal(parseInvite(`  http://192.168.1.2:3000/?room=ABCD${' '.repeat(MAX_TEXT)}  `).code, 'ABCD');

  // Control characters / an unbalanced link must not make the parser throw.
  for (const weird of ['\u0000', 'http://', '?:room=ABCD', 'http://192.168.1.2:3000/?room=ABCD\u2028',
    '<<<>>>', 'http://192.168.1.2:3000/?room=ABCD'.repeat(200)]) {
    assert.doesNotThrow(() => parseInvite(weird));
  }
  // A pasted link keeps its punctuation out of the code.
  assert.equal(parseInvite('看这个 http://192.168.1.2:3000/?room=ABCD。').code, 'ABCD');
  assert.equal(parseInvite('http://192.168.1.2:3000/?room=ABCD,').code, 'ABCD');
});

// ------------------------------------------------------------------------------------------------
// The sampling policy
// ------------------------------------------------------------------------------------------------

/** A watcher wired to a scriptable clipboard and a fake timer. */
function harness(texts, opts = {}) {
  let index = 0;
  const timers = [];
  const cleared = [];
  const seen = [];
  const logs = [];
  const clip = {
    get value() { return typeof texts[Math.min(index, texts.length - 1)] === 'function'
      ? texts[Math.min(index, texts.length - 1)]()
      : texts[Math.min(index, texts.length - 1)]; },
    set(value) { texts[Math.min(index, texts.length - 1)] = value; },
    advance() { index += 1; },
  };
  const watcher = createClipboardWatcher({
    read: () => clip.value,
    onInvite: (inv) => seen.push(inv),
    now: opts.now || (() => 1000),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    clearTimer: (t) => { cleared.push(t); },
    log: (m) => logs.push(m),
    ...opts,
  });
  return { watcher, clip, timers, cleared, seen, logs };
}

test('clipboardWatcher: identical clipboard text prompts exactly once', async () => {
  const h = harness(['http://192.168.1.2:3000/?room=ABCD']);
  const first = await h.watcher.poll();
  assert.equal(first.reason, 'invite');
  assert.equal(first.invite.code, 'ABCD');
  assert.equal(h.seen.length, 1);

  // The link stays in the clipboard: every later sample must be silent (no re-prompt, no new focus).
  for (let i = 0; i < 5; i++) {
    const again = await h.watcher.poll();
    assert.equal(again.reason, 'unchanged');
    assert.equal(again.invite, null);
  }
  assert.equal(h.seen.length, 1, 'the same clipboard contents must never prompt twice');

  // A different invite does prompt again.
  h.clip.set('http://192.168.1.2:3000/?room=HJKQ');
  assert.equal((await h.watcher.poll()).reason, 'invite');
  assert.equal(h.seen.length, 2);
  assert.equal(h.seen[1].code, 'HJKQ');
});

test('clipboardWatcher: ignores everything that is not an invite', async () => {
  const h = harness(['http://192.168.1.2:3000/?room=ABCD']);
  await h.watcher.poll();

  h.clip.set('   ');
  assert.equal((await h.watcher.poll()).reason, 'empty');
  h.clip.set(null);
  assert.equal((await h.watcher.poll()).reason, 'empty');
  h.clip.set('你好，今晚吃什么？');
  assert.equal((await h.watcher.poll()).reason, 'no-invite');
  h.clip.set('x'.repeat(MAX_TEXT + 1));
  assert.equal((await h.watcher.poll()).reason, 'too-long');
  // The oversized text was recorded, so it does not immediately re-report when it shrinks back.
  h.clip.set('你好，今晚吃什么？');
  assert.equal((await h.watcher.poll()).reason, 'no-invite');
  assert.equal(h.seen.length, 1, 'only the one real invite was ever surfaced');
});

test('clipboardWatcher: an unreadable clipboard never clears what was already seen', async () => {
  const h = harness(['http://192.168.1.2:3000/?room=ABCD']);
  await h.watcher.poll();
  h.clip.set(() => { throw new Error('clipboard is busy'); });
  assert.equal((await h.watcher.poll()).reason, 'unreadable');
  assert.equal(h.seen.length, 1);
  // The failure is reported once, not on every sample.
  await h.watcher.poll();
  assert.equal(h.logs.filter((l) => l.includes('cannot read')).length, 1);

  // Back to the same invite: still de-duplicated (the read failure did not reset the memory).
  h.clip.set('http://192.168.1.2:3000/?room=ABCD');
  assert.equal((await h.watcher.poll()).reason, 'unchanged');
  // …until reset(), which is how the prompt's own re-open path asks for another look.
  h.watcher.reset();
  assert.equal((await h.watcher.poll()).reason, 'invite');
  assert.equal(h.seen.length, 2);
});

// ------------------------------------------------------------------------------------------------
// The async read (Electron 44: clipboard.readText() returns Promise<string>)
// ------------------------------------------------------------------------------------------------

test('clipboardWatcher: an async clipboard read works, and a rejection is just "unreadable"', async () => {
  // Electron 44 changed main-process clipboard.readText() to return a promise. A watcher that treated
  // the promise itself as the text saw `typeof !== 'string'` and reported 'empty' forever — the whole
  // feature was silently dead. Both shapes must work.
  const texts = ['http://192.168.1.2:3000/?room=ABCD'];
  const seen = [];
  const watcher = createClipboardWatcher({
    read: async () => texts[0],
    onInvite: (i) => seen.push(i),
    setTimer: () => ({ unref() {} }),
  });
  const first = await watcher.poll();
  assert.equal(first.reason, 'invite');
  assert.equal(first.invite.code, 'ABCD');
  assert.equal((await watcher.poll()).reason, 'unchanged');
  assert.equal(seen.length, 1);

  // A rejecting read is contained: no unhandled rejection, and it is the 'unreadable' path.
  const failing = createClipboardWatcher({
    read: async () => { throw new Error('clipboard is busy'); },
    setTimer: () => ({ unref() {} }),
    log: () => {},
  });
  assert.equal((await failing.poll()).reason, 'unreadable');
  // A promise resolving to a non-string is still just "empty".
  const junk = createClipboardWatcher({ read: async () => 42, setTimer: () => ({ unref() {} }) });
  assert.equal((await junk.poll()).reason, 'empty');
});

test('clipboardWatcher: poll() always returns a promise, even for a sync read', async () => {
  // main.js does `await watcher.poll()`; a sync return value would break the focus handler's ordering.
  const sync = createClipboardWatcher({ read: () => '?room=ABCD', setTimer: () => ({ unref() {} }) });
  const p = sync.poll();
  assert.ok(p instanceof Promise, 'poll() must be awaitable regardless of how read() behaves');
  assert.equal((await p).reason, 'invite');
});

test('clipboardWatcher: a slow read cannot prompt with stale contents', async () => {
  // Overlapping samples are real once read() is async: the older read must not commit its text or fire
  // its handler after a newer sample has already reported.
  const gates = [];
  const seen = [];
  const watcher = createClipboardWatcher({
    read: () => new Promise((resolve) => gates.push({ resolve })),
    onInvite: (i) => seen.push(i),
    setTimer: () => ({ unref() {} }),
  });
  const slow = watcher.poll();            // sample 1 — still pending
  const fast = watcher.poll();            // sample 2 — also pending
  gates[1].resolve('http://192.168.1.2:3000/?room=ZZZZ'); // newest wins
  assert.equal((await fast).invite.code, 'ZZZZ');
  gates[0].resolve('http://192.168.1.2:3000/?room=ABCD'); // the stale one lands afterwards
  assert.equal((await slow).invite, null, 'the stale sample must not surface an invite');
  assert.deepEqual(seen.map((i) => i.code), ['ZZZZ']);
});

test('clipboardWatcher: the interval survives an async read failure', async () => {
  const logs = [];
  let reads = 0;
  const timers = [];
  const watcher = createClipboardWatcher({
    read: async () => { reads += 1; throw new Error('nope'); },
    setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
    log: (m) => logs.push(m),
  });
  watcher.start();
  assert.equal(watcher.running, true);
  timers[0]();
  // The tick is fire-and-forget; let the rejected promise settle, then confirm no unhandled rejection
  // and that the loop is still live.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reads, 1);
  assert.equal(watcher.running, true);
  timers[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reads, 2, 'the interval must keep sampling after a failed read');
});

test('clipboardWatcher: sampling runs on a timer only while enabled', async () => {
  const h = harness(['?room=ABCD']);
  assert.equal(DEFAULT_POLL_MS > 0, true);

  h.watcher.start();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, DEFAULT_POLL_MS);
  h.watcher.start(); // idempotent: a second start must not stack intervals
  assert.equal(h.timers.length, 1);

  // The injected timer fires the same code path as poll().
  h.clip.set('?room=HJKQ');
  h.timers[0].fn();
  await new Promise((r) => setTimeout(r, 5)); // the tick is fire-and-forget (async read)
  assert.equal(h.seen.length, 1);

  h.watcher.stop();
  assert.equal(h.cleared.length, 1);
  h.watcher.stop(); // idempotent
  assert.equal(h.cleared.length, 1);

  h.watcher.start();
  h.watcher.setEnabled(false);
  assert.equal(h.watcher.enabled, false);
  assert.equal(h.watcher.running, false);
  assert.equal((await h.watcher.poll()).reason, 'disabled', 'off means no clipboard read at all');
  h.watcher.setEnabled(true);
  assert.equal(h.watcher.running, true);
});

test('clipboardWatcher: a throwing read or handler cannot take the client down', async () => {
  let reads = 0;
  const watcher = createClipboardWatcher({
    read: () => { reads += 1; throw new Error('nope'); },
    onInvite: () => { throw new Error('handler exploded'); },
    setTimer: () => ({ unref() {} }),
  });
  assert.equal((await watcher.poll()).reason, 'unreadable');
  assert.equal(reads, 1);

  const ok = createClipboardWatcher({
    read: () => '?room=ABCD',
    onInvite: () => { throw new Error('handler exploded'); },
  });
  assert.equal((await ok.poll()).reason, 'invite', 'a failing handler must not swallow the sample');

  assert.throws(() => createClipboardWatcher({}), /read\(\) is required/);
  assert.throws(() => createClipboardWatcher(), /read\(\) is required/);
});

test('clipboardWatcher: clipboard text is never written to the log', async () => {
  const h = harness(['房间号 ?room=ABCD 我的密码 hunter2']);
  await h.watcher.poll();
  assert.equal(h.seen.length, 1);
  const joined = h.logs.join('\n');
  assert.ok(!joined.includes('hunter2'), 'raw clipboard text must never be logged');
  assert.ok(joined.includes('ABCD'), 'the recognised code is what gets logged');
});

// ------------------------------------------------------------------------------------------------
// Settings flag
// ------------------------------------------------------------------------------------------------

test('clipboardWatch defaults to on and only an explicit false turns it off', () => {
  assert.equal(defaultConfig().clipboardWatch, true);
  assert.equal(normalizeConfig(undefined).clipboardWatch, true);
  assert.equal(normalizeConfig(null).clipboardWatch, true);
  assert.equal(normalizeConfig({}).clipboardWatch, true);
  // Garbage must not silently disable the feature (nor turn it on for a truthy string).
  for (const junk of ['false', 0, 1, 'yes', [], {}, NaN, null, true]) {
    assert.equal(normalizeConfig({ clipboardWatch: junk }).clipboardWatch, true, `junk: ${JSON.stringify(junk)}`);
  }
  assert.equal(normalizeConfig({ clipboardWatch: false }).clipboardWatch, false);

  // Round-trip through the on-disk shape.
  const off = normalizeConfig(JSON.parse(JSON.stringify({ ...defaultConfig(), clipboardWatch: false })));
  assert.equal(off.clipboardWatch, false);
  const on = normalizeConfig(JSON.parse(JSON.stringify(defaultConfig())));
  assert.equal(on.clipboardWatch, true);

  // The pre-existing fields are untouched by the new key's presence.
  const cfg = normalizeConfig({ server: '192.168.1.2:3000', localPort: 5000, recent: ['192.168.1.2:3000'] });
  assert.equal(cfg.server, '192.168.1.2:3000');
  assert.equal(cfg.localPort, 5000);
  assert.deepEqual(cfg.recent, ['192.168.1.2:3000']);
  // …and unknown keys are still dropped rather than persisted.
  assert.equal('somethingElse' in normalizeConfig({ somethingElse: 1 }), false);
});

test('the watcher honours the persisted flag', async () => {
  const texts = ['?room=ABCD'];
  const watcher = createClipboardWatcher({
    read: () => texts[0],
    setTimer: () => ({ unref() {} }),
  });
  assert.equal(watcher.enabled, defaultConfig().clipboardWatch);
  watcher.setEnabled(normalizeConfig({ clipboardWatch: false }).clipboardWatch);
  assert.equal((await watcher.poll()).reason, 'disabled');
});

// ------------------------------------------------------------------------------------------------
// Shell wiring — the parts that are not unit-testable without Electron, pinned by contract
// ------------------------------------------------------------------------------------------------

const MAIN = () => read(path.join('client', 'main.js'));
const GAME_WINDOW = () => {
  // The game window's own webPreferences block, so the assertions cannot be satisfied by the
  // settings or prompt window's (correctly different) configuration.
  const m = MAIN().match(/function createMainWindow[\s\S]*?mainWindow\.loadURL/);
  assert.ok(m, 'client/main.js must still build the game window in createMainWindow()');
  return m[0];
};

test('the game window keeps its locked-down webPreferences', () => {
  const block = GAME_WINDOW();
  assert.match(block, /contextIsolation:\s*true/);
  assert.match(block, /nodeIntegration:\s*false/);
  assert.match(block, /sandbox:\s*true/);
  // The renderer is the untouched web game: it must have no preload/bridge at all.
  assert.ok(!/preload:/.test(block), 'the game window must not gain a preload');
});

test('joining goes through the game\'s own ?room= deep link, not a second join path', () => {
  const main = MAIN();
  // roomQuery() is the single source of the URL shape; nothing may hand-write `room=`.
  assert.match(main, /import \{[^}]*roomQuery[^}]*\} from '\.\/invite\.js'/);
  assert.match(main, /roomQuery\(/, 'the deep link must be built with roomQuery()');
  assert.ok(!/['"`]\/?\?room=/.test(main), 'no hand-written ?room= literal — use roomQuery()');
  // …and the navigation is a real load of the loopback origin, so parseRoomParam() sees it.
  assert.match(main, /loopbackOrigin/);
});

test('the invite prompt cannot steal focus and is not an overlay in the game window', () => {
  const main = MAIN();
  const m = main.match(/promptWindow = new BrowserWindow\(\{[\s\S]*?await promptWindow\.loadFile/);
  assert.ok(m, 'client/main.js must still create and load the prompt window');
  const block = m[0];
  assert.match(block, /focusable:\s*false/, 'the prompt must not take focus from the match');
  assert.match(block, /showInactive\(\)/, 'the prompt must be shown without activating it');
  assert.match(block, /skipTaskbar:\s*true/);
  assert.match(block, /alwaysOnTop:\s*true/);
  // A real window, not an injection: the game window has no bridge to inject through.
  assert.match(block, /contextIsolation:\s*true/);
  assert.match(block, /nodeIntegration:\s*false/);
  assert.match(block, /sandbox:\s*true/);
  assert.ok(!/\bfocus\(\)/.test(block), 'nothing in the prompt path may call focus()');
});

test('the prompt is held back while a match is on screen and lifted above the corner row', () => {
  const main = MAIN();
  // A live match is detected through the class the game itself sets (public/js/screens/game.js:171).
  assert.match(main, /sp-in-match/);
  assert.match(read(path.join('public', 'js', 'screens', 'game.js')), /useDocClass\('sp-in-match'\)/);
  // Deferred, not dropped: it is shown once the match ends.
  assert.match(main, /deferredInvite/);
  // …and its geometry clears `.gm__corner` at the bottom-left of the game's own coordinate system.
  assert.match(main, /function promptBounds\(/);
  assert.match(read(path.join('public', 'css', 'screens', 'game.css')), /\.gm__corner\s*\{[^}]*left:\s*\.24rem/);
});

test('the prompt offers 进入房间 / 忽略 / 不再提示 and names the room code', () => {
  const html = read(path.join('client', 'prompt.html'));
  for (const label of ['进入房间', '忽略', '不再提示']) {
    assert.ok(html.includes(`>${label}<`), `prompt.html must have a ${label} button`);
  }
  assert.ok(html.includes('spPrompt.accept') && html.includes('spPrompt.ignore') && html.includes('spPrompt.never'));
  // Inline only: the page is loaded from disk with no network access in the shell.
  assert.match(html, /default-src 'none'/);
  // The room code is rendered from the payload, never hard-coded.
  assert.match(html, /info\.code/);
});

test('不再提示 and the settings checkbox write the same persisted flag', () => {
  const main = MAIN();
  assert.match(main, /'sp:prompt-never'[\s\S]{0,200}setClipboardWatch\(false\)/);
  assert.match(main, /'sp:set-clipboard-watch'[\s\S]{0,200}setClipboardWatch\(/);
  // One setter, one config key, one write.
  assert.match(main, /config = \{ \.\.\.config, clipboardWatch: on \}/);

  const preload = read(path.join('client', 'preload.cjs'));
  assert.match(preload, /setClipboardWatch/);
  assert.match(preload, /sp:set-clipboard-watch/);

  const settings = read(path.join('client', 'settings.html'));
  assert.match(settings, /id="clipboardWatch"[^>]*type="checkbox"/);
  assert.ok(settings.includes('自动识别剪贴板中的房间码'), 'the checkbox label is the task wording');
  assert.match(settings, /clipboardWatch\.checked = cfg\.clipboardWatch !== false/, 'default ON');
  assert.ok(settings.includes('剪贴板与邀请'), 'the settings window needs the clipboard/invite help section');
});

test('the two preloads expose disjoint bridges, and the settings window keeps its own', () => {
  const settingsPreload = read(path.join('client', 'preload.cjs'));
  const promptPreload = read(path.join('client', 'prompt-preload.cjs'));
  assert.match(settingsPreload, /exposeInMainWorld\('spClient'/);
  assert.match(promptPreload, /exposeInMainWorld\('spPrompt'/);
  // A prompt page must not be able to reach the settings IPC, and vice versa.
  assert.ok(!settingsPreload.includes('sp:prompt-accept'));
  assert.ok(!promptPreload.includes('sp:save'));
  for (const p of [settingsPreload, promptPreload]) {
    assert.match(p, /require\('electron'\)/, 'a sandboxed preload is CommonJS');
    assert.ok(!/nodeIntegration|contextIsolation/.test(p), 'the preload must not set window options itself');
  }
  // The settings window still loads the settings preload, the prompt window the prompt one.
  const main = MAIN();
  assert.match(main, /preload: path\.join\(CLIENT_DIR, 'preload\.cjs'\)/);
  assert.match(main, /preload: path\.join\(CLIENT_DIR, 'prompt-preload\.cjs'\)/);
});
