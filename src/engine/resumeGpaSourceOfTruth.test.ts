import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { extractPdfText } from '../lib/pdfText';
import {
  academicsOfRecordForResume,
  applyResumePolicy,
  educationFrom,
  educationGpaLine,
  RESUME_ACADEMIC_FIELDS,
} from './resumePolicy';
import { renderResumePdf } from './resumeRender';
import { RESUME_VISUAL_BENCHMARK } from './resumeVisualBenchmark';

/* Which GPA reaches an employer.
 *
 * On 2026-08-03 a student's parse held "3.8" where application_profile held "3.89", her real grade.
 * Autofill typed 3.89 (the extension reads application_profile), GET /profile served 3.89, and the
 * PDF - the copy an employer keeps, printed under her name - said 3.8, because resume generation
 * read profiles.parsed_json. Nothing backfills the stale column, so this is not a data problem that
 * ages out: the render has to resolve the two stores itself, every time.
 *
 * These tests are about SOURCE, not format. educationGpaLine is unchanged and has its own coverage
 * in resumePolicy.test.ts; what is pinned here is which of two stored numbers it is handed. */

function bankEntry(id: string, org: string, title: string, bullets: string[]): ExperienceBankEntry {
  return {
    id,
    user_id: 'user-1',
    type: 'job',
    org,
    title,
    date_range: '2025 - Present',
    bullet_variants: bullets,
    tags: [],
    created_at: new Date('2026-01-01'),
  } as ExperienceBankEntry;
}

const BANK = [
  bankEntry('1', 'Acme Labs', 'Product Intern', [
    'Analyzed customer interviews and translated findings into launch priorities for the product team',
    'Built weekly dashboards that tracked activation across three onboarding paths',
    'Presented research findings to leaders and secured approval for two experiments',
  ]),
];

function rawSpec(): ResumeSpec {
  return {
    school: 'Invented University',
    degree: 'MBA',
    grad_date: 'May 2027',
    coursework: '',
    education_position: 'after_experience',
    experience: BANK.map((entry) => ({
      type: 'job' as const,
      org: entry.org,
      title: entry.title ?? '',
      date_range: entry.date_range ?? '',
      bullets: entry.bullet_variants as string[],
    })),
    skills: ['TypeScript'],
  } as ResumeSpec;
}

// The shape of the defect, as it actually sat in the database.
const TRUNCATED_PARSE = { school: 'USC', degree: 'BS CS', grad_date: 'May 2027', gpa: '3.8', gpa_scale: '4.0' };
const RECORD_3_89 = { gpa: '3.89', gpa_scale: '4.0' };

describe('the GPA a resume prints comes from application_profile', () => {
  /* THE regression. Fails on 97f724d, which printed the parse's number. */
  test('the stated grade beats the parsed one when they disagree', () => {
    const education = educationFrom(TRUNCATED_PARSE, RECORD_3_89);
    assert.equal(education.gpa, '3.89');
    assert.equal(educationGpaLine(education), '3.89/4.0');
  });

  test('the same disagreement resolves the same way through the whole policy pass', () => {
    const { spec } = applyResumePolicy(
      rawSpec(),
      educationFrom(TRUNCATED_PARSE, RECORD_3_89),
      BANK,
      'engineering role',
    );
    assert.equal(spec.gpa, '3.89/4.0');
  });

  /* The number on the paper, which is the only surface this defect was ever about. Goes through the
     real renderer and reads the text back out of the PDF: a spec field holding the right string is
     not the claim being made here. */
  test('the stated grade is what the rendered PDF prints', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.gpa = educationGpaLine(educationFrom(TRUNCATED_PARSE, RECORD_3_89));

    const rendered = await renderResumePdf(spec, benchmark.contact, benchmark.jdText);
    const flat = (await extractPdfText(rendered.buffer)).text.replace(/\s+/g, ' ');

    assert.match(flat, /GPA: 3\.89\/4\.0/);
    assert.doesNotMatch(flat, /GPA: 3\.8\//);
  });

  /* The scale is an academic claim too - "3.89" means something different on a 4.0 than on a 5.0 -
     so it is taken from the same row as the number rather than paired with a scale the parse read
     off a different reading of the page. */
  test('the scale travels with the grade, not with the parse', () => {
    const education = educationFrom(
      { ...TRUNCATED_PARSE, gpa_scale: '4.0' },
      { gpa: '8.9', gpa_scale: '10.0' },
    );
    assert.equal(educationGpaLine(education), '8.9/10.0');
  });

  test('a stated grade with no stated scale prints bare, not on the scale the parse read', () => {
    const education = educationFrom(TRUNCATED_PARSE, { gpa: '3.89', gpa_scale: '' });
    assert.equal(educationGpaLine(education), '3.89');
  });
});

