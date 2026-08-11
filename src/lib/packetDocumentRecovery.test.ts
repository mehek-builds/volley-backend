import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  frozenContactHeader,
  rerenderFrozenCoverLetter,
  rerenderFrozenResume,
} from './packetDocumentRecovery';
import { PacketDocumentExpiredError } from './resumeAccess';
import { extractPdfText } from './pdfText';
import { renderCoverLetterPdf } from './coverLetterPdf';
import { renderResumePdf } from '../engine/resumeRender';

/* WHAT THE SWEEP LEAVES BEHIND, in the shape it leaves it.
 *
 * Measured on the prod Neon DB 2026-08-11: 325 of the 326 rows in a status that can still reach a
 * send were carrying resume content in `spec`, and all 44 rows whose blob had ALREADY been swept
 * were too. So this fixture is not a convenience, it is the state a 30-day-old row is actually in:
 * every field the render needs, and no file. */
function storedSpec(overrides: Record<string, unknown> = {}) {
  return {
    school: 'University of Southern California',
    degree: 'B.S. Computer Science',
    grad_date: 'May 2028',
    coursework: 'Data Structures, Algorithms, Machine Learning',
    experience: [1, 2].map((i) => ({
      org: `Company ${i}`,
      title: 'Software Engineering Intern',
      date_range: 'Jun 2024 - Aug 2025',
      bullets: [1, 2, 3].map(
        (j) => `Built feature ${j} that improved conversion by ${10 + j}% across 40,000 daily events for 100+ users`,
      ),
    })),
    skills: ['Python', 'SQL', 'Swift', 'Git'],
    _contact: {
      full_name: 'Mehek Mandal',
      email: 'mehek@example.test',
      phone: '+971 567417451',
      linkedin_url: 'https://www.linkedin.com/in/mehekmandal/',
    },
    ...overrides,
  };
}

