import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  BASE_RESUME_MODEL_CALL_CAP_MS,
  baseResumeSpecFromEvidence,
  generateBaseResumeSpec,
} from './baseResume';
import {
  RESUME_GENERATION_INTERACTIVE_BUDGET_MS,
  generateResumeSpec,
  resumeSpecFromEvidence,
} from './resumeSpec';
import {
  parseResumeFromPdf,
  parseResumeLocally,
  parseResumeWithClaude,
  parsedProfileFromModelText,
  parsedProfileWithOneRepair,
  printedGpaIn,
  reconcileGpaWithSource,
  RESUME_PARSE_BUDGET_MS,
  RESUME_PROVIDER_CALL_CAP_MS,
  RESUME_PROVIDER_HEDGE_DELAY_MS,
  LOCAL_PARSE_LIMITS,
  resumeParseDeadlineFromUploadStart,
  resumeParseCallTimeoutMs,
  splitSpokenLanguages,
  SYSTEM_PROMPT,
} from './parse';

const messagesPrototype = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages) as {
  create: (...args: unknown[]) => unknown;
  stream: (...args: unknown[]) => unknown;
};
const responsesPrototype = Object.getPrototypeOf(new OpenAI({ apiKey: 'test-key' }).responses) as {
  create: (...args: unknown[]) => unknown;
};

// R-047, found in live QA 2026-07-23. Mehek's uploaded resume reads "Bachelor of Science in Computer
// Science & Business Administration, Finance Emphasis". The parser stored "Bachelor of Science in
// Business Administration, Emphasis in Finance": the Computer Science half was dropped and the
// emphasis reworded. Every tailored resume then presented a computer science candidate as a finance
// candidate, and resumeValidate's "education degree differs from uploaded resume" check could not
// catch it, because that check compares the spec against this same corrupted stored value. The only
// defence is the parse prompt, so pin its load-bearing clauses.

test('the parse prompt demands a verbatim degree', () => {
  assert.match(SYSTEM_PROMPT, /copied VERBATIM/);
});

test('the parse prompt names the joint-degree failure it exists to prevent', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /joint or dual degree/);
  assert.match(flat, /carry BOTH halves/i);
});

test('the prompt does not hand the model a ready-made degree to copy', () => {
  // Few-shot contamination: a plausible verbatim degree inside model-visible text is something the
  // model can emit when a resume's education section is unclear, which is the exact fabrication the
  // rule forbids. The concrete R-047 strings belong in a code comment, not the prompt.
  assert.doesNotMatch(SYSTEM_PROMPT, /Bachelor of Science in/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /Emphasis in Finance/i);
});

test('the parse prompt forbids inferring a degree from the school or college name', () => {
  // The prompt is a wrapped template literal, so match across the line breaks rather than pinning
  // one particular wrap position: rewrapping the paragraph must not fail this test.
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /never let the school or college name influence the degree/i);
  assert.match(flat, /business school hosts non-business degrees/i);
});

test('the parse prompt still requires an empty string over an invented degree', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /return an empty string rather than inferring one/i);
});

test('the parse prompt keeps the precise graduation date', () => {
  // Summer 2027 eligibility turns on this. A resume that loses "May 2027" down to a bare year, or
  // gains a year it never printed, changes whether the student qualifies for the posting at all.
  assert.match(SYSTEM_PROMPT, /most precise date printed on the resume/i);
});

test('the parse prompt pins the five-role evidence and ordering contract', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /exactly five distinct job titles/i);
  assert.match(flat, /ordered from strongest to weakest fit/i);
  assert.match(flat, /dated years of experience, past job titles, projects, skills, and stated degree/i);
  assert.match(flat, /match the seniority shown by the evidence/i);
  assert.match(flat, /do not invent a field the resume does not support/i);
  assert.match(flat, /do not return five cosmetic variations/i);
  assert.match(flat, /space of valid job titles is open-ended/i);
  assert.match(flat, /never restrict recommendations.*predefined occupation list/i);
});

function modelProfile(target_roles: unknown): string {
  return JSON.stringify({
    full_name: 'A Candidate', experience: [], skills: [], projects: [], school: '',
    grad_year: 0, target_roles,
  });
}

