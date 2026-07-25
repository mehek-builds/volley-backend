import PDFDocument from 'pdfkit';

export type CoverLetterIdentity = { full_name: string; email?: string };

export async function renderCoverLetterPdf(
  identity: CoverLetterIdentity,
  company: string,
  body: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'LETTER', margins: { top: 54, right: 64, bottom: 54, left: 64 } });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.font('Helvetica-Bold').fontSize(15).fillColor('#111111').text(identity.full_name);
    if (identity.email) document.moveDown(0.25).font('Helvetica').fontSize(9.5).fillColor('#444444').text(identity.email);
    document.moveDown(1.5).fillColor('#111111').fontSize(10.5).text(new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date()));
    document.moveDown(1).text(`Hiring team\n${company}`);
    document.moveDown(1).text('Dear Hiring Team,');
    for (const paragraph of body.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean)) {
      document.moveDown(0.9).font('Helvetica').fontSize(10.5).fillColor('#111111').text(paragraph, { lineGap: 3 });
    }
    document.moveDown(1).text(`Sincerely,\n${identity.full_name}`);
    document.end();
  });
}

