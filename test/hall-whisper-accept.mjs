// Acceptance: 私聊 end-to-end through a REAL running server — deleted after use.
// A and B are two independent browser-like clients; C is a bystander who must see nothing.
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { StubMatch } from '../server/match/StubMatch.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, publicDir: path.join(R, 'public') });
const url = `ws://127.0.0.1:${srv.port}/ws`;

const a = await TestClient.connect(url);
const b = await TestClient.connect(url);
const c = await TestClient.connect(url);
const wa = await a.hello('阿米娅');
const wb = await b.hello('凯尔希');
await c.hello('博士C');
console.log('  三个客户端已连接:', wa.playerId, wb.playerId);

// A 私聊 B
const atB = b.waitFor('hall.whisper', () => true, 3000);
const atA = a.waitFor('hall.whisper', () => true, 3000);
assert.equal((await a.request({ t: 'hall.whisper', to: wb.playerId, text: '晚上一起打终极吗？' })).t, 'ok');
const fb = await atB;
const fa = await atA;
console.log('  B 收到:', JSON.stringify(fb.line.text), '来自', fb.line.fromName);
assert.equal(fb.line.text, '晚上一起打终极吗？');
assert.equal(fa.line.text, fb.line.text, 'A 也收到自己的回显');

// B 回复 A
const atA2 = a.waitFor('hall.whisper', (m) => m.line.fromId === wb.playerId, 3000);
assert.equal((await b.request({ t: 'hall.whisper', to: wa.playerId, text: '好啊，8 点见' })).t, 'ok');
console.log('  A 收到回复:', (await atA2).line.text);

// C 什么都收不到（连公共频道也没有）
await c.expectNone('hall.whisper', () => true, 400);
await c.expectNone('hall.chat', () => true, 200);

// B 离开后，A 再发 → 服务器拒绝（对方不在线）
await b.close();
await new Promise((r) => setTimeout(r, 300));
const gone = await a.request({ t: 'hall.whisper', to: wb.playerId, text: '还在吗' });
assert.equal(gone.t, 'error');
console.log('  B 离开后 A 再发 → 被拒绝:', gone.detail || gone.code);

// 服务器没有留下任何私聊痕迹
const snap = srv.lobby.hall.snapshot();
assert.deepEqual(snap.chat, [], '公共频道没有被污染');
console.log('  服务器公共频道干净，未留存私聊');

await a.close(); await c.close();
await srv.close();
console.log('  ✓ 私聊端到端验收通过');
process.exit(0);
