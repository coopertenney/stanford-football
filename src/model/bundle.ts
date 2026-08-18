/**
 * Assemble everything the browser needs into one artifact bundle.
 *
 *   npm run bundle
 *
 * Combines the fitted ordinal model, the retention curves and the value config into
 * data/bundle.json. This plus data/cohort.b64 (for comparable players) is the
 * complete payload — no dataset ships.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { buildRetention, retentionFor } from './retention.ts';
import {
  DEFAULT_VALUE_CONFIG,
  POSITION_STARTER_VALUE,
  TIER_MULTIPLIER,
  VALUE_PROVENANCE,
} from './value.ts';
import type { PositionGroup } from '../ingest/types.ts';

/** Newest recruit class with all five eligibility years observed (2021 + 4 = 2025). */
const LAST_COMPLETE_CLASS = 2021;

async function main(): Promise<void> {
  const rows = JSON.parse(await readFile('data/labeled_seasons.json', 'utf8'));
  const model = JSON.parse(await readFile('data/model.json', 'utf8'));

  const retention = buildRetention(rows, LAST_COMPLETE_CLASS);
  console.log(`retention from classes ${retention.classesUsed.join(', ')}`);
  console.log(`  overall: ${retention.overall.map((v) => v.toFixed(3)).join('  ')}`);
  for (const position of Object.keys(retention.byPosition).sort()) {
    console.log(
      `  ${position.padEnd(4)}   ${retention.byPosition[position]!.map((v) => v.toFixed(3)).join('  ')}`,
    );
  }
  console.log('  by era:');
  for (const era of Object.keys(retention.byEra).sort()) {
    console.log(
      `  ${era.padEnd(12)}${retention.byEra[era]!.map((v) => v.toFixed(3)).join('  ')}`,
    );
  }

  const bundle = {
    generated: 'offline',
    model,
    retention,
    value: {
      ...DEFAULT_VALUE_CONFIG,
      positionValue: POSITION_STARTER_VALUE,
      tierMultiplier: TIER_MULTIPLIER,
    },
    provenance: VALUE_PROVENANCE,
  };
  await writeFile('data/bundle.json', JSON.stringify(bundle));
  const bytes = (await readFile('data/bundle.json')).byteLength;
  console.log(`\nwrote data/bundle.json — ${(bytes / 1024).toFixed(1)} KB`);

  // Sanity: a WR in the current era should show declining retention.
  const curve = retentionFor(retention, 'WR' as PositionGroup, 'portal-nil');
  console.log(`WR portal-nil retention: ${curve.map((v) => v.toFixed(3)).join('  ')}`);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
