/**
 * Fit the ordinal model and validate it honestly.
 *
 *   npm run train
 *
 * Three checks, and the model should not ship if any of them fails:
 *
 *   1. OUT-OF-TIME split. Train on recruit classes <= 2021, test on 2022-2023.
 *      A random split would leak: the same player appears in up to five rows, so
 *      random assignment puts a player's year-2 season in train and year-3 in test.
 *   2. CALIBRATION. If the model says 30% Starter, ~30% should be starters. This
 *      matters more than accuracy because the probability gets multiplied by a
 *      dollar figure.
 *   3. BEAT THE BASELINE. Composite rating alone already gets AUC ~0.79 for draft.
 *      If the full model barely improves on rating alone, the sophistication is
 *      decorative and should be reported as such rather than dressed up.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { buildFeatures, featureNames } from './features.ts';
import {
  auc,
  calibrationError,
  fitOrdinal,
  ORDERED_OUTCOMES,
  predictOrdinal,
  type OrderedOutcome,
} from './ordinal.ts';
import type { Era, PlayerSource, PositionGroup } from '../ingest/types.ts';

const IN_FILE = 'data/labeled_seasons.json';
const OUT_FILE = 'data/model.json';

/** Classes up to this year train; later classes test. */
const TRAIN_THROUGH = 2021;
const TEST_FROM = 2022;
const TEST_THROUGH = 2023;

interface Row {
  outcome: string;
  stars: number | null;
  rating: number | null;
  ranking: number | null;
  height: number | null;
  weight: number | null;
  position: PositionGroup;
  source: PlayerSource;
  era: Era;
  eligibilityYear: number;
  recruitYear: number;
}

const outcomeIndex = (outcome: string): number =>
  ORDERED_OUTCOMES.indexOf(outcome as OrderedOutcome);

async function main(): Promise<void> {
  const all: Row[] = JSON.parse(await readFile(IN_FILE, 'utf8'));
  // Censored states are not outcomes and must not train the model.
  const usable = all.filter((r) => outcomeIndex(r.outcome) >= 0);
  console.log(`${all.length} rows, ${usable.length} with a reported outcome`);

  const names = featureNames();
  const toX = (r: Row): number[] => buildFeatures(r);

  const train = usable.filter((r) => r.recruitYear <= TRAIN_THROUGH);
  const test = usable.filter(
    (r) => r.recruitYear >= TEST_FROM && r.recruitYear <= TEST_THROUGH,
  );
  console.log(
    `out-of-time split: train classes <=${TRAIN_THROUGH} (${train.length}), test ${TEST_FROM}-${TEST_THROUGH} (${test.length})`,
  );

  const Xtrain = train.map(toX);
  const ytrain = train.map((r) => outcomeIndex(r.outcome));
  console.log(`fitting ${names.length} features...`);
  const model = fitOrdinal(Xtrain, ytrain, names, { iterations: 600 });
  console.log(
    `log-likelihood ${model.logLikelihood.toFixed(0)}, mean ${(model.logLikelihood / model.n).toFixed(4)} per row`,
  );

  // --- coefficients --------------------------------------------------------
  console.log('\n=== COEFFICIENTS (positive = better career) ===');
  const ranked = names
    .map((name, i) => ({ name, beta: model.beta[i]! }))
    .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));
  for (const { name, beta } of ranked.slice(0, 14)) {
    console.log(`  ${name.padEnd(18)}${beta >= 0 ? ' ' : ''}${beta.toFixed(4)}`);
  }
  console.log(`  cutpoints: ${model.cutpoints.map((c) => c.toFixed(3)).join(', ')}`);

  // --- test predictions ----------------------------------------------------
  const Xtest = test.map(toX);
  const ytest = test.map((r) => outcomeIndex(r.outcome));
  const predicted = Xtest.map((row) => predictOrdinal(model, row));

  console.log('\n=== CALIBRATION on held-out classes ===');
  console.log('  predicted vs observed rate; ECE = expected calibration error');
  for (let k = 0; k < ORDERED_OUTCOMES.length; k++) {
    const { ece } = calibrationError(predicted, ytest, k);
    const meanPredicted =
      predicted.reduce((sum, p) => sum + p[k]!, 0) / predicted.length;
    const observed = ytest.filter((y) => y === k).length / ytest.length;
    console.log(
      `  ${ORDERED_OUTCOMES[k]!.padEnd(18)}predicted ${(meanPredicted * 100).toFixed(1)}%  observed ${(observed * 100).toFixed(1)}%  ECE ${(ece * 100).toFixed(2)}pp`,
    );
  }

  // --- beat the baseline ---------------------------------------------------
  // Discrimination for "reached Starter or better", model vs rating alone.
  const reachedStarter = ytest.map((y) => y >= 2);
  const modelScore = predicted.map((p) => p[2]! + p[3]!);
  const ratingScore = test.map((r) => r.rating ?? 0.84);
  const starsScore = test.map((r) => r.stars ?? 3);
  console.log('\n=== BEAT THE BASELINE (AUC for Starter-or-better) ===');
  console.log(`  stars alone        ${auc(starsScore, reachedStarter).toFixed(4)}`);
  console.log(`  rating alone       ${auc(ratingScore, reachedStarter).toFixed(4)}`);
  console.log(`  full model         ${auc(modelScore, reachedStarter).toFixed(4)}`);
  console.log(
    '  If the model does not clear rating alone by a visible margin, say so plainly',
  );
  console.log('  rather than presenting it as an advance.');

  // --- sanity: does ordering by star rating survive? -----------------------
  console.log('\n=== ORDERING CHECK (must be monotonic in stars) ===');
  console.log('  Predicted P(Starter+) and P(Impact) for a generic WR, year 3');
  for (const stars of [5, 4, 3, 2]) {
    const probabilities = predictOrdinal(
      model,
      buildFeatures({
        stars,
        // Representative composite rating for each star band.
        rating: { 5: 0.98, 4: 0.92, 3: 0.85, 2: 0.79 }[stars] ?? 0.85,
        ranking: { 5: 25, 4: 250, 3: 900, 2: 2200 }[stars] ?? 900,
        height: 73,
        weight: 195,
        position: 'WR',
        source: 'HighSchool',
        era: 'portal-nil',
        eligibilityYear: 3,
      }),
    );
    console.log(
      `  ${stars}-star   Starter+ ${((probabilities[2]! + probabilities[3]!) * 100).toFixed(1)}%   Impact ${(probabilities[3]! * 100).toFixed(2)}%`,
    );
  }

  await writeFile(OUT_FILE, JSON.stringify(model));
  const bytes = (await readFile(OUT_FILE)).byteLength;
  console.log(`\nwrote ${OUT_FILE} — ${(bytes / 1024).toFixed(1)} KB`);
  console.log('This is what ships to the browser instead of the dataset.');
}

main().catch((error: unknown) => {
  console.error('\ntraining failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
