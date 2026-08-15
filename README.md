# Stanford Football — Player Valuation Tool

Given a recruit profile (stars, composite rating, ranking, height, weight, position,
school), find historical comparables via KNN and show the year-by-year career outcome
distribution — Bust / Depth-Rotation / Starter / Impact Player — then layer a dollar
value mapping to produce EV, Net Value and ROI against a proposed offer.

Phase 1/2 proof of concept per `Player Tool v1 PDR.pdf`.

> ## ⚠️ Do not act on the tool's absolute numbers yet
> Two known distortions both push outcomes **optimistic**:
> 1. **Outcome labels are percentile buckets, not the PDR's absolute definitions.**
>    Cut points at 0.25/0.60/0.85 mean the dataset returns Bust 25.0 / Depth 35.0 /
>    Starter 25.0 / Impact 15.0 in *every* eligibility year — a definitional artifact,
>    not a finding.
> 2. **Survivorship: non-participants are missing rather than labeled Bust.** The
>    pipeline starts from the stats endpoint, so a recruit who never recorded a carry
>    or catch never enters the table. Only 42% of pulled recruits appear. The ~58%
>    missing are the real busts.
>
> The KNN **ranking** survives both problems (5-star WR 47.0% Impact → 2-star WR 17.1%
> → 3-star RB 11.1%); it's the levels that are wrong. See `CLAUDE.md` for the full
> writeup and the agreed fix order.

## Setup

Requires Python 3.11+ and Node 22+.

```bash
git clone https://github.com/coopertenney/stanford-football.git
cd stanford-football

# Python app
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# TS ingest pipeline
npm install
```

### API key

The pipeline reads a [CollegeFootballData](https://collegefootballdata.com/key) key from
the environment. Free to obtain. Never hardcode it.

```bash
cp .env.example .env    # then fill in CFBD_API_KEY
export CFBD_API_KEY=...
```

### ⚠️ Location matters on macOS

**Do not put this repo under `~/Desktop` or `~/Documents`** if those are iCloud-synced.
iCloud materializes the venv's binaries on demand, so every `import` blocks on network
I/O. Measured: `import pandas` + one CSV read took **84.5s wall against 0.6s CPU**,
`build_model()` never finished, and streamlit served HTTP 200 with a permanently blank
page. Same work from `~/dev`: **0.39s**.

Symptom to recognize — near-zero CPU with huge wall-clock time is iCloud, not the app.

## Running

```bash
.venv/bin/streamlit run app.py --server.port 8502 --server.headless true
# then open http://localhost:8502
```

`Port 8502 is not available` just means an instance is already up:

```bash
pkill -f "streamlit run app.py"
```

The KNN model is `@st.cache_resource`-cached per process, so a code or data change needs
a **restart**, not just a browser refresh.

> Deliberately **not** passing `--server.address 0.0.0.0` — that published the app
> unauthenticated on the campus network IP. Add it only when demoing to another device
> on purpose.

## Data pipeline

```bash
npm run ingest          # TS pipeline → data/player_seasons.json
python3 gather_rb_data.py   # legacy per-position pull → cfbd_data/, *_outcomes.csv
```

**Tracked** (model inputs, needed for a clean-clone run):

| File | What |
|---|---|
| `yearly_wr_te_outcomes.csv` | WR/TE, 2018-2024 classes, 2018-2025 stats |
| `yearly_rb_outcomes.csv` | RB, 2,844 player-seasons, 89% recruit-profile match |
| `yearly_player_outcomes.csv` | combined WR+TE+RB, 7,914 rows — what `app.py` reads |
| `Player Data/` | hand-supplied source CSVs, not script-regenerable |
| `value_mapping.json` | $ per outcome per position; WR values match PDR §3.2.1 |

**Not tracked** (regenerable — see `.gitignore`): `cfbd_cache/` (329M), `cfbd_data/`
(12M), `data/` (80M).

Adding a position: pull its CFBD stat category → build `<position>_outcomes.csv` →
re-concat into `yearly_player_outcomes.csv` → add an entry to `value_mapping.json`
(without one, the app silently falls back to WR values with a warning) → restart
streamlit.

## Project layout

```
app.py                    Streamlit UI + KNN model (677 lines)
value_mapping.json        $ value per outcome per position
gather_rb_data.py         legacy Python ingest
src/ingest/               TS rewrite of the ingest pipeline
Football_Player_Tool_v1_PDR.ipynb   original notebook (app.py was extracted from it)
Player Tool v1 PDR.pdf    the spec
CLAUDE.md                 working notes: known bugs, gap-vs-PDR, fix order
```

`app.py` and `value_mapping.json` were extracted from the notebook and are now edited
directly — not regenerated from it.

## State vs. the PDR

Phase 1 ships and meets the §4.1 success criteria. Phase 2 is about half built. Known
formula bugs (ROI computed two ways on one screen; EV takes `.max()` where §3.2.2 wants
a sum across years) and the full gap list are in `CLAUDE.md`.
