import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles, application_profile, targeting } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { readExperienceBank } from '../db/experienceBank';
import {
  baseResumeSelectionIssues,
  generateBaseResumeSpec,
  priorityEntriesForBaseResume,
  type BaseResumeEvent,
} from '../llm/baseResume';
import {
  applyResumePolicy,
  enforceExperienceBulletFloor,
  normalizeDashesForPrint,
  type CandidateEducation,
} from '../engine/resumePolicy';
import {
  findPdfSafeMarginIssues,
  findPdfTextFidelityIssues,
  renderResumePdf,
  type ContactHeader,
} from '../engine/resumeRender';
import { extractPdfText } from '../lib/pdfText';
import {
  BULLET_MAX_CHARS,
  validateResumeSpec,
  validatePdfLayout,
  pruneUngroundedContent,
  weakVerbBullets,
} from '../engine/resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';

/* GET /resume/base        - the stored base resume, or 404 if never built.
 * POST /resume/base/stream - build it, streaming each piece as it is decided (SSE).
 *
 * WHY SSE AND NOT A PLAIN 200.
 * The build takes 10-25 seconds. A plain request would show a spinner for all of it and then paint
 * a finished resume, which is both a worse wait and a less honest one: the student has no way to
 * see WHAT we understood from their upload until it is too late to feel like a process. Streaming
 * the pieces as the model decides them turns the wait into the explanation.
 *
 * Every stage this emits corresponds to work that actually happened. There is no timer driving a
 * fake sequence, and there is deliberately no percentage: the number of entries is not known until
 * the model has chosen them, so any percentage would be a guess dressed as a measurement. The
 * client draws position, never progress (DESIGN.md Guardrails).
 */

const REQUEST_DEADLINE_MS = 120_000; // vercel.json allows 300s; this is the model-call bound.
/* The point past which another verb pass cannot finish inside the function's 300s. One more model
 * call can take REQUEST_DEADLINE_MS, and the render plus PDF parse plus checks after it need room
 * of their own, so the loop stops well before the ceiling rather than at it. */
const VERB_PASS_BUDGET_MS = 140_000;

/* A short menu of approved verbs, handed to the model when a rewrite pass fails.
 *
 * Chosen to span the KINDS of work students actually describe rather than to be a best-of list:
 * operations and service, people, analysis, building, and writing. The bullets that stall are
 * almost always operational ones ("Stocked and handled food items"), which is exactly where a
 * software-flavoured suggestion is no help. Every entry is on STRONG_VERBS. */
export const VERB_SUGGESTIONS = [
  'Managed', 'Organized', 'Coordinated', 'Processed', 'Administered',
  'Delivered', 'Prepared', 'Trained', 'Supervised', 'Facilitated',
  'Analyzed', 'Evaluated', 'Tracked', 'Documented',
  'Built', 'Designed', 'Improved', 'Streamlined',
];

type Stage =
  | 'reading'
  | 'selecting'
  | 'writing'
  | 'polishing'
  | 'fitting'
  | 'checking'
  | 'done'
  | 'failed';

/** The ATS verdict, reported on every build whether it passes or not. */
export interface AtsVerdict {
  passed: boolean;
  issues: string[];
  pages: number;
  extractable_chars: number;
  keyword_coverage_pct: number;
  scored_against: string;
}

/** One SSE frame. `stage` events narrate, the rest carry spec data the client paints immediately. */
type StreamFrame =
  | { event: 'stage'; stage: Stage; detail?: string }
  | { event: 'source'; bank_entries: number; source_pages: number; declared_skills: number }
  // Clears what the client has painted, so a retry's shorter pass cannot leave stale entries.
  | { event: 'restart' }
  | ({ event: 'piece' } & BaseResumeEvent)
  | ({ event: 'ats' } & AtsVerdict)
  | {
      event: 'done';
      spec: ResumeSpec;
      warnings: string[];
      ats: AtsVerdict;
      // Bullets with no number in them, so /start can ask the student for the few that matter.
      metrics: Array<{ org: string; title: string; date_range: string; bullet: string }>;
      built_at: string;
    }
  | { event: 'error'; message: string };