test('an invalid Anthropic key cannot take down text resume parsing while OpenAI is healthy', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  const calls: Record<string, unknown>[] = [];
  let providerSignal: AbortSignal | undefined;
  mock.method(responsesPrototype, 'create', async (
    body: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ) => {
    calls.push(body);
    providerSignal = options.signal;
    return {
      status: 'completed',
      output_text: modelProfile(FIVE_ROLES),
      incomplete_details: null,
      usage: { input_tokens: 100, output_tokens: 40, input_tokens_details: {} },
    };
  });
  mock.method(messagesPrototype, 'create', async () => {
    throw Object.assign(new Error('API key is invalid'), { status: 401 });
  });

  const controller = new AbortController();
  const parsed = await parseResumeWithClaude('A Candidate\nSoftware engineer', {
    signal: controller.signal,
  });

  assert.equal(parsed.full_name, 'A Candidate');
  assert.equal(calls.length, 1);
  assert.ok(providerSignal, 'the provider receives a cancellation signal');
  assert.equal(controller.signal.aborted, false, 'winning the hedge must not abort the request signal');
  assert.equal(providerSignal?.aborted, true, 'the completed hedge cancels provider-owned work');
  assert.equal(
    ((calls[0].text as { format?: { type?: string } }).format?.type),
    'json_schema',
    'resume parsing must use provider-enforced structured output',
  );
});

test('resume parsing falls back to Anthropic when OpenAI is unavailable', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  mock.method(responsesPrototype, 'create', async () => {
    throw Object.assign(new Error('OpenAI unavailable'), { status: 503 });
  });
  let anthropicCalls = 0;
  mock.method(messagesPrototype, 'create', async () => {
    anthropicCalls += 1;
    return { content: [{ type: 'text', text: modelProfile(FIVE_ROLES) }] };
  });

  const parsed = await parseResumeWithClaude('A Candidate\nSoftware engineer', { hedgeDelayMs: 0 });

  assert.equal(parsed.full_name, 'A Candidate');
  assert.equal(anthropicCalls, 1);
});

test('resume provider calls are capped and share one end-to-end deadline', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  let now = 1_000;
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  mock.method(Date, 'now', () => now);
  const openAITimeouts: number[] = [];
  let openAICalls = 0;
  mock.method(responsesPrototype, 'create', async (_body: unknown, options: { timeout?: number }) => {
    openAITimeouts.push(options.timeout ?? 0);
    openAICalls += 1;
    now += 9_000;
    if (openAICalls === 1) {
      return {
        status: 'completed',
        output_text: modelProfile(['Only one role']),
        incomplete_details: null,
        usage: { input_tokens: 100, output_tokens: 40, input_tokens_details: {} },
      };
    }
    throw Object.assign(new Error('OpenAI repair unavailable'), { status: 503 });
  });

  let anthropicOptions: { timeout?: number; maxRetries?: number } | undefined;
  mock.method(messagesPrototype, 'create', async (_body: unknown, options: { timeout?: number; maxRetries?: number }) => {
    anthropicOptions = options;
    return { content: [{ type: 'text', text: modelProfile(FIVE_ROLES) }] };
  });

  const parsed = await parseResumeWithClaude('A Candidate\nSoftware engineer');

  assert.equal(parsed.full_name, 'A Candidate');
  assert.deepEqual(openAITimeouts, [RESUME_PROVIDER_CALL_CAP_MS, RESUME_PROVIDER_CALL_CAP_MS]);
  assert.equal(anthropicOptions?.timeout, RESUME_PARSE_BUDGET_MS - 18_000);
  assert.equal(anthropicOptions?.maxRetries, 0);
});

test('the resume parse deadline refuses a new provider call instead of resetting the SDK timeout', () => {
  assert.equal(resumeParseDeadlineFromUploadStart(1_000), 1_000 + RESUME_PARSE_BUDGET_MS);
  const deadline = 25_000;
  assert.equal(resumeParseCallTimeoutMs(deadline, 1_000), RESUME_PROVIDER_CALL_CAP_MS);
  assert.equal(resumeParseCallTimeoutMs(deadline, 20_000), 5_000);
  assert.throws(
    () => resumeParseCallTimeoutMs(deadline, 24_500),
    (error: unknown) => (error as { kind?: string }).kind === 'model_timeout',
  );
});

