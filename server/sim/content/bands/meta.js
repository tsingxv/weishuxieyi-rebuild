// server/sim/content/bands/meta.js — prep side of the 40 strategies (bands, data/bands.json).
//
// Every band handler is assembled from the band's buffs by their official buff key (numbers from bb / bbStr, never
// hard-coded); keys that only act in battle (env_gbuff_new_with_verify, auto_chess_change_map) live in battle.js.
// Starting LP (totalHp) and 坎诺特's leftover funds are the match's own rules.
//
//   prep_finish_char_bond_add_layer {layer}            华法琳   prep end: per distinct board tier, 1 random op → its bonds +layer (无需激活)
//   band_first_self_refresh_present_char {count,bond}  杜遥夜   first 2 manual refreshes/round: ≥count <bond> chess (tier ≤ shop level)
//   band_shop_refresh_copy_max_lv_char {count}         梓兰     every manual refresh: highest-tier shop chess copied into another slot, copy frozen
//   preparation_start_gain_chess_from_round {round}    梓兰/小贾斯汀/昆图斯/马克维茨/变形者集群/Pith/夕/杰西卡/缪尔赛思/芬  round start of `round`: bbStr.chess
//   preparation_start_gain_chess_every_n_round {round} 杜宾     every `round` rounds (round % n = 0): bbStr.chess
//   give_coin_in_round {round,coin}                    老鲤     income of round `round` = coin (R1/R2 0, R3 15)
//   prep_start_gain_chess_from_pool_in_round {round}   老鲤     round start of `round`: 1 chess of pool
//   band_coin_cost_gain_random_char_by_shop_level      绮良     every coin_cnt funds spent → count random chess ≤ shop level
//   up_shop_next_refresh_must_present_bond_char        佩佩     level-up to a level of lvlist → +1 free refresh (price 0) that prefers <bond>
//   gain_bond_char_per_round {round,preround,bond}     哈洛德   rounds round, round+preround, …: a <bond> chess (≤ shop level, else any tier)
//   first_buy_in_round_char_price_change {price,bond}  休露丝   first <bond> chess of the round costs `price`
//   band_cost_coin_reach_cnt_gain_chess_from_pool      潘格尼尼 once coin_cnt funds spent in total: 1 chess of pool (elite 拉特兰 ≥ T4)
//   round_start_bond_check_gain_layer                  余       round start of `round`: exactly factioncount active bonds → +count1, else each active +count2
//   up_shop_add_special_goods {count,choice,pool}      凯瑟琳   every level-up: pick 1 of `count` items of pool (free)
//   coin_carry_over {capital,interest,max}             坎诺特   leftover ≥ capital at round start → +min(max, ⌊left/capital⌋×interest) income
//   round_start_all_player_change_enemy_2              鸭爵     global: every alive player's normal battle from `round` (own + teammates)
//   round_start_activate_char_chess_effect_in_board    铃兰     round start: 获得时 traits of the right-most (then bottom-most) board op with one
//   first_sell_char_chess_exchange_char_chess_in_shop  巫恋     first sale of a normal op per round: swapped with a random shop chess (no funds)
//   round_start_gain_char_chess_in_shop_every_n_round  松桐     round % n = 0: a random shop chess for free (its slot empties)
//   round_start_gain_coin_by_bond_char_chess_buy       玛恩纳   each <bond> chess bought → +count funds next round (≤ max_count / round)
//   refresh_shop_count_gain_coin_bond_char_chess       贾维     every refresh_count manual refreshes (match total) → <bond> chess ≤ shop level (≤ max_count / round)
//   preparation_start_add_special_goods_every_n_round  娜仁图亚 round % n = 0: pick choice_cnt of refresh_cnt items of pool (free)
// "进入休整期时" / "回合开始时" = onRoundStart (research 01 §5 step 6).

import { buffsOf, num, bandRecord, gameData } from '../support/index.js';
import { metaBonds } from '../support/meta.js';
import * as garrisons from '../garrisons.js';

const int = (v, d = 0) => Math.trunc(num(v, d));
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const hasBond = (ctx, id, bond) => { const c = ctx.gd.chess(id); return !!(c && Array.isArray(c.bonds) && c.bonds.includes(bond)); };
const isNormalChess = (ctx, id) => { const c = ctx.gd.chess(id); return !!(c && !c.isGolden); };

/** Per-round counter: reset lazily when the round changes. */
function roundCounter(ctx, key) {
  if (ctx.counter(`${key}:r`) !== ctx.round) { ctx.setCounter(`${key}:r`, ctx.round); ctx.setCounter(key, 0); }
  return ctx.counter(key);
}
const bumpRound = (ctx, key, n = 1) => { roundCounter(ctx, key); return ctx.incCounter(key, n); };

