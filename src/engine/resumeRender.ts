import PDFDocument from 'pdfkit';
import type { ResumeSpec } from '../llm/resumeSpec';

// Direct PDF generation (no docx -> PDF conversion step). The Dubai off-cycle resume engine
// (~/Documents/Internship Apps/_resume-engine/build_resume_v2.py) edits fixed paragraph slots
// in a pre-made .docx via python-docx, then shells out to LibreOffice (make_pdfs.sh) for a
// faithful-layout PDF. Neither half of that pipeline is available on Vercel serverless: no
// python-docx equivalent in Node, and no LibreOffice binary to shell out to. Generating the PDF
// directly with pdfkit sidesteps both problems and, as a side effect, gives full programmatic
// control over layout - exactly what's needed to enforce the same pt-precise spacing rules
// validate_resume.py checks for (EDUCATION top-gap 2pt, other section gaps 8pt, entry gaps 4pt,
// Times 11pt body, one-page fit).

const PAGE_MARGIN = 36; // 0.5in, matches the Dubai template
const USABLE_WIDTH = 612 - PAGE_MARGIN * 2; // Letter width 612pt - margins = 540pt (matches ONE_LINE_PT)
const USABLE_HEIGHT = 792 - PAGE_MARGIN * 2; // Letter height 792pt - margins
const BODY_SIZE = 11;
const NAME_SIZE = 16;
const CONTACT_SIZE = 10;
const HEADER_SIZE = 11;

export interface ContactHeader {
  full_name: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
}

function contactLine(contact: ContactHeader): string {
  return [contact.email, contact.phone, contact.linkedin_url, contact.github_url, contact.portfolio_url]
    .filter(Boolean)
    .join('   |   ');
}

// Estimates total content height for a spec without rendering a real document, so the caller
// can trim BEFORE paying for a render (rather than render, discover overflow, and re-render).
// Uses a throwaway PDFDocument purely for its font-metrics engine (heightOfString/widthOfString
// work off font metrics alone and don't require the doc to ever be written anywhere).
function estimateHeight(spec: ResumeSpec, contact: ContactHeader): number {
  const measurer = new PDFDocument({ margin: PAGE_MARGIN, bufferPages: true });
  measurer.font('Times-Roman');

  let h = 0;
  h += NAME_SIZE * 1.3; // name line
  h += CONTACT_SIZE * 1.3 + 8; // contact line + gap after

  h += HEADER_SIZE * 1.3 + 2; // EDUCATION header, 2pt top-gap
  h += BODY_SIZE * 1.3; // school/grad-date tabbed line
  if (spec.degree) h += BODY_SIZE * 1.2;
  if (spec.coursework) h += measurer.fontSize(BODY_SIZE).heightOfString(`Relevant coursework: ${spec.coursework}`, { width: USABLE_WIDTH });

  h += HEADER_SIZE * 1.3 + 8; // EXPERIENCE header, 8pt top-gap
  for (const entry of spec.experience) {
    h += BODY_SIZE * 1.3 + 4; // org/date tabbed line, 4pt entry gap
    h += BODY_SIZE * 1.2; // title line
    for (const b of entry.bullets) {
      h += measurer.fontSize(BODY_SIZE).heightOfString(`•  ${b}`, { width: USABLE_WIDTH - 14 }) + 2;
    }
  }

  if (spec.skills.length > 0) {
    h += HEADER_SIZE * 1.3 + 8; // SKILLS header, 8pt top-gap
    h += measurer.fontSize(BODY_SIZE).heightOfString(spec.skills.join('   •   '), { width: USABLE_WIDTH });
  }

  void contact; // contact only affects the contact line's content, not its own line height
  return h;
}

// Trims lowest-priority content first, matching the priority order the tailoring spec already
// established (most-relevant experience entry first, bullets in importance order): drop the
// least relevant experience entry, then the last bullet of the lowest-priority remaining entry,
// then coursework - never touches the top-ranked entry or its first two bullets.
export function trimSpecToFit(spec: ResumeSpec, contact: ContactHeader): { spec: ResumeSpec; trimmed: boolean } {
  let current = spec;
  let trimmed = false;

  while (estimateHeight(current, contact) > USABLE_HEIGHT) {
    if (current.experience.length > 2) {
      current = { ...current, experience: current.experience.slice(0, -1) };
      trimmed = true;
      continue;
    }
    const lastEntryIdx = current.experience.length - 1;
    const lastEntry = current.experience[lastEntryIdx];
    if (lastEntry && lastEntry.bullets.length > 2) {
      const nextExperience = [...current.experience];
      nextExperience[lastEntryIdx] = { ...lastEntry, bullets: lastEntry.bullets.slice(0, -1) };
      current = { ...current, experience: nextExperience };
      trimmed = true;
      continue;
    }
    if (current.coursework) {
      current = { ...current, coursework: '' };
      trimmed = true;
      continue;
    }
    break; // nothing left to safely trim; render as-is and let the post-render page check flag it
  }

  return { spec: current, trimmed };
}

