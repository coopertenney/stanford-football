/**
 * Stage 1 entry point: build the unlabeled player-season dataset.
 *
 *   npm run ingest          # everything except the per-team games pull
 *   npm run ingest:games    # adds games played (~770 extra cached calls, P4 only)
 *
 * Writes data/player_seasons.json and prints a coverage report. It deliberately
 * does NOT assign outcome labels — thresholds for Starter vs Depth are the central
 * judgment call in this project and should be set against these numbers, not
 * guessed mid-build.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { stats } from './cfbd.ts';
import {
  FIRST_RECRUIT_YEAR,
  LAST_RECRUIT_YEAR,
  LAST_SEASON,
  join,
  type Coverage,
} from './join.ts';
import type { PlayerSeason, PositionGroup } from './types.ts';

const OUT_DIR = 'data';
const OUT_FILE = `${OUT_DIR}/player_seasons.json`;

const POSITION_ORDER: PositionGroup[] = [
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

const pct = (numerator: number, denominator: number): string =>
  denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(1)}%`;

function reportCoverage(rows: PlayerSeason[], coverage: Coverage): void {
  const line = (label: string, value: string): void =>
    console.log(`  ${label.padEnd(38)} ${value}`);

  const linked = coverage.linkedTier1 + coverage.linkedTier2;

  console.log('\n=== RECRUIT -> ATHLETE LINKING ===');
  line('Recruits pulled (10 classes)', String(coverage.recruitsPulled));
  line(
    'Tier 1 (roster.recruitIds, authoritative)',
    `${coverage.linkedTier1} (${pct(coverage.linkedTier1, coverage.recruitsPulled)})`,
  );
  line(
    'Tier 2 (name + committed school)',
    `${coverage.linkedTier2} (${pct(coverage.linkedTier2, coverage.recruitsPulled)})`,
  );
  line(
    'Linked, either tier',
    `${linked} (${pct(linked, coverage.recruitsPulled)})`,
  );
  line('Tier 2 rejected as ambiguous', String(coverage.tier2Ambiguous));
  line(
    'Never linked (no FBS roster appearance)',
    `${coverage.unlinked} (${pct(coverage.unlinked, coverage.recruitsPulled)})`,
  );
  line(
    'Roster entries carrying recruitIds',
    `${coverage.rosterEntriesWithRecruitIds} / ${coverage.rosterEntriesTotal} (${pct(
      coverage.rosterEntriesWithRecruitIds,
      coverage.rosterEntriesTotal,
    )})`,
  );
  line('Recruits dropped, position unresolved', String(coverage.positionUnresolved));
  line(
    'Portal entries matched to a roster',
    `${coverage.portalEntriesMatched} / ${coverage.portalEntriesPulled} (${pct(
      coverage.portalEntriesMatched,
      coverage.portalEntriesPulled,
    )})`,
  );

  // The survivorship check. The legacy pipeline could only ever emit participants;
  // a healthy recruit-first build has a large never-rostered share.
  const rostered = rows.filter((r) => r.rostered).length;
  console.log('\n=== PARTICIPATION (the survivorship fix) ===');
  line('Total player-season rows', String(rows.length));
  line('Rostered rows', `${rostered} (${pct(rostered, rows.length)})`);
  line(
    'Never-rostered rows (real busts)',
    `${rows.length - rostered} (${pct(rows.length - rostered, rows.length)})`,
  );

  // Whether usage is usable as a labeling signal is position-dependent: it derives
  // from offensive play-by-play, so defensive coverage is the open question.
  console.log('\n=== USAGE COVERAGE BY POSITION (rostered rows only) ===');
  console.log('  This decides whether absolute thresholds can use usage for all 9');
  console.log('  groups or only the offensive ones.\n');
  console.log(`  ${'POS'.padEnd(6)}${'ROSTERED'.padEnd(11)}${'WITH USAGE'.padEnd(13)}COVERAGE`);
  for (const position of POSITION_ORDER) {
    const bucket = coverage.usageByPosition.get(position);
    if (!bucket) {
      console.log(`  ${position.padEnd(6)}${'0'.padEnd(11)}${'0'.padEnd(13)}n/a`);
      continue;
    }
    console.log(
      `  ${position.padEnd(6)}${String(bucket.rostered).padEnd(11)}${String(
        bucket.withUsage,
      ).padEnd(13)}${pct(bucket.withUsage, bucket.rostered)}`,
    );
  }

  // Participation signal availability per group. This is what decides which
  // position groups can be labeled at all: usage is offense-only, box scores
  // cover defense, and OL has neither.
  if (coverage.gamesIngested) {
    console.log('\n=== PARTICIPATION SIGNAL BY POSITION ===');
    console.log('  Rostered rows with a KNOWN games count (unpulled team-seasons');
    console.log('  are null, not 0 — the games pull is P4-only).\n');
    console.log(
      `  ${'POS'.padEnd(6)}${'KNOWN GP'.padEnd(11)}${'GP>0'.padEnd(16)}${'MEAN GP'.padEnd(10)}SIGNAL`,
    );
    for (const position of POSITION_ORDER) {
      const known = rows.filter(
        (r) => r.position === position && r.rostered && r.gamesPlayed != null,
      );
      const played = known.filter((r) => (r.gamesPlayed ?? 0) > 0);
      const meanGames =
        played.length > 0
          ? played.reduce((sum, r) => sum + (r.gamesPlayed ?? 0), 0) / played.length
          : 0;
      const share = known.length > 0 ? played.length / known.length : 0;
      // OL registers ~9% at ~2.5 games: fumble recoveries, not participation.
      const signal = known.length === 0 ? 'NONE' : share > 0.4 ? 'ok' : 'UNUSABLE';
      console.log(
        `  ${position.padEnd(6)}${String(known.length).padEnd(11)}${`${played.length} (${pct(
          played.length,
          known.length,
        )})`.padEnd(16)}${meanGames.toFixed(1).padEnd(10)}${signal}`,
      );
    }
  }

  console.log('\n=== DATASET SHAPE ===');
  const bySource = new Map<string, number>();
  const byPosition = new Map<string, number>();
  const byEligibility = new Map<number, number>();
  let power4 = 0;
  let drafted = 0;
  for (const row of rows) {
    bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1);
    byPosition.set(row.position, (byPosition.get(row.position) ?? 0) + 1);
    byEligibility.set(
      row.eligibilityYear,
      (byEligibility.get(row.eligibilityYear) ?? 0) + 1,
    );
    if (row.power4) power4++;
    if (row.draftPick) drafted++;
  }
  line(
    'By source',
    [...bySource].map(([k, v]) => `${k} ${v}`).join(', '),
  );
  line(
    'By position',
    POSITION_ORDER.map((p) => `${p} ${byPosition.get(p) ?? 0}`).join(', '),
  );
  line(
    'By eligibility year',
    [...byEligibility]
      .sort(([a], [b]) => a - b)
      .map(([k, v]) => `Y${k} ${v}`)
      .join(', '),
  );
  line('Power 4 rows', `${power4} (${pct(power4, rows.length)})`);
  line('Draft-pick rows', `${drafted} (${pct(drafted, rows.length)})`);

  // Sanity check: known NFL players must not land in the never-rostered pile.
  // Kyler Murray, Jarrett Stidham and Byron Cowart all did on the first build,
  // which is what forced the tier 2 link.
  const CANARIES = ['Kyler Murray', 'Jarrett Stidham', 'Byron Cowart'];
  console.log('\n=== CANARY CHECK (known NFL players must be rostered) ===');
  for (const canary of CANARIES) {
    const playerRows = rows.filter((r) => r.name === canary);
    const rosteredSeasons = playerRows
      .filter((r) => r.rostered)
      .map((r) => `${r.season}:${r.team}`);
    const tier = playerRows.find((r) => r.linkTier != null)?.linkTier ?? null;
    const status = rosteredSeasons.length > 0 ? 'OK  ' : 'FAIL';
    console.log(
      `  ${status} ${canary.padEnd(18)} tier=${tier ?? '-'} drafted=${
        playerRows.some((r) => r.draftPick) ? 'y' : 'n'
      } ${rosteredSeasons.join(' ') || '(never rostered)'}`,
    );
  }

  if (!coverage.gamesIngested) {
    console.log(
      '\n  NOTE: gamesPlayed is null on every row — run `npm run ingest:games`',
    );
    console.log('  to populate it (P4 teams only, ~770 additional cached calls).');
  }
}

async function main(): Promise<void> {
  const includeGames = process.argv.includes('--games');

  console.log(
    `Recruit classes ${FIRST_RECRUIT_YEAR}-${LAST_RECRUIT_YEAR}, seasons through ${LAST_SEASON}.`,
  );
  console.log(`Games pull: ${includeGames ? 'ON (P4 only)' : 'OFF'}\n`);

  const started = Date.now();
  const { rows, coverage } = await join(includeGames);

  await mkdir(OUT_DIR, { recursive: true });
  const json = JSON.stringify(rows);
  await writeFile(OUT_FILE, json);

  reportCoverage(rows, coverage);

  const megabytes = (json.length / 1_024 / 1_024).toFixed(1);
  console.log('\n=== OUTPUT ===');
  console.log(`  ${OUT_FILE}  ${megabytes} MB  (${rows.length} rows)`);
  console.log(
    `  API calls: ${stats.fetched} fetched, ${stats.cached} from cache, ${stats.failed} failed`,
  );
  console.log(`  Elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(
    '\n  Row-per-object JSON at this size is for inspection only. The browser',
  );
  console.log('  bundle will need a columnar encoding — sized in stage 3.');
  console.log('\n  No outcome labels assigned. That is stage 2.');
}

main().catch((error: unknown) => {
  console.error('\nIngestion failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
