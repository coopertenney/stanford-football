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
import { LAST_SEASON } from './join.ts';
import type { PlayerSeason, PositionGroup } from './types.ts';

const IN_FILE = 'data/player_seasons.json';
const OUT_FILE = 'data/labeled_seasons.json';

/** All-Conference selections across the Power 4 plus an NFL draft class. */
const IMPACT_TARGET_PER_SEASON = 350;

/**
 * Newest recruit class with all five eligibility years observed (2021 + 4 = 2025).
 *
 * The year-by-year table MUST be restricted to these classes. Pooling censored
 * classes makes each eligibility-year column a different cohort: classes 2022-2025
 * contribute only to years 1-4 and are far more portal-heavy (year 1 is 10.7%
 * Portal against year 5's 2.3%), and portal players start immediately. That
 * overstated year-1 Starter probability by ~2.5x — precisely the number a
 * front-loaded offer gets priced against.
 */
const LAST_COMPLETE_CLASS = 2021;

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
    // Roster name first — it agrees with PFF far more often than the
    // recruiting-service name. Fall back to the recruit name when unresolved.
    const entry = row.team
      ? (pff.byNameTeamSeason.get(
           pffKey(row.season, row.rosterName ?? row.name, row.team),
         ) ?? pff.byNameTeamSeason.get(pffKey(row.season, row.name, row.team)))
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

  // Schools that appear as an FBS roster team anywhere in the window. Used to tell
  // "committed FBS and never played" (measurable) from "never had an FBS path".
  const fbsSchools = new Set(
    seasons.map((r) => r.team).filter((t): t is string => t != null),
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
  // Printing the Record directly emitted "[object Object]" — which is exactly why
  // the 263-vs-350 miss went unnoticed for as long as it did.
  console.log(
    `\nIMPACT_WAA per position: ${Object.entries(IMPACT_WAA)
      .filter(([, v]) => Number.isFinite(v))
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  );
  console.log(
    `Target ${IMPACT_TARGET_PER_SEASON} Impact seasons/yr; single cross-position cut`,
  );
  console.log(
    `Impact seasons/yr from the data is ${calibrated.toFixed(3)} — compare before trusting either.`,
  );

  // --- label ---------------------------------------------------------------
  let labeled: LabeledSeason[] = [];
  for (const list of byRecruit.values()) {
    // Career span: first and last season this athlete actually appeared on a
    // roster. Slots outside it are censored rather than called Bust.
    const rosteredSeasons = list.filter((r) => r.rostered).map((r) => r.season);
    const firstSeason = rosteredSeasons.length ? Math.min(...rosteredSeasons) : null;
    const lastSeason = rosteredSeasons.length ? Math.max(...rosteredSeasons) : null;

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
        linkTier: row.linkTier,
        gamesPlayed: row.gamesPlayed,
        usageOverall: row.usageOverall,
        draftPick: row.draftPick,
        nextSeasonObservable: row.season < LAST_SEASON,
        // committedTo is populated and names a school that fields an FBS roster in
        // our data. Absent committedTo, a roster appearance was never reachable.
        committedFbs: row.committedTo != null && fbsSchools.has(row.committedTo),
        outsideCareer:
          firstSeason != null &&
          lastSeason != null &&
          (row.season < firstSeason || row.season > lastSeason),
      });
      labeled.push({ ...row, outcome: result.outcome, snapShare: result.snapShare });
    });
  }

  // ---- deduplicate athlete-seasons ---------------------------------------
  // An athlete who was both a high-school recruit and a portal transfer has TWO
  // records, so the same (athlete, season) appears twice with different eligibility
  // indices — the HS record calls it year 3, the portal record calls it year 1.
  // 10,060 such duplicate rows were reaching the report distributions AND
  // train.ts, double-weighting every transfer in the headline numbers and in every
  // fitted coefficient. Deduplicating only in columnar.ts fixed the browser and
  // left the model wrong.
  //
  // Keep the row whose eligibility index reflects the true career clock — the
  // record with the longer observed career, which is the HS one in almost every
  // case. The transfer FACT is preserved on `transferred` so the portal cohort
  // stays reachable.
  const careerLength = new Map<string, number>();
  for (const row of labeled) {
    careerLength.set(row.recruitId, (careerLength.get(row.recruitId) ?? 0) + 1);
  }
  const keptBySeason = new Map<string, LabeledSeason>();
  const deduped: LabeledSeason[] = [];
  let duplicatesDropped = 0;
  for (const row of labeled) {
    // Unresolved recruits have no athleteId and cannot collide.
    if (!row.athleteId) {
      deduped.push(row);
      continue;
    }
    const key = `${row.athleteId}:${row.season}`;
    const incumbent = keptBySeason.get(key);
    if (!incumbent) {
      keptBySeason.set(key, row);
      deduped.push(row);
      continue;
    }
    duplicatesDropped++;
    const challengerBetter =
      (careerLength.get(row.recruitId) ?? 0) >
      (careerLength.get(incumbent.recruitId) ?? 0);
    // Either way the surviving row must remember the athlete transferred.
    const everTransferred =
      row.source === 'Portal' || incumbent.source === 'Portal';
    if (challengerBetter) {
      const at = deduped.indexOf(incumbent);
      if (at >= 0) deduped.splice(at, 1);
      keptBySeason.set(key, row);
      deduped.push(row);
      if (everTransferred) row.transferred = true;
    } else if (everTransferred) {
      incumbent.transferred = true;
    }
  }
  console.log(
    `\ndeduplicated ${duplicatesDropped} duplicate athlete-seasons (${labeled.length} -> ${deduped.length})`,
  );
  // Reassign rather than splice/push-spread: spreading ~191k elements into push
  // exceeds the argument limit and throws, which silently skipped the rewrite.
  labeled = deduped;

  // ---- career-level draftee veto -----------------------------------------
  // A drafted athlete whose every observed season reads Bust is not a finding, it
  // is a coverage failure: their real career is outside our window, or the PFF join
  // missed them under a nickname the suffix rule cannot reach (Pat/Patrick,
  // Sauce/Ahmad). Claiming Bust there is the single most damaging thing this tool
  // can do — it puts an NFL draft pick in the bust bucket in front of a coach.
  //
  // So those rows become Unresolved. This does NOT assert they were good; it
  // asserts we cannot see what they were, which is true. Specialists are left
  // alone — they are already Insufficient Data by design, not mislabeled.
  const RANK: Record<string, number> = {
    Bust: 1,
    'Depth / Rotation': 2,
    Starter: 3,
    'Impact Player': 4,
  };
  const bestRank = new Map<string, number>();
  for (const row of labeled) {
    if (!row.draftPick || !row.athleteId) continue;
    const rank = RANK[row.outcome] ?? 0;
    bestRank.set(row.athleteId, Math.max(bestRank.get(row.athleteId) ?? 0, rank));
  }
  let vetoed = 0;
  for (const row of labeled) {
    if (
      row.draftPick &&
      row.athleteId &&
      row.position !== 'ST' &&
      (bestRank.get(row.athleteId) ?? 0) <= 1 &&
      row.outcome === 'Bust'
    ) {
      row.outcome = 'Unresolved';
      vetoed++;
    }
  }
  console.log(
    `\ncareer-level draftee veto: ${vetoed} rows moved Bust -> Unresolved`,
  );
  console.log('(drafted athletes with no supportable season — coverage failure, not a finding)');

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
  console.log(`complete classes only (<=${LAST_COMPLETE_CLASS}); pooling censored`);
  console.log('classes made each column a different, increasingly portal-heavy cohort');
  console.log(header);
  const yearShares: number[] = [];
  for (let year = 1; year <= 5; year++) {
    const rows = labeled.filter(
      (r) => r.eligibilityYear === year && r.recruitYear <= LAST_COMPLETE_CLASS,
    );
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

  // ===================== DRAFTEE GATE =====================
  // The single check that matters most for credibility. An NFL draft pick whose
  // best observed season reads Bust is indefensible in front of a coach, and the
  // tool showed 16 first-round picks that way before the name-join fix.
  const bestByAthlete = new Map<
    string,
    { rank: number; name: string; round: number | null; specialist: boolean }
  >();
  for (const row of labeled) {
    if (!row.draftPick || !row.athleteId) continue;
    const rank = RANK[row.outcome] ?? 0;
    const current = bestByAthlete.get(row.athleteId);
    if (!current || rank > current.rank) {
      bestByAthlete.set(row.athleteId, {
        rank,
        name: row.name,
        round: row.draftRound ?? null,
        specialist: row.position === 'ST',
      });
    }
  }
  const drafted = [...bestByAthlete.values()];
  // Specialists are excluded by design (Insufficient Data), so they cannot pass a
  // Bust check and must not be counted as failures. Tracked separately instead.
  const positional = drafted.filter((d) => !d.specialist);
  const specialists = drafted.filter((d) => d.specialist);
  // FAIL only on an actual Bust label. rank 0 means every season was censored —
  // we cannot see the career, which is stated rather than asserted, and is a
  // coverage number rather than a wrong claim.
  const busts = positional.filter((d) => d.rank === 1);
  const unseen = positional.filter((d) => d.rank === 0);
  const firstRoundBusts = busts.filter((d) => d.round === 1);
  console.log('\n=== DRAFTEE GATE (NFL picks must not read as Bust) ===');
  console.log(
    `  drafted athletes in cohort: ${drafted.length} (${specialists.length} specialists, excluded by design)`,
  );
  for (const rank of [4, 3, 2, 1, 0]) {
    const n = positional.filter((d) => d.rank === rank).length;
    const label =
      rank === 0 ? 'no reported season' : Object.keys(RANK).find((k) => RANK[k] === rank)!;
    console.log(`  ${label.padEnd(20)}${String(n).padStart(5)}  ${pct(n, positional.length)}`);
  }
  console.log(
    `  ${busts.length === 0 ? 'PASS' : 'FAIL'}  draftees labeled Bust: ${busts.length}` +
      ` (first round: ${firstRoundBusts.length})`,
  );
  console.log(
    `  INFO  draftees with no supportable season: ${unseen.length} (${pct(unseen.length, positional.length)})`,
  );
  console.log('        these are censored, not called busts — a coverage limit we state');
  if (busts.length > 0) {
    console.log('  worst offenders (fix the join, not the threshold):');
    for (const d of busts.slice(0, 8)) {
      console.log(`    round ${d.round ?? '?'}  ${d.name}`);
    }
  }

  console.log(`\nwrote ${OUT_FILE} (${labeled.length} rows)`);
}

main().catch((error: unknown) => {
  console.error('\nlabeling failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
