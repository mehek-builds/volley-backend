import { del, put } from '@vercel/blob';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes, profiles } from '../db/schema';
import { readExperienceBank } from '../db/experienceBank';
import { readApplicationReview } from './applicationReview';
import { renderCoverLetterPdf } from './coverLetterPdf';
import { generateCoverLetter, validateCoverLetter } from '../llm/coverLetter';
import { resolveBlobUrl } from './resumeAccess';

export type ApplicationRow = typeof generated_resumes.$inferSelect;
type StoredSpec = Record<string, unknown>;

export type CoverLetterArtifact = {
  body: string;
  word_count: number;
  warnings: string[];
  generated_at: string;
  approved_at?: string;
  object_key: string;
  file_name: string;
};

export function storedCoverLetter(row: ApplicationRow): CoverLetterArtifact | null {
  const value = (row.spec as StoredSpec)._cover_letter;
  if (!value || typeof value !== 'object') return null;
  const artifact = value as Partial<CoverLetterArtifact>;
  return typeof artifact.body === 'string'
    && typeof artifact.object_key === 'string'
    && typeof artifact.file_name === 'string'
    ? artifact as CoverLetterArtifact
    : null;
}

export function canGenerateCoverLetter(supported: boolean | undefined, capabilityConfirmed = false): boolean {
  return capabilityConfirmed || supported === true;
}

async function candidateContext(row: ApplicationRow) {
  const [bank, profileRows] = await Promise.all([
    readExperienceBank(row.user_id),
    db.select().from(profiles).where(eq(profiles.user_id, row.user_id)).limit(1),
  ]);
  const stored = row.spec as StoredSpec;
  return JSON.stringify({
    education: profileRows[0]?.parsed_json ?? {},
    declared_skills: profileRows[0]?.skills ?? [],
    selected_resume: Object.fromEntries(Object.entries(stored).filter(([key]) => !key.startsWith('_'))),
    experience_bank: bank,
  });
}

async function persistCoverLetter(
  row: ApplicationRow,
  body: string,
  warnings: string[],
  wordCount: number,
  approved: boolean,
) {
  const stored = row.spec as StoredSpec;
  const review = readApplicationReview(stored);
  const contact = (stored._contact ?? {}) as { full_name?: string; email?: string };
  const job = row.job_context as { company?: string; role?: string };
  if (!review?.jd_text || !job.company || !job.role || !contact.full_name) throw new Error('Application packet is incomplete');
  const pdf = await renderCoverLetterPdf({ full_name: contact.full_name, email: contact.email }, job.company, body);
  const blob = await put(`users/${row.user_id}/resumes/${row.id}-cover-letter-${Date.now()}.pdf`, pdf, {
    access: 'public',
    contentType: 'application/pdf',
  });
  const generatedAt = new Date().toISOString();
  const artifact: CoverLetterArtifact = {
    body,
    word_count: wordCount,
    warnings,
    generated_at: generatedAt,
    approved_at: approved ? generatedAt : undefined,
    object_key: blob.pathname,
    file_name: `${contact.full_name.replace(/\s+/g, '_')}_${job.company.replace(/\s+/g, '_')}_Cover_Letter.pdf`,
  };
  const previous = storedCoverLetter(row);
  let updated: Array<{ id: string }>;
  try {
    updated = await db.update(generated_resumes).set({
      spec: sql`jsonb_set(${generated_resumes.spec}, '{_cover_letter}', ${JSON.stringify(artifact)}::jsonb, true)`,
    }).where(and(eq(generated_resumes.id, row.id), eq(generated_resumes.user_id, row.user_id)))
      .returning({ id: generated_resumes.id });
  } catch (error) {
    await del(blob.url).catch(() => undefined);
    throw error;
  }
  if (!updated[0]) {
    await del(blob.url).catch(() => undefined);
    throw new Error('Application changed before the cover letter could be saved');
  }
  if (previous?.object_key && previous.object_key !== artifact.object_key) {
    const previousUrl = await resolveBlobUrl(previous.object_key).catch(() => null);
    if (previousUrl) await del(previousUrl).catch(() => undefined);
  }
  return { cover_letter: artifact, blob_url: blob.url };
}

export async function generateStoredCoverLetter(row: ApplicationRow, force = false, capabilityConfirmed = false) {
  const stored = row.spec as StoredSpec;
  const review = readApplicationReview(stored);
  const job = row.job_context as { company?: string; role?: string };
  if (!review?.jd_text || !job.company || !job.role) throw new Error('Application packet is incomplete');
  if (!canGenerateCoverLetter(review.cover_letter_supported, capabilityConfirmed)) {
    throw new Error('The employer portal does not expose a cover-letter attachment field');
  }
  const existing = storedCoverLetter(row);
  if (existing && !force) return { cover_letter: existing, blob_url: undefined };
  const source = await candidateContext(row);
  let body = '';
  let validation = { issues: ['not generated'], warnings: [] as string[], word_count: 0, body: '' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    body = await generateCoverLetter({ company: job.company, role: job.role, jd_text: review.jd_text, candidate_source: source }, validation.issues);
    validation = validateCoverLetter(body, job.company, job.role, source);
    if (validation.issues.length === 0) break;
  }
  if (validation.issues.length > 0) {
    const error = new Error('The cover letter did not pass grounding checks.') as Error & { issues?: string[] };
    error.issues = validation.issues;
    throw error;
  }
  return persistCoverLetter(row, validation.body, validation.warnings, validation.word_count, false);
}

export async function saveStoredCoverLetter(row: ApplicationRow, body: string) {
  const review = readApplicationReview(row.spec);
  const job = row.job_context as { company?: string; role?: string };
  if (!job.company || !job.role || review?.cover_letter_supported !== true) {
    throw new Error('The employer portal does not expose a cover-letter attachment field');
  }
  const source = await candidateContext(row);
  const validation = validateCoverLetter(body, job.company, job.role, source);
  if (validation.issues.length > 0) {
    const error = new Error('Fix the cover letter before saving.') as Error & { issues?: string[] };
    error.issues = validation.issues;
    throw error;
  }
  return persistCoverLetter(row, validation.body, validation.warnings, validation.word_count, true);
}

export async function deleteStoredCoverLetter(row: ApplicationRow) {
  const existing = storedCoverLetter(row);
  await db.update(generated_resumes).set({
    spec: sql`${generated_resumes.spec} - '_cover_letter'`,
  }).where(and(eq(generated_resumes.id, row.id), eq(generated_resumes.user_id, row.user_id)));
  if (existing?.object_key) {
    const url = await resolveBlobUrl(existing.object_key).catch(() => null);
    if (url) await del(url).catch(() => undefined);
  }
}
