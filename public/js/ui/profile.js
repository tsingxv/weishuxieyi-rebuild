// The player's own identity on this browser (client-side only, no accounts on a friend server).
//
// Two things must survive a reload: the nickname (so the title screen can prefill it) and a stable
// random `profileId` (so the permanent match history can tell "my" matches from entries left behind
// by somebody else on a shared browser). `visits` / `lastSeenAt` are cheap counters the title screen
// uses to greet a returning player.
//
// The nickname lives in `sp.name` as a RAW string — the exact key and format net.js writes in
// identity.saveName/loadName — so the two modules can never disagree about who the player is. The
// remaining fields ride along in the JSON preference `sp.pref.profile` through store.js loadPref/savePref.
//
// Every entry point is total: private mode, a disabled localStorage or a corrupt slot must never
// break the title screen, so reads fall back to in-memory defaults and writes are best-effort.

import { loadPref, savePref } from '../store.js';

/** net.js identity key (raw string, deliberately not `sp.pref.*`). */
export const NAME_KEY = 'sp.name';
/** Preference slot holding the rest of the profile. */
const PREF_KEY = 'profile';
/** Longest nickname kept (net.js truncates at 64; the UI asks for NAME_MAX_LEN). */
const NAME_MAX_STORE = 64;

/** Session cache: keeps `profileId` stable even when nothing can be persisted (private mode). */
let cached = null;
/** Last nickname seen when localStorage is unavailable, so a write/read round-trip still works. */
let memoryName = null;

function str(v) {
  return typeof v === 'string' ? v : '';
}

function int(v) {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

function readName() {
  try {
    const raw = globalThis.localStorage?.getItem(NAME_KEY);
    if (typeof raw === 'string') {
      memoryName = raw.slice(0, NAME_MAX_STORE);
      return memoryName;
    }
    return memoryName;
  } catch {
    return memoryName;
  }
}

function writeName(name) {
  memoryName = name;
  try { globalThis.localStorage?.setItem(NAME_KEY, name); } catch { /* private mode / quota: the session copy still works */ }
}

/**
 * Random, stable id for this browser. `crypto.randomUUID` needs a secure context, so a plain-http
 * LAN game falls back to a time+random tag — still unique enough to tag history entries.
 * @returns {string}
 */
function genId() {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '').slice(0, 16);
  } catch { /* not available: fall through */ }
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function readPref() {
  const raw = loadPref(PREF_KEY, null);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/**
 * Read the stored profile, filling in defaults. Never throws.
 * The very first call generates a `profileId` and persists it, otherwise every reload would mint a
 * new one and the permanent history would look empty.
 * @returns {{ name: string, profileId: string, visits: number, lastSeenAt: number, rememberName: boolean }}
 */
export function loadProfile() {
  const pref = readPref();
  const storedName = readName();
  const generated = !str(pref?.profileId);
  const profile = {
    name: storedName != null ? storedName : str(pref?.name),
    profileId: str(pref?.profileId) || str(cached?.profileId) || genId(),
    visits: int(pref?.visits),
    lastSeenAt: int(pref?.lastSeenAt),
    rememberName: pref?.rememberName === true,
  };
  cached = profile;
  if (generated) savePref(PREF_KEY, profile);
  return { ...profile };
}

/**
 * Merge a patch into the stored profile and persist it. Unknown keys are ignored and bad types are
 * dropped, so a caller cannot poison the slot with garbage. Never throws.
 * @param {{ name?: string, profileId?: string, visits?: number, lastSeenAt?: number, rememberName?: boolean }} [patch]
 * @returns {{ name: string, profileId: string, visits: number, lastSeenAt: number, rememberName: boolean }}
 */
export function saveProfile(patch) {
  const next = loadProfile();
  if (patch && typeof patch === 'object') {
    if (typeof patch.name === 'string') {
      next.name = patch.name.slice(0, NAME_MAX_STORE);
      writeName(next.name);
    }
    if (str(patch.profileId)) next.profileId = patch.profileId;
    if (Number.isFinite(patch.visits)) next.visits = int(patch.visits);
    if (Number.isFinite(patch.lastSeenAt)) next.lastSeenAt = int(patch.lastSeenAt);
    if (typeof patch.rememberName === 'boolean') next.rememberName = patch.rememberName;
  }
  cached = next;
  savePref(PREF_KEY, next);
  return { ...next };
}

/**
 * Count one visit and stamp `lastSeenAt`. The caller decides whether a re-render counts again.
 * @returns {{ name: string, profileId: string, visits: number, lastSeenAt: number, rememberName: boolean }}
 */
export function bumpVisit() {
  const p = loadProfile();
  return saveProfile({ visits: p.visits + 1, lastSeenAt: Date.now() });
}

/**
 * 1–2 glyphs for an avatar chip: the first two characters of a CJK nickname, otherwise the initials
 * of up to two words. `'?'` when there is nothing to show.
 * @param {string} [name]
 * @returns {string}
 */
export function profileInitials(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) return '?';
  const chars = Array.from(text);
  // CJK nicknames are two glyphs, not an initialism; slice by code point so an emoji survives.
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)) return chars.slice(0, 2).join('');
  const words = text.split(/[\s_\-.,]+/).filter(Boolean);
  const head = Array.from(words[0] || '');
  if (words.length > 1) {
    const tail = Array.from(words[1] || '');
    return ((head[0] || '') + (tail[0] || '')).toUpperCase();
  }
  return head.slice(0, 2).join('').toUpperCase();
}
