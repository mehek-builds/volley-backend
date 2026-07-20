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

const RENDERED_BASELINE_SNAPSHOTS: Record<string, number[]> = {
  '04-sparse-two-short-jobs': [
    739.1, 720.7, 688.1, 664.9, 648.6, 620, 596.7, 580.4, 563.8, 547, 524.1,
    507.9, 491.2, 474.4, 445.5, 422.3,
  ],
  '09-normal-all-sections': [
    741.7, 727.1, 709.6, 692.5, 679.4, 666.8, 648.1, 631, 617.9, 605.3, 593.6,
    580.9, 569.2, 550.5, 533.4, 520.3, 507.7, 496, 483.3, 471.6, 452.8, 435.7,
    422.6, 410.1, 398.4, 385.6, 373.9, 355.2, 338.1,
  ],
  '24-dense-long-everything': [
    741.7, 727.1, 716.5, 699, 681.9, 668.8, 656.2, 644.5, 625.8, 608.7, 595.6,
    583, 571.3, 558.6, 546.9, 534.2, 522.4, 507.7, 494.6, 482.1, 470.3, 457.6,
    445.9, 433.2, 421.5, 402.8, 385.7, 372.5, 360, 348.3, 335.6, 323.8, 311.1,
    299.4, 280.7, 263.6, 250.5, 237.9, 226.2, 213.5, 201.8, 189.1, 177.3,
    158.6, 141.5, 129.8,
  ],
};

describe('resume visual layout controls', () => {
  test('the benchmark contains exactly 25 named layouts', () => {
    assert.equal(RESUME_VISUAL_BENCHMARK.length, 25);
    assert.equal(new Set(RESUME_VISUAL_BENCHMARK.map((entry) => entry.id)).size, 25);
    assert.equal(RESUME_DESIGN.compact.density.sparseTriggerRatio, 0.5);
    assert.equal(RESUME_DESIGN.compact.density.targetFillRatio, 0.66);
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

  test('sparse expansion stops near the target fill when full expansion would exceed it', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '06-normal-two-jobs');
    assert.ok(benchmark);
    const spec = structuredClone(benchmark.spec);
    spec.skills.push(...Array.from({ length: 5 }, (_, index) => `Skill${index}`));

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

    assert.ok(compact.fill_ratio < RESUME_DESIGN.compact.density.sparseTriggerRatio);
    assert.ok(spacious.fill_ratio > RESUME_DESIGN.compact.density.targetFillRatio);
    assert.ok(plan.layout.density_expansion > 0);
    assert.ok(plan.layout.density_expansion < 1);
    assert.ok(
      Math.abs(plan.layout.fill_ratio - RESUME_DESIGN.compact.density.targetFillRatio) < 0.002,
    );
  });

  test('normal resumes retain the compact design', () => {
    const benchmark = RESUME_VISUAL_BENCHMARK.find((entry) => entry.id === '09-normal-all-sections');
    assert.ok(benchmark);
    const compact = measureResumeLayout(
      benchmark.spec,
      benchmark.contact,
      resumeDesignAtExpansion(0),
    );
    const plan = planResumeLayout(benchmark.spec, benchmark.contact, benchmark.jdText);

    assert.ok(compact.fill_ratio >= RESUME_DESIGN.compact.density.sparseTriggerRatio);
    assert.equal(plan.layout.density_expansion, 0);
    assert.equal(plan.layout.body_font_size, RESUME_DESIGN.compact.typography.body);
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
      {
        body_font_size: 10.5,
        density_expansion: 0,
        fill_ratio: 0.584,
        bottom_whitespace: 299.7,
        section_order: ['HEADER', 'EDUCATION', 'EXPERIENCE', 'PROJECTS', 'LEADERSHIP', 'SKILLS'],
        sections: [
          { name: 'HEADER', top: 36, bottom: 71.1, height: 35.1 },
          { name: 'EDUCATION', top: 71.1, bottom: 127.5, height: 56.5 },
          { name: 'EXPERIENCE', top: 127.5, bottom: 225.2, height: 97.6 },
          { name: 'PROJECTS', top: 225.2, bottom: 322.8, height: 97.6 },
          { name: 'LEADERSHIP', top: 322.8, bottom: 420.4, height: 97.6 },
          { name: 'SKILLS', top: 420.4, bottom: 456.3, height: 35.8 },
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
