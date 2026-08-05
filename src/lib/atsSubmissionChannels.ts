import type { SubmissionPacket } from './portalSubmission';

export type AtsSubmissionChannelProvider = 'greenhouse' | 'ashby';

export type AtsSubmissionAssessment = {
  provider: AtsSubmissionChannelProvider;
  status: 'available' | 'unavailable';
  reason?: string;
  board_token?: string;
  job_id?: string;
  missing_fields?: string[];
};

export type AtsSubmissionResult =
  | {
    kind: 'submitted';
    provider: AtsSubmissionChannelProvider;
    confirmationText: string;
    finalUrl: string;
    referenceId?: string;
  }
  | {
    kind: 'not_applicable';
    assessment: AtsSubmissionAssessment;
  };

type RawChannelConfig = {
  ats?: unknown;
  company_name?: unknown;
  board_token?: unknown;
  organization?: unknown;
  api_key_env?: unknown;
  field_paths?: unknown;
};

type ConfiguredChannel = {
  ats: AtsSubmissionChannelProvider;
  companyName?: string;
  boardToken?: string;
  organization?: string;
  apiKeyEnv: string;
  apiKey: string;
  fieldPaths?: Record<string, string>;
};

type SubmitOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

const CHANNEL_CONFIG_ENV = 'LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON';
const GREENHOUSE_EMBED_TOKEN_HOSTS = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io']);

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeToken(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function fullNameParts(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export function greenhousePostingFromUrl(rawUrl: string | undefined): { boardToken: string; jobId: string } | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'boards.greenhouse.io' && parts.length >= 3 && parts[1] === 'jobs' && /^\d+$/.test(parts[2])) {
    return { boardToken: parts[0], jobId: parts[2] };
  }
  if (GREENHOUSE_EMBED_TOKEN_HOSTS.has(host) && parts[0] === 'embed' && parts[1] === 'job_app') {
    const token = url.searchParams.get('token');
    const boardToken = url.searchParams.get('for') ?? url.searchParams.get('b');
    if (token && /^\d+$/.test(token) && boardToken) return { boardToken, jobId: token };
  }
  return null;
}

export function ashbyPostingFromUrl(rawUrl: string | undefined): { organization: string; jobPostingId: string } | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'jobs.ashbyhq.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [organization, jobPostingId] = parts;
  if (!/^[0-9a-fA-F-]{36}$/.test(jobPostingId)) return null;
  return { organization, jobPostingId };
}

export function configuredAtsSubmissionChannels(env: NodeJS.ProcessEnv = process.env): ConfiguredChannel[] {
  const raw = env[CHANNEL_CONFIG_ENV];
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const channels: ConfiguredChannel[] = [];
  for (const item of parsed as RawChannelConfig[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const ats = trimmed(item.ats)?.toLowerCase();
    if (ats !== 'greenhouse' && ats !== 'ashby') continue;
    const apiKeyEnv = trimmed(item.api_key_env);
    if (!apiKeyEnv) continue;
    const apiKey = trimmed(env[apiKeyEnv]);
    if (!apiKey) continue;
    channels.push({
      ats,
      companyName: trimmed(item.company_name),
      boardToken: trimmed(item.board_token),
      organization: trimmed(item.organization),
      apiKeyEnv,
      apiKey,
      fieldPaths: sanitizeFieldPaths(item.field_paths),
    });
  }
  return channels;
}

function sanitizeFieldPaths(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const paths: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const path = trimmed(raw);
    if (path) paths[key] = path;
  }
  return Object.keys(paths).length > 0 ? paths : undefined;
}

function greenhouseChannel(rawUrl: string | undefined, env: NodeJS.ProcessEnv): {
  assessment: AtsSubmissionAssessment;
  channel?: ConfiguredChannel;
} | null {
  const posting = greenhousePostingFromUrl(rawUrl);
  if (!posting) return null;
  const boardToken = normalizeToken(posting.boardToken);
  const channel = configuredAtsSubmissionChannels(env).find(
    (item) => item.ats === 'greenhouse' && normalizeToken(item.boardToken) === boardToken,
  );
  if (!channel) {
    return {
      assessment: {
        provider: 'greenhouse',
        status: 'unavailable',
        reason: `Missing employer-authorized Greenhouse Job Board API credentials for ${posting.boardToken}.`,
        board_token: posting.boardToken,
        job_id: posting.jobId,
      },
    };
  }
  return {
    channel,
    assessment: {
      provider: 'greenhouse',
      status: 'available',
      board_token: posting.boardToken,
      job_id: posting.jobId,
    },
  };
}

