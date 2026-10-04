// Local-client art is optional (DESIGN §13): the emote art, the 玩法说明 pages and the official tier chips resolve
// from data/local-assets.json when present and fall back (text / tips / CSS) when the manifest or an entry is missing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMOTES, emoteArtPath, emoteArtGroup, emoteInfo } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const manifest = {
  version: 1,
  groups: {
    'emoticon/basic': { pic_happy_battle: { path: '/assets/local/emoticon/basic/pic_happy_battle.png', w: 120, h: 120 } },
    guide: Object.fromEntries(['autochess_home_1', 'autochess_home_2', 'autochess_shop_1', 'autochess_handbook_4']
      .map((k) => [k, { path: `/assets/local/guide/${k}.png`, w: 1024, h: 1024 }])),
    'ui/battle': { img_chess_level_3: { path: '/assets/local/ui/battle/img_chess_level_3.png', w: 45, h: 45 } },
  },
};

let mode = 'ok';
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/local-assets.json') && mode === 'ok') return { ok: true, status: 200, json: async () => manifest };
  return { ok: false, status: 404, json: async () => ({}) };
};

describe('local-client art fallbacks', () => {
  test('manifest present: listed entries resolve, unlisted ones stay null', async () => {
    const { data, localAsset } = await import('../../public/js/data.js');
    await data.load('local');
    const { emoteArtUrl } = await import('../../public/js/ui/emotes.js');
    const { guidePages, GUIDE_CHAPTERS } = await import('../../public/js/ui/guide.js');
    const { tierChipUrl } = await import('../../public/js/ui/components.js');
    assert.equal(emoteArtUrl('autochess_battle_happy'), emoteArtPath('autochess_battle_happy'));
    assert.equal(emoteArtUrl('autochess_battle_sad'), null, 'unlisted emote art is never requested');
    assert.equal(emoteArtUrl('nope'), null);
    const pages = guidePages();
    assert.deepEqual(pages.map((p) => p.key), ['autochess_home_1', 'autochess_home_2', 'autochess_shop_1', 'autochess_handbook_4'], 'reading order, missing pages skipped');
    assert.deepEqual(pages.map((p) => p.chapter), [0, 0, 1, 2]);
    assert.equal(GUIDE_CHAPTERS.reduce((n, c) => n + c.pages.length, 0), 19, 'the 19 official tutorial pages');
    assert.equal(tierChipUrl(3), '/assets/local/ui/battle/img_chess_level_3.png');
    assert.equal(tierChipUrl(4), null, 'CSS fallback');
    assert.equal(localAsset('guide', 'autochess_home_9'), null);
    assert.equal(localAsset('nope', 'x'), null);
  });

  test('manifest missing: everything falls back', async () => {
    mode = 'missing';
    const { data } = await import('../../public/js/data.js');
    const orig = console.warn; console.warn = () => {};
    try { await data.invalidate('local'); } finally { console.warn = orig; }
    assert.equal(data.status('local'), 'missing');
    const { emoteArtUrl } = await import('../../public/js/ui/emotes.js');
    const { guidePages } = await import('../../public/js/ui/guide.js');
    const { tierChipUrl } = await import('../../public/js/ui/components.js');
    for (const id of EMOTES) assert.equal(emoteArtUrl(id), null);
    assert.deepEqual(guidePages(), []);
    assert.equal(tierChipUrl(1), null);
  });

  test('the real manifest (when extracted) lists all 36 emotes and all 19 guide pages', { skip: !safeRead() && 'no data/local-assets.json' }, () => {
    const real = JSON.parse(safeRead());
    for (const id of EMOTES) {
      const entry = real.groups[emoteArtGroup(id)]?.[emoteInfo(id).picId];
      assert.ok(entry, `emote ${id}`);
      assert.equal(entry.path, emoteArtPath(id));
    }
    assert.equal(Object.keys(real.groups.guide || {}).length, 19);
  });
});

function safeRead() {
  try { return readFileSync(path.join(ROOT, 'data/local-assets.json'), 'utf8'); } catch { return null; }
}
