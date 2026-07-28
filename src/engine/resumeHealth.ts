import type { ResumeSpec } from '../llm/resumeSpec';
import { excerpt, BULLET_MAX_CHARS } from './resumeValidate';

/**
 * The resume health check the student sees.
 *
 * Every rule here already existed and already ran. They lived inside the generator's retry loop,
 * where their only reader was the model: a bullet with no metric, a weak opening verb, an
 * over-long line that will wrap to a third one. The student was shown the RESULT of those checks
 * (a resume) and never the checks, so they had no way to tell a resume that barely passed from one
 * that passed comfortably, and no way to act on the difference.
 *
 * WHY THIS IS A LIST OF NAMED CRITERIA AND NOT A SCORE
 *
 * Rezi's Resume Score grades 0-100 across 23 criteria and its review corpus is unanimous that the
 * named, prioritized fixes are the useful part; Jobscan's most common complaint is the opposite,
 * users hitting 80%+ and hearing nothing, because a single number invites you to optimize the
 * number. Litos already has ONE number, the JD match score, and it means something specific:
 * coverage of what this posting asked for. A second number competing with it would teach students
 * to average two things that measure different questions.
 *
 * So this returns findings, each naming the rule, the bullet it fired on, and what to do. Ordered
 * so the top item is the one worth fixing first.
 *
 * NOTHING HERE FAILS A RESUME. These are all quality signals, not gates. The hard gates (grounding,
 * one page, no em dash, extractable text) run in the generator and a resume cannot exist without
 * passing them, so reporting them to the student would be reporting a state they can never be in.
 */

export type HealthSeverity = 'fix' | 'consider';

export interface HealthFinding {
  /** Stable id, so the UI can key on it and a fix can be attributed. */
  rule: string;
  severity: HealthSeverity;
  /** One line, addressed to the student, naming the specific thing. */
  title: string;
  /** What to do about it. */
  action: string;
  /** The entry this fired on, when it fired on one. */
  org?: string;
  /** The offending text, trimmed for display. */
  bullet?: string;
}

export interface ResumeHealth {
  findings: HealthFinding[];
  /** How many bullets the resume has in total, so "3 of 9 bullets" is sayable. */
  bullet_count: number;
  /** Bullets carrying a number. The one count worth showing, because it is the one students act on. */
  quantified_count: number;
}

/**
 * A number that states a MAGNITUDE, not any digit.
 *
 * A bare /\d/ counted a version string and a four-digit year, so "Migrated the service to v2.1 in
 * 2025" read as quantified and its no-metric finding was suppressed, while quantified_count in the
 * header was inflated by bullets carrying no scale at all.
 */
const YEAR_OR_VERSION = /\bv?\d+(\.\d+)+\b|\b(19|20)\d{2}\b/g;
function hasMagnitude(bullet: string): boolean {
  return /\d/.test(bullet.replace(YEAR_OR_VERSION, ' '));
}

/**
 * Openings that are genuinely weak, as a closed list.
 *
 * NOT the inverse of STRONG_VERBS. resumeValidate.weakVerbBullets flags any bullet whose first word
 * is absent from an enumerated strong-verb list, which is the right bias when the reader is the
 * model inside a retry loop: a false positive there costs one regeneration. The reader here is the
 * student, and a false positive tells them to rewrite a good bullet. The first screenshot of this
 * panel flagged "Containerized six services with Docker..." as opening on a weak verb, because
 * "containerized" simply is not in the list. No enumeration of good verbs will ever be complete.
 *
 * These are the constructions that actually bury the work: they describe proximity to a task rather
 * than doing it. A closed list of those is small, stable, and can be defended line by line.
 */
