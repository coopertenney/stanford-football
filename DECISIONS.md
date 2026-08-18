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

## 2026-08-15 — `src/ingest/` audited; four doc claims falsified; a fifth distortion found

First orchestrator cycle. A read-only agent audited `src/ingest/`'s 5 files against the four pinned
distortions; the orchestrator then re-ran the load-bearing checks itself. **Verified** below means
the orchestrator ran the command; **relayed** means it rests on the audit alone.

**Gate reading, before and after: 12 PASS · 4 KNOWN-BAD · 1 CANNOT-SEE · 0 FAIL** (verified, twice).
Nothing moved — no code changed this cycle. `ORCHESTRATOR-STATE.md` had said 11 PASS; `check.py` is
untouched since (landed `b10a154`, that doc `96bed4b`, `scripts/` clean), so it was a miscount.

**What `src/ingest/` is** (verified): a stage-1, **unlabeled** pipeline, complete and **unwired** —
`app.py` still reads `yearly_player_outcomes.csv`. Artifact `data/player_seasons.json`: 83.5 MB,
gitignored, 196,679 rows, 48,797 distinct recruits (40,236 HighSchool + 8,561 Portal), 9 position
groups, classes 2015–2024, 24 fields, **no label field**. Merge direction is recruit-first and
non-participants are retained — 96,221 never-rostered rows kept. P4 scoping stamped but never
filtered on: 288 teams, 47.1% P4 (relayed) against a pinned 270 / 48.6%.

🔴 **The audit's headline number was a tautology.** It reported "96.7% coverage" against the pinned
42.2%. 96.7% is the share of HS recruits *emitted a row* — ~100% by construction, since the
pipeline emits a row per recruit-season regardless of participation. Re-derived by hand in the
baseline's own universe (WR/TE/RB, classes 2018–2024): **10,150 recruits, 7,984 ever rostered =
78.7%** (verified). The lesson is now ERRATA in `ORCHESTRATOR-INSTRUCTIONS.md`: check a returned
metric's **denominator** against the baseline's, not only its value.

**Four documented claims falsified** (all verified):
1. `ORCHESTRATOR-STATE.md` §6 — *"Item 1 needs a data source the pipeline does not touch"*. It does
   touch it: `join.ts` pulls `/roster` 2015–2025 plus `/player/usage`, `/draft/picks` and box
   scores. **Item 1 is unblocked on data**; only the "what is a Starter" product call remains.
2. `CLAUDE.md` — *"HS vs. transfer portal isn't captured at all"*. True of the Python path only;
   the TS artifact holds 19,330 Portal rows.
3. `CLAUDE.md` — *"WR/TE/RB — 3 of the PDR's 9 groups. 7 recruiting classes"*. True of the shipped
   model; the ingest has all 9 groups and 10 classes.
4. `ORCHESTRATOR-STATE.md` §6 — item 2 *"sequence after 1"*. Its structural half is already done.

🔴 **The retracted key claim had propagated into code, and is now deleted.** `src/ingest/cfbd.ts`
carried it verbatim above `apiKey()`, including *"not to rotate it"* — the same false claim
retracted elsewhere in this file on this date, the one `CLAUDE.md`'s process block cites as its
canonical example. Routed to the session that owns the file rather than dispatched; it deleted the
whole block. **Verified after the fact** (not taken on report): `apiKey()` has no comment, and a
repo-wide grep for *"effectively committed" / "not to rotate"* returns only the documents recording
the incident.

**The provenance is the lesson, and it is new.** That session wrote the comment by copying the claim
out of `CLAUDE.md` while `CLAUDE.md` still asserted it — it treated the notes as verified, which is
what notes are for. So the retraction fixed the source and left the derivative standing, in the one
place the original scrub could not have caught it, because that scrub hunted key *literals* rather
than sentences about the key. **A prose correction does not propagate. Retracting a claim means
grepping the repo for it.** Rule added to `CLAUDE.md`.

**Fifth distortion, not pinned by the gate — the 0.4 usage weight is dead** (verified):
`gather_rb_data.py` looks for a `Usage Overall` column in a pivot of
`/stats/player/season?category=rushing`, which never contains it, and falls back to `0`. Measured:
`Usage Overall` has `nunique == 1`, value 0, across **all 2,844 RB and all 5,070 WR/TE rows**;
`usage_pct` is a constant ≈0.5008 from tied ranks (std 0.0003 RB / 0.0001 WR-TE). So
`impact_score = 0.4·constant + 0.6·production_pct` — **every outcome label in the shipped 7,914 rows
is pure raw-production rank.** Independent of the four pinned distortions and invisible to the gate.
The TS path sidesteps it by pulling the real `/player/usage` endpoint.

