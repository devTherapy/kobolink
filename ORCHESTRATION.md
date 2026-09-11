# How the coordination actually works

You asked for a central agent that tracks the full picture, talks to the other
agents, keeps them on track, and assembles the results. Three of those four are
straightforward. The "talks to the other agents" part is the one worth being
precise about, because it is not how Claude Code works and building on it would
be building on sand.

---

## What does not exist

**There is no live message passing between running agents.** A subagent has
exactly two channels: the summary it returns to whoever spawned it, and files on
disk. No queue, no broker, no agent interrupting another mid-task to say "careful,
I renamed that field."

So a coordinator cannot keep agents on track *while they work*. It can only
decide what they work on, and check what they produce. That is a dispatcher, not
a conductor — and accepting that shapes everything else.

## What does the coordinating, then

Four mechanisms, in descending order of how much they actually prevent drift:

**1. The contract does most of it.** `packages/contracts` holds every request and
response shape as a Zod schema, and the OpenAPI document generated from it
produces the Swift and Kotlin models. Three domains stay in sync because a
disagreement is a **compile error**, not a conversation someone forgot to have.
This is the real coordinator. Everything else is support.

**2. CI enforces it.** Five jobs, all blocking: lint+typecheck, unit,
integration-api, integration-web, e2e. An agent that drifts finds out from a red
PR, which is far more reliable than an agent that was told to be careful.

**3. `PLAN.md` is the shared memory.** Durable, readable by every agent and every
future session, and it survives restarts in a way conversation context does not.
Each agent updates only its own rows; the orchestrator owns the rest and
reconciles the file against `git log` at the start of every session.

**4. The orchestrator agent is the dispatcher.** Reads `PLAN.md`, works out which
features are ready, spawns the right specialists, verifies what comes back
against the "Done when" column, updates the file, repeats.

Note what that ordering means: **if the only thing keeping your domains in sync
were agents talking to each other, the build would drift.** The contract and the
gate are what make it hold.

---

## The collision problem, and the fix

Subagents spawned in parallel **share one working directory and one git checkout
by default**. Two agents editing the same tree, both running `git commit`, is a
mess.

Every domain agent definition here carries `isolation: worktree`. Each gets its
own temporary git worktree, so parallel work genuinely cannot collide. That one
line is what makes one-agent-per-domain viable rather than theoretical.

For longer parallel stints you can also run separate terminals:

```bash
claude --worktree backend     # terminal 1
claude --worktree frontend    # terminal 2
claude --worktree mobile      # terminal 3
```

Each is a real worktree on its own branch. `claude agents` opens a dispatcher
that runs background sessions, each auto-isolated the same way.

---

## Running it

Drop this directory's contents into the repo root, then:

```bash
claude                      # main session
> use the orchestrator agent to start the build
```

The orchestrator will read `PLAN.md`, find that Wave 0 is unstarted, and build
`X0` and `X1` itself — the monorepo, CI, hooks and the contracts package. Those
are the only things it writes code for, because nothing else can start until
they exist.

After Wave 0 merges, each session looks like:

```
> orchestrator: what's ready?
  → reads PLAN.md, reports the ready set
> dispatch them
  → spawns backend, frontend and mobile agents in parallel, each in its own worktree
  → each returns a summary; orchestrator verifies against "Done when"
  → PLAN.md updated; PRs opened
```

You review and merge the PRs. The orchestrator never merges its own work.

## The guard rail

`.claude/hooks/guard-commit.sh` runs before any `git commit` or `git push` and
refuses two things: committing on `main`, and committing while typecheck or lint
is red. It denies the tool call and tells the agent why.

This exists because the audit trail you asked for is only worth having if every
commit on `main` arrived through a reviewed PR with a green gate. An instruction
in an agent definition is a request; a hook is a rule.

## What to watch for

- **An agent reporting success it did not verify.** The orchestrator is told not
  to take claims as evidence, but check the "Done when" column yourself on
  anything that matters.
- **Contract drift.** Only the orchestrator edits `packages/contracts`, as its
  own PR. When one merges, in-flight agents must re-run their gate.
- **Mobile cannot run here.** iOS and Android need Xcode and the Android SDK, so
  those agents only work on your Mac.
- **Three parallel agents on opus is expensive.** Wave 1 is nine features. If
  cost matters, run one domain at a time and accept the slower wall clock.
