import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import pdfParse from 'pdf-parse';
import { extractPdfText } from '../lib/pdfText';
import { RESUME_CONTENT_LIMITS } from './resumeContentPolicy';
import { validatePdfLayout } from './resumeValidate';
import { RESUME_DESIGN, resumeDesignAtExpansion } from './resumeDesign';
import {
  measureResumeLayout,
  findPdfSafeMarginIssues,
  findPdfTextFidelityIssues,
  findResumeTypographyIssues,
  planResumeLayout,
  renderResumePdf,
  validateResumeVisualLayout,
  type ResumeVisualLayout,
} from './resumeRender';
import { RESUME_VISUAL_BENCHMARK } from './resumeVisualBenchmark';

interface RenderedTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function renderedTextItems(pdf: Buffer): Promise<RenderedTextItem[][]> {
  const pages: RenderedTextItem[][] = [];
  const zeroOffset = new Uint8Array(pdf);
  await pdfParse(zeroOffset as unknown as Buffer, {
    pagerender: async (pageData: {
      getTextContent: (options: Record<string, boolean>) => Promise<{
        items: Array<{
          str: string;
          transform: number[];
          width: number;
          height: number;
        }>;
      }>;
    }) => {
      const content = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      const items = content.items.map((item) => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height,
      }));
      pages.push(items);
      return items.map((item) => item.text).join(' ');
    },
  });
  return pages;
}

/* Every text baseline on the rendered page, top to bottom. These are golden values: they exist to
 * catch layout drift nobody intended, so a diff here is a question, not automatically a bug.
 *
 * Last regenerated 2026-08-04, for the two-split-line entry layout: the place moved to the right of
 * the organisation and the date dropped to the right of the role. The ITEM COUNT is unchanged in all
 * three cases, which is the reassuring part - nothing was added or lost, the date's baseline simply
 * coincides with the role's now instead of the organisation's. The remaining deltas are all under
 * 0.3pt and come from the italic line-gap ratio applying to the second line's left column.
 *
 * Previously regenerated 2026-08-02, for the 4pt safe inset above the candidate name. Every name baseline
 * moved down 4pt. The page-fill planner then reduced expansion slightly to keep the same 94% target,
 * so later baselines move by progressively less. The section order and bullet line counts remain
 * unchanged, and the rendered safe-margin check passes for all benchmark cases.
 */
const RENDERED_BASELINE_SNAPSHOTS: Record<string, number[]> = {
  '04-sparse-two-short-jobs': [
    733.3, 706, 656.8, 630, 611.1, 569.8, 542.9, 524.1, 502.7, 481.3, 448.9,
    430.1, 408.7, 387.3, 345.9, 319.1,
  ],
  '09-normal-all-sections': [
    733.7, 707.5, 661.4, 635.5, 617.3, 599.4, 560.3, 534.4, 516.1, 495.6, 482.4,
    461.8, 448.6, 409.4, 383.6, 365.3, 344.7, 331.5, 311, 297.7, 258.6, 232.7,
    214.4, 193.9, 180.7, 160.1, 146.9, 107.7, 81.9,
  ],
  '24-dense-long-everything': [
    737.2, 719.4, 708.6, 687.5, 669.3, 655.6, 642.2, 630.3, 609, 590.8, 577.1,
    563.4, 551.5, 537.8, 525.9, 512.2, 500.3, 483.6, 469.8, 456.1, 444.2, 430.5,
    418.6, 404.9, 393, 371.7, 353.5, 339.8, 326.1, 314.2, 300.5, 288.6, 274.9,
    263, 241.7, 223.5, 209.8, 196.1, 184.2, 170.5, 158.6, 144.9, 133, 111.7,
    93.5, 81.6,
  ],
};

