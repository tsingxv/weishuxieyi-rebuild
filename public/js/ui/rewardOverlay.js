// Merge reward reminder (research 00 §3): the reward cards themselves live in the shop bar (shopBar.js RewardCards —
// after a promotion they replace the bar's operator cards, like the original). When the player puts the pick off
// (稍后选择) this pill above the bar brings the cards back; it disappears once the server clears `shop.rewardOffer`
// (picked, or the round ended).

import { html, Icon, TierChip } from './components.js';

/**
 * @param {{ priv:any, minimized:boolean, onMinimize:(m:boolean)=>void }} props
 */
export function RewardOverlay({ priv, minimized, onMinimize }) {
  const offer = priv?.shop?.rewardOffer;
  if (!offer || !Array.isArray(offer.slots) || !offer.slots.length || !minimized) return null;
  return html`<button type="button" class="rewardpill" onClick=${() => onMinimize(false)}>
    <${Icon} name="crown" /><span>晋升奖励待选择</span><${TierChip} tier=${offer.tier || 1} size="sm" />
  </button>`;
}
