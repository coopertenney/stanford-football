# Stanford Football Player Tool — project notes

> **📋 THE PROCESS — read this before changing anything.**
>
> **Run `npm run check` before you commit.** One gate, `scripts/check.py`. It exists because
> this project's failures are not "a function returned the wrong value" — they are rotting
> notes, claims nobody verified, and a model whose numbers are wrong in ways nothing detects
> while the tool prints dollar figures somebody makes offers from.
>
> **Five statuses. The middle three are the whole point:**
> - `PASS` / `FAIL` — normal. FAIL exits 1.
> - `KNOWN-BAD` — a documented distortion is still present **and matches
>   `scripts/baseline.json`**. Exits 0. **This is not a pass**; it means "still broken, as
>   recorded." It exits 0 only so nobody appends `|| true` to a permanently-red gate.
> - `CHANGED` — reality diverged from the ledger **in either direction**. Exits 1. **A fix
>   trips this exactly like a regression does**, on purpose: today, fixing fix-order item 1 or
>   2 has nothing that would confirm it worked.
> - `CANNOT-SEE` — an input was missing, so the check did not run. Exits 0 and is **never**
>   reported as a pass. It always names what would make it see.
>
> **`scripts/baseline.json` is a characterization ledger, not a wishlist.** Several entries
> pin values we know are *wrong*. Updating one is the act of claiming a fix — do it
> deliberately, and record the why in `DECISIONS.md`.
>
> **What the gate cannot see** (stated so a green run isn't over-read): it does not run
> `app.py` or instantiate the KNN model, so the ROI/EV formula bugs are invisible to it, and it
> cannot verify a relabeling preserved the model's ordering. The secret scan matches the
> *shape* of a key, not a key it has never seen. Full list in the script's docstring.
>
> **This file is rules + current state. Dated findings go in [`DECISIONS.md`](DECISIONS.md).**
> A measurement appended here is a tax on every future session, since this file loads every
> time. Promote only the durable one-liner back up here, with a pointer down.
>
> **Two claim rules, both earned here:**
> - **An absence claim needs a command behind it.** *"Not built anywhere," "nothing reads it,"
>   "already committed"* are cheap to check and expensive to assert wrongly, because a stated
>   absence closes the question for every later reader. The *"key is already effectively
>   committed"* note was false and nearly licensed a real leak — there was no repo.
>   A private repo also reads as *nonexistent* to a query lacking access.
> - **Mark what you verified vs. what you were told.** Uniform confidence is what makes one
>   wrong claim load-bearing.
>
> **Deliberately NOT here:** summer-build's orchestrator coordination tooling (board,
> seam-drift). Wrong fit — one `app.py` plus a five-file ingest, ~1–2 concurrent sessions, and
> its seam list matches nothing here so its drift check would report green forever. Reasoning
> in `ORCHESTRATOR-SETUP-HANDOFF.md`; decision in `DECISIONS.md` (2026-08-15).

## What this is
Phase 1/2 PoC per `Player Tool v1 PDR.pdf`: given a recruit profile (stars, rating, ranking,
height, weight, position, school), find historical comps via KNN and show the year-by-year
career outcome distribution (Bust / Depth-Rotation / Starter / Impact Player), then (Phase 2)
layer $ value mapping + EV/ROI against a proposed offer.

## Setup / running the app
- **Do not move this project under `~/Desktop` or `~/Documents`** — both are iCloud-synced
  here, which makes a venv unusable: every `import` blocks on network I/O. **Symptom to
  recognize: near-zero CPU with huge wall-clock time is iCloud, not the app and not the
  network.** Measurements: `DECISIONS.md` (2026-08-11).
- Python deps live in `.venv/`. System Homebrew python is externally-managed (PEP 668), so
  don't `pip install` outside it — use `.venv/bin/pip -r requirements.txt`.
- Run: `.venv/bin/streamlit run app.py --server.port 8502 --server.headless true`, then
  http://localhost:8502. **Do not add `--server.address 0.0.0.0`** — it publishes the app
  unauthenticated on the campus network IP. Add it only when deliberately demoing to another
  device.
- `Port 8502 is not available` means an instance is already up: `pkill -f "streamlit run app.py"`.
- The KNN model is `@st.cache_resource`-cached per process, so **a code or data change needs a
  restart**, not a browser refresh.
- `app.py` and `value_mapping.json` were extracted from the notebook and are edited **directly**
  now, not regenerated from it.

## Data pipeline
- 🔴 **The CFBD API key is read from `CFBD_API_KEY` in every code path** — `src/ingest/cfbd.ts`,
  `gather_rb_data.py`, notebook cell 1. No hardcoded copies; the Python sites fail loudly when
  it is unset rather than making an unauthenticated call. **The current key is burned — rotate
  it.** Why, and the false "already-committed" note that nearly caused the leak it described:
  `DECISIONS.md` (2026-08-15).
- **Tracked** (model inputs): `yearly_wr_te_outcomes.csv` (WR/TE), `yearly_rb_outcomes.csv`
  (RB, 2,844 rows), `yearly_player_outcomes.csv` (combined, **7,914 rows** — what
  `build_model()` reads), `Player Data/` (hand-supplied, not script-regenerable),
  `value_mapping.json`.
