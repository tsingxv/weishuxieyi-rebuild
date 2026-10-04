// server/sim/grid.js — field grid, tile queries, passability and the official ground pathfinding (DESIGN §3,
// research 08 §3).
//
// Coordinates: row 0 = bottom, col 0 = left. Tile (r,c) has world centre (x=c, y=r).
// Stage input: `{ id, rows: string[19] (bottom-first), legend?: {glyph: {...}}, devices?: [...] }`.
// Legend entries are normalised from either the research format (heightType/buildableType/passableMask/tileKey)
// or the build-data format (height/build/passable/terrain); missing glyphs fall back to DEFAULT_LEGEND.
//
// Pathfinding = the official client's (`Torappu.Battle.SPFA`, research 08 §3.1/§3.4): one FLOW FIELD per destination,
// a FIFO SPFA from the destination over the rect with the 4 neighbours UP (row+1), RIGHT, DOWN, LEFT (in that order,
// no diagonal edges), edge cost = the neighbour's move cost (1, or OBSTACLE_COST 1000 for an "obstacle-like" tile: a
// crate), strict-improvement relaxation (a tile keeps the first parent that reached it); then the parents are
// smoothed row-major in place — each tile's parent jumps to the farthest ancestor in Bresenham line of sight (every
// tile on the line walkable and not a crate; a diagonal step needs both orthogonal neighbours clear). A ground enemy
// walks straight toward `next[tile]` of its current tile (ai.js). Fields are cached per (destination, grid version).
//
// Blockable-ground preference (user playtest: "the lower-gate enemies of 战场#01 walk up the col-9 floor lane where no
// operator can block them"). Two refinements on top of the official algorithm; `dist` (so the crate cost 1000 and
// every grid route length) stays exactly the official one:
//   * tie-break: the SPFA relaxes on (dist, pen) lexicographically, `pen` = number of NON-BLOCKABLE walkable tiles
//     (floor / gate / goal / teleport tiles — `blockable()` false: not LOW ground buildable for melee) on the chain.
//     Among equal-length chains the one with the fewest non-blockable tiles wins; remaining ties go to the first
//     parent in SPFA order (the official order unless a pen improvement re-queued a tile).
//   * smoothing: a line of sight may only cross a non-blockable tile (including the corner tiles of a diagonal step)
//     that lies on the tile's own raw chain between its two ends — a smoothed segment never cuts across floor the grid
//     route does not walk, so an enemy never slips past an operator standing on the road next to the floor lane.
//     This one also bends routes whose raw chain is the official one (a diagonal that would clip off-chain floor
//     becomes an L, mostly inside the boss arena's central floor): the smoothed polyline can be up to 2 tiles
//     longer than the official one (test/sim/pathing-blockable.test.js bounds it).
// Unavoidable non-blockable tiles (gates, goals, teleports and single-exit floor, e.g. (12,9) next to the upper
// gate) stay on the route; test/sim/pathing-blockable.test.js lists them per stage, gate and field.
//
// Obstacle layer (bit flags per tile): BLOCK (射击台 / mounds / `setObstacle(r, c, on)` — impassable [ASSUMED for
// platforms, research 08 §8 #1]) and CRATE (阻隔工事 devices — `setObstacle(r, c, on, 'crate')`: walkable at cost 1000,
// blocks line of sight; an enemy that must cross one is blocked by the device and breaks it). Any change bumps
// `version`, which invalidates the cached fields (enemies re-read their next step). `groundPassable` (placement,
// displacement, content) still treats both kinds as occupied unless `ignoreObstacles`. `straightClear` tells whether an
// off-centre unit may walk straight to a tile centre (ai.js planLeg, fear.js: else it steps back to its tile centre).

import { ROWS, COLS } from './constants.js';

/** Move cost of an obstacle-like tile (client `Tile.get_moveCost`: obstacle-like ? 1000 : 1). */
export const OBSTACLE_COST = 1000;
/** Obstacle-layer bits. */
export const OB_BLOCK = 1;
export const OB_CRATE = 2;
/** Official neighbour order `GridPosition.GRID_FOUR_WAYS`: UP (row+1), RIGHT, DOWN, LEFT — do not reorder. */
const FOUR_WAYS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
/** Cached flow fields per grid version (destinations: route ends, checkpoints, attract points). */
const FIELD_CACHE_MAX = 64;

