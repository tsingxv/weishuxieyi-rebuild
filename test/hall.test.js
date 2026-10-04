// test/hall.test.js — \u5927\u5385 (server-wide presence, chat, whisper): the opt-in channel that lets the
// people on one friend server see each other, share room codes and read the last few \u6218\u7ee9 + \u79f0\u53f7.
//
// Every live test boots its own server with the StubMatch (like test/lobby.test.js), so the frames on the
// wire are exactly what a browser sees and one test's chat cannot leak into the next.
// NOTE: all CJK string literals in this file are written as \uXXXX escapes on purpose — a PowerShell
// Set-Content round-trip previously corrupted them into mojibake and the assertions stopped matching.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { sanitizeChat } from '../server/hall.js';
import { CHAT_MAX_LEN, ERR } from '../shared/constants.js';
import { C2S, S2C, validateC2S } from '../shared/protocol.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

// ---- CJK literals as escapes (see the NOTE above) ---------------------------------------------
const AMIYA = '\u963f\u7c73\u5a35';   // 阿米娅
const KELSI = '\u51ef\u5c14\u5e0c';   // 凯尔希
const HIALL = '\u5927\u5bb6\u597d';   // 大家好
const SECRET = '\u79c1\u804a\u6d4b\u8bd5'; // 私聊测试
const HELLO = '\u5728\u5417';          // 在吗

/** A live server + its clients, torn down together. */
async function withServer(fn) {
  const { StubMatch } = await import('../server/match/StubMatch.js');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, publicDir: PUBLIC });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const open = new Set();
  const connect = async (name, token) => {
    const c = await TestClient.connect(url);
    open.add(c);
    const w = await c.hello(name, token);
    c.id = w.playerId;
    c.token = w.token;
    return c;
  };
  const enter = async (c) => {
    const reply = await c.request({ t: 'hall.enter' });
    assert.equal(reply.t, 'ok', `hall.enter answered ${JSON.stringify(reply)}`);
    return c.waitFor('hall.state', () => true, 3000);
  };
  try {
    return await fn({ srv, url, connect, enter });
  } finally {
    for (const c of open) await c.close().catch(() => {});
    open.clear();
    await srv.close();
  }
}

describe('sanitizeChat', () => {
  test('collapses whitespace, strips control characters and clamps to CHAT_MAX_LEN', () => {
    assert.equal(sanitizeChat('  hello   world  '), 'hello world');
    assert.equal(sanitizeChat('a\nb\tc'), 'a b c');
    assert.equal(sanitizeChat('x\u202ey'), 'x y', 'a bidi override cannot lie about the layout');
    assert.equal(sanitizeChat('a\u0000b'), 'a b');
    assert.equal(sanitizeChat('\u200b'), '');
    assert.equal(sanitizeChat(123), '');
    assert.equal(sanitizeChat(null), '');
    assert.equal(sanitizeChat('\u3042'.repeat(500)).length, CHAT_MAX_LEN);
  });
});

describe('hall protocol surface', () => {
  test('the new types are registered on both sides and validate their fields', () => {
    for (const t of ['hall.enter', 'hall.leave', 'hall.chat', 'hall.whisper']) assert.ok(Object.hasOwn(C2S, t), `${t} in C2S`);
    for (const t of ['hall.state', 'hall.roster', 'hall.chat', 'hall.whisper']) assert.ok(S2C.includes(t), `${t} in S2C`);
    assert.equal(validateC2S({ t: 'hall.enter' }), null);
    assert.equal(validateC2S({ t: 'hall.leave' }), null);
    assert.equal(validateC2S({ t: 'hall.chat', text: 'hi' }), null);
    assert.notEqual(validateC2S({ t: 'hall.chat', text: '' }), null);
    assert.notEqual(validateC2S({ t: 'hall.chat', text: 'x'.repeat(CHAT_MAX_LEN + 1) }), null);
    assert.equal(validateC2S({ t: 'hall.whisper', to: 'p_abc123', text: 'hi' }), null);
    assert.notEqual(validateC2S({ t: 'hall.whisper', text: 'hi' }), null, 'to is required');
    assert.notEqual(validateC2S({ t: 'hall.whisper', to: 'p_abc123' }), null, 'text is required');
  });
});

