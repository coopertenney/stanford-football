/**
 * Bundle the app into ONE self-contained HTML file.
 *
 * The model bundle and the cohort column store are injected as compile-time
 * constants, so the output has no external requests at all — required both by the
 * artifact CSP and by the goal of handing a single file to a coach.
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const bundle = JSON.parse(await readFile('data/bundle.json', 'utf8'));
const cohort = await readFile('data/cohort.b64', 'utf8');

const result = await build({
  entryPoints: ['src/ui/main.ts'],
  bundle: true, write: false, format: 'iife', target: 'es2022', minify: true,
  define: {
    __BUNDLE__: JSON.stringify(bundle),
    __COHORT_B64__: JSON.stringify(cohort.trim()),
  },
});
const js = result.outputFiles[0].text;
const html = (await readFile('src/ui/index.html', 'utf8')).replace('__APP__', () => js);
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', html);
const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed 
  ? (Buffer.byteLength(html) / 1024 / 1024).toFixed(2) : '?';
console.log(`dist/index.html — ${mb} MB (js ${(Buffer.byteLength(js) / 1024).toFixed(0)} KB)`);
