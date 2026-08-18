# Orchestrator state — stanford-football

> **The reload point.** [`ORCHESTRATOR-INSTRUCTIONS.md`](ORCHESTRATOR-INSTRUCTIONS.md) is *how to
> operate*; this file is *what is true right now*. Read the instructions' ERRATA block first.
>
> **This file is state, not history.** Rewrite sections in place as they change. Do **not** append
> a "2026-08-20 update — §2 is stale" section below an outdated one; that pattern is why
> summer-build's equivalent carries four stacked corrections and reads wrong until you reach the
> bottom. Dated records belong in [`DECISIONS.md`](DECISIONS.md).

**Last rewritten: 2026-08-15.**

---

## 1. Where the project is

Phase 1 of `Player Tool v1 PDR.pdf` ships and satisfies §4.1. Phase 2 is about half built.

Three commits of process work landed 2026-08-15 (git init + key scrub, the gate, the docs trim);
**no work on the fix order has started.** The tool runs and produces numbers that should not be
acted on — see §3.

## 2. Board / live sessions

**One live lane, `ingest-pipeline`** (session `setup`, declared 2026-08-15 after being asked).

| Session | Branch | Files owned | Status |
|---|---|---|---|
| `setup` | `main`, **uncommitted** | `src/ingest/*.ts` (all 5), `package.json`, `tsconfig.json` | live — stage-1 ingest, stopped deliberately before labeling |

It authored the whole TS ingest this session, including the `join.ts` games fix. **`app.py`,
`value_mapping.json`, `scripts/*`, all CSVs are explicitly not theirs and free to dispatch.**
Anything needing `src/ingest/types.ts` — which includes item 1's labeler, since that file is its
input contract — **sequences behind this lane**; they offered to hand the contract over rather than
have two authors.

**The lane was invisible until asked.** It ran undeclared for a session; posting is opt-in and
nothing enforces it, which is why `git status` is part of orienting and `board.py list` says so
itself. `./scripts/orient.sh` prints both.

One dispatch has been made from this file: the read-only `src/ingest/` audit, 2026-08-15, closed.

**Peer sessions — `ListAgents` shows names, never working directories, so the names mislead.**
Confirmed by Cooper 2026-08-15: the session named **`orch` is summer-build's (pareto)
orchestrator, not this repo's.** This repo's is **`orch football`**. Do not read `orch` as a second
orchestrator here. Session **`setup`** was asked which repo and files it holds; unanswered as of
this rewrite. Everything else on that list is presumed summer-build until it says otherwise —
**presumed, not verified.**

Instrument: `python3 scripts/board.py list`. Coordination directory is project-local
(`.coord/`, gitignored) and cannot collide with summer-build's.

## 3. The gate's current reading

`.venv/bin/python scripts/check.py` — **12 PASS · 4 KNOWN-BAD · 1 CANNOT-SEE · 0 FAIL**, exit 0.
(Re-run 2026-08-15 by the orchestrator. This file previously said 11 PASS. `scripts/check.py` has
not been touched since that number was written — it landed in b10a154, this file in 96bed4b, and
`git status` shows scripts/ clean — so the 11 was a miscount, not a change in the gate. The 12 are:
secrets 4, hygiene 3, docs 3, data 2.)

**This is the baseline to compare against after every dispatch.** A shrinking PASS count matters as
much as a rising FAIL count.

The four `KNOWN-BAD` are the four data distortions, all pinned in `scripts/baseline.json`:

| Distortion | Current value | Fixed looks like |
|---|---|---|
| Labels are percentile buckets | 24.96 / 34.98 / 25.02 / 15.05 — the cut points themselves | shares diverge from 0.25/0.60/0.85 and vary by year |
| No year signal | max spread 0.35pp across years 1–5 | spread well past 1pp; year 1 skews Bust |
| Survivorship | 42.2% recruit coverage | coverage approaches 100%, Bust share rises sharply |
| No P4 scoping | 270 teams, 48.6% P4/P5 | P4 share near 100, teams far below 270 |

The one `CANNOT-SEE` is the **KNN ordering** (5-star WR 47.0% > 2-star WR 17.1% > 3-star RB 11.1%),
hand-measured and verified by no script. **A relabeling must preserve that ordering.** Nothing will
tell you if it doesn't.

## 4. What is not covered by anything

Read this before treating a green run as verification.

- 🔴 **There is no CI.** No GitHub Actions, no required checks, no review bot. The orchestrator is
  the only gate. Every summer-build rule about reading a review body instead of its tick is moot
  here — there is no tick.
- **The gate never runs `app.py`.** The three formula bugs in §5 are invisible to it.
- **No clean-clone test has been done.** `requirements.txt` is a freeze of a venv that already
  worked, which is evidence the packages suffice, not that the README's steps do. PDR §4.1 is not
  provably met.
- **`src/ingest/` — settled 2026-08-15, no longer an unknown.** See §4a.

## 4a. What `src/ingest/` does and does not fix — settled 2026-08-15

