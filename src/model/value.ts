/**
 * Value mapping — grounded in public market data where it exists, labelled where
 * it does not.
 *
 * WHAT CHANGED AND WHY
 * This previously computed value as `starterSeasonValue x positionWeight`, a
 * product of TWO invented numbers: a $350,000 scale I made up, and a positional
 * multiplier derived from measured PFF win headroom. The scale had no source at all.
 *
 * Public reporting turns out to publish per-position STARTER DOLLARS directly, so
 * the product collapses into one measured number per position. That removes the
 * invented constant entirely rather than dressing it up.
 *
 * SOURCE OF THE POSITION DOLLARS
 * ESPN, Max Olson, 11 Aug 2026, "What positions cost in the transfer portal" —
 * surveyed 12+ general managers and 12+ agents for per-position, per-season, all-in
 * ranges. Values below are range midpoints. This is a PRACTITIONER SURVEY, not an
 * audited figure; no audited figure exists anywhere (see WHAT IS NOT KNOWABLE).
 *
 * It survives an independent top-down check: 22 starters at these rates plus the QB
 * premium comes to roughly $15.7M, which against a reported $22.5M average Power 4
 * all-in roster cost leaves about $6.8M for ~83 non-starters, or ~$82K each —
 * consistent with ESPN's own "plenty competing for a starting job making $200,000
 * or less". Two independent methods converging is the strongest validation available.
 *
 * CROSS-CHECKED against ACC revenue-share budget allocation by position group
 * (Opendorse College Football Kickoff report, Aug 2025) — real budget data from
 * Stanford's own conference: QB 19.4%, OL 17.0%, WR 16.3%, DL 15.5%, RB 10.6%,
 * DB 7.8%, LB 6.8%, TE 5.3%, ST 1.3%. Those are GROUP shares, so converting to a
 * per-player figure needs a divisor the source does not publish. Dividing by
 * starting slots implies a QB premium of 3.57x a receiver, against the 2.86x in the
 * table below — so this table is if anything CONSERVATIVE on the largest price in
 * the sport. The two disagree more on OL, DB and LB, where a starting-slot divisor
 * is a poor proxy for roster depth; ESPN's figures are per-player by construction
 * and are preferred for that reason.
 *
 * NOT USED: the 75/15/5 football/MBB/WBB split widely quoted from House v. NCAA.
 * It is the BACK-DAMAGES allocation for past athletes and an expert's opinion about
 * a counterfactual; the settlement is silent on forward per-sport allocation. The
 * "$146,000 per player" figure circulating from it is $20.5M x 0.75 / 105 — three
 * assumptions and a calculator, reproduced without measurement. Schools where
 * records were actually obtained came in below it.
 *
 * A second source agrees on the shape: a position chart via FootballScoop
 * (12 Jun 2026) normalizes to within +/-0.2 of these ratios for eight of twelve
 * positions. The QB premium of ~3x a non-QB starter is confirmed by both and is the
 * single most robust relationship in this data.
 *
 * WHAT WAS DELIBERATELY NOT USED
 *  - On3 valuations before July 2026 are MODEL OUTPUT, not money — an algorithm
 *    blending social following and performance. Feeding them in would plant a second
 *    unlabelled modelling artifact beside the percentile-bucket problem this project
 *    already exists to remove.
 *  - Opendorse's positional revenue-share percentages are real payments but published
 *    only as group shares. Converting to per-player needs a players-per-position
 *    divisor nobody publishes; doing so put RB above WR and OL below DB, contradicting
 *    both dollar sources. Directional evidence only.
 *  - Headline transfer figures are usually MULTI-YEAR TOTALS. Mensah's reported "$8M"
 *    is $4M/yr; Ojo's "$5.1M" is ~$775K/yr. This model values a SEASON, so ingesting
 *    headline numbers raw would overstate by 2-4x.
 *  - Several widely-circulating recruit-pricing tables are AI-generated SEO content
 *    with no attribution (one admits in its footer to being "researched autonomously
 *    by The Machine"). Excluded.
 */

import type { PositionGroup } from '../ingest/types.ts';
import { ORDERED_OUTCOMES, type OrderedOutcome } from './ordinal.ts';

