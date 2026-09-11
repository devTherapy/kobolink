#!/usr/bin/env bash
# One-time setup. Safe to re-run: every step checks before acting.
set -euo pipefail

say()  { printf '\033[32m▸\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null || die "git is not installed."
command -v gh  >/dev/null || die "The GitHub CLI is not installed. brew install gh"
command -v node >/dev/null || die "node is not installed."
gh auth status >/dev/null 2>&1 || die "Not signed in to GitHub. Run: gh auth login"

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || warn "node $node_major — the build targets node 22+."
docker info >/dev/null 2>&1 || warn "Docker is not running. Testcontainers needs it for the API integration tests."

chmod +x .claude/hooks/*.sh 2>/dev/null || true
[ -f .env.local ] || { cp salvage/env.example .env.local 2>/dev/null && say "Created .env.local from the template — fill it in when X3 arrives."; }

if [ ! -d .git ]; then
  say "Initialising the repository"
  git init -b main -q
  git add -A
  git commit -q -m "chore: plan, agents, skills, salvaged libraries

No application code yet. The monorepo, CI and packages/contracts are X0 and X1
in PLAN.md and are the first thing the orchestrator builds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  say "First commit created"
else
  say "Repository already initialised — leaving it alone"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  say "Creating the GitHub repository"
  gh repo create kobolink --private --source=. --push
else
  say "Remote already configured: $(git remote get-url origin)"
fi

say "Enabling branch protection on main"
owner_repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api -X PUT "repos/$owner_repo/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  -f 'required_status_checks[strict]=true' \
  -F 'required_status_checks[contexts][]=' \
  -F 'enforce_admins=false' \
  -F 'required_pull_request_reviews=' \
  -F 'restrictions=' >/dev/null 2>&1 \
  && say "Branch protection on: main is PR-only" \
  || warn "Could not set branch protection (private repos need a paid plan). The commit hook still blocks direct commits to main."

cat <<'MSG'

Ready. Start the build with:

  CLAUDE_CODE_RETRY_WATCHDOG=1 claude --permission-mode auto

then paste the prompt from RUN.md.

MSG
