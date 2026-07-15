import type { ResumeSpec } from '../llm/resumeSpec';
import type { ExperienceBankEntry } from '../db/schema';
import { wordSet, numberSignatures, ungroundedNumbers } from './grounding';

// Deterministic QA gate for a generated resume, ported from the Dubai off-cycle resume
// engine's validate_resume.py + pressure_test.py (~/Documents/Internship Apps/_resume-engine/) -
// the same quality bar Mehek applies to her own resume builds, now applied to every student's
// Volley-generated resume too. Content checks operate on the spec (pre-render); layout checks
// (page count, extractable text) operate on the rendered PDF text.

// Same whitelist as the Dubai engine's STRONG_VERBS, exported so resumeSpec.ts's system prompt
// stays in sync with what the validator actually enforces (single source of truth).
export const STRONG_VERBS = new Set(
  `built shipped designed engineered developed led drove owned launched analyzed
delivered diagnosed ran secured founded co-founded managed presented translated instrumented deployed
architected automated optimized scaled quantified benchmarked researched synthesized negotiated
coordinated spearheaded established pioneered cut reduced improved increased grew won earned created
implemented conducted partnered collaborated evaluated modeled sized identified uncovered cracked
recruited mentored trained structured forecasted tracked documented demoed integrated resolved isolated
refined applied profiled solved interviewed communicated prepared produced drafted executed
devised formulated advised championed briefed`
    .split(/\s+/)
    .filter(Boolean),
);

const INITIATIVE_VERBS = new Set(
  `founded co-founded owned drove spearheaded launched built pioneered led initiated established
won secured shipped architected designed engineered scaled automated negotiated cracked recruited
refined structured`
    .split(/\s+/)
    .filter(Boolean),
);

const BULLET_MAX_CHARS = 235; // beyond this, a ~2-line bullet wraps to a 3rd line
const MIN_KEYWORD_COVERAGE = 18; // % of JD terms that must appear (ATS safety floor)
const METRIC_RE = /(\$|%|\d|\b0\.\d+\b|\b\d+x\b)/i;

const STOPWORDS = new Set(
  `the and for with you your our are will from that this have role team work within across into
their they our who whom able strong good using use used per via etc a an of to in on at by as is be we`
    .split(/\s+/)
    .filter(Boolean),
);

function jdKeywords(jdText: string): Set<string> {
  const words = (jdText.toLowerCase().match(/[a-z][a-z+/&-]{2,}/g) ?? []) as string[];
  return new Set(words.filter((w) => !STOPWORDS.has(w) && w.length > 3));
}

function contentWords(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[a-z]{4,}/g) ?? []) as string[];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

export interface BulletFlag {
  entry: string;
  bullet: string;
  flags: string[];
}

export interface ValidationResult {
  issues: string[]; // hard problems - drive the retry loop
  warnings: BulletFlag[]; // pressure-test-style soft flags - surfaced, don't block
  ats_keyword_coverage_pct: number;
}

// ---- Grounding: every org/title/number in the output must trace back to the experience bank ----
// This is the deterministic backstop for the product's #1 promise ("never invents a job, a skill,
// or a number"). The generator prompt already forbids fabrication; this catches drift the prompt
// misses, by checking generated facts against the student's actual source data, not just its form.

export interface GroundingViolation {
  entry: string; // the generated entry's org (for context)
  kind: 'org' | 'title' | 'metric' | 'date';
  detail: string; // the offending token (org name, title, number, or year)
  bullet?: string; // present for metric violations
}

// The 4-digit years in a date string, e.g. "Jun 2023 - Aug 2024" -> ["2023","2024"].
function yearsIn(dateRange: string | null | undefined): string[] {
  return dateRange ? (dateRange.match(/\b(?:19|20)\d{2}\b/g) ?? []) : [];
}

