// The player's permanent 战绩.
//
// Nothing on the server outlives a restart — `buildResult` is pushed once and the shared `m.result`
// slice is cleared when the player leaves the settlement screen — so the client is the only place a
// match can be remembered (shared/constants.js points at this file for exactly that reason). Every
// finished match is appended here by the result screen and read back for its 我的战绩 panel.
//
// Storage is best-effort: private mode, a disabled localStorage or a full quota must never break the
// settlement screen, so reads and writes are wrapped and the module keeps an in-memory copy for the
// session. A corrupt or hand-edited slot degrades to "no history" rather than throwing.
//
// Stored entry (kept small on purpose — 50 of them share one slot):
//   { at, victory, roundsPassed, durationMs, difficulty, modeId, hiddenCleared, titleName, profileId,
//     players: [{ name, isBot, victory, roundsPassed, titleName }] }
// `titleName` is the 评语 *I* earned and `hiddenCleared` the 隐秘核心 outcome: both are what
// summarize() counts, so they are stored even though the panel only shows a couple of them.

import { loadProfile } from './profile.js';

/** localStorage slot. Deliberately not `sp.pref.*`: this is data written on every match, not a preference. */
export const HISTORY_KEY = 'sp.history.v1';
/** Matches kept; older ones fall off the end of the ring. */
export const HISTORY_KEEP = 50;
/** Serialized cap (~192 KB) — one slot of the shared 5 MB quota, far above 50 real entries. */
export const HISTORY_MAX_CHARS = 192 * 1024;
/** Two identical payloads inside this window are the same match seen twice (a remounted screen). */
const DEDUPE_MS = 10000;
/** Seats recorded per match (MAX_SEATS is 4; the slack only tolerates a larger future roster). */
const PLAYERS_MAX = 8;
/** Longest nickname stored per player. */
const NAME_MAX_STORE = 64;

/** Session fallback used only when nothing can be persisted. */
let memory = null;

function safeGet(key) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return typeof raw === 'string' ? raw : null;
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

/**
 * The 评语 name of a player entry, tolerating everything the payload may hold: the server sends
 * `title: { id, name, … } | null`, a stored entry keeps the flattened `titleName`.
 * @param {{ titleName?: string, title?: any }|null|undefined} playerEntry
 * @returns {string|null}
 */
export function titleNameOf(playerEntry) {
  if (!playerEntry || typeof playerEntry !== 'object') return null;
  if (typeof playerEntry.titleName === 'string' && playerEntry.titleName) return playerEntry.titleName;
  const t = playerEntry.title;
  if (typeof t === 'string' && t) return t;
  if (t && typeof t === 'object' && typeof t.name === 'string' && t.name) return t.name;
  return null;
}

function sanitizePlayer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.slice(0, NAME_MAX_STORE) : '';
  if (!name) return null;
  return {
    name,
    isBot: !!raw.isBot,
    victory: !!raw.victory,
    roundsPassed: Math.max(0, Math.round(num(raw.roundsPassed))),
    titleName: titleNameOf(raw),
  };
}

/**
 * Is this object recognizable as a stored/pushed match? Anything else (a torn write, `{}`, an array,
 * a bare `{ at }`) is dropped rather than counted as a match — a settled match always carries a
 * timestamp plus at least one outcome field.
 */
function isEntryLike(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (!Number.isFinite(raw.at) || raw.at <= 0) return false;
  return typeof raw.victory === 'boolean' || Number.isFinite(raw.roundsPassed) || Array.isArray(raw.players);
}

/** Coerce one stored/pushed entry into the compact shape, or null when it is unusable. */
function sanitizeEntry(raw) {
  if (!isEntryLike(raw)) return null;
  const players = [];
  if (Array.isArray(raw.players)) {
    for (const p of raw.players) {
      const one = sanitizePlayer(p);
      if (one) players.push(one);
      if (players.length >= PLAYERS_MAX) break;
    }
  }
  return {
    at: Math.round(num(raw.at)),
    victory: !!raw.victory,
    roundsPassed: Math.max(0, Math.round(num(raw.roundsPassed))),
    durationMs: Math.max(0, Math.round(num(raw.durationMs))),
    difficulty: typeof raw.difficulty === 'string' ? raw.difficulty : null,
    modeId: typeof raw.modeId === 'string' ? raw.modeId : null,
    hiddenCleared: !!raw.hiddenCleared,
    titleName: titleNameOf(raw),
    profileId: typeof raw.profileId === 'string' && raw.profileId ? raw.profileId : null,
    players,
  };
}

/**
 * Every stored match, newest first. A missing, corrupt or unreadable slot yields `[]`; with no
 * storage at all the session copy is returned instead.
 * @returns {Array<object>}
 */
export function loadHistory() {
  const raw = safeGet(HISTORY_KEY);
  if (raw == null) return memory ? memory.slice() : [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const list = [];
    for (const item of parsed) {
      const entry = sanitizeEntry(item);
      if (entry) list.push(entry);
      if (list.length >= HISTORY_KEEP) break;
    }
    memory = list;
    return list.slice();
  } catch {
    // Unparseable slot: treat it as "no history" rather than propagating garbage to the UI.
    memory = null;
    return [];
  }
}

