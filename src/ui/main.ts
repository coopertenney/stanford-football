/**
 * DOM wiring and charts.
 *
 * Charts are hand-rolled SVG: no library, because the page must be self-contained
 * and a strict CSP blocks external scripts anyway.
 */

import {
  decodeCohort,
  evaluate,
  ORDERED_OUTCOMES,
  TIER_COLORS,
  valueVector,
  type Cohort,
  type Evaluation,
  type Profile,
} from './app.ts';
import { starterSeasonValue } from '../model/value.ts';
import type { Era, PlayerSource, PositionGroup } from '../ingest/types.ts';

declare const __BUNDLE__: any;
declare const __COHORT_B64__: string;

const POSITIONS: PositionGroup[] = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'DB'];
const OUTCOME_CODE_NAMES = [
  'not observed',
  'Bust',
  'Depth / Rotation',
  'Starter',
  'Impact Player',
  'Redshirt',
  'Insufficient data',
  'Unresolved — never linked',
];

let cohort: Cohort;

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const money = (n: number): string =>
  (n < 0 ? '-$' : '$') +
  Math.abs(Math.round(n)).toLocaleString('en-US', { maximumFractionDigits: 0 });

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function readProfile(prefix: string): Profile {
  const num = (id: string): number | null => {
    const raw = $<HTMLInputElement>(prefix + id).value.trim();
    if (raw === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    stars: num('Stars'),
    rating: num('Rating'),
    ranking: num('Ranking'),
    height: num('Height'),
    weight: num('Weight'),
    position: $<HTMLSelectElement>(prefix + 'Position').value as PositionGroup,
    source: $<HTMLSelectElement>(prefix + 'Source').value as PlayerSource,
    era: $<HTMLSelectElement>(prefix + 'Era').value as Era,
  };
}

/** Stacked bar of the outcome distribution by eligibility year. */
function stackedBar(byYear: number[][], retention: number[]): string {
  const W = 560;
  const H = 210;
  const padL = 34;
  const padB = 26;
  const padT = 8;
  const bandW = (W - padL) / byYear.length;
  const barW = bandW * 0.62;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Outcome distribution by eligibility year">`;
  // Recessive gridlines at 25% intervals.
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    const y = padT + (1 - g) * (H - padT - padB);
    svg += `<line x1="${padL}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" class="tick">${g * 100}</text>`;
  }
  byYear.forEach((distribution, index) => {
    const x = padL + index * bandW + (bandW - barW) / 2;
    let cursor = 0;
    distribution.forEach((p, k) => {
      const h = p * (H - padT - padB);
      const y = padT + (1 - cursor - p) * (H - padT - padB);
      // 2px surface gap between stacked segments, per mark spec.
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(0, h - 2)}" fill="${TIER_COLORS[k]}"><title>${ORDERED_OUTCOMES[k]}: ${pct(p)} (year ${index + 1})</title></rect>`;
      cursor += p;
    });
    svg += `<text x="${x + barW / 2}" y="${H - 12}" text-anchor="middle" class="tick">Y${index + 1}</text>`;
    svg += `<text x="${x + barW / 2}" y="${H - 2}" text-anchor="middle" class="tick dim">${Math.round(retention[index]! * 100)}%</text>`;
  });
  svg += '</svg>';
  return svg;
}

/** Monte Carlo histogram with the offer drawn as a reference line. */
function histogram(mc: Evaluation['mc'], offer: number): string {
  const W = 560;
  const H = 180;
  const padL = 34;
  const padB = 26;
  const padT = 8;
  const max = Math.max(...mc.histogram.map((h) => h.count)) || 1;
  const bw = (W - padL) / mc.histogram.length;
  const lo = mc.histogram[0]!.edge;
  const hi = mc.histogram[mc.histogram.length - 1]!.edge;
  const span = hi - lo || 1;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Simulated career value distribution">`;
  mc.histogram.forEach((bucket, index) => {
    const h = (bucket.count / max) * (H - padT - padB);
    const x = padL + index * bw;
    svg += `<rect x="${x}" y="${H - padB - h}" width="${Math.max(1, bw - 2)}" height="${h}" fill="${TIER_COLORS[2]}" opacity="0.85"><title>${money(bucket.edge)}: ${bucket.count} runs</title></rect>`;
  });
  // Offer reference line — the comparison the chart exists to support.
  if (offer >= lo && offer <= hi) {
    const x = padL + ((offer - lo) / span) * (W - padL);
    svg += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" stroke="var(--ink)" stroke-width="2" stroke-dasharray="4 3"/>`;
    svg += `<text x="${x + 4}" y="${padT + 10}" class="tick">offer</text>`;
  }
  svg += `<text x="${padL}" y="${H - 8}" class="tick">${money(lo)}</text>`;
  svg += `<text x="${W}" y="${H - 8}" text-anchor="end" class="tick">${money(hi)}</text>`;
  svg += '</svg>';
  return svg;
}

