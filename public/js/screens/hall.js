// 大厅 (server-wide hall, DESIGN §8.1): who is online, which 同盟 are open, one shared chat channel and
// the recent results of everyone on the server (server/hall.js).
//
// The server pushes hall frames only to sessions that asked for them, so this screen owns the
// subscription: it sends `hall.enter` on mount (and again after a reconnect) and `hall.leave` on
// unmount — main.js only republishes the frames into `store.hall`. The slice is a full snapshot on
// entry (`hall.state`) plus presence/room deltas (`hall.roster`) and single chat lines (`hall.chat`),
// so everything here is a plain read of that slice; nothing is cached locally.
//
// Reached from the protocol picker (screens/lobby.js) through `ui.screen` (store.selectRoute); the
// back button clears it again, which lands on the lobby — or on the room (→ battle), because a running
// match always outranks the hall in the router.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { CHAT_MAX_LEN, MAX_SEATS, ROOM_CODE_LEN, ERR } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, Panel, TextField, AvatarFrame, DifficultyTag, PingPill, Spinner, useTicker, doctorNo } from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { GuideButton } from '../ui/guide.js';
import { LoadoutButton } from './loadout.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, loadPref, savePref, serverNow, openHall, closeHall } from '../store.js';
import { copyText, inviteLink } from './room.js';
import { getConfig, useData } from '../data.js';

/** Where the chat draft lives between visits (a half-typed line must not be lost on a screen switch). */
const K_CHAT_DRAFT = 'hall.chatDraft';
/** How many finished matches the right column lists (the server keeps a ring of HALL_RESULTS_KEEP). */
const RESULT_ROWS = 8;
/** Relative times ("3 分钟前") in the results/roster only need to be right to the half minute. */
const AGE_TICK_MS = 30_000;

const CODE_RE = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LEN}}$`);
const MODE_LABEL = { solo: '独立模拟', coop: '同盟模拟' };

// ---- pure helpers (no DOM/hooks; Node-importable for tests) --------------------------------------

/**
 * Whether an open room can be joined, and why not.
 * @param {any} room a `roomEntry` from the hall snapshot, or null when it is not listed there
 * @returns {'open'|'in-match'|'solo'|'full'|'unknown'}
 */
export function joinState(room) {
  if (!room || typeof room.code !== 'string') return 'unknown';
  if (room.inMatch) return 'in-match';
  if (room.mode === 'solo') return 'solo';
  // `seats` counts every occupied seat (humans + AI teammates): a room holding 4 cannot take another.
  return Number(room.seats) >= MAX_SEATS ? 'full' : 'open';
}

/** One-line explanation per `joinState` (empty for 'open'). */
export const JOIN_NOTE = {
  unknown: '暂无该同盟的公开信息',
  'in-match': '该同盟正在模拟中',
  solo: '独立模拟无法加入',
  full: '房间已满',
  open: '',
};

/**
 * Display name of a finished match's mode, derived from its `modeId` (`mode_multi_hard`).
 * @param {string|null|undefined} modeId
 * @returns {string} '' when the id is unknown
 */
export function modeLabel(modeId) {
  const s = String(modeId ?? '');
  if (s.includes('_single_')) return MODE_LABEL.solo;
  if (s.includes('_multi_')) return MODE_LABEL.coop;
  return '';
}

/**
 * Compact duration ("12 分 34 秒" / "45 秒").
 * @param {number} ms
 * @returns {string}
 */
export function fmtDuration(ms) {
  const total = Number.isFinite(Number(ms)) ? Math.max(0, Math.round(Number(ms) / 1000)) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/**
 * Relative "how long ago" text for a server timestamp.
 * @param {number} at server epoch ms
 * @param {number} [now] server epoch ms (defaults to the clock-corrected now)
 * @returns {string}
 */
export function fmtAgo(at, now = serverNow()) {
  const d = Number(now) - Number(at);
  if (!Number.isFinite(d) || d < 0) return '刚刚';
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

/** Wall-clock "HH:MM" of a server timestamp (for chat lines). */
export function fmtClock(at) {
  const d = new Date(Number(at));
  if (!Number.isFinite(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The text `hall.chat` would carry for a raw input: control characters and runs of whitespace
 * collapsed, trimmed and clamped to CHAT_MAX_LEN — what the server's own `sanitizeChat` does. Returns
 * '' when there is nothing to send, so callers can skip the request entirely.
 * @param {unknown} raw
 * @returns {string}
 */
export function chatPayload(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LEN)
    .trim();
}

/**
 * Index of 评语 (titles) from data/config.json by id, so a result entry that only carries `title.id`
 * still shows the name the result screen shows.
 * @param {any} config
 * @returns {Map<string, string>}
 */
export function titleIndex(config) {
  const list = Array.isArray(config?.titles) ? config.titles : [];
  const map = new Map();
  for (const t of list) {
    if (t && typeof t.id === 'string') map.set(t.id, typeof t.name === 'string' && t.name ? t.name : t.id);
  }
  return map;
}

/**
 * Display name of a hall result player's 评语, tolerating a missing title and an unknown id.
 * @param {any} p a `resultEntry.players[]` entry
 * @param {Map<string, string>} index from `titleIndex`
 * @returns {string|null}
 */
export function titleNameOf(p, index) {
  const t = p?.title;
  if (!t || typeof t !== 'object') return null;
  if (typeof t.name === 'string' && t.name) return t.name;
  if (typeof t.id === 'string') return index.get(t.id) || t.id;
  return null;
}

/** The open-room entry a roster entry points at (players in solo/unlisted rooms have none). */
export function roomByCode(rooms, code) {
  if (!Array.isArray(rooms) || typeof code !== 'string') return null;
  return rooms.find((r) => r && r.code === code) || null;
}

// ---- components ----------------------------------------------------------------------------------

function SectionLabel({ idx, title, micro }) {
  return html`<div class="section-label"><span class="section-label__idx num">${idx}</span>${title}<${MicroLabel}>${micro}<//></div>`;
}

