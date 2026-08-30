/**
 * WHICH COMMIT IS ACTUALLY SERVING THIS REQUEST.
 *
 * DEPLOY.md's verification step is "compare `revision` to the merge commit". On 2026-08-04 that
 * check returned null for a deployment that was READY, correct, and holding the production alias,
 * and establishing what was live took a Vercel API call and two git commands. A verification step
 * that returns null instead of answering is the shape of check that gets trusted right up until it
 * matters.
 *
 * WHY IT WAS NULL, NOW ESTABLISHED RATHER THAN GUESSED. The comment this replaces said the
 * deciding factor was "NOT established" and listed two candidate explanations. Measured over the
 * last 12 production deployments of this project through the Vercel REST API:
 *
 *   source     deployments   git metadata keys        VERCEL_GIT_COMMIT_SHA
 *   git                 11   githubCommitSha, ...     set
 *   cli                  1   gitCommitSha, ...        NOT set
 *
 * Vercel populates the `VERCEL_GIT_*` system variables from the GITHUB-integration metadata, whose
 * keys carry the `github` prefix. A `vercel --prod` deploy from a laptop attaches its own git
 * metadata under the shorter `git` prefix, read from the local checkout, and that shape is NOT
 * projected into the environment. So the rule is simply: deploy from the GitHub integration and
 * `revision` is populated; deploy from the CLI and it is not, unless the SHA is passed in.
 *
 * HENCE GIT_SHA, which is the CLI path's way of saying the same thing. `scripts/deploy-prod.sh`
 * passes `-e GIT_SHA=$(git rev-parse HEAD)` so a CLI deploy is as identifiable as a git one. The
 * variable already existed in the health handler and nothing ever set it, which is why the fallback
 * never fired.
 *
 * AND HENCE `revision_source`, which is the part that makes a null actionable instead of merely
 * disappointing. `revision: null` alone cannot distinguish "nobody passed a SHA" from "this field
 * is broken", and those need different responses. Publishing which mechanism answered turns the
 * health check into something that explains itself:
 *
 *   vercel-git   the GitHub integration deployed it. The normal path.
 *   git-sha      a CLI deploy that passed GIT_SHA, i.e. went through the deploy script.
 *   none         a bare `vercel --prod`. The revision is genuinely unknown and the deployment id
 *                in `build` is the only handle; resolve it with
 *                `vercel inspect <build>` or the REST API.
 *
 * NOT A REPLACEMENT FOR `build`, which stays. A SHA is comparable to `git rev-parse origin/main`
 * without leaving the terminal and a deployment id is not, so the SHA is the first thing to read;
 * the id is what still identifies the deployment when no SHA was supplied at all.
 */
export type RevisionSource = 'railway-git' | 'vercel-git' | 'git-sha' | 'none';

export interface BuildRevision {
  /** The commit this code was built from, or null when nothing supplied one. */
  revision: string | null;
  /** Which mechanism answered. See the note above: this is what makes a null diagnosable. */
  revision_source: RevisionSource;
}

/**
 * Resolve the running commit from the environment.
 *
 * Takes the environment as an argument rather than reading `process.env` directly so the precedence
 * is testable without mutating global state, which is the only reason this is a function in its own
 * module rather than three lines inline in the health handler.
 *
 * PRECEDENCE IS VERCEL FIRST. Where both are present the platform's own value is the one that
 * cannot have been typed wrong: `GIT_SHA` is passed by a shell script from whatever checkout it ran
 * in, and a stale or hand-set value is exactly the failure this endpoint exists to detect. An empty
 * or whitespace-only value counts as absent, because `-e GIT_SHA=` on a deploy with no git present
 * sets the variable to the empty string and that must not read as an answer.
 */
export function resolveRevision(env: NodeJS.ProcessEnv = process.env): BuildRevision {
  const fromRailway = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (fromRailway) return { revision: fromRailway, revision_source: 'railway-git' };
  const fromVercel = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (fromVercel) return { revision: fromVercel, revision_source: 'vercel-git' };
  const fromScript = env.GIT_SHA?.trim();
  if (fromScript) return { revision: fromScript, revision_source: 'git-sha' };
  return { revision: null, revision_source: 'none' };
}

/**
 * The deployment identity that is always available, whatever the git metadata looked like.
 *
 * VERCEL_DEPLOYMENT_ID is the primary because it is the id every Vercel surface keys on, so it
 * resolves straight to a deployment and through it to a commit. VERCEL_URL is the fallback because
 * it is the older variable and is set on every deployment that has ever existed; it carries the
 * same identity in a hostname. Both are absent locally, where null is correct.
 */
export function resolveBuild(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.RAILWAY_DEPLOYMENT_ID || env.VERCEL_DEPLOYMENT_ID || env.VERCEL_URL || null;
}