/** Persist a list (already newest-first), trimming it to the ring and the serialized cap. */
function saveHistory(list) {
  let next = Array.isArray(list) ? list.slice(0, HISTORY_KEEP) : [];
  let text = '[]';
  try { text = JSON.stringify(next); } catch { return []; }
  while (next.length > 1 && text.length > HISTORY_MAX_CHARS) {
    next = next.slice(0, next.length - 1); // drop the oldest entry first
    try { text = JSON.stringify(next); } catch { return []; }
  }
  safeSet(HISTORY_KEY, text);
  memory = next;
  return next;
}

/** The payload's entry for me: by playerId when the caller knows it, else by remembered nickname. */
function mineOf(msg, myId, myName) {
  const list = Array.isArray(msg.players) ? msg.players : [];
  if (typeof myId === 'string' && myId) {
    const byId = list.find((p) => p && typeof p === 'object' && p.playerId === myId);
    if (byId) return byId;
  }
  if (myName) {
    const byName = list.find((p) => p && typeof p === 'object' && p.name === myName);
    if (byName) return byName;
  }
  return null;
}

/** Build the stored entry from an `m.result` payload (the raw server push, not the normalized shape). */
function entryFromResult(msg, myId) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const profile = loadProfile();
  const players = [];
  if (Array.isArray(msg.players)) {
    for (const p of msg.players) {
      const one = sanitizePlayer(p);
      if (one) players.push(one);
      if (players.length >= PLAYERS_MAX) break;
    }
  }
  const mine = mineOf(msg, myId, profile.name);
  return sanitizeEntry({
    at: Date.now(),
    victory: mine ? !!mine.victory : !!msg.victory,
    roundsPassed: mine && Number.isFinite(mine.roundsPassed) ? mine.roundsPassed : msg.roundsPassed,
    durationMs: msg.durationMs,
    difficulty: msg.difficulty,
    modeId: msg.modeId,
    hiddenCleared: msg.hiddenCleared,
    titleName: mine ? titleNameOf(mine) : null,
    profileId: profile.profileId,
    players,
  });
}

/** Identity of a match, used to notice the same payload recorded twice. */
function signature(entry) {
  return [entry.victory, entry.roundsPassed, entry.durationMs, entry.difficulty, entry.modeId].join('|');
}

/**
 * Append one finished match, newest first. Returns the stored entry, or null when the payload held
 * nothing usable. Recording the same payload twice in a row (a remounted result screen) is a no-op.
 * @param {object} msg the `m.result` payload
 * @param {string} [myId] my `playerId`; omit and the entry is matched by remembered nickname instead
 * @returns {object|null}
 */
export function recordResult(msg, myId) {
  const entry = entryFromResult(msg, myId);
  if (!entry) return null;
  const list = loadHistory();
  const top = list[0];
  if (top && signature(top) === signature(entry) && Math.abs(top.at - entry.at) < DEDUPE_MS) return top;
  saveHistory([entry, ...list].slice(0, HISTORY_KEEP));
  return entry;
}

/** Drop every stored match (and the session copy). */
export function clearHistory() {
  memory = null;
  try { globalThis.localStorage?.removeItem(HISTORY_KEY); } catch { /* nothing to do */ }
}

function emptySummary() {
  return {
    total: 0, wins: 0, losses: 0, winRate: 0,
    bestRounds: 0, bestWinRounds: 0, hiddenClears: 0,
    titles: [], topTitle: null, lastAt: 0,
  };
}

/**
 * Totals for the 我的战绩 panel.
 * `profileId` keeps a shared browser honest: entries tagged with somebody else's profile are skipped,
 * while untagged ones count as mine (only this client ever writes them).
 * @param {Array<object>} [entries] defaults to loadHistory()
 * @param {string} [profileId]
 * @returns {{ total: number, wins: number, losses: number, winRate: number, bestRounds: number,
 *   bestWinRounds: number, hiddenClears: number, titles: Array<{name: string, count: number}>,
 *   topTitle: string|null, lastAt: number }}
 */
export function summarize(entries, profileId) {
  const out = emptySummary();
  if (!Array.isArray(entries)) return out;
  const counts = new Map();
  for (const raw of entries) {
    const e = sanitizeEntry(raw);
    if (!e) continue;
    if (profileId && e.profileId && e.profileId !== profileId) continue;
    out.total += 1;
    if (e.victory) {
      out.wins += 1;
      if (e.roundsPassed > out.bestWinRounds) out.bestWinRounds = e.roundsPassed;
    }
    if (e.roundsPassed > out.bestRounds) out.bestRounds = e.roundsPassed;
    if (e.hiddenCleared) out.hiddenClears += 1;
    if (e.at > out.lastAt) out.lastAt = e.at;
    if (e.titleName) counts.set(e.titleName, (counts.get(e.titleName) || 0) + 1);
  }
  out.losses = out.total - out.wins;
  out.winRate = out.total ? out.wins / out.total : 0;
  out.titles = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || (a.name < b.name ? -1 : 1));
  out.topTitle = out.titles.length ? out.titles[0].name : null;
  return out;
}
