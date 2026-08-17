/**
 * Feature construction, shared by training and prediction.
 *
 * Must be identical in both places or the model silently predicts nonsense, so it
 * lives here rather than being written twice.
 *
 * Design notes on specific features:
 *
 *  - `stars` is included but is the weakest signal (draft AUC 0.744 vs ranking's
 *    0.800). It is kept because recruiters think in stars and because it carries
 *    information when rating is missing.
 *  - `ranking` enters as log(1 + rank). The difference between the #1 and #50
 *    recruit matters enormously; between #800 and #850 it is noise. Log spacing
 *    reflects that; raw rank does not.
 *  - Missingness is explicit. `stars` is 89.5% populated, `rating` 86.4%,
 *    `ranking` 80.4%. Mean-imputing without an indicator would make "unrated"
 *    look like "average", and unrated recruits are NOT average — they are 69.6%
 *    ever-rostered against a 3-star's 77.4%, so missingness is itself a signal.
 *  - `eligibilityYear` is one-hot, not linear. The Starter rate runs 5.7 / 7.9 /
 *    10.3 / 11.1 / 9.0 across years 1-5 — it rises then falls, so a linear term
 *    would fit the wrong shape.
 *  - `era` is one-hot for the same reason regimes were flagged at ingest: the 2021
 *    portal/NIL break and 2025 revenue sharing are structural, not a trend.
 */

import type { PositionGroup, PlayerSource, Era } from '../ingest/types.ts';

export const POSITION_ORDER: PositionGroup[] = [
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

export const ERA_ORDER: Era[] = ['pre-portal', 'portal-nil', 'rev-share'];

export interface FeatureInput {
  stars: number | null;
  rating: number | null;
  ranking: number | null;
  height: number | null;
  weight: number | null;
  position: PositionGroup;
  source: PlayerSource;
  era: Era;
  eligibilityYear: number;
}

/**
 * Reference values used when a field is missing. Paired with an indicator so the
 * model can learn what missingness means instead of assuming it means average.
 */
const IMPUTE = { stars: 3, rating: 0.84, ranking: 900, height: 74, weight: 215 };

/** Build the feature name list once; order must match buildFeatures exactly. */
export function featureNames(): string[] {
  const names = [
    'stars',
    'rating',
    'logRanking',
    'height',
    'weight',
    'starsMissing',
    'ratingMissing',
    'rankingMissing',
    'sourcePortal',
  ];
  // Drop the first level of each categorical to avoid collinearity with the
  // cutpoints, which already carry the intercept.
  for (const position of POSITION_ORDER.slice(1)) names.push(`pos_${position}`);
  for (const era of ERA_ORDER.slice(1)) names.push(`era_${era}`);
  for (let year = 2; year <= 5; year++) names.push(`year_${year}`);
  return names;
}

export function buildFeatures(input: FeatureInput): number[] {
  const stars = input.stars ?? IMPUTE.stars;
  const rating = input.rating ?? IMPUTE.rating;
  const ranking = input.ranking ?? IMPUTE.ranking;
  const height = input.height ?? IMPUTE.height;
  const weight = input.weight ?? IMPUTE.weight;

  const row: number[] = [
    stars,
    rating,
    Math.log1p(ranking),
    height,
    weight,
    input.stars == null ? 1 : 0,
    input.rating == null ? 1 : 0,
    input.ranking == null ? 1 : 0,
    input.source === 'Portal' ? 1 : 0,
  ];
  for (const position of POSITION_ORDER.slice(1)) {
    row.push(input.position === position ? 1 : 0);
  }
  for (const era of ERA_ORDER.slice(1)) row.push(input.era === era ? 1 : 0);
  for (let year = 2; year <= 5; year++) row.push(input.eligibilityYear === year ? 1 : 0);
  return row;
}