describe('resume visual layout controls', () => {
  test('the benchmark contains exactly 25 named layouts', () => {
    assert.equal(RESUME_VISUAL_BENCHMARK.length, 25);
    assert.equal(new Set(RESUME_VISUAL_BENCHMARK.map((entry) => entry.id)).size, 25);
    // Pinned so a density change has to be deliberate. targetFillRatio moved 0.66 -> 0.94 and
    // expandBelowRatio was added on 2026-07-27; sparseTriggerRatio stays 0.5 because it now means
    // only "warn that this resume is too thin", not "decide whether to expand".
    assert.equal(RESUME_DESIGN.compact.density.sparseTriggerRatio, 0.5);
    assert.equal(RESUME_DESIGN.compact.density.expandBelowRatio, 0.98);
    assert.equal(RESUME_DESIGN.compact.density.targetFillRatio, 0.94);
    assert.equal(RESUME_DESIGN.compact.density.maximumFillRatio, 1);
  });

  test('sparse resumes expand typography and spacing without changing content', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '04-sparse-two-short-jobs');
    assert.ok(benchmark);
    const compact = measureResumeLayout(
      benchmark.spec,
      benchmark.contact,
      resumeDesignAtExpansion(0),
    );
    const plan = planResumeLayout(benchmark.spec, benchmark.contact, benchmark.jdText);

    assert.ok(compact.fill_ratio < RESUME_DESIGN.compact.density.sparseTriggerRatio);
    assert.ok(plan.layout.fill_ratio > compact.fill_ratio);
    assert.ok(plan.layout.density_expansion > 0);
    assert.deepEqual(plan.spec, benchmark.spec);
    assert.equal(plan.layout.body_font_size >= RESUME_DESIGN.compact.typography.body, true);
  });

  test('sparse expansion stops before a spacious bullet would exceed two lines', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '01-sparse-single-job');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.experience[0].bullets[0] = Array(31).fill('impact').join(' ');

    const compact = measureResumeLayout(
      spec,
      benchmark.contact,
      resumeDesignAtExpansion(0),
    );
    const spacious = measureResumeLayout(
      spec,
      benchmark.contact,
      resumeDesignAtExpansion(1),
      1,
    );
    const plan = planResumeLayout(spec, benchmark.contact, benchmark.jdText);
    const rendered = await renderResumePdf(spec, benchmark.contact, benchmark.jdText);
    const parsed = await extractPdfText(rendered.buffer);

    assert.equal(compact.bullets[0].lines, 2);
    assert.equal(spacious.bullets[0].lines, 3);
    assert.ok(plan.layout.density_expansion > 0);
    assert.ok(plan.layout.density_expansion < 1);
    assert.ok(plan.layout.bullets.every((bullet) => bullet.lines <= 2));
    assert.equal(parsed.numpages, 1);
  });

  test('expansion stops near the target fill when full expansion would exceed it', () => {
    /* Fixture changed 2026-07-27. This used to be 06-normal-two-jobs with five skills bolted on,
     * chosen because it overshot the OLD 0.66 target at full expansion. Against a 0.94 target it
     * no longer overshoots at all - it runs out of scale first - so it stopped exercising the
     * behaviour named in the title. A genuinely dense resume is the case that still has to stop
     * partway, so the test now uses one instead of a padded normal one. */
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '16-dense-four-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);

    const compact = measureResumeLayout(
      spec,
      benchmark.contact,
      resumeDesignAtExpansion(0),
    );
    const spacious = measureResumeLayout(
      spec,
      benchmark.contact,
      resumeDesignAtExpansion(1),
      1,
    );
    const plan = planResumeLayout(spec, benchmark.contact, benchmark.jdText);

    // The interesting case is content that WOULD overshoot at full expansion: the search has to
    // stop partway rather than run to the end of the scale.
    assert.ok(compact.fill_ratio < RESUME_DESIGN.compact.density.targetFillRatio);
    assert.ok(spacious.fill_ratio > RESUME_DESIGN.compact.density.targetFillRatio);
    assert.ok(plan.layout.density_expansion > 0);
    assert.ok(plan.layout.density_expansion < 1);
    assert.ok(
      Math.abs(plan.layout.fill_ratio - RESUME_DESIGN.compact.density.targetFillRatio) < 0.002,
      `converged to ${plan.layout.fill_ratio.toFixed(3)}`,
    );
  });

  /* REPLACES 'normal resumes retain the compact design' (2026-07-27).
   *
   * That test asserted density_expansion === 0 for an ordinary resume, which was the behaviour
   * that left every real resume a third empty: measured across five downloaded sample resumes,
   * output filled 0.675 to 0.720 of the page. Retaining compact IS the defect, so the test that
   * pinned it had to go rather than be worked around. A one-page resume should fill its page. */
  test('normal resumes expand to fill the page', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '09-normal-all-sections');
    assert.ok(benchmark);
    const compact = measureResumeLayout(
      benchmark.spec,
      benchmark.contact,
      resumeDesignAtExpansion(0),
    );
    const plan = planResumeLayout(benchmark.spec, benchmark.contact, benchmark.jdText);

    // Compact leaves this resume 40% empty, which is precisely why it must not be what ships.
    assert.ok(compact.fill_ratio < RESUME_DESIGN.compact.density.expandBelowRatio);
    assert.ok(plan.layout.density_expansion > 0);
    assert.ok(
      plan.layout.fill_ratio >= 0.9,
      `expected a full page, got ${plan.layout.fill_ratio.toFixed(3)}`,
    );
    // Filling the page must never mean overflowing it.
    assert.ok(plan.layout.fill_ratio <= RESUME_DESIGN.compact.density.maximumFillRatio);
    assert.ok(plan.layout.bullets.every((b) => b.lines <= RESUME_DESIGN.compact.limits.maxBulletLines));
  });

  /* The other half of the same rule: expansion is bounded by what still fits. A resume already
   * dense at compact must be expanded only as far as the target, never past the page. */
  test('dense resumes expand only to the target, never past the page', () => {
    for (const id of ['17-dense-five-entries', '24-dense-long-everything']) {
      const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === id);
      assert.ok(benchmark, id);
      const plan = planResumeLayout(benchmark.spec, benchmark.contact, benchmark.jdText);
      assert.ok(
        Math.abs(plan.layout.fill_ratio - RESUME_DESIGN.compact.density.targetFillRatio) < 0.01,
        `${id}: fill ${plan.layout.fill_ratio.toFixed(3)}`,
      );
      assert.ok(plan.layout.fill_ratio <= RESUME_DESIGN.compact.density.maximumFillRatio, id);
    }
  });

  /* Every benchmark, one invariant: whatever the expansion search picks, it fits on the page and
   * respects the bullet line cap. This is the guard that makes widening the spacious end safe. */
  test('no benchmark layout overflows its page after expansion', () => {
    for (const benchmark of RESUME_VISUAL_BENCHMARK) {
      const plan = planResumeLayout(benchmark.spec, benchmark.contact, benchmark.jdText);
      assert.ok(
        plan.layout.fill_ratio <= RESUME_DESIGN.compact.density.maximumFillRatio,
        `${benchmark.id}: fill ${plan.layout.fill_ratio.toFixed(3)}`,
      );
      assert.ok(
        plan.layout.bullets.every((b) => b.lines <= RESUME_DESIGN.compact.limits.maxBulletLines),
        `${benchmark.id}: bullet exceeded ${RESUME_DESIGN.compact.limits.maxBulletLines} lines`,
      );
    }
  });

  test('the shared content policy caps bullets before layout selection', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.experience[0].bullets.push(
      'Automated release verification for 7 services and reduced rollback time by 28%.',
    );

    const plan = planResumeLayout(spec, benchmark.contact, benchmark.jdText);
    assert.equal(
      plan.spec.experience[0].bullets.length,
      RESUME_CONTENT_LIMITS.maxBulletsPerEntry,
    );
    assert.ok(plan.omissions.some((item) => item.includes('lower-fit bullet')));
  });

  test('the canonical mixed-section geometry stays visually stable', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '09-normal-all-sections');
    assert.ok(benchmark);
    const layout = planResumeLayout(benchmark.spec, benchmark.contact, benchmark.jdText).layout;
    const round = (value: number, digits = 1) => Number(value.toFixed(digits));

    assert.deepEqual(
      {
        body_font_size: round(layout.body_font_size),
        density_expansion: round(layout.density_expansion, 3),
        fill_ratio: round(layout.fill_ratio, 3),
        bottom_whitespace: round(layout.bottom_whitespace),
        section_order: layout.section_order,
        sections: layout.sections.map((section) => ({
          name: section.name,
          top: round(section.top),
          bottom: round(section.bottom),
          height: round(section.height),
        })),
        bullet_lines: layout.bullets.map((bullet) => bullet.lines),
      },
      /* Updated 2026-08-04 for the two-split-line entry layout. Expansion adjusts from 0.905 to
       * 0.902 so the resume still lands at the 0.94 fill target, and the EDUCATION block grows a
       * tenth of a point because the second line's left column is now italic. What matters is what
       * did NOT move: the section order, all six bullet line counts, and every section boundary
       * beyond a rounding tick. The dates changed columns, not the shape of the page.
       *
       * Previously updated 2026-08-02 for the 4pt header safe inset. */
      {
        body_font_size: 11.9,
        density_expansion: 0.902,
        fill_ratio: 0.94,
        bottom_whitespace: 43.2,
        section_order: ['HEADER', 'EDUCATION', 'EXPERIENCE', 'PROJECTS', 'LEADERSHIP', 'SKILLS'],
        sections: [
          { name: 'HEADER', top: 36, bottom: 107.2, height: 71.2 },
          { name: 'EDUCATION', top: 107.2, bottom: 195.2, height: 88 },
          { name: 'EXPERIENCE', top: 195.2, bottom: 346.1, height: 150.8 },
          { name: 'PROJECTS', top: 346.1, bottom: 496.9, height: 150.8 },
          { name: 'LEADERSHIP', top: 496.9, bottom: 647.8, height: 150.8 },
          { name: 'SKILLS', top: 647.8, bottom: 712.8, height: 65 },
        ],
        bullet_lines: [2, 2, 2, 2, 2, 2],
      },
    );
  });

  test('visual validation catches clipping, overlap, wrong order, small type, and long bullets', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '09-normal-all-sections');
    assert.ok(benchmark);
    const clean = planResumeLayout(benchmark.spec, benchmark.contact, benchmark.jdText).layout;
    assert.deepEqual(validateResumeVisualLayout(clean).issues, []);

    const broken: ResumeVisualLayout = {
      ...clean,
      content_bottom: clean.page_height,
      fill_ratio: 1.1,
      body_font_size: 8,
      section_order: [...clean.section_order].reverse(),
      sections: clean.sections.map((section, index) =>
        index === 1 ? { ...section, top: clean.sections[0].bottom - 10 } : section,
      ),
      bullets: clean.bullets.map((bullet, index) =>
        index === 0 ? { ...bullet, lines: 3 } : bullet,
      ),
    };
    const issues = validateResumeVisualLayout(broken).issues.join('\n');
    assert.match(issues, /clips/);
    assert.match(issues, /fills 110%/);
    assert.match(issues, /section order/);
    assert.match(issues, /overlaps/);
    assert.match(issues, /3 lines/);
    assert.match(issues, /body font/);
  });

  test('typography validation catches a bullet that exceeds two rendered lines', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.experience[0].bullets[0] =
      'Built and launched a deeply integrated customer analytics and workflow automation platform across product, engineering, data science, operations, finance, sales, marketing, compliance, security, and customer success teams, reducing reporting time by 35% while documenting every migration decision and recovery procedure for future operators.';

    const issues = findResumeTypographyIssues(spec, benchmark.contact);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /renders as 3 lines/);
  });

  test('PDF text fidelity preserves common Latin extended names', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const contact = { ...benchmark.contact, full_name: 'Zoë Łukasz' };
    const rendered = await renderResumePdf(benchmark.spec, contact, benchmark.jdText);
    const parsed = await extractPdfText(rendered.buffer);

    assert.deepEqual(findPdfTextFidelityIssues(parsed.text, rendered.spec, contact), []);
  });

  test('safe-margin validation rejects an extractable header that clips above the page', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const layout = planResumeLayout(benchmark.spec, benchmark.contact, benchmark.jdText).layout;
    const issues = findPdfSafeMarginIssues([[
      {
        text: benchmark.contact.full_name,
        x: layout.margin,
        y: layout.page_height - layout.margin - 8,
        width: 120,
        height: 12,
      },
    ]], layout);
    assert.ok(issues.some((issue) => /top safe margin/.test(issue)));
  });

  /* Replaces two tests that asserted the opposite: that the target role rendered under the name and
     that fidelity FAILED when it was absent. Both guarded a feature removed 2026-08-04 (the header
     is the name, a rule, and the contact line, matching the applicant's own template). Deleting
     them without putting this in its place would leave the header's most contested line unpinned,
     and it is the line most likely to be reintroduced by someone reading the still-present
     `spec.target_role` and assuming it is meant to be printed. */
  /* The GPA reaches the paper, sits where a student's own resume puts it, and is budgeted for.
     Height and drawing move together here for the same reason the target-role removal had to: a
     line drawn but not measured makes the layout search solve for a page that is not the page, and
     the error surfaces as the last entry sliding off a resume that reports itself as fitting. */
  /* The two-split-line shape, which is what a resume actually looks like: the left edge is the
     institution and the role, the right edge is where and when. Pinned by GEOMETRY rather than by
     text order, because "Los Angeles, CA appears somewhere" would pass even if it rendered on the
     wrong line or in the left column. */
  test('place sits right of the organisation, date right of the role', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.school_location = 'Los Angeles, CA';
    spec.experience[0].location = 'Princeton, NJ';

    const rendered = await renderResumePdf(spec, benchmark.contact, benchmark.jdText);
    const parsed = await extractPdfText(rendered.buffer);
    const items = parsed.pages.flat().filter((item) => item.text.trim());
    const find = (text: string) => items.find((item) => item.text.includes(text));

    const school = find(spec.school.slice(0, 20));
    const place = find('Los Angeles');
    const degree = find(spec.degree.slice(0, 20));
    const gradDate = find(spec.grad_date);
    assert.ok(school && place && degree && gradDate);

    // Same line as its left-hand partner, and further right than it.
    assert.ok(Math.abs(school.y - place.y) < 1, 'the place shares the school baseline');
    assert.ok(place.x > school.x, 'the place is the right-hand column');
    assert.ok(Math.abs(degree.y - gradDate.y) < 1, 'the date shares the degree baseline');
    assert.ok(gradDate.x > degree.x, 'the date is the right-hand column');
    // And the date is genuinely BELOW the school line now, not beside it.
    assert.ok(gradDate.y < school.y, 'the date dropped to the second line');

    const org = find(spec.experience[0].org);
    const entryPlace = find('Princeton');
    const title = find(spec.experience[0].title.slice(0, 15));
    const range = find(spec.experience[0].date_range);
    assert.ok(org && entryPlace && title && range);
    assert.ok(Math.abs(org.y - entryPlace.y) < 1 && entryPlace.x > org.x);
    assert.ok(Math.abs(title.y - range.y) < 1 && range.x > title.x);

    assert.equal(parsed.numpages, 1);
    assert.deepEqual(findPdfTextFidelityIssues(parsed.text, rendered.spec, benchmark.contact), []);
    assert.deepEqual(findPdfSafeMarginIssues(parsed.pages, rendered.layout), []);
  });

  test('a resume with no places on file still renders, one line short', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const rendered = await renderResumePdf(benchmark.spec, benchmark.contact, benchmark.jdText);
    const parsed = await extractPdfText(rendered.buffer);
    assert.equal(parsed.numpages, 1);
    assert.deepEqual(findPdfTextFidelityIssues(parsed.text, rendered.spec, benchmark.contact), []);
    assert.deepEqual(validateResumeVisualLayout(rendered.layout).issues, []);
  });

  test('a GPA renders between the degree and the coursework, and is measured', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const withGpa = structuredClone(benchmark.spec);
    withGpa.gpa = '3.89/4.0';
    const withoutGpa = structuredClone(benchmark.spec);
    withoutGpa.gpa = '';

    const rendered = await renderResumePdf(withGpa, benchmark.contact, benchmark.jdText);
    const parsed = await extractPdfText(rendered.buffer);
    const flat = parsed.text.replace(/\s+/g, ' ');

    assert.equal(parsed.numpages, 1);
    assert.match(flat, /GPA: 3\.89\/4\.0/);
    // Order on the page: degree, then GPA, then coursework.
    assert.ok(flat.indexOf(withGpa.degree) < flat.indexOf('GPA: 3.89/4.0'));
    assert.ok(flat.indexOf('GPA: 3.89/4.0') < flat.indexOf('Relevant coursework'));
    assert.deepEqual(findPdfTextFidelityIssues(parsed.text, rendered.spec, benchmark.contact), []);
    assert.deepEqual(validateResumeVisualLayout(rendered.layout).issues, []);
    assert.deepEqual(findPdfSafeMarginIssues(parsed.pages, rendered.layout), []);

    // Budgeted, not drawn for free: the measured education block has to grow by the line.
    const tall = planResumeLayout(withGpa, benchmark.contact, benchmark.jdText);
    const short = planResumeLayout(withoutGpa, benchmark.contact, benchmark.jdText);
    assert.ok(tall && short);
    assert.ok(
      tall.layout.content_height > short.layout.content_height,
      'the education block must measure taller with a GPA than without one',
    );
  });

  test('no GPA on file prints no GPA line at all', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.gpa = '';
    const rendered = await renderResumePdf(spec, benchmark.contact, benchmark.jdText);
    const parsed = await extractPdfText(rendered.buffer);
    assert.doesNotMatch(parsed.text, /GPA/);
    assert.deepEqual(findPdfTextFidelityIssues(parsed.text, rendered.spec, benchmark.contact), []);
  });

  test('the target role is never printed on the document', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.target_role = 'Senior Analytics Engineering and Data Governance Lead for Global Operations';
    const rendered = await renderResumePdf(spec, benchmark.contact, benchmark.jdText);
    const parsed = await extractPdfText(rendered.buffer);
    const flat = parsed.text.replace(/\s+/g, ' ');

    assert.equal(parsed.numpages, 1);
    assert.doesNotMatch(flat, /Senior Analytics Engineering and Data Governance Lead/);
    // The name still leads, and EDUCATION still follows the contact line rather than a headline.
    assert.match(flat.trimStart(), new RegExp(`^${benchmark.contact.full_name}`));
    assert.deepEqual(validateResumeVisualLayout(rendered.layout).issues, []);
    assert.deepEqual(validatePdfLayout(parsed.text, parsed.numpages).issues, []);
    assert.deepEqual(findPdfTextFidelityIssues(parsed.text, rendered.spec, benchmark.contact), []);
    assert.deepEqual(findPdfSafeMarginIssues(parsed.pages, rendered.layout), []);
  });

  /* A target role that is set but unprinted must not be treated as missing content. This is the
     regression the old fidelity expectation would now cause if it were left in place. */
  test('fidelity does not demand a target role that is deliberately unprinted', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = { ...benchmark.spec, target_role: 'Analytics Engineer' };
    const issues = findPdfTextFidelityIssues('Candidate Name EDUCATION EXPERIENCE', spec, benchmark.contact);
    assert.ok(!issues.some((issue) => /target role/.test(issue)));
  });

  test('PDF text fidelity fails closed for unsupported name glyphs', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const contact = { ...benchmark.contact, full_name: 'Zoë Łukasz 李' };
    const rendered = await renderResumePdf(benchmark.spec, contact, benchmark.jdText);
    const parsed = await extractPdfText(rendered.buffer);
    const issues = findPdfTextFidelityIssues(parsed.text, rendered.spec, contact);

    assert.ok(issues.includes('rendered PDF text does not faithfully preserve header name'));
    assert.ok(!issues.includes('rendered PDF text does not faithfully preserve education school'));
  });

  test('PDF text fidelity does not let a repeated bullet word mask a missing header name', () => {
    const issues = findPdfTextFidelityIssues(
      'EXPERIENCE Alex improved onboarding conversion',
      {
        school: '',
        degree: '',
        grad_date: '',
        coursework: '',
        experience: [{
          org: '',
          title: '',
          date_range: '',
          bullets: ['Alex improved onboarding conversion'],
        }],
        skills: [],
      },
      { full_name: 'Alex' },
    );

    assert.ok(issues.includes('rendered PDF text does not faithfully preserve header name'));
  });

  test('PDF text fidelity accepts whitespace differences introduced at wrapped line boundaries', () => {
    const spec = {
      school: '',
      degree: '',
      grad_date: '',
      coursework: '',
      experience: [{
        org: 'Traeco',
        title: 'Software Engineer',
        date_range: '2025 - 2026',
        bullets: ['Built reliable infrastructure for production traffic replay'],
      }],
      skills: [],
    };
    const contact = { full_name: 'Mehek Mandal' };
    const extracted = [
      'Mehek Mandal',
      'Traeco',
      'Software Engineer',
      '2025 - 2026',
      // pdf.js can join the wrapped line without the source space after "reliable".
      'Built reliableinfrastructure for production traffic replay',
    ].join('\n');

    assert.deepEqual(findPdfTextFidelityIssues(extracted, spec, contact), []);
  });

  test('PDF text fidelity still rejects a missing non-whitespace character', () => {
    const spec = {
      school: '',
      degree: '',
      grad_date: '',
      coursework: '',
      experience: [{
        org: 'Traeco',
        title: 'Software Engineer',
        date_range: '2025 - 2026',
        bullets: ['Built reliable infrastructure for production traffic replay'],
      }],
      skills: [],
    };
    const contact = { full_name: 'Mehek Mandal' };
    const extracted = [
      'Mehek Mandal',
      'Traeco',
      'Software Engineer',
      '2025 - 2026',
      'Built reliable infrastructure for production trafic replay',
    ].join('\n');

    assert.ok(
      findPdfTextFidelityIssues(extracted, spec, contact)
        .includes('rendered PDF text does not faithfully preserve entry 1 bullet 1'),
    );
  });
});

