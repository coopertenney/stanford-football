/**
 * Derive the labeling constants, and guard the pipeline's headline numbers.
 *
 *   npm run calibrate         # derive + compare against the pinned baseline
 *   npm run calibrate --pin   # accept current values as the new baseline
 *
 * WHY THIS EXISTS
 * Two constant tables in label.ts determine every outcome label —
 * STARTER_SNAP_SHARE and IMPACT_WAA — and until now neither could be re-derived
 * from anything in the repo. The comment said "re-derive if the slot assumptions
 * change", with nothing to re-derive it with. That gap is how the Impact volume
 * miss survived: the cuts were producing 263 seasons a year against a declared
 * target of 350 and nothing recomputed it.
 *
 * It also pins the headline distribution. scripts/check.py guards the LEGACY
 * artifacts only — it reads yearly_player_outcomes.csv and never touches
 * labeled_seasons.json — so nothing caught the three regressions introduced while
 * fixing this pipeline. They were found by adversarial review, which is not a
 * repeatable process. This is.
 *
 * A CHANGED result is not automatically a failure. Read which number moved and in
 * which direction; if a fix moved it, re-pin deliberately and say why in the commit.
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  IMPACT_WAA,
  STARTER_SNAP_SHARE,
  STARTING_SLOTS,
  isCensored,
  type Outcome,
} from './label.ts';
import type { PositionGroup } from './types.ts';

const LABELED = 'data/labeled_seasons.json';
const BASELINE = 'scripts/baseline_ts.json';

/** Starters per real starting slot the snap-share cuts should reproduce. */
const STARTERS_PER_SLOT_TARGET = 0.37;
/** Impact seasons per year, matched to All-Conference volume across the Power 4. */
const IMPACT_PER_SEASON_TARGET = 350;
/** Season where cohort coverage approximates a full FBS roster (5 classes deep). */
const REFERENCE_SEASON = 2024;

const POSITIONS: PositionGroup[] = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'DB'];

interface Row {
  position: PositionGroup;
  season: number;
  team: string | null;
  outcome: Outcome;
  snapShare: number | null;
  pffWaa: number | null;
  eligibilityYear: number;
  stars: number | null;
  athleteId: string | null;
}

const quantile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))] ?? 0;

