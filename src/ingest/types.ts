/**
 * CFBD API response shapes.
 *
 * These were written against live 2024/2015 payloads probed on 2026-08-12, not
 * from the published schema — where a field was absent or null in the sample it
 * is typed nullable/optional here. Fields the pipeline does not read are omitted.
 */

/** GET /recruiting/players?year=&classification= */
export interface CfbdRecruit {
  /** Recruit id. Joins to `CfbdRosterPlayer.recruitIds`. String in the payload. */
  id: string;
  /** Sometimes present, sometimes null — do not rely on it as the athlete key. */
  athleteId: string | null;
  recruitType: string;
  year: number;
  ranking: number | null;
  name: string;
  school: string | null;
  committedTo: string | null;
  position: string | null;
  height: number | null;
  weight: number | null;
  stars: number | null;
  rating: number | null;
  city: string | null;
  stateProvince: string | null;
  country: string | null;
}

/** GET /roster?year= — no team param needed; returns every FBS player-season. */
export interface CfbdRosterPlayer {
  /** Athlete id. Joins to usage.id, draft.collegeAthleteId, game-stat athlete id. */
  id: string;
  firstName: string | null;
  lastName: string | null;
  team: string;
  weight: number | null;
  height: number | null;
  jersey: number | null;
  /** Class year as an integer (1-5ish), NOT the season. */
  year: number | null;
  position: string | null;
  /** Recruit ids this roster entry is linked to. ~81% populated on the sample. */
  recruitIds: string[] | null;
}

/** GET /player/usage?year= */
export interface CfbdUsage {
  season: number;
  id: string;
  name: string;
  position: string | null;
  team: string;
  conference: string | null;
  usage: {
    overall: number | null;
    pass: number | null;
    rush: number | null;
    firstDown: number | null;
    secondDown: number | null;
    thirdDown: number | null;
    standardDowns: number | null;
    passingDowns: number | null;
  } | null;
}

/** GET /stats/player/season?year=&category= — long format, one row per statType. */
export interface CfbdSeasonStat {
  season: number;
  playerId: string;
  player: string;
  team: string;
  conference: string | null;
  category: string;
  statType: string;
  stat: number | string | null;
}

/** GET /draft/picks?year= */
export interface CfbdDraftPick {
  /** Number in the payload, unlike the string ids elsewhere. Normalize on read. */
  collegeAthleteId: number | null;
  collegeTeam: string | null;
  year: number;
  overall: number | null;
  round: number | null;
  pick: number | null;
  name: string;
  position: string | null;
}

/** GET /player/portal?year= — no player id field, so name+position is the only key. */
export interface CfbdPortalEntry {
  season: number;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  origin: string | null;
  destination: string | null;
  transferDate: string | null;
  rating: number | null;
  stars: number | null;
  eligibility: string | null;
}

/** GET /teams/fbs?year= */
export interface CfbdTeam {
  id: number;
  school: string;
  conference: string | null;
  classification: string | null;
}

/** GET /games/players?year=&team= — deeply nested box scores. */
export interface CfbdGamePlayers {
  id: number;
  teams: {
    team: string;
    conference: string | null;
    homeAway: string | null;
    categories: {
      name: string;
      types: {
        name: string;
        athletes: { id: string; name: string; stat: string | null }[];
      }[];
    }[];
  }[];
}

// ---------------------------------------------------------------------------
// Pipeline output
// ---------------------------------------------------------------------------

/** The 9 position groups named in PDR §3.1.2. */
export type PositionGroup =
  | 'QB'
  | 'RB'
  | 'WR'
  | 'TE'
  | 'OL'
  | 'DL'
  | 'LB'
  | 'DB'
  | 'ST';

/** PDR §3.1.2 "Player Source" — absent from the legacy pipeline entirely. */
export type PlayerSource = 'HighSchool' | 'Portal';

/**
 * One recruit-season row, unlabeled.
 *
 * Stage 1 stops here deliberately: outcome labeling needs threshold decisions
 * that should be made with the coverage numbers below in hand. Every field an
 * absolute-threshold labeler would need is present and raw.
 */
export interface PlayerSeason {
  recruitId: string;
  /** Null when the recruit never appears on any roster — a hard non-participant. */
  athleteId: string | null;
  name: string;
  position: PositionGroup;
  /** Raw CFBD position string, kept so group mapping stays auditable. */
  positionRaw: string | null;
  source: PlayerSource;

  // Recruit profile — the KNN feature inputs.
  stars: number | null;
  rating: number | null;
  ranking: number | null;
  height: number | null;
  weight: number | null;
  recruitYear: number;
  committedTo: string | null;

  // Season context.
  season: number;
  /** 1-5, = season - recruitYear + 1. */
  eligibilityYear: number;
  /** Null when not rostered that season. */
  team: string | null;
  conference: string | null;
  power4: boolean;

  // Participation signals for labeling.
  /** True when the recruit appears on a roster for this season. */
  rostered: boolean;
  /** Offensive snap share from play-by-play. Null when usage has no row. */
  usageOverall: number | null;
  /** Distinct games with a box-score line. Null when games were not ingested. */
  gamesPlayed: number | null;
  /** Ever drafted — PDR §3.1.1 names draft pick as an Impact criterion. */
  draftPick: boolean;
  draftRound: number | null;

  /**
   * How this recruit was resolved to an athlete: 1 = authoritative
   * roster.recruitIds, 2 = inferred from name + committed school, null = never
   * resolved (treated as never rostered). Retained on every row so the inferred
   * share of the dataset stays auditable and can be excluded if it proves noisy.
   */
  linkTier: 1 | 2 | null;
}
