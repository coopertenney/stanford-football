# DECISIONS — dated record

`CLAUDE.md` is **rules and current state**. This file is **history**: what was measured, when,
what it cost, and what was decided. The split exists because `CLAUDE.md` loads into context on
every session, so a dated finding appended there is a tax on every future read.

**Entries here are records, not rules.** An entry that has been superseded is **stale, not
wrong** — mark what replaced it and leave the original. Deleting a true dated record destroys
the only evidence of why a decision was made.

**Mark what you checked yourself.** Every claim below is either *verified* (a command was run,
quoted) or *relayed* (someone said so). Uniform confidence is what makes one wrong claim
load-bearing.

---

## 2026-08-15 — under version control, key scrubbed, gate built

**Verified.** `git init` + first commit, pushed private to
`github.com/coopertenney/stanford-football`. 25 files / 7.9M tracked; 421M of regenerable data
excluded.

**The API key was never in git history, and the note claiming otherwise nearly caused the leak
it described.** `CLAUDE.md` and `.env.example` both said the hardcoded CollegeFootballData key
was *"already effectively committed."* False: there was no repository, so it had never been in
any history — and the first commit would have been the thing that made it permanent. Scrubbed
from `gather_rb_data.py` and notebook cell 1 before `git init`; `src/ingest/cfbd.ts` already
read from the environment. Verified absent from the full history with
`git log --all -p | grep -E "<key prefix>"`.

The key is nonetheless **burned** — weeks in plaintext on disk plus a terminal exposure — and
needs rotating. **Standing rule:** an *"it's already exposed"* claim licenses a real leak, so
check it against `git log` before believing it.

**Two mechanical traps found while doing this, both worth keeping:**

- **`.gitignore` has no trailing-comment syntax.** `cfbd_cache/   # 329M` is parsed as a
  pattern containing spaces and a `#`, so it matches nothing. It staged **822 files** and 329M
  silently. Caught only by inspecting the stage before committing — `git add` reported nothing
  unusual. Now checked by `scripts/check.py` (hygiene group) and noted in `.gitignore` itself.
- **A private repo reads as nonexistent to an under-privileged query.** `gh repo view` returned
  *"Could not resolve to a Repository"* — not because the repo was absent, but because `gh` was
  authenticated as `ctenney05` while the repo belongs to `coopertenney`. An absence claim from
  a query that lacks access is not an absence. Nearly created a duplicate.

**Decided:** `gh`'s active account is `coopertenney` (Cooper's call — the prior `ctenney05`
default was itself the accident).

**Decided:** do **not** port summer-build's orchestrator coordination tooling here. Reached
independently by two sessions. Reasoning: that framework's value is seam-drift detection across
packages several people maintain, plus a board so 5–7 concurrent lanes can see each other.
Here there is one ~677-line `app.py` and a five-file ingest, the parallelism ceiling is 1–2
sessions, and its hardcoded `SEAM_PATHS` list matches nothing in this repo — so ported
unchanged its drift check would report green forever, which is worse than no check. Full
reasoning and the two mechanical gotchas kept at `ORCHESTRATOR-SETUP-HANDOFF.md`.

**Built instead: `scripts/check.py` + `scripts/baseline.json`.** A characterization gate suited
to this project's actual failure modes (rotting notes, unchecked claims, silently wrong model
numbers) rather than to multi-session coordination. Its central idea is that a documented
distortion gets its current value **pinned**, so divergence in *either* direction goes red —
fixing item 1 or 2 currently has nothing that would confirm it worked. First run: 11 PASS,
4 KNOWN-BAD, 1 CANNOT-SEE, 1 FAIL (this file was missing).

**Also:** `requirements.txt` (47 packages, frozen from the working venv), `README.md`, and
`src/ingest/` documented in `CLAUDE.md` — it had existed for weeks mentioned in no doc, so a
reader would conclude the TS rewrite did not exist.

**Not done:** no clean-clone test on a fresh machine. `requirements.txt` is a freeze of a venv
that already worked, which is evidence the packages suffice, not that the README's steps do.
PDR §4.1 is not provably met until someone clones cold.

---

## 2026-08-12 — the two data distortions, and the full PDR re-read

**Verified, re-measured 2026-08-15.** Both distortions push outcomes **optimistic**. Fix these
before anyone acts on the tool's numbers.

**1. Outcome labels are percentile buckets, not the PDR's definitions.**
`gather_rb_data.py:156-164` cuts `impact_percentile` at 0.25/0.60/0.85, so the dataset returns
Bust 24.96 / Depth 34.98 / Starter 25.02 / Impact 15.05 — the cut points themselves, in **every**
eligibility year (max spread across years 1–5: **0.35pp**). The distribution is a definitional
artifact, not an empirical finding. PDR §3.1.1 wants absolute standards (Starter = holds a
starting role a full season; Impact = All-Conference / draft pick), and the PDR risk table
already prescribes the fix: a starts-based heuristic, e.g. ≥10 starts. That needs Public Roster
/ Participation Data — a **P0** source in §3.1.4 the pipeline does not touch. Outcomes currently
derive from box-score totals only.

Side effect: labels are **position-relative**, so a "Starter" RB and a "Starter" WR are not the
same thing — and that feeds straight into the dollar mapping.

