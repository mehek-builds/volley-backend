import PDFDocument from 'pdfkit';
import type { ResumeSpec } from '../llm/resumeSpec';
import { matchingBankEntry, relevanceScore } from './resumePolicy';
import { startsWithStrongVerb } from './resumeValidate';
import type { ExperienceBankEntry } from '../db/schema';
import {
  RESUME_DESIGN,
  resumeDesignAtExpansion,
  type ResumeDesignTokens,
} from './resumeDesign';
import { RESUME_CONTENT_LIMITS, RESUME_FIT_FALLBACKS } from './resumeContentPolicy';
import type { PdfTextGeometryItem } from '../lib/pdfText';

export interface ContactHeader {
  full_name: string;
  email?: string;
  phone?: string;
  /* Where she is, e.g. "Los Angeles, CA". Measured 2026-08-11: `spec->'_contact'` carried neither
   * a location nor a city on any of the 158 stored packets, so every resume Litos has ever
   * generated has a header with no location on it, while "Current location" was separately a
   * required-and-empty blocker on 9 of them. The fact was on file the whole time and simply had
   * nowhere in this interface to go. */
  location?: string;
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

/* Exported for the header tests. This is the one function that decides what the contact line of a
 * rendered resume says: renderResumePdf draws exactly this string, measureResumeLayout measures it,
 * and resumeContactIssues validates it. Testing it is testing what the employer reads, without
 * rasterising a PDF to find out. */
export function contactLine(contact: ContactHeader): string {
  const seen = new Set<string>();
  const clean = (value: string | undefined) => {
    const shown = value?.trim().replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '') ?? '';
    const key = shown.toLowerCase();
    if (!shown || seen.has(key)) return '';
    seen.add(key);
    return shown;
  };
  // Location leads the line, which is where a reader looks for it and where every resume
  // convention puts it. `clean` strips a URL scheme and a trailing slash; a city string has
  // neither, so it passes through untouched and still takes part in the duplicate check.
  return [contact.location, contact.email, contact.phone, contact.linkedin_url, contact.github_url, contact.portfolio_url]
    .map(clean)
    .filter(Boolean)
    .join(' | ');
}

/**
 * A resume the employer who reads it cannot answer.
 *
 * Thrown, not collected into an issues array, because every other post-render check answers the
 * question "is this document good enough to send" and this one answers "is this a document at all".
 * A named class rather than a bare Error so the routes can tell it apart from a render fault and
 * say something the applicant can act on, instead of "the check could not run".
 */
export class ResumeContactError extends Error {
  constructor() {
    super('This resume has no email address and no phone number on it, so an employer who reads it has no way to reply');
    this.name = 'ResumeContactError';
  }
}

/**
 * Whether the header carries a way to REACH the applicant, which links are not.
 *
 * Measured 2026-08-09 on production: 28 of one account's 85 packets had `_contact.email` and
 * `_contact.phone` both null, so the whole block under the name collapsed to a LinkedIn URL. A
 * profile page is a place to look someone up, not an address a recruiter replies to, and 26 of
 * those 28 had already been typed into a live employer form before anyone noticed. So links are
 * deliberately NOT counted here: the bar is a route back, not a non-empty line.
 *
 * Trimmed rather than truthiness-checked, because the contact block is assembled from stored jsonb
 * and a whitespace-only string is what an "email: ''" round trip produces.
 */
export function hasContactRoute(contact: ContactHeader): boolean {
  return Boolean(contact.email?.trim() || contact.phone?.trim());
}

/**
 * The same rule as an ISSUE STRING, for the quality block every packet stores.
 *
 * spec._quality already records specIssues, layoutIssues, visualWarnings, groundingRemoved,
 * atsCoverage and the whole visualLayout. On Virtu packet 80aeba93, which has no email and no
 * phone, every one of those arrays is empty: the quality system measures density, section order,
 * keyword coverage and grounding, and had nothing whatsoever to say about whether the resume can be
 * replied to. The most basic property a resume has was the one property nothing asserted.
 *
 * visualLayout.sectionOrder is not a substitute and never was. It reads ["HEADER","EDUCATION",
 * "EXPERIENCE","SKILLS"] on that same packet, because HEADER is present whenever the NAME is drawn.
 * A header is a name and a way to answer it; the section-order check cannot see the difference, so
 * the difference has to be checked here.
 *
 * Returns an array rather than a boolean so it can be spread into the existing issue lists and
 * stored alongside them, in the same shape the rest of the quality block already uses.
 */
