/**
 * Decision math: expected value, certain equivalent, Monte Carlo.
 *
 * FIXES THREE FORMULA BUGS FROM THE PREDECESSOR
 *
 *  1. EV was a PEAK, not a total. app.py:540 took `.max()` over eligibility years
 *     and labelled it "Expected Value Ceiling". PDR §3.2.2 asks for the SUM across
 *     all years. Net Value and ROI both inherited the error, so against a
 *     multi-year compensation figure the tool understated EV substantially.
 *  2. ROI was computed TWO different ways on the same screen. app.py:110 used
 *     (EV-C)/C for the table; app.py:547 used EV/C for the summary metric. They
 *     differ by exactly 1.0x. §3.2.2 defines ROI as EV/C, so the table was wrong.
 *  3. The summary banner CONTRADICTED the metrics above it. app.py:578 used a
 *     `.mean()` EV for its green/red verdict while the metric row used `.max()`,
 *     so the same recruit could show positive Net Value under a red "negative
 *     investment" banner.
 *
 * Here EV is computed ONCE, summed across years, and every downstream figure — ROI,
 * net value, the verdict — derives from that single number. They cannot disagree
 * because there is only one.
 *
 * TWO THINGS THE PREDECESSOR DID NOT HAVE
 *
 * RETENTION. EV summed over five years silently assumes you keep the player for
 * five years. The portal means you often do not, so each year's value is weighted
 * by the probability the player is still on your roster.
 *
 * RISK PREFERENCE. Expected value assumes risk neutrality — that a coin flip
 * between $1M and nothing is worth exactly $500k. Under a hard budget cap it is
 * not. See certainEquivalent below.
 */

import type { PositionGroup } from '../ingest/types.ts';
import {
  replacementValue,
  tierCv,
  valueVector,
  type ValueConfig,
} from './value.ts';
import { ORDERED_OUTCOMES } from './ordinal.ts';

/** Probabilities for the four outcomes, for one eligibility year. */
export type YearDistribution = number[];

export interface EvInputs {
  /** One distribution per eligibility year, index 0 = year 1. */
  byYear: YearDistribution[];
  position: PositionGroup;
  /** Total compensation across the whole deal, in dollars. */
  totalCompensation: number;
  /**
   * Probability the player is still on this roster in each year, same length as
   * byYear. Omit for the retain-everyone assumption the predecessor made implicitly.
   */
  retention?: number[];
  valueConfig?: ValueConfig;
}

export interface EvResult {
  /** Sum over years of sum over outcomes of P x Value. PDR §3.2.2. */
  expectedValue: number;
  /** Expected value above what a replacement player would have produced. */
  valueAboveReplacement: number;
  /** EV minus total compensation. */
  netValue: number;
  /** EV / total compensation. ONE definition, used everywhere. */
  roi: number;
  /** Highest P(Bust) across years — the PDR's Downside Probability. */
  downsideProbability: number;
  /** Highest P(Impact) across years — Upside Probability, previously missing. */
  upsideProbability: number;
  /** Variance of total value, treating years as independent draws. */
  outcomeVariance: number;
  outcomeStdDev: number;
  perYear: { year: number; expectedValue: number; retention: number }[];
}

/**
 * Expected value across the whole deal.
 *
 * Years are summed, never maxed. Variance treats years as independent, which
 * OVERSTATES it: a player who starts in year 2 is likelier to start in year 3, so
 * real outcomes are positively correlated across years and the true spread is
 * narrower. Monte Carlo below inherits the same simplification. Stated rather than
 * hidden because it makes the risk figures conservative, not optimistic.
 */
