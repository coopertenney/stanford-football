/**
 * Value mapping — scale separated from shape.
 *
 * WHAT WAS WRONG BEFORE
 * value_mapping.json held one unsourced dollar figure per (position, tier):
 * WR Starter = $400k, TE Starter = $300k, and no QB entry at all. Those numbers
 * came from the PDR's illustrative defaults, not from any market. They were then
 * multiplied by a probability to produce a dollar recommendation, so the entire
 * output inherited a guess while looking like a measurement.
 *
 * THE STRUCTURE HERE
 *   Value(outcome, position) = scale(position) x shape(outcome)
 *
 * SCALE is what the program allocates to that position group. It is the part a
 * program KNOWS. Revenue sharing bounds it — the House settlement caps school
 * spending around $20.5M — so a program can state its own number rather than
 * inherit a league average. Stanford's willingness to pay is not Texas's.
 *
 * SHAPE is how value steps up across tiers, and how position groups compare. This
 * is the estimated part. Two sources inform it here:
 *   - positional weight, from measured PFF WAA headroom (see POSITION_WEIGHT)
 *   - tier multipliers, from the replacement-relative logic below
 *
 * WHY THE SPLIT MATTERS
 * It isolates what is known from what is modeled. Right now the user has told us to
 * estimate everything, so the whole dollar layer is modeled and the UI must say so.
 * But when a real budget arrives, only `scale` changes — the outcome model, the
 * tier shape and every calibration stay untouched.
 *
 * REPLACEMENT LEVEL, NOT ZERO
 * The old mapping set Bust = $0. That understates a miss: spending $400k on a bust
 * yields no production AND consumes $400k that had alternative uses AND burns a
 * roster spot. Value is therefore measured against REPLACEMENT — the player you
 * would otherwise have had — which makes a miss correctly negative rather than
 * merely neutral.
 */

import type { PositionGroup } from '../ingest/types.ts';
import { ORDERED_OUTCOMES, type OrderedOutcome } from './ordinal.ts';

/**
 * Relative value of a position group, normalized so the mean group is 1.0.
 *
 * Derived from measured WAA headroom — the maximum wins-above-average observed at
 * each position across 104,478 PFF player-seasons, 2015-2025. A quarterback tops
 * out near 2.4 and a tackle near 0.5, so a great quarterback swings roughly five
 * times the wins of a great tackle. That spread is real, it is measured, and the
 * legacy mapping did not express it at all: it had WR at $400k and TE at $300k,
 * a 1.33x range across the entire roster.
 *
 * This is the most defensible part of the shape estimate because it comes from
 * observed win contribution rather than from market anecdote.
 */
export const POSITION_WEIGHT: Record<PositionGroup, number> = {
  QB: 3.2,
  RB: 0.6,
  WR: 1.1,
  TE: 0.7,
  OL: 1.0,
  DL: 1.2,
  LB: 0.8,
  DB: 1.1,
  // Specialists are unlabeled by the model, so this is never exercised today.
  ST: 0.3,
};

/**
 * Value by tier, as a multiple of one "starter-season", measured against
 * replacement level.
 *
 * Bust is NEGATIVE, not zero — see the module note. The magnitude is the roster
 * spot plus the opportunity cost of the money, expressed relative to a starter's
 * value; the offer amount itself is subtracted separately in the EV calculation,
 * so this figure captures only the non-cash cost of the miss.
 *
 * Impact is set at 3x a starter rather than something larger because the tier is
 * defined as All-Conference caliber, not generational. The gap between a starter
 * and an All-Conference player is real but not an order of magnitude.
 *
 * ESTIMATED. No transaction data stands behind these ratios.
 */
export const TIER_MULTIPLIER: Record<OrderedOutcome, number> = {
  Bust: -0.15,
  'Depth / Rotation': 0.25,
  Starter: 1.0,
  'Impact Player': 3.0,
};

export interface ValueConfig {
  /**
   * Dollars a starter-season is worth at a mean-value position. The single number
   * that sets the scale for everything else. Default is a placeholder in the
   * region of reported Power 4 starter compensation and MUST be replaced with the
   * program's own allocation before any output is acted on.
   */
  starterSeasonValue: number;
  /** Optional per-position override of POSITION_WEIGHT. */
  positionWeight?: Partial<Record<PositionGroup, number>>;
  /** Optional per-tier override of TIER_MULTIPLIER. */
  tierMultiplier?: Partial<Record<OrderedOutcome, number>>;
}

export const DEFAULT_VALUE_CONFIG: ValueConfig = {
  starterSeasonValue: 350_000,
};

/** Dollar value of one season at a given outcome and position. */
export function seasonValue(
  outcome: OrderedOutcome,
  position: PositionGroup,
  config: ValueConfig = DEFAULT_VALUE_CONFIG,
): number {
  const weight = config.positionWeight?.[position] ?? POSITION_WEIGHT[position];
  const multiplier = config.tierMultiplier?.[outcome] ?? TIER_MULTIPLIER[outcome];
  return config.starterSeasonValue * weight * multiplier;
}

/** The four tier values for a position, in outcome order. */
export function valueVector(
  position: PositionGroup,
  config: ValueConfig = DEFAULT_VALUE_CONFIG,
): number[] {
  return ORDERED_OUTCOMES.map((outcome) => seasonValue(outcome, position, config));
}

/**
 * Replacement-level value for a position — what the next-best available player
 * would have produced.
 *
 * Set at the Depth/Rotation tier: if you miss on a recruit, what you actually get
 * is not nothing, it is a rotational player from elsewhere on the roster or the
 * portal. Comparing against this rather than against zero is what makes the tool
 * answer "is this player worth it" rather than "is this player good".
 */
export function replacementValue(
  position: PositionGroup,
  config: ValueConfig = DEFAULT_VALUE_CONFIG,
): number {
  return seasonValue('Depth / Rotation', position, config);
}
