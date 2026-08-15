import streamlit as st
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import json

from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.neighbors import NearestNeighbors

st.set_page_config(page_title="Recruit Outcome Comps", layout="wide")

OUTCOME_COLS = ["Bust", "Depth / Rotation", "Starter", "Impact Player"]

@st.cache_resource
def build_model():
    df = pd.read_csv("yearly_player_outcomes.csv")
    numeric_features = ["stars", "rating", "ranking", "height", "weight"]
    categorical_features = ["position_clean", "committedTo"]

    profiles = (
        df[
            [
                "player",
                "name_clean",
                "stars",
                "rating",
                "ranking",
                "height",
                "weight",
                "position_clean",
                "committedTo",
                "recruit_year",
            ]
        ]
        .drop_duplicates(subset=["name_clean", "position_clean", "recruit_year"])
        .copy()
    )

    for col in numeric_features:
        profiles[col] = pd.to_numeric(profiles[col], errors="coerce")

    X = profiles[numeric_features + categorical_features].copy()

    preprocessor = ColumnTransformer(
        transformers=[
            (
                "num",
                Pipeline(
                    [
                        ("imputer", SimpleImputer(strategy="median")),
                        ("scaler", StandardScaler()),
                    ]
                ),
                numeric_features,
            ),
            (
                "cat",
                Pipeline(
                    [
                        ("imputer", SimpleImputer(strategy="most_frequent")),
                        ("onehot", OneHotEncoder(handle_unknown="ignore")),
                    ]
                ),
                categorical_features,
            ),
        ]
    )

    X_processed = preprocessor.fit_transform(X)

    knn = NearestNeighbors(n_neighbors=50, metric="euclidean")
    knn.fit(X_processed)

    return df, profiles, preprocessor, knn, numeric_features, categorical_features


df, profiles, preprocessor, knn, numeric_features, categorical_features = build_model()

import json

@st.cache_data
def load_value_mapping():
    with open("value_mapping.json", "r") as f:
        return json.load(f)


def compute_expected_value(distribution_wide, position, offer_amount):
    value_mapping = load_value_mapping()

    if position not in value_mapping:
        st.warning(f"No value mapping found for {position}. Using WR values.")
        position_values = value_mapping["WR"]
    else:
        position_values = value_mapping[position]

    ev_df = distribution_wide.copy()

    ev_df["expected_value"] = (
        ev_df["Bust"] * position_values["Bust"]
        + ev_df["Depth / Rotation"] * position_values["Depth / Rotation"]
        + ev_df["Starter"] * position_values["Starter"]
        + ev_df["Impact Player"] * position_values["Impact Player"]
    )

    ev_df["offer_amount"] = offer_amount
    ev_df["expected_surplus"] = ev_df["expected_value"] - offer_amount
    ev_df["roi"] = ev_df["expected_surplus"] / offer_amount

    return ev_df