/** Grant a chess or an item by id. */
function grant(ctx, id, opts = {}) {
  if (ctx.gd.item(id)) return ctx.grantItem(id, opts);
  if (ctx.gd.chess(id)) return ctx.grantChess(id, opts);
  return null;
}

/** Indices of unsold chess slots of the shop. */
const chessSlots = (ctx) => ctx.shopSlots().map((s, i) => (s && s.kind === 'chess' && !s.sold ? i : -1)).filter((i) => i >= 0);

/** Up to `n` distinct item ids of an equip pool. */
function rollItems(ctx, poolId, n) {
  const out = [];
  for (let k = 0; k < n * 6 && out.length < n; k++) {
    const r = ctx.rollPool(poolId);
    if (!r || r.kind !== 'item') break;
    if (!out.includes(r.id)) out.push(r.id);
  }
  return out;
}

/** Random chess of `bond`, tier ≤ shop level (fallback: any tier when `anyTier`). */
function rollBond(ctx, bond, { anyTier = false } = {}) {
  return ctx.rollChess({ bond, maxTier: Math.max(1, ctx.shopLevel()) }) || (anyTier ? ctx.rollChess({ bond, maxTier: 6 }) : null);
}

// ---------------------------------------------------------------------------------------------------------------
// buff key → (params[], bandId) → hooks

const K = {};

K.prep_finish_char_bond_add_layer = (ps) => ({
  onPrepEnd(ctx) {
    const n = int(ps[0].layer, 0);
    if (n <= 0) return;
    const byTier = new Map();
    for (const p of ctx.board()) {
      if (!p || p.kind !== 'chess') continue;
      const t = p.tier ?? ctx.gd.tierOf(p.id);
      if (!byTier.has(t)) byTier.set(t, []);
      byTier.get(t).push(p);
    }
    for (const t of [...byTier.keys()].sort((a, b) => a - b)) {
      const p = ctx.rng.pick(byTier.get(t));
      for (const b of metaBonds(ctx, p)) ctx.addLayers(b, n, { requireActive: false, reason: 'band' });
    }
  },
});

K.band_first_self_refresh_present_char = (ps) => ({
  onRefresh(ctx) {
    const p = ps[0];
    if ((ctx.roundStats().refreshes || 0) > 2) return;
    const need = Math.max(1, int(p.count, 1));
    const idx = chessSlots(ctx);
    const slots = ctx.shopSlots();
    let have = idx.filter((i) => hasBond(ctx, slots[i].id, p.bond)).length;
    const others = ctx.rng.shuffle(idx.filter((i) => !hasBond(ctx, slots[i].id, p.bond)));
    for (const i of others) {
      if (have >= need) break;
      const id = rollBond(ctx, p.bond);
      if (!id) break;
      ctx.setShopSlot(i, { kind: 'chess', id });
      have++;
    }
  },
});

K.band_shop_refresh_copy_max_lv_char = () => ({
  onRefresh(ctx) {
    const slots = ctx.shopSlots();
    const idx = chessSlots(ctx);
    if (idx.length < 2) return;
    let best = -1;
    for (const i of idx) best = Math.max(best, ctx.gd.tierOf(slots[i].id));
    const src = ctx.rng.pick(idx.filter((i) => ctx.gd.tierOf(slots[i].id) === best));
    const dst = ctx.rng.pick(idx.filter((i) => i !== src));
    ctx.setShopSlot(dst, { kind: 'chess', id: slots[src].id, frozen: true });
  },
});

K.preparation_start_gain_chess_from_round = (ps) => ({
  onRoundStart(ctx) {
    for (const p of ps) {
      const id = p.chess ?? p.chess_id;
      if (ctx.round !== int(p.round, -1) || !id) continue;
      for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) grant(ctx, id, { requirePool: false, source: 'band' });
    }
  },
});

K.preparation_start_gain_chess_every_n_round = (ps) => ({
  onRoundStart(ctx) {
    for (const p of ps) {
      const n = int(p.round, 0);
      const id = p.chess ?? p.chess_id;
      if (n <= 0 || ctx.round % n !== 0 || !id) continue;
      for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) grant(ctx, id, { source: 'band' });
    }
  },
});

K.give_coin_in_round = (ps) => ({
  onIncome(ctx, ev) {
    for (const p of ps) if (ctx.round === int(p.round, -1)) ev.income = Math.max(0, int(p.coin, 0));
  },
});