/** Built-in legend (research 05 §2.3) used when a stage has no legend entry for a glyph. */
export const DEFAULT_LEGEND = Object.freeze({
  '#': { height: 'HIGH', build: 'NONE', pass: 'FLY', key: 'tile_forbidden' },
  X: { height: 'HIGH', build: 'NONE', pass: 'NONE', key: 'tile_forbidden' },
  r: { height: 'LOW', build: 'ALL', pass: 'ALL', key: 'tile_road' },
  R: { height: 'LOW', build: 'NONE', pass: 'ALL', key: 'tile_road' },
  f: { height: 'LOW', build: 'NONE', pass: 'ALL', key: 'tile_floor' },
  p: { height: 'LOW', build: 'NONE', pass: 'ALL', key: 'tile_floor' },
  h: { height: 'HIGH', build: 'RANGED', pass: 'FLY', key: 'tile_wall' },
  b: { height: 'LOW', build: 'ALL', pass: 'FLY', key: 'tile_fence_bound' },
  a: { height: 'HIGH', build: 'NONE', pass: 'FLY', key: 'tile_achand' },
  A: { height: 'HIGH', build: 'NONE', pass: 'FLY', key: 'tile_achand' },
  S: { height: 'LOW', build: 'NONE', pass: 'ALL', key: 'tile_start', special: 'start' },
  E: { height: 'LOW', build: 'NONE', pass: 'ALL', key: 'tile_end', special: 'end' },
  I: { height: 'LOW', build: 'NONE', pass: 'ALL', key: 'tile_telin', special: 'telin' },
  O: { height: 'LOW', build: 'NONE', pass: 'ALL', key: 'tile_telout', special: 'telout' },
  m: { height: 'LOW', build: 'ALL', pass: 'ALL', key: 'tile_mire', terrain: 'mire' },
  g: { height: 'LOW', build: 'ALL', pass: 'ALL', key: 'tile_smog', terrain: 'smog' },
  d: { height: 'LOW', build: 'ALL', pass: 'ALL', key: 'tile_deepsea', terrain: 'deepsea' },
  i: { height: 'LOW', build: 'ALL', pass: 'ALL', key: 'tile_infection', terrain: 'infection' },
});

const TERRAIN_BY_KEY = { tile_mire: 'mire', tile_smog: 'smog', tile_deepsea: 'deepsea', tile_infection: 'infection', tile_deepwater: 'deepsea' };
const SPECIAL_BY_KEY = { tile_start: 'start', tile_end: 'end', tile_telin: 'telin', tile_telout: 'telout' };

function normPass(v) {
  if (v === true) return 'ALL';
  if (v === false) return 'NONE';
  const s = String(v ?? '').toUpperCase();
  if (s === 'ALL' || s === 'GROUND' || s === 'WALK') return 'ALL';
  if (s.includes('FLY')) return 'FLY';
  if (s === 'NONE' || s === '') return 'NONE';
  return 'ALL';
}

/** Normalise one legend entry (any known format) into `{ height, build, pass, key, terrain, special }`. */
export function normalizeLegendEntry(glyph, e) {
  const base = DEFAULT_LEGEND[glyph] || { height: 'LOW', build: 'NONE', pass: 'ALL', key: 'tile_floor' };
  if (!e || typeof e !== 'object') return { ...base, glyph };
  const key = e.tileKey ?? e.key ?? e.tile ?? base.key;
  const heightRaw = e.height ?? e.heightType;
  const height = heightRaw == null ? base.height : (/HIGH/i.test(String(heightRaw)) ? 'HIGH' : 'LOW');
  const buildRaw = e.build ?? e.buildable ?? e.buildableType;
  const build = buildRaw == null ? base.build : (buildRaw === true ? 'ALL' : buildRaw === false ? 'NONE' : String(buildRaw).toUpperCase());
  let pass;
  if (e.pass != null) pass = normPass(e.pass);
  else if (e.passable != null || e.passableMask != null) pass = normPass(e.passable ?? e.passableMask);
  else if (e.groundPassable != null) pass = e.groundPassable ? 'ALL' : (e.flyPassable === false ? 'NONE' : 'FLY');
  else pass = base.pass;
  const terrain = e.terrain ?? TERRAIN_BY_KEY[key] ?? base.terrain ?? null;
  const special = e.special ?? SPECIAL_BY_KEY[key] ?? base.special ?? null;
  return { glyph, key, height, build, pass, terrain, special };
}