def yearly_player_outcome_distribution(
    stars,
    rating,
    ranking,
    height,
    weight,
    position,
    committed_to,
    n_neighbors=25,
    exclude_player = None
):
    player_profile = pd.DataFrame(
        [
            {
                "stars": stars,
                "rating": rating,
                "ranking": ranking,
                "height": height,
                "weight": weight,
                "position_clean": position,
                "committedTo": committed_to,
            }
        ]
    )

    player_processed = preprocessor.transform(player_profile)

    distances, indices = knn.kneighbors(
        player_processed,
        n_neighbors=n_neighbors,
    )

    similar_profiles = profiles.iloc[indices[0]].copy()
    similar_profiles["distance"] = distances[0]

    if exclude_player is not None:
        similar_profiles = similar_profiles[
            similar_profiles["player"] != exclude_player
        ].copy()

    similar_profiles = similar_profiles.head(n_neighbors)

    similar_keys = similar_profiles[
        ["name_clean", "position_clean", "recruit_year"]
    ]

    similar_years = df.merge(
        similar_keys,
        on=["name_clean", "position_clean", "recruit_year"],
        how="inner",
    )

    distribution = (
        similar_years.groupby(["eligibility_year", "outcome"])
        .size()
        .rename("count")
        .reset_index()
    )

    distribution["probability"] = (
        distribution["count"]
        / distribution.groupby("eligibility_year")["count"].transform("sum")
    )

    distribution_wide = (
        distribution.pivot_table(
            index="eligibility_year",
            columns="outcome",
            values="probability",
            fill_value=0,
        )
        .reset_index()
    )

    for col in OUTCOME_COLS:
        if col not in distribution_wide.columns:
            distribution_wide[col] = 0

    distribution_wide = (
        distribution_wide.set_index("eligibility_year")
        .reindex([1, 2, 3, 4, 5], fill_value=0)
        .reset_index()
    )

    distribution_wide = distribution_wide[
        ["eligibility_year"] + OUTCOME_COLS
    ]

    sample_sizes = (
        similar_years.groupby("eligibility_year")
        .size()
        .reindex([1, 2, 3, 4, 5], fill_value=0)
        .reset_index(name="sample_size")
    )

    return similar_profiles, similar_years, distribution_wide, sample_sizes


def render_distribution_visuals(distribution_wide, sample_sizes):
    plot_df = distribution_wide.copy()

    for col in OUTCOME_COLS:
        if col not in plot_df.columns:
            plot_df[col] = 0

    row_sums = plot_df[OUTCOME_COLS].sum(axis=1)

    plot_df[OUTCOME_COLS] = (
        plot_df[OUTCOME_COLS]
        .div(row_sums.replace(0, pd.NA), axis=0)
        .fillna(0)
    )

    table_df = plot_df.merge(sample_sizes, on="eligibility_year", how="left")

    for col in OUTCOME_COLS:
        table_df[col] = (table_df[col] * 100).round(1).astype(str) + "%"

    table_df = table_df.rename(
        columns={
            "eligibility_year": "Year",
            "sample_size": "Sample Size",
        }
    )

    st.subheader("Year-by-Year Outcome Distribution")
    st.dataframe(table_df, use_container_width=True)

    fig, ax = plt.subplots(figsize=(10, 6))

    years = plot_df["eligibility_year"].astype(int)

    colors = {
        "Bust": "#8B0000",
        "Depth / Rotation": "#808080",
        "Starter": "#1f77b4",
        "Impact Player": "#2ca02c",
    }

    bottom = pd.Series([0] * len(plot_df), dtype=float)

    for outcome in OUTCOME_COLS:
        values = plot_df[outcome].astype(float)

        ax.bar(
            years,
            values,
            bottom=bottom,
            label=outcome,
            color=colors[outcome],
        )

        bottom = bottom + values

    ax.set_ylim(0, 1)
    ax.set_xticks([1, 2, 3, 4, 5])
    ax.set_xlabel("Eligibility Year")
    ax.set_ylabel("Probability")
    ax.set_title("Historical Outcome Distribution by Eligibility Year")
    ax.legend(title="Outcome", bbox_to_anchor=(1.05, 1), loc="upper left")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda y, _: f"{y:.0%}"))

    st.pyplot(fig)

    plot_df["expected_value"] = (
        0 * plot_df["Bust"]
        + 1 * plot_df["Depth / Rotation"]
        + 2 * plot_df["Starter"]
        + 3 * plot_df["Impact Player"]
    )

    fig2, ax2 = plt.subplots(figsize=(9, 5))

    ax2.plot(
        years,
        plot_df["expected_value"],
        marker="o",
        linewidth=3,
    )

    ax2.set_ylim(0, 3)
    ax2.set_xticks([1, 2, 3, 4, 5])
    ax2.set_xlabel("Eligibility Year")
    ax2.set_ylabel("Expected Outcome Value")
    ax2.set_title("Expected Development Trajectory")
    ax2.set_yticks([0, 1, 2, 3])
    ax2.set_yticklabels(["Bust", "Depth", "Starter", "Impact"])

    st.pyplot(fig2)