K.prep_start_gain_chess_from_pool_in_round = (ps) => ({
  onRoundStart(ctx) {
    for (const p of ps) {
      if (ctx.round !== int(p.round, -1)) continue;
      for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) {
        const r = ctx.rollPool(p.pool);
        if (r) grant(ctx, r.id, { source: 'band' });
      }
    }
  },
});

K.band_coin_cost_gain_random_char_by_shop_level = (ps) => ({
  onSpend(ctx, ev) {
    const p = ps[0];
    const step = int(p.coin_cnt, 0);
    if (step <= 0 || !(ev.amount > 0)) return;
    let acc = ctx.incCounter('band:kirara:acc', ev.amount);
    while (acc >= step) {
      acc = ctx.incCounter('band:kirara:acc', -step);
      for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) {
        const id = ctx.rollChess({ maxTier: Math.max(1, ctx.shopLevel()) });
        if (id) ctx.grantChess(id, { source: 'band' });
      }
    }
  },
});

K.up_shop_next_refresh_must_present_bond_char = (ps) => ({
  onLevelUp(ctx, ev) {
    const p = ps[0];
    if (!list(p.lvlist).map(Number).includes(ev.level)) return;
    ctx.incCounter('band:pepe:special', 1);
    if (int(p.price, 0) === 0) ctx.grantFreeRefresh(1);
  },
  onRefresh(ctx) {
    if (ctx.counter('band:pepe:special') <= 0) return;
    ctx.incCounter('band:pepe:special', -1);
    const bond = ps[0].bond;
    const slots = ctx.shopSlots();
    for (const i of chessSlots(ctx)) {
      if (hasBond(ctx, slots[i].id, bond)) continue;
      const id = rollBond(ctx, bond);
      if (!id) break;
      ctx.setShopSlot(i, { kind: 'chess', id });
    }
  },
});

K.gain_bond_char_per_round = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    const r0 = int(p.round, 1), every = Math.max(1, int(p.preround, 1));
    if (ctx.round < r0 || (ctx.round - r0) % every !== 0) return;
    for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) {
      const id = rollBond(ctx, p.bond, { anyTier: true });
      if (id) ctx.grantChess(id, { source: 'band' });
    }
  },
});

K.first_buy_in_round_char_price_change = (ps) => ({
  onPrice(ctx, ev) {
    const p = ps[0];
    if (ev.kind !== 'chess' || !hasBond(ctx, ev.id, p.bond)) return;
    if (ctx.counter('band:sciurus:r') === ctx.round) return;
    ctx.setPrice(Math.min(num(ev.price, 0), int(p.price, 1)));
  },
  onBuy(ctx, ev) {
    if (ev.kind === 'chess' && hasBond(ctx, ev.slot.id, ps[0].bond)) ctx.setCounter('band:sciurus:r', ctx.round);
  },
});

K.band_cost_coin_reach_cnt_gain_chess_from_pool = (ps) => ({
  onSpend(ctx, ev) {
    const p = ps[0];
    if (ctx.counter('band:paganini:done') > 0) return;
    const spent = ctx.incCounter('band:paganini:spent', Math.max(0, int(ev.amount, 0)));
    if (spent < int(p.coin_cnt, 0)) return;
    const r = ctx.rollPool(p.pool);
    if (r && grant(ctx, r.id, { source: 'band' })) ctx.setCounter('band:paganini:done', 1);
  },
});

K.round_start_bond_check_gain_layer = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    if (ctx.round !== int(p.round, -1)) return;
    const active = Object.entries(ctx.bonds()).filter(([, b]) => b && b.active).map(([id]) => id);
    if (active.length === int(p.factioncount, 1)) {
      for (const b of active) ctx.addLayers(b, int(p.count1, 0), { requireActive: true, reason: 'band' });
    } else {
      for (const b of active) ctx.addLayers(b, int(p.count2, 0), { requireActive: true, reason: 'band' });
    }
  },
});

K.up_shop_add_special_goods = (ps) => ({
  onLevelUp(ctx) {
    const p = ps[0];
    const ids = rollItems(ctx, p.pool, Math.max(1, int(p.count, 3)));
    if (ids.length) ctx.offerItems(ids, { source: 'band' });
  },
});

K.coin_carry_over = (ps) => ({
  onIncome(ctx, ev) {
    const p = ps[0];
    const cap = int(p.capital, 0), left = ctx.funds();
    if (cap <= 0 || left < cap) return;
    const bonus = Math.min(int(p.max, Infinity), Math.floor(left / cap) * int(p.interest, 0));
    if (bonus > 0) ev.income = int(ev.income, 0) + bonus;
  },
});

