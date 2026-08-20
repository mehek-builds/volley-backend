import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import {
  COVER_LETTER_SYSTEM_PROMPT,
  escapeRawControlCharacters,
  generateCoverLetter,
  parseCoverLetterBody,
  validateCoverLetter,
} from './coverLetter';

// generateCoverLetter builds its own module-private Anthropic client, so there is no seam to inject
// a fake through. `create` lives on the shared Messages prototype rather than on the instance, so
// patching it there reaches the client the module already built, whatever order the modules loaded
// in. This is the only way to assert on the REQUEST, and the request is half of what is under test.
const messagesPrototype = Object.getPrototypeOf(new Anthropic({ apiKey: 'test-key' }).messages) as {
  create: (...args: unknown[]) => unknown;
};

const COVER_LETTER_INPUT = {
  company: 'Gemini',
  role: 'Software Engineering Intern (Fall 2026)',
  jd_text: 'Build and ship backend services. Fall 2026 internship.',
  candidate_source: 'Mehek built a Chrome extension that fills in job applications.',
};

function stubClaude(response: { content: unknown[]; stop_reason: string }) {
  const calls: Record<string, unknown>[] = [];
  mock.method(messagesPrototype, 'create', async (body: Record<string, unknown>) => {
    calls.push(body);
    return response;
  });
  return calls;
}

// Both of these pin the ONE fix in this change with no other test standing behind it. Deleting the
// max_tokens raise and the stop_reason guard left all seven cover letter tests green, which makes it
// the fix most likely to be quietly reverted by a future edit that "tidies up" the request.
test('the cover letter request asks for 8192 tokens, not the old 2048', async (t) => {
  t.after(() => mock.restoreAll());
  const calls = stubClaude({
    content: [{ type: 'text', text: '{"body":"Paragraph one.\\n\\nParagraph two."}' }],
    stop_reason: 'end_turn',
  });

  assert.equal(await generateCoverLetter(COVER_LETTER_INPUT), 'Paragraph one.\n\nParagraph two.');
  assert.equal(calls.length, 1);
  // 2048 was a SHARED budget for adaptive thinking plus the emitted JSON on claude-sonnet-5, which
  // left as little as ~850 tokens of letter on a long posting. Anything at or below the old ceiling
  // reopens the truncation window, so this asserts the exact value rather than a lower bound.
  assert.equal(calls[0].max_tokens, 8192);
});

test('a response cut off at max_tokens raises the truncation error, not the parse error', async (t) => {
  t.after(() => mock.restoreAll());
  // A real truncation: valid JSON prefix, no closing quote or brace. Without the stop_reason guard
  // this falls through to parseCoverLetterBody and comes back as "Claude returned an invalid cover
  // letter", which is exactly the confusion that let a raw-newline bug spend its life being read as
  // a token-limit problem. The two failures have to stay separately named.
  stubClaude({
    content: [{ type: 'text', text: '{"body":"I am writing to apply for the Software Engineering In' }],
    stop_reason: 'max_tokens',
  });

  await assert.rejects(
    () => generateCoverLetter(COVER_LETTER_INPUT),
    (error: Error) => {
      assert.match(error.message, /truncated at max_tokens/);
      assert.doesNotMatch(error.message, /invalid cover letter/);
      return true;
    },
  );
});

// The exact failure that took a real Greenhouse submission down on 2026-08-04.
//
// The prompt asks for a 3-or-4 PARAGRAPH letter returned inside a JSON string, so every response
// has to encode paragraph breaks. Claude escapes them as \n most of the time and emits a RAW
// newline the rest of the time: 2 failures in 8 calls on the live Gemini posting. JSON.parse
// rejects a raw control character inside a string literal, so a complete and perfectly usable
// letter was thrown away as "invalid", and because the runner let that throw escape it killed the
// whole submission.
//
// Written as a real newline in a template literal on purpose. Writing it as \\n would test the
// escaped form, which never broke.
const RAW_NEWLINE_RESPONSE = `{"body":"I'm writing to apply for the Software Engineering Intern (Fall 2026) role at Gemini. I'm a Computer Science and Business Administration student at USC Viterbi (May 2028).

At Litos I built a Chrome extension that fills in job applications. The work was mine end to end.

I would bring that same approach to Gemini this fall."}`;