Audited read-only, then the load-bearing claims re-verified by the orchestrator directly. Marked
**[V]** where the orchestrator ran the check itself, **[A]** where it rests on the audit alone.

`src/ingest/` is a **stage-1, unlabeled** pipeline. It assigns no outcome label of any kind
(`build.ts` prints *"No outcome labels assigned. That is stage 2."*). Nothing consumes its output:
`app.py` still reads `yearly_player_outcomes.csv`. **It is a complete, unwired parallel pipeline.**

| Distortion | Verdict |
|---|---|
| A. Percentile labels | **OUT OF SCOPE** — no labeler exists in these 5 files [V: `player_seasons.json` has no outcome/label field]. But every input an absolute-threshold labeler needs is present and raw: `rostered`, `usageOverall`, `gamesPlayed`, `draftPick`. |
| B. No year signal | **OUT OF SCOPE**, same reason. The old flatness was `groupby("eligibility_year")` percentile ranking in `gather_rb_data.py` — percentile-within-year cannot vary by year [A]. Nothing in the TS path does that. |
| C. Survivorship / merge direction | **STRUCTURALLY FIXED** [V]. `join.ts` iterates recruits, not stat lines; non-participants are retained as `rostered:false` rather than dropped — **96,221 of 196,679 rows are never-rostered and kept**. The labeling half is stage 2's job. |
| D. P4 scoping | **NOT ADDRESSED** [V]. `isPowerConference` scopes the games *pull* for cost and stamps a `power4` boolean; no row is ever filtered on it. A one-line filter is now possible; nobody has decided to apply it. |

🔴 **Do not quote "96.7% coverage."** The audit reported it against the pinned 42.2%; the numbers
are not comparable. 96.7% is the share of HS recruits emitted *a row*, which is ~100% by
construction. Re-derived by hand in the baseline's own universe (WR/TE/RB, classes 2018–2024):
**10,150 recruits, 7,984 ever rostered = 78.7%** [V]. That is the honest before/after against 42.2%
— and even it is a different definition (rostered vs. having stat lines).

Artifact on disk, [V] at 11:50 on 2026-08-15: `data/player_seasons.json`, **94 MB**, gitignored,
**200,685 rows**, **26 flat fields**, 11 classes **2015–2025**, all 9 position groups, no label
field. Never-rostered share 48.3% [relayed].

⚠️ **This file moves under you — it was rebuilt twice in one afternoon** (83.5 MB / 196,679 rows /
10 classes at 11:22 → 94 MB / 200,685 / 11 classes at 11:50). Any count you quote from it needs its
timestamp, and an earlier audit's numbers went stale within the hour. The 24-fields/2015–2024
reading recorded earlier was correct when taken and wrong by the time it was written down.

**`gamesPlayed` is `null`, not `0`, outside the P4 games pull** — the owning session's change, and
the most consequential one in the lane: a `0` there reads as "did not play" but means "never
fetched", which would have silently poisoned any labeler using games as a threshold.

**Record 54,870 — the whole rostered non-P4 population — not 33,806.** The discrepancy resolved and
the resolution matters more than the number. 33,806 was a real count of a *narrower* thing at an
earlier dataset version (10 classes, predicate `rostered && !power4 && gamesPlayed === 0`, out of
53,135). But the *other* 19,329 rostered non-P4 rows were corrupted too, differently and less
visibly: they carried **nonzero but radically incomplete** counts, covering only their games against
P4 opponents — an artifact of the same double-count bug, since pulling a P4 team also tallied its
non-P4 opponent's players. So the split was 33,806 phantom zeros + 19,329 P4-games-only partials,
and **quoting 33,806 alone would have described a third of the corruption as all of it.** All are
now `null`.

**The uncommitted `join.ts` diff is correct** and should land. `game.teams` carries both teams, so
counting every side double-counted games; the fix filters to the pulled team's own side. Not a fix
to anything shipping — nothing reads the artifact — but a **prerequisite for item 1 being correct**,
since `gamesPlayed` is the natural absolute threshold for "Starter" and a 2× inflation would put
essentially every P4 player over any plausible cut. Residual risk, worth a guard, not a blocker:
`gamesPulled` is keyed on the *requested* team while the filter matches `side.team`, so a school
CFBD spells differently between endpoints would read `gamesPlayed: 0` ("did not play") instead of
`null`. Zero mismatches across all 719 cached files today [A].

## 4b. Defects found 2026-08-15, not previously in any doc

- ✅ **CLOSED same day — `src/ingest/cfbd.ts` carried the retracted "key is already effectively
  committed … not to rotate it" note as a code comment.** Routed to the owning session rather than
  dispatched (their file, live lane); they deleted the whole block rather than rewriting it.
  Verified [V]: `apiKey()` now has no comment, and a repo-wide grep for the phrase returns only the
  docs that record the incident. **Provenance, which is the durable part:** that session wrote the
  comment by copying the claim out of `CLAUDE.md` while `CLAUDE.md` still asserted it. **Correcting
  prose does not correct what was derived from it.** Retracting a claim now means grepping the repo
  for it — the original scrub missed this because it hunted key *literals*, not sentences about the
  key.