- **Not tracked** (regenerable): `cfbd_cache/` 329M, `cfbd_data/` 12M, `data/` 80M.
- **Adding a position:** pull its CFBD stat category → build `<position>_outcomes.csv` →
  re-concat into `yearly_player_outcomes.csv` → **add an entry to `value_mapping.json`** (without
  one the app silently falls back to WR values with a warning) → restart streamlit.

## 🔴 Data validity — do not act on the tool's absolute numbers
Four distortions, all pushing outcomes **optimistic**. Each is pinned in
`scripts/baseline.json` with its full reasoning and what *fixed* would look like; `npm run check`
reports them as `KNOWN-BAD` and goes **red** if any moves. Dated measurements: `DECISIONS.md`
(2026-08-12).

| | Current | Why it's wrong |
|---|---|---|
| Labels are percentile buckets | 24.96 / 34.98 / 25.02 / 15.05 | these **are** the 0.25/0.60/0.85 cut points — a definitional artifact, not a finding. Also position-**relative**, so a "Starter" RB ≠ a "Starter" WR, and that feeds the dollar mapping |
| No year signal | max spread **0.35pp** across years 1–5 | a real distribution shifts with eligibility year; year-1 freshmen should bust far more |
| Survivorship | **42.2%** of recruits covered | non-participants are *missing*, not labeled Bust. The missing **57.8%** are the real busts, so "Bust" means "bottom quartile of players who already made the field" |
| No P4 scoping | **270** teams, **48.6%** P4/P5 | PDR §3.1.4 asks for ACC / Power 4; Sun Belt, MAC etc. distort the ranks. Stanford: 67 rows |

⚠️ **Two rates, different denominators — don't conflate.** **89%** = share of *stat-line players*
matched to a recruit profile. **42%** = share of *recruits* appearing at all. Both correct.

✅ **The KNN ordering survives all of it** (5-star WR 47.0% Impact → 2-star WR 17.1% → 3-star RB
11.1%): sensible ranking, wrong levels. **A relabeling must preserve that ordering — if it
inverts, the fix broke the model, and no script will tell you** (hand-measured;
`baseline.json: model_signal`).

## Known rough edges — `app.py`
Three unfixed formula bugs, all invisible to `npm run check` (it doesn't instantiate the model).
Line refs and the PDR citations: `DECISIONS.md` (2026-08-12).
- **ROI is computed two different ways on the same screen** — the table uses (EV−C)/C, the
  summary metric uses EV/C. They differ by exactly 1.0×. §3.2.2 defines it as EV/C, so **the
  table is the wrong one.**
- **EV is a peak, not a total** — takes `.max()` over eligibility years and labels it "Expected
  Value Ceiling." §3.2.2 wants the sum across years. Net Value and ROI inherit it, so against a
  multi-year comp figure this **understates** EV.
- **The summary banner contradicts the metric row above it** — banner uses `.mean()` EV, metrics
  use `.max()`, so one recruit can show positive Net Value *and* a red "negative investment."
- `build_model()` runs at module scope before the first `st.title()`, so any future slowdown
  there surfaces as a **blank page rather than a spinner**. Fast today (~0.07s).

## State vs. the PDR
Phase 1 ships and satisfies §4.1. Phase 2 is about half built. Full gap list: `DECISIONS.md`
(2026-08-12).
- **Biggest Phase 1 gap is not position count — it's "Player Source."** HS vs. transfer portal
  isn't captured at all (the pipeline pulls only `classification="HighSchool"`), and it's named
  in §3.1.2, in the §4.1 criteria, *and* it is core use case #2 (comparing two portal targets).
- Position coverage is WR/TE/RB — 3 of the PDR's 9 groups. 7 recruiting classes where §3.1.4
  asks for 10.
- **Phase 2 missing:** Upside Probability, Outcome Variance, Monte Carlo (§3.2.3), side-by-side
  Comparison Mode (§3.2.4).
- **Reproducibility (§4.1 "from a clean clone"): mostly met** — `requirements.txt`, `README.md`,
  git-tracked private at `github.com/coopertenney/stanford-football`. **Not verified:** nobody has
  cloned to a clean machine and run it, and a freeze of a working venv is evidence the packages
  suffice, not that the documented steps do.

## Fix order (agreed 2026-08-12)
1. Redefine outcomes against roster/participation data — absolute thresholds, not percentiles.
2. Include non-participants as Bust (invert the merge direction).
3. Fix the ROI and EV formulas to match §3.2.2 — contained, ~20 lines.
4. Add Player Source input.
5. Upside Probability + Outcome Variance — trivial once 3 is done.
6. Monte Carlo, then Comparison Mode.
7. ~~`requirements.txt` + README + `git init`~~ — **done 2026-08-15.**

**Items 1–2 are the only ones that change what the tool tells a recruiter, and they are what
`src/ingest/` exists to do.**

## TypeScript ingest rewrite — `src/ingest/`
5 files: `cfbd.ts` (API client, reads `CFBD_API_KEY`, caches to `cfbd_cache/`), `join.ts`,
`positions.ts`, `types.ts`, `build.ts` (entrypoint). `npm run ingest` (or `ingest:games`) →
`data/player_seasons.json`. `npm run typecheck` for tsc. Node ≥22, `tsx`, no runtime deps.

This is the vehicle for fix-order items 1–2 — it re-does the pull/merge `gather_rb_data.py` got
wrong. **Whether it currently fixes the merge direction or the outcome labeling is UNVERIFIED**;
nobody has read those 5 files against the distortions above. Do that before assuming the rewrite
has solved them.