export const WEAK_OPENERS = new Set(
  `responsible accountable tasked helped helping assisted assisting
participated involved worked working aided
attended shadowed observed learned studied familiarized
various several miscellaneous duties`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * "Responsible for X" and "Helped with X" open on their first word.
 *
 * 'facilitated', 'supported', 'contributed' and 'exposed' were removed from the list after review:
 * the first is in the generator's own STRONG_VERBS (so the panel contradicted the hard gate), and
 * the rest have ordinary transitive uses ("Exposed a REST API for 12 services") that this bare
 * first-word test cannot tell from the passive sense. 'exposed to' is the passive one, so it is
 * matched as a construction rather than as a word.
 */
function weakOpening(bullet: string): string | null {
  const words = bullet.trim().split(/\s+/);
  const raw = words[0] ?? '';
  const first = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (WEAK_OPENERS.has(first)) return raw;
  if (first === 'exposed' && (words[1] ?? '').toLowerCase() === 'to') return raw;
  return null;
}

export function checkResumeHealth(spec: ResumeSpec): ResumeHealth {
  const findings: HealthFinding[] = [];
  const bullets = (spec.experience ?? []).flatMap((e) =>
    (e.bullets ?? []).map((bullet) => ({ org: e.org, bullet })),
  );

  const quantified = bullets.filter(({ bullet }) => hasMagnitude(bullet));
  // When NOTHING is quantified, one summary finding says it better than N identical ones, and the
  // header's fix count stops double counting the same problem.
  const noneQuantified = bullets.length > 0 && quantified.length === 0;

  // ONE pass over the bullets, all rules applied per bullet, so push order is the order the bullets
  // appear on the page and a single bad bullet's findings sit together. Rule-major loops put every
  // no-metric above every weak-verb and scattered one bullet's findings down the list.
  for (const { org, bullet } of bullets) {
    if (!noneQuantified && !hasMagnitude(bullet)) {
      findings.push({
        rule: 'no-metric',
        // 'consider', not 'fix': the grounding pass DROPS any bullet whose number is not already in
        // the student's experience bank, so "add a number" as an instruction can delete the bullet
        // if they estimate one. The action says where the number has to come from.
        severity: 'consider',
        title: 'This bullet has no number in it.',
        action: 'If the work you told us about has the number, add it. Do not guess one.',
        org,
        bullet: excerpt(bullet, 90),
      });
    }

    const opener = weakOpening(bullet);
    if (opener) {
      findings.push({
        rule: 'weak-verb',
        severity: 'fix',
        title: `This bullet opens on "${opener}".`,
        action: 'Open on what you did, not on how close you were to it.',
        org,
        bullet: excerpt(bullet, 90),
      });
    }

    if (bullet.length > BULLET_MAX_CHARS) {
      findings.push({
        rule: 'too-long',
        severity: 'fix',
        title: `This bullet is ${bullet.length} characters and will wrap onto a third line.`,
        action: `Cut it to about ${BULLET_MAX_CHARS}. A third line costs you another bullet elsewhere.`,
        org,
        bullet: excerpt(bullet, 90),
      });
    }
  }

  // Structural observations, below the per-bullet fixes because they are judgement calls.
  if (noneQuantified) {
    findings.push({
      rule: 'no-metrics-anywhere',
      severity: 'fix',
      title: 'No bullet on this resume has a number in it.',
      action: 'Put a number from the work you told us about on your strongest bullet.',
    });
  }

  // An empty resume produced zero findings, so the panel rendered a full all-clear reading "All 0
  // bullets are quantified" on something the generator's validator treats as a hard failure.
  if (bullets.length === 0) {
    findings.push({
      rule: 'no-bullets',
      severity: 'fix',
      title: 'This resume has no bullets.',
      action: 'Add at least one role with what you did in it.',
    });
  }

  if ((spec.skills ?? []).length === 0) {
    findings.push({
      rule: 'no-skills',
      severity: 'consider',
      title: 'Your skills line is empty.',
      action: 'The robot that reads your resume looks here first. Add the tools you actually use.',
    });
  }

  for (const entry of spec.experience ?? []) {
    if ((entry.bullets ?? []).length === 0) {
      findings.push({
        rule: 'empty-entry',
        severity: 'consider',
        title: `${entry.org} has no bullets.`,
        action: 'A role with no bullets takes space and says nothing. Add one or drop the role.',
        org: entry.org,
      });
    }
  }

  // 'fix' before 'consider', and within each, source order, which is resume order. A student
  // reading top to bottom meets the findings in the order the bullets appear on their page.
  const weight = (f: HealthFinding) => (f.severity === 'fix' ? 0 : 1);
  findings.sort((a, b) => weight(a) - weight(b));

  return { findings, bullet_count: bullets.length, quantified_count: quantified.length };
}
