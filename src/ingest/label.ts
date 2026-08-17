/**
 * Outcome labeling — absolute standards, not percentile buckets.
 *
 * WHAT THIS REPLACES
 * The legacy pipeline cut `impact_percentile` at 0.25/0.60/0.85, which forced the
 * distribution to be Bust 25.0 / Depth 35.0 / Starter 25.0 / Impact 15.0 in EVERY
 * eligibility year — the cut points restated, not a finding. It was also
 * position-RELATIVE, so a "Starter" RB and a "Starter" WR were different things,
 * and that fed straight into the dollar mapping.
 *
 * THE STANDARD HERE
 * PDR §3.1.1 wants absolute standards: Starter = holds a starting role for a full
 * season; Impact = All-Conference / draft caliber. Both are now measurable:
 *
 *   snapShare  player snaps / an estimate of the team's plays that season
 *   waa        PFF wins-above-average, position-standardized by construction
 *
 * WHY snapShare AND NOT RAW SNAPS
 * Season length varies — 2020 averaged 200 snaps per player against ~270 in
 * neighbouring years. A raw-snap threshold would have mislabeled that whole season.
 * Dividing by an estimate of team plays makes the measure per-opportunity, so a
 * shortened season self-corrects.
 *
 * HOW TEAM PLAYS IS ESTIMATED
 * From the maximum snap count among that team-season's own offensive linemen (for
 * offensive positions) or its front-seven/secondary (for defensive ones). A healthy
 * starting lineman is on the field for very nearly every offensive play, so max OL
 * snaps is a close proxy for offensive plays run. This is a NORMALIZER, not a
 * threshold: the labeling cut points below stay absolute, and cohort rates are free
 * to vary by star level, era and eligibility year — which is the entire point of
 * moving off percentiles.
 *
 * WHAT IS NOT LABELED
 * Redshirt/ineligible seasons are censored rather than called Bust. Kyler Murray's
 * 2016 is the canonical case: rostered at Oklahoma, zero participation, because he
 * was sitting out a transfer. That is not an outcome, it is a year that did not
 * count. See RedshirtRule below.
 */

import type { PlayerSeason, PositionGroup } from './types.ts';

/** PDR §3.1.1 outcome categories, plus the censoring state. */
export type Outcome =
  | 'Bust'
  | 'Depth / Rotation'
  | 'Starter'
  | 'Impact Player'
  /** Not an outcome — a season that should not enter the distribution. */
  | 'Redshirt / Ineligible'
  /**
   * The data cannot support a label. Currently only specialists: PFF records a
   * median of 1 snap for K/P/LS in the WAA feed and grades almost none of them
   * (18 of 418 kickers in the game-grade sample), so snap share and WAA cannot
   * tell a starting kicker from a walk-on. Emitting a guess here would put a
   * fabricated number in front of a recruiter, so the group is excluded and the
   * exclusion is stated.
   */
  | 'Insufficient Data'
  /**
   * The recruit was never resolved to an athlete, so nothing about their career
   * was observed. NOT an outcome — censored.
   *
   * This state exists because omitting it reproduced the predecessor's error with
   * the sign flipped. Labeling unresolved recruits Bust made 56,802 rows — 31.7%
   * of all reported rows and 40.9% of the entire Bust pile — Bust because the
   * pipeline could not find them, not because anything was measured. That is a
   * definitional artifact dressed as a finding, exactly like the percentile cuts.
   *
   * The pile is provably not "players who did not make it": 40.9% have no
   * committedTo at all (so tier 2 can never reach them), and 25.2% committed to a
   * non-FBS school and will never appear on an FBS roster — they are out of
   * universe. committedTo fill rate is itself a feed artifact varying 66.6% (2015)
   * to 94.2% (2021), so leaving them in made cohort composition drift across
   * classes for non-football reasons.
   *
   * Effect of excluding them: headline Bust falls from 77.5% to roughly 61-66%.
   * Larger than any threshold decision in this file.
   */
  | 'Unresolved';

