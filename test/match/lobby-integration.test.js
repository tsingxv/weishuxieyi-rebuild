// The real Match behind the real platform (HTTP/WS server + lobby): a solo and a co-op match driven over sockets.
// Phase timers are scaled down (timerScale) and battles use FakeBattle so the test runs in real time quickly.
// Combat is client-side (DESIGN §14): each socket client simulates its b.start specs (test/match/simClient.js) and
// reports b.progress / b.result through the platform (server/net.js routes b.* to the match). The last test runs the
// server-run fallback (SP_COMBAT=server) that still streams b.snap.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { Match } from '../../server/match/Match.js';
import { TestClient } from '../helpers/wsClient.js';
import { FakeBattle } from './fakeBattle.js';
import { attachWsSimClient } from './simClient.js';
import { EMOTES } from '../../shared/constants.js';

let serverCombat = false;
class FastMatch extends Match {
  constructor(o) { super({ ...o, timerScale: 0.02, BattleClass: FakeBattle, clientCombat: !serverCombat }); }
}

const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };
const errors = [];
let srv = null;
const clients = [];

async function server() {
  if (!srv) srv = await startServer({ port: 0, host: '127.0.0.1', log, MatchClass: FastMatch });
  return srv;
}
async function player(name, token) {
  const s = await server();
  const c = await TestClient.connect(`ws://127.0.0.1:${s.port}/ws`);
  clients.push(c);
  const w = await c.hello(name, token);
  c.id = w.playerId;
  c.token = w.token;
  c.sim = attachWsSimClient(c, { BattleClass: FakeBattle, pace: 'instant' });
  return c;
}
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  if (srv) await srv.close();
});

test('solo over websockets: briefing → band → prep → buy/place/ready → combat → settle → round 2 → leave', async () => {
  FakeBattle.reset();
  FakeBattle.script = () => ({ duration: 1 });
  const c = await player('Solo');
  await ok(c, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
  await c.waitFor('room.state');
  await ok(c, { t: 'room.start' });
  const pub = await c.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
  assert.equal(pub.modeId, 'mode_single_funny');
  assert.equal(pub.lastRound, 9);
  await ok(c, { t: 'g.infoReady' });
  await c.waitFor('m.public', (p) => p.phase === 'BAND_DRAFT');
  await ok(c, { t: 'g.band', bandId: 'band_sarkazb' });
  const prep = await c.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 1, 10000);
  assert.equal(prep.players[0].lp, 45);
  const priv = await c.waitFor('m.private', (p) => p.funds === 4 && p.shop.slots.length > 0);
  const slot = priv.shop.slots.findIndex((s) => s && s.kind === 'chess' && s.price <= 4);
  await ok(c, { t: 'g.buy', slot });
  const after1 = await c.waitFor('m.private', (p) => p.hand.some(Boolean));
  const piece = after1.hand.find(Boolean);
  // wrong-phase / bad intents come back as errors with codes
  const bad = await c.request({ t: 'g.choice', idx: 0 });
  assert.equal(bad.t, 'error');
  assert.equal(bad.code, 'WRONG_PHASE');
  const tile = [[9, 3], [9, 4], [10, 3], [12, 5]].find(() => true);
  const mv = await c.request({ t: 'g.move', uid: piece.uid, to: { area: 'board', row: tile[0], col: tile[1] } });
  assert.ok(mv.t === 'ok' || (mv.t === 'error' && mv.code === 'BAD_TILE'));
  await ok(c, { t: 'g.ready', ready: true });
  // (the client answers at once: the COMBAT phase may be shorter than the m.public throttle window)
  const start = await c.waitFor('b.start', (x) => x.authoritative, 10000);
  assert.equal(start.fieldId, `n:${c.id}`);
  assert.equal(start.spec.kind, 'normal');
  await c.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 2, 15000);
  assert.ok(c.sim.log.some((x) => x.t === 'b.result' && x.battleId === start.battleId), 'the client reported its battle');
  assert.equal(c.log.filter((x) => x.t === 'b.snap' || x.t === 'b.ev').length, 0, 'no combat streaming');
  // (reports carry no rid: an error answering one would arrive without a rid)
  assert.equal(c.log.filter((x) => x.t === 'error' && x.rid == null).length, 0, 'every report was accepted without error');
  await ok(c, { t: 'g.emote', id: EMOTES[0] });
  await c.waitFor('m.emote');
  // leaving the only human seat ends the match; the room returns to its lobby life cycle
  await ok(c, { t: 'g.leave' });
  assert.deepEqual(errors, []);
});

test('co-op over websockets: two humans + AI, reconnect with the token mid-match resyncs the state', async () => {
  FakeBattle.reset();
  FakeBattle.script = () => ({ duration: 1 });
  const a = await player('A');
  const b = await player('B');
  await ok(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const st = await a.waitFor('room.state');
  await ok(b, { t: 'room.join', code: st.code });
  await ok(a, { t: 'room.addBot' });
  await ok(b, { t: 'room.ready', ready: true });
  await ok(a, { t: 'room.start' });
  for (const c of [a, b]) await c.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
  await ok(a, { t: 'g.infoReady' });
  await ok(b, { t: 'g.infoReady' });
  const draft = await a.waitFor('m.public', (p) => p.phase === 'BAND_DRAFT' && p.draft);
  assert.equal(draft.draft.order.length, 3);
  // humans pick when it is their turn (bots pick themselves)
  for (let i = 0; i < 20; i++) {
    const p = await a.waitFor('m.public', (x) => x.phase !== 'BAND_DRAFT' || [a.id, b.id].includes(x.draft && x.draft.turn), 10000);
    if (p.phase !== 'BAND_DRAFT') break;
    const who = p.draft.turn === a.id ? a : b;
    await who.request({ t: 'g.band', bandId: 'band_bldsk' });
  }
  await a.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 1, 10000);
  // B drops and comes back with its token
  await b.terminate();
  const b2 = await player('B', b.token);
  const pub = await b2.waitFor('m.public', (p) => p.phase === 'PREP');
  assert.equal(pub.players.find((p) => p.playerId === b2.id).connected, true);
  const priv = await b2.waitFor('m.private');
  assert.equal(priv.playerId, b2.id);
  await ok(a, { t: 'g.ready', ready: true });
  await ok(b2, { t: 'g.ready', ready: true });
  await a.waitFor('m.public', (p) => p.phase === 'COMBAT', 10000);
  await a.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 2, 15000);
  await ok(a, { t: 'g.leave' });
  await ok(b2, { t: 'g.leave' });
  assert.deepEqual(errors, []);
});

test('server-run fallback (SP_COMBAT=server): the match simulates every field and streams m.field + b.snap', async () => {
  FakeBattle.reset();
  FakeBattle.script = () => ({ duration: 1 });
  serverCombat = true;
  try {
    const c = await player('Legacy');
    await ok(c, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
    await c.waitFor('room.state');
    await ok(c, { t: 'room.start' });
    await c.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    await ok(c, { t: 'g.infoReady' });
    await c.waitFor('m.public', (p) => p.phase === 'BAND_DRAFT');
    await ok(c, { t: 'g.band', bandId: 'band_sarkazb' });
    await c.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 1, 10000);
    await ok(c, { t: 'g.ready', ready: true });
    await c.waitFor('m.field', () => true, 10000);
    await c.waitFor('b.snap', (s) => typeof s.gt === 'number', 10000);
    await c.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 2, 15000);
    assert.equal(c.log.filter((x) => x.t === 'b.start').length, 0);
    await ok(c, { t: 'g.leave' });
    assert.deepEqual(errors, []);
  } finally {
    serverCombat = false;
  }
});
