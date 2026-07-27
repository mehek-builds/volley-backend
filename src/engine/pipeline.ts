/**
 * The student's pipeline stage, and where a row starts when they have never moved it.
 *
 * TWO AXES, NOT ONE. spec._review.status is submission machinery: resume_ready, preparing, filling,
 * submitted, failed. It records what LITOS did, and Litos owns it. The pipeline stage records what
 * the COMPANY did, and the student owns it. They move independently: a submission is "submitted"
 * forever while the student moves applied -> interview -> offer. Collapsing them, which is the
 * tempting shortcut because "submitted" looks like a stage, would make an interview
 * indistinguishable from a submission retry and would let the automation silently overwrite a fact
 * about the student's life.
 *
 * The board is the shape Huntr and Teal both retain on: reviewers of each describe the Kanban as
 * the thing that replaced their spreadsheet. What retains is not the columns, it is that the data
 * accumulates and stays theirs.
 */

export const STAGES = ['saved', 'applied', 'interview', 'offer', 'closed'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  saved: 'Saved',
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer',
  closed: 'Closed',
};

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/**
 * Where a row sits when pipeline_stage is NULL.
 *
 * Derived rather than backfilled. A backfill would have claimed every historical row had been
 * triaged when none of them had, and it would have had to guess. Deriving keeps the guess in one
 * place, visible, and reversible the moment the student moves the card.
 */
export function deriveStage(stored: unknown, submissionStatus: unknown): Stage {
  if (isStage(stored)) return stored;
  // Anything the automation actually sent is at least "applied". Everything else is still "saved":
  // a prepared resume the student has not sent is not an application, and counting it as one is
  // the inflation the funnel refuses for the same reason.
  return submissionStatus === 'submitted' ? 'applied' : 'saved';
}

/**
 * A move the student can make.
 *
 * Any stage to any stage, deliberately. A pipeline is not a state machine here: applications go
 * backwards (an "interview" that turns out to be a recruiter screen), skip forwards (a referral
 * that starts at interview), and get reopened. Enforcing an order would encode a theory of job
 * searching that does not survive contact with one.
 */
export function canMove(from: Stage, to: Stage): boolean {
  return from !== to;
}
