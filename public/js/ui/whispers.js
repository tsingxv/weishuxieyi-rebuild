// 私聊 (hall.whisper, DESIGN §8.1): one-to-one lines inside the 大厅.
//
// The server deliberately stores nothing — `hall.whisper` only relays a line to its two parties and
// forgets it (server/hall.js whisper()). So this module is where a conversation actually lives: threads
// are kept in localStorage under `sp.pref.whispers` (store.js loadPref/savePref, failure-tolerant), keyed
// by the *other* player's id. Storage is capped: at most WHISPER_THREADS threads and WHISPER_KEEP lines
// per thread, oldest dropped, so the slot can never grow without bound.
//
// The wire shape is `whisperLine { id, at, fromId, fromName, toId, text }`. For a thread with player X,
// a line is "mine" when `fromId === myId`. My own outgoing lines are appended optimistically from the
// same server echo (hall.whisper reaches both parties), so there is exactly one copy of every line.

import { loadPref, savePref } from '../store.js';

export const WHISPERS_KEY = 'whispers';
/** Conversations kept at all (oldest thread evicted when a new one appears). */
export const WHISPER_THREADS = 12;
/** Lines kept per thread. */
export const WHISPER_KEEP = 60;

const empty = () => ({});

/** Read every stored thread: `{ [playerId]: whisperLine[] }`, newest-last inside a thread. Never throws. */
export function loadThreads() {
  const raw = loadPref(WHISPERS_KEY, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty();
  const out = empty();
  for (const [id, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    out[id] = list.filter((l) => l && typeof l === 'object' && typeof l.text === 'string').slice(-WHISPER_KEEP);
  }
  return out;
}

/** Persist the threads (capped). Returns the stored map. */
export function saveThreads(map) {
  const ids = Object.keys(map);
  if (ids.length > WHISPER_THREADS) {
    for (const id of ids.slice(0, ids.length - WHISPER_THREADS)) delete map[id];
  }
  for (const id of Object.keys(map)) map[id] = (map[id] || []).slice(-WHISPER_KEEP);
  savePref(WHISPERS_KEY, map);
  return map;
}

/** A stable thread key for two player ids (order-independent). */
export const threadKeyOf = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * Append one wire line to the thread it belongs to (by `fromId`/`toId`), creating the thread if needed.
 * Idempotent per line id: the same `hall.whisper` frame delivered twice (a remounted screen) is stored once.
 * @param {object} map the threads map (mutated in place and persisted)
 * @param {{ id: string, fromId: string, toId: string, text: string, at: number }} line
 * @returns {object} the same map
 */
export function appendLine(map, line) {
  if (!line || typeof line.id !== 'string' || !line.fromId || !line.toId) return map;
  const key = threadKeyOf(line.fromId, line.toId);
  const list = map[key] || [];
  if (list.some((l) => l.id === line.id)) return map;
  map[key] = [...list, line].slice(-WHISPER_KEEP);
  return saveThreads(map);
}

/**
 * Drop one thread (the ✕ in the private panel). `playerId` may be either party's id.
 * @param {object} map @param {string} a @param {string} b
 */
export function clearThread(map, a, b) {
  delete map[threadKeyOf(a, b)];
  return saveThreads(map);
}

/**
 * Mark every line of a thread as read (`readUpTo` = the last seen line id). Unread badges use this.
 * @param {object} map @param {string} a @param {string} b @param {string} readUpTo
 */
export function markRead(map, a, b, readUpTo) {
  const key = threadKeyOf(a, b);
  const list = map[key];
  if (!list) return map;
  map[key] = list.map((l) => (l.id === readUpTo || l.read ? { ...l, read: true } : l));
  return saveThreads(map);
}

/** Unread count for a thread: lines that are not mine and not marked read. */
export function unreadOf(map, a, b, myId) {
  const list = map[threadKeyOf(a, b)] || [];
  return list.filter((l) => l.fromId !== myId && !l.read).length;
}

/** Total unread across all threads (badge on the 频道/私聊 switch). */
export function unreadTotal(map, myId) {
  return Object.keys(map).reduce((n, key) => n + unreadOf(map, ...key.split('\u0000'), myId), 0);
}
