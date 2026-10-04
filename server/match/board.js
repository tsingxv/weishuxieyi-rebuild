// server/match/board.js — placement legality (DESIGN §3), board/hand/temp slot helpers.
//
// Deploy map: for every tile of the own board region (rows 9–12, cols 2–10) the legality class is derived from the
// stage legend (data/stages.json `tiles[glyph]`: height + buildable) and the stage devices:
//   'melee'  — LOW tile with buildable ALL/MELEE: melee AND ranged chess may stand here
//              ("所有行动内远程干员可部署在近战位").
//   'ranged' — HIGH tile with buildable ALL/RANGED, or a tile under an active platform (射击台): ranged only.
//   (absent) — not deployable (NONE, forbidden, road lanes, tiles under active crates/mounds).
// Per-player overrides (terrain 机变 cards, content): `deviceOverrides { alias: active }` toggles stage devices,
// `tileOverrides { 'r,c': 'melee'|'ranged'|'none' }` force a class. The result equals stages[id].deployTiles.normal
// for the unmodified stage (asserted in test/match/board.test.js).
//
// Deploy field (user playtest #5 item 7): in the prep of a boss round (最终攻势 / 隐秘核心) the player deploys on ITS
// half of the boss field (research 09 §1.2, official ConvertChessPositionInfoToBossMap / player_map_ud_offset 7 /
// player_map_lr_boundary_col 10), so legality reads the tiles and devices THERE: `field` 'bossL' → board (r, c) is
// stage tile (r − 7, c); 'bossR' (the second player of a pair, mirrored) → (r − 7, 20 − c); 'normal' → (r, c). Board
// coordinates stay the same everywhere (the server's board, g.move, the sim input); only the tile read changes. E.g.
// act2 m01's 1×3 fenced tiles (tile_fence_bound, LOW / buildable ALL) at boss (3–5, 8) and (3–5, 12) = board
// (10–12, 8), which are '#' on the normal field. The result equals stages[id].deployTiles.bossLeft / bossRight
// mapped to board coordinates (test/match/playtest5-deploy.test.js).
//
// Tokens follow their own `position` (ALL ⇒ any deployable tile, MELEE ⇒ melee tiles, RANGED ⇒ any deployable).
// Facing: board pieces carry `dir` ∈ UP|RIGHT|DOWN|LEFT (server/sim/dir.js); `pieceDir` reads it (absent ⇒ RIGHT),
// `parseDir` validates an intent's optional direction.

import { GEO } from '../../shared/constants.js';
import { DEFAULT_DIR, isDir } from '../sim/dir.js';
import { BOSS_ROW_OFFSET, COLS } from '../sim/constants.js';

export const FIELD = GEO.FIELD; // { r0: 9, r1: 12, c0: 2, c1: 10 }
export const tileKey = (r, c) => `${r},${c}`;
export const parseKey = (k) => { const [r, c] = String(k).split(',').map(Number); return [r, c]; };
/** A board piece's direction (default RIGHT). */
export const pieceDir = (piece) => (piece && isDir(piece.dir) ? piece.dir : DEFAULT_DIR);
/** An intent's optional direction: undefined / null ⇒ RIGHT, a direction name ⇒ itself, anything else ⇒ null (invalid). */
export const parseDir = (d) => (d === undefined || d === null ? DEFAULT_DIR : isDir(d) ? d : null);
export const inField = (r, c) => Number.isInteger(r) && Number.isInteger(c) && r >= FIELD.r0 && r <= FIELD.r1 && c >= FIELD.c0 && c <= FIELD.c1;

const OBSTACLE_ROLES = new Set(['crate', 'mound']);
const PLATFORM_ROLES = new Set(['platform']);

/** Deploy fields: the own normal board, or the player's half of the boss field (left / mirrored right). */
export const DEPLOY_FIELDS = Object.freeze(['normal', 'bossL', 'bossR']);
/**
 * How many rows a board row lies below its boss-field row: board row = boss-field row + 7 (official
 * player_map_ud_offset 7; = −sim BOSS_ROW_OFFSET). Note the sign: render/prepfield.js BOSS_ROW_SHIFT is −7 (board →
 * display row), the opposite direction.
 */
export const BOARD_ROWS_ABOVE_BOSS = -BOSS_ROW_OFFSET;
/** Mirror column of the right boss half: board col c ↔ field col 20 − c (sim Battle.mapTile). */
export const BOSS_MIRROR_COL = COLS - 1;
const fieldOf = (f) => (DEPLOY_FIELDS.includes(f) ? f : 'normal');

/** The stage tile [row, col] a board tile (r, c) stands on in deploy field `field`. */
export function fieldTile(field, r, c) {
  const f = fieldOf(field);
  if (f === 'normal') return [r, c];
  return [r - BOARD_ROWS_ABOVE_BOSS, f === 'bossR' ? BOSS_MIRROR_COL - c : c];
}

/** Inverse of fieldTile: the board tile of stage tile (r, c) in deploy field `field`. */
export function boardTileOf(field, r, c) {
  const f = fieldOf(field);
  if (f === 'normal') return [r, c];
  return [r + BOARD_ROWS_ABOVE_BOSS, f === 'bossR' ? BOSS_MIRROR_COL - c : c];
}

/**
 * @param {object|null} stage data/stages.json entry
 * @param {{ deviceOverrides?: Record<string, boolean>, tileOverrides?: Record<string, string>, field?: 'normal'|'bossL'|'bossR' }} [opts]
 * @returns {Map<string, 'melee'|'ranged'>} keyed by BOARD tile 'r,c' (rows 9–12, cols 2–10)
 */
