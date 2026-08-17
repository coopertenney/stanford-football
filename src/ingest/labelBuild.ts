/**
 * Apply outcome labels to the ingested player-seasons.
 *
 *   npm run label
 *
 * Reads data/player_seasons.json (from `npm run ingest`) plus the PFF exports in
 * pff_data/, joins them, labels every season, and writes data/labeled_seasons.json.
 *
 * The report at the end is the point of this script. Three things must hold or the
 * relabel has not actually fixed anything:
 *
 *   1. Outcome shares must NOT sit on the threshold values. The old pipeline
 *      returned 25.0/35.0/25.0/15.0 because those were its cut points.
 *   2. Shares must VARY across eligibility years. The old spread was 0.35pp;
 *      freshmen should bust far more often than fifth-year players.
 *   3. Shares must vary by star rating in the sensible direction, preserving the
 *      ordering the legacy KNN found (5-star > 4-star > 3-star > 2-star).
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  calibrateImpactThreshold,
  estimateTeamPlays,
  IMPACT_WAA,
  isCensored,
  labelSeason,
  REPORTED_OUTCOMES,
  STARTER_SNAP_SHARE,
  teamPlaysFor,
  type LabeledSeason,
  type Outcome,
} from './label.ts';
import { loadPffWar, pffKey, PFF_POSITIONS } from './pff.ts';
import type { PlayerSeason, PositionGroup } from './types.ts';

const IN_FILE = 'data/player_seasons.json';
const OUT_FILE = 'data/labeled_seasons.json';

/** All-Conference selections across the Power 4 plus an NFL draft class. */
const IMPACT_TARGET_PER_SEASON = 350;

const POSITIONS: PositionGroup[] = [
  'QB',
  'RB',
  'WR',
  'TE',
  'OL',
  'DL',
  'LB',
  'DB',
  'ST',
];

const pct = (n: number, d: number): string =>
  d === 0 ? '   n/a' : `${((n / d) * 100).toFixed(1)}%`;

function distribution(rows: readonly LabeledSeason[]): Map<Outcome, number> {
  const counts = new Map<Outcome, number>();
  for (const row of rows) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  return counts;
}

function printDistribution(label: string, rows: readonly LabeledSeason[]): void {
  const reported = rows.filter((r) => !isCensored(r.outcome));
  const counts = distribution(reported);
  const cells = REPORTED_OUTCOMES.map((o) =>
    pct(counts.get(o) ?? 0, reported.length).padStart(8),
  ).join('');
  console.log(`  ${label.padEnd(12)}${String(reported.length).padStart(8)}${cells}`);
}