const EMPTY_TILE = Object.freeze({ glyph: 'X', key: 'tile_forbidden', height: 'HIGH', build: 'NONE', pass: 'NONE', terrain: null, special: null });

/** A melee operator may stand (and block) on this terrain: LOW ground buildable for ALL or MELEE. */
function isBlockableTile(t) { return t.height === 'LOW' && (t.build === 'ALL' || t.build === 'MELEE'); }

export class Grid {
  /**
   * @param {object} stage stage entry (rows bottom-first)
   * @param {{r0:number,r1:number,c0:number,c1:number}} rect inclusive simulation bounds
   */
  constructor(stage, rect) {
    this.stage = stage || {};
    this.rect = rect;
    this.rows = ROWS;
    this.cols = COLS;
    const rows = Array.isArray(this.stage.rows) ? this.stage.rows : [];
    const legend = this.stage.legend || {};
    const cache = new Map();
    const info = (g) => {
      if (!cache.has(g)) cache.set(g, Object.freeze(normalizeLegendEntry(g, legend[g])));
      return cache.get(g);
    };
    /** @type {object[]} */
    this.tiles = new Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) {
      const line = typeof rows[r] === 'string' ? rows[r] : (Array.isArray(rows[r]) ? rows[r].join('') : '');
      for (let c = 0; c < COLS; c++) {
        const g = line[c];
        this.tiles[r * COLS + c] = g ? info(g) : EMPTY_TILE;
      }
    }
    /** 1 = walkable terrain an operator cannot block on (floor, gate, goal, teleport…): the path tie-break penalty */
    this.unblockable = new Uint8Array(ROWS * COLS);
    for (let k = 0; k < ROWS * COLS; k++) {
      const t = this.tiles[k];
      this.unblockable[k] = t.pass === 'ALL' && !isBlockableTile(t) ? 1 : 0;
    }
    /** obstacle bits per tile (OB_BLOCK | OB_CRATE) */
    this.obstacle = new Uint8Array(ROWS * COLS);
    this.version = 0;
    /** @type {Map<string, FlowField>} */
    this._fields = new Map();
  }

  key(r, c) { return r * COLS + c; }
  inBounds(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }
  inRect(r, c) { const R = this.rect; return r >= R.r0 && r <= R.r1 && c >= R.c0 && c <= R.c1; }
  /** Tile info (frozen) or an impassable placeholder outside the stage. */
  tile(r, c) { return this.inBounds(r, c) ? this.tiles[r * COLS + c] : EMPTY_TILE; }

  /** Ground units may stand / be placed here (inside the rect, terrain passable, no obstacle of any kind). */
  groundPassable(r, c, ignoreObstacles = false) {
    if (!this.inRect(r, c)) return false;
    const t = this.tiles[r * COLS + c];
    if (t.pass !== 'ALL') return false;
    return ignoreObstacles || !this.obstacle[r * COLS + c];
  }

  /** Walkable for the flow field: in the rect, terrain passable for WALK, not hard-blocked (crates ARE walkable). */
  walkable(r, c, ignoreObstacles = false) {
    if (!this.inRect(r, c)) return false;
    const k = r * COLS + c;
    if (this.tiles[k].pass !== 'ALL') return false;
    return ignoreObstacles || !(this.obstacle[k] & OB_BLOCK);
  }

  flyPassable(r, c) { return this.inRect(r, c) && this.tile(r, c).pass !== 'NONE'; }

  /** Whether a unit may stand on this tile. `ranged` units may also use LOW ALL/MELEE tiles (DESIGN §3). */
  canStand(r, c, { ranged = false } = {}) {
    const t = this.tile(r, c);
    if (t.build === 'NONE') return false;
    if (ranged) return t.build === 'ALL' || t.build === 'RANGED' || (t.height === 'LOW' && t.build === 'MELEE');
    return t.height === 'LOW' && (t.build === 'ALL' || t.build === 'MELEE');
  }

  isLow(r, c) { return this.tile(r, c).height === 'LOW'; }

  /** Ground a melee operator can be deployed on and block from (LOW, buildable ALL / MELEE) — terrain only. */
  blockable(r, c) { return isBlockableTile(this.tile(r, c)); }

  /**
   * Toggle an obstacle. `kind` 'block' (default: impassable — platforms, mounds, content) or 'crate' (obstacle-like:
   * walkable at OBSTACLE_COST, blocks line of sight). Each kind is its own bit, so a crate turned into a platform on
   * the same tile (map cards) stays consistent whatever the order of the two calls.
   */
  setObstacle(r, c, on, kind = 'block') {
    if (!this.inBounds(r, c)) return;
    const k = r * COLS + c;
    const bit = kind === 'crate' ? OB_CRATE : OB_BLOCK;
    const v = on ? (this.obstacle[k] | bit) : (this.obstacle[k] & ~bit);
    if (this.obstacle[k] === v) return;
    this.obstacle[k] = v;
    this.version++;
    this._fields.clear();
  }

  /** Any obstacle (crate or block) on the tile. */
  isObstacle(r, c) { return this.inBounds(r, c) && this.obstacle[r * COLS + c] !== 0; }
  /** An obstacle-like (cost-1000) crate on the tile. */
  isCrate(r, c) { return this.inBounds(r, c) && (this.obstacle[r * COLS + c] & OB_CRATE) !== 0; }
  /** A hard block (platform / mound / content) on the tile. */
  isBlocked(r, c) { return this.inBounds(r, c) && (this.obstacle[r * COLS + c] & OB_BLOCK) !== 0; }

  /** List tiles of a given special kind ('start'|'end'|'telin'|'telout') inside the rect. */
  specialTiles(kind) {
    const out = [];
    const R = this.rect;
    for (let r = R.r0; r <= R.r1; r++) for (let c = R.c0; c <= R.c1; c++) if (this.tile(r, c).special === kind) out.push([r, c]);
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // official flow field (research 08 §3.4)

  /**
   * Flow field toward (er, ec). `allowDiagonal` false ⇒ line of sight only along a row or a column (every autochess
   * route allows diagonals). `ignoreObstacles` ⇒ blocks and crates are ignored (fallback when the goal is walled off).
   * @returns {FlowField}
   */
  flowField(er, ec, { allowDiagonal = true, ignoreObstacles = false } = {}) {
    er |= 0; ec |= 0;
    const ck = `${er},${ec},${allowDiagonal ? 1 : 0},${ignoreObstacles ? 1 : 0}`;
    const hit = this._fields.get(ck);
    if (hit) return hit;
    const f = this._buildField(er, ec, allowDiagonal, ignoreObstacles);
    if (this._fields.size >= FIELD_CACHE_MAX) this._fields.delete(this._fields.keys().next().value);
    this._fields.set(ck, f);
    return f;
  }

  _buildField(er, ec, allowDiagonal, ignore) {
    const N = ROWS * COLS;
    const dist = new Int32Array(N).fill(-1);
    const parent = new Int32Array(N).fill(-1);
    /** non-blockable tiles on the raw chain (tile included, destination excluded) — the equal-length tie-break */
    const pen = new Int32Array(N);
    const f = { dest: -1, dist, parent, pen, next: parent, len: null, version: this.version, allowDiagonal, ignore };
    if (!this.inBounds(er, ec)) return f;
    const dest = er * COLS + ec;
    f.dest = dest;
    const inQ = new Uint8Array(N);
    const unb = this.unblockable;
    const crate = (k) => !ignore && (this.obstacle[k] & OB_CRATE) !== 0;
    // SPFA (FIFO), seeded with the destination (walkable or not); relaxation on (dist, pen) lexicographically
    const q = new Int32Array(N * 4 + 8);
    let qh = 0, qt = 0;
    const push = (k) => {
      if (qt >= q.length) { q.copyWithin(0, qh, qt); qt -= qh; qh = 0; }
      q[qt++] = k;
    };
    dist[dest] = 0;
    push(dest);
    inQ[dest] = 1;
    while (qh < qt) {
      const cur = q[qh++];
      inQ[cur] = 0;
      const r = (cur / COLS) | 0, c = cur - r * COLS;
      for (let i = 0; i < 4; i++) {
        const nr = r + FOUR_WAYS[i][0], nc = c + FOUR_WAYS[i][1];
        if (!this.walkable(nr, nc, ignore)) continue;
        const nb = nr * COLS + nc;
        const nd = dist[cur] + (crate(nb) ? OBSTACLE_COST : 1);
        const np = pen[cur] + unb[nb];
        if (dist[nb] < 0 || nd < dist[nb] || (nd === dist[nb] && np < pen[nb])) {
          dist[nb] = nd;
          pen[nb] = np;
          parent[nb] = cur;
          if (!inQ[nb]) { push(nb); inQ[nb] = 1; }
        }
      }
    }
    // smoothing: row-major, in place (client `_PostprocessAndMakeNextMapSmoothly`); a line from n toward ancestor a
    // may cross a non-blockable tile only when that tile is on n's raw chain between n and a (onChain / minDist)
    const next = new Int32Array(parent);
    const onChain = new Int32Array(N).fill(-1);
    let from = -1, minDist = 0;
    const clear = (r, c) => {
      if (!this.walkable(r, c, ignore)) return false;
      const k = r * COLS + c;
      if (crate(k)) return false;
      return !unb[k] || (onChain[k] === from && dist[k] >= minDist);
    };
    const los = allowDiagonal ? (a, b) => bresenhamClear(a, b, clear) : (a, b) => segmentClear(a, b, clear);
    for (let n = 0; n < N; n++) {
      if (dist[n] < 0 || next[n] < 0) continue;
      for (let x = n, guard = N; x >= 0 && guard-- > 0; x = parent[x]) onChain[x] = n;
      from = n;
      let b = next[n];
      while (next[b] >= 0) {
        minDist = dist[next[b]];
        if (!los(n, next[b])) break;
        b = next[b];
      }
      next[n] = b;
    }
    f.next = next;
    return f;
  }

  /** Geometric length (tiles) of the smoothed route from tile key k to the field's destination (memoised). */
  fieldLength(f, k) {
    if (!f || k < 0 || f.dist[k] < 0) return Infinity;
    if (!f.len) f.len = new Float64Array(ROWS * COLS).fill(-1);
    const stack = [];
    let x = k;
    while (x >= 0 && f.len[x] < 0) {
      if (x === f.dest || f.next[x] < 0) { f.len[x] = 0; break; }
      stack.push(x);
      x = f.next[x];
      if (stack.length > ROWS * COLS) return Infinity; // cannot happen (dist strictly decreases); defensive
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      const a = stack[i], b = f.next[a];
      const ar = (a / COLS) | 0, ac = a - ar * COLS, br = (b / COLS) | 0, bc = b - br * COLS;
      f.len[a] = f.len[b] + Math.hypot(br - ar, bc - ac);
    }
    return f.len[k];
  }

  /**
   * Smoothed waypoints [[r,c]…] from (sr,sc) to (er,ec) along the flow field (start and goal included), or null when
   * the start cannot reach the goal. With `ignoreObstacles` the field ignores blocks and crates.
   */
  waypoints(sr, sc, er, ec, { ignoreObstacles = false, allowDiagonal = true } = {}) {
    if (!this.inBounds(sr, sc) || !this.inBounds(er, ec)) return null;
    const start = sr * COLS + sc;
    const goal = er * COLS + ec;
    if (start === goal) return [[sr, sc]];
    const f = this.flowField(er, ec, { ignoreObstacles, allowDiagonal });
    if (f.dist[start] < 0) return null;
    const out = [[sr, sc]];
    let k = start, guard = ROWS * COLS;
    while (k !== goal && guard-- > 0) {
      k = f.next[k];
      if (k < 0) return null;
      out.push([(k / COLS) | 0, k % COLS]);
    }
    return out;
  }

  /**
   * Tiles crossed by the enemy route from (sr,sc) to (er,ec): the smoothed waypoints joined by their Bresenham lines
   * (start and goal included; consecutive tiles are 8-neighbours). null when unreachable (unless ignoreObstacles).
   */
  findPath(sr, sc, er, ec, { ignoreObstacles = false } = {}) {
    const wp = this.waypoints(sr, sc, er, ec, { ignoreObstacles });
    if (!wp) return null;
    const out = [wp[0]];
    for (let i = 1; i < wp.length; i++) {
      const seg = bresenhamTiles(wp[i - 1], wp[i]);
      for (let j = 1; j < seg.length; j++) out.push(seg[j]);
    }
    return out;
  }

  /** Length (tiles) of a polyline of [r,c] points. */
  static pathLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return len;
  }
}

