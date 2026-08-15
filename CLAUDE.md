# Stanford Football Player Tool — project notes

## What this is
Phase 1/2 PoC per `Player Tool v1 PDR.pdf`: given a recruit profile (stars, rating,
ranking, height, weight, position, school), find historical comps via KNN and show
year-by-year career outcome distribution (Bust / Depth-Rotation / Starter / Impact
Player), then (Phase 2) layer $ value mapping + EV/ROI against a proposed offer.

## Setup / running the app
- Project lives at `~/dev/stanford-football`. **Do not move it back under `~/Desktop`
  or `~/Documents`** — both are iCloud-synced on this machine, and a venv there is
  unusable: iCloud materializes the venv's binaries on demand, so every `import`
  blocks on network I/O. Measured 2026-08-11 while it sat on the Desktop:
  `import pandas` + read of `yearly_player_outcomes.csv` took 84.5s wall against
  0.6s CPU, `build_model()` never finished, `pip freeze` hung past 4 minutes, and
  streamlit served HTTP 200 but rendered a permanently blank page (process
  `sleeping` at 0.3% CPU, wedged mid-import). Same work from `~/dev`: 0.39s.
  Symptom to recognize — near-zero CPU with huge wall-clock time means iCloud, not
  the app, and not the network.
- Python deps live in a local venv: `.venv/` (streamlit, pandas, numpy, matplotlib,
  scikit-learn, requests). System Homebrew python is externally-managed (PEP 668),
  so don't `pip install` outside the venv — use `.venv/bin/pip`. Venv rebuilt from
  scratch 2026-08-11 at the new location (full install: 32s), so package versions
  are newer than the original Desktop venv.
- Run: `.venv/bin/streamlit run app.py --server.port 8502 --server.headless true`
  then open http://localhost:8502. Dropped the old `--server.address 0.0.0.0` flag —
  it published the app unauthenticated on the campus network IP. Re-add only when
  deliberately demoing to another device.
- `Port 8502 is not available` just means an instance is already up; `pkill -f
  "streamlit run app.py"` before restarting.
- `app.py` and `value_mapping.json` were extracted from
  `Football_Player_Tool_v1_PDR.ipynb` (cells `%%writefile app.py` / `value_mapping.json`)
  and now live as standalone files (edited directly going forward, not via notebook).

## Data pipeline
- 🔴 **CFBD API key is read from `CFBD_API_KEY` in every code path** — `src/ingest/cfbd.ts`,
  `gather_rb_data.py`, notebook cell 1. No hardcoded copies remain; both Python sites fail
  loudly with a setup message when it's unset rather than making an unauthenticated call.
  **Corrects an earlier note here that called the old key "already-committed."** That was
  false and it mattered: there was no git repo at the time, so the key had never been in any
  history — and the first commit would have been the first thing to put it there permanently.
  Scrubbed *before* `git init` (2026-08-15), so history is clean. The key is nonetheless
  **burned** (weeks in plaintext on disk + a terminal exposure) — rotate, don't reuse.
  Standing rule: an "it's already exposed" claim licenses a real leak, so check it against
  `git log` before believing it.
- Raw pulls cached in `cfbd_data/` (recruits by year, player_stats by category+year) —
  re-running the gather script reuses the cache instead of re-hitting the API.
- `yearly_wr_te_outcomes.csv` — original WR/TE dataset from the notebook (receiving
  category, 2018-2024 recruiting classes, 2018-2025 stats).
- `yearly_rb_outcomes.csv` — added 2026-08-02 via `gather_rb_data.py`, same
  clean/merge/eligibility-year/outcome-labeling logic as the notebook's WR/TE
  pipeline, but category="rushing" and `rushing_score = YDS + 20*TD + 2*CAR`
  (analogous to `receiving_score = YDS + 20*TD + 5*REC`). 2,844 RB player-season rows,
  89% recruiting-profile match rate.