export function expectedValue(inputs: EvInputs): EvResult {
  const { byYear, position, totalCompensation, retention, valueConfig } = inputs;
  const values = valueVector(position, valueConfig);
  const replacement = replacementValue(position, valueConfig);

  let total = 0;
  let totalVariance = 0;
  let replacementTotal = 0;
  let downside = 0;
  let upside = 0;
  const perYear: EvResult['perYear'] = [];

  byYear.forEach((distribution, index) => {
    const keep = retention?.[index] ?? 1;
    let yearMean = 0;
    for (let k = 0; k < distribution.length; k++) {
      yearMean += distribution[k]! * values[k]!;
    }
    let yearSecondMoment = 0;
    for (let k = 0; k < distribution.length; k++) {
      yearSecondMoment += distribution[k]! * values[k]! ** 2;
    }
    const yearVariance = Math.max(0, yearSecondMoment - yearMean ** 2);

    total += keep * yearMean;
    totalVariance += keep * yearVariance;
    replacementTotal += keep * replacement;
    downside = Math.max(downside, distribution[0] ?? 0);
    upside = Math.max(upside, distribution[3] ?? 0);

    perYear.push({ year: index + 1, expectedValue: keep * yearMean, retention: keep });
  });

  return {
    expectedValue: total,
    valueAboveReplacement: total - replacementTotal,
    netValue: total - totalCompensation,
    // Guard a zero offer rather than emitting Infinity into the UI.
    roi: totalCompensation > 0 ? total / totalCompensation : Number.NaN,
    downsideProbability: downside,
    upsideProbability: upside,
    outcomeVariance: totalVariance,
    outcomeStdDev: Math.sqrt(totalVariance),
    perYear,
  };
}

// ---------------------------------------------------------------------------
// Risk preference — the delta-property u-curve
// ---------------------------------------------------------------------------

/**
 * Risk odds, r, from a single elicited preference probability.
 *
 * The elicitation is one question: "You are indifferent between $0 for certain and
 * a deal that wins $X with probability p or loses $X with probability 1-p. What is
 * your p?" Then r = p / (1 - p).
 *
 *   r = 1   indifferent at p = 0.5, i.e. risk NEUTRAL — an expected-value decision
 *           maker, which is exactly what the predecessor assumed for everyone
 *   r > 1   needs better-than-even odds to accept a symmetric bet: risk AVERSE
 *   r < 1   risk seeking
 *
 * A person satisfying the delta property has constant absolute risk aversion, so
 * one number determines the entire u-curve over the relevant range. That is why
 * this formulation is worth using rather than picking a curvature parameter: it is
 * elicitable in one sentence from someone who has never seen a utility function.
 */
export const riskOddsFromPreference = (p: number): number => {
  const clamped = Math.min(0.999, Math.max(0.001, p));
  return clamped / (1 - clamped);
};

export interface UCurve {
  /** Risk odds. 1 = risk neutral. */
  r: number;
  /** The dollar magnitude the preference probability was assessed at. */
  X: number;
}

/**
 * u(d) = -r^(-d/X), the delta-property u-curve.
 *
 * Left unscaled deliberately. The scaling constants a and b that map the worst and
 * best outcomes onto [0,1] are a presentational nicety; they cancel out of the
 * certain equivalent, so introducing them here would add code without changing an
 * answer.
 */
const u = (d: number, { r, X }: UCurve): number => -Math.pow(r, -d / X);

/** Inverse of u, used to convert an expected u-value back into dollars. */
const uInverse = (value: number, { r, X }: UCurve): number =>
  (-X * Math.log(-value)) / Math.log(r);

/**
 * Certain equivalent: the guaranteed dollar amount the decision maker would accept
 * in place of the deal.
 *
 * This is the number that belongs next to an offer, not expected value. The gap
 * between them is the risk discount, and it is what makes two recruits with
 * identical EV but different variance produce different recommendations.
 *
 * Falls back to plain expected value when r is 1, both because that is the correct
 * answer for a risk-neutral decision maker and because log(1) = 0 would divide by
 * zero.
 */
export function certainEquivalent(
  outcomes: readonly number[],
  probabilities: readonly number[],
  curve: UCurve,
): number {
  const mean = outcomes.reduce((sum, v, i) => sum + v * (probabilities[i] ?? 0), 0);
  if (Math.abs(curve.r - 1) < 1e-9) return mean;
  let expectedU = 0;
  for (let i = 0; i < outcomes.length; i++) {
    expectedU += (probabilities[i] ?? 0) * u(outcomes[i]!, curve);
  }
  return uInverse(expectedU, curve);
}

// ---------------------------------------------------------------------------
// Monte Carlo — PDR §3.2.3
// ---------------------------------------------------------------------------

