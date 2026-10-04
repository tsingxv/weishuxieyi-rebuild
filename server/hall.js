// server/hall.js — 大厅: one server-wide channel for everyone connected to this instance.
//
// A friend-only server has no accounts and no public listing, so the hall is deliberately small and
// in-memory: who is online, which rooms are open, a short chat, and the last few finished matches. It is
// **opt-in per session** (`hall.enter` / `hall.leave`): a session that never enters the hall receives no
// hall frames at all, and a session sitting on the title screen pays nothing.
//
// Wiring: `Lobby` owns one `Hall` and forwards four events to it —
//   * `hall.enter/leave/chat`   (C2S, from `Lobby.onMessage`)
//   * `onSessionGone(session)`  (disconnect expiry / leave — see `Lobby.onExpire`)
//   * `onRoomChanged()`         (a room was created/disposed or a seat changed — roster refresh)
//   * `onMatchEnd(room, msg)`   (the public `m.result` frame of a finished match → the results ring)
//
// Everything is bounded (CHAT_MAX_LEN / HALL_CHAT_KEEP / HALL_RESULTS_KEEP / HALL_ROSTER_MAX) and
// rate-limited (CHAT_COOLDOWN_MS), so an open hall cannot grow without bound or be used to flood.
//
// Restarting the server clears all of it by design; the client keeps its own permanent history
// (public/js/ui/history.js) so a player's own 战绩 survives.

import { CHAT_COOLDOWN_MS, CHAT_MAX_LEN, HALL_CHAT_KEEP, HALL_RESULTS_KEEP, HALL_ROOMS_MAX, HALL_ROSTER_MAX, WHISPER_BURST, WHISPER_MAX_LEN, WHISPER_WINDOW_MS, ERR } from '../shared/constants.js';
import { encode, isDroppable, sendRaw, sendSession } from './net.js';

/** How long roster changes are coalesced before one `hall.roster` broadcast (ms). */
export const ROSTER_FLUSH_MS = 150;

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });

/**
 * Trim and normalise a chat line the way the server will store it: strip control characters (a newline
 * or a bidi override would let a line lie about its own layout), collapse runs of whitespace, clamp to
 * CHAT_MAX_LEN. Returns '' for a line that carries nothing usable.
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeChat(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, CHAT_MAX_LEN).trim();
}

/** One seat of a room as a hall-facing summary. */
function roomSummary(room) {
  const seats = room.seats.filter(Boolean);
  const host = room.hostId ? room.seatOf(room.hostId) : null;
  return {
    code: room.code,
    mode: room.mode,
    difficulty: room.difficulty,
    humans: room.activeHumans().length,
    seats: seats.length,
    inMatch: !!room.match,
    hostName: host && !host.left ? host.name : null,
  };
}

/** A finished match reduced to what the hall shows: who played, how it went, which 评语 each got. */
export function resultSummary(room, msg, at, seq) {
  const players = Array.isArray(msg?.players) ? msg.players : [];
  return {
    id: `${room.code}-${seq}`,
    at,
    roomCode: room.code,
    modeId: typeof msg?.modeId === 'string' ? msg.modeId : null,
    difficulty: typeof msg?.difficulty === 'string' ? msg.difficulty : null,
    victory: !!msg?.victory,
    roundsPassed: Number.isFinite(msg?.roundsPassed) ? msg.roundsPassed : 0,
    durationMs: Number.isFinite(msg?.durationMs) ? Math.max(0, Math.round(msg.durationMs)) : 0,
    players: players.slice(0, 4).map((p) => ({
      playerId: typeof p?.playerId === 'string' ? p.playerId : null,
      name: typeof p?.name === 'string' ? p.name : '?',
      isBot: !!p?.isBot,
      victory: !!p?.victory,
      roundsPassed: Number.isFinite(p?.roundsPassed) ? p.roundsPassed : 0,
      // the result screen's 评语 (server/match/results.js assignTitles): only the display fields travel
      title: p?.title && typeof p.title === 'object' && typeof p.title.id === 'string'
        ? { id: p.title.id, name: typeof p.title.name === 'string' ? p.title.name : p.title.id }
        : null,
    })),
  };
}

/**
 * The server-wide hall. One instance per `Lobby`.
 */
