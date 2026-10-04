// Permanent local match history (public/js/ui/history.js).
//
// The module reads and writes `globalThis.localStorage` through `store.js` loadPref/savePref for the
// profile tag, so a small in-memory stub is installed before it is imported — the same pattern as
// test/ui/emotes.test.js. Everything here must survive a missing, full or corrupt storage.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Minimal localStorage stand-in; `fail` makes writes throw (private mode / quota). */
function makeStorage() {
  const map = new Map();
  const api = {
    fail: false,
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) {
      if (api.fail) throw new Error('QuotaExceededError');
      map.set(String(k), String(v));
    },
    removeItem(k) { map.delete(String(k)); },
    raw(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    size() { return map.size; },
    clear() { map.clear(); },
  };
  return api;
}

globalThis.localStorage = makeStorage();
const HIST_KEY = 'sp.history.v1';
const PROFILE_KEY = 'sp.pref.profile';

const { loadHistory, recordResult, clearHistory, summarize, titleNameOf, HISTORY_KEEP, HISTORY_MAX_CHARS } =
  await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'ui', 'history.js')).href);

/**
 * A result payload shaped like an `m.result` push. `victory` / `roundsPassed` / `titleName` are
 * propagated to my own seat (p1) as well, because the server describes each player individually and
 * the module trusts my own seat over the match-level values.
 */
function result(over = {}) {
  const { titleName = '铁壁', players, ...rest } = over;
  const victory = rest.victory !== undefined ? rest.victory : true;
  const roundsPassed = rest.roundsPassed !== undefined ? rest.roundsPassed : 12;
  return {
    t: 'm.result',
    hiddenReached: false,
    hiddenCleared: false,
    modeId: 'mode_multi_hard',
    difficulty: 'HARD',
    durationMs: 52 * 60000,
    ...rest,
    victory,
    roundsPassed,
    players: players !== undefined ? players : [
      { playerId: 'p1', seat: 0, name: '指挥官', isBot: false, victory, roundsPassed, title: titleName ? { id: 't1', name: titleName } : null },
      { playerId: 'p2', seat: 1, name: '机器人', isBot: true, victory, roundsPassed, title: null },
    ],
  };
}

beforeEach(() => {
  clearHistory();
  globalThis.localStorage.clear();
  globalThis.localStorage.fail = false;
});

describe('loadHistory', () => {
  test('an empty slot reads as an empty list', () => {
    assert.deepEqual(loadHistory(), []);
  });

  test('a corrupt slot degrades to empty instead of throwing', () => {
    for (const junk of ['{not json', '{"a":1}', 'null', '"str"', '42', '[[[', '\u0000']) {
      globalThis.localStorage.setItem(HIST_KEY, junk);
      assert.deepEqual(loadHistory(), [], `expected [] for ${JSON.stringify(junk)}`);
    }
  });

  test('drops unusable entries but keeps the good ones', () => {
    globalThis.localStorage.setItem(HIST_KEY, JSON.stringify([
      null, 42, 'x', [], { at: 5 }, { at: 1, victory: true, roundsPassed: 3, players: [] },
    ]));
    const list = loadHistory();
    assert.equal(list.length, 1);
    assert.equal(list[0].victory, true);
    assert.equal(list[0].roundsPassed, 3);
  });

  test('normalizes a stored entry into the compact shape', () => {
    globalThis.localStorage.setItem(HIST_KEY, JSON.stringify([{
      at: 1700, victory: true, roundsPassed: 9, durationMs: 60000, difficulty: 'HARD', modeId: 'm1',
      hiddenCleared: true, profileId: 'me',
      players: [{ name: '甲', isBot: false, victory: true, roundsPassed: 9, title: { id: 'x', name: '铁壁' }, extra: 'dropped' }],
    }]));
    const [entry] = loadHistory();
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'difficulty', 'durationMs', 'hiddenCleared', 'modeId', 'players', 'profileId', 'roundsPassed', 'titleName', 'victory']);
    assert.equal(entry.titleName, null);
    assert.deepEqual(entry.players[0], { name: '甲', isBot: false, victory: true, roundsPassed: 9, titleName: '铁壁' });
  });

  test('caps an oversized list at the ring size, newest first', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      at: 1000 + i, victory: i % 2 === 0, roundsPassed: i, players: [],
    }));
    globalThis.localStorage.setItem(HIST_KEY, JSON.stringify(many));
    const list = loadHistory();
    assert.equal(list.length, HISTORY_KEEP);
    assert.equal(list[0].at, 1000, 'the stored order is kept');
  });

  test('never throws without localStorage', () => {
    const saved = globalThis.localStorage;
    delete globalThis.localStorage;
    try {
      assert.deepEqual(loadHistory(), []);
      assert.doesNotThrow(() => clearHistory());
    } finally {
      globalThis.localStorage = saved;
    }
  });
});

