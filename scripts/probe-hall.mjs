// Acceptance probe: drive the 大厅 protocol against a RUNNING packaged server exe.
//
// This is deliberately an out-of-process client (a plain `ws` socket, exactly what a browser uses), so
// it proves the shipped binary — not the repository source — speaks the hall protocol: a snapshot on
// `hall.enter`, chat delivered between two players, and a room code learned through the roster
// (which is what "大厅里分享房间码" means in practice).
//
// Usage: node <this> <port>     (expects the server exe already listening on 127.0.0.1:<port>)

import WebSocket from 'ws';

const port = Number(process.argv[2] || 0);
if (!Number.isInteger(port) || port <= 0) {
  console.error('usage: node hall-e2e-probe.mjs <port>');
  process.exit(2);
}
const URL = `ws://127.0.0.1:${port}/ws`;

/** Connect, say hello and enter the hall; resolves with the client + its hall.state snapshot. */
function openHall(name) {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(URL);
    const seen = [];
    const timer = setTimeout(() => reject(new Error(`timeout for ${name} (saw ${seen.join(',')})`)), 10000);
    w.on('open', () => w.send(JSON.stringify({ t: 'hello', rid: 1, name, version: 1 })));
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
    w.on('message', (d) => {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      seen.push(m.t);
      if (m.t === 'welcome') w.send(JSON.stringify({ t: 'hall.enter', rid: 2 }));
      if (m.t === 'hall.state') {
        clearTimeout(timer);
        resolve({ w, seen, state: m });
      }
    });
  });
}

/** Resolve with the first frame of `type` matching `pred`, or reject after `ms`. */
function next(w, type, pred = () => true, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { w.off('message', onMsg); reject(new Error(`no ${type} within ${ms}ms`)); }, ms);
    function onMsg(d) {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      if (m.t === type && pred(m)) {
        clearTimeout(timer);
        w.off('message', onMsg);
        resolve(m);
      }
    }
    w.on('message', onMsg);
  });
}

const fail = (msg) => { console.error(`  FAIL: ${msg}`); process.exit(1); };

try {
  const a = await openHall('甲博士');
  const b = await openHall('乙博士');
  console.log(`  A hall.state: roster=${a.state.roster.map((x) => x.name).join('/')} rooms=${a.state.roomsTotal}`);

  // A chats; B must receive it (the whole point of a shared hall channel)
  const chatP = next(b.w, 'hall.chat');
  a.w.send(JSON.stringify({ t: 'hall.chat', rid: 9, text: '客户端联调：大家好' }));
  const line = await chatP;
  if (line.line.name !== '甲博士') fail(`chat author was ${line.line.name}`);
  console.log(`  chat delivered to B: "${line.line.text}" from ${line.line.name}`);

  // A opens a room; B learns the code from the hall roster (share-a-code path)
  const rosterP = next(b.w, 'hall.roster', (m) => Array.isArray(m.rooms) && m.rooms.length > 0);
  a.w.send(JSON.stringify({ t: 'room.create', rid: 10, mode: 'coop', difficulty: 'NORMAL' }));
  const roster = await rosterP;
  const room = roster.rooms[0];
  if (room.hostName !== '甲博士') fail(`room host was ${room.hostName}`);
  console.log(`  B learned A's room through the hall: ${room.code} host=${room.hostName} humans=${room.humans}/${room.seats} mode=${room.mode}`);

  // the roster also tags who is where
  const rowA = roster.roster.find((r) => r.name === '甲博士');
  if (!rowA || rowA.roomCode !== room.code) fail(`roster did not place A in ${room.code}`);
  console.log(`  roster places 甲博士 in ${rowA.roomCode} (inMatch=${rowA.inMatch})`);

  a.w.close();
  b.w.close();
  console.log('  RESULT: the packaged server speaks the hall protocol end-to-end');
  process.exit(0);
} catch (e) {
  fail(e.message);
}
