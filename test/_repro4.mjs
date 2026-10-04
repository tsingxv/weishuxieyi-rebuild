// one-off repro #4: does a THIRD client's hall.enter deliver hall.state? (deleted after use)
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { StubMatch } from '../server/match/StubMatch.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, publicDir: path.join(R, 'public') });
const url = `ws://127.0.0.1:${srv.port}/ws`;

const mk = async (n) => {
  const c = await TestClient.connect(url);
  const w = await c.hello(n);
  c.id = w.playerId;
  console.log(`  ${n} connected, id=${c.id}`);
  return c;
};

const clients = [];
for (const n of ['A', 'B']) {
  const c = await mk(n);
  clients.push(c);
  const reply = await c.request({ t: 'hall.enter' }).catch((e) => ({ t: 'EXC:' + e.message }));
  console.log(`  ${n} hall.enter -> ${JSON.stringify(reply)}`);
  const st = await c.waitFor('hall.state', () => true, 2000).catch((e) => { console.log(`  ${n} state TIMEOUT (log tail: ${c.log.slice(-6).map((m) => m.t).join(',')})`); return null; });
  console.log(`  ${n} state: ${st ? 'ok' : 'MISSING'}`);
}

// the failing test does exactly this: whisper, then a THIRD client enters
const wr = await clients[0].request({ t: 'hall.whisper', to: clients[1].id, text: '私密' });
console.log('  whisper ->', JSON.stringify(wr));
const got = await clients[1].waitFor('hall.whisper', () => true, 2000).catch(() => null);
console.log('  B got whisper:', got ? got.line.text : 'TIMEOUT');
clients[0].clearInbox(); clients[1].clearInbox();

for (const n of ['C', 'D']) {
  const c = await mk(n);
  clients.push(c);
  const reply = await c.request({ t: 'hall.enter' }).catch((e) => ({ t: 'EXC:' + e.message }));
  console.log(`  ${n} hall.enter -> ${JSON.stringify(reply)}`);
  const st = await c.waitFor('hall.state', () => true, 2500).catch((e) => { console.log(`  ${n} state TIMEOUT (log tail: ${c.log.slice(-6).map((m) => m.t).join(',')})`); return null; });
  console.log(`  ${n} state: ${st ? 'ok' : 'MISSING'}`);
}

console.log('  members:', srv.lobby.hall.members.size);
for (const c of clients) await c.close();
await srv.close();
process.exit(0);