async function main(): Promise<void> {
  const seasons: PlayerSeason[] = JSON.parse(await readFile(IN_FILE, 'utf8'));
  console.log(`loaded ${seasons.length} player-seasons`);

  const cfbdTeams = [
    ...new Set(seasons.map((r) => r.team).filter((t): t is string => t != null)),
  ];
  const pff = await loadPffWar(cfbdTeams);
  console.log(
    `loaded ${pff.rowsLoaded} PFF rows, seasons ${pff.seasonsLoaded[0]}-${pff.seasonsLoaded.at(-1)}`,
  );
  if (pff.rowsLoaded === 0) {
    console.error(
      '\nNo PFF data in pff_data/. Labeling needs it — snaps are the participation',
    );
    console.error('signal for all nine position groups. Aborting rather than');
    console.error('silently producing labels from CFBD box scores alone.');
    process.exit(1);
  }

  // --- attach PFF ----------------------------------------------------------
  const withPff = seasons.map((row) => {
    const entry = row.team
      ? pff.byNameTeamSeason.get(pffKey(row.season, row.name, row.team))
      : undefined;
    return {
      ...row,
      pffSnaps: entry?.snaps ?? null,
      pffWaa: entry?.waa ?? null,
    };
  });
  const joined = withPff.filter((r) => r.pffSnaps != null).length;
  console.log(
    `PFF joined to ${joined}/${withPff.length} rows (${pct(joined, withPff.length)})`,
  );

  // --- team plays ----------------------------------------------------------
  // From the FULL PFF population, not the matched cohort. See estimateTeamPlays.
  const pffAsRows = [...pff.byNameTeamSeason.values()].map((entry) => ({
    season: entry.season,
    team: entry.cfbdTeam,
    position: (PFF_POSITIONS[entry.position] ?? 'ST') as PositionGroup,
    snaps: entry.snaps,
  }));
  const teamPlays = estimateTeamPlays(pffAsRows);
  console.log(
    `estimated plays for ${teamPlays.size} team-seasons from ${pffAsRows.length} PFF rows`,
  );

  // --- per-player context needed by the redshirt rule ----------------------
  // Group by recruit so each season can see the next one, and detect the season a
  // player changed teams.
  const byRecruit = new Map<string, typeof withPff>();
  for (const row of withPff) {
    const list = byRecruit.get(row.recruitId);
    if (list) list.push(row);
    else byRecruit.set(row.recruitId, [row]);
  }
  for (const list of byRecruit.values()) list.sort((a, b) => a.season - b.season);

  // --- calibrate Impact against real volume --------------------------------
  const waaBySeason = new Map<number, number[]>();
  for (const row of withPff) {
    if (row.pffWaa == null) continue;
    const list = waaBySeason.get(row.season);
    if (list) list.push(row.pffWaa);
    else waaBySeason.set(row.season, [row.pffWaa]);
  }
  const calibrated = calibrateImpactThreshold(waaBySeason, IMPACT_TARGET_PER_SEASON);
  console.log(
    `\nIMPACT_WAA constant is ${IMPACT_WAA}; the cut reproducing ${IMPACT_TARGET_PER_SEASON}`,
  );
  console.log(
    `Impact seasons/yr from the data is ${calibrated.toFixed(3)} — compare before trusting either.`,
  );

  // --- label ---------------------------------------------------------------
  const labeled: LabeledSeason[] = [];
  for (const list of byRecruit.values()) {
    list.forEach((row, index) => {
      const next = list[index + 1];
      const previous = list[index - 1];
      const transferYear =
        (row.source === 'Portal' && row.eligibilityYear === 1) ||
        (previous?.team != null && row.team != null && previous.team !== row.team);

      const result = labelSeason({
        pffSnaps: row.pffSnaps,
        pffWaa: row.pffWaa,
        teamPlays: teamPlaysFor(teamPlays, row.season, row.team, row.position),
        rostered: row.rostered,
        position: row.position,
        nextSeasonSnaps: next?.pffSnaps ?? null,
        transferYear,
      });
      labeled.push({ ...row, outcome: result.outcome, snapShare: result.snapShare });
    });
  }

  await writeFile(OUT_FILE, JSON.stringify(labeled));

  // ======================= VALIDATION REPORT =============================
  const censored = labeled.filter((r) => isCensored(r.outcome)).length;
  console.log(`\ncensored (Redshirt / Ineligible): ${censored} (${pct(censored, labeled.length)})`);
  console.log('These are excluded from every distribution below — a redshirt is not');
  console.log('an outcome, it is a season that did not count.');

  const header = `  ${'GROUP'.padEnd(12)}${'N'.padStart(8)}${REPORTED_OUTCOMES.map((o) =>
    (o === 'Depth / Rotation' ? 'DEPTH' : o === 'Impact Player' ? 'IMPACT' : o.toUpperCase()).padStart(8),
  ).join('')}`;

  console.log('\n=== TEST 1: shares must NOT equal the threshold values ===');
  console.log(header);
  printDistribution('ALL', labeled);

  console.log('\n=== TEST 2: shares must VARY across eligibility years ===');
  console.log('(legacy spread was 0.35pp — a definitional artifact)');
  console.log(header);
  const yearShares: number[] = [];
  for (let year = 1; year <= 5; year++) {
    const rows = labeled.filter((r) => r.eligibilityYear === year);
    printDistribution(`year ${year}`, rows);
    const reported = rows.filter((r) => !isCensored(r.outcome));
    const bust = reported.filter((r) => r.outcome === 'Bust').length;
    if (reported.length) yearShares.push((bust / reported.length) * 100);
  }
  const spread = Math.max(...yearShares) - Math.min(...yearShares);
  console.log(`\n  Bust share spread across years: ${spread.toFixed(1)}pp`);

  console.log('\n=== TEST 3: ordering by star rating must be sensible ===');
  console.log(header);
  for (const stars of [5, 4, 3, 2]) {
    printDistribution(`${stars}-star`, labeled.filter((r) => r.stars === stars));
  }

  console.log('\n=== BY POSITION (starter threshold in parens) ===');
  console.log(header);
  for (const position of POSITIONS) {
    printDistribution(
      `${position} (${STARTER_SNAP_SHARE[position]})`,
      labeled.filter((r) => r.position === position),
    );
  }

  console.log('\n=== IMPACT VOLUME PER SEASON (target ~350) ===');
  for (const season of [...new Set(labeled.map((r) => r.season))].sort()) {
    const n = labeled.filter(
      (r) => r.season === season && r.outcome === 'Impact Player',
    ).length;
    console.log(`  ${season}: ${n}`);
  }

  console.log(`\nwrote ${OUT_FILE} (${labeled.length} rows)`);
}

main().catch((error: unknown) => {
  console.error('\nlabeling failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
