function email(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ? normalized : undefined;
}

/** Server-owned address printed on resumes, kept separate from portal routing aliases. */
export function resumeEmailOfRecord(parsedProfile: unknown, _accountEmail?: string): string | undefined {
  const parsed = parsedProfile && typeof parsedProfile === 'object' && !Array.isArray(parsedProfile)
    ? parsedProfile as Record<string, unknown>
    : {};
  return email(parsed.resume_email);
}

/**
 * The address to store on a freshly uploaded parse.
 *
 * WHY THIS EXISTS. `resume_email` is read by the base resume, the tailored resume, the packet audit
 * and the academic-email answer, and until 2026-08-16 nothing ever WROTE it. The parser extracts no
 * email (llm/parse.ts has no such field), so the only source was a text box under "Edit parsed
 * details" in Documents that onboarding never mentions. 16 of 17 production profiles had none, and
 * the base resume's ATS gate refused every one of them.
 *
 * PRESERVE BEATS SEED, and that order is the point. `parsed_json` is replaced wholesale by each
 * upload, so an address the student typed themselves was destroyed by their next re-upload. Their
 * value wins over both this parse and the account default, always.
 *
 * The seed is the verified login email, which is the address they signed up with and the one
 * `GET /resume/base/file` already prints. A portal routing alias can never arrive here: aliases
 * live in application_email_aliases and never reach `users.email`.
 */
export function resumeEmailForUpload(
  existingParsedProfile: unknown,
  accountEmail?: string,
  /** The address printed on the resume just uploaded. See the third rung below. */
  parsedEmail?: string,
): string | undefined {
  /* THREE RUNGS, in the order of who is most entitled to decide the address.
   *
   * 1. what the student typed themselves - their correction, and it outlives every upload
   * 2. the verified login email - the address they signed up with
   * 3. THE ADDRESS ON THE RESUME THEY JUST HANDED OVER, which is new here.
   *
   * The third rung is what a guest has and the other two are not. A guest account carries no email
   * at all, so onboarding stopped dead at the build with "Add the email address that should appear
   * on your resume" and pointed at an Account page that had none to add. Their resume prints one,
   * under their name, and the parser reads it now. It is the applicant's own published address on
   * their own document, which is exactly what a resume header is for.
   *
   * Below the login email deliberately: a verified address Litos can route replies through beats a
   * transcription, and a resume can carry a stale university address the student has moved off. */
  return resumeEmailOfRecord(existingParsedProfile) ?? email(accountEmail) ?? email(parsedEmail);
}

export function resumePacketEmailIsCurrent(storedEmail: unknown, currentResumeEmail: unknown): boolean {
  return Boolean(email(storedEmail) && email(storedEmail) === email(currentResumeEmail));
}