export class Hall {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   rooms: () => Iterable<any>,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   now?: () => number,
   * }} opts
   */
  constructor({ registry, rooms, log = noopLog, now = Date.now }) {
    this.registry = registry;
    this.roomsOf = rooms;
    this.log = log;
    this.now = now;
    /** @type {Set<string>} playerIds subscribed to hall frames */
    this.members = new Set();
    /** @type {Map<string, number>} first-seen time per playerId (roster "online since") */
    this.seen = new Map();
    /** @type {any[]} newest-last chat ring */
    this.chat = [];
    /** @type {any[]} newest-last finished-match ring */
    this.results = [];
    /** @type {number} monotonic id source for chat lines and result entries */
    this.seq = 0;
    /** @type {Map<string, number>} last accepted chat time per playerId (cooldown) */
    this.chatAt = new Map();
    /** @type {Map<string, number[]>} recent private-line times per playerId (burst budget) */
    this.whisperAt = new Map();
    /** @type {NodeJS.Timeout | null} coalesced roster broadcast */
    this.rosterTimer = null;
  }

  // ---- presence --------------------------------------------------------------------------------

  /** Is this session receiving hall frames? @param {import('./net.js').Session} session */
  isMember(session) { return !!session && this.members.has(session.playerId); }

  /** Every connected session, in a stable order (name, then playerId) so the roster does not jump around. */
  roster() {
    const out = [];
    for (const s of this.registry.all()) {
      // registry.all() also yields disconnected-but-resumable sessions: only live sockets are "online"
      if (!s || !s.connected) continue;
      if (!this.seen.has(s.playerId)) this.seen.set(s.playerId, this.now());
      const room = s.roomCode ? this.roomOf(s.roomCode) : null;
      out.push({
        playerId: s.playerId,
        name: s.name,
        roomCode: s.roomCode || null,
        inMatch: !!(room && room.match),
        since: this.seen.get(s.playerId) ?? this.now(),
      });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.playerId < b.playerId ? -1 : 1));
    return out;
  }

  /** @param {string} code */
  roomOf(code) {
    for (const room of this.roomsOf()) if (room.code === code && !room.disposed) return room;
    return null;
  }

  /** Open rooms, newest code first is not meaningful — keep code order for a stable list. */
  rooms() {
    const out = [];
    for (const room of this.roomsOf()) {
      if (room.disposed) continue;
      out.push(roomSummary(room));
    }
    out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return out;
  }

  /** The full hall snapshot (`hall.state`). */
  snapshot() {
    const roster = this.roster();
    const rooms = this.rooms();
    return {
      t: 'hall.state',
      roster: roster.slice(0, HALL_ROSTER_MAX),
      total: roster.length,
      rooms: rooms.slice(0, HALL_ROOMS_MAX),
      roomsTotal: rooms.length,
      results: this.results.slice(-HALL_RESULTS_KEEP),
      chat: this.chat.slice(-HALL_CHAT_KEEP),
      serverNow: this.now(),
    };
  }

  // ---- membership ------------------------------------------------------------------------------

  /** `hall.enter`: subscribe and answer with the snapshot. Idempotent. */
  enter(session) {
    if (!session) return OK;
    this.members.add(session.playerId);
    if (!this.seen.has(session.playerId)) this.seen.set(session.playerId, this.now());
    sendSession(session, this.snapshot());
    // the roster changed by this very arrival: tell the others (coalesced)
    this.scheduleRoster();
    return OK;
  }

  /** `hall.leave`: unsubscribe. Idempotent. */
  leave(session) {
    if (!session) return OK;
    if (this.members.delete(session.playerId)) this.scheduleRoster();
    return OK;
  }

  /**
   * A session that already entered the hall said hello again (reconnect / reload): re-send the snapshot
   * without subscribing anyone new. Called from `Lobby.onHello`.
   */
  resume(session) {
    if (!this.isMember(session)) return false;
    sendSession(session, this.snapshot());
    return true;
  }

  /** Post a chat line (validated `hall.chat`). @returns {{ ok: true } | { error: string, detail?: string }} */
  postChat(session, msg) {
    if (!session) return fail(ERR.INTERNAL);
    const text = sanitizeChat(msg && msg.text);
    if (!text) return fail(ERR.BAD_MSG, 'empty message');
    const at = this.now();
    const last = this.chatAt.get(session.playerId);
    if (last != null && at - last < CHAT_COOLDOWN_MS) return fail(ERR.RATE, 'chat too fast');
    this.chatAt.set(session.playerId, at);
    const line = { id: `c${++this.seq}`, at, playerId: session.playerId, name: session.name, text };
    this.chat.push(line);
    if (this.chat.length > HALL_CHAT_KEEP * 2) this.chat.splice(0, this.chat.length - HALL_CHAT_KEEP);
    this.broadcast({ t: 'hall.chat', line });
    return OK;
  }

  /**
   * 私聊: relay one private line from `session` to the session named in `msg.to`.
   *
   * Deliberately different from the public channel:
   *   * the server **stores nothing** — the line goes to the two sockets and is forgotten, so a restart
   *     or a later `hall.enter` can never replay someone's private conversation;
   *   * the recipient does **not** have to be in the hall (`hall.enter`), only connected — hiding from
   *     the public channel should not also cut off a friend's direct line;
   *   * sending to yourself is refused (it would be indistinguishable from a delivered line and is
   *     always a client bug);
   *   * flood control is its own budget (WHISPER_BURST per WHISPER_WINDOW_MS), so a busy public channel
   *     and a private conversation cannot starve each other;
   *
   * @param {import('./net.js').Session} session
   * @param {{ to?: unknown, text?: unknown }} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  whisper(session, msg) {
    if (!session) return fail(ERR.INTERNAL);
    const text = sanitizeChat(msg && msg.text);
    if (!text) return fail(ERR.BAD_MSG, 'empty message');

    // the recipient must be a *live* session; `isId` on the wire already bounds the shape
    const toId = typeof msg?.to === 'string' ? msg.to : '';
    if (!toId) return fail(ERR.BAD_MSG, 'missing recipient');
    if (toId === session.playerId) return fail(ERR.BAD_MSG, 'cannot whisper to yourself');
    const to = this.registry.byId(toId);
    if (!to || !to.connected) return fail(ERR.BAD_MSG, '该玩家已不在线');

    const now = this.now();
    // Anti-flood: a sliding-window burst budget. There is deliberately no per-line cooldown — a real
    // conversation is several short lines in a few seconds, and the burst cap already bounds the rate
    // (WHISPER_BURST per WHISPER_WINDOW_MS, ~2/s sustained).
    const recent = (this.whisperAt.get(session.playerId) || []).filter((t) => now - t < WHISPER_WINDOW_MS);
    if (recent.length >= WHISPER_BURST) return fail(ERR.RATE, '发得太快，稍后再试');
    recent.push(now);
    this.whisperAt.set(session.playerId, recent);

    const line = {
      id: `w${++this.seq}`,
      at: now,
      fromId: session.playerId,
      fromName: session.name,
      toId,
      text,
    };
    // relay to the two parties only; the sender's copy marks it as outgoing client-side by fromId === me
    sendSession(to, { t: 'hall.whisper', line });
    sendSession(session, { t: 'hall.whisper', line });
    return OK;
  }

  // ---- events ----------------------------------------------------------------------------------

  /**
   * A session is gone for good (reconnect window elapsed / it left): drop it from the roster and free its
   * cooldown entry. Its chat lines and results stay — they are history, not presence.
   * @param {import('./net.js').Session} session
   */
  onSessionGone(session) {
    if (!session) return;
    this.seen.delete(session.playerId);
    this.chatAt.delete(session.playerId);
    this.whisperAt.delete(session.playerId);
    if (this.members.delete(session.playerId)) this.scheduleRoster();
  }

  /** A room/seat changed: refresh the roster (coalesced, so a start-of-match storm is one frame). */
  onRoomChanged() { this.scheduleRoster(); }

  /**
   * A finished match: keep a compact entry for the hall's "recent results" and push the roster (the room
   * left its match, so `inMatch` flipped).
   */
  onMatchEnd(room, msg) {
    const entry = resultSummary(room, msg, this.now(), ++this.seq);
    this.results.push(entry);
    if (this.results.length > HALL_RESULTS_KEEP * 2) this.results.splice(0, this.results.length - HALL_RESULTS_KEEP);
    this.scheduleRoster();
    return entry;
  }

  // ---- sending ---------------------------------------------------------------------------------

  /** Coalesce roster broadcasts within ROSTER_FLUSH_MS. */
  scheduleRoster() {
    if (this.rosterTimer) return;
    this.rosterTimer = setTimeout(() => {
      this.rosterTimer = null;
      this.flushRoster();
    }, ROSTER_FLUSH_MS);
    this.rosterTimer.unref?.();
  }

  /** Push the current presence/rooms to everyone in the hall (`hall.roster`). */
  flushRoster() {
    if (this.members.size === 0) return;
    const roster = this.roster();
    const rooms = this.rooms();
    this.broadcast({
      t: 'hall.roster',
      roster: roster.slice(0, HALL_ROSTER_MAX),
      total: roster.length,
      rooms: rooms.slice(0, HALL_ROOMS_MAX),
      roomsTotal: rooms.length,
    });
  }

  /** Encode once, push to every subscribed connected session. */
  broadcast(msg) {
    if (this.members.size === 0) return;
    const data = encode(msg);
    if (data == null) { this.log.error(`[hall] unserializable frame ${msg && msg.t}`); return; }
    const droppable = isDroppable(msg);
    for (const playerId of this.members) {
      const session = this.registry.byId(playerId);
      if (!session || !session.connected) continue;
      sendRaw(session.ws, data, { droppable });
    }
  }

  /** Counters for /healthz. */
  stats() { return { hallMembers: this.members.size, hallChat: this.chat.length, hallResults: this.results.length }; }

  /** Release the coalescing timer (server shutdown / tests). */
  dispose() {
    if (this.rosterTimer) { clearTimeout(this.rosterTimer); this.rosterTimer = null; }
    this.members.clear();
    this.whisperAt.clear();
  }
}