- `yearly_player_outcomes.csv` — combined WR+TE+RB dataset (7,914 rows), what
  `app.py`'s `build_model()` actually reads now. If adding another position, follow
  the same pattern: pull its CFBD stat category, build a `<position>_outcomes.csv`,
  then re-concat into `yearly_player_outcomes.csv` and restart streamlit (the KNN
  model is `@st.cache_resource`-cached per process, so a code/data change needs a
  restart, not just a browser refresh).
- `value_mapping.json` needs an entry per position or the app falls back to WR
  values with a warning — added an RB entry (Depth $90k / Starter $350k / Impact $1M)
  when RB was wired in. WR values match the PDR §3.2.1 defaults exactly.

## Data validity — two known distortions (found 2026-08-12)
Both push outcomes optimistic. Fix these before anyone acts on the tool's numbers.
- **Outcome labels are percentile buckets, not the PDR's definitions.**
  `gather_rb_data.py:156-164` cuts `impact_percentile` at 0.25/0.60/0.85, so the
  dataset returns Bust 25.0 / Depth 35.0 / Starter 25.0 / Impact 15.0 — exactly the
  cut points, in *every* eligibility year. The distribution is a definitional
  artifact, not an empirical finding. PDR §3.1.1 wants absolute standards (Starter =
  holds a starting role a full season; Impact = All-Conference / draft pick), and the
  PDR risk table already prescribes the fix: a starts-based heuristic (e.g. ≥10 starts).
  That needs Public Roster / Participation Data — a **P0** source in §3.1.4 that the
  pipeline doesn't touch. Outcomes currently derive from box-score totals only.
  Side effect: labels are position-relative, so a "Starter" RB and a "Starter" WR
  aren't the same thing, and that feeds straight into the dollar mapping.
- **Survivorship: non-participants are missing, not labeled Bust.** The pipeline
  starts from the stats endpoint and left-joins recruits onto it
  (`gather_rb_data.py:103`), so a recruit who never recorded a carry or catch never
  enters the table. 6,910 WR/TE/RB HS recruits pulled for 2018-2024; only 2,913
  distinct players (42%) appear in `yearly_player_outcomes.csv`. The ~58% missing are
  the real busts. So "Bust" currently means "bottom quartile of players who already
  made the field." Fix by inverting the merge direction: start from the recruit list,
  left-join stats, treat no-stat seasons as Bust.
  (The 89% match rate noted above is a different denominator — share of *stat-line*
  players matched to a recruit profile. Both numbers are correct; don't conflate.)
- **KNN signal survives both problems** — worth knowing before rewriting the model.
  Measured 2026-08-12: 5-star elite WR → 47.0% Impact, 2-star WR → 17.1%, 3-star RB →
  11.1%. Ordering and spread are sensible; it's the absolute levels that are wrong
  (a 2-star at 17% Impact is not credible). Relabeling should preserve the ranking.
- **No Power 4 scoping.** PDR §3.1.4 says scope to ACC / Power 4 where possible.
  Dataset spans 270 teams, only 48.6% P4/P5 — Sun Belt, MAC, etc. sit in the same
  percentile pool and distort the ranks. Stanford itself: 67 rows.

## Known rough edges
- `build_model()` is called at module scope (`app.py:80`), before the first
  `st.title()`, so nothing paints until the CSV load + KNN fit completes. Fast now
  (~0.07s), but it means any future slowdown in that function shows up as a blank
  page rather than a spinner — misleading when debugging.
- **ROI is computed two different ways on the same screen.** `app.py:110` (table) uses
  `expected_surplus / offer_amount` = (EV−C)/C; `app.py:546` (summary metric) uses
  `total_ev / total_compensation` = EV/C. They differ by exactly 1.0x. PDR §3.2.2
  defines ROI as EV / Total Compensation — the table is the wrong one.
- **EV is a peak, not a total.** PDR §3.2.2: "Σ (P(outcome) × Value(outcome)) across
  all years." `app.py:540` takes `.max()` — the single best eligibility year — and
  labels it "Expected Value Ceiling." Net Value and ROI both inherit it. Against a
  multi-year comp figure this understates EV.
- **Summary banner contradicts the metric row above it.** `app.py:578` uses `.mean()`
  EV for the green/red verdict while the metrics use `.max()`. Same recruit can show
  positive Net Value and a red "negative investment" banner.
- `build_model()` sits at module scope — see the note above; any slowdown there
  surfaces as a blank page, not a spinner.

## Gap vs. PDR (full re-read of all 7 pages, 2026-08-12)
Phase 1 ships and satisfies the §4.1 success criteria; Phase 2 is about half built.
- **Phase 1 met:** 4 outcome categories match §3.1.1; year 1-5 table + stacked bar
  per §3.1.3; real data not hardcoded; 7 recruiting classes (criteria wants ≥5);
  3 position groups (criteria wants 3+); star rating / composite rating / position
  inputs all present.
- **Phase 1 gaps:** position coverage is WR/TE/RB, 3 of the PDR's 9 groups (missing
  QB/OL/DL/LB/DB/Special Teams). "Player Source" (HS vs. transfer portal) isn't
  captured at all — pipeline only pulls `classification="HighSchool"` — and it's named
  in §3.1.2, in the §4.1 success criteria, *and* it's core use case #2 (comparing two
  portal targets), so it's higher priority than the raw position count. §3.1.4 asks
  for 10 classes (2015-2024); we have 7 (2018-2024).
