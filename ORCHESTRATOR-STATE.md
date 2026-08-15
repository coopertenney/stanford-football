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

**Empty. No lanes are live.** No dispatch has ever been made from this file.

Instrument: `python3 scripts/board.py list`. Coordination directory is project-local
(`.coord/`, gitignored) and cannot collide with summer-build's.

## 3. The gate's current reading

`.venv/bin/python scripts/check.py` — **11 PASS · 4 KNOWN-BAD · 1 CANNOT-SEE · 0 FAIL**, exit 0.

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
- **`src/ingest/`'s 5 files have not been read against the two distortions.** Whether the TS
  rewrite already fixes the merge direction or the labeling is **unknown** — not "no" and not
  "yes." Settling this is cheap and should probably be the first dispatch.

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

**Item 1 needs a data source the pipeline does not touch** — Public Roster / Participation Data, a
P0 source in PDR §3.1.4. That is a real dependency, not an implementation detail; item 1 cannot be
dispatched as written until it is resolved, and resolving it may be a question for Cooper.

## 7. Recommended next dispatch

**Read-only: audit `src/ingest/`'s 5 files against the two distortions.** Cheap, owns no files,
cannot collide, and it settles §4's open unknown — which currently blocks honest planning of items
1–2, since nobody knows whether the TS rewrite already solved them.

Second, if a writing session is wanted in parallel: **item 3** (ROI/EV formulas). Self-contained,
`app.py` only, ~20 lines, and it is the one fix whose correctness is checkable against an explicit
PDR formula rather than against a judgment call about what a "Starter" is.

## 8. Open with Cooper

- 🔴 **Rotate the CFBD API key.** Only he can. It never entered git history but sat in plaintext on
  disk and was exposed in a terminal.
- **What is a "Starter"?** Item 1 replaces percentile buckets with absolute standards, and the PDR's
  §3.1.1 definition ("holds a starting role a full season") needs a data-backed operationalisation.
  The PDR risk table suggests ≥10 starts. That is a product call.
- **Is Public Roster / Participation Data obtainable?** Item 1 depends on it. See §6.