test('provider SDK timeouts fall back locally instead of blocking onboarding', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  mock.method(responsesPrototype, 'create', async () => {
    throw new OpenAI.APIConnectionTimeoutError();
  });
  mock.method(messagesPrototype, 'create', async () => {
    throw new Anthropic.APIConnectionTimeoutError();
  });

  const source = [
    'A Candidate',
    'EXPERIENCE',
    'Litos',
    'Software Engineer | Jan 2025 - Present',
    '• Built reliable onboarding software for student job seekers',
  ].join('\n');
  const parsed = await parseResumeWithClaude(source, { hedgeDelayMs: 0 });
  assert.equal(parsed.parse_method, 'local_fallback');
  assert.equal(parsed.full_name, 'A Candidate');
  assert.equal(parsed.experience[0]?.company, 'Litos');
  await assert.rejects(
    () => parseResumeFromPdf(Buffer.from('%PDF-1.7 scanned resume')),
    (error: unknown) => (error as { kind?: string }).kind === 'model_timeout',
  );
  const scanFallback = await parseResumeFromPdf(Buffer.from('%PDF-1.7 scanned resume'), {
    fallbackText: source,
  });
  assert.equal(scanFallback.parse_method, 'local_fallback');
});

test('the local parser transcribes common resume sections without inventing target roles', () => {
  const parsed = parseResumeLocally([
    'Mehek Mandal',
    'mehek@example.com | +1 (213) 555-0100 | linkedin.com/in/mehek',
    'EXPERIENCE',
    'Litos | Dubai, UAE',
    'Product Manager | Jan 2025 - Present',
    '• Built a resume onboarding flow used by student job seekers',
    'PROJECTS',
    'Signup Reliability',
    'Owner | Aug 2026 - Present',
    '• Reduced upload failures through deterministic fallback parsing',
    'EDUCATION',
    'University of Southern California, Marshall School of Business',
    'Bachelor of Science, Expected May 2027',
    'SKILLS: Product strategy, SQL, TypeScript',
  ].join('\n'));

  assert.equal(parsed.full_name, 'Mehek Mandal');
  assert.equal(parsed.email, 'mehek@example.com');
  assert.equal(parsed.school, 'University of Southern California, Marshall School of Business');
  assert.equal(parsed.grad_year, 2027);
  assert.deepEqual(parsed.skills, ['Product strategy', 'SQL', 'TypeScript']);
  assert.equal(parsed.experience[0]?.company, 'Litos');
  assert.equal(parsed.experience[0]?.title, 'Product Manager');
  assert.equal(parsed.projects[0]?.name, 'Signup Reliability');
  assert.deepEqual(parsed.target_roles, []);
  assert.equal(parsed.parse_method, 'local_fallback');
});

test('the Anthropic hedge starts before a slow OpenAI request settles', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  let releaseOpenAI: (() => void) | undefined;
  mock.method(responsesPrototype, 'create', () => new Promise((resolve) => {
    releaseOpenAI = () => resolve({
      status: 'completed', output_text: modelProfile(FIVE_ROLES), incomplete_details: null,
      usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: {} },
    });
  }));
  let anthropicCalls = 0;
  mock.method(messagesPrototype, 'create', async () => {
    anthropicCalls += 1;
    return { content: [{ type: 'text', text: modelProfile(FIVE_ROLES) }] };
  });

  const parsed = await parseResumeWithClaude('A Candidate\nSoftware engineer', { hedgeDelayMs: 0 });
  releaseOpenAI?.();
  assert.equal(parsed.full_name, 'A Candidate');
  assert.equal(anthropicCalls, 1);
  assert.ok(RESUME_PROVIDER_HEDGE_DELAY_MS < RESUME_PROVIDER_CALL_CAP_MS);
});

test('main and job-specific resume creation have grounded model-free fallbacks', () => {
  const bank = [{
    id: 'entry-1',
    user_id: 'user-1',
    type: 'job',
    org: 'Litos',
    title: 'Product Manager',
    location: 'Dubai, UAE',
    date_range: 'Jan 2025 - Present',
    bullet_variants: [
      'Built a reliable resume onboarding flow used by student job seekers',
      'Reduced signup failures by adding deterministic parsing safeguards',
    ],
    tags: [],
  }] as unknown as Parameters<typeof baseResumeSpecFromEvidence>[0];
  const education = {
    school: 'University of Southern California',
    degree: 'Bachelor of Science',
    grad_date: 'May 2027',
  };

  const base = baseResumeSpecFromEvidence(bank, education, ['SQL', 'TypeScript'], bank);
  assert.equal(base.generation_method, 'local_fallback');
  assert.equal(base.experience[0]?.org, 'Litos');
  assert.deepEqual(base.experience[0]?.bullets, bank[0].bullet_variants);

  const approvedBase = {
    ...base,
    experience: [{ ...base.experience[0], bullets: ['Built the applicant-approved onboarding wording for student job seekers'] }],
  };
  const tailored = resumeSpecFromEvidence(
    'Product Manager',
    bank,
    education,
    ['SQL', 'TypeScript'],
    approvedBase,
    bank[0],
  );
  assert.equal(tailored.generation_method, 'local_fallback');
  assert.equal(tailored.target_role, 'Product Manager');
  assert.equal(tailored.experience[0]?.org, 'Litos');
  assert.deepEqual(tailored.experience[0]?.bullets, approvedBase.experience[0]?.bullets);
});