function ashbyChannel(rawUrl: string | undefined, env: NodeJS.ProcessEnv): {
  assessment: AtsSubmissionAssessment;
  channel?: ConfiguredChannel;
} | null {
  const posting = ashbyPostingFromUrl(rawUrl);
  if (!posting) return null;
  const organization = normalizeToken(posting.organization);
  const channel = configuredAtsSubmissionChannels(env).find(
    (item) => item.ats === 'ashby' && normalizeToken(item.organization) === organization,
  );
  if (!channel) {
    return {
      assessment: {
        provider: 'ashby',
        status: 'unavailable',
        reason: `Missing employer-authorized Ashby API credentials for ${posting.organization}.`,
        board_token: posting.organization,
        job_id: posting.jobPostingId,
      },
    };
  }
  return {
    channel,
    assessment: {
      provider: 'ashby',
      status: 'available',
      board_token: posting.organization,
      job_id: posting.jobPostingId,
    },
  };
}

export function assessAtsSubmissionChannel(rawUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): AtsSubmissionAssessment | null {
  const greenhouse = greenhouseChannel(rawUrl, env);
  if (greenhouse) return greenhouse.assessment;
  const ashby = ashbyChannel(rawUrl, env);
  if (ashby) return ashby.assessment;
  return null;
}

function questionFieldBlockers(packet: SubmissionPacket): string[] {
  return packet.questions
    .filter((item) => item.answer.trim() && !item.atsApiField?.trim())
    .map((item) => item.question.slice(0, 120));
}

function appendMappedQuestionFields(form: FormData, packet: SubmissionPacket) {
  for (const item of packet.questions) {
    if (!item.atsApiField?.trim() || !item.answer.trim()) continue;
    form.append(item.atsApiField.trim(), item.answer);
  }
}

function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

function pdfBlob(buffer: Buffer): Blob {
  return new Blob([new Uint8Array(buffer)], { type: 'application/pdf' });
}

async function submitGreenhouse(
  rawUrl: string,
  channel: ConfiguredChannel,
  packet: SubmissionPacket,
  fetchImpl: typeof fetch,
): Promise<AtsSubmissionResult> {
  const posting = greenhousePostingFromUrl(rawUrl);
  if (!posting) throw new Error('Greenhouse posting URL could not be parsed');
  const missingFields = questionFieldBlockers(packet);
  if (missingFields.length > 0) {
    return {
      kind: 'not_applicable',
      assessment: {
        provider: 'greenhouse',
        status: 'unavailable',
        reason: 'Required reviewed questions are missing Greenhouse API field mappings.',
        board_token: posting.boardToken,
        job_id: posting.jobId,
        missing_fields: missingFields,
      },
    };
  }
  const { firstName, lastName } = fullNameParts(packet.fullName);
  const form = new FormData();
  form.append('first_name', firstName);
  form.append('last_name', lastName);
  form.append('email', packet.email);
  if (packet.phone) form.append('phone', packet.phone);
  if (packet.city) form.append('location', packet.city);
  form.append('resume', pdfBlob(packet.resume), packet.resumeName);
  if (packet.coverLetter && packet.coverLetterName) {
    form.append('cover_letter', pdfBlob(packet.coverLetter), packet.coverLetterName);
  }
  appendMappedQuestionFields(form, packet);
  const response = await fetchImpl(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(posting.boardToken)}/jobs/${encodeURIComponent(posting.jobId)}`,
    {
      method: 'POST',
      headers: { Authorization: authHeader(channel.apiKey) },
      body: form,
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Greenhouse API submission failed with ${response.status}: ${text.slice(0, 300)}`);
  return {
    kind: 'submitted',
    provider: 'greenhouse',
    confirmationText: text.trim() || 'Greenhouse accepted the application through the Job Board API.',
    finalUrl: rawUrl,
    referenceId: response.headers.get('x-request-id') ?? undefined,
  };
}

