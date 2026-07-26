import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { readExperienceBank } from '../db/experienceBank';
import { generateBaseResumeSpec, type BaseResumeEvent } from '../llm/baseResume';
import { applyResumePolicy, type CandidateEducation } from '../engine/resumePolicy';
import { validateResumeSpec, pruneUngroundedContent, weakVerbBullets } from '../engine/resumeValidate';
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

type Stage =
  | 'reading'
  | 'selecting'
  | 'writing'
  | 'polishing'
  | 'fitting'
  | 'done'
  | 'failed';

/** One SSE frame. `stage` events narrate, the rest carry spec data the client paints immediately. */
type StreamFrame =
  | { event: 'stage'; stage: Stage; detail?: string }
  | { event: 'source'; bank_entries: number; source_pages: number; declared_skills: number }
  // Clears what the client has painted, so a retry's shorter pass cannot leave stale entries.
  | { event: 'restart' }
  | ({ event: 'piece' } & BaseResumeEvent)
  | { event: 'done'; spec: ResumeSpec; warnings: string[]; built_at: string }
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

export async function baseResumeRoutes(fastify: FastifyInstance) {
  fastify.get('/resume/base', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const [profile] = await db.select().from(profiles).where(eq(profiles.user_id, userId));
    if (!profile?.base_resume_json) {
      return reply.status(404).send({ error: 'No base resume yet' });
    }
    return reply.status(200).send({
      spec: profile.base_resume_json,
      built_at: profile.base_resume_built_at,
      source_pages: readSourcePages(profile.parsed_json),
    });
  });

  fastify.post('/resume/base/stream', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const [[profile], bank] = await Promise.all([
      db.select().from(profiles).where(eq(profiles.user_id, userId)),
      readExperienceBank(userId),
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
          { timeoutMs: REQUEST_DEADLINE_MS, feedback },
        );
      };

      let rawSpec = await generate();

      /* THE HARD RULE, enforced rather than merely reported.
       *
       * Every bullet opens with a strong action verb. The tailored path has always had a feedback
       * retry for this; the base path had none, so a weak opener was written into the student's
       * stored base resume and surfaced only as a note they could ignore. That is the one resume
       * most likely to be sent unread, so it is the worst place to let the rule slide.
       *
       * One retry, naming the exact offenders. Bounded because a second failure means the bank's
       * own wording is the problem, and at that point the honest move is to show the student what
       * we produced and let them rewrite it in the editor rather than loop burning model calls.
       */
      const weak = weakVerbBullets(rawSpec);
      if (weak.length > 0) {
        send({ event: 'stage', stage: 'polishing' });
        // The client paints entries positionally, so it has to clear before the re-stream or a
        // shorter second pass would leave stale entries from the first behind.
        send({ event: 'restart' });
        rawSpec = await generate([
          `These bullets do not start with a strong action verb from the allowed list. Rewrite each one to open with an approved verb, keeping the same facts: ${weak
            .map((w) => `"${w.verb}" in ${w.org}`)
            .join('; ')}`,
        ]);
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
      const { spec, removed } = pruneUngroundedContent(policiedSpec, bank, declaredSkills);
      // Empty jdText is correct, not a placeholder: the JD only drives keyword-coverage scoring,
      // which is meaningless without a posting. Every grounding and writing check still runs.
      const validation = validateResumeSpec(spec, '', bank, declaredSkills, education);
      const warnings = [...removed, ...validation.issues];

      const builtAt = new Date();
      await db
        .update(profiles)
        .set({ base_resume_json: spec, base_resume_built_at: builtAt, updated_at: builtAt })
        .where(eq(profiles.user_id, userId));

      send({ event: 'stage', stage: 'done' });
      send({ event: 'done', spec, warnings, built_at: builtAt.toISOString() });
    } catch (err) {
      fastify.log.error(err);
      send({ event: 'stage', stage: 'failed' });
      send({
        event: 'error',
        message: err instanceof Error ? err.message : 'Could not build the base resume',
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
    const builtAt = new Date();
    const [updated] = await db
      .update(profiles)
      .set({ base_resume_json: body.spec, base_resume_built_at: builtAt, updated_at: builtAt })
      .where(eq(profiles.user_id, userId))
      .returning({ built_at: profiles.base_resume_built_at });
    if (!updated) return reply.status(404).send({ error: 'No such profile' });
    return reply.status(200).send({ ok: true, built_at: updated.built_at });
  });
}