describe('the parse is the seed behind the record, not a competitor to it', () => {
  /* No application_profile row at all: nothing to contradict, and the parse is the only copy anyone
     has. A student who has not reached the application-profile step still gets her GPA. */
  test('with no academic record on file the parse is used', () => {
    const education = educationFrom(TRUNCATED_PARSE, undefined);
    assert.equal(educationGpaLine(education), '3.8/4.0');
  });

  /* A row that EXISTS but states no GPA is a first-hand blank, and blank is an answer: it is what
     autofill types into an employer's GPA box and what the dashboard shows the student. Printing
     the parse's number here would recreate the same contradiction pointed the other way. */
  test('a blank on the record suppresses the number rather than falling back', () => {
    const education = educationFrom(TRUNCATED_PARSE, { gpa: '', gpa_scale: '' });
    assert.equal(education.gpa, '');
    assert.equal(educationGpaLine(education), '');
  });

  test('a whitespace-only record entry is a blank, not a value', () => {
    assert.equal(educationGpaLine(educationFrom(TRUNCATED_PARSE, { gpa: '   ' })), '');
  });

  test('a non-string on the record is a blank, not a value', () => {
    // application_profile is written through a zod schema, but a hand-edited row can hold anything.
    assert.equal(educationGpaLine(educationFrom(TRUNCATED_PARSE, { gpa: 3.89 })), '');
  });
});

describe('an absent GPA prints nothing at all', () => {
  test('no grade anywhere renders an empty string, never "undefined"', () => {
    const education = educationFrom({ school: 'USC', degree: 'BS CS' }, undefined);
    assert.equal(educationGpaLine(education), '');
    const { spec } = applyResumePolicy(rawSpec(), education, BANK, 'engineering role');
    assert.equal(spec.gpa, '');
  });

  test('the rendered PDF carries no GPA line when there is no grade', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.gpa = educationGpaLine(educationFrom({ school: 'USC' }, { gpa: '' }));

    const rendered = await renderResumePdf(spec, benchmark.contact, benchmark.jdText);
    const flat = (await extractPdfText(rendered.buffer)).text.replace(/\s+/g, ' ');
    assert.doesNotMatch(flat, /GPA/);
    assert.doesNotMatch(flat, /undefined/);
  });
});

describe('one builder serves both generation paths', () => {
  /* /resume/base/stream and /resume/generate built the education block from two separate pieces of
     code, and the tailored one read the wrong column. Same function now, asserted by identity: a
     re-inlined copy on either side is exactly the drift that produced this defect. */
  test('baseResume re-exports the engine builder rather than keeping its own', async () => {
    const { educationFrom: fromRoute } = await import('../routes/baseResume');
    assert.equal(fromRoute, educationFrom);
  });

  test('neither generation route builds a CandidateEducation by hand', () => {
    for (const route of ['resume.ts', 'baseResume.ts']) {
      const source = stripComments(
        readFileSync(path.join(__dirname, '..', 'routes', route), 'utf8'),
      );
      assert.match(source, /educationFrom\(/, `${route} must build its education block with educationFrom`);
      assert.doesNotMatch(
        source,
        /gpa:\s*(parsed|p)\?\./,
        `${route} must not read a GPA out of the parse directly`,
      );
    }
  });
});

describe('the resume academic record matches the one every other surface serves', () => {
  /* academicsOfRecordForResume is a deliberate second implementation of routes/profile.ts's
     academicsOfRecord (the engine layer cannot import a route module), so the two are pinned to
     agree. If they ever diverge, the PDF and the dashboard state different grades again. */
  test('it resolves gpa and gpa_scale exactly as GET /profile does', async () => {
    const { academicsOfRecord } = await import('../routes/profile');
    const rows: Array<Record<string, unknown>> = [
      { gpa: '3.89', gpa_scale: '4.0', major: 'CS' },
      { gpa: '  3.89  ', gpa_scale: '   ', major: ' CS ' },
      { gpa: '', gpa_scale: '', major: '' },
      { gpa: null, gpa_scale: undefined, major: 3 },
      {},
    ];
    for (const row of rows) {
      const served = academicsOfRecord(row) as Record<string, unknown>;
      const forResume = academicsOfRecordForResume(row) as Record<string, unknown>;
      for (const field of RESUME_ACADEMIC_FIELDS) {
        assert.equal(forResume[field], served[field], `${field} must agree for ${JSON.stringify(row)}`);
      }
    }
  });

  test('no row means no override on either surface', () => {
    assert.equal(academicsOfRecordForResume(undefined), undefined);
  });

  /* major is NOT here on purpose: ResumeSpec has no major field and resumeRender draws none, so
     there is nothing on the page for it to be right or wrong about. This pins the reason rather
     than the omission, so adding a major to the render forces this test to be revisited. */
  test('major is excluded because the render has no place to print it', () => {
    const specSource = stripComments(
      readFileSync(path.join(__dirname, '..', 'llm', 'resumeSpec.ts'), 'utf8'),
    );
    assert.doesNotMatch(specSource, /\bmajor\b/);
    assert.deepEqual([...RESUME_ACADEMIC_FIELDS], ['gpa', 'gpa_scale']);
  });
});

/* Structural assertions read code, and a comment that MENTIONS the thing being forbidden would
 * otherwise pass or fail the check on prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
