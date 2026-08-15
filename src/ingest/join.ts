/**
 * Recruit-first assembly of player-season rows.
 *
 * The legacy pipeline (gather_rb_data.py:103) started from /stats/player/season and
 * left-joined recruits onto it. A recruit who never recorded a carry or catch never
 * entered the table at all, so "Bust" silently came to mean "bottom quartile of
 * players who already made the field" — 6,910 recruits pulled, 2,913 (42%) present.
 *
 * This module inverts that. It starts from the recruit list and resolves each
 * recruit to an athlete id, then attaches every roster season that athlete has. A
 * recruit who was rostered and never played is a row with rostered:true and
 * usageOverall≈0; a recruit who never appeared on any FBS roster is a row with
 * rostered:false. Both are retained.
 *
 * Linking is tiered because roster.recruitIds is incomplete — it resolved only 53%
 * of recruits on the first build, and the unresolved pile contained Kyler Murray,
 * Jarrett Stidham and Byron Cowart, who are conspicuously not busts:
 *
 *   Tier 1  roster.recruitIds contains the recruit id            (authoritative)
 *   Tier 2  normalized name matches at the committed school,      (inferred)
 *           inside the eligibility window, athlete unclaimed,
 *           and neither the name nor the athlete is ambiguous
 *
 * Once an athlete id is resolved by either tier, ALL of that athlete's roster
 * seasons are attached, so transfers are followed (Murray: Texas A&M 2015 then
 * Oklahoma 2016-2018). Tier 2 links are counted and reported separately so the
 * inferred share of the dataset is always visible.
 */

import {
  getDraftPicks,
  getGamePlayers,
  getPortal,
  getRecruits,
  getRoster,
  getTeams,
  getUsage,
} from './cfbd.ts';
import {
  isPowerConference,
  normalizeName,
  normalizeTeam,
  resolvePositionGroup,
} from './positions.ts';
import type {
  CfbdRecruit,
  CfbdRosterPlayer,
  PlayerSeason,
  PositionGroup,
} from './types.ts';

/** Recruit classes to ingest. PDR §3.1.4 asks for 10 (2015-2024); legacy had 7. */
export const FIRST_RECRUIT_YEAR = 2015;
export const LAST_RECRUIT_YEAR = 2024;

/**
 * Latest season with roster/usage data.
 *
 * This is a hard boundary, not a filter: rows are only emitted for seasons that
 * have actually been played. Emitting a row for a future season would set
 * rostered:false on it, and a labeler would read that as non-participation when it
 * really means "hasn't happened yet". A 2024 recruit therefore contributes
 * eligibility years 1-2 only — right-censored, which is correct, rather than five
 * years with three phantom busts.
 */
export const LAST_SEASON = 2025;

/** PDR §3.1.3 reports outcomes across eligibility years 1-5. */
const MAX_ELIGIBILITY_YEAR = 5;

/** Draft classes to scan. A 2015 recruit can be drafted from 2018 onward. */
const FIRST_DRAFT_YEAR = 2016;
const LAST_DRAFT_YEAR = 2026;

/** Portal seasons to ingest for the transfer cohort. */
const FIRST_PORTAL_YEAR = 2018;

export interface Coverage {
  recruitsPulled: number;
  /** Resolved via roster.recruitIds. */
  linkedTier1: number;
  /** Resolved via name + committed school + window. */
  linkedTier2: number;
  /** Tier 2 candidates rejected because the name was ambiguous. */
  tier2Ambiguous: number;
  unlinked: number;
  rosterEntriesTotal: number;
  rosterEntriesWithRecruitIds: number;
  positionUnresolved: number;
  portalEntriesPulled: number;
  portalEntriesMatched: number;
  /** Per position group: rostered rows, and how many have a usage row. */
  usageByPosition: Map<PositionGroup, { rostered: number; withUsage: number }>;
  gamesIngested: boolean;
}

interface RosterSeason {
  season: number;
  player: CfbdRosterPlayer;
}

