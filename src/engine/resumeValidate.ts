import type { ResumeSpec } from '../llm/resumeSpec';

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

// Spec-level checks: content rules a JD-tailored spec must satisfy before it's worth rendering.
// Mirrors validate_resume.py's content/structure checks + pressure_test.py's per-bullet scoring,
// adapted from the Dubai engine's fixed EDUCATION/EXPERIENCE/LEADERSHIP/SKILLS template to
// Volley's generalized per-student spec (no LEADERSHIP section, entries aren't hardcoded).
export function validateResumeSpec(spec: ResumeSpec, jdText: string): ValidationResult {
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
