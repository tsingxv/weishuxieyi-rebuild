// 邀请横幅 — "a room code is in your clipboard".
//
// Plain-http LAN play has no `navigator.clipboard` (it needs a secure context), so this banner is
// realistically a **localhost / https** affordance in the browser client; the desktop client reads the
// clipboard from its own shell instead (client/clipboardWatcher.js) and shows a native prompt. It is
// still worth having here: the exe serves the game from `http://127.0.0.1`, which *is* a secure
// context, and a player on `https` (a reverse proxy) gets it too.
//
// Detection is deliberate, not a poll: one check on mount, then on window focus. Reading the clipboard
// unbidden on a timer would be hostile, and asking for the permission needs a user gesture in most
// browsers anyway.
//
// Layout: the title screen has almost no vertical slack at the phone minimum (640×360 — the login box
// ends at 337 and the footer starts at 340), so an in-flow row would push `.title-conn` past the
// viewport and the devices e2e would flag it as clipped. The strip is therefore absolutely positioned
// above whatever it is anchored to (`bottom: calc(100% + .06rem)`), which costs the document nothing.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon } from './components.js';
import { store, loadPref, savePref } from '../store.js';
import { parseInvite, readClipboardText, shouldCheckClipboard } from './clipboard.js';

/** Preference: the player asked never to be told about clipboard invites again. */
export const K_INVITE_MUTED = 'inviteMuted';

/** Is the "don't tell me again" switch on? */
export function inviteMuted() {
  return loadPref(K_INVITE_MUTED, false) === true;
}

/** Remember the "don't tell me again" switch. */
export function muteInvite() {
  savePref(K_INVITE_MUTED, true);
}

/** Turn the clipboard-invite prompt back on (the settings modal's switch). */
export function unmuteInvite() {
  savePref(K_INVITE_MUTED, false);
}

/**
 * Join a room through the game's EXISTING deep-link path: the router/`schedulePendingJoin()` in
 * main.js owns the actual `room.join`, the retry after a reconnect, and the "already in another room"
 * guard. Setting the store field is all this banner has to do.
 * @param {string} code
 */
export function requestJoin(code) {
  store.patch('ui', { pendingJoin: code });
}

/**
 * The dismissible invite strip.
 *
 * @param {{ anchor?: 'top'|'bottom' }} [props] `bottom` (default) sits above a login box; `top` hangs
 *   under the top edge — both are absolutely positioned, so neither changes the layout.
 */
export function InviteBanner({ anchor = 'bottom' } = {}) {
  const [invite, setInvite] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (inviteMuted()) return undefined;
    let checking = false;
    const check = async () => {
      if (checking || !shouldCheckClipboard()) return;
      checking = true;
      try {
        const text = await readClipboardText();
        if (!alive.current) return;
        const found = text ? parseInvite(text) : null;
        // Only surface a *new* code: re-showing the same one after 忽略 would be nagging.
        setInvite((cur) => (found && (!cur || cur.code !== found.code) ? found : cur));
      } finally {
        checking = false;
      }
    };
    check();
    globalThis.addEventListener?.('focus', check);
    return () => globalThis.removeEventListener?.('focus', check);
  }, []);

  if (!invite || dismissed) return null;
  const accept = () => {
    requestJoin(invite.code);
    setDismissed(true);
  };
  const ignore = () => setDismissed(true);
  const never = () => {
    muteInvite();
    setDismissed(true);
  };

  return html`<div class=${`invite-banner invite-banner--${anchor}`} role="status">
    <${Icon} name="key" />
    <span class="invite-banner__text">检测到房间码 <b class="num">${invite.code}</b></span>
    <div class="invite-banner__acts">
      <${Button} variant="primary" size="sm" icon="chevrons" onClick=${accept}>进入房间<//>
      <${Button} variant="ghost" size="sm" onClick=${ignore}>忽略<//>
      <button type="button" class="invite-banner__never" onClick=${never}>不再提示</button>
    </div>
  </div>`;
}
