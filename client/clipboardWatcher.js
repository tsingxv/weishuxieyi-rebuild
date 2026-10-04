// client/clipboardWatcher.js — bounded clipboard sampling for the desktop shell.
//
// WHY: the "one-click join" prompt is driven by whatever the player copies in another application, so
// this module decides *when* it is polite to look. Everything is injectable (the clipboard reader, the
// clock, the timer) so the sampling policy is testable without Electron and without a real clipboard.
//
// Policy:
//   * sampling happens only while the game window is focused and only every `intervalMs` (~2 s) —
//     the caller stops the watcher when the window is hidden, offline or in a match, because a
//     prompt during a fight is exactly what the task forbids;
//   * a clipboard read is de-duplicated by content: the same text is never surfaced twice in a row,
//     so a link that stays in the clipboard prompts once and not once every two seconds;
//   * an empty/unreadable clipboard never clears the memory of the last text, so a transient read
//     failure cannot make the same invite pop back up;
//   * text longer than `maxTextLength` is ignored outright (nobody invites you with a document);
//   * clipboard text is never logged here — only the room code and the reason.
//
// `read()` may be synchronous or return a promise: Electron 44's main-process `clipboard.readText()`
// returns `Promise<string>` (electron.d.ts), so both shapes must work and a rejection counts as
// "unreadable" exactly like a synchronous throw. Consequently `poll()` is always a promise.
//
// Pure module: no Electron import. `client/main.js` supplies `read: () => clipboard.readText()`.

import { MAX_TEXT, parseInvite } from './invite.js';

/** How often the clipboard is sampled while the game window is focused. */
export const DEFAULT_POLL_MS = 2000;

/**
 * @typedef {object} WatchResult
 * @property {import('./invite.js').Invite|null} invite
 * @property {'invite'|'unchanged'|'empty'|'too-long'|'no-invite'|'disabled'|'unreadable'} reason
 * @property {number} at  `now()` when the sample was taken
 */

/**
 * @param {object} opts
 * @param {() => unknown | Promise<unknown>} opts.read   read the clipboard (may throw or reject)
 * @param {(invite: import('./invite.js').Invite) => void} [opts.onInvite]  called for every new invite
 * @param {(text: unknown) => import('./invite.js').Invite|null} [opts.parse]  injected for tests
 * @param {() => number} [opts.now]
 * @param {typeof setInterval} [opts.setTimer]
 * @param {typeof clearInterval} [opts.clearTimer]
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.maxTextLength]
 * @param {(msg: string) => void} [opts.log]
 */
export function createClipboardWatcher({
  read,
  onInvite = null,
  parse = parseInvite,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  intervalMs = DEFAULT_POLL_MS,
  maxTextLength = MAX_TEXT,
  log = () => {},
} = {}) {
  if (typeof read !== 'function') throw new TypeError('createClipboardWatcher: read() is required');

  /** Last non-empty text we looked at; the de-duplication key. */
  let lastText = null;
  let enabled = true;
  let running = false;
  let timer = null;
  let readFailed = false;
  /**
   * Samples can overlap (an async read is a real await), so only the newest one may commit `lastText`
   * and fire. Without this, a slow read of the *previous* clipboard contents would land after a fresh
   * read and prompt for a stale invite.
   */
  let seq = 0;

  /** @returns {Promise<WatchResult>} */
  async function sample() {
    const at = now();
    if (!enabled) return { invite: null, reason: 'disabled', at };
    const mine = ++seq;

    let text;
    try {
      // `await` covers both shapes: a sync string resolves immediately, a promise is unwrapped.
      text = await read();
    } catch (e) {
      if (!readFailed) {
        readFailed = true;
        log(`[clipboard] cannot read the clipboard: ${e && e.message ? e.message : e}`);
      }
      return { invite: null, reason: 'unreadable', at };
    }
    // A newer sample has already reported; this one is stale and must not fire or touch state.
    if (mine !== seq) return { invite: null, reason: 'unchanged', at };
    readFailed = false;

    if (typeof text !== 'string') return { invite: null, reason: 'empty', at };
    const trimmed = text.trim();
    if (!trimmed) return { invite: null, reason: 'empty', at };
    if (trimmed.length > maxTextLength) {
      lastText = trimmed;
      return { invite: null, reason: 'too-long', at };
    }
    if (trimmed === lastText) return { invite: null, reason: 'unchanged', at };
    lastText = trimmed;

    let invite = null;
    try {
      invite = parse(trimmed);
    } catch (e) {
      log(`[clipboard] cannot parse clipboard text: ${e && e.message ? e.message : e}`);
      return { invite: null, reason: 'no-invite', at };
    }
    if (!invite) return { invite: null, reason: 'no-invite', at };

    log(`[clipboard] invite for ${invite.code} (${invite.source}${invite.server ? `, ${invite.server}` : ''})`);
    if (onInvite) {
      try {
        onInvite(invite);
      } catch (e) {
        log(`[clipboard] invite handler failed: ${e && e.message ? e.message : e}`);
      }
    }
    return { invite, reason: 'invite', at };
  }

  function start() {
    if (running || !enabled) return;
    running = true;
    timer = setTimer(() => {
      // Errors are already contained inside sample(); this catches a rejected promise from the async
      // path so the interval can never become an unhandled rejection.
      Promise.resolve()
        .then(sample)
        .catch((e) => log(`[clipboard] sample failed: ${e && e.message ? e.message : e}`));
    }, intervalMs);
    // An active interval must never be the reason the process stays alive (Electron quits on its own;
    // a plain `node --test` process would otherwise be held open by an injected real timer).
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    running = false;
  }

  return {
    /** Take one sample now (the window-focus handler calls this directly). Always a promise. */
    poll: sample,
    start,
    stop,
    get running() { return running; },
    get enabled() { return enabled; },
    /** The settings checkbox. Turning it on/off starts/stops the sampling loop to match. */
    setEnabled(value) {
      const next = value !== false;
      if (next === enabled) return;
      enabled = next;
      if (enabled) start();
      else stop();
    },
    /** Forget the last text, so the current clipboard contents are considered again. */
    reset() { lastText = null; },
    /** The last text looked at (for tests; deliberately never written to the log). */
    get lastText() { return lastText; },
  };
}