test('base resume generation emits and returns its grounded fallback when streaming fails', async (t) => {
  t.after(() => mock.restoreAll());
  let streamOptions: { signal?: AbortSignal; maxRetries?: number } | undefined;
  mock.method(messagesPrototype, 'stream', (_body: unknown, options: { signal?: AbortSignal; maxRetries?: number }) => {
    streamOptions = options;
    return ({
    on: () => undefined,
    finalMessage: async () => { throw Object.assign(new Error('provider unavailable'), { status: 503 }); },
    });
  });
  const bank = [{
    id: 'entry-1', user_id: 'user-1', type: 'job', org: 'Litos', title: 'Product Manager',
    location: 'Dubai, UAE', date_range: '2025 - Present',
    bullet_variants: ['Built reliable onboarding software for student job seekers'], tags: [],
  }] as unknown as Parameters<typeof generateBaseResumeSpec>[0];
  const events: unknown[] = [];
  const result = await generateBaseResumeSpec(
    bank,
    { school: 'USC', degree: 'B.S.', grad_date: 'May 2027' },
    ['TypeScript'],
    (event) => events.push(event),
  );

  assert.equal(result.generation_method, 'local_fallback');
  assert.equal(streamOptions?.maxRetries, 0);
  assert.ok(streamOptions?.signal, `base generation must be capped at ${BASE_RESUME_MODEL_CALL_CAP_MS}ms`);
  assert.deepEqual(events, [
    { type: 'restart' },
    { type: 'education', education_position: 'after_experience' },
    { type: 'entry', index: 0, entry: result.experience[0] },
    { type: 'skills', skills: ['TypeScript'] },
  ]);
});

test('job-specific generation returns a grounded fallback after both providers fail', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
  let openAITimeout = 0;
  let anthropicSignal: AbortSignal | undefined;
  mock.method(responsesPrototype, 'create', async (_body: unknown, options: { timeout?: number }) => {
    openAITimeout = options.timeout ?? 0;
    throw Object.assign(new Error('openai down'), { status: 503 });
  });
  mock.method(messagesPrototype, 'create', async (_body: unknown, options: { signal?: AbortSignal }) => {
    anthropicSignal = options.signal;
    throw Object.assign(new Error('anthropic down'), { status: 503 });
  });
  const bank = [{
    id: 'entry-1', user_id: 'user-1', type: 'job', org: 'Litos', title: 'Product Manager',
    location: 'Dubai, UAE', date_range: '2025 - Present',
    bullet_variants: ['Built reliable onboarding software for student job seekers'], tags: [],
  }] as unknown as Parameters<typeof generateResumeSpec>[3];

  const result = await generateResumeSpec(
    'Build reliable onboarding systems', 'Example', 'Product Manager', bank,
    { school: 'USC', degree: 'B.S.', grad_date: 'May 2027' }, undefined,
    ['TypeScript'], 240_000, null, bank[0],
  );

  assert.equal(result.generation_method, 'local_fallback');
  assert.equal(result.experience[0]?.org, 'Litos');
  assert.ok(openAITimeout <= RESUME_GENERATION_INTERACTIVE_BUDGET_MS);
  assert.ok(anthropicSignal, 'Anthropic fallback receives the remaining shared latency budget');
});

test('caller aborts are never converted into local parse success', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
  const pending = (_body: unknown, options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  });
  mock.method(responsesPrototype, 'create', pending);
  mock.method(messagesPrototype, 'create', pending);

  for (const invoke of [
    (signal: AbortSignal) => parseResumeWithClaude('A Candidate\nEXPERIENCE', { signal, hedgeDelayMs: 0 }),
    (signal: AbortSignal) => parseResumeFromPdf(Buffer.from('%PDF-1.7'), { signal, hedgeDelayMs: 0, fallbackText: 'A Candidate' }),
  ]) {
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    const promise = invoke(controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(reason);
    await assert.rejects(() => promise, reason);
  }
});

