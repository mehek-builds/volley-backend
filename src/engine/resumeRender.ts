import PDFDocument from 'pdfkit';
import type { ResumeSpec } from '../llm/resumeSpec';
import { relevanceScore } from './resumePolicy';

const PAGE_MARGIN = 36;
const USABLE_WIDTH = 612 - PAGE_MARGIN * 2;
const USABLE_HEIGHT = 792 - PAGE_MARGIN * 2;
const BODY_SIZE = 10.5;
const NAME_SIZE = 16;
const CONTACT_SIZE = 9.5;
const HEADER_SIZE = 10.5;
const SPARSE_FILL_RATIO = 0.5;

export interface ContactHeader {
  full_name: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
}

export interface ResumeLayoutPlan {
  spec: ResumeSpec;
  omissions: string[];
  trimmed: boolean;
  sparse: boolean;
  estimated_height: number;
}

function contactLine(contact: ContactHeader): string {
  return [contact.email, contact.phone, contact.linkedin_url, contact.github_url, contact.portfolio_url]
    .filter(Boolean)
    .join(' | ');
}

type ResumeEntry = ResumeSpec['experience'][number];

function educationPosition(spec: ResumeSpec): NonNullable<ResumeSpec['education_position']> {
  return spec.education_position ?? 'top';
}

function entriesFor(spec: ResumeSpec, type: NonNullable<ResumeEntry['type']>): ResumeEntry[] {
  return spec.experience.filter((entry) => (entry.type ?? 'job') === type);
}

function sectionHeight(doc: PDFKit.PDFDocument, title: string, topGap: number): number {
  return topGap + doc.font('Times-Bold').fontSize(HEADER_SIZE).heightOfString(title, { width: USABLE_WIDTH }) + 6;
}

function educationHeight(doc: PDFKit.PDFDocument, spec: ResumeSpec, topGap: number): number {
  if (!spec.school && !spec.degree && !spec.grad_date && !spec.coursework) return 0;
  let height = sectionHeight(doc, 'EDUCATION', topGap);
  height += Math.max(
    doc.font('Times-Bold').fontSize(BODY_SIZE).heightOfString(spec.school, { width: USABLE_WIDTH * 0.72 }),
    doc.font('Times-Roman').fontSize(BODY_SIZE).heightOfString(spec.grad_date, { width: USABLE_WIDTH * 0.25 }),
  );
  if (spec.degree) height += 2 + doc.font('Times-Italic').fontSize(BODY_SIZE).heightOfString(spec.degree, { width: USABLE_WIDTH });
  if (spec.coursework) {
    height += 2 + doc.font('Times-Roman').fontSize(BODY_SIZE).heightOfString(`Relevant coursework: ${spec.coursework}`, { width: USABLE_WIDTH });
  }
  return height;
}

function entryHeight(doc: PDFKit.PDFDocument, entry: ResumeEntry, gapBefore: number): number {
  let height = gapBefore;
  height += Math.max(
    doc.font('Times-Bold').fontSize(BODY_SIZE).heightOfString(entry.org, { width: USABLE_WIDTH * 0.7 }),
    doc.font('Times-Roman').fontSize(BODY_SIZE).heightOfString(entry.date_range, { width: USABLE_WIDTH * 0.27 }),
  );
  if (entry.title) height += 1 + doc.font('Times-Italic').fontSize(BODY_SIZE).heightOfString(entry.title, { width: USABLE_WIDTH });
  for (const bullet of entry.bullets) {
    height += 1 + doc.font('Times-Roman').fontSize(BODY_SIZE).heightOfString(`•  ${bullet}`, { width: USABLE_WIDTH - 14 });
  }
  return height;
}

function entrySectionHeight(doc: PDFKit.PDFDocument, title: string, entries: ResumeEntry[], topGap: number): number {
  if (entries.length === 0) return 0;
  return sectionHeight(doc, title, topGap) + entries.reduce((sum, entry, index) => sum + entryHeight(doc, entry, index === 0 ? 0 : 3), 0);
}

