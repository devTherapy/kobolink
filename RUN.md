# Run the build

Point Claude Code at this file. It executes everything in `PLAN.md` and stops
when there is nothing left to build.

```bash
cd ~/Desktop/personal/kobolink
./bootstrap.sh                    # once: git repo, GitHub, first commit
CLAUDE_CODE_RETRY_WATCHDOG=1 claude --permission-mode auto
```

Then paste this and walk away:

```
Read RUN.md, PLAN.md and CLAUDE.md.

/goal Every row in PLAN.md has status done or blocked, and PR-LOG.md has one
entry for each done row.

Use the orchestrator agent. Work the loop in its definition: find the ready set,
dispatch domain agents in parallel, run the gate, run /code-review, run the
reviewer agent, send back anything blocked, merge what passes, append to
PR-LOG.md, repeat. Do not stop to check in. Do not ask me to review or merge.

Stop only when the goal is met, or when a decision is genuinely mine to make —
and then tell me exactly what you need.
```

## What it will do

| | |
|---|---|
| Wave 0 | Builds the monorepo, five CI jobs, and `packages/contracts` itself |
| Wave 1–2 | Dispatches backend, frontend and mobile agents in parallel, each in its own git worktree |
| Every PR | Gate → `/code-review` → adversarial `reviewer` agent → fix → merge |
| Every merge | A row in `PR-LOG.md` with the PR link |

`PR-LOG.md` is your audit trail. Read it top to bottom afterwards and each link
is one feature, with the reasoning in the description and the review findings in
the thread.

## What will stop it, legitimately

- **X3 hosting** needs you to choose a host and add one DNS record for `pay`.
  Everything before it runs on localhost.
- **Mobile features** need Xcode and the Android SDK. They run on this Mac and
  nowhere else, so they are the likeliest to stall.
- A feature that fails review three times gets marked `blocked` and skipped
  rather than ground on.

## The honest caveats

**`/goal` is best-effort.** It keeps the session working across turns toward a
verifiable condition, with idle check-ins. It is not a guarantee, and the
evaluator can decide a condition is unreachable and stop. If it stops early,
re-running the same prompt picks up where `PLAN.md` says it left off — that is
the whole reason the plan lives in a file rather than in context.

**Self-review has a ceiling.** `/code-review` runs in a fresh subagent, and the
`reviewer` agent sees only the diff and the acceptance criteria. Both are far
better than an agent grading its own homework. Neither is you. The failure mode
you should expect is not broken code — the gate catches that — but code that is
green, plausible, and subtly not what you wanted. Since the point of this project
is studying the implementation afterward, skim the PRs as they land rather than
only at the end.

**Auto mode needs Pro, Max or Team.** Without it, drop `--permission-mode auto`
and the allowlist in `.claude/settings.json` still covers most of the run — you
will get occasional prompts.

**On a Max plan, dollars are not the constraint — rate limits are.** There is no
per-dollar meter to cap; usage runs against 5-hour session windows and a weekly
cap, and **Opus and Sonnet are limited separately**. Hitting a limit stops the
session with an error; you can `/model` to the other one and carry on, or wait
for the reset.

So the protection here is model tiering, not a budget flag. The orchestrator and
the reviewer run on **Opus** — dispatch decisions and adversarial review are
exactly where the stronger model pays for itself. The four domain agents run on
**Sonnet**: they implement well-specified features against a fixed contract, with
a test gate and an adversarial reviewer behind them. That keeps the bulk of the
token spend off your Opus limit, which is the one that will actually lock you out.

If review quality slips, flip a domain agent to `model: opus` in its definition
and accept the shorter runway.

`CLAUDE_CODE_RETRY_WATCHDOG=1` makes the session retry through transient rate
limits rather than dying on the first one.

Check `/usage` when you come back — on a subscription it shows your plan usage
bars, not a dollar figure. If you *do* want a hard money ceiling, that is
`/usage-credits` (a monthly cap on overage billed at API rates), not a CLI flag.

**Do not use `--dangerously-skip-permissions` for this.** Auto mode plus the
allowlist is the right level on a machine with your SSH keys on it.

## If you come back and it has stopped

```bash
CLAUDE_CODE_RETRY_WATCHDOG=1 claude --permission-mode auto --continue
```

or start fresh with the same prompt. `PLAN.md` and `PR-LOG.md` hold the state;
nothing important lives in the conversation.