test('the local parser bounds untrusted text before persistence', () => {
  const skills = Array.from({ length: LOCAL_PARSE_LIMITS.skills + 20 }, (_, index) => `Skill ${index}`).join(', ');
  const bullets = Array.from({ length: LOCAL_PARSE_LIMITS.bulletsPerEntry + 5 }, (_, index) => `• Built bounded item ${index}`);
  const entries = Array.from({ length: LOCAL_PARSE_LIMITS.entriesPerSection + 5 }, (_, index) => [
    `Company ${index}`,
    `Engineer | 202${index % 10} - Present`,
    ...bullets,
  ].join('\n'));
  const parsed = parseResumeLocally([
    'A Candidate',
    'EXPERIENCE',
    ...entries,
    'SKILLS',
    skills,
  ].join('\n'));

  assert.ok(parsed.experience.length <= LOCAL_PARSE_LIMITS.entriesPerSection);
  assert.ok(parsed.experience.every((entry) => entry.description.split('\n').length <= LOCAL_PARSE_LIMITS.bulletsPerEntry));
  assert.ok(parsed.experience.every((entry) => entry.description.length <= LOCAL_PARSE_LIMITS.descriptionChars));
  assert.ok(parsed.skills.length <= LOCAL_PARSE_LIMITS.skills);
  assert.ok(parsed.experience.every((entry) => entry.company.length <= LOCAL_PARSE_LIMITS.fieldChars));
});

test('the local parser handles the full input ceiling of whitespace without backtracking', () => {
  const started = performance.now();
  const parsed = parseResumeLocally(' '.repeat(LOCAL_PARSE_LIMITS.inputChars));
  assert.equal(parsed.full_name, '');
  assert.ok(performance.now() - started < 1_000, 'bounded whitespace input should complete within one second');
});

test('an exhausted route deadline uses the local parser without calling a provider', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  mock.method(Date, 'now', () => 10_000);
  let providerCalls = 0;
  mock.method(responsesPrototype, 'create', async () => { providerCalls += 1; return {}; });
  mock.method(messagesPrototype, 'create', async () => { providerCalls += 1; return {}; });

  const parsed = await parseResumeWithClaude('A Candidate\nSoftware engineer', {
    deadlineMs: 10_500,
    hedgeDelayMs: 0,
  });
  assert.equal(parsed.parse_method, 'local_fallback');
  assert.equal(providerCalls, 0);
});

test('scanned PDF parsing sends the document to OpenAI before Anthropic', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  t.after(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  let openAIBody: Record<string, unknown> | undefined;
  mock.method(responsesPrototype, 'create', async (body: Record<string, unknown>) => {
    openAIBody = body;
    return {
      status: 'completed',
      output_text: modelProfile(FIVE_ROLES),
      incomplete_details: null,
      usage: { input_tokens: 100, output_tokens: 40, input_tokens_details: {} },
    };
  });
  mock.method(messagesPrototype, 'create', async () => {
    throw new Error('Anthropic must not run when OpenAI reads the scan');
  });

  await parseResumeFromPdf(Buffer.from('%PDF-1.7 scanned resume'));

  const message = (openAIBody?.input as Array<{ content?: Array<{ type?: string; file_data?: string }> }>)[0];
  const file = message.content?.find((item) => item.type === 'input_file');
  assert.equal(file?.file_data, Buffer.from('%PDF-1.7 scanned resume').toString('base64'));
});

test('the parser accepts exactly five distinct non-empty target roles and trims them', () => {
  const parsed = parsedProfileFromModelText(modelProfile([
    ' Software Engineer ', 'Backend Engineer', 'Frontend Engineer', 'Product Engineer', 'Data Engineer',
  ]));
  assert.deepEqual(parsed.target_roles, [
    'Software Engineer', 'Backend Engineer', 'Frontend Engineer', 'Product Engineer', 'Data Engineer',
  ]);
});

