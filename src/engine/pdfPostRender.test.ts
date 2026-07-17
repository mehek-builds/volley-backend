import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('pins the root cause: bare pdf-parse rejects a pooled render in a FRESH process', async () => {
    // Process isolation is the point of the child spawn: pdf.js keeps state after its first
    // getDocument, so a same-process assertion here goes stale the moment another test parses a
    // zero-offset buffer first (measured 2026-07-17: identical shifted views throw in a fresh
    // process and parse after a prior success). A fresh process is also exactly what every
    // serverless invocation is, which is why prod hit this on EVERY render. The child runs the
    // route's real sequence: raw parse of a nonzero-byteOffset view fails, the zero-offset copy
    // (extractPdfText's fix) parses the same bytes. If the raw half ever starts passing,
    // pdf-parse fixed its byteOffset aliasing and the defensive copy can be retired.
    const { buffer } = await renderResumePdf(spec(), CONTACT);
    const dir = mkdtempSync(join(tmpdir(), 'r017-'));
    const pdfPath = join(dir, 'render.pdf');
    writeFileSync(pdfPath, buffer);
    try {
      const childScript = `
        const fs = require('fs');
        const pdfParse = require(${JSON.stringify(require.resolve('pdf-parse'))});
        const raw = fs.readFileSync(process.argv[1]);
        const lead = 16;
        const slab = Buffer.alloc(lead + raw.length + 64, 0x41);
        raw.copy(slab, lead);
        const shifted = slab.subarray(lead, lead + raw.length);
        (async () => {
          let rawParse;
          try { await pdfParse(shifted); rawParse = 'parsed'; }
          catch (e) { rawParse = 'threw: ' + e.message; }
          const fixed = await pdfParse(new Uint8Array(shifted));
          console.log(JSON.stringify({ rawParse, pages: fixed.numpages, chars: fixed.text.trim().length }));
        })();
      `;
      const stdout = execFileSync(process.execPath, ['-e', childScript, pdfPath], { encoding: 'utf8' });
      const out = JSON.parse(stdout.trim().split('\n').pop() as string) as { rawParse: string; pages: number; chars: number };
      assert.match(
        out.rawParse,
        /threw: .*XRef/i,
        `expected the raw pooled parse to fail with the R-017 error, got "${out.rawParse}" - if it parses now, pdf-parse fixed its byteOffset bug and extractPdfText's copy can be retired`,
      );
      assert.equal(out.pages, 1, 'the zero-offset copy must parse the same bytes');
      assert.ok(out.chars > 400, 'the zero-offset copy must extract the full text');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