/**
 * Dollars for ONE SEASON from a player holding a starting job at that position,
 * Power 4 average, 2026, all-in (revenue share plus third-party NIL).
 *
 * ESPN range midpoints, mapped onto our nine groups. Where a group spans several
 * ESPN positions it is weighted by how many of each actually start:
 *   OL  = (2 x OT $900K + 3 x interior $600K) / 5
 *   DL  = (2 x EDGE $850K + 2 x DT $750K) / 4
 *   DB  = (2 x CB $650K + 2 x S $600K) / 4
 *
 * QB at $2M is ~3x the non-QB starter mean. The predecessor's value_mapping.json
 * had no QB entry at all, so the single largest price in the sport was unrepresented.
 */
export const POSITION_STARTER_VALUE: Record<PositionGroup, number> = {
  QB: 2_000_000,
  OL: 720_000,
  WR: 700_000,
  DL: 800_000,
  DB: 625_000,
  RB: 550_000,
  LB: 500_000,
  TE: 450_000,
  // Specialists are never labelled by the model, so this is not exercised today.
  ST: 125_000,
};

/**
 * Value of each outcome tier as a multiple of a starter season.
 *
 * REVISED against ESPN's within-position backup / starter / elite breakdown.
 * The previous ratios came from the PDR §3.2.1 defaults (0.25 / 1.00 / 3.00) and the
 * market disagrees in both directions:
 *
 *   DEPTH was far too low. The PDR implies a backup is worth a quarter of a starter;
 *   reported figures put a rostered Power 4 backup at 0.6-0.7x (TE backup $250-400K
 *   against a $500-600K starter; a No.3 receiver $200-600K against a No.2 at
 *   $500-600K). This was the larger error, and it biased expected value DOWNWARD for
 *   the most common non-bust outcome.
 *
 *   IMPACT was somewhat too high. 3.0x overstates it; reported elite-tier pricing
 *   sits nearer 2.0x ("proven playmaker" receivers at $1M+ against $700K starters).
 *   True outliers reach 8-10x, but that is a long tail, not a tier.
 *
 * BUST stays negative and stays mine. The PDR sets it to zero; that understates a
 * miss, which costs the roster spot and the alternative use of the money on top of
 * producing nothing. No market source prices a bust, so -0.15 is reasoning, not data.
 */
export const TIER_MULTIPLIER: Record<OrderedOutcome, number> = {
  Bust: -0.15,
  // 0.55, and the sources genuinely disagree — this is the least settled number
  // in the file. ESPN's within-position backup band implies 0.58-0.65; Opendorse's
  // starter-vs-backup AAV bands (P4 backup $199-233K against a $620-783K non-QB
  // starter) imply 0.29-0.31; the PDR said 0.25. Shipping 0.65 put us at the top of
  // one range and double the other two.
  //
  // The sources are measuring different players. Opendorse's band spans every
  // backup on a 105-man roster including deep reserves, while THIS tier requires
  // >=10% of team snaps — a genuine rotation player, nearer ESPN's No.2. So the
  // higher figure is the right family, but 0.65 was its ceiling. 0.55 sits inside
  // ESPN's range without pretending the disagreement is resolved.
  'Depth / Rotation': 0.55,
  Starter: 1.0,
  'Impact Player': 2.0,
};

/**
 * Program-tier discount on the Power 4 average.
 *
 * The ESPN figures are a Power 4 mean skewed by the SEC and Big Ten. ESPN puts
 * ACC/Big 12 quarterbacks at $1-2M against $2-3M in the SEC/Big Ten — roughly a
 * 0.6x conference discount.
 *
 * Stanford is likely BELOW even the ACC average: it entered the conference on a 30%
 * partial television revenue share, rising to 70% only in year eight, so its capacity
 * is materially lower than conference peers. Default is set to the ACC figure rather
 * than something Stanford-specific because no public number exists for a private
 * school — this is the value most in need of replacement with a real internal budget.
 */