describe('rebuilding an expired packet resume from the row', () => {
  test('a swept packet still produces a real, readable resume', async () => {
    const buffer = await rerenderFrozenResume({
      spec: storedSpec(),
      jdText: 'Software engineering internship. Python, SQL.',
      role: 'Software Engineering Intern',
    });
    assert.ok(buffer.length > 0);
    assert.equal(buffer.subarray(0, 5).toString('utf8'), '%PDF-');
    const parsed = await extractPdfText(buffer);
    assert.equal(parsed.numpages, 1, 'a resume that grew a second page is not the one that was approved');
    assert.match(parsed.text, /Mehek Mandal/);
    assert.match(parsed.text, /University of Southern California/);
    assert.match(parsed.text, /mehek@example\.test/, 'the employer must have a way to reply');
  });

  test('the rebuild reads the FROZEN contact block, never a live profile', async () => {
    /* The discipline the whole module exists for. A rebuild that consulted the current profile
       would hand an employer a different document from the one the applicant approved, and would
       quietly defeat submissionEducationGuard, whose entire job is comparing the stored spec
       against the live profile to catch a corrected graduation date. */
    const parsed = await extractPdfText(await rerenderFrozenResume({
      spec: storedSpec({ _contact: { full_name: 'Frozen Name', email: 'frozen@example.test' } }),
      jdText: 'Software engineering internship.',
    }));
    assert.match(parsed.text, /Frozen Name/);
    assert.match(parsed.text, /frozen@example\.test/);
  });

  test('the frozen education block is what gets printed, not a corrected one', async () => {
    const parsed = await extractPdfText(await rerenderFrozenResume({
      spec: storedSpec({ grad_date: 'December 2027' }),
      jdText: 'Software engineering internship.',
    }));
    assert.match(parsed.text, /December 2027/,
      'the packet prints what it stored; drift is the education guard’s question, not this one');
  });

  test('a packet with no way to reply on it is refused BEFORE anything is rendered', async () => {
    /* The 28 production packets whose _contact has neither an email nor a phone, measured 2026-08-11
       and matching the count in resumeContactRoute.test.ts exactly. Rebuilding one would send an
       employer a resume nobody can answer, which is the defect that reached 26 live employer forms.
       That row needs regenerating, and the expired sentence is what asks for it.

       ASSERTED AS "the renderer was never called", not merely as "it rejected". renderResumePdf
       carries its own contact guard, so a test that only checked the rejection would still pass with
       this module's guard deleted, and would be pinning that function's behaviour rather than this
       one's. What this guard actually buys is that the recovery cannot produce a document with no
       reply route even if it were handed a renderer that would happily draw one. */
    let renderCalls = 0;
    await assert.rejects(
      () => rerenderFrozenResume(
        {
          spec: storedSpec({
            _contact: {
              full_name: 'Mehek Mandal',
              linkedin_url: 'https://www.linkedin.com/in/mehekmandal/',
            },
          }),
          jdText: 'Software engineering internship.',
        },
        async (...args) => {
          renderCalls += 1;
          return renderResumePdf(...args);
        },
      ),
      (error: unknown) => error instanceof PacketDocumentExpiredError && error.document === 'resume',
    );
    assert.equal(renderCalls, 0, 'an uncontactable packet must not reach the renderer at all');
  });

  test('an empty spec is left expired rather than rendered as a blank page', async () => {
    /* normalizeSpec is tolerant by design, so without the gate this renders a page with a name on
       it and nothing else, and sends it. */
    await assert.rejects(
      () => rerenderFrozenResume({
        spec: { _contact: { full_name: 'Mehek Mandal', email: 'mehek@example.test' } },
        jdText: 'Software engineering internship.',
      }),
      (error: unknown) => error instanceof PacketDocumentExpiredError,
    );
  });

  test('a render that throws becomes the expired sentence, not a pdfkit message on a dashboard', async () => {
    await assert.rejects(
      () => rerenderFrozenResume(
        { spec: storedSpec(), jdText: 'Software engineering internship.' },
        async () => { throw new Error('pdfkit: missing glyph'); },
      ),
      (error: unknown) => {
        assert.ok(error instanceof PacketDocumentExpiredError);
        assert.doesNotMatch(error.message, /pdfkit|glyph/);
        return true;
      },
    );
  });

  test('a rebuild that clips off the page is refused, because that is the one thing drift can break', async () => {
    /* Content is unchanged and was validated when the packet was built, so the only way this
       document can differ from the approved one is RESUME_DESIGN moving between build day and send
       day. validateResumeVisualLayout is what notices, and refusing is correct: an application is
       recoverable by regenerating, a clipped resume in an employer's ATS is not. */
    await assert.rejects(
      () => rerenderFrozenResume(
        { spec: storedSpec(), jdText: 'Software engineering internship.' },
        async () => ({
          buffer: Buffer.from('%PDF-1.4'),
          spec: {} as never,
          omissions: [],
          trimmed: false,
          sparse: false,
          layout: {
            page_height: 792,
            margin: 36,
            content_bottom: 900,
            fill_ratio: 0.9,
            body_font_size: 10,
            section_order: [],
            expected_section_order: [],
            sections: [],
            bullets: [],
          } as never,
        }),
      ),
      (error: unknown) => error instanceof PacketDocumentExpiredError && error.document === 'resume',
    );
  });

  test('frozenContactHeader treats a jsonb blank as absent, not as a contact route', () => {
    assert.deepEqual(frozenContactHeader({ _contact: { full_name: 'A', email: '   ', phone: '' } }), {
      full_name: 'A',
      email: undefined,
      phone: undefined,
      linkedin_url: undefined,
      github_url: undefined,
      portfolio_url: undefined,
    });
    assert.equal(frozenContactHeader(null).full_name, '');
    assert.equal(frozenContactHeader({}).full_name, '');
  });
});

