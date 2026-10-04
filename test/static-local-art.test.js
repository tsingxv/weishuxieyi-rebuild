// The optional local-client art manifest (data/local-assets.json, DESIGN §13): an install without it must get an
// empty manifest (200) instead of a 404, and an install with it must get the real file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../server/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function serve(dataDir) {
  const handler = createStaticHandler({ publicDir: path.join(ROOT, 'public'), dataDir, sharedDir: path.join(ROOT, 'shared') });
  const srv = http.createServer((req, res) => {
    const [p, q] = req.url.split('?');
    handler(req, res, p, q || '');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function get(srv, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: url, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('missing data/local-assets.json → 200 empty manifest (no 404 on installs without local art)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-noart-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  const srv = await serve(dir);
  try {
    const r = await get(srv, '/data/local-assets.json');
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/json/);
    const doc = JSON.parse(r.body);
    assert.deepEqual(doc.groups, {});
    const h = await get(srv, '/data/local-assets.json', 'HEAD');
    assert.equal(h.status, 200);
    assert.equal(h.body, '');
    // other missing data files still 404
    assert.equal((await get(srv, '/data/nope.json')).status, 404);
    assert.equal((await get(srv, '/data/sub/local-assets.json')).status, 404);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('present data/local-assets.json is served as-is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-art-'));
  const doc = { version: 1, source: 'local-client', count: 1, groups: { module: { 'mar-x': { path: '/assets/local/module/mar-x.png' } } } };
  fs.writeFileSync(path.join(dir, 'local-assets.json'), JSON.stringify(doc));
  const srv = await serve(dir);
  try {
    const r = await get(srv, '/data/local-assets.json');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), doc);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