/**
 * Share of the team's plays at which a season counts as holding a starting role.
 *
 * CALIBRATED, NOT ESTIMATED. These began as my football estimates (QB 0.65,
 * OL 0.70, RB 0.35) and that was the weakest link in the labeler: unlike
 * IMPACT_WAA they had no external anchor, and measurement showed they were
 * inconsistent across positions. Starters found per real starting slot ranged from
 * 0.26 at running back to 0.55 at tight end — a 2.1x spread, meaning "Starter" was
 * a materially harder bar at one position than another. That is the same
 * cross-position incomparability the rewrite exists to remove, just less visible
 * than the Impact case.
 *
 * Each value is now the snap share that yields the SAME number of starters per
 * real starting slot (0.37) at every position, anchored to the slot counts in
 * STARTING_SLOTS. The ratio is below 1.0 because the cohort covers only 2015+
 * recruits — no walk-ons, no JUCO, no pre-2015 sixth-years — so we can never find
 * every starter on a roster. Equalizing at the observed median preserves the
 * overall Starter rate while making the bar mean the same thing everywhere.
 *
 * The resulting values are also football-sensible, which is the check that matters:
 * linemen and quarterbacks near 0.78, a committee running back at 0.29, rotational
 * defensive linemen at 0.47.
 *
 * Derived 2026-08-17. Re-derive if STARTING_SLOTS or the cohort window changes.
 */
export const STARTER_SNAP_SHARE: Record<PositionGroup, number> = {
  QB: 0.761,
  RB: 0.29,
  WR: 0.496,
  TE: 0.575,
  OL: 0.785,
  DL: 0.468,
  LB: 0.534,
  DB: 0.687,
  // Specialists are excluded entirely — see the Insufficient Data note above.
  ST: 0.0,
};

/** Below this share of team plays, a player was not meaningfully in the rotation. */
export const ROTATION_SNAP_SHARE = 0.1;

/**
 * WAA at or above which a season counts as Impact — PER POSITION.
 *
 * A single cut across positions does not work, and the first run proved it: at a
 * uniform 0.28, quarterbacks came out 2.6% Impact and offensive linemen 0.0%,
 * across eleven seasons. WAA is in common UNITS (wins) but not a common RANGE — a
 * quarterback touches every offensive snap, so his achievable win-swing tops out
 * near 2.4 while a tackle's tops out near 0.5. One threshold therefore makes Impact
 * routine at one position and arithmetically impossible at another, which is the
 * cross-position incomparability this whole rewrite exists to remove.
 *
 * These values are a standardization, expressed in interpretable units. Each is the
 * WAA cut that reproduces that position's real All-Conference volume — starting
 * slots per team times roughly eight Power 4 selections — measured as the median
 * across the eleven seasons. So the threshold means "All-Conference caliber at this
 * position", which is what PDR §3.1.1 actually asks for, rather than "N standard
 * deviations", which means nothing to a coach.
 *
 * Critically, these are FIXED absolute cuts derived once from the full FBS
 * population. They are NOT recomputed per cohort or per season — that recomputation
 * is precisely what made the legacy labels a definitional artifact. Cohort Impact
 * rates remain free to vary by star rating, eligibility year and era.
 *
 * RESCALED 2026-08-17 by k=0.60 after measurement showed the first derivation
 * missed its own target by ~40%. The stated anchor is All-Conference volume, and
 * IMPACT_TARGET_PER_SEASON declares 350; the original cuts produced a median of 263
 * seasons over threshold (25%% low) and only 155 Impact labels per season inside the
 * cohort. The cost was visible on players anyone would recognise: Lamar Jackson
 * (Heisman, max WAA 0.653 against a 0.785 QB cut), Travon Walker (#1 overall) and
 * Calvin Ridley (0.244 against a 0.245 cut) all read "Starter". 57 of the 68
 * first-round picks missing Impact failed on threshold alone, not on the join.
 *
 * FINAL SCALE: 0.84 of the original cuts (0.60 x 1.4). The intermediate 0.60 came
 * from a measurement taken BEFORE out-of-career seasons were censored; removing 43%%
 * of the Bust pile lifted every other share, so 0.60 then overshot badly — 592
 * Impact seasons in 2024 against a 350 target. Re-derived against current labels:
 * by 2024 the cohort spans five recruit classes and therefore approximates a full
 * FBS roster, so 350 is the right target for that season, and 0.84 yields 365.
 *
 * A NOTE ON THE TENSION, because it is real and should not be quietly optimised
 * away: All-Conference volume and NFL-draftee recall pull in opposite directions.
 * Loosening the cut until most draftees reach Impact would produce far more Impact
 * seasons than All-Conference selections exist. Volume is the principled anchor —
 * it is tied to an external quantity — while draftee recall is a VALIDATION signal.
 * Tuning the threshold to maximise recall would be fitting to the validation set.
 * This scale keeps the volume anchor and accepts imperfect recall.
 *
 * Relative position weighting is unchanged by any rescale, so the fix for QB 2.6%%
 * vs OL 0.0%% still holds.
 *
 * Derived 2026-08-17 from 104,478 PFF player-seasons. Re-derive with
 * calibrateImpactThreshold() if the slot assumptions change.
 */
