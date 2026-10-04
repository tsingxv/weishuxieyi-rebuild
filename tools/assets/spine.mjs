// Spine model pipeline: download skel/atlas/page PNGs, fetch extra atlas pages,
// normalize atlases (size:/pma:), parse skeletons and resolve animation roles.
// Produces the per-model `spine` entries of data/assets.json.

import { readFile, writeFile, stat, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assetUrl, safeName, urlDir } from './sources.mjs';
import { kindOf, pngSize } from './formats.mjs';
import { atlasInfo, normalizeAtlas } from './atlas.mjs';
import { parseSkel } from './skel.mjs';
import { resolveRoles } from './anim-roles.mjs';

async function fileStat(p) { try { const s = await stat(p); return s.isFile() ? s : null; } catch { return null; } }

/**
 * @typedef {{ skel: string, atlas: string, textures: string[], pma: boolean, anims: any,
 *   animations: Record<string, number>, events: string[], hits: Record<string, number[]>, bounds: any }} SpineEntry
 */

/**
 * Run the whole Spine pipeline for every planned model.
 * @param {Map<string, any>} models plan.models
 * @param {object} o
 * @param {string} o.root absolute public/assets directory
 * @param {import('./downloader.mjs').Downloader} o.dl
 * @param {string} o.cachePath parse cache JSON path
 * @param {boolean} [o.download] false = only post-process what is on disk
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<{ entries: Map<string, SpineEntry>, problems: string[] }>}
 */
export async function processModels(models, { root, dl, cachePath, download = true, log = console.log }) {
  const problems = [];
  const list = [...models.values()];
  if (download) {
    const jobs = [];
    for (const m of list) jobs.push(m.skel, m.atlas, ...m.pngs);
    await dl.run(jobs, 'spine');
    // Atlases may reference more pages than the index lists.
    const extra = [];
    for (const m of list) {
      const text = await readFile(join(root, m.atlas.rel), 'utf8').catch(() => null);
      if (!text) continue;
      for (const page of atlasInfo(text).pages) {
        const rel = m.dir + safeName(page);
        if (!m.pngs.some((p) => p.rel === rel)) {
          // Same folder as the atlas actually came from (ledger), then the planned folders.
          const got = dl.ledger.files[m.atlas.rel]?.url;
          const dirs = [...new Set([got ? urlDir(got) : null, m.baseUrl, ...m.atlas.urls.map(urlDir)].filter(Boolean))];
          const a = { rel, urls: dirs.map((d) => d + encodeURIComponent(page)), kind: kindOf(page) };
          m.pngs.push(a);
          extra.push(a);
        }
      }
    }
    if (extra.length) await dl.run(extra, 'spine pages');
  }

  let cache = {};
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')) || {}; } catch { cache = {}; }
  const nextCache = {};
  const entries = new Map();
  let parsed = 0; let cached = 0;
  let ledgerDirty = false;
  const t0 = Date.now();
  for (const m of list) {
    const skelAbs = join(root, m.skel.rel);
    const atlasAbs = join(root, m.atlas.rel);
    const skelSt = await fileStat(skelAbs);
    const atlasText = await readFile(atlasAbs, 'utf8').catch(() => null);
    if (!skelSt || !atlasText) { problems.push(`${m.key}: missing ${!skelSt ? 'skel' : 'atlas'}`); continue; }
    // Normalize the atlas against the real page sizes.
    const info0 = atlasInfo(atlasText);
    const sizes = new Map();
    let pagesOk = info0.pages.length > 0;
    for (const page of info0.pages) {
      const buf = await readFile(join(root, m.dir + safeName(page))).catch(() => null);
      const sz = buf ? pngSize(buf) : null;
      if (!sz) { pagesOk = false; problems.push(`${m.key}: missing/invalid page ${page}`); continue; }
      sizes.set(page, sz);
    }
    if (!pagesOk) continue;
    const norm = normalizeAtlas(atlasText, { pageSize: (p) => sizes.get(p) || null, pma: !!m.pma, renamePage: (p) => safeName(p) });
    if (norm.missingSize.length) { problems.push(`${m.key}: cannot size pages ${norm.missingSize.join(',')}`); continue; }
    if (norm.changed) {
      await writeFile(atlasAbs + '.tmp', norm.text);
      await rename(atlasAbs + '.tmp', atlasAbs);
    }
    const atlasSt = await fileStat(atlasAbs);
    const info = atlasInfo(norm.text);
    // Parse the skeleton (cached by file size + mtime).
    const ck = `${m.skel.rel}|${skelSt.size}|${Math.floor(skelSt.mtimeMs)}|${atlasSt?.size}|${Math.floor(atlasSt?.mtimeMs ?? 0)}`;
    let sk = cache[m.skel.rel]?.key === ck ? cache[m.skel.rel].info : null;
    if (sk) cached++;
    else {
      try {
        sk = parseSkel(await readFile(skelAbs), info.regions);
        parsed++;
      } catch (e) {
        // A corrupt skeleton would otherwise be kept forever (its size matches the ledger):
        // delete it and forget it so the next online run downloads it again.
        problems.push(`${m.key}: skel parse failed (${e.message}); deleted, re-run to re-download`);
        try { await unlink(skelAbs); } catch { /* ignore */ }
        if (dl?.ledger?.files) delete dl.ledger.files[m.skel.rel];
        ledgerDirty = true;
        continue;
      }
    }
    nextCache[m.skel.rel] = { key: ck, info: sk };
    if (sk.missingRegions?.length) problems.push(`${m.key}: ${sk.missingRegions.length} attachment(s) not in atlas (e.g. ${sk.missingRegions[0]})`);
    if (!sk.animations.length) { problems.push(`${m.key}: skeleton has no animations`); continue; }
    const anims = resolveRoles(sk.animations, { skillIndices: m.skillIndices, durations: sk.durations });
    entries.set(m.key, {
      skel: assetUrl(m.skel.rel),
      atlas: assetUrl(m.atlas.rel),
      textures: info.pages.map((p) => assetUrl(m.dir + p)),
      pma: !!m.pma,
      anims,
      animations: sk.durations,
      events: sk.events,
      hits: sk.hits,
      bounds: sk.bounds,
    });
    if (Date.now() - t0 > 0 && (parsed + cached) % 100 === 0) log(`[spine] processed ${parsed + cached}/${list.length}`);
  }
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(nextCache));
  if (ledgerDirty && dl?.saveLedger) { try { await dl.saveLedger(); } catch { /* next run re-validates */ } }
  log(`[spine] models ok=${entries.size}/${list.length} (parsed ${parsed}, cached ${cached})`);
  return { entries, problems };
}
