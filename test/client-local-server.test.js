// Desktop client (client/): address parsing, the settings file, and the loopback server that serves the
// bundled payload while tunnelling the renderer's `/ws` to the host the player configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createLocalServer } from '../client/localServer.js';
import { addressError, parseServerAddress, sameAddress } from '../client/serverAddress.js';
import { DEFAULT_LOCAL_PORT, normalizeConfig, readConfig, rememberServer, writeConfig } from '../client/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------------------------------------
// Addresses
// ------------------------------------------------------------------------------------------------

test('parseServerAddress: bare host, host:port, scheme, path and IPv6', () => {
  const bare = parseServerAddress('192.168.1.2');
  assert.equal(bare.base, 'http://192.168.1.2:3000');
  assert.equal(bare.ws, 'ws://192.168.1.2:3000/ws');
  assert.equal(bare.health, 'http://192.168.1.2:3000/healthz');
  assert.equal(bare.label, '192.168.1.2:3000');

  assert.equal(parseServerAddress('26.100.222.17:3000').ws, 'ws://26.100.222.17:3000/ws');
  assert.equal(parseServerAddress('http://192.168.1.2:3001/').ws, 'ws://192.168.1.2:3001/ws');
  // a path/trailing junk is ignored: the game is only served from the root
  assert.equal(parseServerAddress('http://box.local:3000/index.html?x=1').base, 'http://box.local:3000');
  // a bare host means the game's own default port; a written-out scheme means the scheme's default
  assert.equal(parseServerAddress('game.example.com').base, 'http://game.example.com:3000');
  assert.equal(parseServerAddress('http://game.example.com').base, 'http://game.example.com:80');
  const tls = parseServerAddress('https://game.example.com');
  assert.equal(tls.base, 'https://game.example.com:443');
  assert.equal(tls.ws, 'wss://game.example.com:443/ws');
  assert.equal(parseServerAddress('wss://game.example.com/ws').base, 'https://game.example.com:443');
  assert.equal(parseServerAddress('ws://192.168.1.2:3000/ws').ws, 'ws://192.168.1.2:3000/ws');
  assert.equal(parseServerAddress('[::1]:3000').base, 'http://[::1]:3000');
  assert.equal(parseServerAddress('  192.168.1.2:3000  ').port, 3000);
});

test('parseServerAddress: rejects what cannot address a host', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, 'http://', 'ftp://x', 'http://host:0', 'http://host:99999',
    'http://a b:3000', 'has space:3000', `http://${'x'.repeat(400)}:3000`]) {
    assert.equal(parseServerAddress(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  assert.match(addressError('') ?? '', /填写/);
  assert.match(addressError('ftp://x') ?? '', /http/);
  assert.equal(addressError('192.168.1.2:3000'), null);
});

test('sameAddress compares origins, not text', () => {
  assert.ok(sameAddress('192.168.1.2', 'http://192.168.1.2:3000/'));
  assert.ok(!sameAddress('192.168.1.2:3000', '192.168.1.2:3001'));
  assert.ok(sameAddress('', null));
});

// ------------------------------------------------------------------------------------------------
// Settings file
// ------------------------------------------------------------------------------------------------

test('normalizeConfig survives corrupt input and clamps fields', () => {
  const d = normalizeConfig(null);
  assert.equal(d.server, '');
  assert.equal(d.localPort, DEFAULT_LOCAL_PORT);
  assert.deepEqual(d.recent, []);
  const weird = normalizeConfig({ server: 'not a host', localPort: 10, recent: ['192.168.1.2', 'not a host', '192.168.1.2:3000'], window: { width: 1, height: 'x' } });
  assert.equal(weird.server, '', 'an unusable saved address is dropped, not trusted');
  assert.equal(weird.localPort, 1024);
  assert.deepEqual(weird.recent, ['192.168.1.2'], 'duplicates by origin are collapsed, junk dropped');
  assert.equal(weird.window.width, 900);
  assert.equal(weird.window.height, 860);
});

test('readConfig/writeConfig round-trip; a broken file falls back to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-client-cfg-'));
  const file = path.join(dir, 'client-config.json');
  try {
    assert.equal(readConfig(file).server, '');
    const written = writeConfig(file, rememberServer(readConfig(file), '26.100.222.17:3000'));
    assert.equal(written.server, '26.100.222.17:3000');
    assert.deepEqual(readConfig(file).recent, ['26.100.222.17:3000']);
    const again = rememberServer(readConfig(file), '192.168.1.2:3000');
    assert.deepEqual(again.recent, ['192.168.1.2:3000', '26.100.222.17:3000']);
    assert.equal(again.server, '192.168.1.2:3000');
    fs.writeFileSync(file, '{ not json');
    assert.equal(readConfig(file).server, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------
// Loopback server
// ------------------------------------------------------------------------------------------------

function request(port, url, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withLocalServer(fn) {
  const local = createLocalServer({
    publicDir: path.join(ROOT, 'public'),
    dataDir: path.join(ROOT, 'data'),
    sharedDir: path.join(ROOT, 'shared'),
    simDir: path.join(ROOT, 'server', 'sim'),
    log: () => {},
  });
  const port = await local.listen(0);
  try { return await fn(local, port); } finally { await local.close(); }
}

test('loopback server serves the game payload with the server\u2019s own handler', async () => {
  await withLocalServer(async (_local, port) => {
    const index = await request(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.body, /STRONGHOLD PROTOCOL/);

    // root-relative asset URLs the game needs offline
    assert.equal((await request(port, '/js/main.js')).status, 200);
    // public/fonts comes with the downloaded (gitignored) assets: absent on a fresh clone → 404
    const fontsCss = path.join(ROOT, 'public', 'fonts', 'fonts.css');
    assert.equal((await request(port, '/fonts/fonts.css')).status, fs.existsSync(fontsCss) ? 200 : 404, 'present → served, absent (fresh clone) → 404');
    assert.match((await request(port, '/data/config.json')).headers['content-type'], /application\/json/);

    // the browser stand-in for server/data.js, and the simulation as ES modules only
    const shim = await request(port, '/data.js');
    assert.equal(shim.status, 200);
    assert.match(shim.body, /getSimData/);
    assert.equal((await request(port, '/sim/spec.js')).status, 200);
    assert.equal((await request(port, '/sim/nodeData.js')).status, 404, 'the Node-only loader is never served');
    assert.equal((await request(port, '/sim/NODEDATA.JS')).status, 404);
    assert.equal((await request(port, '/sim/constants.json')).status, 404);

    // no source, no directory listings, no other methods
    assert.equal((await request(port, '/server/index.js')).status, 404);
    assert.equal((await request(port, '/../package.json')).status, 403, 'traversal is refused');
    assert.equal((await request(port, '/', { method: 'POST' })).status, 405);
    // requests carrying a foreign Host are refused (DNS rebinding)
    assert.equal((await request(port, '/', { host: 'evil.example.com' })).status, 403);
  });
});

function wsEcho() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ t: 'welcome', path: req.url }));
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  return new Promise((resolve) => wss.once('listening', () => resolve({ wss, port: wss.address().port })));
}