export const IMPACT_WAA: Record<PositionGroup, number> = {
  QB: 0.6594,
  RB: 0.1394,
  WR: 0.2058,
  TE: 0.1798,
  OL: 0.0958,
  DL: 0.1445,
  LB: 0.142,
  DB: 0.1898,
  // Specialists never reach Impact — see the Insufficient Data note above.
  ST: Number.POSITIVE_INFINITY,
};

/** Starting slots per team, per group — the anchor for the cuts above. */
export const STARTING_SLOTS: Record<PositionGroup, number> = {
  QB: 1,
  RB: 2,
  WR: 3,
  TE: 1,
  OL: 5,
  DL: 4,
  LB: 3,
  DB: 4,
  ST: 3,
};

// Specialists are excluded outright rather than given weak labels. Measured on the
// labeled set: median PFF snaps for K/P/LS is 1. There is no signal to threshold.

export interface LabelInputs {
  /** PFF season snap total, or null when the player has no PFF row. */
  pffSnaps: number | null;
  /** PFF wins above average, or null. */
  pffWaa: number | null;
  /** Estimated plays run by this player's team that season. */
  teamPlays: number | null;
  /** Whether the player appeared on a roster at all. */
  rostered: boolean;
  position: PositionGroup;
  /** Snaps in the player's NEXT season, for the redshirt rule. */
  nextSeasonSnaps: number | null;
  /**
   * Independent CFBD participation evidence, used ONLY to refuse a Bust that PFF
   * cannot support. See the corroboration block in labelSeason.
   */
  gamesPlayed: number | null;
  usageOverall: number | null;
  /** Career-level: this athlete was drafted. Used as a Bust veto, never as a label. */
  draftPick: boolean;
  /**
   * True when this season lies OUTSIDE the athlete's college career — before they
   * first appeared on a roster, or after they last did.
   *
   * These must be censored, not Bust. `!rostered` fires for every empty slot in the
   * 5-year window, so a player who left for the NFL after year 3 was labeled Bust in
   * years 4 and 5. Measured consequence: 189 of 231 first-round picks carried at
   * least one Bust season — Ashton Jeanty read Impact/Impact/Impact/BUST — and the
   * UI renders all five slots as pips, so a coach sees a red mark on a top-10 pick.
   * 1,599 of 2,006 Bust rows on drafted athletes were post-departure. 43.3% of the
   * ENTIRE Bust pile is seasons in which the player was not enrolled.
   */
  outsideCareer: boolean;
  /** True when this player-season is the transfer year of a portal move. */
  transferYear: boolean;
  /**
   * Which tier resolved this recruit to an athlete, or null if never resolved.
   * Null means we observed nothing and must not claim an outcome.
   */
  linkTier: 1 | 2 | null;
}

export interface LabelResult {
  outcome: Outcome;
  /** Snaps as a share of estimated team plays, or null when unknowable. */
  snapShare: number | null;
  /** Why this label was assigned — kept for auditing, not display. */
  reason: string;
}

/**
 * Classify one player-season.
 *
 * Order of tests matters. Censoring is checked before Bust so a redshirt year is
 * never counted as a failure, and the not-rostered case is checked before anything
 * requiring PFF data.
 */
