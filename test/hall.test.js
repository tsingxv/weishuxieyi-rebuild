// test/hall.test.js — 大厅 (server-wide presence, chat, recent results): the opt-in channel that lets the
// people on one friend server see each other, share room codes and read the last few 战绩 + 评语.
//
// Every live test boots its own server with the StubMatch (like test/lobby.test.js), so the frames on the
// wire are exactly what a browser sees and one test's chat cannot leak into the next.
import { describe, test, before, after } from 'node:test';
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

/** A live server + its clients, torn down together. */
async function withServer(fn) {
  const { StubMatch } = await import('../server/match/StubMatch.js');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, publicDir: PUBLIC });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const open = new Set();
  /** Connect + hello; the client gets `.id` / `.token`. */
  const connect = async (name, token) => {
    const c = await TestClient.connect(url);
    open.add(c);
    const w = await c.hello(name, token);
    c.id = w.playerId;
    c.token = w.token;
    return c;
  };
  /** Enter the hall and consume the snapshot. @returns the hall.state frame */
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
    assert.equal(sanitizeChat('あ'.repeat(500)).length, CHAT_MAX_LEN);
  });
});

describe('hall protocol surface', () => {
  test('the new types are registered on both sides and validate their fields', () => {
    for (const t of ['hall.enter', 'hall.leave', 'hall.chat']) assert.ok(Object.hasOwn(C2S, t), `${t} in C2S`);
    for (const t of ['hall.state', 'hall.roster', 'hall.chat']) assert.ok(S2C.includes(t), `${t} in S2C`);
    assert.equal(validateC2S({ t: 'hall.enter' }), null);
    assert.equal(validateC2S({ t: 'hall.leave' }), null);
    assert.equal(validateC2S({ t: 'hall.chat', text: 'hi' }), null);
    assert.notEqual(validateC2S({ t: 'hall.chat', text: '' }), null);
    assert.notEqual(validateC2S({ t: 'hall.chat', text: 'x'.repeat(CHAT_MAX_LEN + 1) }), null);
    assert.notEqual(validateC2S({ t: 'hall.chat' }), null);
  });
});

