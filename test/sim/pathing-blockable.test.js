// Blockable-ground preference of the ground pathing (grid.js header; user playtest: on 战场#01 the lower-gate enemies
// walked up the col-9 floor lane, where no operator can stand, instead of the col-8 road). Among equal-length routes the
// flow field takes the one with the fewest non-blockable tiles, and smoothing never cuts across floor the grid route
// does not walk. Audit: every active stage × gate × field (normal, 联防 both halves, boss both halves incl. the solo
// `_s` templates) — the non-blockable tiles an enemy still crosses are listed and proven unavoidable (no route of equal
// or near-equal length, up to +2 tiles, crosses fewer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid, bresenhamTiles } from '../../server/sim/grid.js';
import { getDefaultSource, hasGeneratedData, normalizeRoute } from '../../server/sim/simdata.js';
import { GEO } from '../../shared/constants.js';
import { makeBattle, flatStage, chessRec, enemyRec } from '../helpers/battleHarness.js';

const REAL = { skip: !hasGeneratedData() && 'no generated data' };
const COLS = 21;
const STAGES = ['act1autochess_m01', 'act1autochess_m02', 'act1autochess_m03', 'act1autochess_m04', 'act2autochess_m01', 'act2autochess_m02', 'act2autochess_m03', 'act2autochess_m04'];
const walker = (o = {}) => enemyRec({ key: 'enemy_walker', hp: 1e6, speed: 1, ...o });
const guard = chessRec({ id: 't_guard', profession: 'WARRIOR', stats: { atk: 0, blockCnt: 3, maxHp: 1e6 }, skill: null });

/** Grid of a real stage with its match-start devices (crates cost 1000, platforms / mounds blocked). */
function stageGrid(id, rect) {
  const st = getDefaultSource().getStage(id);
  const g = new Grid(st, rect);
  for (const d of st.raw.devices) {
    if (!d.active || !d.pos) continue;
    if (d.role === 'crate') g.setObstacle(d.pos[0], d.pos[1], true, 'crate');
    if (d.role === 'platform' || d.role === 'mound') g.setObstacle(d.pos[0], d.pos[1], true);
  }
  return g;
}

/** Every tile the enemy's rounded position can take on the smoothed route: Bresenham tiles + diagonal-step corners. */
function covered(wp) {
  const out = [wp[0]];
  for (let i = 1; i < wp.length; i++) {
    const seg = bresenhamTiles(wp[i - 1], wp[i]);
    for (let j = 1; j < seg.length; j++) {
      const [r0, c0] = seg[j - 1], [r1, c1] = seg[j];
      if (r0 !== r1 && c0 !== c1) out.push([r1, c0], [r0, c1]);
      out.push(seg[j]);
    }
  }
  return out;
}

/** Non-blockable tiles crossed from s to e (start and goal excluded), in route order. */
function nbCrossed(g, s, e) {
  const wp = g.waypoints(s[0], s[1], e[0], e[1]);
  assert.ok(wp, `(${s}) → (${e}) reachable`);
  const seen = new Set();
  for (const [r, c] of covered(wp)) {
    const k = `${r},${c}`;
    if ((r === s[0] && c === s[1]) || (r === e[0] && c === e[1]) || g.blockable(r, c)) continue;
    assert.ok(g.walkable(r, c), `(${s}) → (${e}) crosses unwalkable (${k})`);
    seen.add(k);
  }
  return [...seen];
}

/**
 * Fewest non-blockable tiles (start and goal excluded) over all 4-connected crate-free routes s → e of length ≤ the
 * shortest + `slack`; { best, min } (min = the minimum over those lengths).
 */
