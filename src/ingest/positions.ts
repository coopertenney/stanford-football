/**
 * Position group mapping and Power 4 scoping.
 *
 * Recruit feeds and roster feeds use different position vocabularies. Enumerated
 * from live 2024 roster (22,843 rows) and 2020 recruit (3,516 rows) payloads:
 *
 *   roster:  WR OL LB DB DL RB TE QB S CB PK DE DT P LS EDGE FB OT G C NT ATH ?
 *   recruit: WR CB ATH OT S OLB RB OG DT ILB SDE TE PRO WDE DUAL OC APB K P LS
 *            IOL EDGE DL LB QB FB
 *
 * Recruiting-service codes are scouting labels, not depth-chart slots — PRO and
 * DUAL are both QBs, SDE/WDE are DL, APB is a RB. ATH ("athlete") is genuinely
 * unresolved at signing: 347 of 3,516 in 2020. That is why resolvePositionGroup()
 * prefers the roster position when the player was rostered — it reflects what the
 * player actually became, and it resolves most ATH for free.
 */

import type { PositionGroup } from './types.ts';

const ROSTER_POSITIONS: Record<string, PositionGroup> = {
  QB: 'QB',
  RB: 'RB',
  FB: 'RB',
  WR: 'WR',
  TE: 'TE',
  OL: 'OL',
  OT: 'OL',
  G: 'OL',
  C: 'OL',
  DL: 'DL',
  DE: 'DL',
  DT: 'DL',
  NT: 'DL',
  EDGE: 'DL',
  LB: 'LB',
  DB: 'DB',
  CB: 'DB',
  S: 'DB',
  PK: 'ST',
  P: 'ST',
  LS: 'ST',
};

const RECRUIT_POSITIONS: Record<string, PositionGroup> = {
  // Recruiting services split QB by play style; both are QBs.
  QB: 'QB',
  PRO: 'QB',
  DUAL: 'QB',
  // APB = "all-purpose back".
  RB: 'RB',
  APB: 'RB',
  FB: 'RB',
  WR: 'WR',
  TE: 'TE',
  // OC = center, IOL = interior OL.
  OT: 'OL',
  OG: 'OL',
  OC: 'OL',
  IOL: 'OL',
  OL: 'OL',
  // SDE/WDE = strong-side / weak-side defensive end.
  DL: 'DL',
  DT: 'DL',
  SDE: 'DL',
  WDE: 'DL',
  EDGE: 'DL',
  DE: 'DL',
  LB: 'LB',
  ILB: 'LB',
  OLB: 'LB',
  DB: 'DB',
  CB: 'DB',
  S: 'DB',
  K: 'ST',
  PK: 'ST',
  P: 'ST',
  LS: 'ST',
};

function normalize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.trim().toUpperCase();
  // The 2024 roster contains a literal "?" entry alongside nulls.
  if (!clean || clean === '?' || clean === 'NULL') return null;
  return clean;
}

/**
 * Resolve a position group, preferring what the player actually played.
 *
 * Returns null when neither source maps — most often an unrostered ATH recruit,
 * which no amount of mapping can place. Callers should count those rather than
 * bucket them arbitrarily.
 */
export function resolvePositionGroup(
  rosterPosition: string | null | undefined,
  recruitPosition: string | null | undefined,
): PositionGroup | null {
  const roster = normalize(rosterPosition);
  if (roster && ROSTER_POSITIONS[roster]) return ROSTER_POSITIONS[roster];

  const recruit = normalize(recruitPosition);
  if (recruit && RECRUIT_POSITIONS[recruit]) return RECRUIT_POSITIONS[recruit];

  return null;
}

/**
 * Conferences treated as Power 4/5 for PDR §3.1.4 scoping.
 *
 * Membership is evaluated per season from that season's conference string, so the
 * 2024 realignment is handled implicitly: a team that moved from the Pac-12 to the
 * Big Ten is P4 in both, and Pac-12 rows stay P4 for the seasons they were.
 */
const POWER_CONFERENCES = new Set([
  'ACC',
  'Big Ten',
  'Big 12',
  'SEC',
  'Pac-12',
  'Pac-10',
]);

export const isPowerConference = (conference: string | null | undefined): boolean =>
  conference ? POWER_CONFERENCES.has(conference.trim()) : false;

/** Normalize a school name for cross-endpoint matching (portal origin/destination). */
export const normalizeTeam = (team: string | null | undefined): string =>
  (team ?? '').trim().toLowerCase();

/** Normalize a player name for the portal join, which has no player id field. */
export const normalizeName = (name: string | null | undefined): string =>
  (name ?? '')
    .toLowerCase()
    .normalize('NFD')
    // Strip combining accents so "Peña" matches "Pena" across feeds.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