**2. Survivorship — non-participants are missing, not labeled Bust.** The pipeline starts from
the stats endpoint and left-joins recruits onto it (`gather_rb_data.py:103`), so a recruit who
never recorded a carry or catch never enters the table. **6,910** WR/TE/RB high-school recruits
pulled for 2018-2024; **2,913** distinct players (**42.2%**) appear in
`yearly_player_outcomes.csv`. The missing **57.8%** are the real busts. So "Bust" currently
means *"bottom quartile of players who already made the field."* Fix by inverting the merge:
start from the recruit list, left-join stats, treat no-stat seasons as Bust.

⚠️ **Two rates, different denominators — do not conflate.** The **89%** figure is the share of
*stat-line players* matched to a recruit profile. The **42%** figure is the share of *recruits*
that appear at all. Both are correct.

**3. KNN signal survives both problems.** Hand-measured: 5-star elite WR → 47.0% Impact, 2-star
WR → 17.1%, 3-star RB → 11.1%. Ordering and spread are sensible; the **absolute levels** are
wrong (a 2-star at 17% Impact is not credible). Relabeling must **preserve the ordering** — if
it inverts, the fix broke the model. Not checked by any script; see
`baseline.json: model_signal.knn_ordering`.

**4. No Power 4 scoping.** PDR §3.1.4 says scope to ACC / Power 4 where possible. Dataset spans
**270** teams, only **48.6%** P4/P5. Stanford itself: **67** rows.

**Gap vs. the PDR** (full re-read, all 7 pages). Phase 1 ships and satisfies §4.1; Phase 2 is
about half built. Phase 1 gaps: 3 of 9 position groups (missing QB/OL/DL/LB/DB/ST); **"Player
Source" (HS vs. transfer portal) is not captured at all** — the pipeline pulls only
`classification="HighSchool"` — and it is named in §3.1.2, in the §4.1 success criteria, *and*
it is core use case #2 (comparing two portal targets), so it outranks the raw position count;
7 recruiting classes where §3.1.4 asks for 10 (2015-2024). Phase 2 missing: Upside Probability,
Outcome Variance, Monte Carlo (§3.2.3), side-by-side Comparison Mode (§3.2.4).

**Agreed fix order** (items 1–2 are the ones that change what the tool tells a recruiter):
1. Redefine outcomes against roster/participation data — absolute thresholds, not percentiles.
2. Include non-participants as Bust (invert the merge direction).
3. Fix ROI and EV formulas to match §3.2.2 — contained, ~20 lines.
4. Add Player Source input.
5. Upside Probability + Outcome Variance — trivial once 3 is done.
6. Monte Carlo, then Comparison Mode.
7. ~~`requirements.txt` + README + `git init`~~ — **done 2026-08-15.**

---

## 2026-08-12 — three formula bugs in `app.py`

**Verified by reading the code.** All still present.

- **ROI is computed two different ways on the same screen.** `app.py:110` (table) uses
  `expected_surplus / offer_amount` = (EV−C)/C; `app.py:546` (summary metric) uses
  `total_ev / total_compensation` = EV/C. They differ by exactly 1.0×. PDR §3.2.2 defines ROI
  as EV / Total Compensation — **the table is the wrong one.**
- **EV is a peak, not a total.** §3.2.2: "Σ (P(outcome) × Value(outcome)) across all years."
  `app.py:540` takes `.max()` — the single best eligibility year — and labels it "Expected Value
  Ceiling." Net Value and ROI both inherit it. Against a multi-year comp figure this
  **understates** EV.
- **Summary banner contradicts the metric row above it.** `app.py:578` uses `.mean()` EV for
  the green/red verdict while the metrics use `.max()`. The same recruit can show positive Net
  Value and a red "negative investment" banner.

Not caught by `scripts/check.py` — it does not instantiate the model. See that script's
"WHAT THIS GATE CANNOT SEE".

---

## 2026-08-11 — do not keep this project in an iCloud-synced folder

**Verified by measurement.** While the project sat on `~/Desktop`, iCloud materialized the
venv's binaries on demand, so every `import` blocked on network I/O:

| | Desktop (iCloud) | `~/dev` |
|---|---|---|
| `import pandas` + one CSV read | **84.5s wall / 0.6s CPU** | **0.39s** |
| `build_model()` | never finished | fine |
| `pip freeze` | hung past 4 min | fine |
| streamlit | HTTP 200, permanently blank page, process `sleeping` at 0.3% CPU | fine |

**Symptom to recognize:** near-zero CPU with huge wall-clock time is iCloud, not the app and
not the network. Moved to `~/dev/stanford-football`; venv rebuilt from scratch at the new
location (full install 32s), so package versions are newer than the original Desktop venv.

**Also decided:** dropped `--server.address 0.0.0.0` from the streamlit invocation — it
published the app unauthenticated on the campus network IP. Re-add only when deliberately
demoing to another device.

---

## 2026-08-02 — RB data added

**Verified.** `yearly_rb_outcomes.csv` via `gather_rb_data.py`, same clean/merge/eligibility-year
/outcome-labeling logic as the notebook's WR/TE pipeline, but `category="rushing"` and
`rushing_score = YDS + 20*TD + 2*CAR` (analogous to `receiving_score = YDS + 20*TD + 5*REC`).
2,844 RB player-season rows, 89% recruiting-profile match rate. Combined into
`yearly_player_outcomes.csv` (7,914 rows), which is what `build_model()` reads.

`value_mapping.json` needs an entry per position or the app falls back to WR values with a
warning — added an RB entry (Depth $90k / Starter $350k / Impact $1M). WR values match PDR
§3.2.1 defaults exactly.

**Note for the next position added:** the KNN model is `@st.cache_resource`-cached per process,
so a code or data change needs a **restart**, not a browser refresh.