function fewestNb(g, s, e, slack = 2) {
  const f = g.flowField(e[0], e[1]);
  const best = f.dist[s[0] * COLS + s[1]];
  if (best < 0 || best >= 1000) return null;
  const ek = e[0] * COLS + e[1];
  const cost = (k) => (k === ek ? 0 : g.unblockable[k]);
  let cur = new Map([[s[0] * COLS + s[1], 0]]);
  let min = Infinity;
  for (let L = 0; L <= best + slack; L++) {
    if (cur.has(ek)) min = Math.min(min, cur.get(ek));
    const nx = new Map();
    for (const [k, p] of cur) {
      if (k === ek) continue;
      const r = (k / COLS) | 0, c = k % COLS;
      for (const [dr, dc] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const nr = r + dr, nc = c + dc;
        if (!g.walkable(nr, nc) || g.isCrate(nr, nc)) continue;
        const nk = nr * COLS + nc, np = p + cost(nk);
        if (!nx.has(nk) || nx.get(nk) > np) nx.set(nk, np);
      }
    }
    cur = nx;
  }
  return { best, min };
}

/** Tiles an enemy of `route` visits (rounded position per tick) and whether `u` blocked it. */
function walk(h) {
  const seen = [];
  h.b.on('tick', () => {
    for (const e of h.b.enemies) {
      const k = `${Math.round(e.y)},${Math.round(e.x)}`;
      if (seen[seen.length - 1] !== k) seen.push(k);
    }
  });
  return seen;
}

// ---------------------------------------------------------------------------------------------------------------

test('equal-length lanes: the road (blockable) lane wins over the floor lane whichever side it is on', () => {
  //         col 0123456789 10
  // row 12  ##hrrrrrrrh      top road, row 12 cols 3..9
  // row 11  ##hrhhhhXYh      two lanes up from (9,9): X = col 8, Y = col 9 (one road, one floor)
  // row 10  ##hrhhhhXYh
  // row  9  ##Er####rrS      gate (9,10) → (9,9); goal (9,2)
  const mk = (x, y) => flatStage({ rows: {
    12: '##hrrrrrrrh##########', 11: `##hrhhhh${x}${y}h##########`, 10: `##hrhhhh${x}${y}h##########`, 9: '##Er####rrS##########',
  } });
  for (const [x, y, lane] of [['r', 'f', 8], ['f', 'r', 9]]) {
    const g = new Grid(mk(x, y), GEO.NORMAL_RECT);
    const f = g.flowField(9, 2);
    assert.equal(f.dist[9 * COLS + 10], 14, 'same official length either way');
    assert.equal(f.pen[9 * COLS + 10], 1, 'only the gate tile is non-blockable on the chosen chain');
    const path = g.findPath(9, 10, 9, 2).map((p) => p.join());
    for (const r of [10, 11]) assert.ok(path.includes(`${r},${lane}`), `lane col ${lane}: ${path.join(' ')}`);
    assert.deepEqual(nbCrossed(g, [9, 10], [9, 2]), [], `no floor crossed (road in col ${lane})`);
  }
});

test('smoothing never cuts a corner across floor that the grid route does not walk', () => {
  // open road field with a floor column at col 9 (rows 10–12): the diagonal shortcut (9,9) → (12,8) would pass the
  // floor of (10,9) / (11,9); the route must go up the road of col 8 instead
  const rows = { 12: '##hrrrrrrrfS#########', 11: '##hrrrrrrrf##########', 10: '##hrrrrrrrf##########', 9: '##ErrrrrrrrS#########' };
  const g = new Grid(flatStage({ rows }), GEO.NORMAL_RECT);
  for (const s of [[9, 9], [9, 10]]) {
    const wp = g.waypoints(s[0], s[1], 12, 3);
    for (const [r, c] of covered(wp)) assert.ok(g.blockable(r, c) || (r === s[0] && c === s[1]), `(${s}) → (12,3) crosses (${r},${c}): ${JSON.stringify(wp)}`);
  }
  // the straight line stays when it only crosses blockable ground
  assert.deepEqual(g.waypoints(9, 9, 12, 3), [[9, 9], [12, 3]]);
});

