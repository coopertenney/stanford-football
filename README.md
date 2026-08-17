# Stanford Football Player Valuation Tool

Given a recruit profile — stars, composite rating, national ranking, height, weight,
position, and whether they are a high-school signee or a transfer — this estimates
the year-by-year distribution of what comparable players actually became, and prices
a proposed offer against it.

Built against `Player Tool v1 PDR.pdf`. This is the TypeScript rewrite; the original
Python/streamlit proof of concept is still in the repo (`app.py`) and is described
under [Legacy](#legacy) below.

> **The dollar layer is estimated, not measured.** Outcome probabilities are fitted
> to 11 recruiting classes and calibrated against held-out data. The dollar values
> those probabilities are multiplied by are modeled from positional win contribution
> with **no compensation-market source behind them**. Treat dollar figures as
> relative, not absolute. See [What is not trustworthy yet](#what-is-not-trustworthy-yet).

## Quick start

```bash
npm install
export CFBD_API_KEY=...          # free key: https://collegefootballdata.com/key
npm run ingest:games             # ~7 min cold, 4 s warm; writes data/player_seasons.json
npm run label                    # applies outcome labels; needs pff_data/ (see below)
npm run train                    # fits the model, prints calibration + baseline checks
npm run bundle                   # retention curves + model -> data/bundle.json
npm run encode                   # 103 MB JSON -> 2.4 MB column store
npm run build                    # -> dist/index.html, fully self-contained
```

Open `dist/index.html`. It has no external requests — model coefficients and the
comparable-player index are inlined at build time.

| script | what it does |
|---|---|
| `npm run ingest` | Pull CFBD, build the recruit-season table (no games pull) |
| `npm run ingest:games` | As above plus per-team box scores (Power 4 only) |
| `npm run label` | Assign outcome labels; prints the three validation tests |
| `npm run train` | Fit the ordinal model, out-of-time validation |
| `npm run bundle` | Retention curves + model + value config |
| `npm run encode` | Columnar encode for the browser |
| `npm run build` | Bundle to one HTML file |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | Project gate (see `scripts/check.py`) |

## Data sources

**CollegeFootballData** (`CFBD_API_KEY` required). Seven endpoints, cached to
`cfbd_cache/` keyed by endpoint and params, so re-runs cost no API calls.

| endpoint | gives |
|---|---|
| `/recruiting/players` | The cohort: 45,735 recruits, classes 2015-2025 |
| `/roster` | 230,072 player-seasons, and `recruitIds` — the join key |
| `/player/usage` | Offensive snap share (skill positions only) |
| `/games/players` | Per-game box scores, Power 4 |
| `/draft/picks` | NFL selections by `collegeAthleteId` |
| `/player/portal` | Transfers — the Player Source dimension |
| `/teams/fbs` | Conference per season, for the Power 4 flag |

**PFF Ultimate** — the WAR/WAA feed, one CSV per season, exported by hand from
`ultimate.pff.com/feeds` into `pff_data/`. 104,478 player-seasons, 2015-2025.
`scripts/collect_pff.sh` moves downloads into place, naming each by the season found
*inside* the file (every export downloads under the same filename).

PFF supplies what CFBD structurally cannot: **snap counts for every position group**.
CFBD box scores can only see a player who recorded a stat, which covers 9.5% of
offensive linemen; PFF covers 100% of them at ~357 snaps a season.

> `pff_data/` is gitignored, and for a different reason from everything else in that
> file. The rest is excluded because it is regenerable. This is excluded because it
> is **licensed** and redistribution is not ours to grant. Derived coefficients and
> labels are fine to commit; PFF's rows are not.

## How it works

### 1. Ingest — recruit-first, not stats-first

The predecessor started from the stats endpoint and left-joined recruits onto it, so
a recruit who never recorded a carry or catch **never entered the table at all**.
"Bust" therefore meant "bottom quartile of players who already made the field."

This starts from the recruit list. A recruit who never appears on a roster is a row
with `rostered: false` — 48.3% of them. Linking is tiered: `roster.recruitIds` where
present (53%), then name + committed school inside the eligibility window (14%).
Every row records which tier resolved it, so the inferred share stays auditable.

Once an athlete is resolved, **all** of their roster seasons attach, so transfers are
followed. Kyler Murray traces Texas A&M 2015 → Oklahoma 2016-18, including the 2016
sit-out year.

### 2. Label — absolute standards, not percentiles

The predecessor cut `impact_percentile` at 0.25/0.60/0.85 and reported that
25%/35%/25%/15% of players landed in each slice. Those *are* the cut points: the
finding was a restatement of the definition, and it was identical in every
eligibility year.

Labels here are absolute:

| tier | definition |
|---|---|
| **Bust** | Never rostered, or rostered with no participation |
| **Depth / Rotation** | Played, below the starting threshold |
| **Starter** | Snap share at or above the position's calibrated cut |
| **Impact** | Starter role **and** WAA at the position's All-Conference cut |
| *Redshirt / Ineligible* | *Censored — not an outcome* |
| *Insufficient Data* | *Special teams — excluded* |

Both threshold sets are **calibrated to football facts, not quantiles**, and both are
fixed absolute values derived once from the full FBS population — never recomputed
per cohort or per season, which is what made the legacy labels circular. Cohort rates
stay free to vary by star, year and era.

- `STARTER_SNAP_SHARE` is set so each position yields the same number of starters
  per real starting slot. Before calibration my football estimates gave a 2.1×
  spread across positions.
- `IMPACT_WAA` is per position because WAA has a common *unit* (wins) but not a
  common *range* — a QB tops out near 2.4, a tackle near 0.5. A single cut gave QBs
  2.6% Impact and linemen **0.0%**.

`npm run label` prints three tests every run:

| | legacy | now |
|---|---|---|
| Distribution | 25.0/35.0/25.0/15.0 (= the cut points) | 77.5/13.1/8.6/0.9 |
| Bust spread across years | 0.35pp | **7.6pp** |
| Star ordering | untested | 5★ 40.3% bust → 2★ 90.7% |

### 3. Model — ordinal regression, KNN only for comps

Probabilities come from a proportional-odds ordinal model, not KNN. Reasons, all
measured on this data:

- Stars is the **weakest** profile feature (draft AUC 0.744 vs ranking's 0.800), and
  within the 3-star band alone rating quartiles run 1.75% → 5.80% draft rate. KNN
  leaned on the feature that discards the most information.
- Equal feature weights are wrong by a position-dependent amount.
- KNN cannot express right-censoring; a 2024 recruit has two observed seasons.

Validated out-of-time (train classes ≤2021, test 2022-23) because a random split
leaks — the same player appears in up to five rows.

| | predicted | observed |
|---|---|---|
| Bust | 75.3% | 73.2% |
| Depth | 13.5% | 15.8% |
| Starter | 9.9% | 10.0% |
| Impact | 1.2% | 1.0% |

Baseline check, stated plainly: full model AUC **0.722** vs composite rating alone
**0.688** vs stars **0.626**. The discrimination gain over rating is modest; most of
the model's value is calibration, which is what matters when the number gets
multiplied by dollars.

KNN is retained purely to display comparable players, which the PDR requires and
which is where a coach's trust comes from.

### 4. Decision math

Three formula bugs from the predecessor are fixed, and EV is computed **once** so
nothing on screen can disagree with anything else:

- EV was `.max()` over years, labeled "Expected Value Ceiling". §3.2.2 asks for the
  sum.
- ROI was `(EV−C)/C` in the table and `EV/C` in the metric — differing by exactly
  1.0×. §3.2.2 defines it as `EV/C`.
- The verdict banner used `.mean()` while the metrics used `.max()`, so a recruit
  could show positive Net Value under a red "negative investment" banner.

Two additions:

**Retention.** EV over five years silently assumed you keep the player five years.
Measured from the data, year-3 retention fell from **65.6% pre-portal to 46.1% in the
portal/NIL era**, and QBs leave most (48.6% by year 3 vs OL 67.6%).

**Risk preference.** Expected value assumes risk neutrality. The tool computes a
**certain equivalent** using the delta-property u-curve, `u(d) = a + b·r^(−d/X)` with
`r = p/(1−p)`, elicited from one question: *indifferent between $0 and a deal that
wins or loses the offer amount — what win probability makes you indifferent?*
`r = 1` is risk neutral (what the predecessor assumed); `r > 1` is risk averse. The
gap between EV and CE is the reported risk discount.

## What is not trustworthy yet

Stated here rather than buried, because the tool prints dollar figures.

1. **The value layer has no market source.** `POSITION_WEIGHT` comes from measured
   WAA headroom and is defensible; `starterSeasonValue` and `TIER_MULTIPLIER` are
   not. The scale/shape split means swapping in a real budget touches nothing else.
2. **Special teams is excluded.** PFF's WAA feed shows a median of 1 snap for K/P/LS.
   *A later review found CFBD box scores do carry kicking/punting volume sufficient
   to identify starters, so this exclusion is narrower than necessary — see
   `DECISIONS.md`.*
3. **`war` is empty in every PFF season** (0 of 104,478 rows); only `waa` — wins
   above *average* — is populated, so replacement level is derived from the low-snap
   tail rather than taken from PFF.
4. **Monte Carlo draws years independently**, overstating spread. Real careers are
   positively correlated year to year.
5. **Observational, not causal.** The data says what similar players became at
   whatever school they attended, not what this player becomes at Stanford.
6. **32.9% of recruits never linked** to an athlete. ~3,900 have a name match at a
   school other than the one they committed to; those were deliberately left
   unlinked, since a wrong link attributes one player's career to another.

## Legacy

`app.py` is the original streamlit proof of concept, still runnable:

```bash
.venv/bin/streamlit run app.py --server.port 8502 --server.headless true
```

It reads `yearly_player_outcomes.csv` (7,914 rows, WR/TE/RB) and still contains the
percentile labels and formula bugs described above. **Do not add
`--server.address 0.0.0.0`** — that publishes it unauthenticated on the campus
network.

`npm run check` gates the legacy artifacts and reports known distortions as
`KNOWN-BAD`. It does **not** exercise `src/` or `data/`, so a green run says nothing
about the rewrite.

## Layout

```
src/ingest/    CFBD client, recruit-first join, PFF loader, labeler
src/model/     features, ordinal regression, value, decision math, retention
src/encode/    columnar encoder for the browser
src/ui/        app logic, DOM + hand-rolled SVG charts, index.html
scripts/       check gate, PFF collection helper
data/          generated (gitignored)
pff_data/      licensed PFF exports (gitignored)
cfbd_cache/    raw API responses (gitignored)
```
