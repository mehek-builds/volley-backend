import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  TabStopType,
  AlignmentType,
  BorderStyle,
} from 'docx';
import type { ResumeSpec } from '../llm/resumeSpec';

// Single default template (PRD-v2 Section 12.2: one base.docx, simplest to build/maintain).
// Unlike the Dubai off-cycle engine (which edits fixed paragraph slots in a pre-made .docx via
// python-docx), this generates the document directly from the spec with the `docx` npm package —
// there's no portable python-docx equivalent for a Node/Vercel serverless function, so the "template"
// here is this render function's fixed section order/formatting rather than a physical base file.

function sectionHeader(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '111827' } },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 20 })],
  });
}

function tabbedLine(left: string, right: string): Paragraph {
  return new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: 9350 }],
    spacing: { after: 20 },
    children: [
      new TextRun({ text: left, bold: true, size: 21 }),
      new TextRun({ text: `\t${right}`, size: 21 }),
    ],
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 20 },
    children: [new TextRun({ text, size: 21 })],
  });
}

export interface ContactHeader {
  full_name: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
}

export async function renderResumeDocx(spec: ResumeSpec, contact: ContactHeader): Promise<Buffer> {
  const contactLine = [contact.email, contact.phone, contact.linkedin_url, contact.github_url, contact.portfolio_url]
    .filter(Boolean)
    .join('  |  ');

  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: contact.full_name, bold: true, size: 32 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: contactLine, size: 18 })],
    }),
    sectionHeader('Education'),
    tabbedLine(spec.school, spec.grad_date),
  ];

  if (spec.degree) {
    children.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [new TextRun({ text: spec.degree, italics: true, size: 20 })],
      }),
    );
  }
  if (spec.coursework) {
    children.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [new TextRun({ text: `Relevant coursework: ${spec.coursework}`, size: 20 })],
      }),
    );
  }

  children.push(sectionHeader('Experience'));
  for (const entry of spec.experience) {
    children.push(tabbedLine(entry.org, entry.date_range));
    children.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [new TextRun({ text: entry.title, italics: true, size: 20 })],
      }),
    );
    for (const b of entry.bullets) children.push(bullet(b));
  }

  if (spec.skills.length > 0) {
    children.push(sectionHeader('Skills'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: spec.skills.join('  •  '), size: 20 })],
      }),
    );
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}