describe('hall (live server)', () => {
  test('hall.enter answers with a snapshot; a session that never enters gets no hall frames', async () => {
    await withServer(async ({ connect, enter }) => {
      const a = await connect(AMIYA);
      const b = await connect(KELSI);
      const state = await enter(a);
      const names = state.roster.map((r) => r.name);
      assert.ok(names.includes(AMIYA), 'the requester is in its own roster');
      assert.ok(names.includes(KELSI), 'every connected session is listed, whether or not it entered');
      assert.equal(state.roomsTotal, 0);
      assert.deepEqual(state.chat, []);
      assert.deepEqual(state.results, []);
      assert.equal(typeof state.serverNow, 'number');

      assert.equal((await a.request({ t: 'hall.chat', text: HIALL })).t, 'ok');
      const line = await a.waitFor('hall.chat');
      assert.equal(line.line.text, HIALL);
      assert.equal(line.line.name, AMIYA);
      await b.expectNone('hall.chat', () => true, 250);
      await b.expectNone('hall.roster', () => true, 100);
    });
  });

  test('the roster lists open rooms with their codes, to every subscriber', async () => {
    await withServer(async ({ connect, enter }) => {
      const a = await connect('A');
      const b = await connect('B');
      await enter(a);
      await enter(b);

      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
      const room = await a.waitFor('room.state');
      const roster = await a.waitFor('hall.roster', (m) => m.rooms.length === 1, 3000);
      assert.equal(roster.rooms[0].code, room.code);
      assert.equal(roster.rooms[0].hostName, 'A');
      assert.equal(roster.roster.find((r) => r.playerId === a.id).roomCode, room.code);
      const seenByB = await b.waitFor('hall.roster', (m) => m.rooms.length === 1, 3000);
      assert.equal(seenByB.rooms[0].code, room.code);
    });
  });

  test('hall.chat broadcasts to every subscriber and enforces the cooldown', async () => {
    await withServer(async ({ connect, enter }) => {
      const a = await connect('A');
      const b = await connect('B');
      await enter(a);
      await enter(b);

      assert.equal((await a.request({ t: 'hall.chat', text: 'hi from A' })).t, 'ok');
      const got = await b.waitFor('hall.chat');
      assert.equal(got.line.text, 'hi from A');
      const fast = await a.request({ t: 'hall.chat', text: 'again' });
      assert.equal(fast.code, ERR.RATE);
      await b.expectNone('hall.chat', () => true, 250);
    });
  });

  test('hall.state replays the chat ring to a session that enters later', async () => {
    await withServer(async ({ connect, enter }) => {
      const a = await connect('A');
      await enter(a);
      assert.equal((await a.request({ t: 'hall.chat', text: 'first' })).t, 'ok');
      await a.waitFor('hall.chat', (m) => m.line.text === 'first');

      const b = await connect('B');
      const state = await enter(b);
      assert.deepEqual(state.chat.map((c) => c.text), ['first'], 'the newcomer sees the backlog');
    });
  });

  test('hall.leave stops the frames', async () => {
    await withServer(async ({ connect, enter }) => {
      const a = await connect('A');
      const b = await connect('B');
      await enter(a);
      await enter(b);
      assert.equal((await b.request({ t: 'hall.leave' })).t, 'ok');
      b.clearInbox();
      assert.equal((await a.request({ t: 'hall.chat', text: 'still here' })).t, 'ok');
      await b.expectNone('hall.chat', () => true, 300);
    });
  });

  test('a finished match lands in the results ring with its titles (评语)', async () => {
    await withServer(async ({ connect, enter }) => {
      const a = await connect('A');
      const b = await connect('B');
      await enter(b);

      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
      const room = await a.waitFor('room.state');
      assert.equal((await a.request({ t: 'room.start' })).t, 'ok');
      await a.waitFor('m.public', (p) => p.phase === 'INFO_CHECK', 4000);
      assert.equal((await a.request({ t: 'g.infoReady' })).t, 'ok');

      const res = await a.waitFor('m.result', () => true, 4000);
      const roster = await b.waitFor('hall.roster', (m) => m.rooms.some((r) => r.code === room.code && r.inMatch === false), 4000);
      assert.ok(roster, 'the hall saw the room leave its match');

      const c = await connect('C');
      const snap = await enter(c);
      assert.ok(snap.results.length >= 1);
      const entry = snap.results.at(-1);
      assert.equal(entry.roomCode, room.code);
      assert.equal(entry.difficulty, 'FUNNY');
      assert.equal(entry.victory, res.victory);
      const p = entry.players[0];
      assert.equal(typeof p.name, 'string');
      assert.ok(p.title === null || (typeof p.title.id === 'string' && typeof p.title.name === 'string'));
    });
  });

  test('a dropped socket leaves the roster but its chat line stays', async () => {
    await withServer(async ({ connect, enter, srv }) => {
      const a = await connect('A');
      const b = await connect('B');
      await enter(a);
      await enter(b);
      assert.equal((await a.request({ t: 'hall.chat', text: 'farewell' })).t, 'ok');
      await b.waitFor('hall.chat', (m) => m.line.text === 'farewell', 3000);

      await a.terminate();
      await b.waitFor('hall.roster', (m) => m.roster.every((r) => r.name !== 'A'), 3000);

      const c = await connect('C');
      const snap = await enter(c);
      assert.deepEqual(snap.chat.map((x) => x.text), ['farewell'], 'history outlives presence');
    });
  });

  test('a reconnect gets the snapshot back without re-entering', async () => {
    await withServer(async ({ connect, enter }) => {
      const a = await connect('A');
      await enter(a);
      assert.equal((await a.request({ t: 'hall.chat', text: 'before' })).t, 'ok');
      await a.waitFor('hall.chat', (m) => m.line.text === 'before', 3000);

      const again = await connect('A', a.token);
      assert.equal(again.id, a.id);
      const snap = await again.waitFor('hall.state', () => true, 3000);
      assert.ok(snap.chat.some((x) => x.text === 'before'));
    });
  });

  test('/healthz reports the hall counters', async () => {
    await withServer(async ({ connect, enter, srv }) => {
      const a = await connect('A');
      await enter(a);
      const body = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
      assert.equal(body.ok, true);
      assert.ok(body.hallMembers >= 1);
      assert.equal(typeof body.hallChat, 'number');
      assert.equal(typeof body.hallResults, 'number');
    });
  });

  // ---- 私聊 (hall.whisper) --------------------------------------------------------------------

  describe('hall.whisper', () => {
    test('relays a line to the recipient and echoes it back to the sender', async () => {
      await withServer(async ({ connect }) => {
        const a = await connect('A');
        const b = await connect('B');
        const gotByB = b.waitFor('hall.whisper', () => true, 3000);
        const gotByA = a.waitFor('hall.whisper', () => true, 3000);
        assert.equal((await a.request({ t: 'hall.whisper', to: b.id, text: SECRET })).t, 'ok');
        const atB = await gotByB;
        const atA = await gotByA;
        for (const [who, frame] of [['B', atB], ['A(echo)', atA]]) {
          assert.equal(frame.line.fromId, a.id, `${who}: fromId`);
          assert.equal(frame.line.fromName, 'A', `${who}: fromName`);
          assert.equal(frame.line.toId, b.id, `${who}: toId`);
          assert.equal(frame.line.text, SECRET, `${who}: text`);
          assert.match(frame.line.id, /^w\d+$/);
        }
      });
    });

    test('does NOT require the recipient to have entered the hall, and does NOT leak to others', async () => {
      await withServer(async ({ connect }) => {
        const a = await connect('A');
        const b = await connect('B');
        const outsider = await connect('C');
        const got = b.waitFor('hall.whisper', () => true, 3000);
        assert.equal((await a.request({ t: 'hall.whisper', to: b.id, text: HELLO })).t, 'ok');
        assert.equal((await got).line.text, HELLO);
        await outsider.expectNone('hall.whisper', () => true, 250);
      });
    });

    test('refuses yourself / offline ids / blank text, and enforces its own burst budget', async () => {
      await withServer(async ({ connect }) => {
        const a = await connect('A');
        const b = await connect('B');

        const self = await a.request({ t: 'hall.whisper', to: a.id, text: 'hi me' });
        assert.equal(self.code, ERR.BAD_MSG, 'whispering to yourself is a client bug');
        const offline = await a.request({ t: 'hall.whisper', to: 'p_doesnotexist', text: 'hi' });
        assert.equal(offline.code, ERR.BAD_MSG);
        const blank = await a.request({ t: 'hall.whisper', to: b.id, text: '   ' });
        assert.equal(blank.code, ERR.BAD_MSG);

        let accepted = 0;
        let rate = 0;
        for (let i = 0; i < 30; i++) {
          const r = await a.request({ t: 'hall.whisper', to: b.id, text: `m${i}` });
          if (r.t === 'ok') accepted++;
          else { assert.equal(r.code, ERR.RATE, `line ${i} must be ok or RATE`); rate++; }
        }
        assert.equal(accepted, 20, 'WHISPER_BURST lines accepted inside the window');
        assert.equal(rate, 10, 'the rest are refused with RATE');
        for (let i = 0; i < accepted; i++) await b.waitFor('hall.whisper', () => true, 3000);
        await b.expectNone('hall.whisper', () => true, 250);
      });
    });

    test('is not stored on the server: a fresh subscriber sees no private lines', async () => {
      await withServer(async ({ connect, enter }) => {
        const a = await connect('A');
        const b = await connect('B');
        await enter(a);
        await enter(b);
        assert.equal((await a.request({ t: 'hall.whisper', to: b.id, text: SECRET })).t, 'ok');
        await b.waitFor('hall.whisper', (m) => m.line.text === SECRET, 3000);

        const c = await connect('C');
        const snap = await enter(c);
        assert.deepEqual(snap.chat, [], 'the public chat ring holds no private lines');
        // only a bystander must have received nothing: A (sender) and B (recipient) each got the line
        await c.expectNone('hall.whisper', () => true, 250);
      });
    });

    test('survives a reconnect: the sender and the recipient can continue privately', async () => {
      await withServer(async ({ connect }) => {
        const a = await connect('A');
        const b = await connect('B');
        assert.equal((await a.request({ t: 'hall.whisper', to: b.id, text: SECRET })).t, 'ok');
        await b.waitFor('hall.whisper', (m) => m.line.text === SECRET, 3000);

        // B drops and resumes with the same token: its playerId is unchanged, so A can still reach it
        const b2 = await connect('B', b.token);
        assert.equal(b2.id, b.id);
        const got = a.waitFor('hall.whisper', (m) => m.line.fromId === b.id, 3000);
        assert.equal((await b2.request({ t: 'hall.whisper', to: a.id, text: 'back' })).t, 'ok');
        assert.equal((await got).line.text, 'back');
      });
    });
  });
});