test('the parser normalizes roles without inventing unrelated fallback careers', () => {
  assert.throws(() => parsedProfileFromModelText(modelProfile(undefined)), /five evidence-backed/);
  assert.throws(() => parsedProfileFromModelText(modelProfile(['Nurse', 'Teacher'])), /five evidence-backed/);
  assert.deepEqual(
    parsedProfileFromModelText(modelProfile(['One', 'Two', 'Three', 'Four', 'Five', 'Six'])).target_roles,
    ['One', 'Two', 'Three', 'Four', 'Five'],
  );
  assert.throws(
    () => parsedProfileFromModelText(JSON.stringify({
      ...JSON.parse(modelProfile(['Nurse', 'Clinical Researcher', 'Care Coordinator', 'Health Educator'])),
      experience: [{ company: 'Hospital', title: 'Registered Nurse', start: '', end: '', description: '' }],
    })),
    /five evidence-backed/,
  );
});

test('the parser keeps every suggested title within the targeting API limit', () => {
  const parsed = parsedProfileFromModelText(modelProfile([
    'A'.repeat(120), 'Backend Engineer', 'Frontend Engineer', 'Product Engineer', 'Data Engineer',
  ]));
  assert.equal(parsed.target_roles[0].length, 80);
  assert.ok(parsed.target_roles.every((role) => role.length <= 80));
});

test('a short role list gets exactly one bounded quality repair', async () => {
  let calls = 0;
  const repaired = await parsedProfileWithOneRepair(modelProfile(['One', 'Two']), async (failure) => {
    calls += 1;
    assert.match(failure, /five evidence-backed target roles/);
    return modelProfile(['One', 'Two', 'Three', 'Four', 'Five']);
  });

  assert.equal(calls, 1);
  assert.deepEqual(repaired.target_roles, ['One', 'Two', 'Three', 'Four', 'Five']);
});

test('a failed repair is not retried indefinitely', async () => {
  let calls = 0;
  await assert.rejects(
    parsedProfileWithOneRepair(modelProfile(['One']), async () => {
      calls += 1;
      return modelProfile(['One', 'Two']);
    }),
    /five evidence-backed target roles/,
  );
  assert.equal(calls, 1);
});

test('open-ended real job titles do not depend on a hard-coded occupation vocabulary', async () => {
  let calls = 0;
  const parsed = await parsedProfileWithOneRepair(modelProfile([
    'Private Equity Associate',
    'Growth Equity Analyst',
    'Search Fund Associate',
    'Infrastructure Investment Analyst',
    'Venture Capital Analyst',
  ]), async () => {
    calls += 1;
    return modelProfile(['One', 'Two', 'Three', 'Four', 'Five']);
  });

  assert.equal(calls, 0);
  assert.equal(parsed.target_roles[0], 'Private Equity Associate');
});

/* ISSUE-020, found on the live demo account 2026-08-03. ParsedProfile had no `languages` key, so
 * the extractor filed spoken languages under `skills`: English, Hindi, Punjabi, French, Arabic and
 * Spanish arrived AHEAD of C++, Figma and Python, because a resume prints its language line above
 * its technical line. baseResume.ts's skillsSourceFor falls back to this array whenever the declared
 * profiles.skills column is null, which is every student at onboarding, so every tailored resume the
 * account produced led its skills section with six spoken languages. */

const FIVE_ROLES = ['One', 'Two', 'Three', 'Four', 'Five'];

function modelSkills(skills: unknown, languages?: unknown): string {
  return JSON.stringify({
    full_name: 'A Candidate', experience: [], skills, projects: [], school: '',
    grad_year: 0, target_roles: FIVE_ROLES, ...(languages === undefined ? {} : { languages }),
  });
}

test('spoken languages do not land in skills', () => {
  const parsed = parsedProfileFromModelText(modelSkills([
    'English', 'Hindi', 'Punjabi', 'French', 'Arabic', 'Spanish',
    'MS PowerPoint', 'Adobe Photoshop', 'C++', 'Figma', 'Python',
  ]));

  assert.deepEqual(parsed.skills, ['MS PowerPoint', 'Adobe Photoshop', 'C++', 'Figma', 'Python']);
  assert.deepEqual(parsed.languages, ['English', 'Hindi', 'Punjabi', 'French', 'Arabic', 'Spanish']);
  // The regression was as much about ORDER as membership: the first skill on the generated resume
  // must now be a technical one.
  assert.equal(parsed.skills[0], 'MS PowerPoint');
});