export function labelSeason(input: LabelInputs): LabelResult {
  const {
    pffSnaps,
    pffWaa,
    teamPlays,
    rostered,
    position,
    nextSeasonSnaps,
    transferYear,
    linkTier,
    gamesPlayed,
    usageOverall,
    draftPick,
    outsideCareer,
  } = input;

  // Specialists first, before anything else. A K/P/LS who never made a roster is
  // genuinely a bust, but mixing those knowable busts with the rostered
  // specialists we cannot grade produces a distribution that reads "100% of
  // kickers bust" — actively misleading. The group is excluded wholesale, and the
  // UI must say the tool does not cover special teams rather than show a number.
  if (position === 'ST') {
    return {
      outcome: 'Insufficient Data',
      snapShare: null,
      reason: 'specialist: no usable snap or grade signal (PFF median 1 snap)',
    };
  }

  // Never resolved to an athlete: we observed nothing, so we claim nothing.
  // Checked BEFORE the rostered test, because an unresolved recruit is trivially
  // "not rostered" and would otherwise be swept into Bust.
  if (linkTier == null) {
    return {
      outcome: 'Unresolved',
      snapShare: null,
      reason: 'recruit never resolved to an athlete — nothing observed',
    };
  }

  // Outside the college career entirely — left for the NFL, or had not arrived yet.
  // Right-censored exactly like an unplayed future season.
  if (outsideCareer) {
    return {
      outcome: 'Unresolved',
      snapShare: null,
      reason: 'season outside the athlete college career (departed or not yet enrolled)',
    };
  }

  // Resolved, on the roster in other years but not this one: a real, measured Bust,
  // and the case the legacy pipeline could not even represent.
  if (!rostered) {
    return { outcome: 'Bust', snapShare: null, reason: 'not on any FBS roster' };
  }

  const snaps = pffSnaps ?? 0;
  // Clamped at 1: the team-plays denominator is an estimate from the snap leader,
  // so a player who outlasted that leader (injury, two-platoon) can exceed it.
  // A share above 1 is not meaningful — it just means "full-time".
  const snapShare =
    teamPlays && teamPlays > 0 ? Math.min(1, snaps / teamPlays) : null;

  // --- censoring -----------------------------------------------------------
  // Rostered with (almost) no participation, then a real role the following
  // season, means the season was a redshirt or a transfer sit-out rather than a
  // failure. Requiring the NEXT season to show participation is what separates
  // "developing" from "never made it" — without it, every genuine bust's first
  // year would be excused as a redshirt.
  const negligible =
    snapShare == null ? snaps < 20 : snapShare < ROTATION_SNAP_SHARE;
  if (negligible && nextSeasonSnaps != null && nextSeasonSnaps >= 100) {
    return {
      outcome: 'Redshirt / Ineligible',
      snapShare,
      reason: 'minimal snaps, meaningful role the following season',
    };
  }
  // A transfer year with no participation MAY be a sit-out — but inferring that
  // from transferYear alone made Bust arithmetically unreachable for portal players
  // in eligibility year 1. Every portal row has transferYear=true at year 1 and is
  // rostered by construction (the match requires a destination roster entry), so
  // this branch fired first, every time. The tool answered "what happens to a
  // portal transfer in year one?" with 0.00% chance of busting and 40% chance of
  // starting — landing precisely on the PDR's core use case #2, comparing two
  // portal targets.
  //
  // A sit-out now requires POSITIVE evidence: the player must come back and play.
  // Without that, a transfer who never saw the field is a bust, which is what it is.
  if (negligible && transferYear && (nextSeasonSnaps ?? 0) >= 100) {
    return {
      outcome: 'Redshirt / Ineligible',
      snapShare,
      reason: 'transfer sit-out, confirmed by a real role the next season',
    };
  }

  // --- no PFF row ----------------------------------------------------------
  // A missing PFF row USUALLY means rostered-and-did-not-play. But the earlier
  // claim that "PFF covers every FBS team and every position" was wrong: the WAA
  // feed carries roughly 73 players per team against 110-120 rostered, so it is a
  // played-in-a-game feed, not a roster feed. Treating absence as proof of
  // non-participation put 16 first-round NFL picks — Derwin James, Patrick
  // Surtain II, Ikem Ekwonu among them — in the Bust bucket for every season of
  // their careers, because a name-format disagreement broke the join.
  //
  // So before calling it a Bust, check whether CFBD independently says the player
  // was on the field. These signals come from a different provider through a
  // different join, so agreement is meaningful and disagreement is disqualifying.
  if (pffSnaps == null) {
    const playedPerGames = (gamesPlayed ?? 0) >= 6;
    const playedPerUsage = (usageOverall ?? 0) >= 0.1;
    if (playedPerGames || playedPerUsage || draftPick) {
      return {
        outcome: 'Unresolved',
        snapShare: null,
        reason: draftPick
          ? 'no PFF row but the athlete was drafted — join failure, not a bust'
          : `no PFF row but CFBD shows participation (games ${gamesPlayed ?? 0}, usage ${usageOverall ?? 0})`,
      };
    }
    return {
      outcome: 'Bust',
      snapShare: null,
      reason: 'rostered, no PFF row, and no CFBD participation evidence',
    };
  }

  // --- Impact --------------------------------------------------------------
  // Requires BOTH a starting-level role and top-tier value. Value alone is not
  // enough: a small-sample WAA spike from a handful of snaps is noise.
  const startsThreshold = STARTER_SNAP_SHARE[position];
  const isStarter = snapShare != null && snapShare >= startsThreshold;
  const impactCut = IMPACT_WAA[position];
  if (isStarter && pffWaa != null && pffWaa >= impactCut) {
    return {
      outcome: 'Impact Player',
      snapShare,
      reason: `starter role and waa ${pffWaa.toFixed(3)} >= ${impactCut} (${position} cut)`,
    };
  }
  if (isStarter) {
    return {
      outcome: 'Starter',
      snapShare,
      reason: `snap share ${snapShare.toFixed(2)} >= ${startsThreshold}`,
    };
  }
  if (snapShare != null && snapShare >= ROTATION_SNAP_SHARE) {
    return {
      outcome: 'Depth / Rotation',
      snapShare,
      reason: `snap share ${snapShare.toFixed(2)} in rotation band`,
    };
  }
  return {
    outcome: 'Bust',
    snapShare,
    reason:
      snapShare == null
        ? `${snaps} snaps, team plays unknown`
        : `snap share ${snapShare.toFixed(3)} below rotation band`,
  };
}

