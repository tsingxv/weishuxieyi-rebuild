// Briefing — INFO_CHECK "1/2 确认本局信息" (research 06 §4.1, D1): enemy leader (silhouette, name,
// abilities), stage (+ its pool: 战场固定 / 战场随机（共N张）), 特训敌人 factions (icon, name, description), 核心盟约 / 附加盟约 rows of bond discs
// (disabled bonds greyed with the banned-member badge), 本局禁用干员 avatars, difficulty tag, the ready
// count x/N with person pips, the 准备就绪 button (g.infoReady) and the countdown.

import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, BondDisc, Tooltip } from '../ui/components.js';
import { useGameData, Img, UnitThumb, RichText } from '../ui/gameComponents.js';
import { StepHeader, ExitModal } from '../ui/matchChrome.js';
import { LoadoutButton } from './loadout.js';
import { actions } from '../ui/gameActions.js';
import { factionTypes, bannedPerBond, sortedPlayers, phaseTotalSeconds, disabledBondSets, briefingBondTip } from '../ui/gameLogic.js';
import { bondIconUrl, enemyIconUrl, factionIconUrl } from '../ui/assetUrls.js';
import { useStore } from '../store.js';
import { data } from '../data.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

function BondRow({ title, micro, bonds, sets, perBond }) {
  const m = data.get('assets');
  return html`<div class="brief-bonds">
    <h3 class="brief-h"><span>${title}</span><${MicroLabel}>${micro}</${MicroLabel}></h3>
    <div class="brief-bonds__row">
      ${bonds.map((b) => {
        // greyed: the drawn set D (still activatable, roster incomplete) and the mode's static inactive bonds
        const state = sets.off.has(b.bondId) ? 'off' : sets.drawn.has(b.bondId) ? 'drawn' : null;
        const off = !!state;
        const bannedN = perBond.get(b.bondId) || 0;
        const tip = briefingBondTip(b.name, state, bannedN);
        return html`<${Tooltip} key=${b.bondId} text=${tip}>
          <div class=${cx('brief-bond', off && 'is-off', state === 'drawn' && 'is-incomplete', !off && bannedN > 0 && 'is-partial')}>
            <${BondDisc} name=${b.name} icon=${bondIconUrl(m, b.bondId)} active=${!off} disabled=${off} tier=${off ? 0 : (b.thresholds?.length || 1)}
              maxTier=${Math.max(1, b.thresholds?.length || 1)} size="md" />
            ${bannedN > 0 ? html`<span class="brief-bond__ban num"><${Icon} name="user" />${bannedN}</span>` : null}
          </div>
        <//>`;
      })}
    </div>
  </div>`;
}

/** INFO_CHECK screen. */
export function BriefingScreen() {
  const pub = useStore((s) => s.match.public);
  const myId = useStore((s) => s.me.playerId);
  const solo = useStore((s) => s.room?.mode === 'solo') || String(pub?.modeId || '').includes('single');
  const gd = useGameData();
  const [exit, setExit] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!pub) return null;

  const players = sortedPlayers(pub);
  const me = players.find((p) => p.playerId === myId);
  const readyN = players.filter((p) => p.ready).length;
  const mode = gd.config?.modes?.[pub.modeId];
  const sets = disabledBondSets(pub, mode?.inactiveBondIds);
  const bonds = gd.list('bonds').sort((a, b) => (a.bondOrder ?? 0) - (b.bondOrder ?? 0) || (a.identifier ?? 0) - (b.identifier ?? 0));
  const core = bonds.filter((b) => b.isCore);
  const addon = bonds.filter((b) => !b.isCore);
  const banned = (Array.isArray(pub.bannedChess) ? pub.bannedChess : []).filter((id) => gd.chess(id));
  banned.sort((a, b) => (gd.chess(a)?.tier ?? 0) - (gd.chess(b)?.tier ?? 0));
  const perBond = bannedPerBond(bonds, banned);
  const boss = pub.bossId ? gd.boss(pub.bossId) : null;
  const bossEnemy = boss ? gd.enemy(boss.enemyKey) : null;
  const stage = pub.stageId ? gd.stage(pub.stageId) : null;
  // the mode's battlefield pool (config.json modes[].stages): 标准 is always 战场#01, 险境+ draw one at random
  const poolN = Array.isArray(mode?.stages) ? mode.stages.length : 0;
  const pool = poolN > 1 ? `战场随机（共${poolN}张）` : poolN === 1 ? '战场固定' : '';
  const types = factionTypes(pub.factions);
  const factions = gd.factions?.types || {};
  const m = gd.m;

  const ready = async () => {
    if (busy || me?.ready) return;
    setBusy(true);
    await actions.infoReady();
    setBusy(false);
  };

  return html`<div class="screen brief">
    <div class="brief__bg" aria-hidden="true"></div>
    <${StepHeader} step=${1} of=${2} title="确认本局信息" micro="BRIEFING // INFO CHECK" pub=${pub}
      total=${phaseTotalSeconds(pub, gd.config)} onExit=${() => setExit(true)} />
    <main class="brief__main">
      <section class="brief__left">
        <div class="brief-boss brackets">
          <${MicroLabel} tone="gold">ENEMY LEADER // 敌方领袖</${MicroLabel}>
          <div class="brief-boss__art">
            <div class="brief-boss__ring" aria-hidden="true"></div>
            ${bossEnemy ? html`<${Img} src=${enemyIconUrl(m, boss.enemyKey)} class="brief-boss__sil" fallback=${html`<span class="brief-boss__q">?</span>`} />`
              : html`<span class="brief-boss__q">?</span>`}
          </div>
          <div class="brief-boss__text">
            <h2 class="brief-boss__name">${boss?.name || bossEnemy?.name || '未知领袖'}</h2>
            <span class="brief-boss__when">第 <b class="num">${mode?.bossRound ?? pub.lastRound ?? 14}</b> 回合 · 最终攻势</span>
            ${Array.isArray(boss?.abilities) && boss.abilities.length ? html`<ul class="brief-boss__abil">
              ${boss.abilities.slice(0, 3).map((a, i) => html`<li key=${i}><${RichText} text=${a} /></li>`)}
            </ul>` : null}
          </div>
        </div>
        <div class="brief-stage">
          <span class="brief-stage__k"><${MicroLabel}>BATTLEFIELD</${MicroLabel}>${pool ? html`<span class="brief-stage__pool">${pool}</span>` : null}</span>
          <span class="brief-stage__name"><${Icon} name="rook" />${stage?.name || pub.stageId || '—'}</span>
        </div>
        <div class="brief-factions">
          <h3 class="brief-h"><span>特训敌人</span><${MicroLabel}>SPECIAL ENEMIES</${MicroLabel}></h3>
          ${types.length ? types.map((t) => html`<div key=${t} class="brief-faction">
            <span class="brief-faction__icon"><${Img} src=${factionIconUrl(m, factions[t]?.icon)} /></span>
            <span class="brief-faction__text"><b>${factions[t]?.name || t}</b><span>${factions[t]?.desc || ''}</span></span>
          </div>`) : html`<p class="t-dim">本局没有特训敌人</p>`}
        </div>
      </section>
      <section class="brief__right">
        <${BondRow} title="核心盟约" micro="CORE BONDS" bonds=${core} sets=${sets} perBond=${perBond} />
        <${BondRow} title="附加盟约" micro="ADD-ON BONDS" bonds=${addon} sets=${sets} perBond=${perBond} />
        <p class="brief-legend"><span class="brief-legend__off"></span>灰色：部分盟约所含干员阵容不完整（仍可通过其他盟约的干员或装备激活）${sets.off.size ? '，或本模式禁用' : ''} · <span class="brief-legend__ban"><${Icon} name="user" /></span>该盟约中无法出现的干员数</p>
        <div class="brief-banned">
          <h3 class="brief-h"><span>本局禁用干员</span><${MicroLabel}>BANNED OPERATORS</${MicroLabel}><b class="num brief-banned__n">${banned.length}</b></h3>
          ${banned.length ? html`<div class="brief-banned__grid">
            ${banned.map((id) => html`<${UnitThumb} key=${id} kind="chess" id=${id} size="sm" dim=${true} />`)}
          </div>` : html`<p class="t-dim">本局没有禁用干员</p>`}
        </div>
      </section>
    </main>
    <footer class="brief__foot">
      <${LoadoutButton} from="briefing" size="lg" class="brief-loadout" />
      <div class="brief-ready">
        <span class="brief-ready__txt">已就绪 <b class="num">${readyN}</b><span class="num">/${players.length}</span></span>
        <span class="brief-ready__pips">${players.map((p) => html`<i key=${p.playerId} class=${cx(p.ready && 'on', p.playerId === myId && 'me')} title=${p.name}><${Icon} name="user" /></i>`)}</span>
      </div>
      <${Button} variant="primary" size="xl" icon=${me?.ready ? 'check' : 'play'} active=${!!me?.ready} loading=${busy}
        disabled=${!!me?.ready || !me} onClick=${ready}>${me?.ready ? '已就绪' : '准备就绪'}<//>
    </footer>
    <${ExitModal} open=${exit} onClose=${() => setExit(false)} solo=${solo} />
  </div>`;
}
