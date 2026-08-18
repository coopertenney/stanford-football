# Handoff — Stanford Football Player Valuation Tool

Written 2026-08-17 at the end of a long session. Branch `ts-rewrite-ingest-model-ui`,
ten commits, working tree clean. Read this before touching anything.

---

## What this is

Recruit profile in (stars, composite rating, national ranking, height, weight,
position, high-school-vs-portal) → calibrated year-by-year probabilities of four
career outcomes (Bust / Depth-Rotation / Starter / Impact) → dollar valuation of a
proposed NIL/revenue-share offer. Built against `Player Tool v1 PDR.pdf`.

There is a **legacy Python/streamlit proof of concept** (`app.py`) still in the repo.
It is superseded but not deleted, and `scripts/check.py` still guards it. The TS
rewrite is everything under `src/`.

**Coverage map of what addresses which PDR section:**
https://claude.ai/code/artifact/b22b4750-9ca0-4263-9712-889e63afd8ae

**Ingest data reference:**
https://claude.ai/code/artifact/fdafdaef-be99-484e-bc7d-f6bc1e217659

---

## Run it

```bash
npm install
export CFBD_API_KEY=...        # key is BURNED, rotate before use
npm run ingest:games           # ~7 min cold, 4 s warm
npm run label                  # outcome labels + validation report + draftee gate
npm run train                  # ordinal model, out-of-time validation
npm run bundle && npm run encode && npm run build   # -> dist/index.html, 2.2 MB
npm run calibrate              # re-derive constants, diff against baseline_ts.json
.venv/bin/python scripts/check.py    # legacy gate — NOT this pipeline
```

`npm run calibrate -- --pin` accepts current numbers as the new baseline. Do that
**deliberately**, and say in the commit which entries moved and why.

---

## THE MOST IMPORTANT THING TO KNOW

Three separate times in this project, a correctly-diagnosed bias was fixed, the fix
over-reached, and **the new failure landed on a population the guard could not see.**
Each was found by adversarial review, not by any test.

1. Percentile labels → fixed → unlinked recruits became Bust (mirror-image bias).
2. Unlinked-as-Bust → censored → NFL players read Bust *after leaving for the NFL*
   (189 of 231 first-round picks).
3. That → fixed → an FBS-commitment rule put **Bryce Young, Justin Fields and Quinn
   Ewers in the bust bucket in the shipped browser artifact.** The draftee gate
   printed PASS throughout, because unlinked recruits have no `athleteId` and
   `draftPick` is keyed on `athleteId`, so every guard was structurally blind to the
   exact population the fix created.

**Before shipping any label change, ask: which population does this create, and can
the existing guards see it?** Then spawn an adversarial review agent. Both prior
reviews found something that would have been visible in a demo.

`npm run calibrate` + `scripts/baseline_ts.json` exist because of this. They pin the
headline distribution so drift is caught mechanically rather than by luck.

---

## BLOCKING — wrong numbers, fix before any demo

Ranked by how much each changes what a recruiter is told.

### 1. Portal EV is off by an order of magnitude

The model predicts **53% chance of an All-Conference season in year 5** for a portal
transfer; observed is 4–10% (n=62 for 4★+ portal WR: Starter 45.2%, Impact 4.8%).
A 4-star portal WR returns **ROI 6.31×**.

This is the answer to PDR core use case #2 — comparing two portal targets — and it is
not defensible. Causes, all measured:
- Portal rows are 3.5% of training data (3,678 of 105,678).
- Proportional-odds forces ONE constant latent shift for `sourcePortal`; the year-4/5
  dummies are fitted almost entirely on high-school careers.
- Portal players are given five eligibility years when they typically have one or two.
- `bundle.json` has **no `rev-share` retention curve** — selecting the newest era
  silently falls back to the base curve, which is *more* optimistic than `portal-nil`.

`train.ts` never separates portal from high-school in its calibration check, so
nothing catches it. Fix: calibrate the portal cell separately, cap portal eligibility
years, add the missing era curve.

### 2. Value above replacement contradicts ROI on the same row

An elite 5-star QB shows **ROI 3.23×** and **value above replacement −$1,249,931**
side by side. `replacementValue` charges the full Depth tier every year, retention-
weighted, for free — so VAR = EV − 1.39 SS and anything below ~55% P(Starter+) goes
negative. Two opposite recommendations in one metric row. This is the same class of
defect as the predecessor's `.max()`-vs-`.mean()` banner that this rewrite exists to
have eliminated. Fix or remove the metric.

### 3. Draftee gates are overfit — Cooper flagged this, and he is right

`labelBuild.ts` has three gates before a recruit is auto-Busted. Gates 1 and 2 are
sound: the school must be genuinely FBS, and no player of that name may appear on
that school's roster in-window. **Gate 3 — never auto-Bust a name matching an NFL
draft pick — uses the outcome to protect the label.** Remove it. Leave the residual
failures visible; suppressing them is how the last three cycles went wrong.

Also: the gate's `PASS draftees labeled Bust: 0` line is a **theorem, not a
measurement** — the career veto rewrites those rows before the gate recomputes, so
rank 1 is unreachable. Two real checks run alongside it and can fail. Trust those.

### 4. Outcome variance ignores its own control

`decision.ts` computes `outcomeVariance` from the four point values only. The
"Within-tier spread" slider does not move the "Outcome std dev" metric, which sits
directly beside a p10/p90 caption that *does* move. Two contradictory spread figures
on one screen.

---

## KNOWN-BAD, documented, not blocking

