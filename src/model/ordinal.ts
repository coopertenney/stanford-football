/**
 * Proportional-odds ordinal regression.
 *
 * WHY NOT KNN
 * The predecessor used KNN over standardized features with equal weights. Three
 * problems, all measured on this data:
 *
 *   1. It treats `stars` as the primary signal, but stars is the WEAKEST of the
 *      profile features. Predicting NFL draft: ranking AUC 0.800, rating 0.788,
 *      stars 0.744. Within the 3-star band alone — 20,623 players, where nearly
 *      every real decision happens — rating quartiles run 1.75% to 5.80% draft
 *      rate. Stars discards that entirely.
 *   2. Equal feature weights are wrong and the amount varies by position: weight
 *      predicts draft at 0.772 for linebackers and 0.513 for specialists.
 *   3. It cannot express right-censoring. A 2024 recruit has two observed seasons;
 *      KNN averages over whatever rows its neighbours happen to have and silently
 *      biases toward early-career outcomes.
 *
 * WHY ORDINAL AND NOT MULTINOMIAL
 * Bust < Depth < Starter < Impact is a genuine ordering. A proportional-odds model
 * uses it: one coefficient vector plus three cutpoints, rather than three
 * independent coefficient vectors. Fewer parameters, and it cannot produce the
 * incoherent result multinomial can where P(Starter) > P(Depth) > P(Starter).
 *
 * WHY IT MATTERS THAT THIS IS CALIBRATED
 * The output gets multiplied by a dollar figure. A model that ranks correctly but
 * is miscalibrated produces confident, wrong offers. Maximum likelihood on the
 * observed frequencies is calibrated by construction; KNN with an arbitrary K is
 * not. That is the whole reason for the swap.
 *
 * SHIPPING
 * Fitting happens offline. The browser receives only coefficients — a few hundred
 * numbers — instead of the dataset. That is also what makes the artifact small.
 */

/** The four reported outcomes, in order. Censored states never reach the model. */
export const ORDERED_OUTCOMES = [
  'Bust',
  'Depth / Rotation',
  'Starter',
  'Impact Player',
] as const;

export type OrderedOutcome = (typeof ORDERED_OUTCOMES)[number];

export interface FitOptions {
  /** L2 penalty. Small but nonzero: thin position/era cells overfit without it. */
  lambda?: number;
  iterations?: number;
  learningRate?: number;
}

export interface OrdinalModel {
  /** Feature coefficients, aligned to featureNames. */
  beta: number[];
  /**
   * Cutpoints, K-1 of them for K outcomes, strictly increasing.
   * Stored as the first cutpoint plus positive gaps so monotonicity cannot break.
   */
  cutpoints: number[];
  featureNames: string[];
  /** Standardization applied to each feature at fit time; must be reapplied. */
  center: number[];
  scale: number[];
  logLikelihood: number;
  n: number;
}

const sigmoid = (z: number): number =>
  z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

/** Guard against log(0) without distorting the gradient meaningfully. */
const EPS = 1e-12;

/**
 * P(Y <= k) = sigmoid(cutpoint_k - x·beta).
 *
 * Note the MINUS: larger x·beta shifts mass toward the HIGHER outcomes, so a
 * positive coefficient means "better career", which is the readable direction.
 */
function cumulative(eta: number, cutpoints: readonly number[]): number[] {
  return cutpoints.map((c) => sigmoid(c - eta));
}

/** Convert cumulative probabilities into per-category probabilities. */
export function categoryProbabilities(cum: readonly number[]): number[] {
  const probabilities: number[] = [];
  let previous = 0;
  for (const c of cum) {
    probabilities.push(Math.max(EPS, c - previous));
    previous = c;
  }
  probabilities.push(Math.max(EPS, 1 - previous));
  // Renormalize: the clamping above can leave the sum slightly off 1.
  const total = probabilities.reduce((a, b) => a + b, 0);
  return probabilities.map((p) => p / total);
}

/**
 * Fit by gradient ascent on the penalized log-likelihood.
 *
 * Cutpoints are parameterized as (first, log-gaps) so the optimizer cannot invert
 * their order — an unconstrained parameterization can produce cutpoints that cross,
 * which yields negative category probabilities and is a classic way for an ordinal
 * fit to fail silently.
 */
