import type { SubmissionPacket } from './portalSubmission';
import {
  greenhousePostingFromUrl,
  greenhousePublicApplicationSchemaForPosting,
  greenhousePublicQuestionLabelKey,
} from './greenhousePublicApplication';

export {
  greenhousePostingFromUrl,
  greenhousePublicApplicationSchema,
  greenhousePublicQuestionLabelKey,
  type GreenhousePublicApplicationSchema,
} from './greenhousePublicApplication';

export type AtsSubmissionChannelProvider =
  | 'unknown'
  | 'greenhouse'
  | 'ashby'
  | 'lever'
  | 'smartrecruiters'
  | 'workable'
  | 'workday'
  | 'icims'
  | 'bamboohr'
  | 'jazzhr'
  | 'paylocity'
  | 'rippling'
  | 'breezy'
  | 'oracle_taleo'
  | 'sap_successfactors'
  | 'adp'
  | 'ukg'
  | 'jobvite'
  | 'dayforce'
  | 'recruitee'
  | 'teamtailor'
  | 'personio'
  | 'pinpoint'
  | 'comeet'
  | 'zoho_recruit'
  | 'bullhorn'
  | 'indeed'
  | 'linkedin'
  | 'ziprecruiter'
  | 'wellfound'
  | 'handshake';

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
  site?: unknown;
  api_key_env?: unknown;
  field_paths?: unknown;
};

type ConfiguredChannel = {
  ats: AtsSubmissionChannelProvider;
  companyName?: string;
  boardToken?: string;
  organization?: string;
  site?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  fieldPaths?: Record<string, string>;
};

type PostingRef = {
  provider: AtsSubmissionChannelProvider;
  tenant: string;
  jobId: string;
  reason?: string;
};

type SubmitOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

const CHANNEL_CONFIG_ENV = 'LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON';
const SUPPORTED_CHANNELS = new Set<AtsSubmissionChannelProvider>([
  'greenhouse',
  'ashby',
  'lever',
  'smartrecruiters',
  'workable',
  'workday',
  'icims',
  'bamboohr',
  'jazzhr',
  'paylocity',
  'rippling',
  'breezy',
  'oracle_taleo',
  'sap_successfactors',
  'adp',
  'ukg',
  'jobvite',
  'dayforce',
  'recruitee',
  'teamtailor',
  'personio',
  'pinpoint',
  'comeet',
  'zoho_recruit',
  'bullhorn',
  'indeed',
  'linkedin',
  'ziprecruiter',
  'wellfound',
  'handshake',
]);

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

function parsedHttpsUrl(rawUrl: string | undefined): URL | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? url : null;
}

function pathParts(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

function providerPosting(
  provider: AtsSubmissionChannelProvider,
  tenant: string | undefined,
  jobId: string | undefined,
  reason?: string,
): PostingRef | null {
  const cleanTenant = tenant?.trim();
  const cleanJobId = jobId?.trim();
  if (!cleanTenant || !cleanJobId) return null;
  return { provider, tenant: cleanTenant, jobId: cleanJobId, reason };
}

function unavailableAssessment(posting: PostingRef, reason: string): AtsSubmissionAssessment {
  return {
    provider: posting.provider,
    status: 'unavailable',
    reason,
    board_token: posting.tenant,
    job_id: posting.jobId,
  };
}

export function ashbyPostingFromUrl(rawUrl: string | undefined): { organization: string; jobPostingId: string } | null {
  const url = parsedHttpsUrl(rawUrl);
  if (!url || url.hostname.toLowerCase() !== 'jobs.ashbyhq.com') return null;
  const parts = pathParts(url);
  if (parts.length < 2) return null;
  const [organization, jobPostingId] = parts;
  if (!/^[0-9a-fA-F-]{36}$/.test(jobPostingId)) return null;
  return { organization, jobPostingId };
}

export function leverPostingFromUrl(rawUrl: string | undefined): { site: string; postingId: string } | null {
  const url = parsedHttpsUrl(rawUrl);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'jobs.lever.co' && host !== 'jobs.eu.lever.co') return null;
  const parts = pathParts(url);
  return parts[0] && parts[1] ? { site: parts[0], postingId: parts[1] } : null;
}

/* Exported for lib/duplicateApplication, which needs the same "which posting is this URL" reading
 * to decide whether two packets are the same posting. Nothing else about it changed. */
