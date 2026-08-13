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

export function resumePacketEmailIsCurrent(storedEmail: unknown, currentResumeEmail: unknown): boolean {
  return Boolean(email(storedEmail) && email(storedEmail) === email(currentResumeEmail));
}
