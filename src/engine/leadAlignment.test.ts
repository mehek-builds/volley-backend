import assert from 'node:assert/strict';
import test from 'node:test';
import { applyResumePolicy } from './resumePolicy';
import { leadAlignmentIssues, leadRequirementCandidates, foldForCitation, sharedCitationTerms } from './leadAlignment';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';

const JD = `Product Management Intern

What you will do:
- Define product requirements and write specs for a consumer surface
- Partner with engineering and design to ship features to users

Requirements:
- Experience shipping a consumer product end to end
- Strong written communication`;

const TONEE = {
  type: 'job' as const,
  org: 'Tonee - AI Texting Tone Detector',
  title: 'Founder',
  date_range: 'September 2025 - Present',
  bullets: [
    'Shipped consumer mobile app end-to-end; designed feature set and UX in Figma, defined product requirements, and developed GTM strategy reaching 100+ active users.',
    'Conducted 47 user interviews and analyzed 8,300+ behavioral data points; translated insights into iterative product improvements.',
    'Evaluated 3 technical architectures for mobile performance; authored specification reducing latency from 2.3s to 0.1s.',
  ],
};
const TRAECO = {
  type: 'job' as const,
  org: 'Traeco - AI Agent Cost Infrastructure',
  title: 'AI Engineer',
  date_range: 'February 2026 - Present',
  bullets: [
    'Built LLM-agent cost infrastructure with LangChain and the OpenAI API, instrumenting evaluation harnesses for accuracy.',
    'Engineered automation workflows wiring data across cloud services, building adoption dashboards that tracked agent usage.',
    'Structured an ambiguous, fast-moving AI market into testable hypotheses through 50+ customer discovery interviews.',
  ],
};

function spec(partial: Partial<ResumeSpec>): ResumeSpec {
  return normalizeSpec({
    target_role: 'Product Management Intern',
    school: 'USC',
    degree: 'BS',
    grad_date: 'May 2027',
    coursework: '',
    experience: [TONEE, TRAECO],
    skills: ['Figma'],
    ...partial,
  });
}

test('a lead entry justified by a quoted requirement and its own bullet passes', () => {
  const s = spec({
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      requirement: 'Experience shipping a consumer product end to end',
      evidence: TONEE.bullets[0],
    },
  });
  assert.deepEqual(leadAlignmentIssues(s, JD), []);
});

test('a missing justification is reported so the retry loop can ask for one', () => {
  const issues = leadAlignmentIssues(spec({}), JD);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /lead_alignment is missing/);
});

test('a single-entry resume has no ordering decision to defend', () => {
  assert.deepEqual(leadAlignmentIssues(spec({ experience: [TONEE] }), JD), []);
});

/* THE NO-FABRICATION PINS.
 *
 * This gate exists to change which true entry leads a resume. It must never become a route by
 * which a claim reaches the page that the applicant's own material does not support, and the two
 * ways that could happen are a requirement the posting never stated and evidence the entry never
 * held. Both are rejected below. Note what a rejection can do at its strongest: put a sentence in
 * the retry feedback. Nothing in this module writes, rewrites, merges or reorders a bullet. */
test('a requirement the posting never stated is rejected', () => {
  const issues = leadAlignmentIssues(spec({
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      // Plausible for the role, and nowhere in the JD above.
      requirement: 'Five years of consumer product management experience',
      evidence: TONEE.bullets[0],
    },
  }), JD);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /not one of this posting's listed requirements/);
});

test('a paraphrase of a real requirement is rejected: the quote must be verbatim', () => {
  const issues = leadAlignmentIssues(spec({
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      requirement: 'experience shipping consumer products from start to finish',
      evidence: TONEE.bullets[0],
    },
  }), JD);
  assert.match(issues[0], /not one of this posting's listed requirements/);
});

/* The defect this closed list was added for. "Strong written communication" is genuinely in this
 * posting, and quoting it would have satisfied the first version of the check while leaving a lead
 * entry that proves nothing the job is about. The list holds the posting's asks, not every sentence
 * it contains, so the retro-fitted justification has nowhere to come from. */
test('a real line from the posting that is not one of its asks cannot justify the lead', () => {
  const asks = leadRequirementCandidates(JD);
  assert.ok(JD.includes('Strong written communication'));
  assert.ok(!asks.includes('Strong written communication'));
  const issues = leadAlignmentIssues(spec({
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      requirement: 'Strong written communication',
      evidence: TONEE.bullets[0],
    },
  }), JD);
  assert.match(issues[0], /not one of this posting's listed requirements/);
});

/* Responsibilities before requirements: the lead entry answers "which of her jobs is this job most
   like", and the responsibilities block is the description of the job. See the module header for
   why this one question inverts the priority order the rest of the prompt uses. */
test('the asks lead with what the job does, then what it screens for', () => {
  assert.deepEqual(leadRequirementCandidates(JD), [
    'Define product requirements and write specs for a consumer surface',
    'Partner with engineering and design to ship features to users',
    'Experience shipping a consumer product end to end',
  ]);
});

/* A posting with no readable asks must relax to the weaker bar rather than fail every packet
 * against an empty list, which would withhold resumes over an unparseable job board rather than
 * over anything the resume says. */
