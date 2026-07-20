import type { ResumeSpec } from '../llm/resumeSpec';
import type { ExperienceBankEntry } from '../db/schema';
import { wordSet, numberSignatures, ungroundedNumbers } from './grounding';
import { deriveCandidateContext, type CandidateEducation } from './resumePolicy';

// Deterministic QA gate for a generated resume, ported from the Dubai off-cycle resume
// engine's validate_resume.py + pressure_test.py (~/Documents/Internship Apps/_resume-engine/) -
// the same quality bar Mehek applies to her own resume builds, now applied to every student's
// RoleQuick-generated resume too. Content checks operate on the spec (pre-render); layout checks
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
  kind: 'org' | 'title' | 'metric' | 'date' | 'claim';
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

// Connector words dropped when forming an org's initialism ("Massachusetts Institute of
// Technology" -> "mit", not "miot").
const ORG_CONNECTORS = new Set(['of', 'the', 'and', 'for', 'at', 'a', 'an', 'de', 'to']);

function normalizeOrg(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"[\]–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// First letters of the significant words, e.g. "Massachusetts Institute of Technology" -> "mit",
// "University of California Los Angeles" -> "ucla", "National Aeronautics and Space
// Administration" -> "nasa".
function orgInitialism(s: string): string {
  return normalizeOrg(s)
    .split(' ')
    .filter((w) => w && !ORG_CONNECTORS.has(w))
    .map((w) => w[0])
    .join('');
}

// If `s` is a single-token acronym (2-6 letters like "MIT"/"USC"/"UCLA"/"IBM"), return it
// lowercased; otherwise null.
function acronymTokenOf(s: string): string | null {
  const tokens = normalizeOrg(s).split(' ').filter(Boolean);
  if (tokens.length === 1 && /^[a-z]{2,6}$/.test(tokens[0])) return tokens[0];
  return null;
}

// Match score between a generated org and a bank org: >0 means they're the same organization.
// H2 fix: an acronym vs its multi-word expansion shares ZERO tokens (bank "Massachusetts Institute
// of Technology" vs generated "MIT"), so token containment alone wrongly treats a real entry as
// invented and prunes it. We additionally match a single-token acronym on either side against the
// other side's initialism (also covers USC, IBM, UCLA, NASA, ...).
// Containment GATES the match; Jaccard RANKS it. The two jobs need different measures, and using
// containment for both is what caused R-022.
//
// Containment (inter / min(|gen|,|src|)) is the right gate: it tolerates a bank entry named more or
// less specifically than the spec's ("Lava Lab" vs "USC Lava Lab"). But it SATURATES at 1.0 the
// moment either side is a single shared token, so it cannot rank. With a bank holding both
// "Traeco" and "Traeco - AI Agent Cost Infrastructure", the spec's
// "Traeco - AI Agent Cost Infrastructure" scored 1/min(5,1) = 1.0 against the one-word "Traeco" and
// 5/min(5,5) = 1.0 against its real entry: a dead tie, resolved by whichever row the DB happened to
// return first. Wrong side of that coin and the pruner reset her real title "AI Engineer" to
// "Founder" and deleted a true bullet.
//
// Jaccard (inter / union) does not saturate: the one-word "Traeco" scores 1/5 = 0.2 while the full
// entry scores 5/5 = 1.0, so the specific entry wins on merit rather than on row order.
//
// The two kinds of evidence are TIERS, not one scale. A shared literal token is stronger evidence
// than an initialism inference, so every word match must outrank every acronym match: word matches
// occupy (1, 2] as 1 + Jaccard, acronyms sit at exactly 1. Ranking them on one scale is a bug that
// a first cut of this fix actually shipped - Jaccard put a literal match at 1/3 while the acronym
// branch still returned a flat 1, so a bank holding "MIT Media Lab" AND "Massachusetts Institute of
// Technology" resolved a spec's "MIT" to the university and then rewrote its title, which is the
// exact R-022 damage this function exists to prevent.
const ACRONYM_MATCH_SCORE = 1; // strictly below any word match, which is 1 + a positive Jaccard

function orgMatchScore(genOrg: string, bankOrg: string): number {
  const gen = wordSet(genOrg);
  const src = wordSet(bankOrg);
  if (gen.size > 0 && src.size > 0) {
    let inter = 0;
    for (const t of gen) if (src.has(t)) inter++;
    if (inter > 0) {
      const containment = inter / Math.min(gen.size, src.size);
      if (containment >= 0.5) return 1 + inter / (gen.size + src.size - inter);
    }
  }
  const genAcr = acronymTokenOf(genOrg);
  if (genAcr && genAcr === orgInitialism(bankOrg)) return ACRONYM_MATCH_SCORE;
  const srcAcr = acronymTokenOf(bankOrg);
  if (srcAcr && srcAcr === orgInitialism(genOrg)) return ACRONYM_MATCH_SCORE;
  return 0;
}

// The bank entry whose org best matches the generated org, or undefined if the generated org
// appears in no bank entry (i.e. it was invented). Matching is token-containment-gated,
// Jaccard-ranked, OR acronym/initialism-aware (see orgMatchScore).
//
// Ties are broken deterministically rather than by array order (R-022): the caller reads the bank
// straight out of Postgres, which promises no ordering without an ORDER BY, so "first one wins"
// meant the resume's contents could change between two identical requests. Prefer the more specific
// org (more tokens), then fall back to the org name itself so the choice is total and stable.
function matchBankEntry(orgName: string, bank: ExperienceBankEntry[]): ExperienceBankEntry | undefined {
  if (wordSet(orgName).size === 0 && !acronymTokenOf(orgName)) return undefined;
  let best: { e: ExperienceBankEntry; score: number } | undefined;
  for (const e of bank) {
    const score = orgMatchScore(orgName, e.org);
    if (score <= 0) continue;
    if (!best || score > best.score || (score === best.score && breaksTie(e.org, best.e.org))) {
      best = { e, score };
    }
  }
  return best?.e;
}

// Deterministic, order-independent tie-break: more specific org first, then lexicographic.
function breaksTie(candidateOrg: string, incumbentOrg: string): boolean {
  const c = wordSet(candidateOrg).size;
  const i = wordSet(incumbentOrg).size;
  if (c !== i) return c > i;
  return candidateOrg < incumbentOrg;
}

function bankEntryCorpus(e: ExperienceBankEntry): string {
  const variants = Array.isArray(e.bullet_variants) ? (e.bullet_variants as string[]) : [];
  const tags = Array.isArray(e.tags) ? (e.tags as string[]) : [];
  return [e.org, e.title ?? '', e.date_range ?? '', ...variants, ...tags].join(' ');
}

function bulletClaimIsGrounded(bullet: string, entry: ExperienceBankEntry): boolean {
  const generated = contentWords(bullet);
  if (generated.size === 0) return false;
  const variants = Array.isArray(entry.bullet_variants)
    ? (entry.bullet_variants as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  return variants.some((variant) => {
    const source = contentWords(variant);
    if (source.size === 0) return false;
    let shared = 0;
    for (const word of generated) if (source.has(word)) shared += 1;
    return shared / Math.min(generated.size, source.size) >= 0.3;
  });
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
      if (!bulletClaimIsGrounded(bullet, src)) {
        violations.push({ entry: entry.org, kind: 'claim', detail: bullet, bullet });
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
  declaredSkills?: string[] | null,
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
      if (!bulletClaimIsGrounded(b, src)) {
        removed.push(`dropped unsupported bullet in ${entry.org}`);
        return false;
      }
      return true;
    });
    experience.push({ ...entry, title, date_range, bullets });
  }

  // Skills are pruned only in declared mode. Dropping on soft bank-grounding would strip skills the
  // student genuinely has but never wrote a bullet about, which is why that mode only warns.
  //
  // Unlike experience, an empty result needs no "never let this empty the resume" guard: a resume
  // with no SKILLS line is honest and readable, whereas one with no experience is a blank page. If
  // pruning empties it, the declared list is the thing to fix.
  let skills = spec.skills;
  if (declaredSkills?.length) {
    // spec.skill_source is deliberately NOT passed while renaming is disabled. The disable lives in
    // the prompt, and the whole reason it is off is that the model ignored the prompt's own rules on
    // the first live run; a prompt-level ban that the validator still honors is not a ban, it is an
    // invitation with a comment. Until the curated synonym whitelist exists, a rename the model emits
    // anyway is treated as any other ungrounded skill and pruned, which fails in the honest
    // direction: fewer skills listed, all of them verbatim hers. Re-enable both together.
    const ungrounded = new Set(findUngroundedSkills(spec.skills, bank, declaredSkills));
    if (ungrounded.size > 0) {
      skills = spec.skills.filter((s) => !ungrounded.has(s));
      removed.push(`dropped ungrounded skills: ${[...ungrounded].join(', ')}`);
    }
  }

  return { spec: { ...spec, experience, skills }, removed };
}

