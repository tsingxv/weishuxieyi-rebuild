// Invite recognition + clipboard reading (public/js/ui/clipboard.js).
//
// The module is pure at import time, so it can be exercised in plain Node; the clipboard only exists
// when we stub it, which is exactly the situation on a plain-http LAN game (no secure context).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const mod = (rel) => import(pathToFileURL(path.join(ROOT, 'public', 'js', rel)).href);

const { parseInvite, readClipboardText, shouldCheckClipboard, CLIPBOARD_TIMEOUT_MS } =
  await mod('ui/clipboard.js');

// ---- browser-global stubs ------------------------------------------------------------------------

const NAV_DESC = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const SECURE_DESC = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');

/** Install a `navigator` (Node's own is a getter-only accessor). */
function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function restoreGlobal(name, desc) {
  if (desc) Object.defineProperty(globalThis, name, desc);
  else delete globalThis[name];
}

afterEach(() => {
  restoreGlobal('navigator', NAV_DESC);
  restoreGlobal('isSecureContext', SECURE_DESC);
});

// ---- parseInvite ---------------------------------------------------------------------------------

describe('parseInvite', () => {
  test('accepts a bare code and uppercases it', () => {
    assert.deepEqual(parseInvite('ab12'), { code: 'AB12', url: null });
    assert.deepEqual(parseInvite('Q7Y2'), { code: 'Q7Y2', url: null });
    assert.deepEqual(parseInvite('abcd'), { code: 'ABCD', url: null });
    assert.deepEqual(parseInvite('ABCDEF'), { code: 'ABCDEF', url: null });
  });

  test('tolerates surrounding whitespace', () => {
    assert.deepEqual(parseInvite('  q7y2 \n'), { code: 'Q7Y2', url: null });
  });

  test('reads ?room= fragments', () => {
    assert.deepEqual(parseInvite('?room=AB12'), { code: 'AB12', url: null });
    assert.deepEqual(parseInvite('&room=ab12'), { code: 'AB12', url: null });
    // a fragment pasted without its '?' still names a room
    assert.deepEqual(parseInvite('room=ab12'), { code: 'AB12', url: null });
    assert.deepEqual(parseInvite('https://h/?room=ab12&x=1'), { code: 'AB12', url: 'https://h/?room=ab12&x=1' });
  });

  test('returns the full url for an http(s) invite so the caller can also open it', () => {
    const url = 'http://192.168.1.9:8443/?room=K7M2';
    assert.deepEqual(parseInvite(url), { code: 'K7M2', url });
    const secure = 'https://host:8443/path?room=k7m2&from=friend';
    assert.deepEqual(parseInvite(secure), { code: 'K7M2', url: secure });
    // the url is returned verbatim, not uppercased
    assert.equal(parseInvite(secure).url, secure);
  });

  test('rejects anything without a usable code', () => {
    for (const bad of [
      '', '   ', 'abc', 'abcdefg', 'ab 12', 'a1!2', '?room=AB', '?room=ABCDEFG', '/room=AB12',
      'https://host/no-param', 'not a room code', '?ROOM=AB12', '中文码', 'abcd-ef', 'xroom=AB12',
    ]) {
      assert.equal(parseInvite(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
    // a 5th/6th character is part of the code, not trailing junk
    assert.deepEqual(parseInvite('room=AB12x'), { code: 'AB12X', url: null });
  });

  test('rejects non-strings instead of throwing', () => {
    for (const bad of [null, undefined, 42, {}, [], true, Symbol('x'), () => {}]) {
      assert.equal(parseInvite(bad), null);
    }
  });

  test('handles a 4000-character paste quickly', () => {
    const junk = `${'x'.repeat(2000)}?room=AB12&${'y'.repeat(1989)}`;
    assert.equal(junk.length, 4000);
    const started = Date.now();
    assert.deepEqual(parseInvite(junk), { code: 'AB12', url: null });
    assert.equal(parseInvite('z'.repeat(4000)), null);
    assert.equal(parseInvite(`?room=${'a'.repeat(4000)}`), null);
    assert.ok(Date.now() - started < 1000, 'a long paste must not be slow');
  });
});

// ---- readClipboardText ---------------------------------------------------------------------------

describe('readClipboardText', () => {
  test('resolves null when the API is missing (plain-http LAN game)', async () => {
    setNavigator({});
    globalThis.isSecureContext = true;
    assert.equal(await readClipboardText(), null);
  });

  test('resolves null outside a secure context and never touches the clipboard', async () => {
    let called = 0;
    setNavigator({ clipboard: { readText: () => { called += 1; return Promise.resolve('AB12'); } } });
    globalThis.isSecureContext = false;
    assert.equal(shouldCheckClipboard(), false);
    assert.equal(await readClipboardText(), null);
    assert.equal(called, 0, 'an insecure context must not query the clipboard');
  });

  test('resolves the clipboard text when everything is available', async () => {
    setNavigator({ clipboard: { readText: () => Promise.resolve('  http://h/?room=ab12 ') } });
    globalThis.isSecureContext = true;
    assert.equal(shouldCheckClipboard(), true);
    assert.equal(await readClipboardText(), '  http://h/?room=ab12 ');
  });

  test('resolves null for empty or non-string clipboard contents', async () => {
    globalThis.isSecureContext = true;
    for (const value of ['', null, undefined, 42, {}]) {
      setNavigator({ clipboard: { readText: () => Promise.resolve(value) } });
      assert.equal(await readClipboardText(), null);
    }
  });

  test('resolves null when the read rejects or throws synchronously', async () => {
    globalThis.isSecureContext = true;
    setNavigator({ clipboard: { readText: () => Promise.reject(new Error('denied')) } });
    assert.equal(await readClipboardText(), null);
    setNavigator({ clipboard: { readText: () => { throw new Error('blocked'); } } });
    assert.equal(await readClipboardText(), null);
  });

  test('gives up instead of hanging on a read that never settles', async () => {
    globalThis.isSecureContext = true;
    setNavigator({ clipboard: { readText: () => new Promise(() => {}) } });
    const started = Date.now();
    assert.equal(await readClipboardText(), null);
    const waited = Date.now() - started;
    assert.ok(waited < CLIPBOARD_TIMEOUT_MS + 2000, `must not hang (waited ${waited}ms)`);
  });

  test('survives a hostile navigator getter', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      get() { throw new Error('nope'); },
    });
    assert.equal(shouldCheckClipboard(), false);
    assert.equal(await readClipboardText(), null);
  });
});