async function submitAshby(
  rawUrl: string,
  channel: ConfiguredChannel,
  packet: SubmissionPacket,
  fetchImpl: typeof fetch,
): Promise<AtsSubmissionResult> {
  const posting = ashbyPostingFromUrl(rawUrl);
  if (!posting) throw new Error('Ashby posting URL could not be parsed');
  const coreFieldPaths = ['name', 'email', 'resume'];
  const missingCorePaths = coreFieldPaths.filter((key) => !channel.fieldPaths?.[key]?.trim());
  if (missingCorePaths.length > 0) {
    return {
      kind: 'not_applicable',
      assessment: {
        provider: 'ashby',
        status: 'unavailable',
        reason: 'Missing Ashby application form paths for core applicant fields.',
        board_token: posting.organization,
        job_id: posting.jobPostingId,
        missing_fields: missingCorePaths,
      },
    };
  }
  const missingFields = questionFieldBlockers(packet);
  if (missingFields.length > 0) {
    return {
      kind: 'not_applicable',
      assessment: {
        provider: 'ashby',
        status: 'unavailable',
        reason: 'Required reviewed questions are missing Ashby application form path mappings.',
        board_token: posting.organization,
        job_id: posting.jobPostingId,
        missing_fields: missingFields,
      },
    };
  }
  const form = new FormData();
  form.append('jobPostingId', posting.jobPostingId);
  form.append(`applicationForm[${channel.fieldPaths!.name}]`, packet.fullName);
  form.append(`applicationForm[${channel.fieldPaths!.email}]`, packet.email);
  if (packet.phone && channel.fieldPaths?.phone) form.append(`applicationForm[${channel.fieldPaths.phone}]`, packet.phone);
  form.append(`applicationForm[${channel.fieldPaths!.resume}]`, pdfBlob(packet.resume), packet.resumeName);
  if (packet.coverLetter && packet.coverLetterName) {
    const coverLetterPath = channel.fieldPaths?.cover_letter ?? channel.fieldPaths?.coverLetter;
    if (coverLetterPath) form.append(`applicationForm[${coverLetterPath}]`, pdfBlob(packet.coverLetter), packet.coverLetterName);
  }
  for (const item of packet.questions) {
    if (!item.atsApiField?.trim() || !item.answer.trim()) continue;
    form.append(`applicationForm[${item.atsApiField.trim()}]`, item.answer);
  }
  const response = await fetchImpl('https://api.ashbyhq.com/applicationForm.submit', {
    method: 'POST',
    headers: { Authorization: authHeader(channel.apiKey) },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Ashby API submission failed with ${response.status}: ${text.slice(0, 300)}`);
  return {
    kind: 'submitted',
    provider: 'ashby',
    confirmationText: text.trim() || 'Ashby accepted the application through applicationForm.submit.',
    finalUrl: rawUrl,
    referenceId: response.headers.get('x-request-id') ?? undefined,
  };
}

export async function tryAtsSubmissionChannel(
  rawUrl: string | undefined,
  packet: SubmissionPacket,
  options: SubmitOptions = {},
): Promise<AtsSubmissionResult> {
  if (!rawUrl) {
    return {
      kind: 'not_applicable',
      assessment: { provider: 'greenhouse', status: 'unavailable', reason: 'Missing application portal URL.' },
    };
  }
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const greenhouse = greenhouseChannel(rawUrl, env);
  if (greenhouse) {
    if (!greenhouse.channel) return { kind: 'not_applicable', assessment: greenhouse.assessment };
    return submitGreenhouse(rawUrl, greenhouse.channel, packet, fetchImpl);
  }
  const ashby = ashbyChannel(rawUrl, env);
  if (ashby) {
    if (!ashby.channel) return { kind: 'not_applicable', assessment: ashby.assessment };
    return submitAshby(rawUrl, ashby.channel, packet, fetchImpl);
  }
  return {
    kind: 'not_applicable',
    assessment: { provider: 'greenhouse', status: 'unavailable', reason: 'No ATS API channel matches this portal URL.' },
  };
}