export function genericKnownPosting(rawUrl: string | undefined): PostingRef | null {
  const url = parsedHttpsUrl(rawUrl);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = pathParts(url);
  const joined = parts.join('/');
  if (host === 'jobs.smartrecruiters.com' && parts.length >= 2) {
    const uuid = parts.find((part) => /^[0-9a-fA-F-]{36}$/.test(part));
    return providerPosting('smartrecruiters', parts[0], uuid ?? parts[1]);
  }
  if (host === 'apply.workable.com' && parts.length >= 3 && parts[1] === 'j') return providerPosting('workable', parts[0], parts[2]);
  if (host.endsWith('myworkdayjobs.com')) return providerPosting('workday', host.split('.')[0], parts.at(-1));
  if (host.includes('icims.com')) return providerPosting('icims', host.split('.')[0], url.searchParams.get('job') ?? parts.at(-1));
  if (host.endsWith('bamboohr.com')) return providerPosting('bamboohr', host.split('.')[0], url.searchParams.get('id') ?? parts.at(-1));
  if (host.endsWith('applytojob.com')) return providerPosting('jazzhr', host.split('.')[0], parts.at(-1));
  if (host.includes('paylocity.com')) return providerPosting('paylocity', host.split('.')[0], url.searchParams.get('jobid') ?? parts.at(-1));
  if (host === 'jobs.rippling.com') return providerPosting('rippling', parts[0], parts.at(-1));
  if (host === 'jobs.breezy.hr') return providerPosting('breezy', parts[0], parts.at(-1));
  if (host.includes('taleo.net')) return providerPosting('oracle_taleo', host.split('.')[0], url.searchParams.get('job') ?? parts.at(-1));
  if (host.includes('successfactors.com') || host.endsWith('jobs2web.com')) return providerPosting('sap_successfactors', host.split('.')[0], url.searchParams.get('job') ?? parts.at(-1));
  if (host.includes('adp.com')) return providerPosting('adp', host.split('.')[0], url.searchParams.get('jobId') ?? parts.at(-1));
  if (host.includes('ukg.com') || host.includes('ultipro.com')) return providerPosting('ukg', host.split('.')[0], url.searchParams.get('jobId') ?? parts.at(-1));
  if (host.includes('jobvite.com')) return providerPosting('jobvite', host.split('.')[0], parts.at(-1));
  if (host.includes('dayforcehcm.com') || host.includes('dayforce.com')) return providerPosting('dayforce', host.split('.')[0], url.searchParams.get('jobId') ?? parts.at(-1));
  if (host === 'recruitee.com' || host.endsWith('.recruitee.com')) return providerPosting('recruitee', host.split('.')[0], parts.at(-1));
  if (host.endsWith('teamtailor.com')) return providerPosting('teamtailor', host.split('.')[0], parts.at(-1));
  if (host.includes('personio.')) return providerPosting('personio', host.split('.')[0], parts.at(-1));
  if (host.includes('pinpointhq.com')) return providerPosting('pinpoint', host.split('.')[0], parts.at(-1));
  if (host.includes('comeet.co')) return providerPosting('comeet', host.split('.')[0], parts.at(-1));
  if (host.includes('zohorecruit.')) return providerPosting('zoho_recruit', host.split('.')[0], parts.at(-1));
  if (host.includes('bullhornstaffing.com')) return providerPosting('bullhorn', host.split('.')[0], parts.at(-1));
  if (host.endsWith('indeed.com')) return providerPosting('indeed', host.split('.').slice(-2).join('.'), url.searchParams.get('jk') ?? parts.at(-1));
  if (host.endsWith('linkedin.com') && joined.includes('jobs/view')) return providerPosting('linkedin', 'linkedin', parts.at(-1));
  if (host.endsWith('ziprecruiter.com')) return providerPosting('ziprecruiter', 'ziprecruiter', parts.at(-1));
  if (host.endsWith('wellfound.com')) return providerPosting('wellfound', 'wellfound', parts.at(-1));
  if (host.endsWith('joinhandshake.com')) return providerPosting('handshake', 'handshake', parts.at(-1));
  return null;
}

