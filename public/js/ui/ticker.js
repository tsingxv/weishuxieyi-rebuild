// Broadcast ticker (m.ticker): a strip under the top bar; each line slides in from the right, stays
// TICKER_MS and leaves; queued lines play in order (only the newest QUEUE_MAX are kept).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { GIcon, RichText } from './gameComponents.js';
import { useStore } from '../store.js';
import { audio } from '../audio.js';

const TICKER_MS = 5200;
const QUEUE_MAX = 4;

/** Ticker strip bound to store.ticker. */
export function Ticker() {
  const items = useStore((s) => s.ticker);
  const seen = useRef(null);
  const queue = useRef([]);
  const [cur, setCur] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    const list = Array.isArray(items) ? items : [];
    if (seen.current == null) {
      // lines received before this screen mounted are history, not news
      seen.current = list.length ? list[list.length - 1].id : 0;
      return;
    }
    const fresh = list.filter((t) => t && t.id > seen.current && Date.now() - t.at < 30000);
    if (!fresh.length) return;
    seen.current = fresh[fresh.length - 1].id;
    queue.current = [...queue.current, ...fresh].slice(-QUEUE_MAX);
    if (!cur) next();
  }, [items]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function next() {
    const it = queue.current.shift() || null;
    setCur(it);
    if (it) {
      audio.sfx('broadcast', { volume: 0.5 });
      clearTimeout(timer.current);
      timer.current = setTimeout(next, TICKER_MS);
    }
  }

  if (!cur) return null;
  return html`<div class="ticker" role="status" aria-live="polite">
    <div key=${cur.id} class="ticker__line"><${GIcon} name="flag" class="ticker__icon" /><${RichText} text=${cur.text} /></div>
  </div>`;
}