describe('recordResult', () => {
  test('prepends a compact entry tagged with my profile id', () => {
    const entry = recordResult(result(), 'p1');
    assert.ok(entry, 'an entry is returned');
    assert.equal(entry.victory, true);
    assert.equal(entry.roundsPassed, 12);
    assert.equal(entry.difficulty, 'HARD');
    assert.equal(entry.modeId, 'mode_multi_hard');
    assert.equal(entry.durationMs, 52 * 60000);
    assert.equal(entry.titleName, '铁壁');
    assert.ok(typeof entry.profileId === 'string' && entry.profileId.length > 0, 'tagged with this browser');
    assert.deepEqual(entry.players.map((p) => p.name), ['指挥官', '机器人']);
    assert.equal(entry.players[1].isBot, true);

    const list = loadHistory();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], entry, 'stored verbatim');
  });

  test('keeps newest first across several matches', () => {
    recordResult(result({ victory: true, roundsPassed: 5, durationMs: 60000 }), 'p1');
    recordResult(result({ victory: false, roundsPassed: 8, durationMs: 120000 }), 'p1');
    recordResult(result({ victory: true, roundsPassed: 11, durationMs: 180000 }), 'p1');
    const list = loadHistory();
    assert.deepEqual(list.map((e) => e.roundsPassed), [11, 8, 5]);
  });

  test('records the same payload only once (a remounted result screen)', () => {
    const msg = result();
    recordResult(msg, 'p1');
    recordResult(msg, 'p1');
    recordResult(msg, 'p1');
    assert.equal(loadHistory().length, 1, 'the same match is not counted twice');
  });

  test('still records a later match with the same shape', async () => {
    const msg = result();
    recordResult(msg, 'p1');
    // a real rematch is separated in time; the dedupe window is short
    const top = loadHistory()[0];
    globalThis.localStorage.setItem(HIST_KEY, JSON.stringify([{ ...top, at: top.at - 60000 }]));
    recordResult(msg, 'p1');
    assert.equal(loadHistory().length, 2);
  });

  test('deals with a result that has no players array', () => {
    const entry = recordResult({ victory: false, roundsPassed: 3, durationMs: 1000, players: null }, 'p1');
    assert.ok(entry);
    assert.equal(entry.victory, false);
    assert.deepEqual(entry.players, []);
    assert.equal(entry.roundsPassed, 3, 'falls back to the match-level result');
    assert.equal(entry.titleName, null);
  });

  test('returns null for a payload with nothing to record', () => {
    for (const bad of [null, undefined, 42, 'x', []]) assert.equal(recordResult(bad, 'p1'), null);
  });

  test('falls back to matching me by nickname when there is no player id', () => {
    globalThis.localStorage.setItem('sp.name', '指挥官');
    const entry = recordResult(result(), undefined);
    assert.equal(entry.titleName, '铁壁');
    assert.equal(entry.victory, true);
  });

  test('caps the ring at HISTORY_KEEP and drops the oldest match', () => {
    for (let i = 0; i < HISTORY_KEEP + 12; i += 1) {
      recordResult(result({ roundsPassed: i, durationMs: i * 1000 }), 'p1');
    }
    const list = loadHistory();
    assert.equal(list.length, HISTORY_KEEP);
    assert.equal(list[0].roundsPassed, HISTORY_KEEP + 11, 'the newest match is first');
    assert.ok(!list.some((e) => e.roundsPassed === 0), 'the oldest matches fell off');
  });

  test('keeps the serialized slot under the size cap', () => {
    // Fat entries (a long 评语 per seat) so 50 of them would blow past HISTORY_MAX_CHARS and the
    // oldest matches have to be dropped to fit the slot.
    const fat = result({
      players: Array.from({ length: 4 }, (_, i) => ({
        playerId: `p${i}`, seat: i, name: `甲${i}`, isBot: false, victory: true, roundsPassed: 12,
        title: { id: 't', name: '评语'.repeat(600) },
      })),
    });
    for (let i = 0; i < 60; i += 1) recordResult({ ...fat, durationMs: i * 1000 }, 'p1');
    const raw = globalThis.localStorage.raw(HIST_KEY);
    assert.ok(raw.length <= HISTORY_MAX_CHARS, `slot is ${raw.length} chars, cap is ${HISTORY_MAX_CHARS}`);
    const kept = loadHistory().length;
    assert.ok(kept >= 1 && kept < HISTORY_KEEP, `kept ${kept} entries`);
  });

  test('a failed write degrades to the session copy instead of throwing', () => {
    globalThis.localStorage.fail = true;
    let entry = null;
    assert.doesNotThrow(() => { entry = recordResult(result(), 'p1'); });
    assert.ok(entry);
    assert.equal(loadHistory().length, 1, 'the match is still visible this session');
  });
});