/**
 * @typedef {object} FlowField
 * @property {number} dest destination tile key (-1 outside the grid)
 * @property {Int32Array} dist SPFA distance to the destination (-1 = unreachable)
 * @property {Int32Array} parent raw BFS parent
 * @property {Int32Array} pen non-blockable tiles on the raw chain (tie-break among equal `dist`)
 * @property {Int32Array} next smoothed parent (the tile to walk straight toward)
 * @property {Float64Array|null} len memoised smoothed length (fieldLength)
 */

/** Bresenham line of sight between tile keys a → b (client `_RaycastBresenhamLine`). */
function bresenhamClear(a, b, clear) {
  let r = (a / COLS) | 0, c = a - r * COLS;
  const r1 = (b / COLS) | 0, c1 = b - r1 * COLS;
  const dr = Math.abs(r1 - r), dc = Math.abs(c1 - c);
  const sr = r1 > r ? 1 : -1, sc = c1 > c ? 1 : -1;
  let err = dc - dr;
  if (!clear(r, c)) return false;
  while (r !== r1 || c !== c1) {
    const e2 = 2 * err;
    let nr = r, nc = c;
    if (e2 > -dr) { err -= dr; nc += sc; }
    if (e2 < dc) { err += dc; nr += sr; }
    if (nr !== r && nc !== c && !(clear(nr, c) && clear(r, nc))) return false;
    r = nr; c = nc;
    if (!clear(r, c)) return false;
  }
  return true;
}