/**
 * Which side of the ball a group plays, for estimating team plays.
 * Specialists are excluded — they inform neither estimate.
 */
export const UNIT: Record<PositionGroup, 'offense' | 'defense' | 'special'> = {
  QB: 'offense',
  RB: 'offense',
  WR: 'offense',
  TE: 'offense',
  OL: 'offense',
  DL: 'defense',
  LB: 'defense',
  DB: 'defense',
  ST: 'special',
};

/**
 * Estimate plays run per team-season from the snap leaders on each unit.
 *
 * Offense is estimated from the highest OL snap count, defense from the highest
 * among DL/LB/DB. Returns a map keyed `season:team`.
 *
 * MUST BE FED THE FULL PFF POPULATION, NOT THE MATCHED COHORT. Team plays is a
 * property of the team, not of our sample. Computing it from cohort rows only
 * produced snap shares above 1 — a QB at 297 and a WR at 525 — because a
 * team-season whose cohort linemen happened to be backups got a denominator of a
 * few dozen snaps. Defensive positions were unaffected only because they define
 * their own maximum, which masked the bug for half the roster.
 */
/**
 * Plausible band for defensive plays as a multiple of offensive plays, and the
 * central value used when no defensive observation exists.
 *
 * Measured across 1,435 team-seasons: median 0.936, p05 0.777, p95 1.115, max 1.778.
 * The offensive estimate is trustworthy — offensive linemen are on the field for
 * nearly every offensive play and are never two-way — so it anchors the defensive
 * one, which is not trustworthy for two reasons pulling opposite ways:
 *
 *   TWO-WAY PLAYERS inflate it. Colorado 2024's defensive maximum is 1,529, which is
 *   Travis Hunter's combined offence+defence total, against roughly 860 real
 *   defensive plays. Every Colorado defender's snap share was therefore deflated ~44%
 *   and NOT ONE was labeled Starter — an 877-snap full-time cornerback read
 *   "Depth / Rotation". 45 team-seasons exceed 1.15.
 *
 *   HEAVY ROTATION deflates it. Where no defender exceeds ~600 snaps the denominator
 *   is far too small and every share is inflated, over-labeling Starters on exactly
 *   the teams that rotate most. 116 team-seasons fall below 0.80.
 *
 * Clamping to the empirical p05-p95 band keeps genuine team-to-team variation while
 * removing both failure modes. A percentile of unit snaps would be better still, and
 * real per-unit totals are derivable from the game-grade feed — but only one week of
 * that is exported.
 */
