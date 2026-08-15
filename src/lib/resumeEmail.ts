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
): string | undefined {
  return resumeEmailOfRecord(existingParsedProfile) ?? email(accountEmail);
}

export function resumePacketEmailIsCurrent(storedEmail: unknown, currentResumeEmail: unknown): boolean {
  return Boolean(email(storedEmail) && email(storedEmail) === email(currentResumeEmail));
}
