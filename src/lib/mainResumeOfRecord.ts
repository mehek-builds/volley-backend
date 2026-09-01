import { profiles } from '../db/schema';
import { deriveCandidateContext, normalizeDashesForPrint } from '../engine/resumePolicy';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import { candidateEducationFromParsedProfile } from './submissionEducationGuard';

/* The main resume as the product will state its EDUCATION, before it is rendered for an employer.
 *
 * profiles.base_resume_json is the spec the student approved on /start, or the parse of the PDF she
 * uploaded, frozen at that moment. profiles.parsed_json is the education of record for the fields
 * the education block prints as facts: school, degree, graduation date and coursework. It is what
 * GET /profile serves for those keys, what the dashboard's "Edit parsed details" writes, and what
 * the send-time guard (lib/submissionEducationGuard.ts) and the site's review-screen banner both
 * compare a packet against. Measured 2026-09-02 on a real account: the uploaded PDF still printed
 * "May 2027" and a business-administration degree while the profile said "May 2028" and computer
 * science, so every managed packet was born already refused, the banner asked her to hand-fix the
 * education line on each application, and the Free fill path (/resume/base/file) would have handed
 * the stale PDF to the employer with no guard in the way at all.
 *
 * THE RULE IS THE BUILDER'S, NOT A NEW ONE. engine/resumePolicy.ts applyResumePolicy writes the
 * education block from the record and discards whatever the spec carried: school, degree and
 * grad_date trimmed with '' for a blank record field, EVERY course on record joined with ', ' (the
 * block is a record, not an argument, see the comment there), and education_position derived from
 * the calendar. This function re-applies exactly that block, read through the guard's own mapping
 * (candidateEducationFromParsedProfile), so "what is rendered" and "what the guard compares" are
 * the same computation rather than two that happen to agree. A blank record field therefore prints
 * blank, as a fresh build would; the caller that must not print a blank school or degree checks for
 * it and refuses before rendering, the way /resume/base and /resume/generate do.
 *
 * Every printed string passes through normalizeDashesForPrint, as every other printed spec does:
 * parsed_json is never dash-normalized, and a record degree carrying the PDF's em dash would
 * otherwise print it and then fail the review screen's own save validation.
 *
 * NOT TOUCHED: gpa, gpa_scale and school_location. GPA is application_profile's to state (the
 * CandidateEducation comment records the day a render read it from the parse instead) and the guard
 * deliberately does not compare it. Nothing else on the resume moves; tailoring is a different
 * route. */
export function mainResumeOfRecord(baseResume: ResumeSpec, parsed: unknown, now = new Date()): ResumeSpec {
  const education = candidateEducationFromParsedProfile(parsed);
  const block = normalizeDashesForPrint({
    school: education.school?.trim() ?? '',
    degree: education.degree?.trim() ?? '',
    grad_date: education.grad_date?.trim() ?? '',
    coursework: (education.coursework ?? []).map((course) => course.trim()).filter(Boolean).join(', '),
  });
  return {
    ...baseResume,
    ...block,
    education_position: deriveCandidateContext(education, now).education_position,
  };
}

/* The two profile columns the main resume is read from, named once so every site that renders or
 * hashes it fetches both halves: a site that forgot parsed_json would hash the bare base resume and
 * refuse every prepare as main_resume_changed. */
export const MAIN_RESUME_PROFILE_COLUMNS = {
  baseResume: profiles.base_resume_json,
  parsed: profiles.parsed_json,
};

/* null when the profile holds no main resume yet; the caller owns that refusal. */
export function mainResumeOfRecordFor(
  row: { baseResume: unknown; parsed: unknown } | undefined,
  now = new Date(),
): ResumeSpec | null {
  if (!row?.baseResume) return null;
  return mainResumeOfRecord(normalizeSpec(row.baseResume), row.parsed, now);
}
