/**
 * Retention curves — the probability a recruit is still on the roster in year N.
 *
 * WHY THIS EXISTS
 * The predecessor summed value across five eligibility years, which silently
 * assumes you keep the player for all five. In the portal era you frequently do
 * not. Without this, year 4-5 value is systematically overstated for exactly the
 * recruits most likely to leave — the good ones.
 *
 * WHAT IS MEASURED
 * P(rostered in year N at the SAME school | rostered in year 1). Same school
 * matters: a player who transfers is still in college football but is no longer
 * your asset, and the tool is pricing your asset.
 *
 * ONLY UNCENSORED CLASSES COUNT
 * Restricted to recruit classes whose full five-year window has been played
 * (through 2021, since 2021 + 4 = 2025). Including censored classes would count
 * "season not yet played" as "player left" and drag the curve down sharply.
 *
 * SPLIT BY ERA, NOT POOLED
 * The 2021 rule change is the entire reason retention matters, so pooling across it
 * would average away the effect being measured.
 */

import type { Era, PositionGroup } from '../ingest/types.ts';

export interface RetentionTable {
  /** `position` -> five probabilities, index 0 = year 1 (always 1.0). */
  byPosition: Record<string, number[]>;
  /** `era` -> five probabilities, for the regime adjustment. */
  byEra: Record<string, number[]>;
  /** Pooled fallback when a cell is too thin to trust. */
  overall: number[];
  /** Classes included; excludes right-censored ones. */
  classesUsed: number[];
  minCellSize: number;
}

const MAX_YEARS = 5;
/** Below this many players in a cell, fall back to the pooled curve. */
const MIN_CELL = 200;

interface Row {
  recruitId: string;
  recruitYear: number;
  eligibilityYear: number;
  position: PositionGroup;
  era: Era;
  team: string | null;
  rostered: boolean;
}

/**
 * Build retention curves from labeled player-seasons.
 *
 * lastCompleteClass is the newest recruit class with all five years observed.
 */
export function buildRetention(
  rows: readonly Row[],
  lastCompleteClass: number,
): RetentionTable {
  // Group by recruit, keeping the year-1 team as the anchor.
  interface Career {
    position: PositionGroup;
    era: Era;
    firstTeam: string | null;
    atFirstTeam: boolean[];
  }
  const careers = new Map<string, Career>();

  for (const row of rows) {
    if (row.recruitYear > lastCompleteClass) continue;
    let career = careers.get(row.recruitId);
    if (!career) {
      career = {
        position: row.position,
        era: row.era,
        firstTeam: null,
        atFirstTeam: new Array<boolean>(MAX_YEARS).fill(false),
      };
      careers.set(row.recruitId, career);
    }
    if (row.eligibilityYear === 1 && row.rostered) career.firstTeam = row.team;
  }

  // Second pass: now that year-1 teams are known, mark presence at that team.
  for (const row of rows) {
    if (row.recruitYear > lastCompleteClass) continue;
    const career = careers.get(row.recruitId);
    if (!career || !career.firstTeam) continue;
    const slot = row.eligibilityYear - 1;
    if (slot >= 0 && slot < MAX_YEARS && row.rostered && row.team === career.firstTeam) {
      career.atFirstTeam[slot] = true;
    }
  }

  // Only careers that actually started somewhere can be tracked.
  const tracked = [...careers.values()].filter((c) => c.firstTeam && c.atFirstTeam[0]);

  const curveFor = (subset: readonly Career[]): number[] => {
    if (subset.length === 0) return new Array<number>(MAX_YEARS).fill(1);
    const out: number[] = [];
    for (let year = 0; year < MAX_YEARS; year++) {
      const present = subset.filter((c) => c.atFirstTeam[year]).length;
      out.push(present / subset.length);
    }
    return out;
  };

  const overall = curveFor(tracked);

  const byPosition: Record<string, number[]> = {};
  for (const position of new Set(tracked.map((c) => c.position))) {
    const subset = tracked.filter((c) => c.position === position);
    byPosition[position] = subset.length >= MIN_CELL ? curveFor(subset) : overall;
  }

  const byEra: Record<string, number[]> = {};
  for (const era of new Set(tracked.map((c) => c.era))) {
    const subset = tracked.filter((c) => c.era === era);
    byEra[era] = subset.length >= MIN_CELL ? curveFor(subset) : overall;
  }

  const classesUsed = [
    ...new Set(rows.filter((r) => r.recruitYear <= lastCompleteClass).map((r) => r.recruitYear)),
  ].sort((a, b) => a - b);

  return { byPosition, byEra, overall, classesUsed, minCellSize: MIN_CELL };
}

/**
 * Retention curve for a position, adjusted for era.
 *
 * The era adjustment is multiplicative on the ratio of era curve to overall curve,
 * so a position curve measured mostly pre-portal still shifts when the recruit
 * being evaluated is in the current regime.
 */
export function retentionFor(
  table: RetentionTable,
  position: PositionGroup,
  era: Era,
): number[] {
  const base = table.byPosition[position] ?? table.overall;
  const eraCurve = table.byEra[era];
  if (!eraCurve) return base;
  return base.map((value, index) => {
    const reference = table.overall[index] ?? 1;
    if (reference <= 0) return value;
    const adjustment = (eraCurve[index] ?? reference) / reference;
    return Math.min(1, Math.max(0, value * adjustment));
  });
}