export function estimateResumeHeight(spec: ResumeSpec, contact: ContactHeader): number {
  const doc = new PDFDocument({ margin: PAGE_MARGIN, bufferPages: true, size: 'LETTER' });
  let height = doc.font('Times-Bold').fontSize(NAME_SIZE).heightOfString(contact.full_name, { width: USABLE_WIDTH });
  const line = contactLine(contact);
  if (line) height += 2 + doc.font('Times-Roman').fontSize(CONTACT_SIZE).heightOfString(line, { width: USABLE_WIDTH });
  height += 4;

  const jobs = entriesFor(spec, 'job');
  const projects = entriesFor(spec, 'project');
  const leadership = entriesFor(spec, 'leadership');
  const blocks: number[] = [];
  if (educationPosition(spec) === 'top') blocks.push(educationHeight(doc, spec, 2));
  blocks.push(entrySectionHeight(doc, 'EXPERIENCE', jobs, 7));
  blocks.push(entrySectionHeight(doc, 'PROJECTS', projects, 7));
  blocks.push(entrySectionHeight(doc, 'LEADERSHIP', leadership, 7));
  if (educationPosition(spec) === 'after_experience') blocks.push(educationHeight(doc, spec, 7));
  if (spec.skills.length > 0) {
    blocks.push(
      sectionHeight(doc, 'SKILLS', 7) +
        doc.font('Times-Roman').fontSize(BODY_SIZE).heightOfString(spec.skills.join(' • '), { width: USABLE_WIDTH }),
    );
  }
  return height + blocks.reduce((sum, block) => sum + block, 0);
}