function RosterRow({ entry, room, isMe, busy, onCopy, onJoin }) {
  const state = joinState(room);
  const code = entry.roomCode;
  return html`<li class=${`hall-who${isMe ? ' is-me' : ''}${entry.inMatch ? ' is-busy' : ''}`}>
    <${AvatarFrame} size="sm" name=${entry.name} seat=${0} self=${isMe} offline=${false} />
    <div class="hall-who__text">
      <span class="hall-who__name">${entry.name || '博士'}${isMe ? html`<span class="hall-who__you">你</span>` : null}</span>
      <${MicroLabel}>DOCTOR #${doctorNo(entry.playerId)}<//>
    </div>
    <div class="hall-who__room">
      ${code
        ? html`<button type="button" class="hall-code hall-code--sm num" title="复制同盟密钥 ${code}" onClick=${() => onCopy(code)}>${code}</button>`
        : html`<span class="hall-who__idle t-dim">闲暇中</span>`}
      ${entry.inMatch ? html`<span class="hall-who__live" title="正在模拟中"><${Icon} name="sword" />模拟中</span>` : null}
      ${code && state === 'open'
        ? html`<${Button} size="sm" variant="ghost" icon="users" loading=${busy === `join:${code}`} onClick=${() => onJoin(code)}>加入<//>`
        : null}
    </div>
  </li>`;
}

function RoomCard({ room, busy, onCopy, onJoin }) {
  const state = joinState(room);
  return html`<li class=${`hall-room${room.inMatch ? ' is-busy' : ''}${state === 'open' ? ' is-open' : ''}`}>
    <div class="hall-room__head">
      <button type="button" class="hall-code num" title="复制同盟密钥 ${room.code}" onClick=${() => onCopy(room.code)}>${room.code}</button>
      <${DifficultyTag} difficulty=${room.difficulty} size="sm" />
      <span class="hall-room__mode"><${Icon} name=${room.mode === 'solo' ? 'user' : 'users'} />${MODE_LABEL[room.mode] || room.mode || '—'}</span>
    </div>
    <div class="hall-room__meta">
      <span><b class="num">${room.humans ?? 0}</b>/${MAX_SEATS} 博士</span>
      <span><b class="num">${room.seats ?? 0}</b> 已占位</span>
      ${room.hostName ? html`<span class="hall-room__host" title="创建者"><${Icon} name="crown" />${room.hostName}</span>` : null}
      ${room.inMatch ? html`<span class="hall-room__live"><${Icon} name="sword" />模拟中</span>` : null}
    </div>
    <div class="hall-room__acts">
      <${Button} size="sm" variant="secondary" icon="copy" onClick=${() => onCopy(room.code)}>复制密钥<//>
      ${state === 'open'
        ? html`<${Button} size="sm" variant="amber" icon="users" loading=${busy === `join:${room.code}`} onClick=${() => onJoin(room.code)}>加入<//>`
        : html`<span class="hall-room__note t-dim">${JOIN_NOTE[state]}<//>`}
    </div>
  </li>`;
}

function ChatPanel({ chat, myId, draft, busy, logRef, onDraft, onSend, onCopyCode }) {
  return html`<${Panel} class="hall-panel hall-chat" pad=${false}>
    <div class="hall-chat__log" ref=${logRef} role="log" aria-live="polite" aria-label="大厅聊天">
      ${chat.length
        ? chat.map((line) => html`<div class=${`hall-line${line.playerId === myId ? ' is-me' : ''}`} key=${line.id || `${line.at}-${line.playerId}`}>
            <span class="hall-line__time num">${fmtClock(line.at)}</span>
            <span class="hall-line__name">${line.name || '博士'}</span>
            <span class="hall-line__text">${line.text}</span>
          </div>`)
        : html`<p class="hall-empty t-dim">还没有人发言。打个招呼，或者把同盟密钥贴出来。</p>`}
    </div>
    <div class="hall-chat__form">
      <${TextField} size="md" value=${draft} placeholder="对全服发言（回车发送）" maxLength=${CHAT_MAX_LEN}
        onInput=${onDraft} onEnter=${onSend} />
      <${Button} variant="primary" size="md" icon="chevrons" loading=${busy === 'chat'} disabled=${!chatPayload(draft)} onClick=${onSend}>发送<//>
    </div>
    <div class="hall-chat__foot">
      <span class="t-dim">所有人可见 · 注意不要泄露隐私</span>
      <button type="button" class="hall-link" onClick=${onCopyCode}>复制我的密钥</button>
    </div>
  <//>`;
}