- **The 0.4 usage weight in the Python impact score is dead** [V]. `gather_rb_data.py` looks for a
  `Usage Overall` column in a pivot of `/stats/player/season?category=rushing`, which never contains
  it, and falls back to `0`. Measured: `Usage Overall` is 0 for **all 2,844 RB and all 5,070 WR/TE
  rows**; `usage_pct` is a constant ≈0.5008 from tied ranks (std 0.0003). So
  `impact_score = 0.4·constant + 0.6·production_pct` — **every outcome label in the shipped 7,914
  rows is pure raw-production rank.** The usage half of the definition has never been active. The
  gate cannot see this and it is independent of the four pinned distortions. The TS path sidesteps
  it by pulling the real `/player/usage` endpoint.

## 5. Known-unfixed defects

In `app.py`, all three from the 2026-08-12 read, all still present, none visible to the gate. Line
refs in `DECISIONS.md` — **grep the symbol, don't trust the line number**, `app.py` is one 677-line
file and any edit drifts them.

- **ROI computed two ways on one screen** — table uses (EV−C)/C, summary metric uses EV/C. §3.2.2
  says EV/C, so the table is wrong.
- **EV is `.max()` over eligibility years, labelled "Ceiling"** — §3.2.2 wants the sum. Net Value
  and ROI inherit it, so it understates EV against a multi-year comp figure.
- **Summary banner uses `.mean()` while the metrics use `.max()`** — one recruit can show positive
  Net Value and a red "negative investment" banner simultaneously.

## 6. Fix order, and what it implies for dispatch

From `CLAUDE.md`. Items 1–2 are the only ones that change what the tool tells a recruiter.

| # | Item | Region | Can run alongside? |
|---|---|---|---|
| 1 | Redefine outcomes on roster/participation data | ingest | yes — with an `app.py` task |
| 2 | Include non-participants as Bust (invert the merge) | ingest | yes, but **sequence after 1** — both rewrite the same labeling |
| 3 | Fix ROI and EV formulas (§3.2.2) | `app.py` | blocks everything else in `app.py` |
| 4 | Add Player Source input | `app.py` + ingest | after 3 |
| 5 | Upside Probability + Outcome Variance | `app.py` | trivial once 3 lands |
| 6 | Monte Carlo, then Comparison Mode | `app.py` | after 3 |
| 7 | ~~requirements.txt + README + git init~~ | — | **done 2026-08-15** |

🔴 **This section previously said item 1 was blocked on a data source the pipeline does not touch
(Public Roster / Participation Data). That was wrong.** `join.ts` pulls `/roster` for every season
2015–2025, plus `/player/usage`, `/draft/picks` and per-game box scores; 100,458 rostered rows are
already joined and on disk [V, grepped the endpoints and counted the artifact]. **Item 1 is
dispatchable now.** What remains open is the *product* question — what threshold defines a
"Starter" — not the data question.

Item 2's structural half is **already done** (§4a, verdict C); it is not a separate dispatch. The
remaining coupling is one-directional: item 1's labeler must treat `rostered:false` rows as Bust.

## 7. Recommended next dispatch

*Recommendation, not a decision — only Cooper sets priority (ERRATA 2026-08-15).*

1. ~~Land the `join.ts` fix / delete the `cfbd.ts` key comment~~ — **do not dispatch. Both are in
   the live lane's files.** Routed to that session instead (2026-08-15). The key comment is the
   urgent half and is now their ask, not an open dispatch.
2. **Item 3 — ROI/EV formulas.** `app.py` only, ~20 lines, confirmed not owned by the live lane,
   and the one fix checkable against an explicit PDR formula (§3.2.2) rather than a judgment call.
   **This is the only substantial writing work dispatchable right now.** Blocks everything else in
   `app.py`, so it goes first there.
3. **Item 1 — the labeler.** Unblocked on data, blocked twice over: on Cooper for the "Starter"
   threshold, and on the `ingest-pipeline` lane for `types.ts`, its input contract. **Sequence,
   don't parallelise** — this is the case §3 warns about. It is the only work that changes what the
   tool tells a recruiter. Its acceptance test is not the gate: **the KNN ordering must survive**,
   and no script checks that.

## 8. Open with Cooper

- 🔴 **Rotate the CFBD API key.** Only he can. It never entered git history but sat in plaintext on
  disk and was exposed in a terminal.
- **What is a "Starter"?** Item 1 replaces percentile buckets with absolute standards, and the PDR's
  §3.1.1 definition ("holds a starting role a full season") needs a data-backed operationalisation.
  The PDR risk table suggests ≥10 starts. That is a product call.
- ~~**Is Public Roster / Participation Data obtainable?**~~ **Answered 2026-08-15: yes, it is
  already pulled and joined, on disk.** See §6.