describe('hall (live server)', () => {
  test('hall.enter answers with a snapshot; a session that never enters gets no hall frames', async () => {
    await withServer(async ({ connect, enter }) => {
      const a = await connect('阿米娅');
      const b = await connect('凯尔希');
      // b stays out of the hall: it must not see a's presence or a's chat
      const state = await enter(a);
      const names = state.roster.map((r) => r.name);
      assert.ok(names.includes('阿米娅'), 'the requester is in its own roster');
      assert.ok(names.includes('凯尔希'), 'every connected session is listed, whether or not it entered');
      assert.equal(state.roomsTotal, 0);
      assert.deepEqual(state.chat, []);
      assert.deepEqual(state.results, []);
      assert.equal(typeof state.serverNow, 'number');
      assert.ok(state.roster.every((r) => r.roomCode === null && r.inMatch === false));

      assert.equal((await a.request({ t: 'hall.chat', text: '大家好' })).t, 'ok');
      const line = await a.waitFor('hall.chat');
      assert.equal(line.line.text, '大家好');
      assert.equal(line.line.name, '阿米娅');
      assert.equal(line.line.playerId, a.id);
      // b never subscribed → nothing was pushed to it
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

      // a new room shows up in the roster frame
      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
      const room = await a.waitFor('room.state');
      const roster = await a.waitFor('hall.roster', (m) => m.rooms.length === 1, 3000);
      assert.equal(roster.rooms[0].code, room.code);
      assert.equal(roster.rooms[0].mode, 'coop');
      assert.equal(roster.rooms[0].humans, 1);
      assert.equal(roster.rooms[0].inMatch, false);
      assert.equal(roster.rooms[0].hostName, 'A');
      assert.equal(roster.roster.find((r) => r.playerId === a.id).roomCode, room.code,
        'the roster says which room each player is in');

      // b (in the hall, not in the room) also learns the code — that is the "share a code" path
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
      assert.equal(got.line.name, 'A');

      // a second line inside the cooldown is refused with RATE, and nothing is broadcast
      const fast = await a.request({ t: 'hall.chat', text: 'again' });
      assert.equal(fast.t, 'error');
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
      // the stub match ends when its humans are ready; that broadcasts the public m.result the hall mirrors
      assert.equal((await a.request({ t: 'g.infoReady' })).t, 'ok');

      const res = await a.waitFor('m.result', () => true, 4000);
      assert.equal(typeof res.victory, 'boolean');
      // the room left its match: the hall's open-rooms list says so
      const roster = await b.waitFor('hall.roster', (m) => m.rooms.some((r) => r.code === room.code && r.inMatch === false), 4000);
      assert.ok(roster, 'the hall saw the room leave its match');

      const c = await connect('C');
      const snap = await enter(c);
      assert.ok(snap.results.length >= 1, 'at least one finished match is kept');
      const entry = snap.results.at(-1);
      assert.equal(entry.roomCode, room.code);
      assert.equal(entry.difficulty, 'FUNNY');
      assert.equal(entry.victory, res.victory, 'the hall mirrors the broadcast result');
      assert.ok(Array.isArray(entry.players) && entry.players.length >= 1);
      const p = entry.players[0];
      assert.equal(typeof p.name, 'string');
      assert.equal(typeof p.roundsPassed, 'number');
      assert.equal(typeof p.victory, 'boolean');
      assert.ok(p.title === null || (typeof p.title.id === 'string' && typeof p.title.name === 'string'),
        'a title is either null or { id, name }');
    });
  });

  test('a dropped socket leaves the roster but its chat line stays', async () => {
    await withServer(async ({ connect, enter, srv }) => {
      const a = await connect('A');
      const b = await connect('B');
      await enter(a);
      await enter(b);
      assert.equal((await a.request({ t: 'hall.chat', text: 'farewell' })).t, 'ok');
      await b.waitFor('hall.chat', (m) => m.line.text === 'farewell');

      await a.terminate();
      // the registry keeps the session resumable, but presence is about live sockets
      await b.waitFor('hall.roster', (m) => m.roster.every((r) => r.name !== 'A'), 3000);

      const health = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
      assert.ok(health.hallMembers >= 1);

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
      await a.waitFor('hall.chat', (m) => m.line.text === 'before');

      // resume with the same token: the session is the same one, so it is still in the hall
      const again = await connect('A', a.token);
      assert.equal(again.id, a.id, 'the same session was resumed');
      const snap = await again.waitFor('hall.state', () => true, 3000);
      assert.ok(snap.chat.some((x) => x.text === 'before'), 'the resumed client gets the hall back');
    });
  });

  test('a chat line is cleaned up before it is broadcast', async () => {
    await withServer(async ({ connect, enter }) => {
      const a = await connect('A');
      const b = await connect('B');
      await enter(a);
      await enter(b);
      // the wire validator accepts any ≤120-char string; the handler owns the cleanup
      assert.equal((await a.request({ t: 'hall.chat', text: '   spaced\u202eout   ' })).t, 'ok');
      const line = await b.waitFor('hall.chat');
      assert.equal(line.line.text, 'spaced out');
      assert.ok(line.line.at > 0);
      assert.match(line.line.id, /^c\d+$/);
    });
  });

  test('/healthz reports the hall counters', async () => {
    await withServer(async ({ connect, enter, srv }) => {
      const a = await connect('A');
      await enter(a);
      const body = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
      assert.equal(body.ok, true);
      assert.ok(body.hallMembers >= 1, 'the hall member count is exposed');
      assert.equal(typeof body.hallChat, 'number');
      assert.equal(typeof body.hallResults, 'number');
    });
  });
});