function open(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.on('message', (data) => {
    const text = data.toString();
    const w = waiters.shift();
    if (w) w(text); else messages.push(text);
  });
  return {
    ws,
    next: () => new Promise((resolve, reject) => {
      if (messages.length) { resolve(messages.shift()); return; }
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 4000);
      waiters.push((text) => { clearTimeout(timer); resolve(text); });
    }),
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve); ws.once('error', reject);
      ws.once('close', (code) => reject(new Error(`closed ${code}`)));
    }),
  };
}

test('the /ws tunnel relays both directions and forwards the host close code', async () => {
  const { wss, port: upstreamPort } = await wsEcho();
  try {
    await withLocalServer(async (local, port) => {
      local.setTarget(`ws://127.0.0.1:${upstreamPort}/ws`);
      const c = open(`ws://127.0.0.1:${port}/ws`);
      await c.open();
      assert.match(await c.next(), /"t":"welcome"/, 'the host greeting is not lost while the upgrade is in flight');
      c.ws.send('ping');
      assert.equal(await c.next(), 'ping');
      const closed = new Promise((resolve) => c.ws.once('close', (code) => resolve(code)));
      for (const peer of wss.clients) peer.close(4001, 'room full');
      assert.equal(await closed, 4001, 'the host close code reaches the renderer unchanged');
    });
  } finally {
    wss.close();
  }
});

test('the /ws tunnel refuses to connect when no host is configured', async () => {
  await withLocalServer(async (_local, port) => {
    const c = open(`ws://127.0.0.1:${port}/ws`);
    await assert.rejects(c.open(), /closed|error/i);
  });
});

test('the /ws tunnel reports a dead host as a failed connection', async () => {
  await withLocalServer(async (local, port) => {
    // port 1 on loopback: nothing is listening there
    local.setTarget('ws://127.0.0.1:1/ws');
    const c = open(`ws://127.0.0.1:${port}/ws`);
    await assert.rejects(c.open(), /closed|error/i);
  });
});

test('setTarget drops live tunnels so a new host address takes effect at once', async () => {
  const { wss, port: upstreamPort } = await wsEcho();
  try {
    await withLocalServer(async (local, port) => {
      local.setTarget(`ws://127.0.0.1:${upstreamPort}/ws`);
      const c = open(`ws://127.0.0.1:${port}/ws`);
      await c.open();
      const closed = new Promise((resolve) => c.ws.once('close', () => resolve(true)));
      local.setTarget(`ws://127.0.0.1:${upstreamPort}/ws`);
      assert.equal(await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 300))]), false, 'an unchanged target keeps the tunnel');
      local.setTarget(null);
      assert.equal(await closed, true);
    });
  } finally {
    wss.close();
  }
});