test('a cover letter whose JSON carries raw newlines is recovered, not rejected', () => {
  const body = parseCoverLetterBody(RAW_NEWLINE_RESPONSE);
  assert.match(body, /^I'm writing to apply for the Software Engineering Intern \(Fall 2026\) role at Gemini\./);
  // The whole letter, not just the first paragraph: the point is that nothing was lost.
  assert.match(body, /I would bring that same approach to Gemini this fall\.$/);
  assert.equal(body.includes('At Litos I built a Chrome extension'), true);
});

test('a cover letter wrapped in a json code fence is recovered', () => {
  const body = parseCoverLetterBody('```json\n{"body":"Paragraph one.\\n\\nParagraph two."}\n```');
  assert.equal(body, 'Paragraph one.\n\nParagraph two.');
});

test('an already-valid cover letter response is unchanged by the repair path', () => {
  assert.equal(parseCoverLetterBody('{"body":"Line one.\\nLine two."}'), 'Line one.\nLine two.');
});

test('a genuinely truncated cover letter still fails rather than being half-accepted', () => {
  // Half a letter in front of an employer is worse than an error, so the tolerant parser must stay
  // intolerant of real damage.
  assert.throws(
    () => parseCoverLetterBody('{"body":"I am writing to apply for the Software Engineering In'),
    /Claude returned an invalid cover letter/,
  );
  assert.throws(() => parseCoverLetterBody(''), /Claude returned an invalid cover letter/);
  assert.throws(() => parseCoverLetterBody('{"body":"   "}'), /Claude returned an invalid cover letter/);
});

test('control-character repair only touches characters inside string literals', () => {
  // A newline BETWEEN tokens is legal JSON whitespace. Escaping it would corrupt the document, so
  // the walker has to know where it is rather than blindly replacing every newline.
  const pretty = '{\n  "body": "one"\n}';
  assert.equal(escapeRawControlCharacters(pretty), pretty);
  // An escaped backslash must not be read as escaping the quote that follows it, or the walker
  // loses track of which side of the string it is on for the rest of the document.
  assert.equal(escapeRawControlCharacters('{"body":"back\\\\slash"}'), '{"body":"back\\\\slash"}');
});

const source = 'Mehek worked at Acme Labs and reduced processing time by 35% using Python. Built an analytics pipeline for 40 users.';

test('cover-letter validation strips prohibited dashes and accepts grounded metrics', () => {
  const paragraph = 'I am applying for the Software Engineer role at Acme. At Acme Labs, I used Python to reduce processing time by 35% while building an analytics pipeline for 40 users. ';
  const result = validateCoverLetter(`${paragraph.repeat(7)}This work maps directly to the role.`, 'Acme', 'Software Engineer', source);
  assert.equal(result.body.includes('—'), false);
  assert.equal(result.issues.some((item) => item.includes('ungrounded numbers')), false);
});

test('cover-letter validation blocks fabricated candidate metrics', () => {
  const body = `I am applying for the Software Engineer role at Acme. ${'My work at Acme Labs used Python to build reliable systems. '.repeat(25)}I increased revenue by 82%.`;
  const result = validateCoverLetter(body, 'Acme', 'Software Engineer', source);
  assert.ok(result.issues.some((item) => item.includes('82%')));
});

/* ================================================================================================
 * PACKET fbc1d407-67bf-43d0-8897-640af434d15a. truveta, Software Engineering Intern, 2026-08-09.
 *
 * Generated, validated, and stored in production carrying two defects at once: a promise she never
 * made, and one quantified result credited to two unrelated projects. Both are pinned here against
 * the letter exactly as it shipped, so a regression has to reproduce the real thing to pass.
 * ============================================================================================== */

const TRUVETA_LETTER = 'I am applying for the Software Engineering Intern role at Truveta. As a Computer Science and '
  + 'Business Administration student at USC with a 3.89 GPA, I have spent the past year building technical projects with '
  + 'Python, TypeScript, and REST APIs while working directly with LangChain and the OpenAI API, and I want to bring that '
  + 'combination of engineering and problem-solving to a team focused on real-world health data. At Traeco, an AI agent '
  + 'cost infrastructure project, I built LLM-agent cost infrastructure using LangChain and the OpenAI API, and '
  + 'instrumented evaluation harnesses that cut agent response latency from 2.3s to 0.1s. I also structured an ambiguous, '
  + 'fast-moving market into testable hypotheses through 50+ customer discovery interviews, which reshaped the product '
  + 'roadmap. Separately, as founder of Tonee, an AI texting tone detector, I shipped a consumer mobile app end-to-end, '
  + 'defining the feature set and UX in Figma and evaluating three technical architectures for mobile performance before '
  + 'authoring a specification that reduced latency from 2.3s to 0.1s. That work required the kind of collaborative, '
  + "deadline-driven execution Truveta's internship calls for, since I coordinated design, product, and technical "
  + 'tradeoffs on a compressed timeline while analyzing over 8,300 behavioral data points to raise model-driven feature '
  + 'accuracy from 78% to 89%. My Program Management internship at Cinematica Labs gave me experience working in a '
  + 'structured technical environment: I built a threshold-based alerting system across 96 mentor-founder pairs from 8 '
  + 'dropout indicators, which recovered 9 of 14 at-risk relationships, and analyzed 183 program surveys using RICE '
  + 'prioritization to help ship three initiatives. That project depended on clear written communication with '
  + 'stakeholders and disciplined time management across concurrent workstreams, both of which carried into my PRD and '
  + 'A/B testing work at SoFi. I am based in Los Angeles but able to work from the Greater Seattle area for this '
  + 'internship, and I am currently enrolled in my undergraduate program with an expected graduation date of May 2028. '
  + "I would welcome the chance to apply my Python and product engineering background to Truveta's work on health data "
  + 'infrastructure.';

// Every number the letter uses, so ungroundedNumbers stays silent and the assertions below are
// about the new checks rather than about arithmetic.
const TRUVETA_SOURCE = JSON.stringify({
  education: { gpa: '3.89', school: 'USC', graduation: 'May 2028' },
  experience_bank: [
    {
      org: 'Traeco - AI Agent Cost Infrastructure',
      bullets: [
        'Built LLM-agent cost infrastructure with LangChain and the OpenAI API, instrumenting evaluation harnesses that cut agent response latency from 2.3s to 0.1s.',
        'Structured an ambiguous market into testable hypotheses through 50+ customer discovery interviews.',
      ],
    },
    {
      org: 'Tonee - AI Texting Tone Detector',
      bullets: [
        'Evaluated 3 technical architectures for mobile performance; authored specification reducing latency from 2.3s to 0.1s.',
        'Analyzed 8,300+ behavioral data points, increasing model-driven feature accuracy from 78% to 89%.',
      ],
    },
    {
      org: 'Cinematica Labs',
      bullets: [
        'Built threshold alerting across 96 pairs from 8 dropout indicators, recovering 9 of 14 at-risk relationships.',
        'Analyzed 183 program surveys using RICE prioritization.',
      ],
    },
  ],
});

const TRUVETA_CONTESTED = { labels: ['0.1', '2.3'], signatures: new Set(['0.1', 'd:0.1', '2.3']) };

test('the Greater Seattle promise is an issue, not a warning', () => {
  const result = validateCoverLetter(TRUVETA_LETTER, 'Truveta', 'Software Engineering Intern', TRUVETA_SOURCE);

  /* The whole of defect 1. The letter DID come back with a signal: the stored packet carries a
   * warning naming "Greater Seattle" as a name not found in her background. A warning is written
   * into the artifact and the letter is persisted anyway, so the signal annotated a promise instead
   * of stopping it. The assertion that matters is which list it lands in. */
  const promise = result.issues.find((issue) => issue.includes('promises something'));
  assert.ok(promise, `expected a blocking issue, got issues=${JSON.stringify(result.issues)}`);
  assert.match(promise!, /I am based in Los Angeles but able to work from the Greater Seattle area/);
  assert.equal(result.warnings.some((warning) => warning.includes('promises something')), false);
});

// The leak this pins: an internal-sounding diagnostic ("Review names not found in candidate
// data: X") reached the applicant-facing "Needs your input" panel verbatim, because the warning
// text itself was never written for her to read. The mechanism (an advisory warning on the
// artifact) is correct and stays; only the copy has to be honest and human-appropriate. Measured
// live in production on two applications, 2026-08-20.
test('the unfamiliar-name warning reads like a note to the applicant, not an internal diagnostic', () => {
  const result = validateCoverLetter(TRUVETA_LETTER, 'Truveta', 'Software Engineering Intern', TRUVETA_SOURCE);

  const nameWarning = result.warnings.find((warning) => warning.includes('Greater Seattle'));
  assert.ok(nameWarning, `expected an unfamiliar-name warning, got warnings=${JSON.stringify(result.warnings)}`);
  assert.match(nameWarning!, /^Names\/orgs not found in your background, Truveta, or Software Engineering Intern \(verify before sending\): /);
  assert.doesNotMatch(nameWarning!, /candidate data/i);
  assert.doesNotMatch(nameWarning!, /^Review /);
});

test('the letter with the promise deleted is accepted, and nothing is written in its place', () => {
  // Silence is the correct output. Truveta's form still asks where she will be; that question
  // surfaces to a human through the resolver, which is the only surface that can check the answer.
  const withoutPromise = TRUVETA_LETTER.replace(
    'I am based in Los Angeles but able to work from the Greater Seattle area for this '
    + 'internship, and I am currently enrolled in my undergraduate program with an expected graduation date of May 2028. ',
    'I am currently enrolled in my undergraduate program with an expected graduation date of May 2028. ',
  );
  assert.notEqual(withoutPromise, TRUVETA_LETTER);
  const result = validateCoverLetter(withoutPromise, 'Truveta', 'Software Engineering Intern', TRUVETA_SOURCE);
  assert.deepEqual(result.issues.filter((issue) => issue.includes('promises something')), []);
});

test('one latency figure credited to both Traeco and Tonee is an issue', () => {
  const result = validateCoverLetter(
    TRUVETA_LETTER,
    'Truveta',
    'Software Engineering Intern',
    TRUVETA_SOURCE,
    TRUVETA_CONTESTED,
  );

  /* Defect 2, and note what does NOT catch it: both figures are in her experience bank, under both
   * orgs, so ungroundedNumbers passes them honestly. The duplication is in her data. This check is
   * the containment, and it refuses the figure for BOTH projects rather than guessing an owner. */
  const reused = result.issues.find((issue) => issue.includes('more than one employer or project'));
  assert.ok(reused, `expected a contested-metric issue, got issues=${JSON.stringify(result.issues)}`);
  assert.match(reused!, /2\.3/);
  assert.match(reused!, /0\.1/);
  assert.match(reused!, /Do not substitute a different number/);
  assert.equal(result.issues.some((issue) => issue.includes('ungrounded numbers')), false);
});

test('with nothing contested the same letter keeps its metrics', () => {
  // The check must cost nothing when the source attributes cleanly, or it would strip true numbers
  // out of every letter written from a healthy bank.
  const result = validateCoverLetter(TRUVETA_LETTER, 'Truveta', 'Software Engineering Intern', TRUVETA_SOURCE);
  assert.deepEqual(result.issues.filter((issue) => issue.includes('more than one employer')), []);
});

test('contested figures are named in the request, not only caught after the fact', async (t) => {
  t.after(() => mock.restoreAll());
  const calls = stubClaude({
    content: [{ type: 'text', text: '{"body":"Paragraph one.\\n\\nParagraph two."}' }],
    stop_reason: 'end_turn',
  });

  await generateCoverLetter({ ...COVER_LETTER_INPUT, contested_metrics: ['0.1', '2.3'] });
  const content = (calls[0].messages as Array<{ content: string }>)[0].content;
  assert.match(content, /appear under more than one employer or project/);
  assert.match(content, /0\.1, 2\.3/);
  assert.match(content, /Do not substitute a different number/);
});

test('a clean source adds no contested-metric instruction to the request', async (t) => {
  t.after(() => mock.restoreAll());
  const calls = stubClaude({
    content: [{ type: 'text', text: '{"body":"Paragraph one.\\n\\nParagraph two."}' }],
    stop_reason: 'end_turn',
  });

  await generateCoverLetter(COVER_LETTER_INPUT);
  const content = (calls[0].messages as Array<{ content: string }>)[0].content;
  assert.equal(content.includes('appear under more than one employer'), false);
});

test('the prompt forbids stating a location and forbids promising', () => {
  /* Pinned because the prompt is the cheap half of the fix and the half most likely to be lost to a
   * later edit that shortens the rule list. The validator would still refuse the letter, but every
   * refusal costs a regeneration round trip, and two of those in a row fails the packet outright. */
  assert.match(COVER_LETTER_SYSTEM_PROMPT, /Never state where the candidate lives, is based, or will be located/);
  assert.match(COVER_LETTER_SYSTEM_PROMPT, /Never promise anything on the candidate's behalf/);
  assert.match(COVER_LETTER_SYSTEM_PROMPT, /relocating/);
  assert.match(COVER_LETTER_SYSTEM_PROMPT, /start dates/);
  assert.match(COVER_LETTER_SYSTEM_PROMPT, /say nothing about it/);
  assert.match(COVER_LETTER_SYSTEM_PROMPT, /Never move a result from one employer or project to another/);
});