export function resumeContactIssues(contact: ContactHeader): string[] {
  return hasContactRoute(contact)
    ? []
    : ['the resume has no email address and no phone number, so an employer who reads it cannot reply'];
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
    { label: 'contact line', value: contactLine(contact) },
    { label: 'education school', value: spec.school },
    { label: 'education degree', value: spec.degree },
    { label: 'graduation date', value: spec.grad_date },
    // A GPA that renders as a different number than it was stored as is a misstated academic claim,
    // so it gets the same character-for-character check every other printed fact here gets.
    { label: 'education GPA', value: spec.gpa },
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

/** Catch extractable text whose glyph box crosses the printable safe margin. */
export function findPdfSafeMarginIssues(
  pages: PdfTextGeometryItem[][],
  layout: Pick<ResumeVisualLayout, 'page_width' | 'page_height' | 'margin'>,
  tolerance = 1,
): string[] {
  const issues = new Set<string>();
  const right = layout.page_width - layout.margin;
  const top = layout.page_height - layout.margin;
  for (const [pageIndex, page] of pages.entries()) {
    for (const item of page.filter((candidate) => candidate.text.trim())) {
      const label = `page ${pageIndex + 1} text "${item.text.trim().slice(0, 40)}"`;
      if (item.x < layout.margin - tolerance) issues.add(`${label} crosses the left safe margin`);
      if (item.x + item.width > right + tolerance) issues.add(`${label} crosses the right safe margin`);
      if (item.y + item.height > top + tolerance) issues.add(`${label} crosses the top safe margin`);
      if (item.y - item.height < layout.margin - tolerance) issues.add(`${label} crosses the bottom safe margin`);
    }
  }
  return [...issues];
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
  return Boolean(spec.school || spec.degree || spec.grad_date || spec.gpa || spec.coursework);
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
  options: { leftFont?: string } = {},
): number {
  const width = usableWidth(design);
  const leftFont = options.leftFont ?? RESUME_FONTS.bold;
  const leftGapRatio =
    leftFont === RESUME_FONTS.italic
      ? design.typography.lineGapRatio.italic
      : design.typography.lineGapRatio.bold;
  return Math.max(
    textHeight(
      doc,
      left,
      leftFont,
      design.typography.body,
      width * design.geometry.splitLeftRatio,
      leftGapRatio,
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
  // Mirrors drawEducation exactly: school with the place, then degree with the date.
  height += splitLineHeight(doc, spec.school, spec.school_location ?? '', design);
  if (spec.degree || spec.grad_date) {
    height +=
      design.spacing.detailTop +
      splitLineHeight(doc, spec.degree, spec.grad_date, design, { leftFont: RESUME_FONTS.italic });
  }
  /* Measured because it is drawn. The target-role removal was a lesson in the other direction:
     measurement and drawing have to move together or the layout search solves for a page that is
     not the page, and here the error would be an education block one line taller than budgeted,
     pushing the last entry off a resume that reports itself as fitting. */
  if (spec.gpa) {
    height +=
      design.spacing.detailTop +
      textHeight(
        doc,
        `GPA: ${spec.gpa}`,
        RESUME_FONTS.regular,
        design.typography.body,
        width,
        design.typography.lineGapRatio.regular,
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
  // Mirrors drawEntrySection exactly: org with the place, then role with the dates.
  let height = gapBefore + splitLineHeight(doc, entry.org, entry.location ?? '', design);
  if (entry.title || entry.date_range) {
    height +=
      design.spacing.detailTop +
      splitLineHeight(doc, entry.title, entry.date_range, design, { leftFont: RESUME_FONTS.italic });
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

    let headerHeight = design.spacing.headerSafeTop + textHeight(
      doc,
      contact.full_name,
      RESUME_FONTS.bold,
      design.typography.name,
      width,
      design.typography.lineGapRatio.bold,
    );
    /* No target-role line is measured here because none is drawn. Measurement and drawing have to
       move together: reserving height for a line the header does not print pushes every section
       below it down by that much and eats page fill the layout search then tries to win back. */
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


/**
 * The student's own unused bullet that best fits this posting, for a page with room to spare.
 *
 * The mirror of lowestValueBullet: that one finds the weakest line to remove while the page
 * overflows, this one finds the strongest line the selection left behind while the page is empty.
 * Candidates come from the BANK, so everything it can add is evidence the student wrote and the
 * grounding checks already accepted. It can never reach for a different entry's work, and it can
 * never invent: an entry whose bank row holds nothing new simply yields nothing.
 */
function highestValueUnusedBullet(
  spec: ResumeSpec,
  bank: ExperienceBankEntry[],
  jdText: string,
  ceiling: number,
): { entryIndex: number; bullet: string } | null {
  /* A plain loop rather than forEach: control-flow analysis cannot see an assignment made inside a
     callback, so `best` narrows to never after the iteration and the return stops compiling. */
  let best: { entryIndex: number; bullet: string; score: number } | null = null;
  for (let entryIndex = 0; entryIndex < spec.experience.length; entryIndex += 1) {
    const entry = spec.experience[entryIndex];
    if (entry.bullets.length >= ceiling) continue;
    const source = matchingBankEntry(entry, bank);
    if (!source) continue;
    const printed = new Set(entry.bullets.map((bullet) => bullet.toLowerCase().replace(/\s+/g, ' ').trim()));
    const variants = Array.isArray(source.bullet_variants) ? source.bullet_variants : [];
    for (const variant of variants) {
      if (typeof variant !== 'string') continue;
      const bullet = variant.trim();
      if (!bullet) continue;
      const key = bullet.toLowerCase().replace(/\s+/g, ' ').trim();
      if (printed.has(key)) continue;
      /* The same gate every printed bullet passed. An unused variant is raw bank text and has not
         necessarily been through the opener rule, so adding one blindly would put a bullet on the
         page that the validator then refuses - turning an empty page into no page at all. */
      if (!startsWithStrongVerb(bullet)) continue;
      const score = relevanceScore(bullet, jdText);
      if (!best || score > best.score) best = { entryIndex, bullet, score };
    }
  }
  return best ? { entryIndex: best.entryIndex, bullet: best.bullet } : null;
}

function addBullet(
  spec: ResumeSpec,
  choice: { entryIndex: number; bullet: string },
): ResumeSpec {
  const experience = [...spec.experience];
  const entry = experience[choice.entryIndex];
  experience[choice.entryIndex] = { ...entry, bullets: [...entry.bullets, choice.bullet] };
  return { ...spec, experience };
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
  /* One-page fitting may remove only entries after the first. The BEHAVIOUR is unchanged; the
     reason it used to give was "the first entry is the upload's reviewed recent experience, a
     resume invariant", and that is no longer what index 0 is. The lead entry is now chosen against
     the posting and justified in spec.lead_alignment (engine/leadAlignment.ts), so it is the single
     most relevant entry on the page rather than the most recent one. Which makes it the LAST thing
     a fit pass should drop, not something exempt from relevance: dropping it would delete the
     evidence the resume is ordered around and leave the stored justification pointing at an entry
     that is no longer there. */
  let index = 1;
  for (let i = 2; i < spec.experience.length; i += 1) {
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
  /* THE STUDENT'S OWN UNUSED EVIDENCE, for a page that turns out to have room to spare.
   *
   * Optional because the trimming half of this function has never needed it and callers that only
   * want a fit decision should not have to load a bank to get one. Without it the expand pass
   * simply does not run and the behaviour is exactly what it was. */
  bank: ExperienceBankEntry[] = [],
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
      // Same rule as removeLowestEntry, for the same reason: the lead entry keeps its position
      // because it is the posting-aligned one, and only the tail is re-ranked and trimmed.
      const first = spec.experience[0];
      const ranked = spec.experience.slice(1)
        .map((entry) => ({ entry, score: entryValue(entry, jdText) }))
        .sort((a, b) => b.score - a.score);
      for (const removed of ranked.slice(RESUME_CONTENT_LIMITS.maxEntries)) {
        omissions.push(`Removed lower-fit ${removed.entry.type ?? 'experience'} entry: ${removed.entry.org}`);
      }
      spec = {
        ...spec,
        experience: [first, ...ranked.slice(0, RESUME_CONTENT_LIMITS.maxEntries - 1).map(({ entry }) => entry)],
      };
    }
    /* AND THE OTHER DIRECTION: a page that SPACING CANNOT FILL gets more of the student's own work.
     *
     * Measured on ten real generations 2026-08-20 - every one filled 0.69 of the page with the
     * density search pinned at its maximum, leaving 222pt blank at the bottom. Reaching the design's
     * own 0.94 target by spacing alone needs about 15pt body type, which is a poster. So the room is
     * spent on evidence instead: the highest-value bullet the selection left in the bank, added one
     * at a time, each time re-measuring.
     *
     * MEASURED AGAINST THE MOST SPACIOUS DESIGN, and the first draft of this measured the most
     * compact one, which was wrong in a way worth recording. At compact even a full resume has room
     * - a 12-bullet spec measures 0.60 there - so every resume qualified and dense ones grew denser
     * while the density search was left with nothing to do. The question is not "is there space on
     * the page" but "is there space SPACING CANNOT USE", and only the expanded design answers it.
     * A resume that fills at expansion 1 is left entirely alone, which is what makes this an
     * emptiness fix rather than a density change.
     *
     * The loop stops on the first refusal - no bank row, nothing new, nothing that clears the opener
     * gate, the entry already at its expanded ceiling, or the next bullet would overshoot - so it
     * terminates on content rather than on a guard, and it can add nothing the student did not
     * write. */
    const spacious = resumeDesignAtExpansion(1);
    const spaciousRoom = (candidate: ResumeSpec) =>
      usableHeight(spacious) * spacious.density.targetFillRatio -
      estimateResumeHeight(candidate, contact, spacious, measurementDocument);

    while (spaciousRoom(spec) > 0) {
      const candidate = highestValueUnusedBullet(
        spec,
        bank,
        jdText,
        RESUME_CONTENT_LIMITS.expandedBulletsPerEntry,
      );
      if (!candidate) break;
      const next = addBullet(spec, candidate);
      /* Never past the target. Overshooting hands the trimmer below a bullet to take straight back
         out, which is churn at best and a swap nobody asked for at worst. */
      if (spaciousRoom(next) < 0) break;
      spec = next;
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

/* The second line of an entry uses the SAME split, in italic on the left. Passing the font in
   rather than writing a near-copy of this function is deliberate: the two lines have to agree about
   the column ratios and the right-hand alignment forever, and two functions that must not drift are
   one function with an argument. */
function drawSplitLine(
  doc: PDFKit.PDFDocument,
  left: string,
  right: string,
  gapBefore: number,
  design: ResumeDesignTokens,
  options: { leftFont?: string } = {},
) {
  const width = usableWidth(design);
  const leftFont = options.leftFont ?? RESUME_FONTS.bold;
  const leftGapRatio =
    leftFont === RESUME_FONTS.italic
      ? design.typography.lineGapRatio.italic
      : design.typography.lineGapRatio.bold;
  doc.y += gapBefore;
  const y = doc.y;
  doc
    .font(leftFont)
    .fontSize(design.typography.body)
    .text(left, design.page.margin, y, {
      width: width * design.geometry.splitLeftRatio,
      lineGap: design.typography.body * leftGapRatio,
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
  /* TWO SPLIT LINES, not one split line plus a full-width line. The place goes on the right of the
     school and the date drops to the right of the degree, which is how a resume is actually set:
     the left edge is the institution and the role, the right edge is where and when. Previously the
     date sat beside the school and the degree line had no right column at all, so the eye had
     nowhere consistent to read dates from. */
  drawSplitLine(doc, spec.school, spec.school_location ?? '', 0, design);
  if (spec.degree || spec.grad_date) {
    doc.y += design.spacing.detailTop;
    drawSplitLine(doc, spec.degree, spec.grad_date, 0, design, { leftFont: RESUME_FONTS.italic });
  }
  /* Between the degree and the coursework, which is where a student's own resume puts it. Absent is
     the normal case and prints nothing: a resume that never stated a GPA is not missing one, and
     the product's standing rule is that it does not keep asking for a number the student chose not
     to give. */
  if (spec.gpa) {
    doc.y += design.spacing.detailTop;
    doc
      .font(RESUME_FONTS.regular)
      .fontSize(design.typography.body)
      .text(`GPA: ${spec.gpa}`, design.page.margin, doc.y, {
        width,
        lineGap: design.typography.body * design.typography.lineGapRatio.regular,
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
    // Same two-line shape as education: org and place, then role and dates.
    drawSplitLine(doc, entry.org, entry.location ?? '', index === 0 ? 0 : design.spacing.entryTop, design);
    if (entry.title || entry.date_range) {
      doc.y += design.spacing.detailTop;
      drawSplitLine(doc, entry.title, entry.date_range, 0, design, { leftFont: RESUME_FONTS.italic });
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

/* A page of text through a synchronous compressor is a sub-second job, so this is far above any
 * real render and exists only so the ATS gate cannot wait on a document that will never finish. */
const RENDER_DEADLINE_MS = 20_000;

export async function renderResumePdf(
  rawSpec: ResumeSpec,
  contact: ContactHeader,
  jdText = '',
  /* Passed through to the fit plan so a page with room to spare can be filled with the student's
     own unused bullets rather than with spacing. Defaults to empty, which is the previous
     behaviour exactly: no bank, no expansion. */
  bank: ExperienceBankEntry[] = [],
): Promise<{
  buffer: Buffer;
  spec: ResumeSpec;
  omissions: string[];
  trimmed: boolean;
  sparse: boolean;
  layout: ResumeVisualLayout;
}> {
  /* THE GUARD, BEFORE A SINGLE BYTE IS DRAWN, and in the renderer rather than in any one route.
   *
   * Four call sites produce an employer-facing PDF (resume.ts generation, applications.ts edit and
   * pre-send verification, baseResume.ts's ATS gate). A check at the producer alone fixes the path
   * it is written on and leaves the next one to be discovered from an employer, which is how this
   * defect reached 28 packets. This is the one function that turns a spec into a document, so it is
   * the one place where "uncontactable" can be made unrepresentable rather than merely unlikely. */
  if (!hasContactRoute(contact)) throw new ResumeContactError();

  const plan = planResumeLayout(rawSpec, contact, jdText, bank);
  const { design, spec } = plan;
  const width = usableWidth(design);
  const doc = createResumeDocument(design);
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  /* This promise must always settle, because the ATS gate on the base-resume build is designed to
   * fail closed and an await that never returns defeats that completely: the function is killed at
   * Vercel's 300s limit with the SSE half-written and neither a done nor an error frame ever sent.
   * The student watches a build that stops and says nothing.
   *
   * THE TIMEOUT IS THE REAL GUARD, not the error listener. Checked against pdfkit 0.19.1: the
   * document is a Readable that emits only layout events ('line', 'pageAdded' and friends), never
   * 'error', and never calls destroy(err). Compression is deflateSync, so doc.end() finalises
   * synchronously and a genuine render failure - a missing font, a bad glyph - throws out of the
   * drawing code rather than arriving as an event. The one way this can hang is the internal
   * `_waiting` count never reaching zero, so `_finalize()` never runs and 'end' never fires, and
   * that path emits nothing at all. An 'error' handler cannot catch it; a deadline can.
   *
   * The listener stays anyway. It costs nothing, it is correct if a later pdfkit ever does emit,
   * and its absence is a trap for the next person who assumes a stream rejects on failure. */
  const done = new Promise<Buffer>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`PDF render did not finish within ${RENDER_DEADLINE_MS}ms`)),
      RENDER_DEADLINE_MS,
    );
    // unref so a pending deadline cannot hold a short-lived process open past its work.
    deadline.unref?.();
    const settle = <T,>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(deadline);
      fn(value);
    };
    doc.on('end', settle(() => resolve(Buffer.concat(chunks))));
    doc.on('error', settle(reject));
  });

  doc
    .font(RESUME_FONTS.bold)
    .fontSize(design.typography.name)
    .text(contact.full_name, design.page.margin, design.page.margin + design.spacing.headerSafeTop, {
      width,
      align: 'center',
      lineGap: design.typography.name * design.typography.lineGapRatio.bold,
    });
  /* NO TARGET-ROLE HEADLINE. Added 2026-07-22 (d670e5d, "align generated resumes with job
     criteria") as an ATS device: stamp the posting's exact title under the name so a filter on job
     title gets a literal hit. Removed 2026-08-04 by Mehek's call, against her own resume template,
     which has the name, a rule, and the contact line, and nothing else.

     The cost was never worth the hit. The line reads as a claim about the applicant in the position
     a person looks for one, and the first thing anyone asked on seeing a generated resume was why
     it led with a job title instead of their name. `spec.target_role` is still set, still validated
     against the posting, and still drives targeting; it is simply not printed on the document. */
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
