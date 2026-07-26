import PDFDocument from 'pdfkit';
import type { ResumeSpec } from '../llm/resumeSpec';
import { relevanceScore } from './resumePolicy';
import {
  RESUME_DESIGN,
  resumeDesignAtExpansion,
  type ResumeDesignTokens,
} from './resumeDesign';
import { RESUME_CONTENT_LIMITS, RESUME_FIT_FALLBACKS } from './resumeContentPolicy';

export interface ContactHeader {
  full_name: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
}

export type ResumeSectionName =
  | 'HEADER'
  | 'EDUCATION'
  | 'EXPERIENCE'
  | 'PROJECTS'
  | 'LEADERSHIP'
  | 'SKILLS';

export interface ResumeSectionMetrics {
  name: ResumeSectionName;
  top: number;
  bottom: number;
  height: number;
}

export interface ResumeBulletMetrics {
  section: ResumeSectionName;
  entry_index: number;
  bullet_index: number;
  lines: number;
}

export interface ResumeVisualLayout {
  page_width: number;
  page_height: number;
  margin: number;
  usable_width: number;
  usable_height: number;
  content_top: number;
  content_bottom: number;
  content_height: number;
  bottom_whitespace: number;
  fill_ratio: number;
  density_expansion: number;
  body_font_size: number;
  expected_section_order: ResumeSectionName[];
  section_order: ResumeSectionName[];
  sections: ResumeSectionMetrics[];
  bullets: ResumeBulletMetrics[];
}

export interface ResumeVisualValidation {
  issues: string[];
  warnings: string[];
}

export interface ResumeLayoutPlan {
  spec: ResumeSpec;
  omissions: string[];
  trimmed: boolean;
  sparse: boolean;
  estimated_height: number;
  design: ResumeDesignTokens;
  layout: ResumeVisualLayout;
}

type ResumeEntry = ResumeSpec['experience'][number];
const LAYOUT_SEARCH_ITERATIONS = 12;
const RESUME_FONTS = {
  regular: 'LitosTinosRegular',
  bold: 'LitosTinosBold',
  italic: 'LitosTinosItalic',
} as const;
const RESUME_FONT_PATHS = {
  regular: require.resolve('@expo-google-fonts/tinos/400Regular/Tinos_400Regular.ttf'),
  bold: require.resolve('@expo-google-fonts/tinos/700Bold/Tinos_700Bold.ttf'),
  italic: require.resolve(
    '@expo-google-fonts/tinos/400Regular_Italic/Tinos_400Regular_Italic.ttf',
  ),
} as const;

function contactLine(contact: ContactHeader): string {
  return [contact.email, contact.phone, contact.linkedin_url, contact.github_url, contact.portfolio_url]
    .filter(Boolean)
    .join(' | ');
}

