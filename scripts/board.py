#!/usr/bin/env python3
"""
board.py — lane coordination for concurrent sessions on stanford-football.

    python3 scripts/board.py post --lane roi-fix --files app.py --doing "fix ROI to EV/C"
    python3 scripts/board.py list
    python3 scripts/board.py drop --lane roi-fix

WHY THIS EXISTS

Concurrent sessions live in separate worktrees, so a file written in one is invisible to the
others until it is committed, pushed and pulled. Git is the wrong transport for live
coordination. This board lives OUTSIDE every worktree, one JSON file per lane, write-your-own /
read-all-others — so write conflicts are structurally impossible.

DELIBERATELY NOT A PORT of summer-build's scripts/session-brief.py. Two differences, both
load-bearing:

  1. NO SEAM-DRIFT HALF. That script baselines origin/main and reports which shared "seam"
     paths moved since your session started. It is the right tool for a repo where several
     people maintain packages you build against. Here there is one app.py and a five-file
     ingest with a single author, so a seam list would match nothing — and a check that can
     never fire reports green forever, which is worse than no check because the green gets
     read as evidence. If this project ever grows a component someone else maintains, add
     that half then, not now.

  2. PROJECT-LOCAL COORDINATION DIRECTORY. session-brief.py defaults to ~/pareto-coord, which
     already holds 105 summer-build lanes. Sharing it would print another project's sessions
     back as if they were yours, silently. This script's default is INSIDE the repo
     (.coord/, gitignored) and cannot collide with anything.

WHAT THIS CANNOT SEE, so a quiet board is not read as "nobody is working":

  - A session that never posted. The board is opt-in; §4 ingredient 2 of
    ORCHESTRATOR-INSTRUCTIONS.md is what makes posting happen, and nothing enforces it.
  - Files an agent touches beyond what it declared. `--files` is a claim by the agent, not an
    observation of its diff. `list --check` compares declarations against each other, never
    against reality.
  - Anything about whether work is correct. That is scripts/check.py's job.

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STALE_HOURS = 24


def coord_dir() -> Path:
    # Project-local by default. Overridable, but never shared with another project's board.
    d = os.environ.get("FOOTBALL_COORD_DIR") or str(ROOT / ".coord")
    p = Path(d) / "board"
    p.mkdir(parents=True, exist_ok=True)
    return p


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def age_hours(iso: str) -> float | None:
    try:
        then = datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return None
    return (datetime.now(timezone.utc) - then).total_seconds() / 3600


def git(*args: str) -> str | None:
    out = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else None


def current_branch() -> str:
    """Two distinct not-a-branch states, because they need OPPOSITE handling.

    git answers 'HEAD' for a detached worktree and only ever returns empty when the CALL
    FAILED. Folding those into one sentinel means a git failure reads as a deliberate
    accommodation — a real defect in the script this one learns from. A caller must be able to
    tell 'no branch' from 'could not ask'.
    """
    out = git("rev-parse", "--abbrev-ref", "HEAD")
    if out is None:
        return "(git-failed)"
    if out == "HEAD":
        return "(detached)"
    return out


def lane_path(lane: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in lane)
    if not safe:
        raise SystemExit("lane name reduced to nothing after sanitising")
    return coord_dir() / f"{safe}.json"


def cmd_post(args) -> int:
    files = [f.strip() for f in (args.files or "").split(",") if f.strip()]
    entry = {
        "lane": args.lane,
        "branch": current_branch(),
        "worktree": str(ROOT),
        "files": files,
        "doing": args.doing or "",
        "updated": now(),
    }
    p = lane_path(args.lane)
    p.write_text(json.dumps(entry, indent=2) + "\n")
    print(f"posted lane '{args.lane}' -> {p}")
    if not files:
        print("  ⚠️  no --files declared. Arbitration (§3) cannot see this lane's footprint,")
        print("      so it will not appear in any overlap warning. Declare them.")
    return 0


def cmd_drop(args) -> int:
    p = lane_path(args.lane)
    if p.exists():
        p.unlink()
        print(f"dropped lane '{args.lane}'")
    else:
        print(f"no such lane '{args.lane}' (nothing to drop)")
    return 0


def load_all() -> list[dict]:
    out = []
    for f in sorted(coord_dir().glob("*.json")):
        try:
            out.append(json.loads(f.read_text()))
        except (OSError, json.JSONDecodeError) as e:
            # A corrupt entry must be visible, not skipped — a lane you cannot read is a lane
            # whose files you cannot arbitrate against.
            out.append({"lane": f.stem, "_unreadable": f"{type(e).__name__}: {e}"})
    return out


def cmd_list(args) -> int:
    entries = load_all()
    if not entries:
        print("board is empty.")
        print("  Not evidence nobody is working: posting is opt-in and nothing enforces it.")
        return 0

    print(f"board — {len(entries)} lane(s)   [{coord_dir()}]\n")
    owners: dict[str, list[str]] = {}
    for e in entries:
        if e.get("_unreadable"):
            print(f"  🔴 {e['lane']}: UNREADABLE — {e['_unreadable']}")
            continue
        a = age_hours(e.get("updated", ""))
        stale = " ⚠️ STALE" if a is not None and a > STALE_HOURS else ""
        age = f"{a:.1f}h ago" if a is not None else "unknown age"
        print(f"  ── {e['lane']}  · {age}{stale}")
        print(f"       branch:  {e.get('branch','?')}")
        print(f"       doing:   {e.get('doing') or '(not stated)'}")
        print(f"       files:   {', '.join(e.get('files') or ['(none declared)'])}")
        for f in e.get("files") or []:
            owners.setdefault(f, []).append(e["lane"])
        print()

    clashes = {f: ls for f, ls in owners.items() if len(ls) > 1}
    if clashes:
        print("🔴 OVERLAPPING FILE CLAIMS — do not dispatch into these (§3):")
        for f, ls in sorted(clashes.items()):
            print(f"     {f}  claimed by: {', '.join(ls)}")
        print("   Options are exactly three: wait, re-scope, or sequence.")
        return 1

    print("no overlapping file claims among DECLARED sets.")
    print("  This compares declarations against each other, never against any agent's actual")
    print("  diff — an undeclared edit is invisible here.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("post", help="write/update this session's lane entry")
    p.add_argument("--lane", required=True, help="short lane name, e.g. roi-fix")
    p.add_argument("--files", help="comma-separated files this lane will EDIT")
    p.add_argument("--doing", help="one line: what you are doing")
    p.set_defaults(fn=cmd_post)

    p = sub.add_parser("list", help="print all lanes; exits 1 on overlapping claims")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("drop", help="remove a lane entry")
    p.add_argument("--lane", required=True)
    p.set_defaults(fn=cmd_drop)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