test('the preference is only a tie-break: crates keep cost 1000, route lengths stay the official ones', REAL, () => {
  // 战场#01 lower gate: a crate on the col-8 road makes the floor lane strictly shorter → it is taken again
  const g = stageGrid('act1autochess_m01', GEO.NORMAL_RECT);
  const len0 = g.flowField(9, 2).dist[9 * COLS + 10];
  g.setObstacle(10, 8, true, 'crate');
  const f = g.flowField(9, 2);
  assert.equal(f.dist[9 * COLS + 10], len0, 'the floor lane has the same length');
  const path = g.findPath(9, 10, 9, 2).map((p) => p.join());
  assert.ok(!path.includes('10,8'), `detours around the crate: ${path.join(' ')}`);
  assert.ok(path.includes('10,9') && path.includes('11,9'), `up the floor lane: ${path.join(' ')}`);
  // wall off the floor lane too: through the crate (1000) rather than nothing
  g.setObstacle(10, 9, true);
  assert.ok(g.flowField(9, 2).dist[9 * COLS + 10] > 1000);
  assert.ok(g.findPath(9, 10, 9, 2).some(([r, c]) => r === 10 && c === 8), 'through the crate');
  // determinism: an identical grid gives identical fields
  const a = stageGrid('act2autochess_m03', GEO.UNITE_RECT).flowField(9, 2), b = stageGrid('act2autochess_m03', GEO.UNITE_RECT).flowField(9, 2);
  assert.deepEqual([...a.next], [...b.next]);
  assert.deepEqual([...a.pen], [...b.pen]);
});

test('战场#01 (user report): a lower-gate enemy keeps to the col-8 road and an operator on (10,8) blocks it', REAL, () => {
  const g = stageGrid('act1autochess_m01', GEO.NORMAL_RECT);
  assert.deepEqual(g.waypoints(9, 10, 9, 2), [[9, 10], [9, 8], [12, 8], [12, 4], [9, 4], [9, 2]]);
  const route = { motion: 'WALK', start: [9, 10], end: [9, 2], checkpoints: [] };
  // unblocked: the tiles it walks never include the col-9 floor
  const h0 = makeBattle({ stageId: 'act1autochess_m01', defs: { enemies: { enemy_walker: walker() } }, enemies: [{ key: 'enemy_walker', route }], content: 'none', autoFinish: false, timeLimit: 120 });
  const seen = walk(h0);
  h0.runUntil(() => h0.b.enemies.length === 0 && h0.b.time > 1, 120);
  assert.equal(h0.result().perPlayer.p1.leaked.length, 1);
  for (const t of ['10,9', '11,9', '12,9']) assert.ok(!seen.includes(t), `never on floor ${t}: ${seen.join(' ')}`);
  for (const t of ['9,9', '9,8', '10,8', '11,8', '12,8']) assert.ok(seen.includes(t), `on road ${t}: ${seen.join(' ')}`);
  // an operator on the col-8 road right above the exit blocks it (also the 联防 field and the checkpoint routes)
  for (const [kind, rt] of [['normal', route], ['unite', route], ['normal', { motion: 'WALK', start: [9, 10], end: [9, 2], checkpoints: [[9, 9]] }]]) {
    for (const tile of [[10, 8], [9, 8]]) {
      const h = makeBattle({ stageId: 'act1autochess_m01', kind, defs: { chess: { t_guard: guard }, enemies: { enemy_walker: walker() } },
        units: [{ chessId: 't_guard', row: tile[0], col: tile[1] }], enemies: [{ key: 'enemy_walker', route: rt }], content: 'none', autoFinish: false, timeLimit: 60 });
      const u = h.unit('t_guard');
      assert.ok(h.runUntil(() => h.enemies()[0]?.blockedBy === u, 30), `${kind} ${JSON.stringify(rt.checkpoints)}: blocked on (${tile})`);
    }
  }
});