// Years present in the generated date range that don't appear in the source entry's date range.
// Only enforced when the source HAS a date range - if the bank entry has no dates we can't verify,
// so we don't fabricate-flag (best-effort, consistent with the rest of grounding).
function ungroundedYears(genRange: string, srcRange: string | null | undefined): string[] {
  const srcYears = new Set(yearsIn(srcRange));
  if (srcYears.size === 0) return [];
  return yearsIn(genRange).filter((y) => !srcYears.has(y));
}

// The bank entry whose org best matches the generated org (>=50% token containment), or undefined
// if the generated org appears in no bank entry (i.e. it was invented).
function matchBankEntry(orgName: string, bank: ExperienceBankEntry[]): ExperienceBankEntry | undefined {
  const gen = wordSet(orgName);
  if (gen.size === 0) return undefined;
  let best: { e: ExperienceBankEntry; score: number } | undefined;
  for (const e of bank) {
    const src = wordSet(e.org);
    if (src.size === 0) continue;
    let inter = 0;
    for (const t of gen) if (src.has(t)) inter++;
    if (inter === 0) continue;
    const containment = inter / Math.min(gen.size, src.size);
    if (containment >= 0.5 && (!best || containment > best.score)) best = { e, score: containment };
  }
  return best?.e;
}

function bankEntryCorpus(e: ExperienceBankEntry): string {
  const variants = Array.isArray(e.bullet_variants) ? (e.bullet_variants as string[]) : [];
  const tags = Array.isArray(e.tags) ? (e.tags as string[]) : [];
  return [e.org, e.title ?? '', e.date_range ?? '', ...variants, ...tags].join(' ');
}

function titleIsSwapped(genTitle: string, srcTitle: string | null): boolean {
  if (!genTitle || !srcTitle) return false;
  const gt = wordSet(genTitle);
  const st = wordSet(srcTitle);
  if (gt.size === 0 || st.size === 0) return false;
  for (const t of gt) if (st.has(t)) return false; // any shared word = a legit light rewrite
  return true; // zero overlap = the title was swapped for a different one
}

// Every grounding violation in a spec against the student's bank. Org that isn't in the bank ->
// 'org'; a title with zero word-overlap with its source title -> 'title'; a bullet number whose
// value doesn't appear in that entry's source text -> 'metric'.
export function findGroundingViolations(spec: ResumeSpec, bank: ExperienceBankEntry[]): GroundingViolation[] {
  const violations: GroundingViolation[] = [];
  for (const entry of spec.experience) {
    const src = matchBankEntry(entry.org, bank);
    if (!src) {
      // No source entry -> the org is invented. Its bullets' metrics are unsupported too, but the
      // org fix (drop the whole entry) subsumes them, so we don't double-report per bullet.
      violations.push({ entry: entry.org, kind: 'org', detail: entry.org });
      continue;
    }
    if (titleIsSwapped(entry.title, src.title)) {
      violations.push({ entry: entry.org, kind: 'title', detail: entry.title });
    }
    for (const yr of ungroundedYears(entry.date_range, src.date_range)) {
      violations.push({ entry: entry.org, kind: 'date', detail: yr });
    }
    const srcSigs = numberSignatures(bankEntryCorpus(src));
    for (const bullet of entry.bullets) {
      for (const n of ungroundedNumbers(bullet, srcSigs)) {
        violations.push({ entry: entry.org, kind: 'metric', detail: n, bullet });
      }
    }
  }
  return violations;
}