function renderOne(target: string, evaluation: Evaluation, offer: number, position: PositionGroup): void {
  const { ev, mc, comps } = evaluation;
  const values = valueVector(position, __BUNDLE__.value);
  // One starter-season at this position, after the program-tier discount. Dividing
  // by it converts every dollar figure into starter-season equivalents — the unit
  // that carries NO estimated scale, so a reader can judge the football claim
  // separately from the pricing claim.
  const ss = starterSeasonValue(position, __BUNDLE__.value) || 1;
  const dual = (n: number): string => `${money(n)}<span class="eq">${(n / ss).toFixed(2)} SS</span>`;

  const metrics = [
    ['Expected value', dual(ev.expectedValue), 'Sum across all 5 years, retention-weighted'],
    ['Simulated mean', money(mc.mean), 'Should match EV — a gap means a modelling bug'],
    ['Certain equivalent', dual(evaluation.certainEquivalent), 'Risk-adjusted worth of the deal'],
    ['Risk discount', money(evaluation.riskDiscount), 'EV minus certain equivalent'],
    ['Net value', dual(ev.netValue), 'EV minus total compensation'],
    ['ROI', Number.isFinite(ev.roi) ? `${ev.roi.toFixed(2)}x` : '—', 'EV / compensation (one definition)'],
    ['Value above replacement', dual(ev.valueAboveReplacement), 'vs the player you would otherwise have'],
    ['One starter-season here', money(ss), `${position} starter, ACC-adjusted (ESPN 2026 survey)`],
    ['Upside P(Impact)', pct(ev.upsideProbability), 'Best year'],
    ['Downside P(Bust)', pct(ev.downsideProbability), 'Worst year'],
    ['Outcome std dev', money(ev.outcomeStdDev), 'Spread of total value'],
    ['P(below offer)', pct(mc.probabilityBelowOffer), `${mc.iterations.toLocaleString()} simulated careers`],
  ];

  const rows = ORDERED_OUTCOMES.map(
    (outcome, k) =>
      `<tr><td><span class="sw" style="background:${TIER_COLORS[k]}"></span>${outcome}</td>` +
      evaluation.byYear.map((d) => `<td class="num">${pct(d[k]!)}</td>`).join('') +
      `<td class="num dim">${money(values[k]!)}</td></tr>`,
  ).join('');

  $(target).innerHTML = `
    <div class="metrics">
      ${metrics.map(([label, value, note]) => `<div class="metric"><span class="ml">${label}</span><b>${value}</b><span class="mn">${note}</span></div>`).join('')}
    </div>
    <h3>Outcome distribution by eligibility year</h3>
    <p class="cap">Bar height is probability. The faint percentage under each year is the chance the player is still on your roster that season — the predecessor assumed 100%.</p>
    <div class="chart">${stackedBar(evaluation.byYear, evaluation.retention)}</div>
    <div class="scroller"><table>
      <thead><tr><th>Outcome</th><th class="num">Y1</th><th class="num">Y2</th><th class="num">Y3</th><th class="num">Y4</th><th class="num">Y5</th><th class="num">Value/yr</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <h3>Simulated career value</h3>
    <p class="cap">Median ${money(mc.median)} · p10 ${money(mc.p10)} · p90 ${money(mc.p90)}. Years are drawn independently, which overstates spread.</p>
    <div class="chart">${histogram(mc, offer)}</div>
    <h3>Comparable players <span class="dim">(${comps.length} nearest)</span></h3>
    <p class="cap">Shown for context. Probabilities above come from the fitted model, not from these comps.</p>
    <div class="scroller"><table>
      <thead><tr><th>Player</th><th>Team</th><th class="num">Class</th><th class="num">★</th><th>Y1-Y5 outcomes</th></tr></thead>
      <tbody>${comps.slice(0, 25).map((c) => `<tr><td>${c.name}</td><td class="dim">${c.team}</td><td class="num">${c.recruitYear}</td><td class="num">${c.stars || '—'}</td><td>${c.outcomes.map((code) => `<span class="pip" title="${OUTCOME_CODE_NAMES[code]}" style="background:${code >= 1 && code <= 4 ? TIER_COLORS[code - 1] : 'var(--grid)'}"></span>`).join('')}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

function run(): void {
  const offer = Number($<HTMLInputElement>('offer').value) || 0;
  const p = Number($<HTMLInputElement>('prefP').value) || 0.5;
  $('rOut').textContent = `r = ${riskOddsLabel(p)}`;

  const a = readProfile('a');
  renderOne('outA', evaluate(cohort, __BUNDLE__, a, offer, p), offer, a.position);

  const compare = $<HTMLInputElement>('compare').checked;
  $('paneB').style.display = compare ? '' : 'none';
  if (compare) {
    const b = readProfile('b');
    renderOne('outB', evaluate(cohort, __BUNDLE__, b, offer, p), offer, b.position);
  }
}

const riskOddsLabel = (p: number): string => {
  const r = p / (1 - p);
  if (Math.abs(r - 1) < 0.02) return '1.00 (risk neutral)';
  return `${r.toFixed(2)} (${r > 1 ? 'risk averse' : 'risk seeking'})`;
};

function boot(): void {
  cohort = decodeCohort(__COHORT_B64__);
  $('cohortInfo').textContent = `${cohort.count.toLocaleString()} recruits, ${cohort.teams.length} teams`;
  for (const prefix of ['a', 'b']) {
    const select = $<HTMLSelectElement>(prefix + 'Position');
    select.innerHTML = POSITIONS.map((p) => `<option>${p}</option>`).join('');
  }
  $<HTMLSelectElement>('aPosition').value = 'WR';
  $<HTMLSelectElement>('bPosition').value = 'WR';
  document.querySelectorAll('input,select').forEach((el) =>
    el.addEventListener('change', run),
  );
  $('compare').addEventListener('change', run);
  run();
}

document.addEventListener('DOMContentLoaded', boot);
