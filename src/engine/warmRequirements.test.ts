import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { warmRequirementCache, WARM_TIMEOUT_MS } from './warmRequirements';
import { matchClause } from './clauseMatch';
import type { CandidateFacts } from './clauseMatch';

const FACTS: CandidateFacts = {
  degree: 'Bachelor of Science in Computer Science',
  school: 'University of Southern California',
  gradDate: 'May 2027',
  resumeText: 'Python. Led a 4-person team, analyzing 350 survey responses.',
  bullets: ['Led a 4-person team, analyzing 350 survey responses.', 'Produced a 50-page proposal.'],
};

const JD = `What we look for:
- You have some first hand experience with SQL and/or Python
- Pursuing a bachelor's in computer science
- You can communicate nuance to partners in written and verbal form
- You use analytical skills to make data-driven decisions
`;

/**
 * The warm step is an optimisation for a screen nobody is looking at yet, so the tests that matter
 * are the ones about what it must NOT do: fail a generation, hold a response open, or put anything
 * in the cache that asking directly would not have.
 */
describe('warming cannot break the thing it is optimising', () => {
  test('a missing posting or an empty resume is a no-op, not an error', async () => {
    assert.equal((await warmRequirementCache(null, FACTS, undefined)).asked, 0);
    assert.equal((await warmRequirementCache(JD, { ...FACTS, bullets: [] }, undefined)).asked, 0);
    assert.equal((await warmRequirementCache('', FACTS, undefined)).asked, 0);
  });

  test('a posting that states no competency clause asks for nothing', async () => {
    const terse = `Requirements\n- Experience with Python and Docker and Kubernetes\n`;
    const r = await warmRequirementCache(terse, FACTS, undefined);
    assert.equal(r.asked, 0, 'named technologies are decided locally and never reach the model');
  });

  test('it times out rather than holding a generation open', async () => {
    // The bound is the whole safety argument for awaiting this inside /resume/generate.
    const started = Date.now();
    const r = await warmRequirementCache(JD, FACTS, undefined, 40);
    assert.ok(Date.now() - started < 4_000, 'must give up quickly, not wait on the model');
    assert.ok(r.skipped, 'a timeout is reported, never thrown');
    assert.equal(r.judged, 0);
  });

  test('the default bound is long enough for one batched call and short enough to be safe', () => {
    assert.ok(WARM_TIMEOUT_MS >= 10_000 && WARM_TIMEOUT_MS <= 30_000, `got ${WARM_TIMEOUT_MS}`);
  });
});