// The non-blockable tiles each gate's route still crosses (start and goal excluded), per stage and field — every one
// proven unavoidable below. normal: lower (9,10) / upper (12,10) gate → (9,2); 联防: the partner half's gates (9,18) /
// (12,18) → (9,2) (the own-half gates as in normal); boss: (5,10) / (2,10) → left goal (1,3) and (2,2) | the mirrored
// right half → (1,17) and (2,18).
const UNAVOIDABLE = {
  act1autochess_m01: { low: '', up: '12,9', uLow: '9,10', uUp: '12,17 9,10', b5: '5,9|5,11', b2: '|' },
  act1autochess_m02: { low: '10,9 11,9', up: '12,9', uLow: '10,17 11,17 12,10 12,9', uUp: '12,17 12,10 12,9', b5: '5,9|5,11', b2: '3,9 4,9|3,11 4,11' },
  act1autochess_m03: { low: '', up: '12,9', uLow: '9,10', uUp: '12,17 9,10', b5: '5,9|5,11', b2: '|' },
  act1autochess_m04: { low: '', up: '12,9 11,9', uLow: '9,10', uUp: '12,17 11,17 9,10', b5: '5,9 4,9|5,11 4,11', b2: '|' },
  act2autochess_m01: { low: '', up: '12,9 11,9 10,9', uLow: '9,10', uUp: '12,17 11,17 10,17 9,10', b5: '5,9 4,9 3,9|5,11 4,11 3,11', b2: '|' },
  act2autochess_m02: { low: '', up: '12,9', uLow: '9,10', uUp: '12,17 9,10', b5: '5,9|5,11', b2: '|' },
  act2autochess_m03: { low: '10,9', up: '12,9', uLow: '10,17 9,10 10,9', uUp: '12,17 9,10 10,9', b5: '5,9|5,11', b2: '3,9|3,11' },
  act2autochess_m04: { low: '', up: '12,9', uLow: '9,10', uUp: '12,17 9,10', b5: '5,9|5,11', b2: '|' },
};

test('audit: every active stage × gate × field — the non-blockable tiles crossed are exactly the listed unavoidable ones', REAL, () => {
  let n = 0;
  for (const sid of STAGES) {
    const exp = UNAVOIDABLE[sid];
    const nrm = stageGrid(sid, GEO.NORMAL_RECT), uni = stageGrid(sid, GEO.UNITE_RECT), bos = stageGrid(sid, GEO.BOSS_RECT);
    const check = (g, s, e, want, what) => {
      const got = nbCrossed(g, s, e);
      assert.equal(got.join(' '), want, `${sid} ${what} (${s}) → (${e}): non-blockable tiles crossed`);
      const m = fewestNb(g, s, e, 2);
      assert.ok(m, `${sid} ${what}: reachable without crates`);
      assert.equal(got.length, m.min, `${sid} ${what} (${s}) → (${e}): a route of length ≤ ${m.best}+2 crosses only ${m.min}`);
      n++;
    };
    check(nrm, [9, 10], [9, 2], exp.low, 'normal lower gate');
    check(nrm, [12, 10], [9, 2], exp.up, 'normal upper gate');
    check(uni, [9, 10], [9, 2], exp.low, '联防 own lower gate');
    check(uni, [12, 10], [9, 2], exp.up, '联防 own upper gate');
    check(uni, [9, 18], [9, 2], exp.uLow, '联防 partner lower gate');
    check(uni, [12, 18], [9, 2], exp.uUp, '联防 partner upper gate');
    const [b5L, b5R] = exp.b5.split('|'), [b2L, b2R] = exp.b2.split('|');
    for (const e of [[1, 3], [2, 2]]) { check(bos, [5, 10], e, b5L, 'boss left'); check(bos, [2, 10], e, b2L, 'boss left'); }
    for (const e of [[1, 17], [2, 18]]) { check(bos, [5, 10], e, b5R, 'boss right'); check(bos, [2, 10], e, b2R, 'boss right'); }
  }
  assert.equal(n, STAGES.length * 14);
});