function ResultRow({ r, titles, now }) {
  const mode = modeLabel(r.modeId);
  const players = Array.isArray(r.players) ? r.players : [];
  return html`<li class=${`hall-res${r.victory ? ' is-win' : ' is-lose'}`}>
    <div class="hall-res__head">
      <span class="hall-res__state">${r.victory ? '模拟完成' : '模拟失败'}</span>
      ${r.difficulty ? html`<${DifficultyTag} difficulty=${r.difficulty} size="sm" />` : null}
      <span class="hall-res__at t-dim num">${fmtAgo(r.at, now)}</span>
    </div>
    <div class="hall-res__meta">
      ${r.roomCode ? html`<button type="button" class="hall-code hall-code--sm num" title="复制同盟密钥 ${r.roomCode}">${r.roomCode}</button>` : null}
      ${mode ? html`<span>${mode}</span>` : null}
      <span>通过 <b class="num">${r.roundsPassed ?? 0}</b> 回合</span>
      <span>耗时 <b class="num">${fmtDuration(r.durationMs)}</b></span>
    </div>
    ${players.length ? html`<div class="hall-res__players">
      ${players.map((p, i) => {
        const name = titleNameOf(p, titles);
        return html`<span class=${`hall-res__who${p.victory ? ' is-win' : ''}`} key=${p.playerId || i}>
          <b>${p.name || '?'}${p.isBot ? html`<i class="hall-res__ai">AI</i>` : null}</b>
          <span class="hall-res__title" title=${name ? `评语：${name}` : '无评语'}>${name || '—'}</span>
        </span>`;
      })}
    </div>` : null}
  </li>`;
}

