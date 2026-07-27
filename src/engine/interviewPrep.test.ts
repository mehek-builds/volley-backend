import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildInterviewPrep } from './interviewPrep';
import type { JdTerm } from './jdMatch';
import type { ResumeSpec } from '../llm/resumeSpec';

const term = (t: string, weight = 1, signal = true): JdTerm => ({ term: t, display: t, weight, kind: 'required', signal });

function spec(bullets: string[]): ResumeSpec {
  return {
    school: 'USC', degree: 'BS', grad_date: '2028', coursework: '',
    experience: [{ type: 'job', org: 'Traeco', title: 'Intern', date_range: '2025', bullets }],
    skills: [],
  } as ResumeSpec;
}

describe('buildInterviewPrep', () => {
  test('a covered requirement gets the student\'s own bullet as the answer', () => {
    const prep = buildInterviewPrep([term('kubernetes')], spec(['Deployed six services on Kubernetes']));
    assert.equal(prep.items[0].unanswered, false);
    assert.equal(prep.items[0].answer?.org, 'Traeco');
    assert.match(prep.items[0].answer?.bullet ?? '', /Kubernetes/);
  });

  test('an uncovered requirement is a question with NO answer, said plainly', () => {
    const prep = buildInterviewPrep([term('kafka')], spec(['Wrote Python pipelines']));
    assert.equal(prep.items[0].unanswered, true);
    assert.equal(prep.items[0].answer, undefined);
    assert.equal(prep.unanswered, 1);
  });

  test('NOTHING is generated: every answer is verbatim from the resume', () => {
    const bullet = 'Deployed six services on Kubernetes, cutting release time by 35%';
    const prep = buildInterviewPrep([term('kubernetes')], spec([bullet]));
    assert.ok(bullet.startsWith((prep.items[0].answer?.bullet ?? '').replace(/…$/, '').trim()));
  });

  test('there is no model call in this engine', () => {
    // An LLM asked to write interview answers from a resume produces the R-015 fabrication one
    // layer further from anywhere the student would notice it.
    const src = readFileSync(path.join(__dirname, 'interviewPrep.ts'), 'utf8');
    // Matches imports and call shapes, not the word "generated" in the prose that explains why.
    assert.ok(!/from '@anthropic-ai|from "@anthropic-ai|client\.messages|\bawait callModel|openai/i.test(src), 'no model call belongs here');
  });

  test('the most likely question comes first', () => {
    const prep = buildInterviewPrep(
      [term('kafka', 0.6), term('python', 1)],
      spec(['Wrote Python pipelines']),
    );
    assert.equal(prep.items[0].term, 'python');
  });

  test('the list is capped so it stays readable the night before', () => {
    const many = Array.from({ length: 40 }, (_, i) => term(`skill${i}`));
    assert.equal(buildInterviewPrep(many, spec([])).items.length, 12);
  });

  test('an empty resume produces questions that are all unanswered, not zero questions', () => {
    const prep = buildInterviewPrep([term('docker'), term('aws')], spec([]));
    assert.equal(prep.items.length, 2);
    assert.equal(prep.answered, 0);
    assert.equal(prep.unanswered, 2);
  });

  test('answered plus unanswered accounts for every item', () => {
    const prep = buildInterviewPrep([term('docker'), term('kafka')], spec(['Ran Docker in CI']));
    assert.equal(prep.answered + prep.unanswered, prep.items.length);
  });

  test('a bare proper noun is NEVER a question, however the posting used it', () => {
    // The panel asked "Tell me about your experience with Chicago", "...with Growth", "...with
    // Marketing" and "...with Engineer Intern", because the scorer admits proper nouns to catch
    // vendor names it does not enumerate. Right for a gap chip, wrong for a question.
    const nonSignal = ['chicago', 'growth', 'marketing', 'engineer intern'].map((t) => term(t, 1, false));
    const prep = buildInterviewPrep([...nonSignal, term('docker')], spec(['Ran Docker in CI']));
    assert.deepEqual(prep.items.map((i) => i.term), ['docker']);
  });

  test('body prose does not become a question, only stated requirements do', () => {
    const prep = buildInterviewPrep([term('rails', 0.4), term('docker', 1)], spec(['Ran Docker in CI']));
    assert.deepEqual(prep.items.map((i) => i.term), ['docker']);
  });

  test('a real multi-word skill is NOT dropped by the credential list', () => {
    // Splitting the exclusion list into words silently removed "data science", "distributed
    // systems", "salesforce administration" and "visa" the payment network.
    const keep = ['data science', 'distributed systems', 'salesforce administration', 'visa', 'spanish'];
    const prep = buildInterviewPrep(keep.map((t) => term(t)), spec([]));
    assert.deepEqual(prep.items.map((i) => i.term).sort(), [...keep].sort());
  });

  test('the answer always contains the term it answers', () => {
    // excerpt(160) cut a legal 235-char bullet before the matched term, showing a quote with no
    // trace of it: an attribution the student can see is unsupported.
    const long =
      'Owned the checkout reliability workstream end to end, cutting p95 latency from 4.2 seconds to 380 milliseconds and reducing on-call pages by 62 percent, then migrated the remaining batch jobs onto Kubernetes clusters';
    const prep = buildInterviewPrep([term('kubernetes')], spec([long]));
    assert.match(prep.items[0].answer?.bullet ?? '', /Kubernetes/);
  });

  test('the strongest evidence wins, not the first bullet on the page', () => {
    const prep = buildInterviewPrep(
      [term('kubernetes')],
      spec([
        'Attended a Kubernetes meetup and read the docs',
        'Rebuilt the ingestion path and migrated 40 jobs onto Kubernetes, cutting cost 30%',
      ]),
    );
    assert.match(prep.items[0].answer?.bullet ?? '', /Rebuilt the ingestion path/);
  });

  test('one bullet is not spent on every question when others could answer', () => {
    const prep = buildInterviewPrep(
      [term('docker'), term('kubernetes')],
      spec(['Ran Docker and Kubernetes in CI', 'Deployed Kubernetes clusters for 12 services']),
    );
    const answers = prep.items.map((i) => i.answer?.bullet);
    assert.equal(new Set(answers).size, 2, 'the same sentence must not answer everything');
  });

  test('a credential is not turned into an interview question', () => {
    // The first screenshot asked "Tell me about your experience with Computer Science", from the
    // posting's degree line. A credential is checked, not discussed.
    const prep = buildInterviewPrep(
      [term('computer science'), term('bachelors degree'), term('docker')],
      spec(['Ran Docker in CI']),
    );
    assert.deepEqual(prep.items.map((i) => i.term), ['docker']);
  });

  test('excluding it from questions does NOT exclude it from the score', () => {
    // The exclusion lives here and not in the match model: a degree requirement should go on
    // counting toward coverage, it just is not a question.
    const src = readFileSync(path.join(__dirname, 'jdMatch.ts'), 'utf8');
    assert.ok(!/NOT_INTERVIEWABLE/.test(src), 'the interview exclusion must not leak into scoring');
  });

  test('no requirements is an empty list, not a crash', () => {
    const prep = buildInterviewPrep([], spec(['Anything']));
    assert.deepEqual(prep.items, []);
  });
});