export const PROGRAM_TIER: Record<string, number> = {
  'sec-bigten': 1.0,
  acc: 0.6,
  big12: 0.6,
  // Stanford specifically, NOT the ACC average. ACC tax filings put Cal, Stanford
  // and SMU on reduced distributions averaging ~$19.9M against ~$47.1M for full
  // members, for their first nine years. Borrowing a scale from a full-share ACC
  // peer therefore overstates Stanford's revenue base by roughly 2x, in a known
  // direction. 0.6 x (19.9/47.1) ~= 0.25.
  stanford: 0.25,
  g5: 0.15,
};

export interface ValueConfig {
  /** Per-position starter-season dollars. Defaults to POSITION_STARTER_VALUE. */
  positionValue?: Partial<Record<PositionGroup, number>>;
  /** Tier multipliers. Defaults to TIER_MULTIPLIER. */
  tierMultiplier?: Partial<Record<OrderedOutcome, number>>;
  /** Program-tier discount on the Power 4 average. */
  programTier?: number;
}

export const DEFAULT_VALUE_CONFIG: ValueConfig = {
  programTier: PROGRAM_TIER['stanford'] ?? 0.25,
};

/** What one starter-season is worth at this position, after the program discount. */
export function starterSeasonValue(
  position: PositionGroup,
  config: ValueConfig = DEFAULT_VALUE_CONFIG,
): number {
  const base = config.positionValue?.[position] ?? POSITION_STARTER_VALUE[position];
  return base * (config.programTier ?? 1);
}

/** Dollar value of one season at a given outcome and position. */
export function seasonValue(
  outcome: OrderedOutcome,
  position: PositionGroup,
  config: ValueConfig = DEFAULT_VALUE_CONFIG,
): number {
  const multiplier = config.tierMultiplier?.[outcome] ?? TIER_MULTIPLIER[outcome];
  return starterSeasonValue(position, config) * multiplier;
}

/** The four tier values for a position, in outcome order. */
export function valueVector(
  position: PositionGroup,
  config: ValueConfig = DEFAULT_VALUE_CONFIG,
): number[] {
  return ORDERED_OUTCOMES.map((outcome) => seasonValue(outcome, position, config));
}

/**
 * Replacement-level value — what the next-best available player would produce.
 *
 * Set at the Depth/Rotation tier: missing on a recruit does not leave you with
 * nothing, it leaves you with a rotational player from the roster or the portal.
 * Comparing against this rather than against zero is what makes the tool answer
 * "is this player worth it" instead of "is this player good".
 */
export function replacementValue(
  position: PositionGroup,
  config: ValueConfig = DEFAULT_VALUE_CONFIG,
): number {
  return seasonValue('Depth / Rotation', position, config);
}

/**
 * WHAT IS NOT KNOWABLE, stated so the UI can say it.
 *
 * There is no public per-player compensation dataset, and the door is closing rather
 * than opening: FOIA requests to a dozen-plus schools produced aggregate totals from
 * two, and North Carolina, Wisconsin, Colorado and South Carolina have passed or
 * proposed statutes exempting athlete payments from public records. Stanford is
 * private and outside records law entirely. The College Sports Commission publishes
 * aggregates only. Every figure above traces to an anonymous practitioner survey,
 * an agent disclosure, or vendor aggregation — none is audited.
 *
 * Treat the dollar layer as carrying roughly +/-30% error, and note the market rose
 * about 10x between 2024 and 2026: outcomes are measured on 2015-2025 careers, but
 * priced at 2026 rates. That is correct for pricing a NEW offer and wrong for
 * valuing a past one.
 */
export const VALUE_PROVENANCE = {
  scaleSource: 'ESPN position survey, Aug 2026 (12+ GMs, 12+ agents), range midpoints',
  scaleConfidence: 'moderate — two independent methods converge; nothing audited',
  tierSource: 'ESPN within-position backup/starter/elite breakdown, Aug 2026',
  bustSource: 'not market-derived; reasoning about roster-spot opportunity cost',
  programTierSource: 'ESPN ACC/Big12 vs SEC/BigTen QB ranges; ~0.6x',
  errorBars: '+/-30%',
  notKnowable: 'per-player compensation; Stanford-specific allocation; a star-rating multiplier',
} as const;