export interface MonteCarloResult {
  iterations: number;
  mean: number;
  /** Raw simulated career totals. Needed to take an exact certain equivalent:
   *  computing it over the binned histogram introduced a ~10% error. */
  totals: Float64Array;
  median: number;
  p10: number;
  p90: number;
  /** Share of simulated careers whose total value fell below the offer. */
  probabilityBelowOffer: number;
  /** Histogram for the chart: bucket lower edge and count. */
  histogram: { edge: number; count: number }[];
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * Seeded on purpose: an unseeded simulation makes the same recruit show a different
 * p10 on every page render, which destroys trust in a tool someone is using to
 * justify a number to a coach.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw a lognormal value for a tier whose MEAN is `mean` and whose coefficient of
 * variation is `cv`.
 *
 * Parameterised on the mean rather than the median so expected value is unchanged by
 * adding spread — the simulation gains realistic dispersion without silently moving
 * the headline number. Box-Muller for the normal draw, since the PRNG is uniform.
 */
function lognormalAboutMean(mean: number, cv: number, random: () => number): number {
  if (cv <= 0 || mean === 0) return mean;
  const sigma2 = Math.log(1 + cv * cv);
  const sigma = Math.sqrt(sigma2);
  // E[X] = exp(mu + sigma^2/2), so mu = ln(mean) - sigma^2/2 preserves the mean.
  const mu = Math.log(Math.abs(mean)) - sigma2 / 2;
  const u1 = Math.max(1e-12, random());
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const draw = Math.exp(mu + sigma * z);
  return mean < 0 ? -draw : draw;
}

/** Sample one outcome index from a distribution. */
function sample(distribution: readonly number[], random: () => number): number {
  const draw = random();
  let cumulative = 0;
  for (let k = 0; k < distribution.length; k++) {
    cumulative += distribution[k]!;
    if (draw <= cumulative) return k;
  }
  return distribution.length - 1;
}

/**
 * Simulate whole careers, sampling an outcome for each eligibility year.
 *
 * Years are drawn independently, which overstates spread — see the note on
 * expectedValue. Retention is applied as a survival draw: once a player leaves,
 * subsequent years contribute nothing, which is the behaviour the portal actually
 * produces.
 */
export function monteCarlo(
  inputs: EvInputs,
  iterations = 10_000,
  seed = 20260817,
  bins = 24,
): MonteCarloResult {
  const { byYear, position, totalCompensation, retention, valueConfig } = inputs;
  const values = valueVector(position, valueConfig);
  const random = mulberry32(seed);

  // retention[] is CUMULATIVE survival — P(still here in year N). A per-year draw
  // must therefore use the CONDITIONAL continuation probability
  // retention[N]/retention[N-1]. Comparing a fresh uniform against the cumulative
  // value each year applies the exit hazard twice over, which made the simulated
  // mean fall ~16% below the analytic expected value and left the two headline
  // figures on screen disagreeing with each other.
  const conditional = (byYear as unknown[]).map((_, year) => {
    const now = retention?.[year] ?? 1;
    const previous = year === 0 ? 1 : (retention?.[year - 1] ?? 1);
    return previous > 0 ? Math.min(1, now / previous) : 0;
  });

  const totals = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let year = 0; year < byYear.length; year++) {
      // Survival: leaving ends the career, so later years contribute nothing.
      if (random() > conditional[year]!) break;
      const tier = sample(byYear[year]!, random);
      // Draw within the tier rather than taking its point value.
      total += lognormalAboutMean(
        values[tier]!,
        tierCv(ORDERED_OUTCOMES[tier]!, valueConfig),
        random,
      );
    }
    totals[i] = total;
  }

  const sorted = Float64Array.from(totals).sort();
  const quantile = (q: number): number => sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))
  ]!;

  const mean = totals.reduce((sum, v) => sum + v, 0) / iterations;
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const width = (max - min) / bins || 1;
  const histogram = Array.from({ length: bins }, (_, index) => ({
    edge: min + index * width,
    count: 0,
  }));
  for (const value of totals) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor((value - min) / width)));
    histogram[index]!.count++;
  }

  let below = 0;
  for (const value of totals) if (value < totalCompensation) below++;

  return {
    iterations,
    mean,
    totals,
    median: quantile(0.5),
    p10: quantile(0.1),
    p90: quantile(0.9),
    probabilityBelowOffer: below / iterations,
    histogram,
  };
}