interface Indexes {
  recruits: Map<string, CfbdRecruit>;
  /** athleteId -> every roster season for that athlete. */
  rosterByAthlete: Map<string, RosterSeason[]>;
  /** recruitId -> resolved athleteId. */
  athleteByRecruit: Map<string, string>;
  /** recruitId -> which tier resolved it. */
  linkTier: Map<string, 1 | 2>;
  /** `season:athleteId` -> usage.overall. */
  usage: Map<string, number>;
  /** athleteId -> best (lowest) draft round. */
  draft: Map<string, number>;
  /** `season:normalizedTeam` -> conference. */
  conference: Map<string, string | null>;
  /** `season:athleteId` -> distinct games with a box-score line. */
  games: Map<string, number>;
  /**
   * `season:normalizedTeam` for every team-season actually pulled.
   *
   * Load-bearing: the games pull is P4-only, so a rostered non-P4 player has no
   * entry in `games` for reasons that have nothing to do with playing. Without
   * this set, gamesPlayed would read 0 — indistinguishable from "did not play" —
   * for 33,806 rostered non-P4 rows, and a labeler would call them all busts.
   * Absent from this set means gamesPlayed is null (unknown), never 0.
   */
  gamesPulled: Set<string>;
  gamesIngested: boolean;
  rosterMeta: { total: number; linked: number };
  tier2Ambiguous: number;
}

const key = (season: number, id: string): string => `${season}:${id}`;