// Last-resort sanitizer: after the generate/retry loop, strip anything still ungrounded rather
// than ship a fabricated claim. Drops invented entries, replaces a swapped title with the real
// one, and drops bullets that carry an ungrounded number. Returns the cleaned spec + a human list
// of what was removed (for the quality report / audit).
export function pruneUngroundedContent(
  spec: ResumeSpec,
  bank: ExperienceBankEntry[],
): { spec: ResumeSpec; removed: string[] } {
  const removed: string[] = [];
  const experience: ResumeSpec['experience'] = [];
  for (const entry of spec.experience) {
    const src = matchBankEntry(entry.org, bank);
    if (!src) {
      removed.push(`dropped entry "${entry.org}" (not in experience bank)`);
      continue;
    }
    let title = entry.title;
    if (titleIsSwapped(title, src.title)) {
      removed.push(`reset title "${title}" -> "${src.title}" for ${entry.org}`);
      title = src.title ?? title;
    }
    let date_range = entry.date_range;
    if (src.date_range && ungroundedYears(date_range, src.date_range).length > 0) {
      removed.push(`reset date "${date_range}" -> "${src.date_range}" for ${entry.org}`);
      date_range = src.date_range;
    }
    const srcSigs = numberSignatures(bankEntryCorpus(src));
    const bullets = entry.bullets.filter((b) => {
      const bad = ungroundedNumbers(b, srcSigs);
      if (bad.length > 0) {
        removed.push(`dropped bullet with ungrounded ${bad.join(', ')} in ${entry.org}`);
        return false;
      }
      return true;
    });
    experience.push({ ...entry, title, date_range, bullets });
  }
  return { spec: { ...spec, experience }, removed };
}

// Skills the spec lists that don't trace back to ANY bank entry (org/title/dates/bullets/tags).
// Surfaced as review WARNINGS, not hard issues: the bank is an incomplete view of a student's
// real skills (they may genuinely know a tool they never wrote a bullet about), so hard-blocking
// would strip legitimate skills. A warning flags likely JD-driven fabrication ("claims Kubernetes
// because the JD wants it") for human review without over-correcting. A skill counts as grounded
// if ANY of its content words appears in the bank corpus.
export function findUngroundedSkills(skills: string[], bank: ExperienceBankEntry[]): string[] {
  const corpus = wordSet(bank.map(bankEntryCorpus).join(' '));
  if (corpus.size === 0) return [];
  const out: string[] = [];
  for (const skill of skills) {
    const tokens = wordSet(skill);
    if (tokens.size === 0) continue; // pure punctuation/symbol - nothing to ground
    const grounded = [...tokens].some((t) => corpus.has(t));
    if (!grounded) out.push(skill);
  }
  return out;
}

