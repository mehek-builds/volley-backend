#!/usr/bin/env bash
#
# Deploy this checkout to PRODUCTION, with the two guards a bare `vercel --prod` does not have.
#
# WHY THIS EXISTS AT ALL, given the GitHub integration already deploys every merge. Measured over
# the last 12 production deployments on 2026-08-04: 11 came from the integration, one per merge to
# main, and 1 came from the CLI. So the integration is the normal path and it works; this script is
# for the times someone deploys by hand anyway, and its job is to make that as safe and as
# identifiable as the automatic path.
#
# GUARD 1: THE TREE MUST BE A DESCENDANT OF origin/main.
#
#   A CLI deploy ships the working tree, not a branch. Several agents work these checkouts at once,
#   so a `vercel --prod` from a checkout that is behind main silently REVERTS whatever landed in
#   between, and nothing in the Vercel UI would show it: the deployment is green, Ready, and holding
#   the alias. On 2026-08-04 a CLI deploy of 7ccc436 replaced a GitHub deployment of the same commit
#   18 seconds later; that one was harmless only because the trees happened to match.
#
# GUARD 2: THE COMMIT SHA IS PASSED IN AS GIT_SHA.
#
#   Vercel fills the `VERCEL_GIT_*` variables from the GitHub integration's metadata. A CLI deploy
#   attaches its own git metadata under a different key prefix which is NOT projected into the
#   environment, so /health reports `revision: null` and the runbook's "compare revision to the
#   merge commit" step cannot answer. See src/lib/buildInfo.ts for the measurement. Passing the SHA
#   explicitly makes a hand deploy exactly as traceable as an automatic one.
#
# Usage:  npm run deploy:prod          normal
#         FORCE=1 npm run deploy:prod  skip guard 1, for a deliberate rollback to an older commit
set -euo pipefail

cd "$(dirname "$0")/.."

EXPECTED_PROJECT_ID="prj_5gPI7ADAT5M26VIxhiAKe1efsJPi"
EXPECTED_PROJECT_NAME="student-outreach-backend"
PROJECT_FILE=".vercel/project.json"

if [ ! -f "$PROJECT_FILE" ]; then
  echo "REFUSING: $PROJECT_FILE is missing." >&2
  echo "A CLI deploy from an unlinked checkout can create or deploy the wrong Vercel project." >&2
  exit 1
fi

PROJECT_ID="$(node -e "const p=require('./$PROJECT_FILE'); process.stdout.write(String(p.projectId || ''))")"
PROJECT_NAME="$(node -e "const p=require('./$PROJECT_FILE'); process.stdout.write(String(p.projectName || ''))")"
if [ "$PROJECT_ID" != "$EXPECTED_PROJECT_ID" ] || [ "$PROJECT_NAME" != "$EXPECTED_PROJECT_NAME" ]; then
  echo "REFUSING: this checkout is linked to the wrong Vercel project." >&2
  echo "  projectId   $PROJECT_ID" >&2
  echo "  projectName $PROJECT_NAME" >&2
  echo "Expected projectId=$EXPECTED_PROJECT_ID projectName=$EXPECTED_PROJECT_NAME" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSING: the working tree is dirty." >&2
  echo "A CLI deploy ships the tree, so uncommitted work would go to production." >&2
  git status --short >&2
  exit 1
fi

SHA="$(git rev-parse HEAD)"
git fetch -q origin main

if [ "${FORCE:-}" != "1" ]; then
  if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "REFUSING: HEAD is not a descendant of origin/main." >&2
    echo "  HEAD        $SHA" >&2
    echo "  origin/main $(git rev-parse origin/main)" >&2
    echo "  behind by   $(git rev-list --count HEAD..origin/main) commit(s)" >&2
    echo >&2
    echo "Deploying this tree would revert work that is already on main. Merge or rebase first." >&2
    echo "If you MEANT to roll production back to this commit, re-run with FORCE=1." >&2
    exit 1
  fi
fi

echo "Deploying $SHA to production"
echo "  origin/main $(git rev-parse origin/main)"
[ "${FORCE:-}" = "1" ] && echo "  FORCE=1, ancestor guard skipped"

# -e sets a RUNTIME variable, which is what the health handler reads. --build-env would only reach
# the build step, where nothing needs it.
vercel --prod --yes -e "GIT_SHA=$SHA"

echo
echo "Confirm what is live:"
echo "  curl -s https://student-outreach-backend.vercel.app/health"
echo "Expect revision=$SHA and revision_source=git-sha"