- **Phase 2 built:** value mapping (configurable per position, no code changes — meets
  §4.2), EV / Net Value / ROI / Downside Probability — though EV and ROI have the
  formula bugs listed under Known rough edges.
- **Phase 2 missing:** Upside Probability (P(Impact)) and Outcome Variance — both
  one-liners off the existing distribution; Monte Carlo simulation (§3.2.3: N
  iterations sampling per year, histogram, median/mean/p10/p90, comp reference line);
  side-by-side Comparison Mode (§3.2.4). All are explicit §4.2 success criteria.
- **Reproducibility (§4.1 "reproducible from a clean clone"):** mostly met as of
  2026-08-15 — `requirements.txt` (47 pinned packages, frozen from the working venv),
  `README.md` with clone-to-run steps, and the repo is now git-tracked at
  `github.com/coopertenney/stanford-football` (private). `app.py` is still one
  677-line file; that's structure, not reproducibility.
  **Not verified:** nobody has actually cloned to a clean machine and run it. The
  `requirements.txt` is a freeze of a venv that already worked, which is evidence the
  packages are sufficient, not that the documented steps are.

## Suggested fix order (agreed 2026-08-12)
1. Redefine outcomes against roster/participation data (absolute thresholds, not
   percentiles) — everything downstream inherits this.
2. Include non-participants as Bust (invert the merge direction).
3. Fix ROI and EV formulas to match §3.2.2 — contained, ~20 lines.
4. Add Player Source input.
5. Upside Probability + Outcome Variance — trivial once 3 is done.
6. Monte Carlo, then Comparison Mode.
7. ~~`requirements.txt` + README + `git init`~~ — **done 2026-08-15.**
Items 1-2 are the ones that change what the tool actually tells a recruiter.
Items 1-2 are what `src/ingest/` (below) exists to do.

## TypeScript ingest rewrite — `src/ingest/` (in progress)
Not mentioned anywhere in these notes until 2026-08-15, so a session reading this file
would have concluded it didn't exist. 5 files, ~52K: `cfbd.ts` (API client, reads
`CFBD_API_KEY`, caches to `cfbd_cache/`), `join.ts`, `positions.ts`, `types.ts`,
`build.ts` (entrypoint). Run: `npm run ingest` (or `--games`), output
`data/player_seasons.json` (80M, gitignored). `npm run typecheck` for tsc.
Node ≥22, `tsx`, no runtime deps.
This is the vehicle for fix-order items 1-2 — it re-does the pull/merge that
`gather_rb_data.py` got wrong. **Whether it currently fixes the merge direction or the
outcome labeling is UNVERIFIED** — nobody has read those 5 files against the two
distortions above. Do that before assuming the rewrite has solved them.
