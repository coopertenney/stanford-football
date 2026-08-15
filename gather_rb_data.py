import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

# Read from the environment — never hardcode. Get a free key at
# https://collegefootballdata.com/key, then `export CFBD_API_KEY=...` (see .env.example).
API_KEY = os.environ.get("CFBD_API_KEY")
if not API_KEY:
    raise SystemExit(
        "CFBD_API_KEY is not set. Get a free key at https://collegefootballdata.com/key "
        "and export it before running: export CFBD_API_KEY=..."
    )
BASE_URL = "https://api.collegefootballdata.com"
headers = {"Authorization": f"Bearer {API_KEY}"}

DATA_DIR = Path("cfbd_data")
DATA_DIR.mkdir(exist_ok=True)


def get_recruits(year):
    url = f"{BASE_URL}/recruiting/players"
    params = {"year": year, "classification": "HighSchool"}
    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    df = pd.DataFrame(response.json())
    df["recruit_year"] = year
    return df


def get_player_stats(year, category):
    url = f"{BASE_URL}/stats/player/season"
    params = {"year": year, "category": category}
    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    df = pd.DataFrame(response.json())
    df["season"] = year
    df["category"] = category
    return df


def cached_get_recruits(year):
    path = DATA_DIR / f"recruits_{year}.csv"
    if path.exists():
        print(f"Using cached recruits {year}")
        return pd.read_csv(path)
    print(f"Downloading recruits {year}")
    df = get_recruits(year)
    df.to_csv(path, index=False)
    time.sleep(0.25)
    return df


def cached_get_player_stats(year, category):
    path = DATA_DIR / f"player_stats_{category}_{year}.csv"
    if path.exists():
        print(f"Using cached {category} stats {year}")
        return pd.read_csv(path)
    print(f"Downloading {category} stats {year}")
    df = get_player_stats(year, category)
    df.to_csv(path, index=False)
    time.sleep(0.25)
    return df


recruits_df = pd.concat(
    [cached_get_recruits(year) for year in range(2018, 2025)],
    ignore_index=True,
)

stats_df = pd.concat(
    [
        cached_get_player_stats(year, category)
        for year in range(2018, 2026)
        for category in ["rushing"]
    ],
    ignore_index=True,
)

print("Recruits rows:", len(recruits_df))
print("Rushing stat rows:", len(stats_df))


def clean_name(s):
    return (
        s.astype(str)
        .str.lower()
        .str.strip()
        .str.replace(r"[^a-z\s]", "", regex=True)
        .str.replace(r"\s+", " ", regex=True)
    )


stats_wide = stats_df.pivot_table(
    index=["player", "team", "conference", "season", "category", "playerId", "position"],
    columns="statType",
    values="stat",
    aggfunc="first",
).reset_index()
stats_wide.columns.name = None

stats_wide["name_clean"] = clean_name(stats_wide["player"])
recruits_df["name_clean"] = clean_name(recruits_df["name"])

stats_wide["position_clean"] = stats_wide["position"].astype(str).str.upper().str.strip()
recruits_df["position_clean"] = recruits_df["position"].astype(str).str.upper().str.strip()

merged_name_pos = stats_wide.merge(
    recruits_df,
    on=["name_clean", "position_clean"],
    how="left",
    suffixes=("_stat", "_recruit"),
)

merged_name_pos["eligibility_year"] = (
    merged_name_pos["season"] - merged_name_pos["recruit_year"] + 1
)

merged_name_pos = merged_name_pos[
    merged_name_pos["eligibility_year"].between(1, 5)
].copy()

merged_name_pos["team_clean"] = merged_name_pos["team"].astype(str).str.lower().str.strip()
merged_name_pos["committed_clean"] = (
    merged_name_pos["committedTo"].astype(str).str.lower().str.strip()
)
merged_name_pos["school_match"] = (
    merged_name_pos["team_clean"] == merged_name_pos["committed_clean"]
).astype(int)

merged_name_pos = merged_name_pos.sort_values(
    by=["player", "season", "team", "school_match", "recruit_year", "rating"],
    ascending=[True, True, True, False, False, False],
)

merged_clean = merged_name_pos.drop_duplicates(
    subset=["player", "season", "team"], keep="first"
).copy()

df = merged_clean[merged_clean["position_clean"] == "RB"].copy()

for col in ["CAR", "YDS", "TD"]:
    if col not in df.columns:
        df[col] = 0
    df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

if "Usage Overall" in df.columns:
    df["Usage Overall"] = pd.to_numeric(df["Usage Overall"], errors="coerce").fillna(0)
else:
    df["Usage Overall"] = 0

df["rushing_score"] = df["YDS"] + 20 * df["TD"] + 2 * df["CAR"]

df["usage_pct"] = df.groupby("eligibility_year")["Usage Overall"].rank(pct=True)
df["production_pct"] = df.groupby("eligibility_year")["rushing_score"].rank(pct=True)

df["impact_score"] = 0.4 * df["usage_pct"] + 0.6 * df["production_pct"]
df["impact_percentile"] = df.groupby("eligibility_year")["impact_score"].rank(pct=True)


def classify_outcome(p):
    if p < 0.25:
        return "Bust"
    elif p < 0.60:
        return "Depth / Rotation"
    elif p < 0.85:
        return "Starter"
    else:
        return "Impact Player"


df["outcome"] = df["impact_percentile"].apply(classify_outcome)

yearly_distribution = (
    df.groupby(["eligibility_year", "outcome"]).size().unstack(fill_value=0)
)
print(yearly_distribution)
print("Final RB player-season rows:", len(df))
print("Matched rating rate:", df["rating"].notna().mean())

df.to_csv("yearly_rb_outcomes.csv", index=False)
print("Saved yearly_rb_outcomes.csv")
