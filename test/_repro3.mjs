// one-off repro #3: exact trace of the failing test sequence — deleted after use
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { StubMatch } from '../server/match/StubMatch.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, publicDir: path.join(R, 'public') });
const url = `ws://127.0.0.1:${srv.port}/ws`;
const enter = async (c, label) => {
  const reply = await c.request({ t: 'hall.enter' });
  console.log(`  ${label} enter reply: ${reply.t}`);
  const st = await c.waitFor('hall.state', () => true, 3000).catch((e) => { console.log(`  ${label} state TIMEOUT`); return null; });
  console.log(`  ${label} state: ${st ? 'ok' : 'MISSING'}`);
  return st;
};

const a = await TestClient.connect(url);
const b = await TestClient.connect(url);
const wa = await a.hello('A');
await b.hello('B');
console.log('A id =', wa.playerId);

console.log('--- enter A ---'); await enter(a, 'A');
console.log('--- enter B ---'); await enter(b, 'B');

console.log('--- whisper A->B ---');
const wr = await a.request({ t: 'hall.whisper', to: b.id, text: '私密' });
console.log('  whisper reply:', JSON.stringify(wr));
const got = await b.waitFor('hall.whisper', () => true, 3000).catch((e) => { console.log('  B whisper TIMEOUT'); return null; });
console.log('  B got:', got ? got.line.text : 'MISSING');

console.log('--- clear inboxes ---');
console.log('  A inbox before clear:', a.inbox.map((m) => m.t).join(','));
a.clearInbox(); b.clearInbox();
console.log('  A session.connected (server) =', srv.registry.byId(wa.playerId)?.connected);

console.log('--- connect C ---');
const c = await TestClient.connect(url);
await c.hello('C');
const csnap = await c.waitFor('hall.state', () => true, 3000).catch(() => null);
console.log('  C state:', csnap ? `ok chat=${csnap.chat.length}` : 'TIMEOUT');

console.log('--- leave A ---');
const l = await a.request({ t: 'hall.leave' });
console.log('  leave reply:', JSON.stringify(l));
console.log('  members:', srv.lobby.hall.members.size, '| A connected:', srv.registry.byId(wa.playerId)?.connected);
a.clearInbox();

console.log('--- re-enter A ---');
const e2 = await a.request({ t: 'hall.enter' });
console.log('  enter reply:', JSON.stringify(e2));
console.log('  members:', srv.lobby.hall.members.size, '| A connected:', srv.registry.byId(wa.playerId)?.connected);
console.log('  A inbox immediately:', a.inbox.map((m) => m.t).join(','));
const s2 = await a.waitFor('hall.state', () => true, 2500).catch((e) => { console.log('  state TIMEOUT'); return null; });
console.log('  state#2:', s2 ? `ok chat=${s2.chat.length} leaked=${s2.chat.some((x) => x.text === '私密')}` : 'MISSING');
console.log('  A log tail:', a.log.slice(-10).map((m) => m.t).join(','));

await a.close(); await b.close(); await c.close();
await srv.close();
process.exit(0);