function drawSectionHeader(doc: PDFKit.PDFDocument, title: string, topGap: number) {
  doc.moveDown(0);
  doc.y += topGap;
  doc.font('Times-Bold').fontSize(HEADER_SIZE).text(title.toUpperCase(), PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
  const ruleY = doc.y + 2;
  doc.moveTo(PAGE_MARGIN, ruleY).lineTo(PAGE_MARGIN + USABLE_WIDTH, ruleY).lineWidth(0.75).stroke();
  doc.y = ruleY + 4;
}

function drawTabbedLine(doc: PDFKit.PDFDocument, left: string, right: string, gapBefore: number) {
  doc.y += gapBefore;
  const y = doc.y;
  doc.font('Times-Bold').fontSize(BODY_SIZE).text(left, PAGE_MARGIN, y, { continued: false });
  doc.font('Times-Roman').fontSize(BODY_SIZE).text(right, PAGE_MARGIN, y, { width: USABLE_WIDTH, align: 'right' });
}

// validate_resume.py flags a page as "not filled" when bottom white space exceeds 54pt, since
// the Dubai template always has a guaranteed pool of leadership/coursework filler to top it up
// with. RoleQuick's spec has no such guaranteed filler (padding it would mean fabricating content,
// which the no-fabrication rule forbids), so sparseness is surfaced as a warning, not something
// the renderer tries to fix by inventing bullets.
const SPARSE_FILL_RATIO = 0.5;

export async function renderResumePdf(
  rawSpec: ResumeSpec,
  contact: ContactHeader,
): Promise<{ buffer: Buffer; trimmed: boolean; sparse: boolean }> {
  const { spec, trimmed } = trimSpecToFit(rawSpec, contact);
  const sparse = estimateHeight(spec, contact) / USABLE_HEIGHT < SPARSE_FILL_RATIO;

  const doc = new PDFDocument({ margin: PAGE_MARGIN, bufferPages: true, size: 'LETTER' });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.font('Times-Bold').fontSize(NAME_SIZE).text(contact.full_name, PAGE_MARGIN, PAGE_MARGIN, {
    width: USABLE_WIDTH,
    align: 'center',
  });
  doc.font('Times-Roman').fontSize(CONTACT_SIZE).text(contactLine(contact), PAGE_MARGIN, doc.y + 2, {
    width: USABLE_WIDTH,
    align: 'center',
  });

  drawSectionHeader(doc, 'Education', 2);
  drawTabbedLine(doc, spec.school, spec.grad_date, 0);
  if (spec.degree) {
    doc.y += 2;
    doc.font('Times-Italic').fontSize(BODY_SIZE).text(spec.degree, PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
  }
  if (spec.coursework) {
    doc.y += 2;
    doc.font('Times-Roman').fontSize(BODY_SIZE).text(`Relevant coursework: ${spec.coursework}`, PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
  }

  drawSectionHeader(doc, 'Experience', 8);
  spec.experience.forEach((entry, i) => {
    drawTabbedLine(doc, entry.org, entry.date_range, i === 0 ? 0 : 4);
    doc.y += 2;
    doc.font('Times-Italic').fontSize(BODY_SIZE).text(entry.title, PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
    doc.y += 2;
    for (const b of entry.bullets) {
      doc.font('Times-Roman').fontSize(BODY_SIZE).text(`•  ${b}`, PAGE_MARGIN + 10, doc.y, { width: USABLE_WIDTH - 10 });
      doc.y += 2;
    }
  });

  if (spec.skills.length > 0) {
    drawSectionHeader(doc, 'Skills', 8);
    doc.font('Times-Roman').fontSize(BODY_SIZE).text(spec.skills.join('   •   '), PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
  }

  doc.end();
  const buffer = await done;
  return { buffer, trimmed, sparse };
}
