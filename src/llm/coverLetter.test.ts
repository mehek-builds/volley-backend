import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { escapeRawControlCharacters, generateCoverLetter, parseCoverLetterBody, validateCoverLetter } from './coverLetter';

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