function normalizedPdfText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function occurrenceCount(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

export function findPdfTextFidelityIssues(
  extractedText: string,
  spec: ResumeSpec,
  contact: ContactHeader,
): string[] {
  const rendered = normalizedPdfText(extractedText);
  // pdf.js may omit or insert whitespace where PDFKit wraps a text run across lines. That is a
  // text-extraction artifact, not lost resume content. Production resumes were being rejected
  // whenever one otherwise intact bullet wrapped at exactly such a boundary. Compare every
  // expected field without whitespace while still requiring the same characters, order, and
  // occurrence count. Unsupported or missing glyphs still fail closed.
  const renderedWithoutWhitespace = rendered.replace(/\s+/g, '');
  const expected: Array<{ label: string; value: string | undefined }> = [
    { label: 'header name', value: contact.full_name },
    { label: 'target role headline', value: spec.target_role },
    { label: 'contact email', value: contact.email },
    { label: 'contact phone', value: contact.phone },
    { label: 'LinkedIn URL', value: contact.linkedin_url },
    { label: 'GitHub URL', value: contact.github_url },
    { label: 'portfolio URL', value: contact.portfolio_url },
    { label: 'education school', value: spec.school },
    { label: 'education degree', value: spec.degree },
    { label: 'graduation date', value: spec.grad_date },
    { label: 'coursework', value: spec.coursework },
    ...spec.experience.flatMap((entry, entryIndex) => [
      { label: `entry ${entryIndex + 1} organization`, value: entry.org },
      { label: `entry ${entryIndex + 1} title`, value: entry.title },
      { label: `entry ${entryIndex + 1} date`, value: entry.date_range },
      ...entry.bullets.map((bullet, bulletIndex) => ({
        label: `entry ${entryIndex + 1} bullet ${bulletIndex + 1}`,
        value: bullet,
      })),
    ]),
    ...spec.skills.map((skill, skillIndex) => ({
      label: `skill ${skillIndex + 1}`,
      value: skill,
    })),
  ];

  const presentExpected = expected
    .filter(({ value }) => Boolean(value?.trim()))
    .map(({ label, value }) => ({ label, normalized: normalizedPdfText(value ?? '') }));

  return presentExpected
    .filter(({ label, normalized }) => {
      const target = normalized.replace(/\s+/g, '');
      if (label === 'header name' && !renderedWithoutWhitespace.startsWith(target)) return true;

      const actualOccurrences = occurrenceCount(renderedWithoutWhitespace, target);
      const expectedOccurrences = presentExpected.reduce((total, item) => {
        const expectedText = item.normalized.replace(/\s+/g, '');
        return total + occurrenceCount(expectedText, target);
      }, 0);

      return actualOccurrences < expectedOccurrences;
    })
    .map(({ label }) => `rendered PDF text does not faithfully preserve ${label}`);
}

function educationPosition(spec: ResumeSpec): NonNullable<ResumeSpec['education_position']> {
  return spec.education_position ?? 'top';
}

function entriesFor(spec: ResumeSpec, type: NonNullable<ResumeEntry['type']>): ResumeEntry[] {
  return spec.experience.filter((entry) => (entry.type ?? 'job') === type);
}

function usableWidth(design: ResumeDesignTokens): number {
  return design.page.width - design.page.margin * 2;
}

function usableHeight(design: ResumeDesignTokens): number {
  return design.page.height - design.page.margin * 2;
}

function createResumeDocument(design: ResumeDesignTokens): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    margin: design.page.margin,
    bufferPages: true,
    size: [design.page.width, design.page.height],
  });
  doc.registerFont(RESUME_FONTS.regular, RESUME_FONT_PATHS.regular);
  doc.registerFont(RESUME_FONTS.bold, RESUME_FONT_PATHS.bold);
  doc.registerFont(RESUME_FONTS.italic, RESUME_FONT_PATHS.italic);
  return doc;
}

function textHeight(
  doc: PDFKit.PDFDocument,
  text: string,
  font: string,
  size: number,
  width: number,
  lineGapRatio: number,
): number {
  return doc.font(font).fontSize(size).heightOfString(text, {
    width,
    lineGap: size * lineGapRatio,
  });
}

function textLines(
  doc: PDFKit.PDFDocument,
  text: string,
  font: string,
  size: number,
  width: number,
  lineGapRatio: number,
): number {
  const height = textHeight(doc, text, font, size, width, lineGapRatio);
  const lineHeight =
    doc.font(font).fontSize(size).currentLineHeight(true) + size * lineGapRatio;
  return Math.max(1, Math.ceil((height - 0.01) / lineHeight));
}

function hasEducation(spec: ResumeSpec): boolean {
  return Boolean(spec.school || spec.degree || spec.grad_date || spec.coursework);
}

type ResumeContentBlock =
  | { kind: 'education'; name: 'EDUCATION'; topGap: number }
  | {
      kind: 'entries';
      name: 'EXPERIENCE' | 'PROJECTS' | 'LEADERSHIP';
      entries: ResumeEntry[];
      topGap: number;
    }
  | { kind: 'skills'; name: 'SKILLS'; topGap: number };

function resumeContentBlocks(
  spec: ResumeSpec,
  design: ResumeDesignTokens,
): ResumeContentBlock[] {
  const blocks: ResumeContentBlock[] = [];
  if (educationPosition(spec) === 'top' && hasEducation(spec)) {
    blocks.push({ kind: 'education', name: 'EDUCATION', topGap: design.spacing.educationTop });
  }

  const entrySections = [
    { name: 'EXPERIENCE' as const, entries: entriesFor(spec, 'job') },
    { name: 'PROJECTS' as const, entries: entriesFor(spec, 'project') },
    { name: 'LEADERSHIP' as const, entries: entriesFor(spec, 'leadership') },
  ];
  for (const section of entrySections) {
    if (section.entries.length > 0) {
      blocks.push({
        kind: 'entries',
        name: section.name,
        entries: section.entries,
        topGap: design.spacing.sectionTop,
      });
    }
  }

  if (educationPosition(spec) === 'after_experience' && hasEducation(spec)) {
    blocks.push({ kind: 'education', name: 'EDUCATION', topGap: design.spacing.sectionTop });
  }
  if (spec.skills.length > 0) {
    blocks.push({ kind: 'skills', name: 'SKILLS', topGap: design.spacing.sectionTop });
  }
  return blocks;
}