// Spec-level checks: content rules a JD-tailored spec must satisfy before it's worth rendering.
// Mirrors validate_resume.py's content/structure checks + pressure_test.py's per-bullet scoring,
// adapted from the Dubai engine's fixed EDUCATION/EXPERIENCE/LEADERSHIP/SKILLS template to
// Volley's generalized per-student spec (no LEADERSHIP section, entries aren't hardcoded).
// When `bank` is provided, grounding violations are added as hard issues so the retry loop
// regenerates; pass [] to skip grounding (form-only validation).
export function validateResumeSpec(spec: ResumeSpec, jdText: string, bank: ExperienceBankEntry[] = []): ValidationResult {
  const issues: string[] = [];
  const warnings: BulletFlag[] = [];

  const allText = [
    spec.school,
    spec.degree,
    spec.coursework,
    ...spec.experience.flatMap((e) => [e.org, e.title, ...e.bullets]),
    ...spec.skills,
  ].join(' ');

  if (allText.includes('—')) issues.push('spec contains an em dash');
  if (spec.experience.length === 0) issues.push('no experience entries selected');

  const kw = jdKeywords(jdText);

  for (const entry of spec.experience) {
    if (entry.bullets.length > 3) issues.push(`${entry.org}: ${entry.bullets.length} bullets (max 3)`);

    for (const bullet of entry.bullets) {
      const flags: string[] = [];
      if (bullet.includes('—')) issues.push(`em dash in bullet: "${bullet.slice(0, 40)}"`);
      if (bullet.length > BULLET_MAX_CHARS) issues.push(`bullet exceeds ${BULLET_MAX_CHARS} chars: "${bullet.slice(0, 40)}"`);

      const words = bullet.trim().split(/\s+/);
      const nWords = words.length;
      const first = (words[0] ?? '').replace(/[^a-zA-Z-]/g, '').toLowerCase();
      const isAction = STRONG_VERBS.has(first);
      const isInitiative = INITIATIVE_VERBS.has(first);
      const hasMetric = METRIC_RE.test(bullet);
      const andCount = (bullet.toLowerCase().match(/\band\b/g) ?? []).length;
      const hits = [...contentWords(bullet)].filter((w) => kw.has(w)).length;

      if (!isAction) issues.push(`bullet not action-verb-first ("${words[0]}"): "${bullet.slice(0, 40)}"`);
      if (nWords > 34) flags.push('verbose');
      if (andCount > 2) flags.push(`run-on(${andCount} "and"s)`);
      if (!hasMetric && hits < 2) flags.push('thin(no-metric+low-fit)');
      if (!isInitiative && !hasMetric) flags.push('no-ownership-signal');

      if (flags.length > 0) warnings.push({ entry: entry.org, bullet, flags });
    }
  }

  // Entry-level near-duplicate check (pressure_test.py's entry_overlaps): two bullets in the
  // same entry restating the same point via high content-word overlap.
  for (const entry of spec.experience) {
    for (let i = 0; i < entry.bullets.length; i++) {
      for (let j = i + 1; j < entry.bullets.length; j++) {
        const a = contentWords(entry.bullets[i]);
        const b = contentWords(entry.bullets[j]);
        if (a.size === 0 || b.size === 0) continue;
        const intersection = [...a].filter((w) => b.has(w)).length;
        const union = new Set([...a, ...b]).size;
        const jaccard = intersection / union;
        if (jaccard >= 0.3) {
          warnings.push({
            entry: entry.org,
            bullet: entry.bullets[i],
            flags: [`overlaps bullet ${j + 1} (${Math.round(jaccard * 100)}% shared words)`],
          });
        }
      }
    }
  }

  const present = [...kw].filter((w) => allText.toLowerCase().includes(w)).length;
  const coveragePct = kw.size > 0 ? Math.round((100 * present) / kw.size) : 100;
  if (coveragePct < MIN_KEYWORD_COVERAGE) {
    issues.push(`low ATS keyword coverage ${coveragePct}% (< ${MIN_KEYWORD_COVERAGE}%): not tailored enough to this JD`);
  }

  // Grounding: fail if the spec cites an org/title/number that isn't in the student's bank.
  if (bank.length > 0) {
    for (const v of findGroundingViolations(spec, bank)) {
      if (v.kind === 'org') {
        issues.push(`grounding: experience entry "${v.detail}" is not in the student's experience bank`);
      } else if (v.kind === 'title') {
        issues.push(`grounding: title "${v.detail}" for ${v.entry} is not supported by the experience bank`);
      } else if (v.kind === 'date') {
        issues.push(`grounding: date "${v.detail}" for ${v.entry} is not in the student's experience bank`);
      } else {
        issues.push(`grounding: metric "${v.detail}" in a ${v.entry} bullet is not in the experience bank ("${(v.bullet ?? '').slice(0, 40)}")`);
      }
    }
    // Skills are grounded softly (warning, not a hard retry-driving issue) - see findUngroundedSkills.
    for (const skill of findUngroundedSkills(spec.skills, bank)) {
      warnings.push({ entry: 'skills', bullet: skill, flags: ['ungrounded-skill'] });
    }
  }

  return { issues, warnings, ats_keyword_coverage_pct: coveragePct };
}

// Post-render layout checks (validate_resume.py's PDF section): exactly 1 page, text
// extractable (ATS-readable - guaranteed by construction since resumeRender.ts writes real
// text, not a rasterized image, but checked anyway as the authoritative signal).
export interface PdfLayoutResult {
  issues: string[];
  page_count: number;
  extractable_chars: number;
}

export function validatePdfLayout(extractedText: string, pageCount: number): PdfLayoutResult {
  const issues: string[] = [];
  if (pageCount !== 1) issues.push(`PDF is ${pageCount} pages (want 1)`);
  if (extractedText.trim().length < 400) issues.push('PDF text not extractable (ATS-unreadable)');
  return { issues, page_count: pageCount, extractable_chars: extractedText.trim().length };
}