test('audit: every WALK leg of every wave template (normal / 联防 / boss / hidden, solo _s too) on every active stage', REAL, () => {
  const src = getDefaultSource();
  const rectOf = { normal: GEO.NORMAL_RECT, training: GEO.NORMAL_RECT, escaped: GEO.UNITE_RECT, boss: GEO.BOSS_RECT, hidden: GEO.BOSS_RECT };
  const legs = new Map();
  for (const id of src.waveIds()) {
    const w = src.getWave(id);
    const rect = rectOf[w && w.kind];
    if (!rect) continue;
    for (const raw of [...(w.routes || []), ...(w.extraRoutes || [])]) {
      const rt = normalizeRoute(raw);
      if (!rt || rt.motion !== 'WALK' || !rt.start || !rt.end) continue;
      let from = rt.start;
      const hop = (to) => {
        const k = `${w.kind}|${from}|${to}`;
        if (from.join() !== to.join() && !legs.has(k)) legs.set(k, { rect, from, to, id });
        from = to;
      };
      for (const cp of rt.checkpoints) {
        if (cp.type === 'MOVE') hop(cp.pos);
        else if (cp.type === 'APPEAR') from = cp.pos;
      }
      hop(rt.end);
    }
  }
  assert.ok(legs.size >= 30, `${legs.size} distinct legs`);
  // Exceptions to the near-equal (+2 tiles) rule, all accepted: boss / hidden-leader legs whose ends lie in or next to
  // the boss arena's central floor (rows 3–5 × cols 9–11: the (5,10) / (2,10) teleport exits, boss_8's parts and
  // patrols); a blockable detour around that floor is ≥ 2 tiles longer, and the official route length is kept.
  const arena = (t) => { const [r, c] = t.split(',').map(Number); return r >= 3 && r <= 5 && c >= 9 && c <= 11; };
  let n = 0, extra = 0, accepted = 0;
  for (const sid of STAGES) {
    const grids = new Map();
    for (const { rect, from, to, id } of legs.values()) {
      const key = JSON.stringify(rect);
      if (!grids.has(key)) grids.set(key, stageGrid(sid, rect));
      const g = grids.get(key);
      if (!g.walkable(from[0], from[1]) || !g.walkable(to[0], to[1])) continue;
      const eq = fewestNb(g, from, to, 0);
      if (!eq) continue;
      const got = nbCrossed(g, from, to);
      const what = `${sid} ${id} (${from}) → (${to}) crosses ${got.join(' ')}`;
      assert.equal(got.length, eq.min, `${what}, an equal-length route only ${eq.min}`);
      const near = fewestNb(g, from, to, 2);
      if (near.min < got.length) {
        assert.ok(rect === GEO.BOSS_RECT && got.every(arena), `${what}: a route of length ≤ ${near.best}+2 crosses only ${near.min}`);
        accepted++;
      }
      extra += got.length;
      n++;
    }
  }
  assert.ok(n > 200, `${n} legs audited (${extra} unavoidable non-blockable crossings)`);
  assert.equal(accepted, 17, 'accepted boss-arena exceptions (update the count only after reviewing a new one)');
});

// ---------------------------------------------------------------------------------------------------------------
// adversarial review (pathing workstream): end-to-end blocking on every map, map-card crate changes, random layouts,
// bounded deviation from the official smoothed route

/** Legs of the standard gates / exits per field kind (field coordinates). */
const GATE_LEGS = [
  ['normal', [9, 10], [9, 2]], ['normal', [12, 10], [9, 2]],
  ['unite', [9, 18], [9, 2]], ['unite', [12, 18], [9, 2]], ['unite', [9, 10], [9, 18]],
  ['boss', [5, 10], [1, 3]], ['boss', [2, 10], [2, 2]], ['boss', [5, 10], [2, 18]], ['boss', [2, 10], [1, 17]],
];

