/**
 * Browser app: recruit profile in, outcome distribution and offer valuation out.
 *
 * Ships as a single self-contained HTML file. No dataset — the fitted ordinal model
 * is ~1.7 KB of coefficients and the comparable-player index is a 2.4 MB base64
 * column store, both inlined at build time.
 *
 * PALETTE NOTE: the four outcome tiers are an ORDERED magnitude (Bust < Depth <
 * Starter < Impact), so they use a single-hue sequential ramp light-to-dark rather
 * than four categorical hues. Values are taken from a validated reference ramp.
 * The two lightest steps fall below 3:1 against the surface, which obliges visible
 * direct labels and a table view — both present below.
 */

import { buildFeatures } from '../model/features.ts';
import { predictOrdinal, ORDERED_OUTCOMES, type OrdinalModel } from '../model/ordinal.ts';
import { expectedValue, monteCarlo, certainEquivalent, riskOddsFromPreference } from '../model/decision.ts';
import { retentionFor, type RetentionTable } from '../model/retention.ts';
import { valueVector, type ValueConfig } from '../model/value.ts';
import type { Era, PlayerSource, PositionGroup } from '../ingest/types.ts';

/** Sequential ramp, worst to best. Lightness is monotonic by construction. */
export const TIER_COLORS = ['#cde2fb', '#9ec5f4', '#2a78d6', '#184f95'];

declare const __BUNDLE__: {
  model: OrdinalModel;
  retention: RetentionTable;
  value: ValueConfig;
};
declare const __COHORT_B64__: string;

// ---------------------------------------------------------------------------
// Cohort column store
// ---------------------------------------------------------------------------

interface Cohort {
  count: number;
  positions: string[];
  sources: string[];
  teams: string[];
  stars: Uint8Array;
  rating: Uint16Array;
  ranking: Uint16Array;
  height: Uint8Array;
  weight: Uint16Array;
  position: Uint8Array;
  source: Uint8Array;
  recruitYear: Uint8Array;
  team: Uint16Array;
  outcomes: Uint8Array;
  names: string[];
  yearBase: number;
  scale: { rating: number; height: number };
}

function decodeCohort(base64: string): Cohort {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));

  let offset = 8 + headerLength;
  const columns: Record<string, ArrayBufferView> = {};
  const ctors: Record<string, any> = { Uint8Array, Uint16Array, Uint32Array };
  for (const entry of header.layout as { name: string; type: string; byteLength: number }[]) {
    const Ctor = ctors[entry.type] ?? Uint8Array;
    // Copy rather than view: the packed offsets are not guaranteed to satisfy
    // the alignment typed arrays require for a zero-copy view.
    const slice = bytes.slice(offset, offset + entry.byteLength);
    columns[entry.name] = new Ctor(slice.buffer, 0, entry.byteLength / Ctor.BYTES_PER_ELEMENT);
    offset += entry.byteLength;
  }

  // Names: one UTF-8 blob split on the single-space separator written by the encoder.
  const blob = new TextDecoder().decode(columns['nameBlob'] as Uint8Array);
  const names = blob.split(' ');

  return {
    count: header.count,
    positions: header.positions,
    sources: header.sources,
    teams: header.teams,
    stars: columns['stars'] as Uint8Array,
    rating: columns['rating'] as Uint16Array,
    ranking: columns['ranking'] as Uint16Array,
    height: columns['height'] as Uint8Array,
    weight: columns['weight'] as Uint16Array,
    position: columns['position'] as Uint8Array,
    source: columns['source'] as Uint8Array,
    recruitYear: columns['recruitYear'] as Uint8Array,
    team: columns['team'] as Uint16Array,
    outcomes: columns['outcomes'] as Uint8Array,
    names,
    yearBase: header.yearBase,
    scale: header.scale,
  };
}

// ---------------------------------------------------------------------------
// Comparable players (KNN) — display only, never the probability source
// ---------------------------------------------------------------------------

export interface Profile {
  stars: number | null;
  rating: number | null;
  ranking: number | null;
  height: number | null;
  weight: number | null;
  position: PositionGroup;
  source: PlayerSource;
  era: Era;
}

export interface Comp {
  name: string;
  team: string;
  recruitYear: number;
  stars: number;
  rating: number;
  outcomes: number[];
  distance: number;
}

