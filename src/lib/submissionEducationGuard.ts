import type { CandidateEducation } from '../engine/resumePolicy';
import { educationDriftIssues } from '../engine/resumeValidate';
import { normalizeSpec } from '../llm/resumeSpec';

/**
 * Send-time education guard for application packets.
 *
 * A packet freezes its rendered PDF when it is built: submissionRunner's buildPacket resolves
 * resume_object_key and uploads those exact bytes, and nothing re-derives the document from the
 * profile at send time. So a packet built weeks ago prints that day's education block, including a
 * graduation date the student may since have corrected. Graduation year decides internship
 * eligibility, which makes this a factual claim to an employer rather than a formatting detail.
 *
 * The attended path is covered only incidentally: the review screen saves through
 * PATCH /applications/:id/resume, which runs the same comparison before it re-renders. The
 * unattended paths (extension standing consent, and any client that posts submit-request without
 * saving first) had no such check, and a client-side check is not an enforcement point.
 *
 * This module is deliberately thin. The comparison itself lives in educationDriftIssues; everything
 * here does is feed it the same two inputs PATCH /resume feeds it, so a packet the dashboard would
 * still accept is a packet the unattended routes will still send.
 */

type ParsedEducationJson = {
  school?: string;
  degree?: string;
  grad_date?: string;
  grad_year?: number;
  currently_enrolled?: boolean;
  coursework?: string[];
  gpa?: string;
  gpa_scale?: string;
  school_location?: string;
};

/**
 * profiles.parsed_json to CandidateEducation, byte for byte what PATCH /applications/:id/resume
 * built inline before this existed. It is shared rather than re-typed because the guard has to
 * agree with the dashboard about what the profile SAYS as well as about how to compare it: a
 * mapping that resolved grad_date differently would refuse packets the dashboard just approved.
 *
 * gpa, gpa_scale and school_location are carried because CandidateEducation declares them, not
 * because they are compared. educationDriftIssues does not look at GPA, and it must not: see the
 * note there.
 */
export function candidateEducationFromParsedProfile(parsed: unknown): CandidateEducation {
  const p = (parsed ?? {}) as ParsedEducationJson;
  return {
    school: p.school ?? '',
    degree: p.degree,
    grad_date: p.grad_date || (p.grad_year ? String(p.grad_year) : undefined),
    grad_year: p.grad_year,
    currently_enrolled: p.currently_enrolled,
    gpa: p.gpa,
    gpa_scale: p.gpa_scale,
    school_location: p.school_location,
    coursework: Array.isArray(p.coursework) ? p.coursework : [],
  };
}

/**
 * The issues a stored packet's education block raises against the profile as it reads right now.
 * Empty means the packet still tells the truth and may be sent without a human looking at it.
 */
export function packetEducationDrift(storedSpec: unknown, parsedProfile: unknown): string[] {
  return educationDriftIssues(normalizeSpec(storedSpec), candidateEducationFromParsedProfile(parsedProfile));
}

export const EDUCATION_DRIFT_CODE = 'EDUCATION_DRIFT';

/**
 * A refusal a client can act on without guessing. A silent refusal, or a bare 409, would be worse
 * than the bug it prevents: the student would see a submission that never happened and no reason.
 */
export function educationDriftResponse(issues: string[]) {
  return {
    error: 'Your education details changed after this application was prepared. Open the application, review the resume and save it, then submit again.',
    code: EDUCATION_DRIFT_CODE,
    issues,
  };
}
