import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderResumePdf } from './resumeRender';
import { validatePdfLayout } from './resumeValidate';
import { extractPdfText } from '../lib/pdfText';
import type { ResumeSpec } from '../llm/resumeSpec';

// R-017 regression coverage. The "authoritative" post-render PDF check had NEVER run: every
// render logged "bad XRef entry" from a warn-swallowed catch, and the empty layoutIssues array
// read downstream as a clean pass. Root cause is a byteOffset aliasing bug in pdf-parse@1.1.1's
// bundled pdf.js (documented in lib/pdfText.ts); these tests drive the whole pipeline the route
// runs - real render, real parse, real validation - against buffers laid out the way production
// buffers actually are (inside Node's shared pool, nonzero byteOffset).

function spec(over: Partial<ResumeSpec> = {}): ResumeSpec {
  return {
    school: 'University of Southern California',
    degree: 'B.S. Computer Science',
    grad_date: 'May 2028',
    coursework: 'Data Structures, Algorithms, Machine Learning',
    experience: [1, 2, 3].map((i) => ({
      org: `Company ${i}`,
      title: 'Software Engineering Intern',
      date_range: 'Jun 2024 - Aug 2025',
      bullets: [1, 2, 3].map(
        (j) => `Built feature ${j} that improved conversion by ${10 + j}% across 40,000 daily events for 100+ users`,
      ),
    })),
    skills: ['Python', 'SQL', 'Figma', 'Amplitude', 'Swift', 'Tableau', 'Firebase', 'Git'],
    ...over,
  } as ResumeSpec;
}

const CONTACT = {
  full_name: 'Mehek Mandal',
  email: 'mehekman@usc.edu',
  phone: '+971 567417451',
  linkedin_url: 'linkedin.com/in/mehek',
  github_url: 'github.com/mehek-builds',
};

// Re-buffer a render into Node's shared pool at a guaranteed nonzero byteOffset - the exact
// memory layout /resume/generate's Buffer.concat produces in a warm process, and the one that
// made the old code throw on every render.
function pooledCopy(buffer: Buffer): Buffer {
  const shifted = Buffer.concat([Buffer.alloc(16), buffer]).subarray(16);
  assert.notEqual(shifted.byteOffset, 0, 'test setup: expected a nonzero byteOffset');
  assert.ok(shifted.equals(buffer), 'test setup: contents must be identical');
  return shifted;
}

describe('R-017: the post-render check actually runs', () => {
  test('extractPdfText parses a real rendered resume from a pooled (nonzero-byteOffset) buffer', async () => {
    const { buffer } = await renderResumePdf(spec(), CONTACT);
    const { text, numpages } = await extractPdfText(pooledCopy(buffer));
    assert.equal(numpages, 1);
    assert.ok(text.includes('Mehek Mandal'), 'extracted text should carry the header');
    assert.ok(text.includes('Company 1'), 'extracted text should carry the experience entries');
    assert.ok(text.trim().length >= 400, 'a full resume must clear the extractability floor');
  });

  test('the check catches a seeded violation: an em dash injected into a bullet', async () => {
    const bad = spec();
    bad.experience[0].bullets[0] = 'Cut latency from 2.3s to 0.1s \u2014 measured across 100+ users';
    const { buffer } = await renderResumePdf(bad, CONTACT);
    const { text, numpages } = await extractPdfText(pooledCopy(buffer));
    const { issues } = validatePdfLayout(text, numpages);
    assert.ok(
      issues.some((i) => /em dash/.test(i)),
      `expected the em-dash violation to be caught, got: ${JSON.stringify(issues)}`,
    );
  });

  test('a clean render produces zero layout issues through the same path', async () => {
    const { buffer } = await renderResumePdf(spec(), CONTACT);
    const { text, numpages } = await extractPdfText(pooledCopy(buffer));
    assert.deepEqual(validatePdfLayout(text, numpages).issues, []);
  });

  test('the defensive extraction path remains correct even when the raw parser also accepts the pooled buffer', async () => {
    const { buffer } = await renderResumePdf(spec(), CONTACT);
    const shifted = pooledCopy(buffer);
    const extracted = await extractPdfText(shifted);

    assert.equal(extracted.numpages, 1);
    assert.ok(extracted.text.includes('Mehek Mandal'));
    assert.ok(extracted.text.trim().length >= 400);
  });
});