export function fitOrdinal(
  X: readonly number[][],
  y: readonly number[],
  featureNames: string[],
  options: FitOptions = {},
): OrdinalModel {
  const { lambda = 1e-3, iterations = 400, learningRate = 0.5 } = options;
  const n = X.length;
  const p = featureNames.length;
  const K = ORDERED_OUTCOMES.length;

  // --- standardize ---------------------------------------------------------
  const center = new Array<number>(p).fill(0);
  const scale = new Array<number>(p).fill(1);
  for (let j = 0; j < p; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += X[i]![j]!;
    center[j] = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (X[i]![j]! - center[j]!) ** 2;
    const sd = Math.sqrt(variance / Math.max(1, n - 1));
    // A constant column would divide by zero; leave it at scale 1 so its
    // coefficient simply absorbs into the cutpoints.
    scale[j] = sd > 1e-9 ? sd : 1;
  }
  const Z = X.map((row) => row.map((v, j) => (v - center[j]!) / scale[j]!));

  // --- initialize ----------------------------------------------------------
  const beta = new Array<number>(p).fill(0);
  // Cutpoints from the marginal outcome frequencies: a good start that keeps the
  // first iterations from thrashing.
  const counts = new Array<number>(K).fill(0);
  for (const label of y) counts[label] = (counts[label] ?? 0) + 1;
  let cumulativeShare = 0;
  const initial: number[] = [];
  for (let k = 0; k < K - 1; k++) {
    cumulativeShare += (counts[k] ?? 0) / n;
    const clamped = Math.min(0.999, Math.max(0.001, cumulativeShare));
    initial.push(Math.log(clamped / (1 - clamped)));
  }
  let first = initial[0]!;
  const logGaps = initial
    .slice(1)
    .map((c, i) => Math.log(Math.max(1e-3, c - initial[i]!)));

  const buildCutpoints = (): number[] => {
    const out = [first];
    for (const g of logGaps) out.push(out[out.length - 1]! + Math.exp(g));
    return out;
  };

  let logLikelihood = -Infinity;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const cutpoints = buildCutpoints();
    const gradBeta = new Array<number>(p).fill(0);
    let gradFirst = 0;
    const gradLogGaps = new Array<number>(logGaps.length).fill(0);
    let ll = 0;

    for (let i = 0; i < n; i++) {
      const row = Z[i]!;
      let eta = 0;
      for (let j = 0; j < p; j++) eta += beta[j]! * row[j]!;

      const cum = cumulative(eta, cutpoints);
      const probabilities = categoryProbabilities(cum);
      const label = y[i]!;
      const probability = probabilities[label]!;
      ll += Math.log(probability);

      // d log P(y=k) / d eta for the cumulative-logit form. P(y=k) =
      // F(c_k - eta) - F(c_{k-1} - eta), and F' = F(1-F).
      const upper = label < K - 1 ? cum[label]! : 1;
      const lower = label > 0 ? cum[label - 1]! : 0;
      const dUpper = label < K - 1 ? upper * (1 - upper) : 0;
      const dLower = label > 0 ? lower * (1 - lower) : 0;
      const dEta = (dLower - dUpper) / probability;

      for (let j = 0; j < p; j++) gradBeta[j]! += dEta * row[j]!;

      // Cutpoint gradients, then chain through the (first, log-gap) mapping.
      const dCut = new Array<number>(K - 1).fill(0);
      if (label < K - 1) dCut[label]! += dUpper / probability;
      if (label > 0) dCut[label - 1]! -= dLower / probability;
      for (let k = 0; k < K - 1; k++) {
        gradFirst += dCut[k]!;
        // cutpoint_k depends on gap_g for every g < k.
        for (let g = 0; g < k; g++) gradLogGaps[g]! += dCut[k]! * Math.exp(logGaps[g]!);
      }
    }

    // L2 on beta only. Penalizing cutpoints would bias the base rates, which are
    // exactly the thing that must stay calibrated.
    for (let j = 0; j < p; j++) {
      ll -= lambda * beta[j]! ** 2;
      gradBeta[j]! -= 2 * lambda * beta[j]!;
    }

    const step = learningRate / n;
    for (let j = 0; j < p; j++) beta[j]! += step * gradBeta[j]!;
    first += step * gradFirst;
    for (let g = 0; g < logGaps.length; g++) logGaps[g]! += step * gradLogGaps[g]!;

    logLikelihood = ll;
  }

  return {
    beta,
    cutpoints: buildCutpoints(),
    featureNames,
    center,
    scale,
    logLikelihood,
    n,
  };
}

/** Predict the four outcome probabilities for one raw (unstandardized) row. */
export function predictOrdinal(
  model: OrdinalModel,
  features: readonly number[],
): number[] {
  let eta = 0;
  for (let j = 0; j < model.beta.length; j++) {
    eta += model.beta[j]! * ((features[j]! - model.center[j]!) / model.scale[j]!);
  }
  return categoryProbabilities(cumulative(eta, model.cutpoints));
}

/**
 * Expected calibration error over `bins` equal-width probability bins.
 *
 * Reported per outcome. This is the number that matters more than accuracy: if the
 * model says 30% Starter, roughly 30% of those players should have become
 * starters, because that probability gets multiplied by a dollar figure.
 */
export function calibrationError(
  predicted: readonly number[][],
  actual: readonly number[],
  outcomeIndex: number,
  bins = 10,
): { ece: number; table: { bin: string; predicted: number; observed: number; n: number }[] } {
  const buckets = Array.from({ length: bins }, () => ({ p: 0, o: 0, n: 0 }));
  for (let i = 0; i < predicted.length; i++) {
    const probability = predicted[i]![outcomeIndex]!;
    const index = Math.min(bins - 1, Math.floor(probability * bins));
    const bucket = buckets[index]!;
    bucket.p += probability;
    bucket.o += actual[i] === outcomeIndex ? 1 : 0;
    bucket.n += 1;
  }
  let ece = 0;
  const table = buckets.map((bucket, index) => {
    const meanPredicted = bucket.n ? bucket.p / bucket.n : 0;
    const observed = bucket.n ? bucket.o / bucket.n : 0;
    ece += (bucket.n / predicted.length) * Math.abs(meanPredicted - observed);
    return {
      bin: `${(index / bins).toFixed(1)}-${((index + 1) / bins).toFixed(1)}`,
      predicted: meanPredicted,
      observed,
      n: bucket.n,
    };
  });
  return { ece, table };
}

/** Rank-based AUC with tie handling, for the beat-the-baseline check. */
export function auc(scores: readonly number[], labels: readonly boolean[]): number {
  const pairs = scores
    .map((s, i) => ({ s, y: labels[i]! }))
    .sort((a, b) => a.s - b.s);
  const positives = pairs.filter((p) => p.y).length;
  const negatives = pairs.length - positives;
  if (positives === 0 || negatives === 0) return Number.NaN;
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j < pairs.length && pairs[j]!.s === pairs[i]!.s) j++;
    const averageRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (pairs[k]!.y) rankSum += averageRank;
    i = j;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}