describe('it warms exactly what the review screen will ask for', () => {
  const src = readFileSync(path.join(__dirname, 'warmRequirements.ts'), 'utf8');

  test('it runs the same deterministic pass, so terms and degrees never reach the model', () => {
    // If this drifted from the review screen's pass, warming would fill the cache with keys the
    // review screen never looks up, which is worse than not warming: it costs and saves nothing.
    assert.match(src, /matchClause\(text, section\.weight, facts, context\)/);
    assert.match(src, /clause\.basis === 'competency'/);
  });

  test('it scores the same sections the breakdown scores', () => {
    assert.match(src, /section\.kind !== 'required' && section\.kind !== 'preferred'/);
  });

  test('the bound RACES the judgement, it does not wait for both', () => {
    // Promise.all here would be silently catastrophic and passes every behavioural test: the
    // timeout promise only ever REJECTS, so `all` would wait for it on the success path too and
    // every warm would report a timeout after doing the work and paying for it.
    assert.match(src, /await Promise\.race\(\[/);
    assert.doesNotMatch(src, /await Promise\.all\(\[/);
  });

  test('it owns no write of its own', () => {
    // judgeCompetenciesCached holds the write, and it only stores verdicts that survived the
    // grounding gate. Warming must not be a second path into the cache with different rules.
    assert.doesNotMatch(src, /db\.insert|competency_verdicts/);
    assert.match(src, /judgeCompetenciesCached/);
  });
});

describe('the generate route treats warming as optional', () => {
  const route = readFileSync(path.join(__dirname, '..', 'routes', 'resume.ts'), 'utf8');

  test('it warms after the packet is persisted, never before', () => {
    // Warming first would spend a model call for a packet that then failed to save. Anchored on
    // the INSERT, not on the table name: the name appears in the import and in a later select, so
    // an indexOf against it was true whatever order the two statements were in.
    const insert = route.indexOf('db.insert(generated_resumes)');
    const warm = route.indexOf('await warmRequirementCache(');
    assert.ok(insert !== -1 && warm !== -1);
    assert.ok(insert < warm, 'the packet must be saved before a model call is spent on it');
  });

  test('a failed warm is logged, not thrown', () => {
    assert.match(route, /if \(warm\.skipped && body\.prewarm\) fastify\.log\.warn/);
    assert.doesNotMatch(route, /throw.*warmRequirementCache/);
  });
});

describe('a packet is tailored and scored against the WHOLE posting', () => {
  const generate = readFileSync(path.join(__dirname, '..', 'routes', 'resume.ts'), 'utf8');
  const requirements = readFileSync(path.join(__dirname, '..', 'routes', 'jdMatch.ts'), 'utf8');

  /* Found 2026-08-04 on a real packet: spec._review.jd_text was exactly 600 characters, cut
     mid-word. GET /jobs serves `left(description, 600)` and the dashboard forwarded that preview
     to /resume/generate, so the RESUME ITSELF was written against six hundred characters of
     company blurb, and the JD stored beside it was the same truncated text. The requirement
     breakdown then scored zero clauses on it, correctly, because the requirements section had been
     cut away before the JD ever arrived. */

  test('generate resolves the full description from job_id', () => {
    // The resolution moved into the shared, scoped helper; generate now delegates rather than
    // carrying its own copy of both the query and the predicate.
    assert.match(generate, /const row = await postingRow\(body\.job_id\);/);
    assert.match(generate, /jdText = resolveJdText\(jdText, row\?\.description\);/);
    assert.match(requirements, /left\(\$\{monitored_jobs\.description\}, 60000\)/);
  });

  test('generate uses the resolved text everywhere, not the body field', () => {
    // A single surviving body.jd_text would tailor against the preview while storing the full
    // text, or the reverse, which is harder to notice than either being wrong on its own.
    const handler = generate.slice(
      generate.indexOf("fastify.post('/resume/generate'"),
      // Bounded at the next route: slicing to EOF covered /resume/download and /resume/history too,
      // so an unrelated future route reading body.jd_text would fail this with a misleading message.
      generate.indexOf("fastify.get('/resume/download'"),
    );
    // Exactly one mention survives, the resolver's own seed. Counting rather than banning, because
    // banning outright would fail on the correct code and invite someone to delete the resolver.
    const uses = handler.match(/\bbody\.jd_text\b/g) ?? [];
    assert.equal(uses.length, 1, `body.jd_text should only seed jdText, found ${uses.length}`);
    assert.match(handler, /let jdText = body\.jd_text;/);
  });

  test('a caller that holds more text than we do still wins', () => {
    // The extension and hand-typed links send a JD we have no row for. Overwriting those with a
    // shorter stored copy would be the same defect pointed the other way.
    // Both routes now go through resolveJdText, whose caller-wins branch is the same guarantee.
    assert.match(requirements, /if \(sent\.length >= 2_000\) return sent;/);
    assert.match(requirements, /return rowDescription\.length > sent\.length \? rowDescription : sent;/);
  });

  test('the breakdown repairs packets that already stored a preview', () => {
    // Without this, every packet built before the fix stays unscoreable forever, because its
    // stored jd_text is 600 characters and no migration rewrites it.
    assert.match(requirements, /export function resolveJdText/);
    assert.match(requirements, /const jdText = resolveJdText\(parsed\.data\.jd_text \?\? '', posting\?\.description\);/);
  });
});

describe('the expensive path is opt-in and the two routes agree', () => {
  const generate = readFileSync(path.join(__dirname, '..', 'routes', 'resume.ts'), 'utf8');
  const routes = readFileSync(path.join(__dirname, '..', 'routes', 'jdMatch.ts'), 'utf8');

  test('an interactive generate is never blocked on a model call', () => {
    /* This was a silent no-op for as long as packets carried a 600-char preview: no competency
       clause, so warmRequirementCache returned instantly. Resolving the full posting turned it
       into a real Sonnet call awaited on the response path, which would have put up to 20 seconds
       in front of a student who pressed Apply. */
    assert.match(generate, /const warm = body\.prewarm/);
    assert.match(generate, /interactive generate, not warmed/);
  });

  test('both routes resolve the JD through one helper', () => {
    // They render on the same screen. Two resolutions is two numbers about one posting.
    assert.equal((routes.match(/resolveJdText\(/g) ?? []).length, 3, 'the definition plus both call sites');
    assert.doesNotMatch(routes, /body\.jd_text \?\? posting\?\.description \?\? '';/);
  });

  test('a row capped at the 60k ceiling never wins', () => {
    // It is truncated mid-word too, so it is no better than what the caller sent.
    assert.match(routes, /rowDescription\.length === 60_000/);
  });

  test('only a preview-shaped text is replaced', () => {
    // The poller overwrites description in place, so a re-polled posting that grew by one
    // character must not silently replace a full JD a caller genuinely holds.
    assert.match(routes, /sent\.length >= 2_000/);
  });
});

describe('the posting read is scoped, and the paid route is metered', () => {
  const routes = readFileSync(path.join(__dirname, '..', 'routes', 'jdMatch.ts'), 'utf8');
  const generate = readFileSync(path.join(__dirname, '..', 'routes', 'resume.ts'), 'utf8');

  /* Retrospective review, 2026-08-04. postingRow began life returning one nullable location column,
     and its comment said scoping was unnecessary because that "discloses nothing". It stopped being
     true when it started returning the DESCRIPTION, which /jd-match/requirements hands back clause
     by clause: any posting the board refuses to serve was readable by uuid alone. */

  test('postingRow requires an enabled source and an allowed portal family', () => {
    assert.match(routes, /eq\(career_page_sources\.enabled, true\)/);
    assert.match(routes, /inArray\(career_page_sources\.ats_name, \[\.\.\.AUTONOMOUS_PORTAL_FAMILIES\]\)/);
  });

  test('it deliberately does NOT require is_active', () => {
    /* The one place this differs from GET /jobs/:id, and it is load-bearing: a packet is often held
       for a posting that has since closed, and refusing there would break the repair path for every
       packet that stored the 600-character preview. Closure is a fact about the job; the source and
       portal-family checks are the permission boundary. */
    const helper = routes.slice(routes.indexOf('export async function postingRow'), routes.indexOf('export function resolveJdText'));
    assert.doesNotMatch(helper, /is_active/);
  });

  test('generate reads the posting through that same helper, not its own query', () => {
    // A second inline query is a second place to forget the scoping, and a second predicate that
    // can drift from the one the review screen uses.
    assert.match(generate, /const row = await postingRow\(body\.job_id\);/);
    const handler = generate.slice(
      generate.indexOf("fastify.post('/resume/generate'"),
      generate.indexOf("fastify.get('/resume/download'"),
    );
    assert.doesNotMatch(handler, /\.from\(monitored_jobs\)/, 'no inline unscoped read may remain');
  });

  test('the requirement breakdown is rate limited and body bounded', () => {
    // It shipped as the only model-backed route in the repo with neither, behind nothing but the
    // 180 req/min IP limiter. Its own cache made the common path free, which is what hid it.
    assert.match(routes, /'\/jd-match\/requirements', \{ preHandler: requireAuth, bodyLimit: 128 \* 1024 \}/);
    assert.match(routes, /allowHourly\(userId, 'jdRequirements', LIMITS\.perHour\.jdRequirements\)/);
  });
});

describe('a graduation requirement is asked, not parsed', () => {
  /* WHAT REPLACED WHAT, because the deleted tests here were good tests of a bad idea.
   *
   * They pinned twenty-one date phrasings against a regex window, and they passed. Round six then
   * found seven more phrasings that the same regex got wrong, in the same way the five rounds
   * before it had: a disqualifier checked on only one side, a cue reaching across a sentence, a
   * comma chaining into an unrelated year, two requirements collapsed into one span, and "not
   * graduating before 2027" read backwards. Each round the fixture grew and the leak moved.
   *
   * So these test the CONTRACT rather than the phrasing: a clause that turns on WHEN goes to the
   * judge intact, a clause that does not is still decided here, and nothing about timing is
   * decided locally ever again. Phrasing is the judge's problem, and it is tested against the
   * judge, where a miss costs a prompt line instead of a regex round. */
  const facts = (gradDate: string | null): CandidateFacts => ({
    degree: 'Bachelor of Science in Computer Science',
    school: 'University of Southern California',
    gradDate,
    resumeText: 'Python.',
    bullets: ['Led a 4-person team, analyzing 350 survey responses.'],
  });

  test('a clause that states timing is deferred, not decided', () => {
    for (const clause of [
      "Pursuing a bachelor's in computer science graduating in Fall 2027 or Spring 2028",
      "Pursuing a bachelor's degree, graduating in 2026",
      "Bachelor's degree; December 2027 graduate preferred",
      "Pursuing a bachelor's degree in computer science expected May 2027",
      "Bachelor's degree, not graduating before 2027",
      "BS graduating 2027; MS candidates graduating 2029",
    ]) {
      const c = matchClause(clause, 1, facts('May 2028'));
      assert.equal(c.basis, 'graduation', clause);
      assert.equal(c.verdict, 'pending', `${clause}: no local verdict may be reached`);
    }
  });

  test('a degree clause with no timing is still settled here', () => {
    // The judge is for reading dates. Asking it whether "computer science" is "Computer Science"
    // would be slower, dearer and less reliable than the substring check that already works.
    const c = matchClause("Bachelor's degree in computer science", 1, facts('May 2028'));
    assert.equal(c.basis, 'degree');
    assert.equal(c.verdict, 'met');
    const miss = matchClause("Bachelor's degree in mechanical engineering", 1, facts('May 2028'));
    assert.equal(miss.verdict, 'unmet');
  });

  test('a stray year still defers, because telling it apart IS the reading', () => {
    /* "our 2019 Series B" is not a graduation requirement, and five regex rounds tried to
       recognise that from the surrounding words. Deferring costs one question and is right; a
       local guess was wrong in both directions across those rounds. */
    const c = matchClause(
      "Bachelor's degree in computer science; join the team we built after our 2019 Series B",
      1,
      facts('May 2030'),
    );
    assert.equal(c.verdict, 'pending');
  });

  test('no graduation date on file is unscoreable, never met', () => {
    // The old code returned MET when either side was missing, so a student who had never entered a
    // graduation date passed every window in the product.
    const c = matchClause(
      "Pursuing a bachelor's in computer science graduating in Fall 2027",
      1,
      facts(null),
    );
    assert.equal(c.verdict, 'unscoreable');
    assert.notEqual(c.verdict, 'met');
  });

  test('pending is never scored as a miss', () => {
    // aggregate() counts unmet in the denominator. A clause still awaiting an answer must not be
    // charged to the student on the way past.
    const pendingClause = matchClause(
      "Pursuing a bachelor's in computer science graduating in Fall 2027",
      1,
      facts('May 2028'),
    );
    assert.equal(pendingClause.verdict, 'pending');
  });
});