test('every map (user: "检查所有的地图"): an operator on ANY road tile the enemy walks over blocks it — normal gates, 联防 partner gates, boss exits', REAL, () => {
  const fast = enemyRec({ key: 'enemy_walker', hp: 1e6, speed: 3 });
  let n = 0;
  for (const sid of STAGES) {
    for (const [kind, start, end] of GATE_LEGS) {
      const route = { motion: 'WALK', start, end, checkpoints: [] };
      const h0 = makeBattle({ stageId: sid, kind, defs: { enemies: { enemy_walker: fast } }, enemies: [{ key: 'enemy_walker', route }], content: 'none', autoFinish: false, timeLimit: 120 });
      const seen = new Set();
      h0.b.on('tick', () => { for (const e of h0.b.enemies) seen.add(`${Math.round(e.y)},${Math.round(e.x)}`); });
      h0.runUntil(() => h0.b.enemies.length === 0 && h0.b.time > 1, 120);
      assert.equal(h0.result().perPlayer.p1.leaked.length, 1, `${sid} ${kind} (${start}) → (${end}) leaks unblocked`);
      const g = h0.b.grid;
      const road = [...seen].map((k) => k.split(',').map(Number)).filter(([r, c]) => g.blockable(r, c) && !g.isObstacle(r, c));
      assert.ok(road.length >= 3, `${sid} ${kind} (${start}) → (${end}) walks road: ${[...seen].join(' ')}`);
      for (const [r, c] of road) {
        const h = makeBattle({ stageId: sid, kind, defs: { chess: { t_guard: guard }, enemies: { enemy_walker: fast } },
          units: [{ chessId: 't_guard', row: r, col: c, abs: true }], enemies: [{ key: 'enemy_walker', route }], content: 'none', autoFinish: false, timeLimit: 120 });
        const u = h.unit('t_guard');
        assert.ok(u && u.tileR === r && u.tileC === c, `${sid} ${kind}: guard deployed on (${r},${c})`);
        assert.ok(h.runUntil(() => h.enemies()[0]?.blockedBy === u, 60), `${sid} ${kind} (${start}) → (${end}): a guard on road (${r},${c}) of the route never blocks`);
        n++;
      }
    }
  }
  assert.ok(n > 600, `${n} guard placements`);
});

test('map cards (移除全部阻隔工事 / 阻隔工事变为射击台): with the crates gone or turned into platforms, no equal-length route crosses fewer non-blockable tiles', REAL, () => {
  let n = 0;
  for (const mode of ['removed', 'platform']) {
    for (const sid of STAGES) {
      const st = getDefaultSource().getStage(sid);
      for (const [kind, s, e] of GATE_LEGS) {
        const g = new Grid(st, kind === 'normal' ? GEO.NORMAL_RECT : kind === 'unite' ? GEO.UNITE_RECT : GEO.BOSS_RECT);
        for (const d of st.raw.devices) {
          if (!d.active || !d.pos) continue;
          if ((d.role === 'crate' && mode === 'platform') || d.role === 'platform' || d.role === 'mound') g.setObstacle(d.pos[0], d.pos[1], true);
        }
        const got = nbCrossed(g, s, e);
        const m = fewestNb(g, s, e, 0);
        assert.equal(got.length, m.min, `${sid} crates ${mode} ${kind} (${s}) → (${e}) crosses ${got.join(' ')}; an equal-length route only ${m.min}`);
        n++;
      }
    }
  }
  assert.equal(n, 2 * STAGES.length * GATE_LEGS.length);
});

test('deviation from the official route is bounded: same grid length everywhere, smoothed polyline ≤ 2 tiles longer', REAL, () => {
  // the official algorithm = the same flow field with every tile counted blockable (no tie-break, no smoothing limit)
  const pureGrid = (sid, rect) => { const g = stageGrid(sid, rect); g.unblockable.fill(0); return g; };
  const fields = [[GEO.NORMAL_RECT, [[9, 2]]], [GEO.UNITE_RECT, [[9, 2], [9, 18]]], [GEO.BOSS_RECT, [[1, 3], [2, 2], [1, 17], [2, 18]]]];
  let n = 0, longer = 0, worst = 0;
  for (const sid of STAGES) {
    for (const [rect, dests] of fields) {
      const ours = stageGrid(sid, rect), pure = pureGrid(sid, rect);
      for (const [er, ec] of dests) {
        const fo = ours.flowField(er, ec), fp = pure.flowField(er, ec);
        assert.deepEqual([...fo.dist], [...fp.dist], `${sid} → (${er},${ec}): official distances`);
        for (let r = rect.r0; r <= rect.r1; r++) {
          for (let c = rect.c0; c <= rect.c1; c++) {
            const k = r * COLS + c;
            if (fo.dist[k] <= 0 || fo.dist[k] >= 1000) continue;
            const d = ours.fieldLength(fo, k) - pure.fieldLength(fp, k);
            assert.ok(d <= 2 + 1e-9, `${sid} (${r},${c}) → (${er},${ec}): ${d.toFixed(2)} tiles longer than official`);
            if (d > 1e-9) longer++;
            worst = Math.max(worst, d);
            n++;
          }
        }
      }
    }
  }
  assert.ok(n > 2000 && longer > 0 && worst > 1, `${n} tiles, ${longer} longer, worst +${worst.toFixed(2)}`);
});