function expectedSectionOrder(spec: ResumeSpec): ResumeSectionName[] {
  return [
    'HEADER',
    ...resumeContentBlocks(spec, RESUME_DESIGN.compact).map((block) => block.name),
  ];
}

function sectionHeaderHeight(
  doc: PDFKit.PDFDocument,
  title: ResumeSectionName,
  topGap: number,
  design: ResumeDesignTokens,
): number {
  return (
    topGap +
    textHeight(
      doc,
      title,
      RESUME_FONTS.bold,
      design.typography.section,
      usableWidth(design),
      design.typography.lineGapRatio.bold,
    ) +
    design.spacing.sectionRuleBefore +
    design.spacing.sectionRuleAfter
  );
}

function splitLineHeight(
  doc: PDFKit.PDFDocument,
  left: string,
  right: string,
  design: ResumeDesignTokens,
): number {
  const width = usableWidth(design);
  return Math.max(
    textHeight(
      doc,
      left,
      RESUME_FONTS.bold,
      design.typography.body,
      width * design.geometry.splitLeftRatio,
      design.typography.lineGapRatio.bold,
    ),
    textHeight(
      doc,
      right,
      RESUME_FONTS.regular,
      design.typography.body,
      width * design.geometry.splitRightRatio,
      design.typography.lineGapRatio.regular,
    ),
  );
}

function educationHeight(
  doc: PDFKit.PDFDocument,
  spec: ResumeSpec,
  topGap: number,
  design: ResumeDesignTokens,
): number {
  if (!hasEducation(spec)) return 0;
  const width = usableWidth(design);
  let height = sectionHeaderHeight(doc, 'EDUCATION', topGap, design);
  height += splitLineHeight(doc, spec.school, spec.grad_date, design);
  if (spec.degree) {
    height +=
      design.spacing.detailTop +
      textHeight(
        doc,
        spec.degree,
        RESUME_FONTS.italic,
        design.typography.body,
        width,
        design.typography.lineGapRatio.italic,
      );
  }
  if (spec.coursework) {
    height +=
      design.spacing.detailTop +
      textHeight(
        doc,
        `Relevant coursework: ${spec.coursework}`,
        RESUME_FONTS.regular,
        design.typography.body,
        width,
        design.typography.lineGapRatio.regular,
      );
  }
  return height;
}

function entryHeight(
  doc: PDFKit.PDFDocument,
  entry: ResumeEntry,
  gapBefore: number,
  design: ResumeDesignTokens,
  bullets: ResumeBulletMetrics[],
  section: ResumeSectionName,
  entryIndex: number,
): number {
  const width = usableWidth(design);
  let height = gapBefore + splitLineHeight(doc, entry.org, entry.date_range, design);
  if (entry.title) {
    height +=
      design.spacing.detailTop +
      textHeight(
        doc,
        entry.title,
        RESUME_FONTS.italic,
        design.typography.body,
        width,
        design.typography.lineGapRatio.italic,
      );
  }
  for (let bulletIndex = 0; bulletIndex < entry.bullets.length; bulletIndex += 1) {
    const bullet = entry.bullets[bulletIndex];
    const rendered = `•  ${bullet}`;
    const bulletWidth = width - design.spacing.bulletIndent;
    height +=
      design.spacing.bulletTop +
      textHeight(
        doc,
        rendered,
        RESUME_FONTS.regular,
        design.typography.body,
        bulletWidth,
        design.typography.lineGapRatio.regular,
      );
    bullets.push({
      section,
      entry_index: entryIndex,
      bullet_index: bulletIndex,
      lines: textLines(
        doc,
        rendered,
        RESUME_FONTS.regular,
        design.typography.body,
        bulletWidth,
        design.typography.lineGapRatio.regular,
      ),
    });
  }
  return height;
}