/** Pull every feed the join needs and index it for O(1) lookups. */
async function buildIndexes(includeGames: boolean): Promise<Indexes> {
  const seasons: number[] = [];
  for (let s = FIRST_RECRUIT_YEAR; s <= LAST_SEASON; s++) seasons.push(s);

  // --- recruits -------------------------------------------------------------
  const recruits = new Map<string, CfbdRecruit>();
  for (let year = FIRST_RECRUIT_YEAR; year <= LAST_RECRUIT_YEAR; year++) {
    for (const recruit of await getRecruits(year)) {
      if (recruit.id) recruits.set(String(recruit.id), recruit);
    }
  }
  console.log(`  recruits indexed: ${recruits.size}`);

  // --- rosters, indexed by athlete and by name+team -------------------------
  const rosterByAthlete = new Map<string, RosterSeason[]>();
  const rosterByNameTeam = new Map<string, RosterSeason[]>();
  const recruitIdToAthletes = new Map<string, Set<string>>();
  let rosterEntriesTotal = 0;
  let rosterEntriesWithRecruitIds = 0;

  for (const season of seasons) {
    const roster = await getRoster(season);
    rosterEntriesTotal += roster.length;

    for (const player of roster) {
      const athleteId = String(player.id);
      const entry: RosterSeason = { season, player };

      const byAthlete = rosterByAthlete.get(athleteId);
      if (byAthlete) byAthlete.push(entry);
      else rosterByAthlete.set(athleteId, [entry]);

      const name = normalizeName(
        `${player.firstName ?? ''} ${player.lastName ?? ''}`,
      );
      if (name) {
        const nameTeamKey = `${name}|${normalizeTeam(player.team)}`;
        const byNameTeam = rosterByNameTeam.get(nameTeamKey);
        if (byNameTeam) byNameTeam.push(entry);
        else rosterByNameTeam.set(nameTeamKey, [entry]);
      }

      if (player.recruitIds?.length) {
        rosterEntriesWithRecruitIds++;
        for (const recruitId of player.recruitIds) {
          const id = String(recruitId);
          const set = recruitIdToAthletes.get(id);
          if (set) set.add(athleteId);
          else recruitIdToAthletes.set(id, new Set([athleteId]));
        }
      }
    }
    console.log(`  roster ${season}: ${roster.length} entries`);
  }

  // --- tier 1: authoritative recruitIds links -------------------------------
  const athleteByRecruit = new Map<string, string>();
  const linkTier = new Map<string, 1 | 2>();
  const claimedAthletes = new Set<string>();

  for (const [recruitId, athleteIds] of recruitIdToAthletes) {
    if (!recruits.has(recruitId)) continue;
    // A recruit id occasionally maps to several athlete records (duplicate feed
    // entries). Take the one with the most roster seasons — the fuller record.
    let best: string | null = null;
    let bestSeasons = -1;
    for (const athleteId of athleteIds) {
      const count = rosterByAthlete.get(athleteId)?.length ?? 0;
      if (count > bestSeasons) {
        bestSeasons = count;
        best = athleteId;
      }
    }
    if (!best) continue;
    athleteByRecruit.set(recruitId, best);
    linkTier.set(recruitId, 1);
    claimedAthletes.add(best);
  }
  console.log(`  tier 1 links (recruitIds): ${athleteByRecruit.size}`);

  // --- tier 2: name + committed school, inside the eligibility window -------
  // Ambiguity guard: if two recruits in the 10-class window share a normalized
  // name, neither is eligible for a tier 2 link — a wrong link is worse than a
  // missing one, because it silently attributes one player's career to another.
  const recruitNameCounts = new Map<string, number>();
  for (const recruit of recruits.values()) {
    const name = normalizeName(recruit.name);
    if (name) recruitNameCounts.set(name, (recruitNameCounts.get(name) ?? 0) + 1);
  }

  let tier2 = 0;
  let tier2Ambiguous = 0;
  for (const [recruitId, recruit] of recruits) {
    if (athleteByRecruit.has(recruitId)) continue;

    const name = normalizeName(recruit.name);
    if (!name || !recruit.committedTo) continue;

    if ((recruitNameCounts.get(name) ?? 0) > 1) {
      tier2Ambiguous++;
      continue;
    }

    const candidates = (
      rosterByNameTeam.get(`${name}|${normalizeTeam(recruit.committedTo)}`) ?? []
    ).filter(
      (entry) =>
        entry.season >= recruit.year &&
        entry.season <= recruit.year + MAX_ELIGIBILITY_YEAR - 1 &&
        !claimedAthletes.has(String(entry.player.id)),
    );
    if (candidates.length === 0) continue;

    // Several unclaimed athlete records under one name at one school means the
    // feed itself is ambiguous here; skip rather than guess.
    const distinctAthletes = new Set(candidates.map((c) => String(c.player.id)));
    if (distinctAthletes.size > 1) {
      tier2Ambiguous++;
      continue;
    }

    const athleteId = String(candidates[0]!.player.id);
    athleteByRecruit.set(recruitId, athleteId);
    linkTier.set(recruitId, 2);
    claimedAthletes.add(athleteId);
    tier2++;
  }
  console.log(`  tier 2 links (name + school): ${tier2}`);

  // --- usage ----------------------------------------------------------------
  const usage = new Map<string, number>();
  for (const season of seasons) {
    for (const row of await getUsage(season)) {
      const overall = row.usage?.overall;
      if (row.id != null && overall != null) {
        usage.set(key(season, String(row.id)), overall);
      }
    }
  }
  console.log(`  usage rows indexed: ${usage.size}`);

  // --- conferences per season ----------------------------------------------
  const conference = new Map<string, string | null>();
  for (const season of seasons) {
    for (const team of await getTeams(season)) {
      conference.set(key(season, normalizeTeam(team.school)), team.conference);
    }
  }

  // --- draft picks ----------------------------------------------------------
  const draft = new Map<string, number>();
  for (let year = FIRST_DRAFT_YEAR; year <= LAST_DRAFT_YEAR; year++) {
    let picks: Awaited<ReturnType<typeof getDraftPicks>>;
    try {
      picks = await getDraftPicks(year);
    } catch {
      // Future draft years are not published yet; not an error.
      continue;
    }
    for (const pick of picks) {
      if (pick.collegeAthleteId == null) continue;
      // collegeAthleteId is a number here but a string everywhere else.
      const id = String(pick.collegeAthleteId);
      const round = pick.round ?? 7;
      const prior = draft.get(id);
      if (prior == null || round < prior) draft.set(id, round);
    }
  }
  console.log(`  drafted athletes indexed: ${draft.size}`);

  // --- games played (expensive: per-team, P4 only) --------------------------
  const games = new Map<string, number>();
  const gamesPulled = new Set<string>();
  if (includeGames) {
    for (const season of seasons) {
      const teams = (await getTeams(season)).filter((t) =>
        isPowerConference(t.conference),
      );
      for (const team of teams) {
        let boxScores: Awaited<ReturnType<typeof getGamePlayers>>;
        try {
          boxScores = await getGamePlayers(season, team.school);
        } catch {
          // A single team-season failing should not abort a ~770-call pull.
          // Deliberately not added to gamesPulled — its rows stay unknown.
          continue;
        }
        gamesPulled.add(key(season, normalizeTeam(team.school)));
        // An athlete appears once per stat type, so the same game recurs many
        // times in the nested payload — count distinct game ids.
        const seen = new Set<string>();
        for (const game of boxScores) {
          for (const side of game.teams) {
            for (const category of side.categories) {
              for (const type of category.types) {
                for (const athlete of type.athletes) {
                  if (!athlete.id) continue;
                  const pair = `${game.id}:${athlete.id}`;
                  if (seen.has(pair)) continue;
                  seen.add(pair);
                  const k = key(season, String(athlete.id));
                  games.set(k, (games.get(k) ?? 0) + 1);
                }
              }
            }
          }
        }
      }
      console.log(`  games ${season}: ${games.size} athlete-seasons cumulative`);
    }
  }

  return {
    recruits,
    rosterByAthlete,
    athleteByRecruit,
    linkTier,
    usage,
    draft,
    conference,
    games,
    gamesPulled,
    gamesIngested: includeGames,
    rosterMeta: { total: rosterEntriesTotal, linked: rosterEntriesWithRecruitIds },
    tier2Ambiguous,
  };
}