/** Row / column line of sight (client `_RaycastSegmentLine`, routes without diagonal moves). */
function segmentClear(a, b, clear) {
  let r = (a / COLS) | 0, c = a - r * COLS;
  const r1 = (b / COLS) | 0, c1 = b - r1 * COLS;
  if (r !== r1 && c !== c1) return false;
  const sr = Math.sign(r1 - r), sc = Math.sign(c1 - c);
  if (!clear(r, c)) return false;
  while (r !== r1 || c !== c1) {
    r += sr; c += sc;
    if (!clear(r, c)) return false;
  }
  return true;
}

/** Tiles of the Bresenham line [r0,c0] → [r1,c1] (same stepping as bresenhamClear). */
export function bresenhamTiles(a, b) {
  let [r, c] = a;
  const [r1, c1] = b;
  const dr = Math.abs(r1 - r), dc = Math.abs(c1 - c);
  const sr = r1 > r ? 1 : -1, sc = c1 > c ? 1 : -1;
  let err = dc - dr;
  const out = [[r, c]];
  let guard = 256;
  while ((r !== r1 || c !== c1) && guard-- > 0) {
    const e2 = 2 * err;
    if (e2 > -dr) { err -= dr; c += sc; }
    if (e2 < dc) { err += dc; r += sr; }
    out.push([r, c]);
  }
  return out;
}