st.title("Recruit Outcome Distribution Tool")

st.write(
    "Enter a WR/TE/RB recruiting profile to find similar historical players "
    "and estimate year-by-year career outcome probabilities."
)

st.sidebar.header("Player Profile")

input_mode = st.sidebar.radio(
    "Input Mode",
    ["Use Existing Player", "Manual Entry"],
    key="input_mode",
)

if input_mode == "Use Existing Player":
    player_options = sorted(profiles["player"].dropna().unique())

    selected_player = st.sidebar.selectbox(
        "Select Player",
        player_options,
        key="existing_player_select",
    )

    selected_row = profiles[profiles["player"] == selected_player].iloc[0]

    player_name = selected_row["player"]
    stars = selected_row["stars"]
    rating = selected_row["rating"]
    ranking = selected_row["ranking"]
    height = selected_row["height"]
    weight = selected_row["weight"]
    position = selected_row["position_clean"]
    committed_to = selected_row["committedTo"]

    st.sidebar.markdown("### Loaded Profile")
    st.sidebar.markdown(
        f"""
        **Stars:** {stars}
        **Rating:** {rating:.4f}
        **Ranking:** {ranking}
        **Height:** {height}
        **Weight:** {weight}
        **Position:** {position}
        **School:** {committed_to}
        """
    )

else:
    player_name = st.sidebar.text_input(
        "Player Name",
        "Example Player",
        key="manual_player_name",
    )

    stars = st.sidebar.slider(
        "Stars",
        2,
        5,
        4,
        key="manual_stars",
    )

    rating = st.sidebar.number_input(
        "247 Composite Rating",
        min_value=0.0,
        max_value=1.0,
        value=0.940,
        step=0.001,
        format="%.3f",
        key="manual_rating",
    )

    ranking = st.sidebar.number_input(
        "National Ranking",
        min_value=1,
        max_value=5000,
        value=120,
        key="manual_ranking",
    )

    height = st.sidebar.number_input(
        "Height in Inches",
        min_value=60,
        max_value=90,
        value=74,
        key="manual_height",
    )

    weight = st.sidebar.number_input(
        "Weight",
        min_value=120,
        max_value=400,
        value=190,
        key="manual_weight",
    )

    position = st.sidebar.selectbox(
        "Position",
        sorted(profiles["position_clean"].dropna().unique()),
        key="manual_position",
    )

    committed_to = st.sidebar.selectbox(
        "Committed To",
        sorted(profiles["committedTo"].dropna().unique()),
        key="manual_school",
    )

n_neighbors = st.sidebar.slider(
    "Comparable Players",
    5,
    50,
    25,
    key="neighbor_slider",
)

offer_amount_k = st.sidebar.slider(
  "Proposed Offer ($000s)",
  min_value=0,
  max_value=1000,
  value=250,
  step=25,
  key="offer_amount_k"
  )

offer_amount = offer_amount_k * 1000

st.sidebar.markdown(
    f"""
    <h2 style='margin-top: -10px;'>
        Offer: ${offer_amount:,.0f}
    </h2>
    """,
    unsafe_allow_html=True
)

run_button = st.sidebar.button(
    "Find Historical Comps",
    key="find_comps_button",
)