/** 大厅 screen. */
export function HallScreen() {
  const hall = useStore((s) => s.hall, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const me = useStore((s) => s.me, shallowEqual);
  useData('config');
  // Relative times / durations stay honest while the screen sits open (shared 30 s ticker, no own timer).
  useTicker(AGE_TICK_MS);

  const [draft, setDraft] = useState(() => {
    const saved = loadPref(K_CHAT_DRAFT, '');
    return typeof saved === 'string' ? saved.slice(0, CHAT_MAX_LEN) : '';
  });
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const logRef = useRef(null);

  const online = conn.status === 'online';
  const now = serverNow();
  const titleById = titleIndex(getConfig());
  const roster = Array.isArray(hall.roster) ? hall.roster : [];
  const rooms = Array.isArray(hall.rooms) ? hall.rooms : [];
  const results = (Array.isArray(hall.results) ? hall.results : []).slice(-RESULT_ROWS).reverse();
  const chat = Array.isArray(hall.chat) ? hall.chat : [];

  useEffect(() => () => { alive.current = false; }, []);

  // Subscribe while mounted. `sub.on` is the local truth (the store's `entered` flag survives a socket
  // drop, so it cannot say whether the *server* still knows us): a status change away from 'online'
  // ends the server-side subscription, the next handshake has to ask again. While `entered` is already
  // true a reconnect is re-entered by main.js (onWelcome), so this only sends the first request.
  useEffect(() => {
    const sub = { on: false };
    const sync = () => {
      const s = store.get();
      if (s.connection.status !== 'online') { sub.on = false; return; }
      if (sub.on) return;
      sub.on = true;
      if (!s.hall.entered) net.send('hall.enter');
    };
    sync();
    const unsub = store.subscribe(sync);
    return () => {
      unsub();
      if (sub.on) net.send('hall.leave');
      // Let the next mount (and main.js's reconnect path) know we are unsubscribed again.
      store.patch('hall', { entered: false });
    };
  }, []);

  // New lines scroll the log to the bottom (the panel keeps its own scroll, the page never jumps).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast('尚未连接到服务器，请稍候', 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const join = (code) => {
    const room = roomByCode(rooms, code);
    const state = joinState(room);
    if (state !== 'open') { toast(JOIN_NOTE[state], 'warn'); return; }
    // room.state follows and the router switches to the room screen (which unmounts this one).
    run(`join:${code}`, () => net.request('room.join', { code }));
  };

  const copyCode = async (code, asLink = false) => {
    if (!CODE_RE.test(code)) return;
    const ok = await copyText(asLink ? inviteLink(code) : code);
    if (ok) toast(asLink ? '已复制邀请链接' : `已复制同盟密钥 ${code}`, 'success');
    else toast('复制失败，请手动复制', 'warn');
  };

  const copyMine = () => {
    const mine = roster.find((e) => e.playerId === me.playerId);
    if (mine?.roomCode) copyCode(mine.roomCode, true);
    else toast('你还没有同盟密钥：先创建或加入一个同盟', 'warn');
  };

  const onDraft = (v) => {
    const next = String(v ?? '').slice(0, CHAT_MAX_LEN);
    setDraft(next);
    savePref(K_CHAT_DRAFT, next);
  };

  const sendChat = () => {
    const text = chatPayload(draft);
    if (!text) return;
    if (!online) { toast('尚未连接到服务器，请稍候', 'warn'); return; }
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('chat');
    net.request('hall.chat', { text }).then(() => {
      if (!alive.current) return;
      setDraft('');
      savePref(K_CHAT_DRAFT, '');
    }).catch((err) => {
      // The server's one-second cooldown is not an error worth an error toast: the line was never
      // stored, so it stays in the draft and the player can just press Enter again.
      if (err?.code === ERR.RATE) toast('发言太快了，稍等一下', 'warn');
      else toastError(err);
    }).finally(() => {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    });
  };

  const back = () => closeHall();

  const rosterNote = hall.total > roster.length ? `在线 ${hall.total} 人 · 仅显示前 ${roster.length} 人` : `在线 ${hall.total} 人`;
  const roomsNote = hall.roomsTotal > rooms.length ? `${hall.roomsTotal} 个 · 仅显示前 ${rooms.length} 个` : `${hall.roomsTotal} 个`;

  return html`<div class="screen hall-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${back} title="返回">返回<//>
        <${PingPill} ms=${conn.ping} online=${online} />
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">SERVER-WIDE COMMS HUB<//>
        <h1 class="topbar__title">大厅</h1>
      </div>
      <div class="topbar__right">
        <${GuideButton} class="hall-guide" variant="secondary" />
        <${LoadoutButton} from="hall" size="sm" class="hall-loadout" />
        <div class="me-chip">
          <${AvatarFrame} size="sm" name=${me.name} seat=${0} self=${true} />
          <div class="me-chip__text">
            <span class="me-chip__name">${me.name || '博士'}</span>
            <${MicroLabel}>${me.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}<//>
          </div>
        </div>
      </div>
    </header>

    <div class="hall-body screen__scroll">
      <section class="hall-col hall-col--who">
        <${SectionLabel} idx="01" title="在线博士" micro=${rosterNote} />
        <${Panel} class="hall-panel hall-panel--who" pad=${false}>
          ${roster.length
            ? html`<ul class="hall-list">
                ${roster.map((e) => html`<${RosterRow} key=${e.playerId} entry=${e} room=${roomByCode(rooms, e.roomCode)}
                  isMe=${e.playerId === me.playerId} busy=${busy} onCopy=${copyCode} onJoin=${join} />`)}
              </ul>`
            : html`<p class="hall-empty t-dim">
                ${online
                  ? html`大厅里目前只有你。等其他人进来，或者先创建自己的同盟。`
                  : html`<${Spinner} size="sm" label="CONNECTING" />`}
              </p>`}
        <//>
      </section>

      <section class="hall-col hall-col--main">
        <${SectionLabel} idx="02" title="开放同盟" micro=${roomsNote} />
        <${Panel} class="hall-panel hall-panel--rooms" pad=${false}>
          ${rooms.length
            ? html`<ul class="hall-list">
                ${rooms.map((r) => html`<${RoomCard} key=${r.code} room=${r} busy=${busy} onCopy=${copyCode} onJoin=${join} />`)}
              </ul>`
            : html`<p class="hall-empty t-dim">${online ? '当前没有开放的同盟。' : '正在读取服务器状态…'}</p>`}
        <//>

        <${SectionLabel} idx="03" title="频道" micro="ALLIANCE CHANNEL" />
        <${ChatPanel} chat=${chat} myId=${me.playerId} draft=${draft} busy=${busy} logRef=${logRef}
          onDraft=${onDraft} onSend=${sendChat} onCopyCode=${copyMine} />
      </section>

      <section class="hall-col hall-col--record">
        <${SectionLabel} idx="04" title="最近战绩" micro="RECENT RESULTS" />
        <${Panel} class="hall-panel hall-panel--results" pad=${false}>
          ${results.length
            ? html`<ul class="hall-list">
                ${results.map((r) => html`<${ResultRow} key=${r.id} r=${r} titles=${titleById} now=${now} />`)}
              </ul>`
            : html`<p class="hall-empty t-dim">服务器还没有完成过模拟。打完一局，这里会留下所有人的评语。</p>`}
        <//>
      </section>
    </div>
  </div>`;
}