function entrySectionHeight(
  doc: PDFKit.PDFDocument,
  title: ResumeSectionName,
  entries: ResumeEntry[],
  topGap: number,
  design: ResumeDesignTokens,
  bullets: ResumeBulletMetrics[],
): number {
  if (entries.length === 0) return 0;
  return (
    sectionHeaderHeight(doc, title, topGap, design) +
    entries.reduce(
      (sum, entry, index) =>
        sum +
        entryHeight(
          doc,
          entry,
          index === 0 ? 0 : design.spacing.entryTop,
          design,
          bullets,
          title,
          index,
        ),
      0,
    )
  );
}

export function measureResumeLayout(
  spec: ResumeSpec,
  contact: ContactHeader,
  design = resumeDesignAtExpansion(0),
  densityExpansion = 0,
  measurementDocument?: PDFKit.PDFDocument,
): ResumeVisualLayout {
  const doc = measurementDocument ?? createResumeDocument(design);
  try {
    const width = usableWidth(design);
    const height = usableHeight(design);
    const sections: ResumeSectionMetrics[] = [];
    const bullets: ResumeBulletMetrics[] = [];
    let cursor = design.page.margin;

    const pushSection = (name: ResumeSectionName, blockHeight: number) => {
      if (blockHeight <= 0) return;
      const top = cursor;
      cursor += blockHeight;
      sections.push({ name, top, bottom: cursor, height: blockHeight });
    };

    let headerHeight = textHeight(
      doc,
      contact.full_name,
      RESUME_FONTS.bold,
      design.typography.name,
      width,
      design.typography.lineGapRatio.bold,
    );
    if (spec.target_role) {
      headerHeight +=
        design.spacing.contactTop +
        textHeight(
          doc,
          spec.target_role,
          RESUME_FONTS.bold,
          design.typography.contact,
          width,
          design.typography.lineGapRatio.bold,
        );
    }
    const line = contactLine(contact);
    if (line) {
      headerHeight +=
        // The gap above the name/contact rule, then the gap below it. Mirrors the draw path term
        // for term, which is the only way this stays correct: the layout planner decides how much
        // room the body gets from this number, so a header that measures short pushes the last
        // section off the page at render time.
        //
        // The rule's own stroke width is deliberately NOT counted. A stroke is painted centred on
        // its baseline and never advances doc.y, so charging the header for it would make the
        // planner and the renderer disagree by 0.65pt on every resume.
        design.spacing.contactTop +
        design.spacing.contactTop +
        textHeight(
          doc,
          line,
          RESUME_FONTS.regular,
          design.typography.contact,
          width,
          design.typography.lineGapRatio.regular,
        );
    }
    headerHeight += design.spacing.headerBottom;
    pushSection('HEADER', headerHeight);

    for (const block of resumeContentBlocks(spec, design)) {
      if (block.kind === 'education') {
        pushSection(block.name, educationHeight(doc, spec, block.topGap, design));
      } else if (block.kind === 'entries') {
        pushSection(
          block.name,
          entrySectionHeight(doc, block.name, block.entries, block.topGap, design, bullets),
        );
      } else {
        pushSection(
          block.name,
          sectionHeaderHeight(doc, block.name, block.topGap, design) +
            textHeight(
              doc,
              spec.skills.join(' • '),
              RESUME_FONTS.regular,
              design.typography.body,
              width,
              design.typography.lineGapRatio.regular,
            ),
        );
      }
    }

    const contentHeight = cursor - design.page.margin;
    return {
      page_width: design.page.width,
      page_height: design.page.height,
      margin: design.page.margin,
      usable_width: width,
      usable_height: height,
      content_top: design.page.margin,
      content_bottom: cursor,
      content_height: contentHeight,
      bottom_whitespace: design.page.height - design.page.margin - cursor,
      fill_ratio: contentHeight / height,
      density_expansion: densityExpansion,
      body_font_size: design.typography.body,
      expected_section_order: expectedSectionOrder(spec),
      section_order: sections.map((section) => section.name),
      sections,
      bullets,
    };
  } finally {
    if (!measurementDocument) doc.destroy();
  }
}

export function estimateResumeHeight(
  spec: ResumeSpec,
  contact: ContactHeader,
  design = resumeDesignAtExpansion(0),
  measurementDocument?: PDFKit.PDFDocument,
): number {
  return measureResumeLayout(spec, contact, design, 0, measurementDocument).content_height;
}