export function buildDeployMap(stage, { deviceOverrides = {}, tileOverrides = {}, field = 'normal' } = {}) {
  /** @type {Map<string, 'melee'|'ranged'>} */
  const map = new Map();
  const rows = stage && Array.isArray(stage.rows) ? stage.rows : null;
  const legend = stage && stage.tiles && typeof stage.tiles === 'object' ? stage.tiles : {};
  for (let r = FIELD.r0; r <= FIELD.r1; r++) {
    for (let c = FIELD.c0; c <= FIELD.c1; c++) {
      const [sr, sc] = fieldTile(field, r, c);
      const line = rows && typeof rows[sr] === 'string' ? rows[sr] : null;
      let cls = null;
      if (line) {
        const g = line[sc];
        const t = g != null && Object.hasOwn(legend, g) ? legend[g] : null;
        if (t) {
          const b = t.buildable;
          if (t.height === 'LOW' && (b === 'ALL' || b === 'MELEE')) cls = 'melee';
          else if ((t.height === 'HIGH' && (b === 'ALL' || b === 'RANGED')) || (t.height === 'LOW' && b === 'RANGED')) cls = 'ranged';
        }
      } else if (!stage) {
        // no stage data at all: an open board (tests / degraded data) — everything melee-deployable except col 9
        cls = c === 9 ? null : 'melee';
      }
      if (cls) map.set(tileKey(r, c), cls);
    }
  }
  const devices = stage && Array.isArray(stage.devices) ? stage.devices : [];
  for (const d of devices) {
    if (!d || !Array.isArray(d.pos)) continue;
    const [r, c] = boardTileOf(field, d.pos[0], d.pos[1]);
    if (!inField(r, c)) continue;
    let active;
    if (d.alias != null && deviceOverrides && Object.hasOwn(deviceOverrides, d.alias)) active = !!deviceOverrides[d.alias];
    else if (typeof d.active === 'boolean') active = d.active;
    else active = !d.hidden;
    if (!active) continue;
    const k = tileKey(r, c);
    if (OBSTACLE_ROLES.has(d.role)) map.delete(k);
    else if (PLATFORM_ROLES.has(d.role)) map.set(k, 'ranged');
  }
  for (const [k, v] of Object.entries(tileOverrides || {})) {
    const [r, c] = parseKey(k);
    if (!inField(r, c)) continue;
    if (v === 'melee' || v === 'ranged') map.set(tileKey(r, c), v);
    else if (v === 'none') map.delete(tileKey(r, c));
  }
  return map;
}

/** Placement class of a chess / token record: 'melee' | 'ranged' | 'all'. */
export function positionClass(rec) {
  const p = rec && typeof rec.position === 'string' ? rec.position.toUpperCase() : 'ALL';
  if (p === 'MELEE') return 'melee';
  if (p === 'RANGED') return 'ranged';
  return 'all';
}

/** Whether a unit of placement class `pos` may stand on (r, c). */
export function canPlace(map, pos, r, c) {
  if (!inField(r, c)) return false;
  const cls = map.get(tileKey(r, c));
  if (!cls) return false;
  if (pos === 'melee') return cls === 'melee';
  return true; // ranged / all: melee tiles and ranged tiles
}

/** Legal tiles for a placement class, in reading order (top→bottom, left→right). */
export function legalTiles(map, pos) {
  const out = [];
  for (let r = FIELD.r1; r >= FIELD.r0; r--) {
    for (let c = FIELD.c0; c <= FIELD.c1; c++) if (canPlace(map, pos, r, c)) out.push([r, c]);
  }
  return out;
}

/** Board pieces sorted in deployment order: top→bottom (row desc) then left→right (col asc). */
export function boardOrder(board) {
  return [...board.entries()]
    .map(([k, p]) => { const [r, c] = parseKey(k); return { r, c, piece: p }; })
    .sort((a, b) => b.r - a.r || a.c - b.c);
}

/**
 * Where a merge's elite stands (PRTS 卫戍协议/帮助 "若消耗已部署至作战区的干员，则发送至作战区对应位置"): of the board tiles
 * the consumed copies stood on (`[{ key, dir }]`), the first in deployment order (top→bottom, left→right — the copy the
 * battle deploys first; the right-hand boss half is mirrored on screen but deploys in the same board order) that
 * `legal(r, c)` accepts for the elite, or null (⇒ the hand). [ASSUMED] the order: the official text names one position.
 * public/js/ui/gameLogic.js mergeTarget mirrors it for the client.
 * @param {Array<{ key: string, dir?: string }>} tiles
 * @param {(r: number, c: number) => boolean} [legal]
 * @returns {{ key: string, dir?: string, r: number, c: number } | null}
 */
export function mergeTile(tiles, legal = () => true) {
  const sorted = (tiles || []).map((t) => { const [r, c] = parseKey(t.key); return { ...t, r, c }; }).sort((a, b) => b.r - a.r || a.c - b.c);
  return sorted.find((t) => inField(t.r, t.c) && legal(t.r, t.c)) || null;
}

/** Index of the free slot to fill (right→left, config.economy.handFillOrder), or -1. */
export function freeSlot(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] == null) return i;
  return -1;
}

export function countFree(arr) {
  let n = 0;
  for (const x of arr) if (x == null) n++;
  return n;
}