function readSourcePages(parsed: unknown): number {
  const pages = (parsed as { source_pages?: unknown } | null)?.source_pages;
  return typeof pages === 'number' && Number.isFinite(pages) && pages > 0 ? pages : 0;
}

/* The skills list to build from: the student's DECLARED list, falling back to the one their resume
 * printed.
 *
 * THE FALLBACK IS THE WHOLE POINT. profiles.skills is the declared column, and at onboarding it is
 * NULL for literally every student - the screen that collects it comes later. This build read only
 * that column, so the base resume was always generated in NON-declared mode, where the skills line
 * is grounded loosely against bullet text instead of against a list. The model filled the gap the
 * way models do.
 *
 * Measured 2026-07-27 on a real Cal Poly computer science resume: the parse read eighteen skills off
 * the page - C, C++, CSS, Git, HTML, Java, Python, Swift, SQL, Xcode, Vim, RStudio and more - and
 * the base resume printed NINE, of which zero appeared anywhere on the student's resume. "Swift" and
 * "Xcode" had become "iOS Development", "C" had become "Systems Programming", and "JSON" had become
 * "JSON Parsing". Every one of those is arguably true, and that is exactly the trap R-015 named: a
 * specific claim laundered into a broad one is ungrounded even when it lands on a true answer.
 *
 * Passing the parsed list puts the build back in declared mode, where the list is authoritative and
 * pruneUngroundedContent drops anything not verbatim on it. This mirrors the precedence GET /profile
 * has always served (serveProfileJson: declared first, parsed as the fallback), so the base resume
 * stops being the one place in the product that ignores what the resume said.
 */
export function skillsSourceFor(declared: unknown, parsed: unknown): string[] | null {
  const strings = (value: unknown): string[] =>
    (Array.isArray(value) ? value : []).filter(
      (s): s is string => typeof s === 'string' && s.trim().length > 0,
    );
  const own = strings(declared);
  if (own.length > 0) return own;
  const fromResume = strings((parsed as { skills?: unknown } | null)?.skills);
  // null, not [], when there is nothing either way: an empty array would put pruning into declared
  // mode against an empty authority and strip the skills line to nothing.
  return fromResume.length > 0 ? fromResume : null;
}

/* The header the ATS check renders and then looks for in the extracted text.
 *
 * Most of it is empty at this point in onboarding, and that is correct rather than a gap: the
 * harvest fills phone and links from the first real application. findPdfTextFidelityIssues only
 * asserts the fields that are actually present, so an empty phone is not a failure - it is a line
 * the resume does not print yet. */