function lowestValueBullet(
  spec: ResumeSpec,
  jdText: string,
  minimum: number,
): { entryIndex: number; bulletIndex: number } | null {
  let lowest: { entryIndex: number; bulletIndex: number; score: number } | null = null;
  spec.experience.forEach((entry, entryIndex) => {
    if (entry.bullets.length <= minimum) return;
    entry.bullets.forEach((bullet, bulletIndex) => {
      const score = relevanceScore(bullet, jdText);
      if (!lowest || score < lowest.score) lowest = { entryIndex, bulletIndex, score };
    });
  });
  return lowest;
}

function entryValue(entry: ResumeEntry, jdText: string): number {
  return relevanceScore([entry.org, entry.title, ...entry.bullets].join(' '), jdText);
}

function removeBullet(
  spec: ResumeSpec,
  choice: { entryIndex: number; bulletIndex: number },
  omissions: string[],
): ResumeSpec {
  const experience = [...spec.experience];
  const entry = experience[choice.entryIndex];
  const bullets = [...entry.bullets];
  const [removed] = bullets.splice(choice.bulletIndex, 1);
  experience[choice.entryIndex] = { ...entry, bullets };
  omissions.push(`Removed a lower-fit bullet from ${entry.org}: ${removed}`);
  return { ...spec, experience };
}

function removeLowestEntry(spec: ResumeSpec, jdText: string, omissions: string[]): ResumeSpec {
  let index = 0;
  for (let i = 1; i < spec.experience.length; i += 1) {
    if (entryValue(spec.experience[i], jdText) < entryValue(spec.experience[index], jdText)) index = i;
  }
  const experience = [...spec.experience];
  const [removed] = experience.splice(index, 1);
  omissions.push(`Removed lower-fit ${removed.type ?? 'experience'} entry: ${removed.org}`);
  return { ...spec, experience };
}

function layoutAcceptsExpansion(layout: ResumeVisualLayout, design: ResumeDesignTokens): boolean {
  return (
    layout.fill_ratio <= design.density.maximumFillRatio &&
    layout.bullets.every((bullet) => bullet.lines <= design.limits.maxBulletLines)
  );
}

function selectSparseDesign(
  spec: ResumeSpec,
  contact: ContactHeader,
  measurementDocument: PDFKit.PDFDocument,
): { design: ResumeDesignTokens; layout: ResumeVisualLayout } {
  const compact = resumeDesignAtExpansion(0);
  const compactLayout = measureResumeLayout(spec, contact, compact, 0, measurementDocument);
  // expandBelowRatio, NOT sparseTriggerRatio. These were the same 0.5 constant, which meant any
  // resume filling half the page returned compact here and was never expanded - measured across
  // five real resumes, that was all of them, at 0.675 to 0.720 fill. sparseTriggerRatio's job is
  // to decide when to WARN that a resume is too thin; deciding when to expand is a different
  // question with a different answer.
  if (compactLayout.fill_ratio >= compact.density.expandBelowRatio) {
    return { design: compact, layout: compactLayout };
  }

  let validLow = 0;
  let invalidHigh = 1;
  const spacious = resumeDesignAtExpansion(1);
  const spaciousLayout = measureResumeLayout(spec, contact, spacious, 1, measurementDocument);
  if (layoutAcceptsExpansion(spaciousLayout, spacious)) {
    validLow = 1;
  } else {
    for (let step = 0; step < LAYOUT_SEARCH_ITERATIONS; step += 1) {
      const middle = (validLow + invalidHigh) / 2;
      const design = resumeDesignAtExpansion(middle);
      const layout = measureResumeLayout(spec, contact, design, middle, measurementDocument);
      if (layoutAcceptsExpansion(layout, design)) validLow = middle;
      else invalidHigh = middle;
    }
  }

  const maximumDesign = resumeDesignAtExpansion(validLow);
  const maximumLayout = measureResumeLayout(
    spec,
    contact,
    maximumDesign,
    validLow,
    measurementDocument,
  );
  if (maximumLayout.fill_ratio <= compact.density.targetFillRatio) {
    return { design: maximumDesign, layout: maximumLayout };
  }

  let low = 0;
  let high = validLow;
  for (let step = 0; step < LAYOUT_SEARCH_ITERATIONS; step += 1) {
    const middle = (low + high) / 2;
    const design = resumeDesignAtExpansion(middle);
    const layout = measureResumeLayout(spec, contact, design, middle, measurementDocument);
    if (layout.fill_ratio < compact.density.targetFillRatio) low = middle;
    else high = middle;
  }
  const expansion = high;
  const design = resumeDesignAtExpansion(expansion);
  return {
    design,
    layout: measureResumeLayout(spec, contact, design, expansion, measurementDocument),
  };
}