- **Special teams excluded** — 8 of 9 position groups. PFF's WAA feed records a median
  of 1 snap for K/P/LS. **Recoverable without new data**: `cfbd_cache/games_players__*`
  already carries kicking/punting volume separating a starting kicker (median 19 FG
  attempts) from a backup (median 0), 86% unambiguously. Long snappers are a genuine
  dead end.
- **`teamPlays` is estimated**, clamped to a plausible band rather than measured. Real
  per-unit snaps live in the PFF game-grade feed — only week 1 is exported.
- **Dollar scale carries ±30%.** No audited per-player compensation data exists
  publicly and state law is closing the records route. Mitigated by making spend level
  a user control and showing every figure in starter-season equivalents.
- **119 draftees still carry ≥1 Bust season** (5 first-round), and **19 five-stars read
  all-Bust**, several of which are 2025 recruits with no season played — a right-edge
  case the gates do not cover.
- **README is stale**, wrong on ~8 load-bearing numbers. Least-reviewed artifact.
- **Model AUC 0.763 vs 0.610 for composite rating alone.** Real but modest. Most of
  the value is calibration, not discrimination. Say it that way.

---

## Requested but not built

1. **Hover provenance on every figure.** Cooper wants to hover any number, equation or
   figure and see exactly how it was computed and what the source was. This is the
   right feature — most of what makes this tool defensible currently lives in code
   comments nobody reading the UI will see. Needs a provenance record per displayed
   metric, not a `title` attribute.
2. **The missing PFF data.** ~14 more weekly Game Grades exports from
   `ultimate.pff.com/feeds` → `pff_data/`, then re-ingest. Fixes `teamPlays` properly
   and may recover special teams. Downloads land in `~/Downloads`; use
   `scripts/collect_pff.sh` to file them by the season inside each file (every export
   downloads under the same filename). Browser automation works — the Feeds UI needs
   League→NCAA, then season, then RUN, with ~9 s between runs or downloads collide.

---

## Traps that cost real time

- **`gamesPlayed` is P4-only.** Non-P4 rows must be `null`, never `0`. A `0` reads as
  "did not play" and poisons labeling.
- **`/games/players?team=X` returns BOTH teams' box scores.** Counting every side
  double-counts. Filter to the requested team.
- **PFF team names need aliases, and a wrong match is worse than none.** Longest-prefix
  sent "North Carolina State Wolfpack" → "North Carolina", leaving NC State at 0% PFF
  coverage and 100% Bust. Eight aliases in `pff.ts` (the doc comment says six — stale).
- **Names: join on `rosterName`, not the recruiting-service name**, and strip
  generational suffixes. Nicknames (Pat/Patrick, Sauce/Ahmad) remain unfixed.
- **The name blob uses a NUL separator.** Joining on a space shredded multi-word names
  in the comps table.
- **`push(...arr)` with ~190k elements throws** and silently skipped a file rewrite.
- **Spreading 200k+ elements into `Math.min/max`** blows the stack.
- **Chrome cannot load `file://`** — serve `dist/` over localhost to view the build.
- **`label.ts:159` says "0.84 yields 365"** — measured 269. Stale comment; the baseline
  already pins 269.

---

## Open decisions for Cooper

1. **Lamar Jackson reads "Starter", not Impact.** PFF's WAA ranks him 10th among 359
   QBs in his Heisman season (0.653; cut is ~0.659). The rushing-QB hypothesis was
   **tested and not supported** (correlation −0.046, n=790) — so this is PFF
   disagreeing with Heisman voters, not a metric flaw. Leaving it is the honest call;
   changing it to catch one name is fitting to the validation set.
2. **Which GitHub account owns this repo.** SSH host aliases are configured and both
   keys are loaded (`github-personal` → coopertenney, `github-school` → ctenney05).
   The remote still points at `coopertenney`. Given PFF data and Stanford IP, the
   school account may be right.
3. **Spend level** is user-set and defaults to 1.00 (Power 4 median). Research verdict:
   **conference is a weak proxy** — within-conference spread (2–2.5×) exceeds
   between-conference spread (~1.35×). The strongest version is Stanford supplying its
   own per-position budget via `positionValue`, which makes the scale measured rather
   than inferred.

---

## Coordination

Another session (`orch football`, socket `uds:/tmp/cc-socks/26048.sock`) is
orchestrating in this repo. It owns docs — `CLAUDE.md`, `DECISIONS.md`,
`ORCHESTRATOR-*.md`, `scripts/check.py`, `scripts/baseline.json`, `scripts/orient.sh`.
I owned `src/**`, `build.mjs`, `README.md`, `scripts/collect_pff.sh`,
`scripts/baseline_ts.json`, `package.json`, `tsconfig.json`.

Post your lane before writing: `python3 scripts/board.py post --lane <name> --files
<comma,separated>`. Orient with `./scripts/orient.sh`.

**PFF licensing is resolved** — Cooper confirmed with the assistant GM that Stanford
permits this use. Keep `pff_data/` gitignored regardless: committing raw licensed rows
is a different act from shipping a derived tool.

---

## Suggested first moves

1. Read `src/ingest/label.ts` top to bottom. It carries the most consequential
   decisions and the reasoning for each.
2. `npm run label` and read the validation report — three tests plus the draftee gate.
3. Fix blocking #3 (remove gate 3) — smallest, and it removes an overfit.
4. Fix blocking #2 (VAR vs ROI) — self-contained, in `value.ts`/`decision.ts`.
5. Then blocking #1 (portal) — the largest and the one touching a core use case.
6. Spawn an adversarial review before declaring any of it done.
