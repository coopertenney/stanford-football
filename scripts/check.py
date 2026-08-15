#!/usr/bin/env python3
"""
check.py — the repo's one gate. Run it before you commit, and after you change anything
about the data pipeline.

    python3 scripts/check.py            # everything
    python3 scripts/check.py --only data
    python3 scripts/check.py --list

WHY THIS EXISTS, AND WHY IT IS NOT A TEST SUITE

This project's failure modes are not "a function returned the wrong value." They are:

  1. Notes rot. `src/ingest/` existed for weeks and was mentioned in no doc, so a reader
     would conclude the TS rewrite did not exist.
  2. Claims nobody checked. "That API key is already effectively committed" was false —
     there was no repository — and it nearly licensed a real leak.
  3. The model's numbers are wrong in ways nothing detects, and the tool outputs dollar
     figures that people use to make recruiting offers.

So the checks here are mostly ASSERTIONS ABOUT FACTS, not about behavior.

FOUR STATUSES — the middle two are the point

  PASS         invariant holds.
  FAIL         real defect. Exits 1.
  KNOWN-BAD    a documented distortion is still present AND matches scripts/baseline.json.
               Exits 0, prints loudly. This is NOT a pass — it means "still broken, as
               recorded." A gate that stayed red on known breakage would just get `|| true`
               appended, and then it protects nothing.
  CHANGED      reality diverged from baseline.json IN EITHER DIRECTION. Exits 1.
               This is the whole design. Fixing a distortion is as noteworthy as
               regressing one: both need a human to look and update the ledger.
  CANNOT-SEE   an input is missing, so the check did not run. Exits 0 but is NEVER
               reported as a pass, and always says what would make it see.

WHAT THIS GATE CANNOT SEE, stated so nobody reads a green run as more than it is:

  - It does not run app.py or instantiate the KNN model, so it cannot catch the ROI/EV
    formula bugs, and it cannot verify that a relabeling preserved the model's ordering.
    `model_signal.knn_ordering` in baseline.json is a HAND measurement, flagged
    checked_by_script: false.
  - It does not test correctness of the ingest, only the shape of its output.
  - The secret scan is a pattern match over tracked files. It catches the shape of a key,
    not a key it has never seen. It is a tripwire, not a guarantee.
  - It reads the working tree, not the index. `git add`ed-but-modified files are checked
    as they exist on disk.

Stdlib only, except pandas for the data checks (which degrade to CANNOT-SEE without it).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = ROOT / "scripts" / "baseline.json"

PASS, FAIL, KNOWN_BAD, CHANGED, CANNOT_SEE = "PASS", "FAIL", "KNOWN-BAD", "CHANGED", "CANNOT-SEE"

ICON = {PASS: "✓", FAIL: "✗", KNOWN_BAD: "▲", CHANGED: "!", CANNOT_SEE: "?"}
# Only FAIL and CHANGED are actionable-and-blocking. See the docstring.
EXIT_NONZERO = {FAIL, CHANGED}

results: list[tuple[str, str, str, list[str]]] = []  # (group, status, headline, detail lines)


def report(group: str, status: str, headline: str, detail: list[str] | str | None = None) -> None:
    if detail is None:
        detail = []
    elif isinstance(detail, str):
        detail = [detail]
    results.append((group, status, headline, detail))


def git(*args: str) -> str:
    out = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True
    )
    if out.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {out.stderr.strip()}")
    return out.stdout


def tracked_files() -> list[str]:
    return [p for p in git("ls-files", "-z").split("\0") if p]


def load_baseline() -> dict | None:
    try:
        return json.loads(BASELINE_PATH.read_text())
    except FileNotFoundError:
        return None


def near(got: float, want: float, tol: float) -> bool:
    return abs(got - want) <= tol


# ======================================================================================
# secrets
# ======================================================================================

# A hardcoded credential looks like a long opaque literal assigned to a key-ish name.
SECRET_ASSIGN = re.compile(
    r"""(?ix)
    \b (api[_-]?key | secret | token | password | bearer) \b
    \s* [:=] \s*
    ["'] ([A-Za-z0-9+/=_\-]{20,}) ["']
    """
)
# Sites that must read from the environment rather than a literal.
KEY_SITES = {
    "gather_rb_data.py": "CFBD_API_KEY",
    "src/ingest/cfbd.ts": "CFBD_API_KEY",
    "Football_Player_Tool_v1_PDR.ipynb": "CFBD_API_KEY",
}
SCAN_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".mjs", ".json", ".ipynb", ".sh", ".yml", ".yaml", ".md", ".txt"}


def check_secrets() -> None:
    g = "secrets"
    hits = []
    for rel in tracked_files():
        p = ROOT / rel
        if p.suffix.lower() not in SCAN_SUFFIXES or not p.is_file():
            continue
        try:
            text = p.read_text(errors="replace")
        except OSError:
            continue
        for m in SECRET_ASSIGN.finditer(text):
            line = text[: m.start()].count("\n") + 1
            # An env read is the correct pattern, not a hit.
            ctx = text[max(0, m.start() - 80) : m.end()]
            if "os.environ" in ctx or "process.env" in ctx or "getenv" in ctx:
                continue
            hits.append(f"{rel}:{line} — {m.group(1)} assigned a {len(m.group(2))}-char literal")
    if hits:
        report(g, FAIL, f"{len(hits)} hardcoded-credential shape(s) in TRACKED files", hits + [
            "Read it from the environment instead. See .env.example.",
            "If this is a false positive, it is still worth renaming the variable.",
        ])
    else:
        report(g, PASS, "no hardcoded-credential shapes in tracked files",
               "Tripwire only: matches the SHAPE of a key. It cannot catch one it has never seen.")

    for rel, var in KEY_SITES.items():
        p = ROOT / rel
        if not p.exists():
            report(g, CANNOT_SEE, f"{rel} is missing — cannot confirm it reads {var}",
                   f"Expected at {rel}. If it was renamed, update KEY_SITES in this script.")
            continue
        text = p.read_text(errors="replace")
        if var in text:
            report(g, PASS, f"{rel} references {var}")
        else:
            report(g, FAIL, f"{rel} does NOT reference {var}",
                   "Every key site must read from the environment. A new hardcoded copy is the "
                   "exact regression this checks for.")


# ======================================================================================
# hygiene
# ======================================================================================

MAX_TRACKED_MB = 10


def check_hygiene() -> None:
    g = "hygiene"

    # gitignore trailing-comment footgun. This is a REAL bug that happened here: writing
    # `cfbd_cache/   # 329M` makes the pattern literally "cfbd_cache/   # 329M", which
    # matches nothing, and 822 files (329M) staged silently.
    gi = ROOT / ".gitignore"
    if not gi.exists():
        report(g, FAIL, ".gitignore is missing")
    else:
        bad = []
        for i, raw in enumerate(gi.read_text().splitlines(), 1):
            s = raw.strip()
            if not s or s.startswith("#"):
                continue
            if "#" in s:
                bad.append(f".gitignore:{i} — {s!r}")
        if bad:
            report(g, FAIL, f"{len(bad)} gitignore pattern(s) with an inline comment", bad + [
                "gitignore has NO trailing-comment syntax: the whole line, spaces and '#' "
                "included, is the pattern — so it matches nothing and the path gets tracked.",
                "Move the comment to its own line.",
            ])
        else:
            report(g, PASS, "no gitignore patterns carry inline comments")

    # Nothing ignored may be tracked. `git ls-files -i -c` asks git directly rather than
    # re-implementing the match rules.
    ignored_tracked = [p for p in git("ls-files", "-z", "-i", "-c", "--exclude-standard").split("\0") if p]
    if ignored_tracked:
        report(g, FAIL, f"{len(ignored_tracked)} tracked file(s) match a gitignore rule",
               ignored_tracked[:20] + ([f"... and {len(ignored_tracked)-20} more"] if len(ignored_tracked) > 20 else []) + [
                   "Untrack with: git rm --cached <path>",
               ])
    else:
        report(g, PASS, "no tracked file matches a gitignore rule")

    big = []
    for rel in tracked_files():
        p = ROOT / rel
        if p.is_file():
            mb = p.stat().st_size / 1_048_576
            if mb > MAX_TRACKED_MB:
                big.append(f"{rel} — {mb:.1f} MB")
    if big:
        report(g, FAIL, f"{len(big)} tracked file(s) over {MAX_TRACKED_MB} MB", big + [
            "Regenerable data belongs in .gitignore. If it is genuinely a source input, "
            f"raise MAX_TRACKED_MB in this script deliberately.",
        ])
    else:
        report(g, PASS, f"no tracked file exceeds {MAX_TRACKED_MB} MB")


# ======================================================================================
# docs
# ======================================================================================

# Things that must be findable in CLAUDE.md, because their ABSENCE from the notes is what
# actually went wrong: src/ingest/ existed unmentioned for weeks.
MUST_BE_DOCUMENTED = ["app.py", "gather_rb_data.py", "src/ingest", "value_mapping.json", "requirements.txt"]

# Claims that were true once and are now false. Each is (regex, why it is stale).
STALE_CLAIMS = [
    (r"not a git repo", "the repo is git-tracked as of 2026-08-15"),
    (r"no `?requirements\.txt`?", "requirements.txt exists"),
    (r"no README", "README.md exists"),
    (r"already[- ]committed", "the old key never entered git history; it was scrubbed pre-init"),
]


def check_docs() -> None:
    g = "docs"
    cm = ROOT / "CLAUDE.md"
    if not cm.exists():
        report(g, FAIL, "CLAUDE.md is missing")
        return
    text = cm.read_text()

    missing = [m for m in MUST_BE_DOCUMENTED if m not in text]
    if missing:
        report(g, FAIL, f"{len(missing)} component(s) absent from CLAUDE.md", [
            *missing,
            "A component missing from the notes reads as nonexistent to the next reader. "
            "That is exactly how src/ingest/ went unmentioned for weeks.",
        ])
    else:
        report(g, PASS, "every tracked component is mentioned in CLAUDE.md",
               "Substring check only — it cannot tell an accurate description from a stale one.")

    # A mention is only a STALE CLAIM if the surrounding paragraph asserts it. Text that
    # quotes the claim in order to correct or forbid it is discussion, not assertion — and
    # this repo's docs do exactly that deliberately, since a superseded dated record is
    # stale rather than wrong and should not be deleted.
    #
    # Scope is the containing PARAGRAPH, not a fixed character window. A ±200-char window
    # produced a false positive on this project's own CLAUDE.md: the sentence naming
    # "already committed" as a forbidden claim sat further than 200 chars from the
    # "was false" that negates it.
    # Bare "false" is included deliberately. `"was false"` alone was too narrow: compressing a
    # paragraph during a docs trim shortened "That was false and it mattered" to "the false
    # ... note", and the check flagged its own project's corrected prose. A paragraph that
    # contains the word "false" near the claim is discussing it, not asserting it.
    NEGATORS = ("~~", "corrects", "false", "never", "not true", "stale",
                "corrected", "do not", "don't", "forbidden", "wrongly")

    def paragraph_around(pos: int) -> str:
        start = text.rfind("\n\n", 0, pos) + 2
        end = text.find("\n\n", pos)
        return text[start : end if end != -1 else len(text)]

    stale = []
    for pat, why in STALE_CLAIMS:
        for m in re.finditer(pat, text, re.I):
            line = text[: m.start()].count("\n") + 1
            para = paragraph_around(m.start()).lower()
            if any(n in para for n in NEGATORS):
                continue
            stale.append(f"CLAUDE.md:{line} — {m.group(0)!r}: {why}")
    if stale:
        report(g, FAIL, f"{len(stale)} stale claim(s) in CLAUDE.md", stale + [
            "Correct it in place, or strike it with ~~ and say what replaced it. A dated "
            "record that has been superseded is STALE, not wrong — do not just delete it.",
        ])
    else:
        report(g, PASS, "no known-stale claims in CLAUDE.md")

    if not (ROOT / "DECISIONS.md").exists():
        report(g, FAIL, "DECISIONS.md is missing",
               "CLAUDE.md is rules + current state. Dated findings, measurements and "
               "reversals go in DECISIONS.md, or CLAUDE.md grows until nobody reads it.")
    else:
        report(g, PASS, "DECISIONS.md exists")


# ======================================================================================
# data — the characterization ledger
# ======================================================================================


def check_data() -> None:
    g = "data"
    base = load_baseline()
    if base is None:
        report(g, CANNOT_SEE, "scripts/baseline.json is missing — no data checks ran",
               "Without a ledger there is nothing to diverge from. Restore it from git.")
        return
    try:
        import pandas as pd
    except ImportError:
        report(g, CANNOT_SEE, "pandas not importable — no data checks ran",
               "Install deps: .venv/bin/pip install -r requirements.txt, then run with .venv/bin/python")
        return

    outcomes = ROOT / "yearly_player_outcomes.csv"
    if not outcomes.exists():
        report(g, CANNOT_SEE, "yearly_player_outcomes.csv is missing — no data checks ran",
               "Rebuild it: see README 'Data pipeline'.")
        return
    df = pd.read_csv(outcomes)

    # --- shape -----------------------------------------------------------------------
    ds = base["dataset"]
    for key, got in (("rows", len(df)), ("distinct_players", df.name_clean.nunique())):
        want = ds[key]["value"]
        if got == want:
            report(g, PASS, f"{key} = {got}")
        else:
            report(g, CHANGED, f"{key}: baseline {want}, now {got}", [
                ds[key]["what"],
                f"why it is pinned: {ds[key].get('why_pinned', 'shape regression tripwire')}",
                "If intended, update scripts/baseline.json and record why in DECISIONS.md.",
            ])

    # --- distortion 1: labels are the cut points --------------------------------------
    d = base["distortions"]["outcome_labels_are_percentile_buckets"]
    shares = (df.outcome.value_counts(normalize=True) * 100).round(2).to_dict()
    tol = d["tolerance_pp"]
    drift = {k: (v, shares.get(k)) for k, v in d["value"].items()
             if shares.get(k) is None or not near(shares[k], v, tol)}
    cuts_pct = [25.0, 35.0, 25.0, 15.0]  # what 0.25/0.60/0.85 mechanically produces
    still_cuts = all(
        any(near(s, c, tol) for c in cuts_pct) for s in shares.values()
    )
    if drift:
        report(g, CHANGED, "outcome distribution moved off its recorded baseline", [
            *[f"  {k}: baseline {w}%, now {gotv}%" for k, (w, gotv) in drift.items()],
            f"still matches the {d['cut_points']} cut points: {still_cuts}",
            "If you fixed the labeling (fix-order item 1), this is the expected result — "
            "update baseline.json, flip status to 'good', and record it in DECISIONS.md.",
            f"fixed looks like: {d['what_fixed_looks_like']}",
        ])
    elif still_cuts:
        report(g, KNOWN_BAD, "outcome labels are still percentile buckets, as recorded", [
            "  " + ", ".join(f"{k} {v}%" for k, v in shares.items()),
            f"these ARE the cut points {d['cut_points']} — a definitional artifact, not a finding",
            f"fix-order item {d['fix_order_item']}; fixed looks like: {d['what_fixed_looks_like']}",
        ])
    else:
        report(g, PASS, "outcome distribution no longer tracks the cut points")

    # --- distortion 2: no year signal --------------------------------------------------
    d2 = base["distortions"]["outcome_shares_uniform_across_years"]
    if "eligibility_year" in df.columns:
        tab = pd.crosstab(df.eligibility_year, df.outcome, normalize="index") * 100
        spread = float((tab.max() - tab.min()).max())
        want, tol2 = d2["value_max_spread_pp"], d2["tolerance_pp"]
        if near(spread, want, tol2):
            report(g, KNOWN_BAD, f"outcome shares still ~uniform across eligibility years (spread {spread:.2f}pp)", [
                "a real distribution shifts with year — year-1 freshmen should bust far more",
                f"fix-order item {d2['fix_order_item']}; fixed looks like: {d2['what_fixed_looks_like']}",
            ])
        else:
            report(g, CHANGED, f"year-to-year spread: baseline {want}pp, now {spread:.2f}pp", [
                "Growing spread is the SUCCESS signal for fix-order item 1.",
                "Update baseline.json if intended.",
            ])
    else:
        report(g, CANNOT_SEE, "no eligibility_year column — year-uniformity check did not run",
               "Column was renamed or dropped; update this script.")

    # --- distortion 3: survivorship ----------------------------------------------------
    d3 = base["distortions"]["survivorship_non_participants_missing"]
    rec_files = sorted((ROOT / "cfbd_data").glob("recruits_*.csv")) if (ROOT / "cfbd_data").exists() else []
    if not rec_files:
        report(g, CANNOT_SEE, "cfbd_data/recruits_*.csv absent — survivorship check did NOT run", [
            f"needs: {d3['needs']}",
            "This is the single most important distortion (fix-order item 2) and it is the one "
            "a clean clone cannot verify, because its denominator is gitignored.",
            f"last measured {d3['measured_on']}: coverage {d3['value']['coverage_pct']}%, "
            f"missing {d3['value']['missing_pct']}%",
        ])
    else:
        rec = pd.concat([pd.read_csv(f) for f in rec_files], ignore_index=True)
        sub = rec[rec["position"].isin({"WR", "RB", "TE"})]
        cov = round(df.name_clean.nunique() / len(sub) * 100, 1)
        want3, tol3 = d3["value"]["coverage_pct"], d3["tolerance_pp"]
        if near(cov, want3, tol3):
            report(g, KNOWN_BAD, f"non-participants still missing: {cov}% of recruits covered", [
                f"{len(sub)} recruits pulled, {df.name_clean.nunique()} in outcomes — "
                f"the missing {round(100-cov,1)}% are the real busts",
                "'Bust' therefore means 'bottom quartile of players who already made the field'",
                f"fix-order item {d3['fix_order_item']}; fixed looks like: {d3['what_fixed_looks_like']}",
            ])
        else:
            report(g, CHANGED, f"recruit coverage: baseline {want3}%, now {cov}%", [
                "Rising coverage is the SUCCESS signal for fix-order item 2 (inverted merge).",
                "Expect the Bust share to rise sharply at the same time — if it did not, the "
                "merge changed but the labeling did not follow.",
            ])

    # --- distortion 4: P4 scoping -------------------------------------------------------
    d4 = base["distortions"]["no_power4_scoping"]
    P4 = {"ACC", "Big Ten", "Big 12", "SEC", "Pac-12"}
    p4 = round(df.conference.isin(P4).mean() * 100, 1)
    teams = int(df.team.nunique())
    if near(p4, d4["value"]["p4_p5_share_pct"], d4["tolerance_pp"]):
        report(g, KNOWN_BAD, f"comparable pool still unscoped: {teams} teams, {p4}% P4/P5", [
            "PDR §3.1.4 asks for ACC / Power 4 scoping; Sun Belt, MAC etc. distort the ranks",
            f"fixed looks like: {d4['what_fixed_looks_like']}",
        ])
    else:
        report(g, CHANGED, f"P4/P5 share: baseline {d4['value']['p4_p5_share_pct']}%, now {p4}%",
               "Update baseline.json if intended.")

    # --- what the ledger says it cannot check ------------------------------------------
    ms = base["model_signal"]["knn_ordering"]
    if not ms.get("checked_by_script", False):
        report(g, CANNOT_SEE, "KNN ordering is NOT verified by this script", [
            f"why: {ms['why_not']}",
            f"hand-measured {ms['measured_on']}: " + ", ".join(f"{k}={v}" for k, v in ms["value"].items()),
            "A relabeling under fix items 1-2 must PRESERVE this ordering. If it inverts, the "
            "fix broke the model — and nothing here will tell you.",
        ])


# ======================================================================================

GROUPS = {"secrets": check_secrets, "hygiene": check_hygiene, "docs": check_docs, "data": check_data}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", action="append", choices=sorted(GROUPS), help="run only these groups")
    ap.add_argument("--list", action="store_true", help="list groups and exit")
    args = ap.parse_args()

    if args.list:
        for name in GROUPS:
            print(name)
        return 0

    for name in (args.only or list(GROUPS)):
        try:
            GROUPS[name]()
        except Exception as e:  # a crashing check must not read as a passing one
            report(name, FAIL, f"check group '{name}' crashed: {type(e).__name__}: {e}",
                   "A crash is not a pass. Fix the check or the input.")

    width = max(len(s) for s in ICON.values())
    last_group = None
    for group, status, headline, detail in results:
        if group != last_group:
            print(f"\n\033[1m{group}\033[0m")
            last_group = group
        print(f"  {ICON[status]:<{width}} {status:<10} {headline}")
        for line in detail:
            print(f"       {line}")

    counts: dict[str, int] = {}
    for _, status, _, _ in results:
        counts[status] = counts.get(status, 0) + 1

    print("\n" + "-" * 78)
    print("  ".join(f"{ICON[s]} {s} {counts[s]}" for s in (PASS, KNOWN_BAD, CANNOT_SEE, CHANGED, FAIL) if s in counts))

    blocking = sum(counts.get(s, 0) for s in EXIT_NONZERO)
    if blocking:
        print(f"\n\033[1mRED\033[0m — {blocking} blocking result(s). CHANGED means the ledger and reality")
        print("disagree; decide which is right, then update scripts/baseline.json or the code.")
        return 1

    if counts.get(KNOWN_BAD):
        print(f"\n\033[1mGREEN, with {counts[KNOWN_BAD]} known-bad\033[0m — nothing regressed, and nothing")
        print("was fixed either. KNOWN-BAD is not a pass: see scripts/baseline.json for the")
        print("distortions still present and DECISIONS.md for the agreed fix order.")
    else:
        print("\n\033[1mGREEN\033[0m")
    if counts.get(CANNOT_SEE):
        print(f"{counts[CANNOT_SEE]} check(s) could not see their input — read them above; they are not passes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