/**
 * Games played for one athlete-season, or null when unknowable.
 *
 * Returns null unless that specific team-season was pulled. 0 is reserved for
 * "was on a pulled roster and recorded no box-score line" — a real signal.
 */
function resolveGamesPlayed(
  indexes: Indexes,
  season: number,
  team: string | null | undefined,
  athleteId: string | null,
): number | null {
  if (!indexes.gamesIngested || !athleteId || !team) return null;
  if (!indexes.gamesPulled.has(key(season, normalizeTeam(team)))) return null;
  return indexes.games.get(key(season, athleteId)) ?? 0;
}

/** Build the high-school recruit cohort — the main body of the dataset. */
function buildHighSchoolCohort(indexes: Indexes, coverage: Coverage): PlayerSeason[] {
  const rows: PlayerSeason[] = [];

  for (const [recruitId, recruit] of indexes.recruits) {
    const athleteId = indexes.athleteByRecruit.get(recruitId) ?? null;
    const rosterSeasons = athleteId
      ? (indexes.rosterByAthlete.get(athleteId) ?? [])
      : [];

    const tier = indexes.linkTier.get(recruitId);
    if (tier === 1) coverage.linkedTier1++;
    else if (tier === 2) coverage.linkedTier2++;
    else coverage.unlinked++;

    // Any roster position this athlete ever held, for resolving ATH recruits.
    const everPlayedPosition =
      rosterSeasons.find((entry) => entry.player.position)?.player.position ?? null;

    const group = resolvePositionGroup(everPlayedPosition, recruit.position);
    if (!group) {
      coverage.positionUnresolved++;
      continue;
    }

    const bySeasonMap = new Map(rosterSeasons.map((entry) => [entry.season, entry]));
    const lastSeason = Math.min(
      recruit.year + MAX_ELIGIBILITY_YEAR - 1,
      LAST_SEASON,
    );

    for (let season = recruit.year; season <= lastSeason; season++) {
      const rosterPlayer = bySeasonMap.get(season)?.player ?? null;
      const conf = rosterPlayer
        ? (indexes.conference.get(key(season, normalizeTeam(rosterPlayer.team))) ??
          null)
        : null;
      const usageOverall = athleteId
        ? (indexes.usage.get(key(season, athleteId)) ?? null)
        : null;

      if (rosterPlayer) {
        const bucket = coverage.usageByPosition.get(group) ?? {
          rostered: 0,
          withUsage: 0,
        };
        bucket.rostered++;
        if (usageOverall != null) bucket.withUsage++;
        coverage.usageByPosition.set(group, bucket);
      }

      const draftRound = athleteId ? (indexes.draft.get(athleteId) ?? null) : null;

      rows.push({
        recruitId,
        athleteId,
        name: recruit.name,
        position: group,
        positionRaw: rosterPlayer?.position ?? recruit.position ?? null,
        source: 'HighSchool',
        stars: recruit.stars ?? null,
        rating: recruit.rating ?? null,
        ranking: recruit.ranking ?? null,
        // Prefer measured roster height/weight; recruit values are self-reported.
        height: rosterPlayer?.height ?? recruit.height ?? null,
        weight: rosterPlayer?.weight ?? recruit.weight ?? null,
        recruitYear: recruit.year,
        committedTo: recruit.committedTo ?? null,
        season,
        eligibilityYear: season - recruit.year + 1,
        team: rosterPlayer?.team ?? null,
        conference: conf,
        power4: isPowerConference(conf),
        rostered: rosterPlayer != null,
        usageOverall,
        gamesPlayed: resolveGamesPlayed(
          indexes,
          season,
          rosterPlayer?.team,
          athleteId,
        ),
        draftPick: draftRound != null,
        draftRound,
        linkTier: tier ?? null,
      });
    }
  }

  return rows;
}

/**
 * Build the transfer-portal cohort — PDR §3.1.2 "Player Source", and the dataset
 * behind core use case #2 (comparing two portal targets).
 *
 * /player/portal carries no player id, so this joins on normalized name against the
 * destination team's roster for the transfer season. Weaker than the recruitIds
 * join; the match rate is reported rather than assumed.
 */