/**
 * Nearest neighbours on the standardized profile, restricted to the same position
 * group and player source.
 *
 * Kept explicitly for DISPLAY. The PDR requires showing comparable players, and a
 * coach's trust comes from recognizing names — but the probabilities come from the
 * ordinal model, which is calibrated, handles censoring, and does not weight every
 * feature equally. Using KNN for both would reintroduce the problems the model swap
 * was meant to fix.
 */
export function findComps(cohort: Cohort, profile: Profile, k = 40): Comp[] {
  const positionCode = cohort.positions.indexOf(profile.position);
  const sourceCode = cohort.sources.indexOf(profile.source);
  // Rough spreads for standardizing distance; exact values matter little here
  // because this list is illustrative rather than inferential.
  const SD = { stars: 0.9, rating: 0.06, logRank: 1.4, height: 2.6, weight: 40 };
  const target = {
    stars: profile.stars ?? 3,
    rating: profile.rating ?? 0.84,
    logRank: Math.log1p(profile.ranking ?? 900),
    height: profile.height ?? 74,
    weight: profile.weight ?? 215,
  };

  const scored: Comp[] = [];
  for (let i = 0; i < cohort.count; i++) {
    if (cohort.position[i] !== positionCode) continue;
    if (cohort.source[i] !== sourceCode) continue;
    const stars = cohort.stars[i]!;
    const rating = cohort.rating[i]! / cohort.scale.rating;
    const ranking = cohort.ranking[i]!;
    const height = cohort.height[i]! / cohort.scale.height;
    const weight = cohort.weight[i]!;
    // Skip records with no profile at all — they cannot be meaningful comps.
    if (stars === 0 && rating === 0) continue;

    let d = 0;
    d += ((stars - target.stars) / SD.stars) ** 2;
    d += ((rating - target.rating) / SD.rating) ** 2;
    d += ((Math.log1p(ranking) - target.logRank) / SD.logRank) ** 2;
    d += ((height - target.height) / SD.height) ** 2;
    d += ((weight - target.weight) / SD.weight) ** 2;

    scored.push({
      name: cohort.names[i] ?? '',
      team: cohort.teams[cohort.team[i]!] ?? '',
      recruitYear: cohort.yearBase + cohort.recruitYear[i]!,
      stars,
      rating,
      outcomes: Array.from(cohort.outcomes.subarray(i * 5, i * 5 + 5)),
      distance: Math.sqrt(d),
    });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, k);
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export interface Evaluation {
  byYear: number[][];
  retention: number[];
  ev: ReturnType<typeof expectedValue>;
  mc: ReturnType<typeof monteCarlo>;
  certainEquivalent: number;
  riskDiscount: number;
  comps: Comp[];
}

export function evaluate(
  cohort: Cohort,
  bundle: typeof __BUNDLE__,
  profile: Profile,
  offer: number,
  preferenceProbability: number,
): Evaluation {
  const byYear: number[][] = [];
  for (let year = 1; year <= 5; year++) {
    byYear.push(
      predictOrdinal(
        bundle.model,
        buildFeatures({ ...profile, eligibilityYear: year }),
      ),
    );
  }
  const retention = retentionFor(bundle.retention, profile.position, profile.era);
  const inputs = {
    byYear,
    position: profile.position,
    totalCompensation: offer,
    retention,
    valueConfig: bundle.value,
  };
  const ev = expectedValue(inputs);
  const mc = monteCarlo(inputs);

  // Certain equivalent over the simulated career totals, using the elicited
  // risk odds. X is anchored to the offer so the elicitation question is asked at
  // a magnitude the decision actually involves.
  const curve = { r: riskOddsFromPreference(preferenceProbability), X: Math.max(1, offer) };
  // Over the RAW simulated totals, equally weighted — not the binned histogram.
  // Binning cost ~10% accuracy and left the certain equivalent disagreeing with
  // expected value even at risk neutrality.
  const totals = Array.from(mc.totals);
  const uniform = new Array<number>(totals.length).fill(1 / totals.length);
  const ce = certainEquivalent(totals, uniform, curve);

  return {
    byYear,
    retention,
    ev,
    mc,
    certainEquivalent: ce,
    riskDiscount: mc.mean - ce,
    comps: findComps(cohort, profile),
  };
}

export { decodeCohort, ORDERED_OUTCOMES, valueVector };
export type { Cohort };