// Skills the spec lists that the student cannot be said to have. Two modes, and which one applies
// depends entirely on whether the student ever told us their skills (profiles.skills, R-015).
//
// DECLARED MODE (`declared` non-empty) - the list is AUTHORITATIVE and anything outside it is
// ungrounded, full stop. Bank corpus is NOT consulted, deliberately: `experience_bank.tags` is
// seeded junk (the same gRPC/SDK-design array copy-pasted onto 6 of 7 rows, including a Product
// Management internship and a VP of Finance role), so grounding against it is how "gRPC" and "SDK
// design" reached essentially every resume Mehek has sent. A source that is itself unreliable
// cannot launder a claim. The student's own list can, which is the whole point of collecting it.
//
// FALLBACK MODE (no `declared`) - the pre-existing soft behaviour, unchanged: a skill is grounded
// if any of its content words appears in the bank corpus, and misses are WARNINGS rather than
// hard issues. The reasoning still holds when there is no declared list: the bank is an incomplete
// view of a student's real skills (they may genuinely know a tool they never wrote a bullet
// about), so hard-blocking on it alone would strip legitimate skills. The warning still flags
// likely JD-driven fabrication for human review without over-correcting.
//
// So collecting the list is what upgrades this check from advisory to enforceable. Without it,
// there is nothing a fabricated skill can be checked against - which is why the register's fix #1
// (add a real skills source) had to come before its fix #4 (validate against it).
export function findUngroundedSkills(
  skills: string[],
  bank: ExperienceBankEntry[],
  declared?: string[] | null,
  skillSource?: Record<string, string> | null,
): string[] {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const allowed = new Set((declared ?? []).map(norm).filter(Boolean));

  if (allowed.size > 0) {
    // A skill survives declared mode two ways, and only two:
    //   1. it is verbatim one of the student's declared skills, or
    //   2. spec.skill_source says it RENAMES one of them, for the JD's vocabulary.
    // Case 2 is why this map is trusted at all: the model may relabel "SQL" as the JD's "ETL", but
    // the label it claims to be renaming must itself be a real declared skill. So a rename can never
    // introduce a skill the student never claimed - the worst it can do is mislabel one they did,
    // which the prompt's negative examples target and which stays visible in skill_source rather than
    // vanishing into the resume. Without this, every rename would be silently dropped here (R-015).
    return skills.filter((s) => {
      const n = norm(s);
      if (!n) return false;
      if (allowed.has(n)) return false;
      const renames = skillSource?.[s];
      if (renames && allowed.has(norm(renames))) return false;
      return true;
    });
  }

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
// RoleQuick's generalized per-student spec (no LEADERSHIP section, entries aren't hardcoded).
// When `bank` is provided, grounding violations are added as hard issues so the retry loop
// regenerates; pass [] to skip grounding (form-only validation).
export function validateResumeSpec(
  spec: ResumeSpec,
  jdText: string,
  bank: ExperienceBankEntry[] = [],
  declaredSkills?: string[] | null,
  education?: CandidateEducation,
): ValidationResult {
  const issues: string[] = [];
  const warnings: BulletFlag[] = [];

  const allText = [
    spec.school,
    spec.degree,
    spec.grad_date,
    spec.coursework,
    ...spec.experience.flatMap((e) => [e.org, e.title, ...e.bullets]),
    ...spec.skills,
  ].join(' ');

  if (allText.includes('—')) issues.push('spec contains an em dash');
  if (spec.experience.length === 0) issues.push('no experience entries selected');
  if (spec.experience.length > 4) issues.push(`${spec.experience.length} entries selected (max 4)`);

  if (education) {
    const exact = (value: string | undefined) => value?.trim() ?? '';
    if (spec.school !== exact(education.school)) issues.push('education school differs from uploaded resume');
    if (spec.degree !== exact(education.degree)) issues.push('education degree differs from uploaded resume');
    if (spec.grad_date !== exact(education.grad_date)) issues.push('education graduation date differs from uploaded resume');
    const allowedCoursework = new Set((education.coursework ?? []).map((course) => course.trim()).filter(Boolean));
    const renderedCoursework = spec.coursework.split(',').map((course) => course.trim()).filter(Boolean);
    if (renderedCoursework.some((course) => !allowedCoursework.has(course))) {
      issues.push('coursework contains a course not listed on the uploaded resume');
    }
    const expectedPosition = deriveCandidateContext(education).education_position;
    if (spec.education_position !== expectedPosition) {
      issues.push(`education must render ${expectedPosition === 'top' ? 'at the top for a currently enrolled student' : 'after experience for this candidate'}`);
    }
  }

  const kw = jdKeywords(jdText);

  for (const entry of spec.experience) {
    if (entry.bullets.length > 3) issues.push(`${entry.org}: ${entry.bullets.length} bullets (max 3)`);
    if (entry.bullets.length === 0) issues.push(`${entry.org}: no bullets selected`);

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

  // Reported, but NOT a hard issue: the floor is currently unreachable, so making it drive the
  // retry loop was pure harm (R-023).
  //
  // jdKeywords() returns every non-stopword word in the JD over 3 chars: 304 of them for a 4.8k
  // Cohere posting, including "toronto", "vacation", "benefits", "passionate", "obsess". Measured
  // 2026-07-17: Mehek's ENTIRE bank, all 7 entries and 409 words (nearly 3x what fits on one page),
  // covers 12-17% of that vocabulary. No resume she could physically write reaches 18%, so this
  // fired on 100% of generations and the retry could never clear it.
  //
  // That mattered for more than cost. The retry feeds these issues back to the model as "fix them
  // in this revision", so every generation was explicitly told "not tailored enough to this JD" and
  // responded the only way it could: by importing JD vocabulary into the skills line. This gate was
  // manufacturing the R-015 fabrication it was supposed to be unrelated to.
  //
  // Left as a warning rather than recalibrated because the number is not just mis-scaled, it barely
  // discriminates: measured against a matching JD vs a wholly mismatched one it separates them by
  // ~2 points, and the obvious alternatives (repeated terms, top-N by frequency) score the
  // MISMATCHED JD higher. A metric worth gating on needs a real keyword model, which is a design
  // decision, not a threshold tweak. Until then, do not restore this as an issue by lowering
  // MIN_KEYWORD_COVERAGE: that buys a green check without making the resume any more tailored.
  const present = [...kw].filter((w) => allText.toLowerCase().includes(w)).length;
  const coveragePct = kw.size > 0 ? Math.round((100 * present) / kw.size) : 100;
  if (coveragePct < MIN_KEYWORD_COVERAGE) {
    warnings.push({
      entry: 'ats',
      bullet: '',
      flags: [`low-keyword-coverage(${coveragePct}% < ${MIN_KEYWORD_COVERAGE}%)`],
    });
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
      } else if (v.kind === 'claim') {
        issues.push(`grounding: a ${v.entry} bullet is not supported by any stored source bullet`);
      } else {
        issues.push(`grounding: metric "${v.detail}" in a ${v.entry} bullet is not in the experience bank ("${(v.bullet ?? '').slice(0, 40)}")`);
      }
    }
    // With a declared skills list the check is enforceable, so an off-list skill is a HARD issue
    // that drives the retry loop: the student said what they know, and the resume claiming more
    // than that is a false statement about them, not a quality nit. Without one there is nothing
    // authoritative to check against, so it stays a warning - see findUngroundedSkills.
    // skill_source deliberately not passed while renaming is disabled: see pruneUngroundedContent.
    // A rename the model emits against the prompt's ban must surface as a hard issue and drive the
    // retry, whose feedback line below already tells it the fix (use the list verbatim).
    const ungroundedSkills = findUngroundedSkills(spec.skills, bank, declaredSkills);
    if (declaredSkills?.length) {
      for (const skill of ungroundedSkills) {
        issues.push(`grounding: skill "${skill}" is not in the student's skills list; never add a skill because the JD asks for it`);
      }
    } else {
      for (const skill of ungroundedSkills) {
        warnings.push({ entry: 'skills', bullet: skill, flags: ['ungrounded-skill'] });
      }
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
  // The zero-em-dash rule (validate_resume.py enforces the same), checked on what actually
  // RENDERED rather than trusting the spec-level prompt. This check existed in spirit but could
  // never fire while the post-render parse threw on every resume (R-017); it is the seeded
  // violation the R-017 regression test drives end to end.
  if (extractedText.includes('\u2014')) issues.push('Rendered PDF contains an em dash (banned punctuation)');
  return { issues, page_count: pageCount, extractable_chars: extractedText.trim().length };
}