test('random layouts: official lengths, fewest non-blockable tiles among equal-length chains, no off-chain floor / crate / wall on a smoothed segment', () => {
  let seed = 20260929;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const RECT = GEO.UNITE_RECT;
  const N = 19 * COLS;
  for (let t = 0; t < 400; t++) {
    const rows = Array.from({ length: 19 }, () => '#'.repeat(COLS));
    for (let r = RECT.r0; r <= RECT.r1; r++) rows[r] = Array.from({ length: COLS }, () => { const x = rnd(); return x < 0.55 ? 'r' : x < 0.85 ? 'f' : '#'; }).join('');
    const g = new Grid({ rows }, RECT), p = new Grid({ rows }, RECT);
    p.unblockable.fill(0);
    for (let i = Math.floor(rnd() * 5); i > 0; i--) { const r = 9 + Math.floor(rnd() * 4), c = Math.floor(rnd() * COLS); g.setObstacle(r, c, true, 'crate'); p.setObstacle(r, c, true, 'crate'); }
    for (let i = Math.floor(rnd() * 3); i > 0; i--) { const r = 9 + Math.floor(rnd() * 4), c = Math.floor(rnd() * COLS); g.setObstacle(r, c, true); p.setObstacle(r, c, true); }
    const er = 9 + Math.floor(rnd() * 4), ec = Math.floor(rnd() * COLS), dest = er * COLS + ec;
    const f = g.flowField(er, ec), fp = p.flowField(er, ec);
    const what = `layout ${t} → (${er},${ec})\n${rows.slice(9, 13).reverse().join('\n')}`;
    assert.deepEqual([...f.dist], [...fp.dist], `${what}: official distances`);
    // the fewest non-blockable tiles over all shortest chains (DP in distance order) = pen
    const order = [...Array(N).keys()].filter((k) => f.dist[k] >= 0).sort((a, b) => f.dist[a] - f.dist[b]);
    const best = new Int32Array(N).fill(1e9);
    for (const k of order) {
      if (k === dest) { best[k] = 0; continue; }
      const r = (k / COLS) | 0, c = k % COLS, cost = g.isCrate(r, c) ? 1000 : 1;
      for (const [dr, dc] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const nk = (r + dr) * COLS + c + dc;
        if (g.inBounds(r + dr, c + dc) && f.dist[nk] >= 0 && f.dist[nk] + cost === f.dist[k]) best[k] = Math.min(best[k], best[nk] + g.unblockable[k]);
      }
      assert.equal(f.pen[k], best[k], `${what}: (${r},${c}) pen`);
    }
    // smoothed chains: strictly closer each hop; segments cross only walkable, crate-free tiles and on-chain floor
    for (const k of order) {
      if (k === dest) continue;
      const chain = new Set();
      for (let x = k; x >= 0; x = f.parent[x]) chain.add(x);
      for (let x = k; x !== dest;) {
        const y = f.next[x];
        assert.ok(y >= 0 && f.dist[y] < f.dist[x], `${what}: next of ${x}`);
        const a = [(x / COLS) | 0, x % COLS], b = [(y / COLS) | 0, y % COLS];
        const hop = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
        for (const [r, c] of covered([a, b])) {
          const kk = r * COLS + c;
          if (kk === dest || hop) continue;
          assert.ok(g.walkable(r, c) && !g.isCrate(r, c), `${what}: (${a}) → (${b}) crosses (${r},${c})`);
          assert.ok(!g.unblockable[kk] || chain.has(kk), `${what}: (${a}) → (${b}) cuts across off-chain floor (${r},${c})`);
        }
        x = y;
      }
    }
  }
});