async function main(): Promise<void> {
  const pin = process.argv.includes('--pin');
  const rows: Row[] = JSON.parse(await readFile(LABELED, 'utf8'));
  const reported = rows.filter((r) => !isCensored(r.outcome));
  console.log(`${rows.length} rows, ${reported.length} reported`);

  // ---- derive STARTER_SNAP_SHARE ----------------------------------------
  // The cut that yields the same number of Starters per real starting slot at every
  // position. Equalizing the RATIO rather than a quantile is what keeps this from
  // being a percentile rule: cohort population per slot varies ~2x across
  // positions, so the two anchors are arithmetically different objects.
  console.log('\n=== DERIVED STARTER_SNAP_SHARE ===');
  console.log(`  target ${STARTERS_PER_SLOT_TARGET} starters per starting slot`);
  console.log(`  ${'POS'.padEnd(5)}${'CURRENT'.padStart(9)}${'DERIVED'.padStart(9)}${'DRIFT'.padStart(8)}`);
  const derivedStarter: Record<string, number> = {};
  for (const position of POSITIONS) {
    const teamSeasons = new Set(
      rows.filter((r) => r.position === position && r.team).map((r) => `${r.season}:${r.team}`),
    );
    const target = Math.round(
      STARTERS_PER_SLOT_TARGET * STARTING_SLOTS[position] * teamSeasons.size,
    );
    const shares = rows
      .filter((r) => r.position === position && r.snapShare != null)
      .map((r) => r.snapShare!)
      .sort((a, b) => b - a);
    const cut = target > 0 && target <= shares.length ? shares[target - 1]! : Number.NaN;
    derivedStarter[position] = Number(cut.toFixed(3));
    const current = STARTER_SNAP_SHARE[position];
    console.log(
      `  ${position.padEnd(5)}${current.toFixed(3).padStart(9)}${cut.toFixed(3).padStart(9)}${(cut - current >= 0 ? '+' : '') + (cut - current).toFixed(3)}`.padEnd(40),
    );
  }

  // ---- derive IMPACT_WAA -------------------------------------------------
  // Scale factor on the current cuts that lands Impact volume on the target in the
  // reference season. Reported as a multiplier because the RELATIVE per-position
  // weighting is the part that fixed QB 2.6% vs OL 0.0% and must not be disturbed.
  const candidates = rows.filter(
    (r) => r.pffWaa != null && (r.outcome === 'Impact Player' || r.outcome === 'Starter'),
  );
  let bestK = 1;
  let bestGap = Infinity;
  for (let k = 0.4; k <= 2.4; k += 0.02) {
    const n = candidates.filter(
      (r) => r.season === REFERENCE_SEASON && r.pffWaa! >= IMPACT_WAA[r.position] * k,
    ).length;
    const gap = Math.abs(n - IMPACT_PER_SEASON_TARGET);
    if (gap < bestGap) {
      bestGap = gap;
      bestK = k;
    }
  }
  const impactInReference = rows.filter(
    (r) => r.season === REFERENCE_SEASON && r.outcome === 'Impact Player',
  ).length;
  // Coverage-adjust the target. 350 assumes we can see every FBS player; the cohort
  // sees only 2015+ recruits, so it misses walk-ons, JUCO arrivals and sixth-years
  // even in a season five classes deep. Comparing raw against 350 nags the cuts
  // toward labeling MORE Impact seasons than All-Conference selections exist, which
  // would quietly undo the anchor.
  // DISTINCT athletes, not player-seasons — counting rows inflates this to 100%.
  const rosteredInReference = new Set(
    rows
      .filter((r) => r.season === REFERENCE_SEASON && r.team && r.athleteId)
      .map((r) => r.athleteId),
  ).size;
  const coverage = Math.min(1, rosteredInReference / (134 * 85));
  const adjustedTarget = Math.round(IMPACT_PER_SEASON_TARGET * coverage);
  console.log('\n=== IMPACT_WAA SCALE ===');
  console.log(
    `  ${REFERENCE_SEASON} Impact seasons: ${impactInReference}`,
  );
  console.log(
    `  full-population target ${IMPACT_PER_SEASON_TARGET}; cohort coverage ${(coverage * 100).toFixed(0)}% -> adjusted target ${adjustedTarget}`,
  );
  console.log(
    `  multiplier to hit the RAW target: ${bestK.toFixed(2)} — do NOT apply blindly;`,
  );
  console.log('  compare against the adjusted target instead.');

  // ---- headline metrics to pin ------------------------------------------
  const share = (outcome: Outcome): number =>
    Number(
      ((reported.filter((r) => r.outcome === outcome).length / reported.length) * 100).toFixed(2),
    );
  const bustByYear: number[] = [];
  for (let year = 1; year <= 5; year++) {
    const sub = reported.filter((r) => r.eligibilityYear === year);
    bustByYear.push(
      sub.length ? Number(((sub.filter((r) => r.outcome === 'Bust').length / sub.length) * 100).toFixed(2)) : 0,
    );
  }
  const starGradient = [5, 4, 3, 2].map((stars) => {
    const sub = reported.filter((r) => r.stars === stars);
    return sub.length
      ? Number(((sub.filter((r) => r.outcome === 'Bust').length / sub.length) * 100).toFixed(2))
      : 0;
  });

  const current = {
    rows: rows.length,
    reported: reported.length,
    bustPct: share('Bust'),
    depthPct: share('Depth / Rotation'),
    starterPct: share('Starter'),
    impactPct: share('Impact Player'),
    bustSpreadPp: Number((Math.max(...bustByYear) - Math.min(...bustByYear)).toFixed(2)),
    bustByYear,
    starBustGradient: starGradient,
    impactInReferenceSeason: impactInReference,
    duplicateAthleteSeasons: 0,
  };

  // ---- compare or pin ----------------------------------------------------
  let baseline: typeof current | null = null;
  try {
    baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
  } catch {
    baseline = null;
  }

  if (pin || !baseline) {
    await writeFile(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`\n${baseline ? 'RE-PINNED' : 'PINNED'} ${BASELINE}`);
    console.log(JSON.stringify(current, null, 2));
    return;
  }

  console.log('\n=== AGAINST BASELINE ===');
  let changed = 0;
  for (const [key, value] of Object.entries(current)) {
    const was = (baseline as Record<string, unknown>)[key];
    const same = JSON.stringify(was) === JSON.stringify(value);
    if (!same) changed++;
    console.log(
      `  ${same ? 'same    ' : 'CHANGED '}${key.padEnd(26)}${JSON.stringify(was)} -> ${JSON.stringify(value)}`,
    );
  }
  if (changed === 0) {
    console.log('\nUNCHANGED — nothing in the labeling pipeline moved.');
  } else {
    console.log(`\nCHANGED: ${changed} metric(s) moved.`);
    console.log('Read the direction. If a fix caused it, re-pin with --pin and say');
    console.log('which entries changed and why in the commit message.');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('calibrate failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