test('a posting that yields no asks falls back to quoting the job description', () => {
  const thin = 'Engineer wanted. Apply within.';
  assert.deepEqual(leadRequirementCandidates(thin), []);
  const s = spec({
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      requirement: 'Engineer wanted',
      evidence: TONEE.bullets[0],
    },
  });
  assert.match(leadAlignmentIssues(s, thin)[0], /does not address/);
  assert.ok(!leadAlignmentIssues(s, thin).some((i) => /not in the job description/.test(i)));
});

test('evidence the lead entry does not hold is rejected, even when it is a real bullet elsewhere', () => {
  const issues = leadAlignmentIssues(spec({
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      requirement: 'Experience shipping a consumer product end to end',
      // A genuine bullet, but it belongs to the second entry, not the one being justified.
      evidence: TRAECO.bullets[0],
    },
  }), JD);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /not one of the bullets selected for Tonee/);
});

test('an invented bullet is rejected even when it would prove the requirement', () => {
  const issues = leadAlignmentIssues(spec({
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      requirement: 'Experience shipping a consumer product end to end',
      evidence: 'Shipped a consumer product end to end for 2 million users.',
    },
  }), JD);
  assert.match(issues[0], /not one of the bullets selected/);
});

test('a listed ask paired with unrelated real evidence is rejected', () => {
  const issues = leadAlignmentIssues(spec({
    experience: [TRAECO, TONEE],
    lead_alignment: {
      entry_org: 'Traeco - AI Agent Cost Infrastructure',
      requirement: 'Experience shipping a consumer product end to end',
      // Both halves exist and the requirement is a real ask. The evidence does not address it,
      // which is what leading with the most recent entry and then looking for a defence produces.
      evidence: TRAECO.bullets[1],
    },
  }), JD);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /does not address/);
});

test('justifying a different entry than the one that leads is reported alone, not buried', () => {
  const issues = leadAlignmentIssues(spec({
    experience: [TRAECO, TONEE],
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      requirement: 'Experience shipping a consumer product end to end',
      evidence: TONEE.bullets[0],
    },
  }), JD);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /but the first entry is "Traeco/);
});

test('after rendering, only the entry the alignment argues for is re-checked', () => {
  // One-page fitting may have dropped the cited bullet. That must not withhold the resume.
  const trimmed = spec({
    experience: [{ ...TONEE, bullets: TONEE.bullets.slice(1) }, TRAECO],
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      requirement: 'Experience shipping a consumer product end to end',
      evidence: TONEE.bullets[0],
    },
  });
  assert.equal(leadAlignmentIssues(trimmed, JD).length, 1);
  assert.deepEqual(leadAlignmentIssues(trimmed, JD, { afterRender: true }), []);
});

/* applyResumePolicy runs normalizeDashesForPrint over every field of the spec, so a requirement
 * quoted out of a posting written with em dashes no longer matches that posting byte for byte by
 * the time it is checked. Pinned end to end through the real policy pass rather than by asserting
 * on foldForCitation, because the coupling is what breaks. */
test('a requirement quoted from a posting written with em dashes survives the policy pass', () => {
  const dashJd = 'Requirements:\n- Experience shipping a consumer product — end to end — to real users';
  const { spec: policed } = applyResumePolicy(
    spec({
      lead_alignment: {
        entry_org: 'Tonee - AI Texting Tone Detector',
        requirement: 'Experience shipping a consumer product — end to end — to real users',
        evidence: TONEE.bullets[0],
      },
    }),
    { school: 'USC', degree: 'BS', grad_date: 'May 2027', currently_enrolled: true },
    [],
    dashJd,
    { targetRole: 'Product Management Intern' },
  );
  assert.ok(!policed.lead_alignment?.requirement.includes('—'), 'policy rewrote the dash, as expected');
  assert.deepEqual(leadAlignmentIssues(policed, dashJd), []);
});

test('foldForCitation is stable across quote, dash and space variants', () => {
  assert.equal(foldForCitation('End‑to‑end  ownership'), foldForCitation('end - to - end ownership'));
  assert.equal(foldForCitation('the team’s goals'), foldForCitation("The team's goals"));
});

test('sharedCitationTerms ignores the words every posting and every bullet share', () => {
  assert.deepEqual(sharedCitationTerms('Strong experience with the team', 'Worked with our team'), []);
  assert.ok(sharedCitationTerms('Define product requirements', 'defined product requirements in Figma').length >= 2);
});

/* The short words this domain runs on. A four-character floor dropped all of these and reported
   real citations as arbitrary; see citationTerms for the packet it was measured on. */
test('three-letter technical terms and "end" still count as shared', () => {
  assert.deepEqual(
    sharedCitationTerms('Own a scoped project end to end', 'Shipped a consumer app end-to-end in 8 weeks'),
    ['end'],
  );
  assert.deepEqual(sharedCitationTerms('Experience with SQL', 'Wrote SQL against a warehouse'), ['sql']);
  assert.deepEqual(sharedCitationTerms('GPU programming', 'Profiled GPU kernels'), ['gpu']);
});