test('programming languages and tools survive the language split', () => {
  // Every name here is one a careless spoken-language list would swallow. Losing any of them
  // deletes a real engineering skill from the student's resume, which is worse than the bug.
  const technical = ['Go', 'R', 'Rust', 'Swift', 'Ruby', 'Julia', 'Scheme', 'Java', 'Basic', 'Processing'];
  const parsed = parsedProfileFromModelText(modelSkills(technical));

  assert.deepEqual(parsed.skills, technical);
  assert.deepEqual(parsed.languages, []);
});

test('a stated proficiency is carried across rather than flattened to bare fluency', () => {
  // "Spanish (basic)" reduced to "Spanish" would read as fluency the student never claimed.
  const parsed = parsedProfileFromModelText(modelSkills([
    'Spanish (conversational)', 'French - fluent', 'Mandarin Chinese: native', 'Python',
  ]));

  assert.deepEqual(parsed.skills, ['Python']);
  assert.deepEqual(parsed.languages, [
    'Spanish (conversational)', 'French - fluent', 'Mandarin Chinese: native',
  ]);
});

test('the model answer leads and the reclassified remainder is merged in without duplicates', () => {
  const parsed = parsedProfileFromModelText(modelSkills(['Hindi', 'english', 'Figma'], ['English', 'Tamil']));

  assert.deepEqual(parsed.skills, ['Figma']);
  // "english" off the skills line is the same language as the model's "English", so the first
  // spelling wins and the entry is not repeated.
  assert.deepEqual(parsed.languages, ['English', 'Tamil', 'Hindi']);
});

test('a resume printing no language line yields an empty list, never an inferred one', () => {
  const parsed = parsedProfileFromModelText(modelSkills(['Python', 'Figma']));

  assert.deepEqual(parsed.skills, ['Python', 'Figma']);
  assert.deepEqual(parsed.languages, []);
});

test('the split tolerates the malformed skills arrays the model actually emits', () => {
  assert.deepEqual(splitSpokenLanguages(null), { skills: [], languages: [] });
  assert.deepEqual(splitSpokenLanguages('English'), { skills: [], languages: [] });
  assert.deepEqual(
    splitSpokenLanguages(['  ', 7, null, ' Hindi ', 'Figma']),
    { skills: ['Figma'], languages: ['Hindi'] },
  );
});

test('the parse prompt keeps spoken languages out of the skills field', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /"skills" is TECHNICAL and professional ability only/i);
  assert.match(flat, /never contain a spoken or natural language/i);
  assert.match(flat, /"languages" holds the spoken or natural languages printed on the resume/i);
  assert.match(flat, /programming languages are NOT spoken languages and belong in "skills"/i);
  // The parser may not manufacture a fluency claim the page never printed.
  assert.match(flat, /never infer a language from the applicant's name, school, or country/i);
});

/* ISSUE-021, found on Mehek's live production account 2026-08-03. Her uploaded resume prints
 * "GPA: 3.89/4.0". The parser stored gpa "3.8" with gpa_scale "4.0": the denominator survived and
 * the last digit of the grade did not. The parse feeds application_profile through
 * academicSeedFrom, and application_profile is what the extension types into an employer's GPA
 * field, so a dropped digit here is a false factual claim on a real job application.
 *
 * The defence is deterministic and lives in reconcileGpaWithSource: the resume text says what the
 * resume prints, so the model's transcription is checked against it rather than trusted. */

test('a truncated GPA is corrected against what the resume prints', () => {
  const source = 'EDUCATION\nUniversity of Southern California\nBS Computer Science, GPA: 3.89/4.0\n';
  const fixed = reconcileGpaWithSource({ gpa: '3.8', gpa_scale: '4.0' }, source);
  assert.equal(fixed.gpa, '3.89');
  assert.equal(fixed.gpa_scale, '4.0');
});

test('a correctly transcribed GPA is left exactly as the model returned it', () => {
  const source = 'Cumulative GPA: 3.89/4.0';
  const fixed = reconcileGpaWithSource({ gpa: '3.89', gpa_scale: '4.0' }, source);
  assert.equal(fixed.gpa, '3.89');
  assert.equal(fixed.gpa_scale, '4.0');
});

test('a printed denominator travels with a corrected grade', () => {
  // A 10.0-scale record misread as 8.9/4.0 would restate an Indian CGPA as a near-perfect US one.
  const fixed = reconcileGpaWithSource({ gpa: '8.9', gpa_scale: '4.0' }, 'CGPA: 8.94/10.0');
  assert.equal(fixed.gpa, '8.94');
  assert.equal(fixed.gpa_scale, '10.0');
});

