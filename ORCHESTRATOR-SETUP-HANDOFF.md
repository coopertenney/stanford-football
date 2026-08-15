# Handoff — setting up your own coordination board (stanford-football)

Written 2026-08-15 by the summer-build orchestrator session, at Cooper's request, after you asked
about porting the orchestrator framework here.

---

## 0. Read this first: the recommendation is still DON'T, and it wasn't mine

You (a previous session in this project) recommended **against** porting the orchestrator framework
here, and gave the reasoning: this project is one ~677-line `app.py` plus a five-file ingest, so there
is nothing for seam-drift detection to guard, and the parallelism ceiling is set by **disjoint file
sets** — which here caps at one or two concurrent sessions. A coordination board for two sessions that
mostly edit the same file is overhead with no payoff.

I agree, and I have the comparison to hand: summer-build runs 5–7 concurrent lanes across genuinely
separate packages, and even there the honest number of *writing* sessions is 2–3. The board earns its
keep because sessions collide in `app.js`-sized shared files and because seam changes land from other
people. Neither is true here.

**So treat this document as "if you do it, do it correctly" — not as a recommendation to proceed.**

The one piece worth taking regardless is §2. It is a footgun that fires the first time anyone runs the
script here, and it fails quietly rather than loudly.

---

## 1. What the framework actually is

Three separable things. You do not need all three, and most of the value here is in the third.

| Piece | What it does | Worth it here? |
|---|---|---|
| `scripts/session-brief.py` | Baselines `origin/main` per worktree, reports which **seam paths** moved since, and runs a shared **board** so concurrent sessions can see each other | **No** — no seams, ~2 sessions max |
| Worktrees + one branch per task | Keeps concurrent sessions out of each other's working tree | **Maybe** — useful even at 2 sessions |
| The dispatch discipline (verify before relaying, never dispatch two sessions at an intersecting file set, "done, CI green" is a claim not evidence) | Judgement, not tooling | **Yes** — costs nothing, no setup |

---

## 2. 🔴 IF YOU RUN `session-brief.py` HERE, SET `PARETO_COORD_DIR` FIRST

**Verified in the script, not assumed** — `scripts/session-brief.py:101`:

```python
d = os.environ.get("PARETO_COORD_DIR") or str(Path.home() / "pareto-coord")
```

So the coordination directory defaults to `~/pareto-coord`, and **that directory is already
summer-build's**: as of 2026-08-15 it holds **104 board entries** plus `state/`, `dispatch/` and two
dated handoff folders. `PARETO_COORD_DIR` is currently **unset** on this machine.

**What goes wrong if you skip this:** nothing errors. `post` writes a football lane into summer-build's
board; `board` prints summer-build's 104 lanes back at you as if they were yours; `state/` gets keyed by
worktree slug, so two projects with similar directory names can share baseline state. You do not get a
failure — you get a board full of someone else's work and a baseline that means nothing. That is worse
than no board.

**Do this instead** — a project-local directory, so it can never collide:

```bash
export PARETO_COORD_DIR="$HOME/dev/stanford-football/.coord"
mkdir -p "$PARETO_COORD_DIR"
```

Put the export in this project's shell config or the session's own environment — **not** in a global
profile, or you invert the problem and summer-build starts writing into the football board.

⚠️ Add `.coord/` to this project's `.gitignore`. The board is live coordination state, not source; and
board entries carry free text about what a session is doing, which you do not want in git history.

---

## 3. What else you must change before the script is meaningful here

`SEAM_PATHS` in `session-brief.py` is a hardcoded summer-build list:

```
production/integration · outreach-integration · canonical-data ·
production/platform/migrations · production/platform/src/server.ts ·
production/platform/src/viewer/{accounts,fields}.ts ·
SECURITY-NORTHSTAR.md · render.yaml · .github
```

None of those exist here. Ported unchanged, the drift check can never fire — which is this repo's
**"an assertion that cannot observe what it guards"** failure mode: a check that reports green forever
is worse than no check, because the green is read as evidence.

So either replace the list with paths that are genuinely shared-and-fragile here (`app.py` is the
obvious candidate; the ingest files probably are not), or **delete the seam half entirely** and keep
only the board. Do not port it as-is.

Two smaller things:
- The script infers the repo from the working directory — it hardcodes no path — so nothing else needs
  editing for it to run.
- summer-build auto-runs it via a `SessionStart` hook: `python3 "$CLAUDE_PROJECT_DIR/scripts/session-brief.py" hook`.
  Copying that hook here means every session pays for it; only wire it up if you kept something that fires.

---

## 4. My honest read

**Take §2's isolation rule and the dispatch discipline. Leave the tooling.**

If you want one concrete thing that would help this project more than a board: use **worktrees plus one
branch per task** whenever two sessions run at once, and before dispatching the second one, write down
which files each will touch. That is the rule doing nearly all the work in summer-build — the board is
how six lanes *discover* collisions, but the discipline of not creating them is what prevents the cost.

If the project grows a second real component — an ingest layer someone else maintains, a deployed
service, anything with a boundary another session can break — revisit this. The framework earns its
keep at that point and not before.

---

## 5. Provenance, so you can weigh it

- The port question, and the recommendation against it, came from a session in this project talking to
  the summer-build orchestrator on 2026-08-14. **Cooper never confirmed a decision either way** — the
  ask was recorded as still pending with him. Do not read this document as approval to proceed.
- The `PARETO_COORD_DIR` default, the 104 board entries, the unset env var, the `SEAM_PATHS` contents
  and the hook command were all **checked directly** on 2026-08-15, not relayed.
- Everything about whether the framework is *worth* porting is judgement, mine and the earlier
  session's. The mechanics in §2 and §3 are facts.
