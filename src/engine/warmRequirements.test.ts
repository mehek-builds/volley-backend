import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { warmRequirementCache, WARM_TIMEOUT_MS } from './warmRequirements';
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
    assert.match(route, /if \(warm\.skipped\) fastify\.log\.warn/);
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
    assert.match(generate, /left\(\$\{monitored_jobs\.description\}, 60000\)/);
    assert.match(generate, /if \(row\?\.description && row\.description\.length > jdText\.length\) jdText = row\.description;/);
  });

  test('generate uses the resolved text everywhere, not the body field', () => {
    // A single surviving body.jd_text would tailor against the preview while storing the full
    // text, or the reverse, which is harder to notice than either being wrong on its own.
    const handler = generate.slice(generate.indexOf("fastify.post('/resume/generate'"));
    // Exactly one mention survives, the resolver's own seed. Counting rather than banning, because
    // banning outright would fail on the correct code and invite someone to delete the resolver.
    const uses = handler.match(/\bbody\.jd_text\b/g) ?? [];
    assert.equal(uses.length, 1, `body.jd_text should only seed jdText, found ${uses.length}`);
    assert.match(handler, /let jdText = body\.jd_text;/);
  });

  test('a caller that holds more text than we do still wins', () => {
    // The extension and hand-typed links send a JD we have no row for. Overwriting those with a
    // shorter stored copy would be the same defect pointed the other way.
    assert.match(generate, /row\.description\.length > jdText\.length/);
    assert.match(requirements, /posting\.description\.length > sent\.length/);
  });

  test('the breakdown repairs packets that already stored a preview', () => {
    // Without this, every packet built before the fix stays unscoreable forever, because its
    // stored jd_text is 600 characters and no migration rewrites it.
    assert.match(requirements, /posting\?\.description && posting\.description\.length > sent\.length/);
  });
});
