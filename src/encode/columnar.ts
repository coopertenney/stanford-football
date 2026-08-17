/**
 * Columnar encoder — turns the labeled dataset into something a browser can hold.
 *
 * THE PROBLEM
 * data/labeled_seasons.json is ~90 MB of row-per-object JSON. A self-contained HTML
 * artifact has to carry its data inline, and 90 MB is both far past the 16 MB
 * artifact ceiling and hopeless to parse on load.
 *
 * THE INSIGHT
 * The browser does not need 200,685 player-SEASONS. Every query is "find recruits
 * whose profile resembles this one, then read their year-by-year outcomes", so the
 * natural unit is one record per RECRUIT with a five-slot outcome sequence. That is
 * ~50k records instead of 200k rows, and the recruit profile — which is what KNN
 * actually matches on — stops being duplicated five times.
 *
 * THE ENCODING
 * Structure of arrays, not array of structures, with each column narrowed to the
 * smallest integer type that holds it losslessly:
 *
 *   stars      Uint8    0-5, 0 = unrated
 *   rating     Uint16   composite x 10000 (0.9991 -> 9991), 0 = unknown
 *   ranking    Uint16   capped at 65535, 0 = unknown
 *   height     Uint8    inches x 2, preserving the .5 values in the feed
 *   weight     Uint16   pounds
 *   position   Uint8    index into POSITIONS
 *   source     Uint8    index into SOURCES
 *   recruitYear Uint8   offset from 2015
 *   outcomes   Uint8[5] one slot per eligibility year, 0 = season not observed
 *
 * Names and teams are dictionary-encoded: teams as an index into a ~300-entry
 * table, names as offsets into one concatenated blob. Names are kept because the
 * PDR requires showing comparable players, and a comp list without names has no
 * credibility with a coach.
 *
 * Everything is packed into a single ArrayBuffer with a small JSON header, so the
 * page does one base64 decode and then reads typed-array views with no per-row
 * parsing at all.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { Outcome } from '../ingest/label.ts';
import type { PlayerSeason, PositionGroup, PlayerSource } from '../ingest/types.ts';

const IN_FILE = 'data/labeled_seasons.json';
const OUT_DIR = 'data';
const OUT_BIN = `${OUT_DIR}/cohort.bin`;
const OUT_B64 = `${OUT_DIR}/cohort.b64`;

export const POSITIONS: PositionGroup[] = [
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

export const SOURCES: PlayerSource[] = ['HighSchool', 'Portal'];

/**
 * Outcome codes. 0 is reserved for "season not observed" — which is NOT the same
 * as any outcome, and is what makes right-censoring representable: a 2024 recruit
 * has zeros in slots 3-5 because those seasons have not been played.
 */
export const OUTCOME_CODES: Record<Outcome, number> = {
  Bust: 1,
  'Depth / Rotation': 2,
  Starter: 3,
  'Impact Player': 4,
  'Redshirt / Ineligible': 5,
  'Insufficient Data': 6,
  Unresolved: 7,
};

const MAX_ELIGIBILITY = 5;
const YEAR_BASE = 2015;

type LabeledRow = PlayerSeason & { outcome: Outcome; transferred?: boolean };

interface Recruit {
  /** Used only to detect the same athlete appearing as both an HS and portal record. */
  athleteId: string | null;
  /**
   * This athlete transferred at some point — either they have a portal record, or
   * their team changed mid-career.
   *
   * Kept because deduplication alone destroyed the portal cohort. Dropping the
   * portal copy of an athlete who also has a high-school record took the Portal
   * population from 8,888 records to 2,002, of which only 8 were genuine FBS-to-FBS
   * transfers — so "compare two portal targets", a core PDR use case, was running on
   * a cohort that excluded nearly every 4-star Power 4 transfer. The fix is to
   * deduplicate the ROW while preserving the transfer FACT, so a portal query can
   * still reach these players.
   */
  transferred: boolean;
  name: string;
  team: string;
  stars: number;
  rating: number;
  ranking: number;
  height: number;
  weight: number;
  position: PositionGroup;
  source: PlayerSource;
  recruitYear: number;
  outcomes: number[];
}

/** Clamp and round to fit a target integer width without ever wrapping. */
const toUint = (value: number, max: number): number =>
  Math.max(0, Math.min(max, Math.round(value)));