K.round_start_activate_char_chess_effect_in_board = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    const event = p.event_type || 'SERVER_GAIN';
    const cands = ctx.board().filter((v) => v && v.kind === 'chess' && ctx.garrisonsOf(v.uid).some((g) => g.eventType === event));
    if (!cands.length) return;
    cands.sort((a, b) => (b.col - a.col) || (a.row - b.row));
    for (const v of cands.slice(0, Math.max(1, int(p.count, 1)))) {
      if (event === 'SERVER_GAIN' && typeof garrisons.triggerGainEffects === 'function') garrisons.triggerGainEffects(ctx, v);
      else ctx.triggerGarrisons(v.uid, event);
    }
  },
});

K.first_sell_char_chess_exchange_char_chess_in_shop = (ps) => ({
  onSold(ctx, ev) {
    const piece = ev.piece;
    if (!piece || piece.kind !== 'chess' || !isNormalChess(ctx, piece.id)) return;
    if (roundCounter(ctx, 'band:vodfox') >= Math.max(1, int(ps[0].count, 1))) return;
    const slots = ctx.shopSlots();
    const idx = chessSlots(ctx);
    if (!idx.length) return;
    const i = ctx.rng.pick(idx);
    const got = ctx.grantChess(slots[i].id, { source: 'band' });
    if (!got) return;
    ctx.setShopSlot(i, { kind: 'chess', id: piece.id });
    ev.gain = 0;
    bumpRound(ctx, 'band:vodfox');
  },
});

K.round_start_gain_char_chess_in_shop_every_n_round = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    const n = int(p.round, 0);
    if (n <= 0 || ctx.round % n !== 0) return;
    for (let k = 0; k < Math.max(1, int(p.count, 1)); k++) {
      const idx = chessSlots(ctx);
      if (!idx.length) return;
      const i = ctx.rng.pick(idx);
      if (ctx.grantChess(ctx.shopSlots()[i].id, { source: 'band' })) ctx.setShopSlot(i, null);
    }
  },
});

K.round_start_gain_coin_by_bond_char_chess_buy = (ps) => ({
  onBuy(ctx, ev) {
    const p = ps[0];
    if (ev.kind !== 'chess' || !hasBond(ctx, ev.slot.id, p.bond)) return;
    const n = int(p.count, 1), max = int(p.max_count, Infinity);
    const used = roundCounter(ctx, 'band:mlynar');
    const add = Math.min(n, max - used);
    if (add <= 0) return;
    ctx.addPendingFunds(add);
    bumpRound(ctx, 'band:mlynar', add);
  },
});

K.refresh_shop_count_gain_coin_bond_char_chess = (ps) => ({
  onRefresh(ctx) {
    const p = ps[0];
    const every = int(p.refresh_count, 0);
    if (every <= 0) return;
    if (ctx.incCounter('band:chiave:refreshes', 1) % every !== 0) return;
    if (roundCounter(ctx, 'band:chiave') >= int(p.max_count, Infinity)) return;
    const id = rollBond(ctx, p.bond);
    if (id && ctx.grantChess(id, { source: 'band' })) bumpRound(ctx, 'band:chiave');
  },
});

K.preparation_start_add_special_goods_every_n_round = (ps) => ({
  onRoundStart(ctx) {
    const p = ps[0];
    const n = int(p.round, 0);
    if (n <= 0 || ctx.round % n !== 0) return;
    const ids = rollItems(ctx, p.pool, Math.max(1, int(p.refresh_cnt, 2)));
    for (let k = 0; k < Math.max(1, int(p.choice_cnt, 1)) && ids.length; k++) ctx.offerItems(ids, { source: 'band' });
  },
});

// ---------------------------------------------------------------------------------------------------------------
// 鸭爵: "你和队友遭遇的部分敌人" — a global handler rewrites the normal-battle spawn list of every alive player while
// the band is held by that player or a teammate. From the `minweight`–`maxweight` share of the wave (time order),
// min..max NORMAL ground enemies are replaced by a random enemylist enemy worth 1 fund to its killer (bounty, also in
// 联防). The originals never exist, so none of their death / kill / leak effects happen.

export const DUCK_BAND = 'band_ducklord';
export const DUCK_COINS = 1;

function duckParams() {
  for (const b of buffsOf(bandRecord(DUCK_BAND))) if (b.key === 'round_start_all_player_change_enemy_2') return b.p;
  return null;
}

