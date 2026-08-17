/**
 * PFF Ultimate feed loader.
 *
 * PFF supplies what CFBD structurally cannot: per-player snap counts for EVERY
 * position group. CFBD's box scores can only see a player who recorded a stat,
 * which covers 9.5% of offensive linemen at a mean of 1.4 games — noise. PFF
 * covers 100% of them, at 338-411 snaps per season. That single difference is
 * what makes a ninth position group possible.
 *
 * Feeds are exported by hand from ultimate.pff.com/feeds as .csv and dropped in
 * pff_data/. They are NOT fetched: there is no API on this license tier, and the
 * files are licensed data that must not be committed (see .gitignore).
 *
 * Season is read from each file's own `season` column rather than its filename,
 * because every export downloads as the same name (`wins_above_replacement.csv`),
 * so filenames collide and carry no information.
 *
 * Join to CFBD is by (normalized name, mapped team, season). Measured on 2024:
 * 96.3% unambiguous, 0.4% ambiguous, 3.4% unmatched.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { normalizeName } from './positions.ts';

const PFF_DIR = 'pff_data';

/**
 * PFF team names carry the mascot ("Air Force Falcons"); CFBD does not
 * ("Air Force"). Longest-prefix matching against the CFBD team list resolves
 * 128 of 134. These six differ by more than a mascot and need stating outright.
 */
const TEAM_ALIASES: Record<string, string> = {
  'Appalachian State Mountaineers': 'App State',
  'Connecticut Huskies': 'UConn',
  'Hawaii Warriors': "Hawai'i",
  'Mississippi Rebels': 'Ole Miss',
  'San Jose State Spartans': 'San José State',
  'USF Bulls': 'South Florida',
  // These two are NOT mascot-only differences and longest-prefix matching sends
  // them to the WRONG school, which is far worse than failing to match. Measured:
  // "North Carolina State Wolfpack" resolved to "North Carolina", filing 781 PFF
  // player-seasons under UNC and leaving NC State with 675 rostered rows at 0% PFF
  // coverage and 100% of its reported labels Bust — zero Starters, ever. Same for
  // Louisiana-Monroe collapsing into Louisiana (-Lafayette).
  'North Carolina State Wolfpack': 'NC State',
  'Louisiana-Monroe Warhawks': 'Louisiana Monroe',
};

/** One player-season from the WAR/WAA feed. */
export interface PffPlayerSeason {
  season: number;
  playerId: string;
  name: string;
  /** PFF's own position vocabulary — a third one. See PFF_POSITIONS. */
  position: string;
  /** Season snap total. The participation signal, available for all positions. */
  snaps: number | null;
  /**
   * Wins above average.
   *
   * Note the feed is named WAR/WAA but the `war` column came back empty on all
   * 10,304 rows of the 2024 export — only `waa` is populated for NCAA. Above
   * AVERAGE is a materially higher bar than above REPLACEMENT: a replacement
   * player sits well below average, so waa understates value relative to a true
   * replacement baseline. A replacement level has to be derived empirically from
   * the low-snap tail rather than taken from PFF.
   */
  waa: number | null;
  /**
   * PFF's own count of seasons played. Runs 1-7 in 2024, with 794 players at
   * year 6 and 66 at year 7 — independent corroboration of the COVID waiver
   * that the CFBD roster data showed from the other direction.
   */
  yearInLeague: number | null;
  /** PFF team name, mascot included. */
  team: string;
  /** Team mapped to CFBD's naming, or null when unmappable. */
  cfbdTeam: string | null;
}

/**
 * Minimal RFC-4180 CSV parser.
 *
 * Hand-rolled rather than pulled in as a dependency: the pipeline has no runtime
 * deps and these files are well-formed exports. Handles quoted fields and
 * embedded commas, which matter because player names contain both.
 */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Close the row on \n, and swallow \r\n as one break.
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      // Skip blank trailing lines.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows.map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((column, index) => {
      record[column] = cells[index] ?? '';
    });
    return record;
  });
}