/** Keep only public provider fields needed to reproduce one posting identity. */
export function canonicalPublicPostingUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  const greenhouse = greenhousePostingFromUrl(rawUrl);
  if (greenhouse) {
    return `https://boards.greenhouse.io/${encodeURIComponent(greenhouse.boardToken)}/jobs/${greenhouse.jobId}`;
  }
  const posting = genericKnownPosting(rawUrl);
  const allowedQueryNames = (() => {
    if (!posting) return [] as string[];
    if (posting.provider === 'oracle_taleo') return ['job'];
    if (posting.provider === 'sap_successfactors') {
      const jobKey = ['jobId', 'career_job_req_id', 'job_application']
        .find((key) => url.searchParams.has(key));
      return [...(jobKey ? [jobKey] : []), 'company'];
    }
    if (posting.provider === 'adp') {
      if (url.hostname.toLowerCase() === 'myjobs.adp.com') return ['reqId'];
      return ['jobId', url.searchParams.has('cid') ? 'cid' : 'company'];
    }
    if (posting.provider === 'ukg') {
      return url.hostname.toLowerCase() === 'recruiting.ultipro.com'
        ? ['opportunityId']
        : ['jobId'];
    }
    if (posting.provider === 'indeed') return ['jk'];
    if (posting.provider === 'ziprecruiter') return ['jid'];
    return [] as string[];
  })();
  const retained = allowedQueryNames
    .map((name) => [name, url.searchParams.get(name)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  url.search = '';
  for (const [name, value] of retained) url.searchParams.set(name, value);
  url.hash = '';
  return url.toString();
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
    if (!SUPPORTED_CHANNELS.has(ats as AtsSubmissionChannelProvider)) continue;
    const apiKeyEnv = trimmed(item.api_key_env);
    if (!apiKeyEnv) continue;
    const apiKey = trimmed(env[apiKeyEnv]);
    if (!apiKey) continue;
    channels.push({
      ats: ats as AtsSubmissionChannelProvider,
      companyName: trimmed(item.company_name),
      boardToken: trimmed(item.board_token),
      organization: trimmed(item.organization),
      site: trimmed(item.site),
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

function leverChannel(rawUrl: string | undefined, env: NodeJS.ProcessEnv): {
  assessment: AtsSubmissionAssessment;
  channel?: ConfiguredChannel;
} | null {
  const posting = leverPostingFromUrl(rawUrl);
  if (!posting) return null;
  const site = normalizeToken(posting.site);
  const channel = configuredAtsSubmissionChannels(env).find(
    (item) => item.ats === 'lever' && normalizeToken(item.site ?? item.boardToken) === site,
  );
  if (!channel) {
    return {
      assessment: {
        provider: 'lever',
        status: 'unavailable',
        reason: `Missing employer-authorized Lever Postings API credentials for ${posting.site}.`,
        board_token: posting.site,
        job_id: posting.postingId,
      },
    };
  }
  return {
    channel,
    assessment: {
      provider: 'lever',
      status: 'available',
      board_token: posting.site,
      job_id: posting.postingId,
    },
  };
}

const PROVIDER_UNAVAILABLE_REASONS: Record<AtsSubmissionChannelProvider, string> = {
  greenhouse: 'Missing employer-authorized Greenhouse Job Board API credentials.',
  ashby: 'Missing employer-authorized Ashby API credentials and application form paths.',
  lever: 'Missing employer-authorized Lever Postings API credentials.',
  smartrecruiters: 'SmartRecruiters Application API requires employer OAuth credentials and explicit consent decision mapping.',
  workable: 'Workable does not expose a public applicant-submit API for arbitrary third-party submissions.',
  workday: 'Workday Recruiting submission APIs are tenant-specific and require employer-authorized Workday credentials.',
  icims: 'iCIMS submission APIs require employer or partner credentials and tenant-specific application mapping.',
  bamboohr: 'BambooHR applicant APIs are employer-account integrations, not public job-board submission endpoints.',
  jazzhr: 'JazzHR does not expose a general public applicant-submit API for third-party use.',
  paylocity: 'Paylocity application submission requires employer tenant access, not a public job-board API.',
  rippling: 'Rippling recruiting submission is tenant-controlled and does not expose a public applicant-submit API.',
  breezy: 'BreezyHR API submission requires employer API access and job-specific custom field mapping.',
  oracle_taleo: 'Oracle Taleo submission requires employer tenant integration credentials.',
  sap_successfactors: 'SAP SuccessFactors Recruiting submission requires employer tenant OData or integration credentials.',
  adp: 'ADP Recruiting integrations require marketplace or employer-authorized credentials.',
  ukg: 'UKG recruiting submission requires employer tenant integration credentials.',
  jobvite: 'Jobvite submission APIs require employer-authorized credentials and tenant-specific mapping.',
  dayforce: 'Dayforce recruiting submission requires employer tenant integration credentials.',
  recruitee: 'Recruitee API access is employer-owned and needs a configured company token before submission.',
  teamtailor: 'Teamtailor candidate submission requires employer API credentials and configured consent handling.',
  personio: 'Personio Recruiting API access is employer-authorized and tenant-specific.',
  pinpoint: 'Pinpoint application APIs require employer-authorized credentials.',
  comeet: 'Comeet candidate APIs require employer-authorized credentials.',
  zoho_recruit: 'Zoho Recruit submissions require employer OAuth credentials and portal-specific mapping.',
  bullhorn: 'Bullhorn submissions require employer-authorized REST credentials.',
  indeed: 'Indeed Apply is a partner integration and cannot submit to arbitrary employer jobs without partner configuration.',
  linkedin: 'LinkedIn Easy Apply is not a public applicant-submit API for arbitrary third-party submissions.',
  ziprecruiter: 'ZipRecruiter application submission requires partner or employer-authorized integration access.',
  wellfound: 'Wellfound application submission is account and partner controlled, not a public ATS API.',
  handshake: 'Handshake applications require platform authorization and are not exposed as a public ATS API.',
  unknown: 'No ATS API channel matches this portal URL.',
};

function genericProviderAssessment(rawUrl: string | undefined): AtsSubmissionAssessment | null {
  const posting = genericKnownPosting(rawUrl);
  if (!posting) return null;
  return unavailableAssessment(posting, PROVIDER_UNAVAILABLE_REASONS[posting.provider]);
}

export function assessAtsSubmissionChannel(rawUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): AtsSubmissionAssessment | null {
  const greenhouse = greenhouseChannel(rawUrl, env);
  if (greenhouse) return greenhouse.assessment;
  const ashby = ashbyChannel(rawUrl, env);
  if (ashby) return ashby.assessment;
  const lever = leverChannel(rawUrl, env);
  if (lever) return lever.assessment;
  return genericProviderAssessment(rawUrl);
}

function questionFieldBlockers(packet: SubmissionPacket): string[] {
  return packet.questions
    .filter((item) => item.answer.trim() && !item.atsApiField?.trim())
    .map((item) => item.question.slice(0, 120));
}

/* THE PART NAME IS A MAPPING, NOT A WORD.
 *
 * Greenhouse and Lever appended the transcript under the hardcoded literal `'transcript'`, chosen
 * because that is what the document is called. A multipart part name an API does not recognise is
 * accepted at the HTTP level and dropped: the POST returns 200, the application is filed, the
 * employer never receives the file, and nothing errors, logs, or shows on the dashboard, which goes
 * on saying sent. That is the worst failure shape available, and it is exactly the one
 * appendGreenhouseQuestionFields (:516) already refuses to produce for a text answer - it posts
 * nothing it cannot name and hands the whole channel back as `not_applicable` with the field named.
 * The document resolves its name the same way and refuses on the same terms.
 *
 * field_paths IS THE ONLY SOURCE WITH ANY AUTHORITY over what an employer's own form calls this
 * document. It is employer-authorized configuration and it travels with the API credentials; Ashby
 * has addressed every one of its fields that way since it was written.
 *
 * REFUSING COSTS THE APPLICATION NOTHING. `not_applicable` is not a dead end:
 * submitViaAtsSubmissionChannel (routes/submissionRunner.ts) logs the reason and returns false, and
 * the browser submit runs instead. The browser path is the one that measured a transcript control on
 * this employer's form in the first place - that measurement is why the packet carries the file at
 * all - so refusing here sends the application through the door that can actually attach it.
 *
 * THE HONEST LIMIT, stated because it is what this decision does NOT settle. Whether `transcript` is
 * a real part name on the Greenhouse Job Board API or the Lever Postings API is UNPROVEN. Neither
 * documents one, no Litos submission has ever gone out through a configured board token carrying a
 * transcript, and no response has ever been read on the question. It can only be settled by a real
 * API submission to a real posting that asks for one. Until it is, this file posts a document under
 * a configured name or under none, and that holds for the obvious name as much as any other.
 */
function transcriptMissingFields(channel: ConfiguredChannel, packet: SubmissionPacket): string[] {
  if (!packet.transcript || !packet.transcriptName) return [];
  return trimmed(channel.fieldPaths?.transcript) ? [] : ['transcript'];
}

/** The configured name for the transcript part, or undefined when nothing has named it. */
function transcriptFieldName(channel: ConfiguredChannel): string | undefined {
  return trimmed(channel.fieldPaths?.transcript);
}

function appendMappedQuestionFields(form: FormData, packet: SubmissionPacket) {
  for (const item of packet.questions) {
    if (!item.atsApiField?.trim() || !item.answer.trim()) continue;
    form.append(item.atsApiField.trim(), item.answer);
  }
}

async function greenhousePublicQuestionFieldMap(
  posting: { boardToken: string; jobId: string },
  fetchImpl: typeof fetch,
): Promise<Map<string, string>> {
  const schema = await greenhousePublicApplicationSchemaForPosting(posting, fetchImpl);
  const fields = new Map<string, string>();
  for (const [label, fieldName] of Object.entries(schema?.fieldNamesByLabel ?? {})) fields.set(label, fieldName);
  return fields;
}

async function appendGreenhouseQuestionFields(
  form: FormData,
  posting: { boardToken: string; jobId: string },
  packet: SubmissionPacket,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const unmapped = packet.questions.filter((item) => item.answer.trim() && !item.atsApiField?.trim());
  const fieldMap = unmapped.length > 0
    ? await greenhousePublicQuestionFieldMap(posting, fetchImpl)
    : new Map<string, string>();
  const missingFields: string[] = [];
  for (const item of packet.questions) {
    if (!item.answer.trim()) continue;
    const directField = item.atsApiField?.trim();
    const publicField = greenhousePublicQuestionLabelKey(item.question)
      ? fieldMap.get(greenhousePublicQuestionLabelKey(item.question)!)
      : undefined;
    const field = directField ?? publicField;
    if (!field) {
      missingFields.push(item.question.slice(0, 120));
      continue;
    }
    form.append(field, item.answer);
  }
  return missingFields;
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
  /* The API channel carries every document the browser paths carry, or the same application is sent
   * two different ways depending on whether a board token happens to be configured. A packet only
   * reaches this line holding a transcript when a browser prepare measured a transcript control on
   * this employer's own form, so the part is appended for a posting that asked for one and for no
   * other. Guarded on both fields for the same reason every other upload here is: a name without
   * bytes, or bytes without a name, is a half-populated part rather than an attachment. The third
   * term is the employer's own name for the part - see transcriptMissingFields for why an unnamed
   * document refuses the channel instead of going out under a guess. */
  const transcriptField = transcriptFieldName(channel);
  if (packet.transcript && packet.transcriptName && transcriptField) {
    form.append(transcriptField, pdfBlob(packet.transcript), packet.transcriptName);
  }
  /* One refusal names everything this channel cannot map, rather than one per resolver: fixing the
   * transcript mapping only to redeploy into the same refusal over a question is a round trip the
   * list can spare whoever is configuring the channel. */
  const missingFields = [
    ...await appendGreenhouseQuestionFields(form, posting, packet, fetchImpl),
    ...transcriptMissingFields(channel, packet),
  ];
  if (missingFields.length > 0) {
    return {
      kind: 'not_applicable',
      assessment: {
        provider: 'greenhouse',
        status: 'unavailable',
        reason: 'Required reviewed questions or attached documents are missing Greenhouse API field mappings.',
        board_token: posting.boardToken,
        job_id: posting.jobId,
        missing_fields: missingFields,
      },
    };
  }
  const response = await fetchImpl(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(posting.boardToken)}/jobs/${encodeURIComponent(posting.jobId)}`,
    {
      method: 'POST',
      headers: { Authorization: authHeader(channel.apiKey!) },
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
  const missingFields = [...questionFieldBlockers(packet), ...transcriptMissingFields(channel, packet)];
  if (missingFields.length > 0) {
    return {
      kind: 'not_applicable',
      assessment: {
        provider: 'ashby',
        status: 'unavailable',
        reason: 'Required reviewed questions or attached documents are missing Ashby application form path mappings.',
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
  /* Ashby addresses every field by a configured path, so there is no default path to fall back to:
   * a transcript is an employer-configured question, and its path is tenant data. This used to SKIP
   * the file when nothing had named it, which reads as the careful choice and is the same outcome as
   * Greenhouse's wrong part name - an application filed without the document the form asked for, and
   * no error anywhere. The refusal above is what makes not-naming-it mean not-sending-it-here rather
   * than sending-it-nowhere; the cover letter beside it is a separate decision and keeps its skip. */
  const transcriptPath = transcriptFieldName(channel);
  if (packet.transcript && packet.transcriptName && transcriptPath) {
    form.append(`applicationForm[${transcriptPath}]`, pdfBlob(packet.transcript), packet.transcriptName);
  }
  for (const item of packet.questions) {
    if (!item.atsApiField?.trim() || !item.answer.trim()) continue;
    form.append(`applicationForm[${item.atsApiField.trim()}]`, item.answer);
  }
  const response = await fetchImpl('https://api.ashbyhq.com/applicationForm.submit', {
    method: 'POST',
    headers: { Authorization: authHeader(channel.apiKey!) },
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

async function submitLever(
  rawUrl: string,
  channel: ConfiguredChannel,
  packet: SubmissionPacket,
  fetchImpl: typeof fetch,
): Promise<AtsSubmissionResult> {
  const posting = leverPostingFromUrl(rawUrl);
  if (!posting) throw new Error('Lever posting URL could not be parsed');
  const missingFields = [...questionFieldBlockers(packet), ...transcriptMissingFields(channel, packet)];
  if (missingFields.length > 0) {
    return {
      kind: 'not_applicable',
      assessment: {
        provider: 'lever',
        status: 'unavailable',
        reason: 'Required reviewed questions or attached documents are missing Lever API field mappings.',
        board_token: posting.site,
        job_id: posting.postingId,
        missing_fields: missingFields,
      },
    };
  }
  const form = new FormData();
  form.append('name', packet.fullName);
  form.append('email', packet.email);
  if (packet.phone) form.append('phone', packet.phone);
  if (packet.linkedinUrl) form.append('urls[LinkedIn]', packet.linkedinUrl);
  if (packet.githubUrl) form.append('urls[GitHub]', packet.githubUrl);
  if (packet.portfolioUrl) form.append('urls[Portfolio]', packet.portfolioUrl);
  form.append('resume', pdfBlob(packet.resume), packet.resumeName);
  // Lever carries no cover letter through this channel, and that is a gap rather than a decision, so
  // it is not a precedent for leaving the transcript out too. Same guard as the other two builders,
  // and the same third term: the part is named by field_paths or the channel has already refused.
  const transcriptField = transcriptFieldName(channel);
  if (packet.transcript && packet.transcriptName && transcriptField) {
    form.append(transcriptField, pdfBlob(packet.transcript), packet.transcriptName);
  }
  appendMappedQuestionFields(form, packet);
  const response = await fetchImpl(
    `https://api.lever.co/v0/postings/${encodeURIComponent(posting.site)}/${encodeURIComponent(posting.postingId)}?key=${encodeURIComponent(channel.apiKey!)}`,
    {
      method: 'POST',
      body: form,
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Lever API submission failed with ${response.status}: ${text.slice(0, 300)}`);
  return {
    kind: 'submitted',
    provider: 'lever',
    confirmationText: text.trim() || 'Lever accepted the application through the Postings API.',
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
      assessment: { provider: 'unknown', status: 'unavailable', reason: 'Missing application portal URL.' },
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
  const lever = leverChannel(rawUrl, env);
  if (lever) {
    if (!lever.channel) return { kind: 'not_applicable', assessment: lever.assessment };
    return submitLever(rawUrl, lever.channel, packet, fetchImpl);
  }
  const generic = genericProviderAssessment(rawUrl);
  if (generic) return { kind: 'not_applicable', assessment: generic };
  return {
    kind: 'not_applicable',
    assessment: { provider: 'unknown', status: 'unavailable', reason: 'No ATS API channel matches this portal URL.' },
  };
}