test('a scale the resume never printed is not invented by the correction', () => {
  const fixed = reconcileGpaWithSource<{ gpa?: string; gpa_scale?: string }>(
    { gpa: '3.8' },
    'Grade point average 3.89',
  );
  assert.equal(fixed.gpa, '3.89');
  assert.equal(fixed.gpa_scale, undefined, 'guessing 4.0 misstates a 10.0-scale record');
});

test('an empty model answer is never filled in from the source text', () => {
  // A resume printing only a major GPA states no overall grade. The model abstaining is an answer,
  // and turning it into a number would be the fabrication the whole GPA rule exists to prevent.
  const fixed = reconcileGpaWithSource({ gpa: '' }, 'Major GPA: 3.95/4.0');
  assert.equal(fixed.gpa, '');
});

test('two disagreeing printed GPAs leave the judgement with the model', () => {
  const source = 'Major GPA: 3.95/4.0 | Cumulative GPA: 3.89/4.0';
  assert.equal(printedGpaIn(source), null);
  assert.equal(reconcileGpaWithSource({ gpa: '3.8' }, source).gpa, '3.8');
});

test('the same GPA printed twice is still one unambiguous reading', () => {
  const reading = printedGpaIn('GPA 3.89\nOverall GPA: 3.89/4.0');
  assert.deepEqual(reading, { gpa: '3.89', scale: '4.0' });
});

test('a resume that prints no GPA yields no reading', () => {
  assert.equal(printedGpaIn('EDUCATION\nBS Computer Science, May 2027\n'), null);
});

/* The reconciliation itself can falsify a credential if it guesses, and it only ever runs on cases
 * where the model DISAGREES with it - which on a correct model answer means these strings would
 * turn a right answer into a wrong one. Caught in review before shipping: the first draft took the
 * first number after the label, so "GPA (out of 4.0): 3.89" read as 4.0 and a real 3.89 would have
 * been written into application_profile, and typed into employer forms, as a perfect score.
 *
 * Every string here must DECLINE. A decline costs nothing: the model's own answer stands. */

test('a denominator printed before the grade is never read as the grade', () => {
  for (const source of [
    'GPA (out of 4.0): 3.89',
    'GPA out of 4.0: 3.89',
    'GPA on a 4.0 scale: 3.89',
    'Cumulative GPA (4.0 scale): 3.89',
    'CGPA (out of 10): 8.94',
  ]) {
    assert.equal(printedGpaIn(source), null, source);
    // And the correct model answer survives untouched.
    const kept = reconcileGpaWithSource({ gpa: '3.89', gpa_scale: '4.0' }, source);
    assert.equal(kept.gpa, '3.89', source);
    assert.equal(kept.gpa_scale, '4.0', source);
  }
});

test('a European decimal comma is declined rather than read as its integer half', () => {
  const source = 'GPA: 3,89/4,0';
  assert.equal(printedGpaIn(source), null);
  assert.equal(reconcileGpaWithSource({ gpa: '3.89', gpa_scale: '4.0' }, source).gpa, '3.89');
});

test('a percentage is not a GPA, however it is labelled', () => {
  assert.equal(printedGpaIn('GPA: 85%'), null);
  assert.equal(printedGpaIn('Cumulative Average: 92.4'), null);
  assert.equal(printedGpaIn('Grade point average: 78.5%'), null);
});

test('a grade above its own denominator is a misread, not a record', () => {
  assert.equal(printedGpaIn('GPA: 8.9/4.0'), null);
  // No printed denominator either: no grading scale tops out below this.
  assert.equal(printedGpaIn('GPA 87'), null);
});

test('a number the pattern cut short is declined', () => {
  // Four decimal places overrun the capture, so what was read is not what was printed.
  assert.equal(printedGpaIn('GPA: 3.8912'), null);
});

test('a corrected grade never keeps a denominator it no longer fits inside', () => {
  // "8.94 out of 4.0" is not a record anyone has. The model's scale is what is now unsupported.
  const fixed = reconcileGpaWithSource({ gpa: '8.9', gpa_scale: '4.0' }, 'Grade point average 8.94');
  assert.equal(fixed.gpa, '8.94');
  assert.equal(fixed.gpa_scale, '', 'an unsupported denominator goes back to being a gap');
});
