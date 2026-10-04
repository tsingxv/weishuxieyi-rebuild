// Room invites that arrive as a copied link: recognise the room code, and read it back from the
// clipboard when the browser allows it.
//
// Pure module scope: no DOM and no browser global is touched while this file is evaluated, so the test
// suite can import it in plain Node. Everything browser-dependent sits behind a function.
//
// The clipboard API needs a secure context (https or localhost); a plain-http LAN game therefore has
// no `navigator.clipboard` at all. Every path degrades to `null` — a missing clipboard may never
// block the title screen, and a `readText()` that never settles (permission prompt) is raced against
// a short timeout instead of hanging the caller.

/** Shortest / longest room code the protocol accepts (shared/constants ROOM_CODE_LEN..+2). */
const CODE_MIN = 4;
const CODE_MAX = 6;
/** Give up on the clipboard after this long — a prompt that never resolves must not stall the UI. */
export const CLIPBOARD_TIMEOUT_MS = 300;

function isAlnum(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/** Code right after a `room=` query parameter, or null. Uppercased like the lobby does. */
function codeFromParam(text) {
  const at = text.indexOf('room=');
  if (at < 0) return null;
  // Only a real query parameter counts: `?room=` / `&room=`. A path such as `/room=ABC` is not an invite.
  if (at > 0 && text[at - 1] !== '?' && text[at - 1] !== '&') return null;
  let i = at + 5;
  let code = '';
  while (i < text.length && code.length <= CODE_MAX) {
    const ch = text[i];
    if (!isAlnum(ch)) break;
    code += ch;
    i += 1;
  }
  if (code.length < CODE_MIN || code.length > CODE_MAX) return null;
  return code.toUpperCase();
}

function isHttpUrl(text) {
  const head = text.slice(0, 8).toLowerCase();
  return head.startsWith('http://') || head.startsWith('https://');
}

/**
 * Recognise a room invite in text the player copied.
 * Accepted: a bare 4–6 character alphanumeric code, `?room=CODE` / `&room=CODE`, or an http(s) link
 * carrying `?room=`. The link form keeps the whole URL so the caller can also just open it.
 * @param {unknown} input
 * @returns {{ code: string, url: string|null }|null} url is the full link only for an http(s) input
 */
export function parseInvite(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  // A bare code: the whole (trimmed) text is the code.
  if (upper.length >= CODE_MIN && upper.length <= CODE_MAX) {
    let allAlnum = true;
    for (let i = 0; i < upper.length; i += 1) if (!isAlnum(upper[i])) { allAlnum = false; break; }
    if (allAlnum) return { code: upper, url: null };
  }
  const code = codeFromParam(text);
  if (!code) return null;
  return { code, url: isHttpUrl(text) ? text : null };
}

/** True when this browser can read the clipboard at all (secure context + the API present). */
export function shouldCheckClipboard() {
  try {
    if (!globalThis.isSecureContext) return false;
    return typeof globalThis.navigator?.clipboard?.readText === 'function';
  } catch {
    return false;
  }
}

/**
 * Read the clipboard, resolving to `null` on every failure: no API, insecure context, denied
 * permission, or a read that takes longer than CLIPBOARD_TIMEOUT_MS. Never rejects, never hangs.
 * @returns {Promise<string|null>}
 */
export function readClipboardText() {
  try {
    if (!shouldCheckClipboard()) return Promise.resolve(null);
    const read = globalThis.navigator.clipboard.readText();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(typeof value === 'string' && value ? value : null);
      };
      const timer = setTimeout(() => finish(null), CLIPBOARD_TIMEOUT_MS);
      Promise.resolve(read).then(finish, () => finish(null));
    });
  } catch {
    return Promise.resolve(null);
  }
}
