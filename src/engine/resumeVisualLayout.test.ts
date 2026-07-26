import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import pdfParse from 'pdf-parse';
import { extractPdfText } from '../lib/pdfText';
import { RESUME_CONTENT_LIMITS } from './resumeContentPolicy';
import { validatePdfLayout } from './resumeValidate';
import { RESUME_DESIGN, resumeDesignAtExpansion } from './resumeDesign';
import {
  measureResumeLayout,
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
 * Last regenerated 2026-07-26, for the header rule between the name and the contact line. The
 * signature of that change is visible in the numbers and is what made them safe to accept: the
 * FIRST baseline (the name) is untouched in all three cases, and every baseline below it moves
 * down by the same ~4pt, which is the rule's stroke plus a contactTop gap either side of it. A
 * change that shifted only some rows, or shifted them by differing amounts, would have meant
 * something reflowed rather than translated, and would not have been snapshot drift at all.
 */
const RENDERED_BASELINE_SNAPSHOTS: Record<string, number[]> = {
  '04-sparse-two-short-jobs': [
    737.3, 710, 660.8, 634, 615.1, 573.9, 547.1, 528.3, 507.1, 485.7, 453.3,
    434.5, 413.3, 391.9, 350.5, 323.6,
  ],
  '09-normal-all-sections': [
    737.6, 711.2, 664.6, 638.6, 620.2, 602.4, 562.9, 536.8, 518.5, 498, 484.7,
    464, 450.8, 411.2, 385.2, 366.8, 346.3, 333, 312.4, 299.1, 259.5, 233.5,
    215.1, 194.6, 181.4, 160.7, 147.4, 107.9, 81.8,
  ],
  '24-dense-long-everything': [
    741.2, 723.2, 712.4, 690.9, 672.6, 658.7, 645.5, 633.5, 612, 593.6, 579.8,
    566.2, 554.3, 540.4, 528.5, 514.7, 502.8, 485.8, 472, 458.4, 446.4, 432.6,
    420.7, 406.9, 395, 373.4, 355.1, 341.2, 327.6, 315.7, 301.9, 289.9, 276.1,
    264.2, 242.6, 224.3, 210.5, 196.8, 184.9, 171.1, 159.2, 145.4, 133.4,
    111.9, 93.5, 81.6,
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
      /* Updated 2026-07-27 for the page-fill change. The headline number is bottom_whitespace:
       * 297.7pt of empty page became 43.2pt, which is the whole point of the change. This resume
       * now expands to 0.919 and lands at the 0.94 target instead of shipping compact at 0.586.
       * Section heights all grow because the spacing scale grew; the order is unchanged and no
       * bullet crossed the two-line limit. */
      {
        body_font_size: 11.9,
        density_expansion: 0.919,
        fill_ratio: 0.94,
        bottom_whitespace: 43.2,
        section_order: ['HEADER', 'EDUCATION', 'EXPERIENCE', 'PROJECTS', 'LEADERSHIP', 'SKILLS'],
        sections: [
          { name: 'HEADER', top: 36, bottom: 103.8, height: 67.8 },
          { name: 'EDUCATION', top: 103.8, bottom: 192.2, height: 88.4 },
          { name: 'EXPERIENCE', top: 192.2, bottom: 343.9, height: 151.7 },
          { name: 'PROJECTS', top: 343.9, bottom: 495.6, height: 151.7 },
          { name: 'LEADERSHIP', top: 495.6, bottom: 647.2, height: 151.7 },
          { name: 'SKILLS', top: 647.2, bottom: 712.8, height: 65.6 },
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

  test('target role headline renders, wraps safely, and remains ATS-readable', async () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.target_role = 'Senior Analytics Engineering and Data Governance Lead for Global Operations';
    const rendered = await renderResumePdf(spec, benchmark.contact, benchmark.jdText);
    const parsed = await extractPdfText(rendered.buffer);

    assert.equal(parsed.numpages, 1);
    assert.match(parsed.text.replace(/\s+/g, ' '), /Senior Analytics Engineering and Data Governance Lead for Global Operations/);
    assert.deepEqual(validateResumeVisualLayout(rendered.layout).issues, []);
    assert.deepEqual(validatePdfLayout(parsed.text, parsed.numpages).issues, []);
    assert.deepEqual(findPdfTextFidelityIssues(parsed.text, rendered.spec, benchmark.contact), []);
  });

  test('PDF fidelity rejects a missing target role headline', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = { ...benchmark.spec, target_role: 'Analytics Engineer' };
    const issues = findPdfTextFidelityIssues('Candidate Name EDUCATION EXPERIENCE', spec, benchmark.contact);
    assert.ok(issues.includes('rendered PDF text does not faithfully preserve target role headline'));
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