describe('25-case rendered resume benchmark', () => {
  for (const benchmark of RESUME_VISUAL_BENCHMARK) {
    test(benchmark.id, async () => {
      const rendered = await renderResumePdf(
        benchmark.spec,
        benchmark.contact,
        benchmark.jdText,
      );
      const visual = validateResumeVisualLayout(rendered.layout);
      const parsed = await extractPdfText(rendered.buffer);
      const pdf = validatePdfLayout(parsed.text, parsed.numpages);

      assert.deepEqual(visual.issues, []);
      assert.deepEqual(pdf.issues, []);
      assert.deepEqual(
        findPdfTextFidelityIssues(parsed.text, rendered.spec, benchmark.contact),
        [],
      );
      assert.equal(rendered.layout.section_order.join('|'), rendered.layout.expected_section_order.join('|'));
      assert.ok(rendered.layout.bottom_whitespace >= 0);
      assert.ok(rendered.layout.fill_ratio <= 1);
      assert.ok(
        rendered.layout.bullets.every(
          (bullet) => bullet.lines <= RESUME_DESIGN.compact.limits.maxBulletLines,
        ),
      );

      const compact = measureResumeLayout(
        rendered.spec,
        benchmark.contact,
        resumeDesignAtExpansion(0),
      );
      if (compact.fill_ratio < RESUME_DESIGN.compact.density.sparseTriggerRatio) {
        assert.ok(rendered.layout.fill_ratio > compact.fill_ratio);
        assert.ok(rendered.layout.density_expansion > 0);
      }
    });
  }
});