async function main(): Promise<void> {
  const rows: LabeledRow[] = JSON.parse(await readFile(IN_FILE, 'utf8'));
  console.log(`read ${rows.length} labeled player-seasons`);

  // --- collapse to one record per recruit ----------------------------------
  const byRecruit = new Map<string, Recruit>();
  for (const row of rows) {
    let recruit = byRecruit.get(row.recruitId);
    if (!recruit) {
      recruit = {
        athleteId: row.athleteId,
        transferred: row.source === 'Portal' || row.transferred === true,
        name: row.name,
        // The team a player is most associated with; first non-null wins.
        team: row.team ?? row.committedTo ?? '',
        stars: row.stars ?? 0,
        rating: row.rating ?? 0,
        ranking: row.ranking ?? 0,
        height: row.height ?? 0,
        weight: row.weight ?? 0,
        position: row.position,
        source: row.source,
        recruitYear: row.recruitYear,
        outcomes: new Array<number>(MAX_ELIGIBILITY).fill(0),
      };
      byRecruit.set(row.recruitId, recruit);
    }
    if (!recruit.team && row.team) recruit.team = row.team;
    if (row.source === 'Portal' || row.transferred === true) recruit.transferred = true;
    const slot = row.eligibilityYear - 1;
    if (slot >= 0 && slot < MAX_ELIGIBILITY) {
      recruit.outcomes[slot] = OUTCOME_CODES[row.outcome] ?? 0;
    }
  }

  // ---- deduplicate transfer careers -------------------------------------
  // A portal record is keyed `portal-{year}-{athleteId}` while the SAME athlete
  // already has a high-school record, so 8,664 of 19,330 portal rows (44.8%) were
  // literal duplicates: 4,839 athletes appeared twice in the comparable-player
  // index, each as an independent neighbour, with the same season filed under
  // different eligibility years. Colorado 2024 showed Nikhai Hill-Green three
  // times. Duplicates also gave transfers double weight in the distribution, and
  // because portal year-1 could not be Bust, the duplicate copy was systematically
  // the more optimistic one.
  //
  // Keep the record with more observed seasons; on a tie prefer the HS record,
  // since it covers the whole career rather than the post-transfer slice.
  const seenAthlete = new Map<string, string>();
  const observed = (r: Recruit): number => r.outcomes.filter((c) => c !== 0).length;
  let dropped = 0;
  for (const [recruitId, recruit] of [...byRecruit.entries()]) {
    const athleteId = recruit.athleteId;
    if (!athleteId) continue;
    const incumbentId = seenAthlete.get(athleteId);
    if (incumbentId == null) {
      seenAthlete.set(athleteId, recruitId);
      continue;
    }
    const incumbent = byRecruit.get(incumbentId)!;
    const challengerWins =
      observed(recruit) > observed(incumbent) ||
      (observed(recruit) === observed(incumbent) &&
        incumbentId.startsWith('portal-') &&
        !recruitId.startsWith('portal-'));
    // Union the transfer fact onto whichever record survives, so dropping the
    // duplicate never drops the knowledge that the player transferred.
    const everTransferred = recruit.transferred || incumbent.transferred;
    if (challengerWins) {
      recruit.transferred = everTransferred;
      byRecruit.delete(incumbentId);
      seenAthlete.set(athleteId, recruitId);
    } else {
      incumbent.transferred = everTransferred;
      byRecruit.delete(recruitId);
    }
    dropped++;
  }
  console.log(`deduplicated ${dropped} records sharing an athleteId`);

  const recruits = [...byRecruit.values()];
  const n = recruits.length;
  console.log(`collapsed to ${n} recruits (${(rows.length / n).toFixed(1)} rows each)`);

  // --- dictionaries --------------------------------------------------------
  const teamList = [...new Set(recruits.map((r) => r.team))].sort();
  const teamIndex = new Map(teamList.map((t, i) => [t, i]));
  console.log(`team dictionary: ${teamList.length} entries`);

  // --- columns -------------------------------------------------------------
  const stars = new Uint8Array(n);
  const rating = new Uint16Array(n);
  const ranking = new Uint16Array(n);
  const height = new Uint8Array(n);
  const weight = new Uint16Array(n);
  const position = new Uint8Array(n);
  const source = new Uint8Array(n);
  const recruitYear = new Uint8Array(n);
  const team = new Uint16Array(n);
  const transferred = new Uint8Array(n);
  const outcomes = new Uint8Array(n * MAX_ELIGIBILITY);

  const nameParts: string[] = [];
  const nameOffsets = new Uint32Array(n + 1);

  recruits.forEach((r, i) => {
    stars[i] = toUint(r.stars, 5);
    // Composite ratings run 0-1; x10000 keeps four decimals exactly.
    rating[i] = toUint(r.rating * 10000, 65535);
    ranking[i] = toUint(r.ranking, 65535);
    // x2 preserves the half-inch values present in the recruiting feed.
    height[i] = toUint(r.height * 2, 255);
    weight[i] = toUint(r.weight, 65535);
    position[i] = POSITIONS.indexOf(r.position);
    source[i] = SOURCES.indexOf(r.source);
    recruitYear[i] = toUint(r.recruitYear - YEAR_BASE, 255);
    team[i] = teamIndex.get(r.team) ?? 0;
    transferred[i] = r.transferred ? 1 : 0;
    for (let slot = 0; slot < MAX_ELIGIBILITY; slot++) {
      outcomes[i * MAX_ELIGIBILITY + slot] = r.outcomes[slot] ?? 0;
    }
    nameParts.push(r.name);
  });

  // Name blob: one UTF-8 buffer plus offsets, so there is no per-name object.
  const nameBlob = new TextEncoder().encode(nameParts.join(' '));
  let cursor = 0;
  recruits.forEach((r, i) => {
    nameOffsets[i] = cursor;
    cursor += new TextEncoder().encode(r.name).length + 1;
  });
  nameOffsets[n] = nameBlob.length;

  // --- pack ----------------------------------------------------------------
  const columns: [string, ArrayBufferView][] = [
    ['stars', stars],
    ['rating', rating],
    ['ranking', ranking],
    ['height', height],
    ['weight', weight],
    ['position', position],
    ['source', source],
    ['recruitYear', recruitYear],
    ['team', team],
    ['transferred', transferred],
    ['outcomes', outcomes],
    ['nameOffsets', nameOffsets],
    ['nameBlob', nameBlob],
  ];

  const header = {
    version: 1,
    count: n,
    maxEligibility: MAX_ELIGIBILITY,
    yearBase: YEAR_BASE,
    positions: POSITIONS,
    sources: SOURCES,
    outcomeCodes: OUTCOME_CODES,
    teams: teamList,
    // Scale factors the reader must undo.
    scale: { rating: 10000, height: 2 },
    layout: columns.map(([name, view]) => ({
      name,
      type: view.constructor.name,
      byteLength: view.byteLength,
    })),
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const dataLength = columns.reduce((sum, [, view]) => sum + view.byteLength, 0);
  // 8-byte prelude: header length, then data length.
  const buffer = new ArrayBuffer(8 + headerBytes.length + dataLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerBytes.length, true);
  view.setUint32(4, dataLength, true);

  const bytes = new Uint8Array(buffer);
  bytes.set(headerBytes, 8);
  let offset = 8 + headerBytes.length;
  for (const [, column] of columns) {
    bytes.set(
      new Uint8Array(column.buffer, column.byteOffset, column.byteLength),
      offset,
    );
    offset += column.byteLength;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_BIN, bytes);
  const base64 = Buffer.from(bytes).toString('base64');
  await writeFile(OUT_B64, base64);

  // --- report --------------------------------------------------------------
  const sourceSize = (await readFile(IN_FILE)).byteLength;
  const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(2)} MB`;
  console.log('\n=== SIZE ===');
  console.log(`  labeled_seasons.json   ${mb(sourceSize)}`);
  console.log(`  cohort.bin             ${mb(bytes.length)}`);
  console.log(`  cohort.b64 (inline)    ${mb(base64.length)}`);
  console.log(
    `  reduction              ${(sourceSize / bytes.length).toFixed(0)}x binary, ${(
      sourceSize / base64.length
    ).toFixed(0)}x as inline base64`,
  );
  console.log(`  header                 ${(headerBytes.length / 1024).toFixed(1)} KB`);
  console.log('\n  column breakdown:');
  for (const [name, column] of columns) {
    console.log(`    ${name.padEnd(14)}${mb(column.byteLength).padStart(9)}`);
  }
  console.log(
    `\n  16 MB artifact ceiling: ${base64.length < 16 * 1024 * 1024 ? 'FITS' : 'EXCEEDED'}`,
  );
}

main().catch((error: unknown) => {
  console.error('\nencoding failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