async function buildPortalCohort(
  indexes: Indexes,
  coverage: Coverage,
): Promise<PlayerSeason[]> {
  const rows: PlayerSeason[] = [];

  // name|team -> athleteIds, restricted to the portal era.
  const athleteByNameTeam = new Map<string, string>();
  for (const [athleteId, rosterSeasons] of indexes.rosterByAthlete) {
    for (const { season, player } of rosterSeasons) {
      if (season < FIRST_PORTAL_YEAR) continue;
      const name = normalizeName(
        `${player.firstName ?? ''} ${player.lastName ?? ''}`,
      );
      if (!name) continue;
      athleteByNameTeam.set(
        `${season}:${name}|${normalizeTeam(player.team)}`,
        athleteId,
      );
    }
  }

  for (let year = FIRST_PORTAL_YEAR; year <= LAST_SEASON; year++) {
    let entries: Awaited<ReturnType<typeof getPortal>>;
    try {
      entries = await getPortal(year);
    } catch {
      continue;
    }

    for (const entry of entries) {
      coverage.portalEntriesPulled++;
      // No destination means the transfer never resolved to a school.
      if (!entry.destination) continue;

      const name = normalizeName(`${entry.firstName ?? ''} ${entry.lastName ?? ''}`);
      if (!name) continue;

      const athleteId = athleteByNameTeam.get(
        `${year}:${name}|${normalizeTeam(entry.destination)}`,
      );
      if (!athleteId) continue;
      coverage.portalEntriesMatched++;

      const rosterSeasons = indexes.rosterByAthlete.get(athleteId) ?? [];
      const bySeasonMap = new Map(rosterSeasons.map((e) => [e.season, e]));
      const firstRoster = bySeasonMap.get(year)?.player ?? null;

      const group = resolvePositionGroup(firstRoster?.position, entry.position);
      if (!group) {
        coverage.positionUnresolved++;
        continue;
      }

      const lastSeason = Math.min(year + MAX_ELIGIBILITY_YEAR - 1, LAST_SEASON);
      const draftRound = indexes.draft.get(athleteId) ?? null;

      for (let season = year; season <= lastSeason; season++) {
        const rosterPlayer = bySeasonMap.get(season)?.player ?? null;
        const conf = rosterPlayer
          ? (indexes.conference.get(key(season, normalizeTeam(rosterPlayer.team))) ??
            null)
          : null;

        rows.push({
          recruitId: `portal-${year}-${athleteId}`,
          athleteId,
          name: `${entry.firstName ?? ''} ${entry.lastName ?? ''}`.trim(),
          position: group,
          positionRaw: rosterPlayer?.position ?? entry.position ?? null,
          source: 'Portal',
          stars: entry.stars ?? null,
          rating: entry.rating ?? null,
          // The portal feed carries no national ranking.
          ranking: null,
          height: rosterPlayer?.height ?? firstRoster?.height ?? null,
          weight: rosterPlayer?.weight ?? firstRoster?.weight ?? null,
          // For a portal player, "recruit year" is the transfer year.
          recruitYear: year,
          committedTo: entry.destination,
          season,
          eligibilityYear: season - year + 1,
          team: rosterPlayer?.team ?? null,
          conference: conf,
          power4: isPowerConference(conf),
          rostered: rosterPlayer != null,
          usageOverall: indexes.usage.get(key(season, athleteId)) ?? null,
          gamesPlayed: resolveGamesPlayed(
            indexes,
            season,
            rosterPlayer?.team,
            athleteId,
          ),
          draftPick: draftRound != null,
          draftRound,
          // Portal links are always name-inferred.
          linkTier: 2,
        });
      }
    }
  }

  return rows;
}

export interface JoinResult {
  rows: PlayerSeason[];
  coverage: Coverage;
}

/** Run the full recruit-first join. */
export async function join(includeGames: boolean): Promise<JoinResult> {
  console.log('Indexing CFBD feeds...');
  const indexes = await buildIndexes(includeGames);

  const coverage: Coverage = {
    recruitsPulled: indexes.recruits.size,
    linkedTier1: 0,
    linkedTier2: 0,
    tier2Ambiguous: indexes.tier2Ambiguous,
    unlinked: 0,
    rosterEntriesTotal: indexes.rosterMeta.total,
    rosterEntriesWithRecruitIds: indexes.rosterMeta.linked,
    positionUnresolved: 0,
    portalEntriesPulled: 0,
    portalEntriesMatched: 0,
    usageByPosition: new Map(),
    gamesIngested: includeGames,
  };

  console.log('Building high-school cohort...');
  const hs = buildHighSchoolCohort(indexes, coverage);
  console.log(`  ${hs.length} rows`);

  console.log('Building portal cohort...');
  const portal = await buildPortalCohort(indexes, coverage);
  console.log(`  ${portal.length} rows`);

  return { rows: [...hs, ...portal], coverage };
}