const toNumber = (value: string | undefined): number | null => {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Map a PFF team name onto CFBD's, by explicit alias then longest prefix.
 *
 * Longest-prefix rather than first-match matters: "Miami" is a prefix of
 * "Miami (OH)", and taking the first hit would collapse two distinct programs.
 */
export function mapTeamToCfbd(
  pffTeam: string,
  cfbdTeams: readonly string[],
): string | null {
  const alias = TEAM_ALIASES[pffTeam];
  if (alias) return alias;

  let best: string | null = null;
  for (const team of cfbdTeams) {
    if (pffTeam.startsWith(team) && (best === null || team.length > best.length)) {
      best = team;
    }
  }
  return best;
}

export interface PffIndex {
  /** `season:normalizedName:cfbdTeam` -> player-season. */
  byNameTeamSeason: Map<string, PffPlayerSeason>;
  /** Keys that matched more than one PFF row; excluded from the lookup map. */
  ambiguous: Set<string>;
  seasonsLoaded: number[];
  rowsLoaded: number;
  teamsUnmapped: string[];
}

export const pffKey = (
  season: number,
  name: string,
  cfbdTeam: string,
): string => `${season}:${normalizeName(name)}:${cfbdTeam}`;

/**
 * Load every WAR/WAA export in pff_data/ and index it for joining.
 *
 * Returns an empty index when the directory is absent — PFF is an optional
 * enrichment, and ingestion must still run without it.
 */
export async function loadPffWar(
  cfbdTeams: readonly string[],
  dir: string = PFF_DIR,
): Promise<PffIndex> {
  const index: PffIndex = {
    byNameTeamSeason: new Map(),
    ambiguous: new Set(),
    seasonsLoaded: [],
    rowsLoaded: 0,
    teamsUnmapped: [],
  };

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.csv'));
  } catch {
    return index;
  }

  const seasons = new Set<number>();
  const unmapped = new Set<string>();

  for (const file of files) {
    const text = await readFile(joinPath(dir, file), 'utf8');
    const records = parseCsv(text);

    // Only the WAR/WAA feed has these columns; skip other feeds in the folder.
    const first = records[0];
    if (!first || !('waa' in first) || !('year_in_league' in first)) continue;

    for (const record of records) {
      const season = toNumber(record['season']);
      const name = record['player'] ?? '';
      const team = record['team'] ?? '';
      if (season == null || !name || !team) continue;

      const cfbdTeam = mapTeamToCfbd(team, cfbdTeams);
      if (!cfbdTeam) {
        unmapped.add(team);
        continue;
      }

      const entry: PffPlayerSeason = {
        season,
        playerId: record['player_id'] ?? '',
        name,
        position: record['position'] ?? '',
        snaps: toNumber(record['snaps']),
        waa: toNumber(record['waa']),
        yearInLeague: toNumber(record['year_in_league']),
        team,
        cfbdTeam,
      };

      const key = pffKey(season, name, cfbdTeam);
      if (index.byNameTeamSeason.has(key)) {
        // Two PFF players share a name on one roster: drop both rather than
        // attribute one player's season to the other.
        index.byNameTeamSeason.delete(key);
        index.ambiguous.add(key);
      } else if (!index.ambiguous.has(key)) {
        index.byNameTeamSeason.set(key, entry);
      }

      seasons.add(season);
      index.rowsLoaded++;
    }
  }

  index.seasonsLoaded = [...seasons].sort((a, b) => a - b);
  index.teamsUnmapped = [...unmapped];
  return index;
}

/**
 * PFF position vocabulary -> the nine PDR groups.
 *
 * A third distinct vocabulary, after the recruiting feed's and the roster's.
 * PFF splits the defensive line by alignment (ED = edge, DI = interior) and the
 * offensive line by spot (T/G/C), and uses HB rather than RB.
 */
export const PFF_POSITIONS: Record<string, string> = {
  QB: 'QB',
  HB: 'RB',
  FB: 'RB',
  WR: 'WR',
  TE: 'TE',
  T: 'OL',
  G: 'OL',
  C: 'OL',
  ED: 'DL',
  DI: 'DL',
  LB: 'LB',
  CB: 'DB',
  S: 'DB',
  K: 'ST',
  P: 'ST',
  LS: 'ST',
  ST: 'ST',
};