const DEF_OFF_RATIO_MIN = 0.78;
const DEF_OFF_RATIO_MAX = 1.12;
const DEF_OFF_RATIO_TYPICAL = 0.936;

export function estimateTeamPlays(
  rows: readonly {
    season: number;
    team: string | null;
    position: PositionGroup;
    snaps: number | null;
  }[],
): Map<string, { offense: number; defense: number }> {
  const out = new Map<string, { offense: number; defense: number }>();
  for (const row of rows) {
    if (!row.team || row.snaps == null) continue;
    const unit = UNIT[row.position];
    if (unit === 'special') continue;
    const key = `${row.season}:${row.team}`;
    const entry = out.get(key) ?? { offense: 0, defense: 0 };
    // Offensive plays are read off linemen only; skill players rotate too much
    // for their maximum to approximate team plays.
    if (unit === 'offense' && row.position === 'OL') {
      entry.offense = Math.max(entry.offense, row.snaps);
    } else if (unit === 'defense') {
      entry.defense = Math.max(entry.defense, row.snaps);
    }
    out.set(key, entry);
  }

  // Anchor and clamp the defensive estimate against the reliable offensive one.
  for (const entry of out.values()) {
    if (entry.offense <= 0) continue;
    const floor = entry.offense * DEF_OFF_RATIO_MIN;
    const ceiling = entry.offense * DEF_OFF_RATIO_MAX;
    entry.defense =
      entry.defense > 0
        ? Math.min(ceiling, Math.max(floor, entry.defense))
        : entry.offense * DEF_OFF_RATIO_TYPICAL;
  }
  return out;
}

export const teamPlaysFor = (
  plays: Map<string, { offense: number; defense: number }>,
  season: number,
  team: string | null,
  position: PositionGroup,
): number | null => {
  if (!team) return null;
  const entry = plays.get(`${season}:${team}`);
  if (!entry) return null;
  const unit = UNIT[position];
  if (unit === 'special') return null;
  const value = unit === 'offense' ? entry.offense : entry.defense;
  // Guard against a thin team-season producing a nonsense denominator. A real FBS
  // team runs several hundred plays a season; anything far below that means the
  // estimate is unreliable and the row is better left unlabeled than mislabeled.
  return value >= 200 ? value : null;
};

/**
 * Derive the WAA cut that yields a target number of Impact seasons per year.
 *
 * Used to sanity-check IMPACT_WAA against real All-Conference plus draft volume
 * rather than trusting the constant. Returns the threshold, not a label.
 */
export function calibrateImpactThreshold(
  waaBySeason: Map<number, number[]>,
  targetPerSeason: number,
): number {
  const cuts: number[] = [];
  for (const values of waaBySeason.values()) {
    if (values.length < targetPerSeason) continue;
    const sorted = [...values].sort((a, b) => b - a);
    cuts.push(sorted[targetPerSeason - 1]!);
  }
  if (cuts.length === 0) return Number.NaN;
  cuts.sort((a, b) => a - b);
  const mid = Math.floor(cuts.length / 2);
  return cuts.length % 2 === 0 ? (cuts[mid - 1]! + cuts[mid]!) / 2 : cuts[mid]!;
}

/** Outcomes that enter the reported distribution. Redshirt is censored out. */
export const REPORTED_OUTCOMES: Outcome[] = [
  'Bust',
  'Depth / Rotation',
  'Starter',
  'Impact Player',
];

export const isCensored = (outcome: Outcome): boolean =>
  outcome === 'Redshirt / Ineligible' ||
  outcome === 'Insufficient Data' ||
  outcome === 'Unresolved';

export type LabeledSeason = PlayerSeason & {
  outcome: Outcome;
  snapShare: number | null;
  pffSnaps: number | null;
  pffWaa: number | null;
};