/**
 * Whether a straight move from (x, y) to the centre of tile p = {x: col, y: row} only crosses ground-walkable,
 * crate-free tiles (the start and end tiles excepted). Exact grid traversal (tile (r,c) spans c ± 0.5, r ± 0.5); a
 * line through a tile corner needs both side tiles clear (as the grid's Bresenham smoothing).
 */
export function straightClear(g, x, y, p) {
  let c = Math.round(x), r = Math.round(y);
  const dx = p.x - x, dy = p.y - y;
  const sc = dx > 0 ? 1 : -1, sr = dy > 0 ? 1 : -1;
  const ddx = dx !== 0 ? Math.abs(1 / dx) : Infinity, ddy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tx = dx !== 0 ? (c + 0.5 * sc - x) / dx : Infinity;
  let ty = dy !== 0 ? (r + 0.5 * sr - y) / dy : Infinity;
  const clear = (rr, cc) => (rr === p.y && cc === p.x) || (g.walkable(rr, cc) && !(g.obstacle[rr * COLS + cc] & OB_CRATE));
  for (let guard = 4 * COLS; guard > 0 && (r !== p.y || c !== p.x); guard--) {
    if (tx >= 1 && ty >= 1) break;
    if (Math.abs(tx - ty) < 1e-9) {
      if (!clear(r, c + sc) || !clear(r + sr, c)) return false;
      c += sc; r += sr; tx += ddx; ty += ddy;
    } else if (tx < ty) { c += sc; tx += ddx; } else { r += sr; ty += ddy; }
    if (!clear(r, c)) return false;
  }
  return true;
}
