// 我的战绩 — the settlement screen's permanent record (public/js/ui/history.js).
//
// The server keeps only a short in-memory ring of finished matches for the 大厅 (server/hall.js); this
// panel is what survives a restart, because it lives in the player's own browser. It shows this match's
// outcome and 评语 next to the cumulative totals, so "最近的战绩和相应的称号" is answerable after a
// reload, on a server that has forgotten everything.
//
// Kept deliberately small and dense: the settlement screen is already busy, so this is a strip of
// figures plus at most three 评语 chips, not a table.

import { html, Icon, MicroLabel } from './components.js';
import { loadHistory, summarize, titleNameOf, HISTORY_KEEP } from './history.js';
import { loadProfile } from './profile.js';

/** How many 评语 chips to show at most (the rest is a count). */
const TITLES_MAX = 3;

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * Compact duration ("12 分 34 秒" / "45 秒"), tolerating a missing/absurd value.
 * @param {number} ms
 */
function fmtDuration(ms) {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
  if (total == null) return null;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/**
 * Read the stored history and fold it for display.
 * Never throws: a browser without localStorage yields an empty history (see history.js).
 * @param {string} [profileId]
 */
export function loadMine(profileId) {
  const entries = loadHistory();
  return { entries, stats: summarize(entries, profileId) };
}

/** One figure of the summary strip. */
function Stat({ label, value, tone }) {
  return html`<div class=${`hmine__stat${tone ? ` is-${tone}` : ''}`}>
    <${MicroLabel}>${label}<//>
    <b class="num">${value}</b>
  </div>`;
}

/**
 * This match's own line: the server's verdict plus the 评语 I earned.
 * @param {{ mine?: any, victory: boolean, roundsPassed?: number, durationMs?: number }} props
 */
function ThisMatch({ mine, victory, roundsPassed, durationMs }) {
  const titleName = titleNameOf(mine);
  const duration = fmtDuration(durationMs);
  return html`<div class="hmine__this">
    <span class=${`hmine__badge${victory ? ' is-win' : ' is-lose'}`}>${victory ? '模拟完成' : '模拟失败'}</span>
    ${Number.isFinite(roundsPassed) ? html`<span class="hmine__kv">通过 <b class="num">${roundsPassed}</b> 回合</span>` : null}
    ${duration ? html`<span class="hmine__kv">耗时 <b class="num">${duration}</b></span>` : null}
    ${titleName
      ? html`<span class="hmine__title" title="本局评语"><${Icon} name="crown" /><b>${titleName}</b></span>`
      : html`<span class="hmine__kv t-dim">本局未获评语</span>`}
  </div>`;
}

/**
 * The 我的战绩 panel: this match, then the permanent totals of this browser profile.
 *
 * @param {{ result: any, myId?: string|null }} props `result` is the raw `m.result` payload
 * @returns {any}
 */
export function MyRecordPanel({ result, myId }) {
  const profile = loadProfile();
  const { entries, stats } = loadMine(profile.profileId);
  const list = Array.isArray(result?.players) ? result.players : [];
  // Match the same way history.js does: by playerId when known, else by the remembered nickname.
  const mine = (myId && list.find((p) => p && p.playerId === myId))
    || list.find((p) => p && !p.isBot && p.name === profile.name)
    || null;
  const victory = mine ? !!mine.victory : !!result?.victory;
  const roundsPassed = mine && Number.isFinite(mine.roundsPassed) ? mine.roundsPassed : result?.roundsPassed;
  const titles = stats.titles.slice(0, TITLES_MAX);
  const moreTitles = Math.max(0, stats.titles.length - titles.length);

  return html`<section class="hmine" aria-label="我的战绩">
    <h2 class="brief-h">
      <span>我的战绩</span>
      <${MicroLabel}>CAREER RECORD<//>
    </h2>
    <${ThisMatch} mine=${mine} victory=${victory} roundsPassed=${roundsPassed} durationMs=${result?.durationMs} />
    ${stats.total === 0
      ? html`<p class="hmine__empty t-dim">本地还没有记录。在这台设备上打完一局后，战绩会永久保存在这里。</p>`
      : html`<div class="hmine__grid">
          <${Stat} label="总场次" value=${stats.total} />
          <${Stat} label="完成" value=${stats.wins} tone="win" />
          <${Stat} label="失败" value=${stats.losses} tone="lose" />
          <${Stat} label="完成率" value=${pct(stats.winRate)} />
          <${Stat} label="最佳回合" value=${stats.bestRounds} />
          ${stats.hiddenClears > 0 ? html`<${Stat} label="隐秘核心" value=${stats.hiddenClears} tone="win" />` : null}
        </div>`}
    ${titles.length
      ? html`<div class="hmine__titles">
          <${MicroLabel}>最常获得的评语<//>
          ${titles.map((t) => html`<span class="hmine__chip" key=${t.name}><${Icon} name="crown" />${t.name}<b class="num">×${t.count}</b></span>`)}
          ${moreTitles > 0 ? html`<span class="hmine__more t-dim">还有 ${moreTitles} 项</span>` : null}
        </div>`
      : null}
    <p class="hmine__note t-dim">
      保存在本机浏览器（最近 ${HISTORY_KEEP} 局）· 换设备或清理浏览器数据后不再保留
    </p>
  </section>`;
}
