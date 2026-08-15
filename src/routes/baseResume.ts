import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles, application_profile, targeting } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { MODEL_UNAVAILABLE_MESSAGE, isModelUnavailable } from '../lib/llmFailure';
import { readExperienceBank } from '../db/experienceBank';
import {
  baseResumeSelectionIssues,
  generateBaseResumeSpec,
  priorityEntriesForBaseResume,
  type BaseResumeEvent,
} from '../llm/baseResume';
import {
  applyResumePolicy,
  educationFrom,
  enforceExperienceBulletFloor,
  normalizeDashesForPrint,
  type CandidateEducation,
} from '../engine/resumePolicy';
import { academicRecordRowFor } from './profile';
import {
  findPdfSafeMarginIssues,
  findPdfTextFidelityIssues,
  hasContactRoute,
  renderResumePdf,
  ResumeContactError,
  type ContactHeader,
} from '../engine/resumeRender';
import { extractPdfText } from '../lib/pdfText';
import {
  BULLET_MAX_CHARS,
  validateResumeSpec,
  validatePdfLayout,
  pruneUngroundedContent,
  weakVerbBullets,
  overlongBullets,
} from '../engine/resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';
import { openSseResponse, trackSseConnection } from '../lib/sseResponse';
import { selectApplicationProfileRow } from '../lib/applicationFacts';
import { resumeEmailOfRecord } from '../lib/resumeEmail';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';

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
/* The point past which another repair pass cannot finish inside the function's 300s. One more model
 * call can take REQUEST_DEADLINE_MS, and the render plus PDF parse plus checks after it need room
 * of their own, so the loop stops well before the ceiling rather than at it. */
const REPAIR_PASS_BUDGET_MS = 140_000;

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
 * the resume does not print yet.
 *
 * TAKES THE DECRYPTED ROW NOW, not the raw one. It always read the three link columns, which are
 * plaintext, and skipped phone, which is in ENCRYPTED_FIELDS and would have printed base64 on the
 * PDF straight off the raw row. So the main resume never carried the phone number the account had
 * on file, which stopped being merely a thin header the day renderResumePdf started refusing a
 * document with no way to reply on it: an account whose only contact fact is a stored phone could
 * otherwise not build a main resume at all. Links read identically either way, since decryptRow
 * passes every non-encrypted column through untouched. */