describe('rendered PDF geometry regressions', () => {
  for (const id of [
    '04-sparse-two-short-jobs',
    '09-normal-all-sections',
    '24-dense-long-everything',
  ]) {
    test(id, async () => {
      const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === id);
      assert.ok(benchmark);
      const rendered = await renderResumePdf(benchmark.spec, benchmark.contact, benchmark.jdText);
      const pages = await renderedTextItems(rendered.buffer);
      assert.equal(pages.length, 1);

      const items = pages[0].filter((item) => item.text.trim().length > 0);
      const tolerance = 1;
      assert.ok(items.length > 0);
      const baselines = [...new Set(items.map((item) => Number(item.y.toFixed(1))))].sort(
        (a, b) => b - a,
      );
      assert.deepEqual(baselines, RENDERED_BASELINE_SNAPSHOTS[id]);
      assert.ok(items.every((item) => item.x >= rendered.layout.margin - tolerance));
      assert.ok(
        items.every(
          (item) =>
            item.x + item.width <=
            rendered.layout.page_width - rendered.layout.margin + tolerance,
        ),
      );

      const sectionBaselines = rendered.layout.section_order
        .filter((section) => section !== 'HEADER')
        .map((section) => {
          const item = items.find((candidate) => candidate.text === section);
          assert.ok(item, `missing rendered ${section} heading`);
          return item.y;
        });
      assert.deepEqual(sectionBaselines, [...sectionBaselines].sort((a, b) => b - a));

      const lowestGlyphBottom = Math.min(...items.map((item) => item.y - item.height));
      const renderedBottomWhitespace = lowestGlyphBottom - rendered.layout.margin;
      assert.ok(renderedBottomWhitespace >= -tolerance);
      assert.ok(
        Math.abs(renderedBottomWhitespace - rendered.layout.bottom_whitespace) <= 18,
        `rendered bottom whitespace ${renderedBottomWhitespace.toFixed(1)}pt differs from planned ${rendered.layout.bottom_whitespace.toFixed(1)}pt`,
      );
    });
  }
});