/** Rewrite `spawns` in place (exported for tests). Returns the replaced spawn specs. */
export function duckReplace(ctx, spawns, p, ownerPlayerId) {
  const gd = ctx.gd;
  const ducks = list(p.enemylist).filter((k) => gd.enemy(k));
  if (!ducks.length || !Array.isArray(spawns)) return [];
  const lo = Math.max(0, int(p.min, 0)), hi = Math.max(lo, int(p.max, lo));
  const want = lo + ctx.rng.int(hi - lo + 1);
  if (want <= 0) return [];
  // one entry per enemy (split multi-count specs), in spawn-time order
  const flat = [];
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i];
    const cnt = Math.max(1, int(s.count, 1));
    for (let k = 0; k < cnt; k++) flat.push({ i, k, t: num(s.time, 0) + k * num(s.interval, 0) });
  }
  flat.sort((a, b) => a.t - b.t || a.i - b.i || a.k - b.k);
  const w0 = num(p.minweight, 0), w1 = num(p.maxweight, 1);
  const n = flat.length;
  const ok = flat.filter((f, j) => {
    const s = spawns[f.i];
    const e = gd.enemy(s.enemyKey);
    const frac = n > 1 ? j / (n - 1) : 0;
    return !s.tag && e && e.rank === 'NORMAL' && e.stats?.motion !== 'FLY' && frac >= w0 - 1e-9 && frac <= w1 + 1e-9;
  });
  const picked = ctx.rng.shuffle(ok).slice(0, want);
  if (!picked.length) return [];
  const byIdx = new Map();
  for (const f of picked) { if (!byIdx.has(f.i)) byIdx.set(f.i, new Set()); byIdx.get(f.i).add(f.k); }
  const out = [];
  const add = [];
  for (const [i, ks] of byIdx) {
    const s = spawns[i];
    const cnt = Math.max(1, int(s.count, 1));
    const keep = cnt - ks.size;
    for (const k of ks) {
      const d = {
        ...s, mods: s.mods ? { ...s.mods } : undefined, count: 1, interval: 0,
        time: num(s.time, 0) + k * num(s.interval, 0), enemyKey: ctx.rng.pick(ducks), tag: 'duck',
        bounty: { coins: DUCK_COINS, ownerPlayerId },
      };
      if (d.mods) delete d.mods.slot;
      add.push(d);
      out.push(d);
    }
    if (keep <= 0) spawns[i] = null;
    else if (ks.size) {
      // keep the unreplaced copies of a multi-count spec as single specs at their original times
      const rest = [];
      for (let k = 0; k < cnt; k++) if (!ks.has(k)) rest.push({ ...s, mods: s.mods ? { ...s.mods } : undefined, count: 1, interval: 0, time: num(s.time, 0) + k * num(s.interval, 0) });
      spawns[i] = null;
      add.push(...rest);
    }
  }
  for (let i = spawns.length - 1; i >= 0; i--) if (spawns[i] == null) spawns.splice(i, 1);
  spawns.push(...add);
  return out;
}

const duckGlobal = {
  onBattleStart(ctx, ev) {
    if (!ev || ev.kind !== 'normal' || !Array.isArray(ev.spawns)) return;
    const p = duckParams();
    if (!p || ctx.round < int(p.round, 1)) return;
    const held = ctx.bandId() === DUCK_BAND || ctx.teammates().some((t) => t.bandId() === DUCK_BAND);
    if (!held) return;
    duckReplace(ctx, ev.spawns, p, ctx.playerId);
  },
};

// ---------------------------------------------------------------------------------------------------------------

/** Merge hook objects (same hook → called in order). */
function merge(parts) {
  const out = {};
  for (const h of parts) {
    for (const [name, fn] of Object.entries(h)) {
      if (typeof fn !== 'function') continue;
      const prev = out[name];
      out[name] = prev ? function merged(ctx, ev) { prev(ctx, ev); fn(ctx, ev); } : fn;
    }
  }
  return out;
}

/** Hooks of one band (null when it has no prep effect). */
export function bandMetaHandler(bandId) {
  const groups = new Map();
  for (const b of buffsOf(bandRecord(bandId))) {
    if (!b.key || !K[b.key]) continue;
    if (!groups.has(b.key)) groups.set(b.key, []);
    groups.get(b.key).push(b.p);
  }
  if (!groups.size) return null;
  return merge([...groups].map(([k, ps]) => K[k](ps, bandId)));
}

export function registerMeta(registry) {
  for (const id of Object.keys(gameData().bands || {})) {
    const h = bandMetaHandler(id);
    if (h) registry.band(id, h);
  }
  registry.global('bands_ducklord', duckGlobal);
}