**The uncommitted `join.ts` fix is correct** (mechanism verified by reading; measurements relayed):
`game.teams` carries both teams, so counting every side double-counted games played — a
distribution peaking at 22 for an ~11-game season. Filtering to the pulled team's own side fixes
it; artifact `max(gamesPlayed) = 16` is consistent with post-fix (verified). It fixes nothing
shipping, since nothing reads the artifact, but it is a **prerequisite for item 1**: `gamesPlayed`
is the natural absolute threshold for "Starter", and 2× inflation would clear any plausible cut.

**A live lane was running undeclared the whole time.** The board read empty and `ORCHESTRATOR-
STATE.md` said no lanes were live; in fact a peer session (`setup`) had authored the entire TS
ingest that session and held all 5 files plus `package.json` and `tsconfig.json`. It surfaced only
because Cooper mentioned the session existed and it was asked directly — `ListAgents` shows session
*names*, never working directories, and two of the names on that list belong to a different repo.
It has since posted lane `ingest-pipeline`. **Board-empty is not evidence; `git status` is.**

**`gamesPlayed` corruption, corrected figure — record 54,870, not 33,806** (both reproduced). The
owning session first reported 33,806, a real count of a narrower thing at an earlier dataset
version: 10 classes, predicate `rostered && !power4 && gamesPlayed === 0`, out of 53,135 rostered
non-P4 rows. The orchestrator counted 54,870 on the current file and asked for the denominator
rather than recording either. The reconciliation found the larger fact: the other **19,329**
rostered non-P4 rows were also corrupt, carrying **nonzero but radically incomplete** counts —
games against P4 opponents only, the same double-count bug seen from the other side. So the
population splits into 33,806 phantom zeros plus 19,329 partials, and **33,806 alone would have
described a third of the corruption as the whole of it.** All are now `null` rather than `0`, which
is the fix that matters: `0` reads as "did not play" but meant "never fetched."

**The artifact was rebuilt twice in one afternoon** — 83.5 MB / 196,679 rows / 10 classes at 11:22,
then 94 MB / 200,685 rows / 11 classes at 11:50 (both verified). The audit's field count went stale
within the hour. **Timestamp any count taken from `data/player_seasons.json`.**

**Tooling:** `scripts/orient.sh` added. Orienting by hand cost 8 tool round-trips and two gate runs;
step 1 of the loop is now one read-only command.

**No decisions taken.** Everything above is measurement. Priority remains Cooper's.

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

🔴 **CORRECTED 2026-08-15 (same day, by Cooper): the paragraph below originally opened
"**Decided:** do not port summer-build's orchestrator coordination tooling here." That was
NOT a decision — it was a recommendation from two assistant sessions, and Cooper had made no
ruling either way.** Worse, `ORCHESTRATOR-SETUP-HANDOFF.md` §5 said so explicitly — *"Cooper
never confirmed a decision either way. Do not read this document as approval to proceed"* —
and it was written up here as settled anyway, one file over.

**Standing rule, and it is the reason this correction is kept rather than edited away: a
recommendation recorded as a decision is worse than an unrecorded one.** An open question at
least stays open; a false "Decided:" closes it for every later reader and for every future
session that loads this file. **Only the human decides. Label your own reasoning as a
recommendation, every time.** Same family as the *"already committed"* claim above — an
assertion nobody checked, which then licensed the thing it described.

⚠️ **A second error in the same entry: it answered a narrower question than was asked.** The
recommendation was against porting **`session-brief.py`'s board and seam-drift tooling**. It
was filed as though it settled whether to have an **orchestrator agent at all** — a different
and much more portable thing, since the agent is the planning/dispatch/verification role and
the board is only one instrument it uses. **Cooper's actual ask was the agent.** Built
2026-08-15; see the next entry.

**RECOMMENDATION (not a decision), preserved as written, for whatever it is worth:** the
summer-build framework's value is seam-drift detection across packages several people maintain,
plus a board so 5–7 concurrent lanes can see each other. Here there is one ~677-line `app.py`
and a five-file ingest, the parallelism ceiling is 1–2 sessions, and its hardcoded `SEAM_PATHS`
list matches nothing in this repo — so ported unchanged its drift check would report green
forever, which is worse than no check. Full reasoning and the two mechanical gotchas kept at
`ORCHESTRATOR-SETUP-HANDOFF.md`. **That argument is about the tooling and does not bear on
whether an orchestrator agent is worth having.**

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
