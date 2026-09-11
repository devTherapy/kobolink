# Start here

Everything for Kobolink is in this one folder. **Ignore the earlier archives from
this conversation** — `kobolink-foundation.tar.gz` was built against Firebase and
roughly half of it is now dead. Whatever survived that change is in `salvage/`
below, and nothing else from it is worth keeping.

---

## What's in the box

```
START-HERE.md          you are here
PLAN.md                the build: 4 backlogs, dependency graph, status table
ORCHESTRATION.md       how the agents coordinate, and what doesn't exist
docs/DESIGN-SPEC.md    the WHY — architecture, data model, deep links, design
.claude/
  agents/              orchestrator · backend · frontend · ios · android
  hooks/               commit guard (blocks main, blocks a red gate)
  settings.json        wires the hook
  skills/              9 vendored skills (Vercel · ui-ux-pro-max · impeccable)
salvage/               code from the Firebase build that survived unchanged
.gitignore
```

Two design canvases live outside the repo, in your artifact gallery:
**Kobolink Screens** (web) and **Kobolink Mobile** (flow map + native screens).

## Read in this order

1. **`PLAN.md`** — 10 minutes. What gets built, in what order, by whom.
2. **`ORCHESTRATION.md`** — 5 minutes. How the agents stay in sync, and the one
   thing people expect that doesn't exist.
3. **`docs/DESIGN-SPEC.md`** — reference. Read §3 (data model) and §6 (deep
   links) properly; skim the rest until you need it.

---

## Run it

```bash
cd ~/Desktop/personal/kobolink
tar -xzf ~/Downloads/kobolink-repo.tar.gz --strip-components=1
./bootstrap.sh
CLAUDE_CODE_RETRY_WATCHDOG=1 claude --permission-mode auto
```

`bootstrap.sh` checks your tools, makes the repo and pushes it to GitHub. There
is no branch protection; the orchestrator's merge rule is the gate. Then paste the prompt from **`RUN.md`** and walk away.

That prompt sets a `/goal` — *every row in PLAN.md is done or blocked* — and
hands the work to the orchestrator, which loops: find what's ready, dispatch the
domain agents in parallel, run the gate, run `/code-review`, run the adversarial
`reviewer` agent, send back anything blocked, merge what passes, append the PR
link to `PR-LOG.md`, repeat.

You do nothing until it stops.

## What you get back

**`PR-LOG.md`** — one row per merged feature with its PR link, in the order they
landed. That is your audit trail: read it top to bottom and each link is one
feature, with the reasoning in the description and the review findings in the
thread.

## When it will legitimately stop

- **X3 hosting** — you pick a host and add one DNS record for `pay`. Nothing
  before it needs a decision.
- **A feature blocked three times** gets marked `blocked` and skipped rather than
  ground on. Check those rows when you come back.
- **`/goal` gives up.** It is best-effort, not a guarantee. Re-running the same
  prompt picks up from `PLAN.md` — which is exactly why the plan lives in a file
  and not in a conversation.

Resume with:

```bash
CLAUDE_CODE_RETRY_WATCHDOG=1 claude --permission-mode auto --continue
```

---

## Who does what now

| | |
|---|---|
| **You** | Run bootstrap, paste the prompt, choose a host at X3, read `PR-LOG.md` afterwards |
| **Orchestrator** | Dispatches, reviews, merges, logs. Owns `PLAN.md`, `packages/contracts`, `PR-LOG.md` |
| **backend · frontend · ios · android** | One domain each, each in its own worktree |
| **reviewer** | Adversarial pass on every diff — sees the change and the acceptance criteria, never the author's reasoning |

## What's guarding it

| Guard | Stops |
|---|---|
| `guard-commit.sh` | Commits on `main`; commits while typecheck or lint is red |
| `keep-going.sh` | The agent stopping while `PLAN.md` still has work |
| `permissions.deny` | Force pushes, `--admin` merges, `sudo`, repo deletion, reading `.env` and keys |
| The merge rule | Nothing merges without five green checks and a reviewer PASS (no GitHub branch protection, by choice) |
| The reviewer | Merging a broken non-negotiable, an unmet acceptance condition, or a test that cannot fail |

## The one thing worth knowing before you walk away

The gate catches broken code. What it cannot catch is code that is green,
plausible, and subtly not what you meant — and that is the realistic failure mode
of an unattended build.

`/code-review` runs in a fresh subagent and the `reviewer` agent sees only the
diff, so neither is grading its own homework. That is meaningfully better than
self-review usually is. It is still not you.

Since the point of this project is studying the implementation afterward, skim
the PRs as they land rather than only at the end. A wrong decision caught at PR
three is a conversation; caught at PR twenty it is a rewrite.

## Also worth knowing

- **Auto mode needs Pro, Max or Team.** Without it, drop the flag — the
  allowlist still covers most of the run and you will get occasional prompts.
- **Docker must be running** for the API integration tests.
- **Mobile only works on this Mac.** No Xcode or Android SDK in a cloud session.
- **Rate limits, not dollars, are what stops a Max plan.** Opus and Sonnet are
  capped separately, so the orchestrator and reviewer run on Opus and the four
  domain agents on Sonnet. Check `/usage` when you return.
