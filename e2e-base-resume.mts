/* End-to-end base-resume run over real uploaded resumes.
 *
 * Calls the SAME functions POST /profile and POST /resume/base/stream call, in the same order,
 * with real Anthropic calls and a real PDF render. Nothing is stubbed except the database: the
 * bank is held in memory instead of inserted, because these are downloaded sample resumes for
 * fictional people and they have no business in the production Neon instance.
 *
 * Usage: npx tsx e2e-base-resume.mts <dir-of-pdfs> [outdir]
 */
import 'dotenv/config';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { extractPdfText } from './src/lib/pdfText';
import { parseResumeWithClaude } from './src/llm/parse';
import { bankEntriesFrom } from './src/routes/profile';
import { generateBaseResumeSpec } from './src/llm/baseResume';
import { applyResumePolicy, type CandidateEducation } from './src/engine/resumePolicy';
import { pruneUngroundedContent, validateResumeSpec } from './src/engine/resumeValidate';
import { renderResumePdf } from './src/engine/resumeRender';
import { RESUME_CONTENT_LIMITS } from './src/engine/resumeContentPolicy';
import type { ExperienceBankEntry } from './src/db/schema';

const dir = process.argv[2];
const outDir = process.argv[3] ?? path.join(dir, '_out');

type Finding = { file: string; severity: 'ERROR' | 'DEFECT' | 'NOTE'; code: string; detail: string };
const findings: Finding[] = [];
const add = (file: string, severity: Finding['severity'], code: string, detail: string) =>
  findings.push({ file, severity, code, detail });

function educationFrom(parsed: Awaited<ReturnType<typeof parseResumeWithClaude>>): CandidateEducation {
  return {
    school: parsed.school ?? '',
    degree: parsed.degree,
    grad_date: parsed.grad_date ?? (parsed.grad_year ? String(parsed.grad_year) : undefined),
    grad_year: parsed.grad_year,
    currently_enrolled: parsed.currently_enrolled,
    coursework: parsed.coursework,
  };
}