export function findResumeTypographyIssues(spec: ResumeSpec, contact: ContactHeader): string[] {
  const design = RESUME_DESIGN.compact;
  return measureResumeLayout(spec, contact, design).bullets
    .filter((bullet) => bullet.lines > design.limits.maxBulletLines)
    .map(
      (bullet) =>
        `${bullet.section} entry ${bullet.entry_index + 1}, bullet ${bullet.bullet_index + 1} renders as ${bullet.lines} lines (max ${design.limits.maxBulletLines})`,
    );
}

export function validateResumeVisualLayout(layout: ResumeVisualLayout): ResumeVisualValidation {
  const design = RESUME_DESIGN.compact;
  const issues: string[] = [];
  const warnings: string[] = [];
  const pageBottom = layout.page_height - layout.margin;

  if (layout.content_bottom > pageBottom + 0.1) {
    issues.push(`layout clips ${Math.ceil(layout.content_bottom - pageBottom)}pt below the usable page`);
  }
  if (layout.fill_ratio > design.density.maximumFillRatio + 0.001) {
    issues.push(`layout fills ${Math.round(layout.fill_ratio * 100)}% of usable height (max 100%)`);
  }
  if (layout.section_order.join('|') !== layout.expected_section_order.join('|')) {
    issues.push(
      `section order is ${layout.section_order.join(' > ')} (expected ${layout.expected_section_order.join(' > ')})`,
    );
  }
  for (let index = 1; index < layout.sections.length; index += 1) {
    const previous = layout.sections[index - 1];
    const current = layout.sections[index];
    if (current.top < previous.bottom - 0.1) {
      issues.push(`${current.name} overlaps ${previous.name}`);
    }
  }
  for (const bullet of layout.bullets) {
    if (bullet.lines > design.limits.maxBulletLines) {
      issues.push(
        `${bullet.section} entry ${bullet.entry_index + 1}, bullet ${bullet.bullet_index + 1} renders as ${bullet.lines} lines (max ${design.limits.maxBulletLines})`,
      );
    }
  }
  if (layout.body_font_size < design.typography.body) {
    issues.push(`body font is ${layout.body_font_size.toFixed(2)}pt (minimum ${design.typography.body}pt)`);
  }
  if (layout.fill_ratio < design.density.sparseTriggerRatio) {
    warnings.push(
      `resume remains sparse at ${Math.round(layout.fill_ratio * 100)}% page fill after safe layout expansion`,
    );
  }

  return { issues, warnings };
}