export function contactHeaderFrom(
  parsed: unknown,
  appProfile: Record<string, unknown> | undefined,
  email: string | undefined,
): ContactHeader {
  const p = (parsed ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
  return {
    full_name: str(p.full_name) ?? 'Applicant',
    email,
    phone: str(appProfile?.phone),
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

/* MOVED to engine/resumePolicy.ts, beside CandidateEducation and the academic precedence it now
 * applies, so the tailored path can call the same function instead of keeping its own inline copy.
 * Re-exported rather than relocated silently: this is the import path every existing caller and
 * test already uses, and a route module is not where a rule shared by two routes belongs. */
export { educationFrom } from '../engine/resumePolicy';

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
  // Authenticated, deterministic render of the saved base resume. This does no AI work, consumes
  // no trial allowance, and remains available to every account for Free application filling.
  fastify.get('/resume/base/file', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const [profile] = await db.select().from(profiles).where(eq(profiles.user_id, userId));
    if (!profile?.base_resume_json) return reply.status(404).send({ error: 'No main resume yet' });
    const applicationProfile = await loadApplicationProfileLike(userId);
    const contact = contactHeaderFrom(
      profile.parsed_json,
      applicationProfile as unknown as Record<string, unknown>,
      resumeEmailOfRecord(profile.parsed_json) ?? request.jwtPayload!.email,
    );
    try {
      const rendered = await renderResumePdf(
        profile.base_resume_json as ResumeSpec,
        contact,
        'General application resume',
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'attachment; filename="litos-base-resume.pdf"')
        .send(rendered.buffer);
    } catch (error) {
      request.log.error({ error, userId }, 'saved main resume could not be rendered for Free filling');
      return reply.status(422).send({ error: 'Your main resume needs review before it can be attached.' });
    }
  });

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
    const [[profile], bank, appProfile, [target]] = await Promise.all([
      db.select().from(profiles).where(eq(profiles.user_id, userId)),
      readExperienceBank(userId),
      // Tolerant read, see lib/applicationFacts.ts.
      selectApplicationProfileRow(userId),
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

    // Includes the CORS headers installed by Fastify. Writing directly to reply.raw with only the
    // stream headers strips those hook-managed headers, so the browser hides the successful 200 as
    // a network-level failure.
    openSseResponse(reply);
    const connection = trackSseConnection(request, reply);

    const send = (frame: StreamFrame) => {
      if (connection.closed) return;
      reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
    };

    /* Decrypted ONCE for the two blocks that read it: the academic record and the contact header.
       Both are printed on this PDF and both used to be resolved separately, the header off the raw
       row (which is why it never carried the phone). */
    const applicationRecord = academicRecordRowFor(appProfile, (err) =>
      request.log.error(
        { err, userId },
        'application_profile could not be decrypted while building the main resume. Printing no GPA and no stored phone rather than the resume parse, which is not the source of truth for either.',
      ),
    );

    /* appProfile, not just the parse. The GPA that reaches this PDF has to be the one the student
       stated and the one autofill types, and the base resume is the document she approves before
       any of them go out. */
    const education = educationFrom(profile.parsed_json, applicationRecord);
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
       *
       * LENGTH IS REPAIRED HERE TOO, for the same reason the verb is. The generation prompt asks for
       * "under 235 characters" in prose and this loop used to ignore the answer, so a bullet four
       * characters over walked through all three passes and died at the ATS gate below, which fails
       * closed: nothing was stored, and the student's only remaining move was to re-roll the model
       * and hope. Trimming is the one repair the model is reliably good at, and it is strictly
       * cheaper to ask for it here than to throw the whole build away.
       */
      const MAX_REPAIR_PASSES = 3;
      for (let pass = 1; pass <= MAX_REPAIR_PASSES; pass += 1) {
        const weak = weakVerbBullets(rawSpec);
        const overlong = overlongBullets(rawSpec);
        const missingPriorities = baseResumeSelectionIssues(rawSpec, priorityEntries);
        if (weak.length === 0 && overlong.length === 0 && missingPriorities.length === 0) break;
        /* REQUEST_DEADLINE_MS bounds one model call, not the request. Three retries plus the first
         * pass is 480s of model time against vercel.json's maxDuration of 300, and blowing that
         * kills the function mid-stream: the client gets a truncated SSE with neither a done nor an
         * error frame, and the finally never runs. So the loop stops when there is no longer room
         * for another call plus the render and check that have to follow it. */
        if (Date.now() - buildStartedAt > REPAIR_PASS_BUDGET_MS) {
          fastify.log.warn({ userId, pass }, 'out of time for another repair pass; shipping with warnings');
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
          /* Naming the bullet AND the overage. "Shorten your bullets" is the instruction the prompt
           * already gives and the model already believes it followed, so the feedback that changes
           * the outcome is the count it got wrong and the exact text to cut. The WHOLE bullet goes
           * back, not an excerpt: the model is being asked to rewrite it, and it cannot trim what it
           * cannot see. */
          overlong.length > 0
            ? `These bullets are too long and will not fit the page: ${overlong
              .map((b) => `${b.org} at ${b.length} characters (${b.length - BULLET_MAX_CHARS} over the ${BULLET_MAX_CHARS} limit): "${b.bullet}"`)
              .join('; ')}.`
            : '',
          /* Cut words, not facts. The grounding pass below independently rejects anything invented,
           * but a dropped number is not invention and would survive it, so the constraint has to be
           * stated here: trimming a bullet must never be a route to losing the metric that earns it
           * its place. */
          overlong.length > 0
            ? `Rewrite each one to under ${BULLET_MAX_CHARS} characters. Cut filler words and redundant phrasing, and keep every number, tool and outcome exactly as it is. Do not drop a metric to make room.`
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
      /* THE ACCOUNT EMAIL IS A RESUME EMAIL, and leaving it out of this line blocked nearly every
       * account in production.
       *
       * `resumeEmailOfRecord` reads only `parsed_json.resume_email`, which nothing in onboarding
       * ever writes: measured 2026-08-16, 16 of 17 production profiles have none. So this resolved
       * to undefined, `contactHeaderFrom` built a header with NO email, the renderer printed a
       * resume an employer cannot reply to by mail, and the gate below then refused to save it. The
       * student was told to "add a personal resume email to your profile" while looking at a
       * preview with their own address printed on it, because /start passes the login email to the
       * PREVIEW (app/start/page.tsx) even though the server never put it in the document.
       *
       * The fallback is not new and not invented here. `GET /resume/base/file`, 240 lines up in
       * this same file, has always read `resumeEmailOfRecord(...) ?? request.jwtPayload!.email`.
       * Two routes answering one question two ways is the whole defect; this makes them agree.
       *
       * The login email is the student's own address, NOT a portal routing alias. Aliases live in
       * application_email_aliases and never reach `users.email`, so the separation that
       * resumeEmail.ts's comment protects is untouched. */
      const resumeEmail = resumeEmailOfRecord(profile.parsed_json) ?? request.jwtPayload!.email;
      const contact = contactHeaderFrom(
        profile.parsed_json,
        applicationRecord,
        resumeEmail,
      );
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
          /* CAN AN EMPLOYER REPLY TO THIS DOCUMENT? That is the question worth failing a resume
           * over, and it is the one this check asked before 861e767 (2026-08-11) narrowed it to a
           * single stored field.
           *
           * Gating on `!resumeEmail` alone blocks a guest, who has no login email to fall back to
           * and no way to set one without an account, even when the resume carries a phone number
           * an employer can call. Most accounts in production are guests. The narrower rule also
           * said nothing true: it named a field the student could not see from that screen rather
           * than the consequence, which is that the document is unreachable.
           *
           * `hasContactRoute` is the renderer's own rule for the same question (engine/resumeRender
           * .ts) and it already refuses to draw a document with neither, so this reports the same
           * boundary rather than inventing a second, stricter one. */
          ...(!hasContactRoute(contact)
            ? ['this resume has no email address and no phone number on it, so an employer who reads it cannot reply. Add one in Documents, under Edit parsed details, then build it again']
            : []),
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
          /* The renderer's contact guard is told apart from a render fault, because the two ask
             different things of the student. "The check could not run" is a message about us and
             has no action in it; a missing email and phone is a fact about her profile that she,
             and only she, can fix. Same refusal either way - the resume is still not stored. */
          issues: [err instanceof ResumeContactError
            ? 'this resume has no email address and no phone number on it, so an employer who reads it cannot reply. Add one to your profile and build it again'
            : 'the ATS check could not run on this resume, so it was not saved'],
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
      /* This frame is printed to the student verbatim, so an upstream error may not pass through
         it. Anthropic's own words for an exhausted balance are "Please go to Plans & Billing to
         upgrade or purchase credits", which is addressed to us and would read to a student as
         either their problem or an invitation to pay someone. Say what is true and useful to the
         person reading it instead. See lib/llmFailure.ts. */
      send({
        event: 'error',
        message: isModelUnavailable(err)
          ? MODEL_UNAVAILABLE_MESSAGE
          : err instanceof Error ? err.message : 'Could not make your main resume',
      });
    } finally {
      if (!connection.closed) reply.raw.end();
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
