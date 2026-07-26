import type { SubmissionPacket } from './portalSubmission';

export type AuthorizedAtsChannel = 'greenhouse_job_board_api';

export type AuthorizedGreenhouseRoute = {
  channel: AuthorizedAtsChannel;
  boardToken: string;
  jobId: string;
  apiKey: string;
};

type GreenhouseField = {
  name: string;
  type: 'input_file' | 'input_text' | 'input_hidden' | 'textarea' | 'multi_value_single_select' | 'multi_value_multi_select';
  values?: Array<{ value: string | number; label: string }>;
};

type GreenhouseQuestion = { required: boolean; label: string; fields: GreenhouseField[] };
type GreenhouseJob = {
  id: number;
  title?: string;
  questions?: GreenhouseQuestion[];
  location_questions?: GreenhouseQuestion[];
  data_compliance?: { requires_consent?: boolean } | Array<{ requires_consent?: boolean }>;
};

export class AuthorizedAtsValidationError extends Error {
  constructor(readonly blockers: string[]) {
    super(`Official ATS submission needs attention: ${blockers.join('; ')}`);
  }
}

function credentialRegistry(raw = process.env.GREENHOUSE_PARTNER_BOARD_KEYS_JSON): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([board, key]) => /^[a-z0-9_-]+$/i.test(board) && typeof key === 'string' && key.trim())
      .map(([board, key]) => [board.toLowerCase(), String(key).trim()]));
  } catch {
    return {};
  }
}

export function hasAnyAuthorizedAtsCredential(raw = process.env.GREENHOUSE_PARTNER_BOARD_KEYS_JSON): boolean {
  return Object.keys(credentialRegistry(raw)).length > 0;
}

export function authorizedGreenhouseRoute(portalUrl: string, raw = process.env.GREENHOUSE_PARTNER_BOARD_KEYS_JSON): AuthorizedGreenhouseRoute | null {
  let url: URL;
  try { url = new URL(portalUrl); } catch { return null; }
  if (!['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const jobsAt = parts.findIndex((part) => part === 'jobs');
  const boardToken = jobsAt > 0 ? parts[jobsAt - 1]!.toLowerCase() : '';
  const jobId = jobsAt >= 0 ? parts[jobsAt + 1] ?? '' : '';
  if (!/^[a-z0-9_-]+$/i.test(boardToken) || !/^\d+$/.test(jobId)) return null;
  const apiKey = credentialRegistry(raw)[boardToken];
  return apiKey ? { channel: 'greenhouse_job_board_api', boardToken, jobId, apiKey } : null;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts.shift() ?? '', lastName: parts.join(' ') };
}

function packetAnswer(packet: SubmissionPacket, label: string): string | undefined {
  const key = normalized(label);
  if (/linkedin/.test(key)) return packet.linkedinUrl;
  if (/github/.test(key)) return packet.githubUrl;
  if (/portfolio|website/.test(key)) return packet.portfolioUrl;
  return packet.questions.find((question) => normalized(question.question) === key)?.answer.trim() || undefined;
}

function selectValue(field: GreenhouseField, answer: string): string | number | Array<string | number> | undefined {
  if (!field.values?.length) return answer;
  const requested = answer.split(/[,;\n]/).map(normalized).filter(Boolean);
  const matches = field.values.filter((option) => requested.includes(normalized(option.label)));
  if (field.type === 'multi_value_multi_select') return matches.map((option) => option.value);
  return matches[0]?.value;
}

export function buildGreenhouseApplicationBody(job: GreenhouseJob, packet: SubmissionPacket): { body: Record<string, unknown>; blockers: string[] } {
  const { firstName, lastName } = splitName(packet.fullName);
  const body: Record<string, unknown> = {
    first_name: firstName,
    last_name: lastName,
    email: packet.email,
    resume_content: packet.resume.toString('base64'),
    resume_content_filename: packet.resumeName,
  };
  if (packet.phone) body.phone = packet.phone;
  if (packet.coverLetter && packet.coverLetterName) {
    body.cover_letter_content = packet.coverLetter.toString('base64');
    body.cover_letter_content_filename = packet.coverLetterName;
  }
  const blockers: string[] = [];
  if (!firstName) blockers.push('First name is required by Greenhouse');
  if (!lastName) blockers.push('Last name is required by Greenhouse');
  for (const question of [...(job.questions ?? []), ...(job.location_questions ?? [])]) {
    if (question.fields.some((field) => ['latitude', 'longitude'].includes(field.name))) {
      if (question.required) blockers.push(`${question.label} requires verified location coordinates`);
      continue;
    }
    const answer = packetAnswer(packet, question.label);
    const standardSatisfied = question.fields.some((field) => {
      if (field.name === 'first_name') return Boolean(firstName);
      if (field.name === 'last_name') return Boolean(lastName);
      if (field.name === 'email') return Boolean(packet.email);
      if (field.name === 'phone') return Boolean(packet.phone);
      if (field.name === 'resume' || field.name === 'resume_text') return packet.resume.length > 0;
      if (field.name === 'cover_letter' || field.name === 'cover_letter_text') return Boolean(packet.coverLetter);
      return false;
    });
    if (standardSatisfied) continue;
    const fillable = question.fields.find((field) => field.type !== 'input_file' && field.type !== 'input_hidden');
    if (answer && fillable) {
      const value = selectValue(fillable, answer);
      if (value !== undefined && (!Array.isArray(value) || value.length > 0)) body[fillable.name] = value;
      else if (question.required) blockers.push(`${question.label} has an answer that does not match an allowed option`);
    } else if (question.required) blockers.push(`${question.label} is required by the employer`);
  }
  const compliance = job.data_compliance
    ? Array.isArray(job.data_compliance) ? job.data_compliance : [job.data_compliance]
    : [];
  if (compliance.some((item) => item.requires_consent)) blockers.push('Employer data-processing consent requires an applicant decision');
  return { body, blockers };
}

export async function inspectAuthorizedGreenhouseApplication(route: AuthorizedGreenhouseRoute, packet: SubmissionPacket, fetchImpl: typeof fetch = fetch): Promise<{ job: GreenhouseJob; body: Record<string, unknown> }> {
  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(route.boardToken)}/jobs/${route.jobId}`;
  const response = await fetchImpl(`${endpoint}?questions=true`);
  if (!response.ok) throw new Error(`Greenhouse job form lookup failed with status ${response.status}`);
  const job = await response.json() as GreenhouseJob;
  const prepared = buildGreenhouseApplicationBody(job, packet);
  if (prepared.blockers.length > 0) throw new AuthorizedAtsValidationError(prepared.blockers);
  return { job, body: prepared.body };
}

export async function submitAuthorizedGreenhouseApplication(route: AuthorizedGreenhouseRoute, packet: SubmissionPacket, fetchImpl: typeof fetch = fetch): Promise<{ confirmationText: string; finalUrl: string; referenceId?: string }> {
  const { body } = await inspectAuthorizedGreenhouseApplication(route, packet, fetchImpl);
  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(route.boardToken)}/jobs/${route.jobId}`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${route.apiKey}:`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Greenhouse application submission failed with status ${response.status}`);
  let referenceId: string | undefined;
  try {
    const parsed = JSON.parse(responseText) as { id?: string | number; application_id?: string | number };
    referenceId = String(parsed.application_id ?? parsed.id ?? '') || undefined;
  } catch { referenceId = undefined; }
  return { confirmationText: 'Greenhouse accepted the application through the employer-authorized Job Board API.', finalUrl: endpoint, referenceId };
}