export function planResumeLayout(
  rawSpec: ResumeSpec,
  contact: ContactHeader,
  jdText: string,
): ResumeLayoutPlan {
  const compact = RESUME_DESIGN.compact;
  const omissions: string[] = [];
  let spec = rawSpec;
  const measurementDocument = createResumeDocument(compact);
  try {
    while (true) {
      const excessBullet = lowestValueBullet(
        spec,
        jdText,
        RESUME_CONTENT_LIMITS.maxBulletsPerEntry,
      );
      if (!excessBullet) break;
      spec = removeBullet(spec, excessBullet, omissions);
    }
    if (spec.experience.length > RESUME_CONTENT_LIMITS.maxEntries) {
      const ranked = spec.experience
        .map((entry) => ({ entry, score: entryValue(entry, jdText) }))
        .sort((a, b) => b.score - a.score);
      for (const removed of ranked.slice(RESUME_CONTENT_LIMITS.maxEntries)) {
        omissions.push(`Removed lower-fit ${removed.entry.type ?? 'experience'} entry: ${removed.entry.org}`);
      }
      spec = {
        ...spec,
        experience: ranked.slice(0, RESUME_CONTENT_LIMITS.maxEntries).map(({ entry }) => entry),
      };
    }
    let guard = 0;

    while (
      estimateResumeHeight(spec, contact, compact, measurementDocument) > usableHeight(compact) &&
      guard < RESUME_FIT_FALLBACKS.maxTrimSteps
    ) {
      guard += 1;
      const thirdBullet = lowestValueBullet(
        spec,
        jdText,
        RESUME_CONTENT_LIMITS.minBulletsPerEntry,
      );
      if (thirdBullet) {
        spec = removeBullet(spec, thirdBullet, omissions);
        continue;
      }
      if (spec.experience.length > RESUME_FIT_FALLBACKS.preferredMinimumEntries) {
        spec = removeLowestEntry(spec, jdText, omissions);
        continue;
      }
      if (spec.coursework) {
        omissions.push('Removed coursework after stronger job-matched evidence was retained');
        spec = { ...spec, coursework: '' };
        continue;
      }
      if (spec.skills.length > RESUME_FIT_FALLBACKS.preferredMinimumSkills) {
        const removed = spec.skills[spec.skills.length - 1];
        omissions.push(`Removed lower-fit skill: ${removed}`);
        spec = { ...spec, skills: spec.skills.slice(0, -1) };
        continue;
      }
      const secondBullet = lowestValueBullet(
        spec,
        jdText,
        RESUME_FIT_FALLBACKS.emergencyMinimumBullets,
      );
      if (secondBullet) {
        spec = removeBullet(spec, secondBullet, omissions);
        continue;
      }
      if (spec.experience.length > 1) {
        spec = removeLowestEntry(spec, jdText, omissions);
        continue;
      }
      if (spec.skills.length > 0) {
        const removed = spec.skills[spec.skills.length - 1];
        omissions.push(`Removed lower-fit skill: ${removed}`);
        spec = { ...spec, skills: spec.skills.slice(0, -1) };
        continue;
      }
      break;
    }

    const selected = selectSparseDesign(spec, contact, measurementDocument);
    return {
      spec,
      omissions,
      trimmed: omissions.length > 0,
      sparse: selected.layout.fill_ratio < compact.density.sparseTriggerRatio,
      estimated_height: selected.layout.content_height,
      design: selected.design,
      layout: selected.layout,
    };
  } finally {
    measurementDocument.destroy();
  }
}

function drawSectionHeader(
  doc: PDFKit.PDFDocument,
  title: ResumeSectionName,
  topGap: number,
  design: ResumeDesignTokens,
) {
  const width = usableWidth(design);
  doc.y += topGap;
  doc
    .font(RESUME_FONTS.bold)
    .fontSize(design.typography.section)
    .text(title, design.page.margin, doc.y, {
      width,
      lineGap: design.typography.section * design.typography.lineGapRatio.bold,
    });
  const ruleY = doc.y + design.spacing.sectionRuleBefore;
  doc
    .moveTo(design.page.margin, ruleY)
    .lineTo(design.page.margin + width, ruleY)
    .lineWidth(design.geometry.sectionRuleWidth)
    .stroke();
  doc.y = ruleY + design.spacing.sectionRuleAfter;
}

function drawSplitLine(
  doc: PDFKit.PDFDocument,
  left: string,
  right: string,
  gapBefore: number,
  design: ResumeDesignTokens,
) {
  const width = usableWidth(design);
  doc.y += gapBefore;
  const y = doc.y;
  doc
    .font(RESUME_FONTS.bold)
    .fontSize(design.typography.body)
    .text(left, design.page.margin, y, {
      width: width * design.geometry.splitLeftRatio,
      lineGap: design.typography.body * design.typography.lineGapRatio.bold,
    });
  const leftBottom = doc.y;
  doc
    .font(RESUME_FONTS.regular)
    .fontSize(design.typography.body)
    .text(right, design.page.margin + width * (1 - design.geometry.splitRightRatio), y, {
      width: width * design.geometry.splitRightRatio,
      align: 'right',
      lineGap: design.typography.body * design.typography.lineGapRatio.regular,
    });
  doc.y = Math.max(leftBottom, doc.y);
}

function drawEducation(
  doc: PDFKit.PDFDocument,
  spec: ResumeSpec,
  topGap: number,
  design: ResumeDesignTokens,
) {
  if (!hasEducation(spec)) return;
  const width = usableWidth(design);
  drawSectionHeader(doc, 'EDUCATION', topGap, design);
  drawSplitLine(doc, spec.school, spec.grad_date, 0, design);
  if (spec.degree) {
    doc.y += design.spacing.detailTop;
    doc
      .font(RESUME_FONTS.italic)
      .fontSize(design.typography.body)
      .text(spec.degree, design.page.margin, doc.y, {
        width,
        lineGap: design.typography.body * design.typography.lineGapRatio.italic,
      });
  }
  if (spec.coursework) {
    doc.y += design.spacing.detailTop;
    doc
      .font(RESUME_FONTS.regular)
      .fontSize(design.typography.body)
      .text(`Relevant coursework: ${spec.coursework}`, design.page.margin, doc.y, {
        width,
        lineGap: design.typography.body * design.typography.lineGapRatio.regular,
      });
  }
}