function lowestValueBullet(spec: ResumeSpec, jdText: string, minimum: number): { entryIndex: number; bulletIndex: number } | null {
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

function removeBullet(spec: ResumeSpec, choice: { entryIndex: number; bulletIndex: number }, omissions: string[]): ResumeSpec {
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

export function planResumeLayout(
  rawSpec: ResumeSpec,
  contact: ContactHeader,
  jdText: string,
): ResumeLayoutPlan {
  const omissions: string[] = [];
  let spec = rawSpec;
  if (spec.experience.length > 4) {
    const ranked = spec.experience
      .map((entry) => ({ entry, score: entryValue(entry, jdText) }))
      .sort((a, b) => b.score - a.score);
    for (const removed of ranked.slice(4)) omissions.push(`Removed lower-fit ${removed.entry.type ?? 'experience'} entry: ${removed.entry.org}`);
    spec = { ...spec, experience: ranked.slice(0, 4).map(({ entry }) => entry) };
  }
  let guard = 0;

  while (estimateResumeHeight(spec, contact) > USABLE_HEIGHT && guard < 100) {
    guard += 1;
    const thirdBullet = lowestValueBullet(spec, jdText, 2);
    if (thirdBullet) {
      spec = removeBullet(spec, thirdBullet, omissions);
      continue;
    }
    if (spec.experience.length > 2) {
      spec = removeLowestEntry(spec, jdText, omissions);
      continue;
    }
    if (spec.coursework) {
      omissions.push('Removed coursework after stronger job-matched evidence was retained');
      spec = { ...spec, coursework: '' };
      continue;
    }
    if (spec.skills.length > 6) {
      const removed = spec.skills[spec.skills.length - 1];
      omissions.push(`Removed lower-fit skill: ${removed}`);
      spec = { ...spec, skills: spec.skills.slice(0, -1) };
      continue;
    }
    const secondBullet = lowestValueBullet(spec, jdText, 1);
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

  const estimatedHeight = estimateResumeHeight(spec, contact);
  return {
    spec,
    omissions,
    trimmed: omissions.length > 0,
    sparse: estimatedHeight / USABLE_HEIGHT < SPARSE_FILL_RATIO,
    estimated_height: estimatedHeight,
  };
}

function drawSectionHeader(doc: PDFKit.PDFDocument, title: string, topGap: number) {
  doc.y += topGap;
  doc.font('Times-Bold').fontSize(HEADER_SIZE).text(title, PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
  const ruleY = doc.y + 1;
  doc.moveTo(PAGE_MARGIN, ruleY).lineTo(PAGE_MARGIN + USABLE_WIDTH, ruleY).lineWidth(0.65).stroke();
  doc.y = ruleY + 4;
}

function drawSplitLine(doc: PDFKit.PDFDocument, left: string, right: string, gapBefore: number) {
  doc.y += gapBefore;
  const y = doc.y;
  doc.font('Times-Bold').fontSize(BODY_SIZE).text(left, PAGE_MARGIN, y, { width: USABLE_WIDTH * 0.72 });
  const leftBottom = doc.y;
  doc.font('Times-Roman').fontSize(BODY_SIZE).text(right, PAGE_MARGIN + USABLE_WIDTH * 0.73, y, {
    width: USABLE_WIDTH * 0.27,
    align: 'right',
  });
  doc.y = Math.max(leftBottom, doc.y);
}

function drawEducation(doc: PDFKit.PDFDocument, spec: ResumeSpec, topGap: number) {
  if (!spec.school && !spec.degree && !spec.grad_date && !spec.coursework) return;
  drawSectionHeader(doc, 'EDUCATION', topGap);
  drawSplitLine(doc, spec.school, spec.grad_date, 0);
  if (spec.degree) {
    doc.y += 1;
    doc.font('Times-Italic').fontSize(BODY_SIZE).text(spec.degree, PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
  }
  if (spec.coursework) {
    doc.y += 1;
    doc.font('Times-Roman').fontSize(BODY_SIZE).text(`Relevant coursework: ${spec.coursework}`, PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
  }
}

function drawEntrySection(doc: PDFKit.PDFDocument, title: string, entries: ResumeEntry[], topGap: number) {
  if (entries.length === 0) return;
  drawSectionHeader(doc, title, topGap);
  entries.forEach((entry, index) => {
    drawSplitLine(doc, entry.org, entry.date_range, index === 0 ? 0 : 3);
    if (entry.title) {
      doc.y += 1;
      doc.font('Times-Italic').fontSize(BODY_SIZE).text(entry.title, PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
    }
    for (const bullet of entry.bullets) {
      doc.y += 1;
      doc.font('Times-Roman').fontSize(BODY_SIZE).text(`•  ${bullet}`, PAGE_MARGIN + 10, doc.y, { width: USABLE_WIDTH - 10 });
    }
  });
}

export async function renderResumePdf(
  rawSpec: ResumeSpec,
  contact: ContactHeader,
  jdText = '',
): Promise<{ buffer: Buffer; spec: ResumeSpec; omissions: string[]; trimmed: boolean; sparse: boolean }> {
  const plan = planResumeLayout(rawSpec, contact, jdText);
  const spec = plan.spec;
  const doc = new PDFDocument({ margin: PAGE_MARGIN, bufferPages: true, size: 'LETTER' });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.font('Times-Bold').fontSize(NAME_SIZE).text(contact.full_name, PAGE_MARGIN, PAGE_MARGIN, {
    width: USABLE_WIDTH,
    align: 'center',
  });
  const line = contactLine(contact);
  if (line) {
    doc.font('Times-Roman').fontSize(CONTACT_SIZE).text(line, PAGE_MARGIN, doc.y + 2, {
      width: USABLE_WIDTH,
      align: 'center',
    });
  }

  if (educationPosition(spec) === 'top') drawEducation(doc, spec, 2);
  drawEntrySection(doc, 'EXPERIENCE', entriesFor(spec, 'job'), 7);
  drawEntrySection(doc, 'PROJECTS', entriesFor(spec, 'project'), 7);
  drawEntrySection(doc, 'LEADERSHIP', entriesFor(spec, 'leadership'), 7);
  if (educationPosition(spec) === 'after_experience') drawEducation(doc, spec, 7);
  if (spec.skills.length > 0) {
    drawSectionHeader(doc, 'SKILLS', 7);
    doc.font('Times-Roman').fontSize(BODY_SIZE).text(spec.skills.join(' • '), PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
  }

  doc.end();
  return { buffer: await done, spec, omissions: plan.omissions, trimmed: plan.trimmed, sparse: plan.sparse };
}
