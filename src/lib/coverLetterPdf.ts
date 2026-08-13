import PDFDocument from 'pdfkit';

export type CoverLetterIdentity = { full_name: string; email?: string };

export async function renderCoverLetterPdf(
  identity: CoverLetterIdentity,
  company: string,
  body: string,
  /**
   * The date printed on the letter. Defaults to now, which is what every generation path wants and
   * what this function did unconditionally before.
   *
   * It is a parameter because the retention sweep deletes the rendered file at 30 days while the
   * letter's body and `generated_at` stay on the row, so a packet sent after that window is rebuilt
   * from those. Left to default, the rebuild would stamp the send date on a letter the applicant
   * approved weeks earlier and hand an employer a document that never existed at that date. The
   * caller passes the artifact's own `generated_at`, which is the same moment the original stamp
   * was taken from, so the rebuilt page matches the approved one.
   */
  date: Date = new Date(),
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'LETTER', margins: { top: 54, right: 64, bottom: 54, left: 64 } });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.font('Helvetica-Bold').fontSize(15).fillColor('#111111').text(identity.full_name);
    if (identity.email) document.moveDown(0.25).font('Helvetica').fontSize(9.5).fillColor('#444444').text(identity.email);
    document.moveDown(1.5).fillColor('#111111').fontSize(10.5).text(new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date));
    document.moveDown(1).text(`Hiring team\n${company}`);
    document.moveDown(1).text('Dear Hiring Team,');
    for (const paragraph of body.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean)) {
      document.moveDown(0.9).font('Helvetica').fontSize(10.5).fillColor('#111111').text(paragraph, { lineGap: 3 });
    }
    document.moveDown(1).text(`Sincerely,\n${identity.full_name}`);
    document.end();
  });
}