function drawEntrySection(
  doc: PDFKit.PDFDocument,
  title: ResumeSectionName,
  entries: ResumeEntry[],
  topGap: number,
  design: ResumeDesignTokens,
) {
  if (entries.length === 0) return;
  const width = usableWidth(design);
  drawSectionHeader(doc, title, topGap, design);
  entries.forEach((entry, index) => {
    drawSplitLine(doc, entry.org, entry.date_range, index === 0 ? 0 : design.spacing.entryTop, design);
    if (entry.title) {
      doc.y += design.spacing.detailTop;
      doc
        .font(RESUME_FONTS.italic)
        .fontSize(design.typography.body)
        .text(entry.title, design.page.margin, doc.y, {
          width,
          lineGap: design.typography.body * design.typography.lineGapRatio.italic,
        });
    }
    for (const bullet of entry.bullets) {
      doc.y += design.spacing.bulletTop;
      doc
        .font(RESUME_FONTS.regular)
        .fontSize(design.typography.body)
        .text(`•  ${bullet}`, design.page.margin + design.spacing.bulletIndent, doc.y, {
          width: width - design.spacing.bulletIndent,
          lineGap: design.typography.body * design.typography.lineGapRatio.regular,
        });
    }
  });
}

export async function renderResumePdf(
  rawSpec: ResumeSpec,
  contact: ContactHeader,
  jdText = '',
): Promise<{
  buffer: Buffer;
  spec: ResumeSpec;
  omissions: string[];
  trimmed: boolean;
  sparse: boolean;
  layout: ResumeVisualLayout;
}> {
  const plan = planResumeLayout(rawSpec, contact, jdText);
  const { design, spec } = plan;
  const width = usableWidth(design);
  const doc = createResumeDocument(design);
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc
    .font(RESUME_FONTS.bold)
    .fontSize(design.typography.name)
    .text(contact.full_name, design.page.margin, design.page.margin, {
      width,
      align: 'center',
      lineGap: design.typography.name * design.typography.lineGapRatio.bold,
    });
  if (spec.target_role) {
    doc
      .font(RESUME_FONTS.bold)
      .fontSize(design.typography.contact)
      .text(spec.target_role, design.page.margin, doc.y + design.spacing.contactTop, {
        width,
        align: 'center',
        lineGap: design.typography.contact * design.typography.lineGapRatio.bold,
      });
  }
  const line = contactLine(contact);
  if (line) {
    // A rule between the name and the contact details, full usable width. The identity sits above
    // it and the ways to reach that person sit below: two different kinds of fact, so the eye gets
    // a divider rather than a paragraph. Same stroke weight as the section rules, so the page has
    // one rule language rather than two.
    const ruleY = doc.y + design.spacing.contactTop;
    doc
      .moveTo(design.page.margin, ruleY)
      .lineTo(design.page.margin + width, ruleY)
      .lineWidth(design.geometry.sectionRuleWidth)
      .stroke();
    doc.y = ruleY + design.spacing.contactTop;
    doc
      .font(RESUME_FONTS.regular)
      .fontSize(design.typography.contact)
      .text(line, design.page.margin, doc.y, {
        width,
        align: 'center',
        lineGap: design.typography.contact * design.typography.lineGapRatio.regular,
      });
  }
  doc.y += design.spacing.headerBottom;

  for (const block of resumeContentBlocks(spec, design)) {
    if (block.kind === 'education') {
      drawEducation(doc, spec, block.topGap, design);
    } else if (block.kind === 'entries') {
      drawEntrySection(doc, block.name, block.entries, block.topGap, design);
    } else {
      drawSectionHeader(doc, block.name, block.topGap, design);
      doc
        .font(RESUME_FONTS.regular)
        .fontSize(design.typography.body)
        .text(spec.skills.join(' • '), design.page.margin, doc.y, {
          width,
          lineGap: design.typography.body * design.typography.lineGapRatio.regular,
        });
    }
  }

  doc.end();
  return {
    buffer: await done,
    spec,
    omissions: plan.omissions,
    trimmed: plan.trimmed,
    sparse: plan.sparse,
    layout: plan.layout,
  };
}
