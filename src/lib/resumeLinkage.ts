import { sql, type SQL } from 'drizzle-orm';
import { applications } from '../db/schema';

/* THE ONE PLACE THAT DECIDES WHAT AN APPLICATION'S RESUME COLUMNS SAY.
 *
 * An application row carries four columns that are one fact between them:
 * selected_resume_artifact_id, resume_attached, resume_source and resume_attached_at. Until
 * 2026-09-03 four separate write sites set them independently, and the shape they could produce
 * between them was "a resume artifact is selected and no resume is attached":
 *
 *   selected_resume_artifact_id: <a real, owned, resume-kind artifact>
 *   resume_attached: false
 *   resume_source: 'none'
 *   resume_attached_at: null
 *
 * Measured on 2026-09-03 across the ten boards Mehek was applying to, SIX were in exactly that
 * state: DSI Innovations, Blueprint Hires, Prediktive, xolife, Confluence Technologies and
 * TixTrack. Every one of them had a PASSED packet audit binding an exact PDF. So the packet
 * believed it had a resume, the audit bound the file, and the linkage row said there was none.
 *
 * The four sites and how each produced it:
 *   - POST /applications/:id/fill updated the artifact id and the (attached, source) pair behind
 *     INDEPENDENT gates, so a request naming only the artifact set the pointer and left the pair
 *     at its default. That is the majority of the six.
 *   - linkGeneratedPacketToCanonicalApplication, which runs on every tailor, set the pointer and
 *     never the pair at all.
 *   - appendEditedResumeArtifactVersion did the same on a first user edit.
 *   - the duplicate-row merge picked the pointer from one row and the pair from another.
 *
 * So the fix is not four patches. It is one function that turns an INTENT into the four columns,
 * and four callers that say what they mean instead of writing columns by hand. There is exactly
 * one way to spell "a resume is attached from this artifact", and it is here.
 *
 * The database now agrees: applications_resume_attachment_state_check requires the pointer to be
 * present exactly when the source is 'artifact', so the shape above is no longer storable. See
 * scripts/apply-resume-linkage-invariant-migration.mjs for the backfill that made that constraint
 * addable.
 */

export type ResumeSource = 'artifact' | 'base_resume' | 'none';

/* Three intents, because a resume comes from exactly three places: a document the student picked,
 * the main resume saved on her profile, or nowhere. Nothing else is expressible, which is the
 * point: the inconsistent shape has no intent that produces it. */
export type ResumeLinkageIntent =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'base_resume' }
  | { kind: 'detached' };

export type ResumeLinkageColumns = {
  selected_resume_artifact_id: string | null;
  resume_attached: boolean;
  resume_source: ResumeSource;
  resume_attached_at: Date | SQL | null;
};

/* What a caller that already holds the four values MEANT by them.
 *
 * Read in this order because the orders disagree on exactly one row shape, the broken one. A row
 * carrying an artifact pointer and (false, 'none') is not a detached application: the pointer is a
 * real owned document that some earlier write bound to this application, and the pair is the half
 * that never got written. Promoting it is the repair. The reverse reading, "not attached, so drop
 * the pointer", would throw away the resume rather than attach it.
 *
 * A caller that genuinely means detached says so by clearing the pointer, which every caller in
 * this repository now does. */
export function resumeLinkageIntentFrom(input: {
  selectedResumeArtifactId: string | null;
  resumeAttached: boolean;
  resumeSource: ResumeSource;
}): ResumeLinkageIntent {
  if (input.resumeAttached && input.resumeSource === 'base_resume') return { kind: 'base_resume' };
  if (input.selectedResumeArtifactId) {
    return { kind: 'artifact', artifactId: input.selectedResumeArtifactId };
  }
  return { kind: 'detached' };
}

/* The four columns, from one intent.
 *
 * preserveAttachedAt exists because a re-tailor is not a re-attach. The two artifact-version
 * writers repoint an application at a new document for an application whose resume may have been
 * attached weeks ago, and resume_attached_at answers "when did this application first get a
 * resume". Overwriting it on every tailor would make that column mean "when was this row last
 * touched", which it already has updated_at for. Expressed as a coalesce so the row decides, in
 * the same statement, rather than this process reading it first and racing another writer. */
export function resumeLinkageColumns(
  intent: ResumeLinkageIntent,
  options: { now?: Date; preserveAttachedAt?: boolean } = {},
): ResumeLinkageColumns {
  const now = options.now ?? new Date();
  const attachedAt: Date | SQL = options.preserveAttachedAt
    ? sql`coalesce(${applications.resume_attached_at}, ${now})`
    : now;
  if (intent.kind === 'artifact') {
    return {
      selected_resume_artifact_id: intent.artifactId,
      resume_attached: true,
      resume_source: 'artifact',
      resume_attached_at: attachedAt,
    };
  }
  if (intent.kind === 'base_resume') {
    return {
      // The main resume is not a document row, so a pointer beside it would name a document this
      // application is not sending. The fill route has always cleared it here; now every caller does.
      selected_resume_artifact_id: null,
      resume_attached: true,
      resume_source: 'base_resume',
      resume_attached_at: attachedAt,
    };
  }
  return {
    selected_resume_artifact_id: null,
    resume_attached: false,
    resume_source: 'none',
    resume_attached_at: null,
  };
}

/* The merge's version of the same question, for the duplicate-row adoption that has several rows
 * and has to keep one linkage. Rows are considered in the caller's order and the first that means
 * anything wins, so the pointer and the pair can no longer be picked from different rows. */
export function mergedResumeLinkageIntent(rows: Array<{
  selected_resume_artifact_id: string | null;
  resume_attached: boolean;
  resume_source: string;
}>): ResumeLinkageIntent {
  for (const row of rows) {
    const intent = resumeLinkageIntentFrom({
      selectedResumeArtifactId: row.selected_resume_artifact_id,
      resumeAttached: row.resume_attached,
      resumeSource: row.resume_source as ResumeSource,
    });
    if (intent.kind !== 'detached') return intent;
  }
  return { kind: 'detached' };
}
