// How much unattended submission work one cron invocation takes on, and which applications an
// unattended run is allowed to spend anything on at all.
//
// Pure functions on purpose: every rule here decides whether a real application reaches a real
// employer, so each one has to be assertable in a unit test without a database, a browser provider
// or a clock.

// The window the batch loop will start another application inside, against the 300s function
// maxDuration in vercel.json. A run that is cut off mid-flight AFTER the submit click is claimed
// lands in needs_attention with "could not verify the confirmation", which is the one state that
// costs a human a manual check of the employer portal. So the budget leaves most of a slow
// application's worth of headroom rather than packing the function to its limit.
export const SUBMISSION_BATCH_TIME_BUDGET_MS = 210_000;

export function hasTimeForAnotherApplication(
  elapsedMs: number,
  budgetMs: number = SUBMISSION_BATCH_TIME_BUDGET_MS,
): boolean {
  return elapsedMs < budgetMs;
}

// Rows claimed per invocation. The real limiter is the time budget above, not this number; this
// only bounds the SELECT so a huge queue does not pull thousands of rows into memory to discard
// most of them. With the cron at every 15 minutes this is a ceiling of batch x 96 per day, far
// above anything the daily cap will let through.
const DEFAULT_BATCH_SIZE = 12;

export function submissionBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.SUBMISSION_BATCH_SIZE, DEFAULT_BATCH_SIZE);
}

// A per-user, per-day ceiling on completed submissions.
//
// Not a throttle on ambition: every application Litos sends is tailored to that specific posting,
// so there is no reason to hold back a queue the user filled deliberately. It is a blast radius
// limit on the one action in this codebase that cannot be undone. A loop bug, a duplicated queue
// or a bad retry reaches at most this many real employers before a human sees it, and the number
// is an env var so it can be raised without a deploy.
const DEFAULT_DAILY_SUBMISSION_CAP = 40;

export function dailySubmissionCap(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.DAILY_SUBMISSION_CAP, DEFAULT_DAILY_SUBMISSION_CAP);
}

export function withinDailyCap(submittedToday: number, cap: number): boolean {
  return submittedToday < cap;
}

// Whether an unattended run should open a browser for this portal at all.
//
// Standing consent means the user asked for applications to be SENT while they are away. On a
// portal that cannot be finished in one run, an unattended run would spend billed managed-browser
// calls and LLM answers filling a form it is then forbidden to submit (see portalCanAutoSubmit),
// and park the result in needs_attention. The user wakes up to work they still have to do, having
// paid for it. Stopping before the spend says the same thing sooner and cheaper.
//
// Deliberately still TRUE without standing consent: fill-and-hand-off on Paylocity, SmartRecruiters,
// JazzHR and BambooHR is a shipped feature and genuinely useful when the user is sitting there to
// finish it. This narrows the autonomous path, not the assisted one.
export function autoRunShouldPrepare(options: {
  canAutoSubmit: boolean;
  standingConsentEnabled: boolean;
}): boolean {
  return options.canAutoSubmit || !options.standingConsentEnabled;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