async function run(file: string) {
  const label = path.basename(file);
  const started = Date.now();
  console.log(`\n${'='.repeat(78)}\n${label}`);

  const buf = await readFile(file);
  let text: string;
  let sourcePages = 0;
  try {
    const parsedPdf = await extractPdfText(buf);
    text = parsedPdf.text;
    sourcePages = parsedPdf.numpages;
  } catch (e) {
    add(label, 'ERROR', 'pdf-extract', String((e as Error).message).slice(0, 200));
    return;
  }
  console.log(`  source: ${sourcePages} page(s), ${text.length} chars of text`);
  // Same page-scaled floor POST /profile applies, so this harness rejects a scan exactly where the
  // real upload does instead of running a doomed parse the route would never have reached.
  const minimumChars = Math.max(50, 700 * Math.max(1, sourcePages));
  if (text.trim().length < minimumChars) {
    add(
      label,
      'NOTE',
      'rejected-at-upload',
      `${text.trim().length} chars over ${sourcePages} page(s) is below the ${minimumChars} floor: upload is rejected with the scanned-PDF message. Correct behaviour.`,
    );
    return;
  }

  let parsed;
  try {
    parsed = await parseResumeWithClaude(text);
  } catch (e) {
    add(label, 'ERROR', 'parse', String((e as Error).message).slice(0, 200));
    return;
  }

  const bankRows = bankEntriesFrom(parsed, '00000000-0000-0000-0000-000000000000');
  const bank = bankRows.map((r, i) => ({
    ...r,
    id: `bank-${i}`,
    created_at: new Date(),
  })) as unknown as ExperienceBankEntry[];

  console.log(
    `  parsed: name=${JSON.stringify(parsed.full_name)} school=${JSON.stringify(parsed.school)} ` +
      `grad=${parsed.grad_year} enrolled=${parsed.currently_enrolled} bank=${bank.length} skills=${parsed.skills?.length ?? 0}`,
  );

  if (!parsed.full_name?.trim()) add(label, 'ERROR', 'parse-no-name', 'full_name empty');
  if (!parsed.school?.trim()) add(label, 'DEFECT', 'parse-no-school', 'school empty');
  if (bank.length === 0) {
    add(label, 'ERROR', 'bank-empty', 'no bank entries seeded; base build would 400');
    return;
  }
  const emptyBullets = bank.filter((b) => (b.bullet_variants as string[]).length === 0);
  if (emptyBullets.length > 0) {
    add(label, 'DEFECT', 'bank-entry-no-bullets', `${emptyBullets.length} of ${bank.length} entries have zero bullets: ${emptyBullets.map((b) => b.org).join(', ')}`);
  }

  const education = educationFrom(parsed);
  const declaredSkills = parsed.skills?.length ? parsed.skills : null;

  let raw;
  const pieces: string[] = [];
  try {
    raw = await generateBaseResumeSpec(bank, education, declaredSkills, (p) => {
      if (p.type === 'entry') pieces.push(`entry:${p.entry.org}(${p.entry.bullets.length})`);
      if (p.type === 'skills') pieces.push(`skills:${p.skills.length}`);
      if (p.type === 'education') pieces.push(`edu:${p.education_position}`);
    }, { timeoutMs: 120_000 });
  } catch (e) {
    add(label, 'ERROR', 'generate', String((e as Error).message).slice(0, 300));
    return;
  }
  console.log(`  stream: ${pieces.join(' ')}`);

  const { spec: policied, context } = applyResumePolicy(raw, education, bank, '', { now: new Date() });
  const { spec, removed } = pruneUngroundedContent(policied, bank, declaredSkills);
  const validation = validateResumeSpec(spec, '', bank, declaredSkills, education);

  for (const r of removed) add(label, 'DEFECT', 'grounding-pruned', r);
  for (const issue of validation.issues) add(label, 'DEFECT', 'validator', issue);

  // Format rules the base resume claims to guarantee.
  if (spec.experience.length === 0) add(label, 'ERROR', 'no-entries', 'spec has zero entries');
  if (spec.experience.length > RESUME_CONTENT_LIMITS.maxEntries)
    add(label, 'DEFECT', 'too-many-entries', `${spec.experience.length} entries`);
  for (const e of spec.experience) {
    if (e.bullets.length > RESUME_CONTENT_LIMITS.maxBulletsPerEntry)
      add(label, 'DEFECT', 'too-many-bullets', `${e.org}: ${e.bullets.length}`);
    if (e.bullets.length < RESUME_CONTENT_LIMITS.minBulletsPerEntry)
      add(label, 'DEFECT', 'too-few-bullets', `${e.org}: ${e.bullets.length}`);
    for (const b of e.bullets) {
      if (b.includes('—')) add(label, 'DEFECT', 'em-dash', `${e.org}: ${b.slice(0, 60)}`);
      const words = b.trim().split(/\s+/).length;
      if (words < 8 || words > 30) add(label, 'DEFECT', 'bullet-length', `${e.org}: ${words} words - ${b.slice(0, 60)}`);
    }
  }
  /* Education leads unless the degree is clearly finished and not recent. Mirrors
   * deriveCandidateContext: enrolled OR recent graduate OR no graduation evidence at all -> top.
   * (This check previously asserted the old `enrolled ? top : after_experience` rule and reported
   * three false defects on the first run after the fix.) */
  const gradYear = parsed.grad_year && parsed.grad_year >= 2000 ? parsed.grad_year : undefined;
  const sinceGrad = gradYear !== undefined ? new Date().getFullYear() - gradYear : undefined;
  /* A PAST graduation date overrides currently_enrolled, matching deriveCandidateContext. The
   * parser can return both at once - one sample resume came back enrolled=true with grad_year
   * 2019 - and the date is the harder evidence. Without this the harness reported a false defect
   * against correct behaviour. */
  const stillEnrolled =
    parsed.currently_enrolled && (gradYear === undefined || gradYear >= new Date().getFullYear());
  const expectedPos =
    stillEnrolled ||
    gradYear === undefined ||
    (sinceGrad !== undefined && sinceGrad >= 0 && sinceGrad <= 2)
      ? 'top'
      : 'after_experience';
  if (context.education_position !== expectedPos)
    add(label, 'DEFECT', 'education-position', `enrolled=${parsed.currently_enrolled} gradYear=${gradYear} expected=${expectedPos} got=${context.education_position}`);
  if (spec.skills.length === 0) add(label, 'DEFECT', 'no-skills', 'skills line empty');

  // Render, which is where one-page claims are actually settled.
  const contact = {
    full_name: parsed.full_name || 'Unknown',
    email: 'test@example.com',
    phone: '+1 555 0100',
  };
  let pageCount = 0;
  let fill = 0;
  try {
    const rendered = await renderResumePdf(spec, contact, '');
    pageCount = (await extractPdfText(rendered.buffer)).numpages;
    fill = rendered.layout.fill_ratio;
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, label.replace(/\.pdf$/, '')) + '-base.pdf', rendered.buffer);
    if (pageCount !== 1) add(label, 'ERROR', 'not-one-page', `rendered ${pageCount} pages`);
    if (fill < 0.55) add(label, 'DEFECT', 'underfull-page', `fill_ratio ${fill.toFixed(3)}`);
  } catch (e) {
    add(label, 'ERROR', 'render', String((e as Error).message).slice(0, 300));
  }

  console.log(
    `  result: ${spec.experience.length} entries [${spec.experience.map((e) => e.bullets.length).join(',')}] ` +
      `skills=${spec.skills.length} edu=${spec.education_position} pages=${pageCount} fill=${fill.toFixed(3)} ` +
      `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  await writeFile(
    path.join(outDir, label.replace(/\.pdf$/, '')) + '-spec.json',
    JSON.stringify({ parsed, bank, spec, validation, removed }, null, 2),
  );
}

const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
await mkdir(outDir, { recursive: true });
for (const f of files) {
  try {
    await run(path.join(dir, f));
  } catch (e) {
    add(f, 'ERROR', 'harness', String((e as Error).stack ?? e).slice(0, 400));
  }
}

console.log(`\n${'='.repeat(78)}\nFINDINGS (${findings.length})\n`);
for (const sev of ['ERROR', 'DEFECT', 'NOTE'] as const) {
  const rows = findings.filter((f) => f.severity === sev);
  if (rows.length === 0) continue;
  console.log(`${sev} (${rows.length}):`);
  for (const r of rows) console.log(`  [${r.code}] ${r.file}: ${r.detail}`);
  console.log('');
}
await writeFile(path.join(outDir, '_findings.json'), JSON.stringify(findings, null, 2));