if run_button:

    similar_profiles, similar_years, distribution_wide, sample_sizes = (
        yearly_player_outcome_distribution(
            stars=stars,
            rating=rating,
            ranking=ranking,
            height=height,
            weight=weight,
            position=position,
            committed_to=committed_to,
            n_neighbors=n_neighbors,
            exclude_player=player_name if input_mode == "Use Existing Player" else None
        )
    )

    st.subheader(f"Historical Comps for {player_name}")

    profile_col, metric_col = st.columns(2)

    with profile_col:
        st.markdown(
            f"""
            **Profile:** {stars}★ {position}

            **Rating:** {rating:.4f}

            **Ranking:** {ranking}

            **School:** {committed_to}
            """
        )

    with metric_col:
        st.metric("Comparable Players", n_neighbors)

    # -----------------------
    # Investment evaluation
    # -----------------------

    ev_df = compute_expected_value(
        distribution_wide=distribution_wide,
        position=position,
        offer_amount=offer_amount
    )

    display_ev = ev_df[
        [
            "eligibility_year",
            "expected_value",
            "offer_amount",
            "expected_surplus",
            "roi"
        ]
    ].copy()

    display_ev["expected_value"] = (
        display_ev["expected_value"]
        .map("${:,.0f}".format)
    )

    display_ev["offer_amount"] = (
        display_ev["offer_amount"]
        .map("${:,.0f}".format)
    )

    display_ev["expected_surplus"] = (
        display_ev["expected_surplus"]
        .map("${:,.0f}".format)
    )

    display_ev["roi"] = (
        (ev_df["roi"] * 100)
        .round(1)
        .astype(str) + "%"
    )

    display_ev = display_ev.rename(columns={
        "eligibility_year": "Year",
        "expected_value": "Expected Value",
        "offer_amount": "Offer",
        "expected_surplus": "Expected Surplus",
        "roi": "ROI"
    })

    st.subheader("Investment Evaluation")

    st.dataframe(display_ev, use_container_width=True)
    # -----------------------
    # Investment summary
    # -----------------------

    total_ev = ev_df["expected_value"].max()

    total_compensation = offer_amount

    net_value = total_ev - total_compensation

    roi_multiple = (
        total_ev / total_compensation
        if total_compensation > 0
        else np.nan
    )

    downside_probability = distribution_wide["Bust"].mean()

    st.subheader("Investment Summary")

    col1, col2, col3, col4 = st.columns(4)

    col1.metric(
        "Expected Value Ceiling",
        f"${total_ev:,.0f}"
    )

    col2.metric(
        "Net Value",
        f"${net_value:,.0f}"
    )

    col3.metric(
        "ROI",
        f"{roi_multiple:.2f}x"
    )

    col4.metric(
        "Downside Probability",
        f"{downside_probability:.1%}"
    )

    avg_expected_value = ev_df["expected_value"].mean()

    avg_surplus = avg_expected_value - offer_amount

    if avg_surplus > 0:

        st.success(
            f"""
            Estimated positive investment.

            Average expected value:
            ${avg_expected_value:,.0f}

            Estimated surplus above offer:
            ${avg_surplus:,.0f}
            """
        )

    else:

        st.error(
            f"""
            Estimated negative investment.

            Average expected value:
            ${avg_expected_value:,.0f}

            Estimated deficit below offer:
            ${abs(avg_surplus):,.0f}
            """
        )

    # -----------------------
    # Charts
    # -----------------------

    render_distribution_visuals(
        distribution_wide,
        sample_sizes
    )

    # -----------------------
    # Similar profiles
    # -----------------------

    st.subheader("Most Similar Historical Players")

    display_cols = [
        "player",
        "stars",
        "rating",
        "ranking",
        "height",
        "weight",
        "position_clean",
        "committedTo",
        "recruit_year",
        "distance",
    ]

    st.dataframe(
        similar_profiles[display_cols],
        use_container_width=True,
    )

    # -----------------------
    # Player-year rows
    # -----------------------

    st.subheader("Matched Player-Year Rows Used")

    year_display_cols = [
        "player",
        "team",
        "season",
        "eligibility_year",
        "outcome",
        "REC",
        "CAR",
        "YDS",
        "TD",
        "receiving_score",
        "rushing_score",
    ]

    available_year_cols = [
        col for col in year_display_cols if col in similar_years.columns
    ]

    st.dataframe(
        similar_years[available_year_cols],
        use_container_width=True,
    )

else:

    st.info(
        "Enter or load a player profile, then click Find Historical Comps."
    )