export function contactHeaderFrom(
  parsed: unknown,
  appProfile: Record<string, unknown> | undefined,
  email: string | undefined,
): ContactHeader {
  const p = (parsed ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
  return {
    full_name: str(p.full_name) ?? 'Applicant',
    email: email ?? str(p.email),
    // Links are plaintext on application_profile (not in ENCRYPTED_FIELDS), so they read directly.
    linkedin_url: str(appProfile?.linkedin_url),
    github_url: str(appProfile?.github_url),
    portfolio_url: str(appProfile?.portfolio_url),
  };
}

/* A stand-in for the posting the base resume does not have: the roles the student says they want.
 *
 * Titles first, because a student typed them. Categories are slugs, so their hyphens become spaces
 * or the keyword scorer sees "software-engineering" as one unmatchable token. The parse's inferred
 * target_roles come last as the fallback for a student who has not reached the targeting screen,
 * which at the base step is most of them. */
export function targetRoleText(
  target: { titles?: unknown; categories?: unknown } | undefined,
  parsed: unknown,
): string {
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  const parts = [
    ...list(target?.titles),
    ...list(target?.categories).map((c) => c.replace(/-/g, ' ')),
    ...list((parsed as { target_roles?: unknown } | null)?.target_roles),
  ];
  return [...new Set(parts.map((p) => p.trim()))].join('. ');
}

/* Bullets carrying no number at all, worst first, for the screen that asks the student to supply
 * one. A resume bullet without a metric is not wrong, it is just weaker than the same bullet with
 * one, and the student is the only person who knows the number.
 *
 * Capped at five and sorted longest-first: a long bullet with no number is describing something
 * substantial and is where a metric buys the most. Asking for every one of them turns onboarding
 * into a form - a federal-style resume has fifteen - and drop-off is the real risk. */
export function metricGapsIn(
  spec: ResumeSpec,
  limit = 5,
): Array<{ org: string; title: string; date_range: string; bullet: string }> {
  const hasNumber = /\d/;
  /* title and date_range travel with the gap so the ask can SAY which role it means. Two stints at
   * one employer can carry the same duty line, and an unlabelled pair of identical prompts gives the
   * student no way to tell which is which - so a number meant for one lands on the other. */
  const gaps: Array<{ org: string; title: string; date_range: string; bullet: string }> = [];
  for (const entry of spec.experience ?? []) {
    for (const bullet of entry.bullets ?? []) {
      if (!hasNumber.test(bullet)) {
        gaps.push({ org: entry.org, title: entry.title ?? '', date_range: entry.date_range ?? '', bullet });
      }
    }
  }
  return gaps.sort((a, b) => b.bullet.length - a.bullet.length).slice(0, limit);
}

function educationFrom(parsed: unknown): CandidateEducation {
  const p = (parsed ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    school: str(p.school) ?? '',
    degree: str(p.degree),
    grad_date: str(p.grad_date) ?? (typeof p.grad_year === 'number' && p.grad_year > 0 ? String(p.grad_year) : undefined),
    grad_year: typeof p.grad_year === 'number' ? p.grad_year : undefined,
    currently_enrolled: typeof p.currently_enrolled === 'boolean' ? p.currently_enrolled : undefined,
    coursework: Array.isArray(p.coursework) ? p.coursework.filter((c): c is string => typeof c === 'string') : undefined,
  };
}

/* A hand-edited spec, made safe to store.
 *
 * Whatever arrives at PUT /resume/base is USER TEXT, and it goes into the one document every
 * tailored resume is built from (resume.ts reads base_resume_json as its starting point). It used to
 * be stored exactly as sent, which routed around every rule the build had enforced seconds earlier:
 * the em-dash ban, the bullet length cap, the one-page fit. An em dash typed into the metrics box on
 * /start would therefore fail validatePdfLayout on every FUTURE resume, with nothing to connect the
 * two for the student.
 *
 * The dash substitution is the same deterministic pass the build runs, so an edit and a build cannot
 * disagree about punctuation. An over-long bullet is REJECTED rather than truncated: this is the
 * student's own wording, and silently cutting it mid-sentence is worse than saying no.
 */
export function sanitizeEditedSpec(raw: unknown): { spec?: ResumeSpec; error?: string } {
  const spec = normalizeDashesForPrint(raw) as ResumeSpec;
  const tooLong = (spec.experience ?? [])
    .flatMap((entry) => (entry.bullets ?? []).map((bullet) => ({ org: entry.org, bullet })))
    .find(({ bullet }) => typeof bullet === 'string' && bullet.length > BULLET_MAX_CHARS);
  if (tooLong) {
    return {
      error: `One bullet in ${tooLong.org} is longer than ${BULLET_MAX_CHARS} characters and will not fit the page. Shorten it and save again.`,
    };
  }
  return { spec };
}

export async function baseResumeRoutes(fastify: FastifyInstance) {
  fastify.get('/resume/base', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const [profile] = await db.select().from(profiles).where(eq(profiles.user_id, userId));
    if (!profile?.base_resume_json) {
      return reply.status(404).send({ error: 'No main resume yet' });
    }
    return reply.status(200).send({
      spec: profile.base_resume_json,
      built_at: profile.base_resume_built_at,
      source_pages: readSourcePages(profile.parsed_json),
    });
  });

  fastify.post('/resume/base/stream', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const email = request.jwtPayload!.email;
    // appProfile and target are read for the ATS gate: the first supplies the contact lines the
    // rendered PDF must round-trip, the second the roles its keyword coverage is scored against.
    const [[profile], bank, [appProfile], [target]] = await Promise.all([
      db.select().from(profiles).where(eq(profiles.user_id, userId)),
      readExperienceBank(userId),
      db.select().from(application_profile).where(eq(application_profile.user_id, userId)),
      db.select().from(targeting).where(eq(targeting.user_id, userId)),
    ]);

    // Fail BEFORE opening the stream. A 400 the client can read is worth more than an SSE
    // connection whose first and only frame is an error, and this is the same precondition
    // /resume/generate enforces - a bank with no entries cannot produce a grounded resume.
    if (!profile?.parsed_json) {
      return reply.status(400).send({ error: 'Upload a resume first' });
    }
    if (bank.length === 0) {
      return reply.status(400).send({ error: 'No experience entries to build from' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Vercel and most reverse proxies buffer a response body by default, which would hold every
      // frame until the stream closed and silently turn this back into the plain 200 it exists to
      // avoid. The stream still WORKS without it; it just stops being a stream.
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    const send = (frame: StreamFrame) => {
      if (closed) return;
      reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
    };

    const education = educationFrom(profile.parsed_json);
    const declaredSkills = skillsSourceFor(profile.skills, profile.parsed_json);
    const targetText = targetRoleText(target, profile.parsed_json);
    const recentReview = (profile.parsed_json as {
      recent_experience_review?: { selected_entry_id?: string | null; continue_with_found?: boolean };
    } | null)?.recent_experience_review;
    const selectedEntryId = recentReview?.selected_entry_id;
    const priorityEntries = priorityEntriesForBaseResume(bank, targetText, selectedEntryId);

    try {
      send({ event: 'stage', stage: 'reading' });
      send({
        event: 'source',
        bank_entries: bank.length,
        source_pages: readSourcePages(profile.parsed_json),
        declared_skills: declaredSkills?.length ?? 0,
      });

      send({ event: 'stage', stage: 'selecting' });

      const generate = async (feedback?: string[]) => {
        let sawFirstEntry = false;
        return generateBaseResumeSpec(
          bank,
          education,
          declaredSkills,
          (piece: BaseResumeEvent) => {
            // The transition from choosing entries to writing them is observable rather than
            // timed: the first completed entry IS the moment selection finished.
            if (piece.type === 'entry' && !sawFirstEntry) {
              sawFirstEntry = true;
              send({ event: 'stage', stage: 'writing' });
            }
            send({ event: 'piece', ...piece });
          },
          { timeoutMs: REQUEST_DEADLINE_MS, feedback, priorityEntries },
        );
      };

      const buildStartedAt = Date.now();
      let rawSpec = await generate();

      /* THE HARD RULES, enforced until they hold.
       *
       * Every bullet opens with a strong action verb, and this loop is what makes that true rather
       * than merely reported. It used to run ONCE and then ship whatever came back, so a student
       * whose second pass still opened a bullet with "Maintained" got the violation written into
       * their stored base resume with a note underneath it. Measured across 30 real resumes on
       * 2026-07-27: the single retry failed to converge on 4 of them.
       *
       * PARAPHRASE IS THE POINT. The model is explicitly allowed to reword a bullet to reach a
       * strong opener, because the alternative is not a weaker verb, it is a resume that breaks the
       * house rule. What it may never do is invent a fact, which is what the grounding pass below
       * still checks independently.
       *
       * Bounded at three passes. Two is not enough (measured), and past three the bank's own wording
       * is the problem, at which point the honest move is to show the student what we produced and
       * let them fix it in the editor rather than loop burning model calls forever.
       */
      const MAX_VERB_PASSES = 3;
      for (let pass = 1; pass <= MAX_VERB_PASSES; pass += 1) {
        const weak = weakVerbBullets(rawSpec);
        const missingPriorities = baseResumeSelectionIssues(rawSpec, priorityEntries);
        if (weak.length === 0 && missingPriorities.length === 0) break;
        /* REQUEST_DEADLINE_MS bounds one model call, not the request. Three retries plus the first
         * pass is 480s of model time against vercel.json's maxDuration of 300, and blowing that
         * kills the function mid-stream: the client gets a truncated SSE with neither a done nor an
         * error frame, and the finally never runs. So the loop stops when there is no longer room
         * for another call plus the render and check that have to follow it. */
        if (Date.now() - buildStartedAt > VERB_PASS_BUDGET_MS) {
          fastify.log.warn({ userId, pass }, 'out of time for another verb pass; shipping with warnings');
          break;
        }
        send({ event: 'stage', stage: 'polishing' });
        // The client paints entries positionally, so it has to clear before the re-stream or a
        // shorter later pass would leave stale entries from the first behind.
        send({ event: 'restart' });
        rawSpec = await generate([
          weak.length > 0
            ? `These bullets do not open with a strong action verb: ${weak
              .map((w) => `"${w.verb}" in ${w.org}`)
              .join('; ')}.`
            : '',
          missingPriorities.length > 0
            ? `The previous selection displaced required current or role-defining work: ${missingPriorities.join('; ')}. Include every REQUIRED PRIORITY ENTRY, even when its source has only one grounded bullet.`
            : '',
          weak.length > 0
            ? 'Rewrite each weak opener with an approved strong verb. You may paraphrase freely to get there, but keep every fact and number exactly as it is.'
            : '',
          /* Naming candidates, not just the rule. The whole approved list is already in the system
           * prompt and the model still returned "Stocked" three passes running on a food-service
           * bullet (measured 2026-07-27), so repeating "use an approved verb" a fourth time was not
           * the missing ingredient. A short concrete menu beside the offending word is. */
          weak.length > 0
            ? `For each weak opener, pick whichever of these fits the action best: ${VERB_SUGGESTIONS.join(', ')}.`
            : '',
          weak.length > 0 && pass > 1
            ? 'A previous attempt at this failed. Do not reuse the opener you used last time for these bullets.'
            : '',
        ].filter(Boolean));
      }

      send({ event: 'stage', stage: 'fitting' });

      // The same deterministic pass the tailored path runs, which is the point: education placement,
      // the 3-bullet cap and the 4-entry cap are ONE implementation, so a base resume and a tailored
      // resume can never disagree about what the house format is. `applyResumePolicy` ignores its
      // jdText argument entirely, so there is nothing to fake here.
      const { spec: policiedSpec } = applyResumePolicy(rawSpec, education, bank, '', { now: new Date() });

      // Grounding is not optional just because there is no JD to over-fit to. A base resume is the
      // one a student is most likely to send unread, so an ungrounded claim here is more dangerous
      // than in a tailored resume they at least glanced at.
      const pruned = pruneUngroundedContent(policiedSpec, bank, declaredSkills);
      const spec = enforceExperienceBulletFloor(pruned.spec, bank, {
        priorityEntryId: selectedEntryId,
        allowSparsePriority: recentReview?.continue_with_found === true,
      });
      const removed = pruned.removed;
      /* The base resume has no posting, so its keyword coverage is scored against the roles the
       * student says they are chasing (targeting titles and categories, plus the target_roles the
       * parse inferred). That number is ADVISORY and never gates: a synthetic JD is a guess at what
       * they will apply to, and gating on it would push generic keyword-stuffing into the one resume
       * they are most likely to send unread. It is reported so they can see it, nothing more. */
      const warnings = [...removed];

      /* THE ATS GATE. Every resume this product produces goes through it, and until now the base
       * resume was the one that did not: it was stored as a spec and never rendered, so none of the
       * post-render checks the tailored path runs had anything to run against. A resume that is not
       * machine-readable is not a resume, and the student would have found that out from an employer.
       *
       * Fails CLOSED, including when the check itself cannot run. An unverified PDF stored as though
       * it passed is exactly R-017's failure mode, and a spec saved behind a check that silently
       * threw is the same lie in a different place. */
      send({ event: 'stage', stage: 'checking' });
      const contact = contactHeaderFrom(profile.parsed_json, appProfile, email);
      let ats: AtsVerdict;
      /* What the renderer actually PRINTED, which is not always what it was handed: planResumeLayout
       * trims to make one page (a third bullet, then whole entries, then coursework, then skills).
       * Checking the untrimmed spec against the printed text asks the PDF to contain lines the
       * trimmer just removed, so any student whose content overflowed a page failed the gate and was
       * stranded at this step - deterministically, so a rebuild would not clear it. resume.ts has
       * always reassigned `spec = rendered.spec` here; this route was the one that did not. */
      let printed = spec;
      try {
        const rendered = await renderResumePdf(spec, contact, targetText);
        printed = rendered.spec;
        const parsedPdf = await extractPdfText(rendered.buffer);
        const layout = validatePdfLayout(parsedPdf.text, parsedPdf.numpages);
        const finalValidation = validateResumeSpec(
          printed,
          targetText,
          bank,
          declaredSkills,
          education,
          undefined,
          {
            allowedSingleBulletEntries: recentReview?.continue_with_found && priorityEntries[0]
              ? [priorityEntries[0]]
              : [],
          },
        );
        const issues = [
          ...finalValidation.issues,
          ...baseResumeSelectionIssues(printed, priorityEntries),
          ...layout.issues,
          ...findPdfSafeMarginIssues(parsedPdf.pages, rendered.layout),
          ...findPdfTextFidelityIssues(parsedPdf.text, printed, contact),
        ];
        ats = {
          passed: issues.length === 0,
          issues,
          pages: layout.page_count,
          extractable_chars: layout.extractable_chars,
          keyword_coverage_pct: finalValidation.ats_keyword_coverage_pct,
          scored_against: targetText ? 'target roles' : 'nothing on file',
        };
      } catch (err) {
        fastify.log.error({ err, userId }, 'ATS CHECK DID NOT RUN on a base resume; refusing to store it'); // vocab-allow: server log
        ats = {
          passed: false,
          issues: ['the ATS check could not run on this resume, so it was not saved'],
          pages: 0,
          extractable_chars: 0,
          keyword_coverage_pct: 0,
          scored_against: 'nothing on file',
        };
      }

      send({ event: 'ats', ...ats });

      if (!ats.passed) {
        send({ event: 'stage', stage: 'failed' });
        send({
          event: 'error',
          message: `This resume did not pass the ATS check, so it has not been saved: ${ats.issues.join('; ')}`,
        });
        return;
      }

      const builtAt = new Date();
      await db
        .update(profiles)
        .set({ base_resume_json: printed, base_resume_built_at: builtAt, updated_at: builtAt })
        .where(eq(profiles.user_id, userId));

      send({ event: 'stage', stage: 'done' });
      send({
        event: 'done',
        spec: printed,
        warnings,
        ats,
        // New uploads already received the specific, evidence-grounded impact prompt. Asking for
        // numbers again here would duplicate that work and make the base-resume step feel broken.
        metrics: selectedEntryId ? [] : metricGapsIn(printed),
        built_at: builtAt.toISOString(),
      });
    } catch (err) {
      fastify.log.error(err);
      send({ event: 'stage', stage: 'failed' });
      send({
        event: 'error',
        message: err instanceof Error ? err.message : 'Could not make your main resume',
      });
    } finally {
      if (!closed) reply.raw.end();
    }
  });

  // Manual correction. The student owns the base resume, so editing it must not require a rebuild:
  // a rebuild would discard their edit in favour of whatever the model picks next.
  fastify.put('/resume/base', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const body = request.body as { spec?: unknown } | undefined;
    if (!body?.spec || typeof body.spec !== 'object') {
      return reply.status(400).send({ error: 'A spec is required' });
    }
    /* Whatever arrives here is USER TEXT, and it goes into the one document every tailored resume is
     * built from (resume.ts reads base_resume_json as its starting point). It used to be stored
     * exactly as sent, which routed around every rule the build had just enforced two seconds
     * earlier: the em-dash ban, the bullet length cap, the one-page fit. An em dash typed into the
     * metrics box on /start would therefore fail validatePdfLayout on every FUTURE resume, and the
     * student would have no way to connect the two.
     *
     * The dash substitution is the same deterministic pass the build runs, so an edit and a build
     * cannot disagree about punctuation. Over-long bullets are rejected rather than truncated: this
     * is the student's own wording and silently cutting it mid-sentence is worse than saying no. */
    const { spec, error } = sanitizeEditedSpec(body.spec);
    if (error) return reply.status(400).send({ error });

    const builtAt = new Date();
    const [updated] = await db
      .update(profiles)
      .set({ base_resume_json: spec, base_resume_built_at: builtAt, updated_at: builtAt })
      .where(eq(profiles.user_id, userId))
      .returning({ built_at: profiles.base_resume_built_at });
    if (!updated) return reply.status(404).send({ error: 'No such profile' });
    return reply.status(200).send({ ok: true, built_at: updated.built_at });
  });
}