describe('the recovery is wired at the producer, not at one call site', () => {
  /* buildPacket has a dozen callers (prepare, submit, the security-code finish, controlled tests,
     the API channel, the extension handoff). renderResumePdf's own contact guard states the rule
     this follows: a check written on one path leaves the next to be discovered from an employer.
     These are source assertions because buildPacket needs a database to run, and the property being
     pinned is structural rather than behavioural. */
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');

  test('buildPacket recovers the resume instead of letting the expired error out', () => {
    assert.match(source, /resumeBytesForPacket\(row\.resume_object_key, controlledTest\)\s*\n\s*\.catch\(/);
    assert.match(source, /return rerenderFrozenResume\(\{ spec: stored, jdText: review\.jd_text \?\? '', role: review\.role \}\)/);
  });

  test('the rebuild is handed the frozen row, never the live profile', () => {
    /* `stored` is row.spec. If this ever becomes `parsed` or a profile read, an employer starts
       receiving a document the applicant never approved, and the education guard starts comparing
       the packet against itself. */
    assert.doesNotMatch(source, /rerenderFrozenResume\(\{ spec: parsed/);
    assert.doesNotMatch(source, /rerenderFrozenResume\(\{ spec: profileRow/);
  });

  test('only the resume expiry is recovered here, and other failures still propagate', () => {
    assert.match(
      source,
      /if \(!\(error instanceof PacketDocumentExpiredError\) \|\| error\.document !== 'resume'\) throw error;\s*\n\s*return rerenderFrozenResume/,
    );
  });

  test('nothing is written back to storage on the recovery path', () => {
    /* The promise stays literally true only while the rebuilt bytes are never persisted: the file
       stays deleted and old links stay dead. A put() reachable from here would restart a retention
       clock as a side effect of sending, and resurrect a document for browsing. */
    const start = source.indexOf('const resume = await resumeBytesForPacket');
    const end = source.indexOf('const fullName =', start);
    assert.ok(start > 0 && end > start);
    const recoveryRegion = source.slice(start, end);
    assert.doesNotMatch(recoveryRegion, /\bput\(/);
    assert.doesNotMatch(recoveryRegion, /db\.update\(/);
  });
});

describe('rebuilding an expired cover letter', () => {
  const LETTER = {
    fullName: 'Mehek Mandal',
    email: 'mehek@example.test',
    company: 'Acme Corp',
    body: 'I am writing to apply for the Software Engineering Internship.\n\nI build things.',
  };

  test('the rebuilt letter carries the date it was WRITTEN, not the date it was rebuilt', async () => {
    /* renderCoverLetterPdf stamps a date on the page. Left to default, a letter swept in September
       and rebuilt on send would reach the employer dated September while being the letter approved
       in August: a document that never existed at that date. generated_at is the same moment the
       original stamp came from, so passing it reproduces the approved page. */
    const parsed = await extractPdfText(await rerenderFrozenCoverLetter({
      ...LETTER,
      generatedAt: '2026-07-22T09:15:00.000Z',
    }));
    assert.match(parsed.text, /July 22, 2026/);
    assert.doesNotMatch(parsed.text, new RegExp(String(new Date().getUTCFullYear()) + '\\s*$'));
    assert.match(parsed.text, /Acme Corp/);
    assert.match(parsed.text, /I build things/);
  });

  test('the rebuilt letter is the same document the applicant approved', async () => {
    /* Byte comparison against a fresh render of the same inputs at the same date. This is the claim
       the whole approach rests on: a re-render is not a regeneration, and nothing about the letter
       changes on its way through the recovery. */
    const generatedAt = '2026-07-22T09:15:00.000Z';
    const rebuilt = await rerenderFrozenCoverLetter({ ...LETTER, generatedAt });
    const original = await renderCoverLetterPdf(
      { full_name: LETTER.fullName, email: LETTER.email },
      LETTER.company,
      LETTER.body,
      new Date(generatedAt),
    );
    assert.equal(
      (await extractPdfText(rebuilt)).text,
      (await extractPdfText(original)).text,
    );
  });

  test('an unusable generated_at falls back to today rather than to an invalid date', async () => {
    const parsed = await extractPdfText(await rerenderFrozenCoverLetter({
      ...LETTER,
      generatedAt: 'not-a-date',
    }));
    assert.doesNotMatch(parsed.text, /Invalid Date|NaN/);
  });

  test('a letter with nothing to say is left expired, so the existing degrade handles it', async () => {
    for (const missing of [{ body: '   ' }, { company: '' }, { fullName: '' }]) {
      await assert.rejects(
        () => rerenderFrozenCoverLetter({ ...LETTER, ...missing }),
        (error: unknown) => error instanceof PacketDocumentExpiredError && error.document === 'cover_letter',
      );
    }
  });
});