describe('summarize', () => {
  const entries = [
    { at: 4000, victory: true, roundsPassed: 15, durationMs: 1, hiddenCleared: true, profileId: 'me', titleName: '铁壁' },
    { at: 3000, victory: true, roundsPassed: 9, durationMs: 1, hiddenCleared: false, profileId: 'me', titleName: '铁壁' },
    { at: 2000, victory: false, roundsPassed: 11, durationMs: 1, hiddenCleared: false, profileId: 'me', titleName: '孤军' },
    { at: 1000, victory: false, roundsPassed: 2, durationMs: 1, hiddenCleared: false, profileId: 'me', titleName: null },
  ];

  test('counts matches, wins and win rate', () => {
    const s = summarize(entries, 'me');
    assert.equal(s.total, 4);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 2);
    assert.equal(s.winRate, 0.5);
  });

  test('reports the best rounds and the hidden clear', () => {
    const s = summarize(entries, 'me');
    assert.equal(s.bestRounds, 15);
    assert.equal(s.bestWinRounds, 15);
    assert.equal(s.hiddenClears, 1);
    assert.equal(s.lastAt, 4000);
  });

  test('ranks the most frequent 评语', () => {
    const s = summarize(entries, 'me');
    assert.deepEqual(s.titles, [{ name: '铁壁', count: 2 }, { name: '孤军', count: 1 }]);
    assert.equal(s.topTitle, '铁壁');
  });

  test('skips entries tagged to somebody else, and counts untagged ones as mine', () => {
    const s = summarize([...entries, { at: 5000, victory: true, roundsPassed: 99, profileId: 'other', titleName: '偷来的' },
      { at: 6000, victory: true, roundsPassed: 4, profileId: null, titleName: '无名' }], 'me');
    assert.equal(s.total, 5, 'the other profile is excluded, the untagged entry counts');
    assert.equal(s.bestRounds, 15, 'the other profile cannot raise my best');
    assert.equal(s.topTitle, '铁壁');
  });

  test('counts everything when no profile id is given', () => {
    assert.equal(summarize(entries, undefined).total, 4);
  });

  test('handles empty and malformed input', () => {
    for (const bad of [[], null, undefined, 'x', 42, {}]) {
      const s = summarize(bad, 'me');
      assert.equal(s.total, 0);
      assert.equal(s.winRate, 0);
      assert.deepEqual(s.titles, []);
      assert.equal(s.topTitle, null);
    }
  });

  test('ignores unusable entries inside the list', () => {
    const s = summarize([null, 42, {}, ...entries], 'me');
    assert.equal(s.total, 4);
  });

  test('summarize(loadHistory()) agrees with what was recorded', () => {
    recordResult(result({ victory: true, roundsPassed: 7, durationMs: 1000 }), 'p1');
    recordResult(result({ victory: false, roundsPassed: 3, durationMs: 2000 }), 'p1');
    const s = summarize(loadHistory());
    assert.equal(s.total, 2);
    assert.equal(s.wins, 1);
    assert.equal(s.bestRounds, 7);
    assert.equal(s.topTitle, '铁壁');
  });
});

describe('titleNameOf', () => {
  test('tolerates every title shape', () => {
    assert.equal(titleNameOf({ title: { id: 't', name: '铁壁' } }), '铁壁');
    assert.equal(titleNameOf({ titleName: '孤军' }), '孤军');
    assert.equal(titleNameOf({ titleName: '孤军', title: { name: '铁壁' } }), '孤军', 'the flattened name wins');
    assert.equal(titleNameOf({ title: '字串评语' }), '字串评语');
    assert.equal(titleNameOf({ title: { id: 't' } }), null);
    assert.equal(titleNameOf({ title: null }), null);
    assert.equal(titleNameOf({}), null);
  });

  test('tolerates null and non-objects', () => {
    for (const bad of [null, undefined, 42, 'x', true]) assert.equal(titleNameOf(bad), null);
  });
});

describe('clearHistory', () => {
  test('removes the stored matches', () => {
    recordResult(result(), 'p1');
    assert.equal(loadHistory().length, 1);
    clearHistory();
    assert.equal(loadHistory().length, 0);
    assert.equal(globalThis.localStorage.raw(HIST_KEY), null);
  });

  test('leaves the profile preference alone', () => {
    recordResult(result(), 'p1');
    const profile = globalThis.localStorage.raw(PROFILE_KEY);
    assert.ok(profile, 'recordResult minted a profile id');
    clearHistory();
    assert.equal(globalThis.localStorage.raw(PROFILE_KEY), profile);
  });
});
