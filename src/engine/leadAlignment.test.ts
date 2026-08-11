import assert from 'node:assert/strict';
import test from 'node:test';
import { applyResumePolicy } from './resumePolicy';
import {
  leadAlignmentIssues,
  leadRequirementCandidates,
  foldForCitation,
  offersRatherThanRequires,
  selectJdAlignedLead,
  sharedCitationTerms,
} from './leadAlignment';
import { monitoredDescriptionHash } from '../lib/monitoredPortalRepair';
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

function spec(partial: Partial<ResumeSpec>, jdText = JD): ResumeSpec {
  const alignment = partial.lead_alignment
    ? { ...partial.lead_alignment, jd_hash: partial.lead_alignment.jd_hash ?? monitoredDescriptionHash(jdText) }
    : partial.lead_alignment;
  return normalizeSpec({
    target_role: 'Product Management Intern',
    school: 'USC',
    degree: 'BS',
    grad_date: 'May 2027',
    coursework: '',
    experience: [TONEE, TRAECO],
    skills: ['Figma'],
    ...partial,
    lead_alignment: alignment,
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

test('a single-entry resume still needs evidence for why it leads this job', () => {
  assert.match(leadAlignmentIssues(spec({ experience: [TONEE] }), JD)[0], /lead_alignment is missing/);
});

test('deterministic selection leads a frontend role with frontend work instead of LLM infrastructure', () => {
  const frontend = {
    type: 'job' as const,
    org: 'Storefront Studio',
    title: 'Frontend Engineer',
    date_range: '2025',
    bullets: [
      'Built responsive React and TypeScript interfaces for a consumer web application used by 4,000 customers.',
      'Improved browser rendering performance and accessibility across mobile layouts.',
      'Partnered with designers to ship reusable UI components.',
    ],
  };
  const jd = `Frontend Engineer

Responsibilities:
- Build responsive React and TypeScript interfaces for consumer web applications
- Improve browser performance and accessible UI components

Requirements:
- Experience shipping frontend products to customers`;
  const selected = selectJdAlignedLead(spec({ experience: [TRAECO, frontend] }), jd, {
    company: 'Acme', role: 'Frontend Engineer',
  });
  assert.deepEqual(selected.issues, []);
  assert.equal(selected.spec.experience[0]?.org, 'Storefront Studio');
  assert.equal(selected.spec.lead_alignment?.evidence, frontend.bullets[0]);
  assert.equal(selected.spec.lead_alignment?.jd_hash, monitoredDescriptionHash(jd));
  assert.ok(selected.supported_terms.includes('react'));
  assert.ok(selected.supported_terms.includes('typescript'));
  assert.equal(selected.spec.school, 'USC');
  assert.equal(selected.spec.degree, 'BS');
  assert.equal(selected.spec.grad_date, 'May 2027');
});

test('deterministic selection leads a quant-trading role with trading evidence instead of product work', () => {
  const quant = {
    type: 'job' as const,
    org: 'Market Lab',
    title: 'Quantitative Researcher',
    date_range: '2024',
    bullets: [
      'Researched quantitative trading strategies in Python using market data and backtested risk signals.',
      'Analyzed order-book behavior and presented trading recommendations.',
      'Built statistical models for portfolio risk.',
    ],
  };
  const jd = `Quantitative Trading Intern

What you will do:
- Research quantitative trading strategies using market data
- Analyze risk and collaborate with traders

Requirements:
- Python experience for quantitative analysis`;
  const selected = selectJdAlignedLead(spec({ experience: [TONEE, quant] }), jd, {
    company: 'Trading Firm', role: 'Quantitative Trading Intern',
  });
  assert.deepEqual(selected.issues, []);
  assert.equal(selected.spec.experience[0]?.org, 'Market Lab');
  assert.equal(selected.spec.lead_alignment?.requirement, 'Research quantitative trading strategies using market data');
  assert.equal(selected.spec.lead_alignment?.evidence, quant.bullets[0]);
});

test('selection ignores an unsupported generic-keyword overlap and fails closed', () => {
  const generic = {
    ...TRAECO,
    bullets: [
      'Built software systems for an engineering team.',
      'Developed technology solutions for internal projects.',
      'Created tools used across applications.',
    ],
  };
  const jd = `Hardware Design Intern

Responsibilities:
- Build software systems for engineering projects

Requirements:
- Experience with PCB layout and circuit simulation`;
  const selected = selectJdAlignedLead(spec({ experience: [generic] }), jd, {
    company: 'Circuits Inc', role: 'Hardware Design Intern',
  });
  assert.equal(selected.spec.lead_alignment, null);
  assert.match(selected.issues[0], /no selected bullet shares supported domain evidence/);
  assert.deepEqual(selected.supported_terms, []);
});

test('a citation bound to a different frozen JD is rejected', () => {
  const selected = selectJdAlignedLead(spec({ experience: [TRAECO, TONEE] }), JD, {
    company: 'Acme', role: 'Product Management Intern',
  }).spec;
  assert.ok(selected.lead_alignment?.jd_hash);
  const issues = leadAlignmentIssues(selected, `${JD}\n- Extra requirement`, {
    context: { company: 'Acme', role: 'Product Management Intern' },
  });
  assert.ok(issues.some((issue) => /jd_hash does not match/.test(issue)));
});

test('a citation with no frozen-JD binding is rejected', () => {
  const selected = selectJdAlignedLead(spec({ experience: [TRAECO, TONEE] }), JD, {
    company: 'Acme', role: 'Product Management Intern',
  }).spec;
  const withoutHash = { ...selected, lead_alignment: { ...selected.lead_alignment!, jd_hash: undefined } };
  assert.ok(leadAlignmentIssues(withoutHash, JD).some((issue) => /jd_hash is missing/.test(issue)));
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
  }, thin);
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

test('after rendering, trimming the sole cited evidence remains a blocking defect', () => {
  const trimmed = spec({
    experience: [{ ...TONEE, bullets: TONEE.bullets.slice(1) }, TRAECO],
    lead_alignment: {
      entry_org: 'Tonee - AI Texting Tone Detector',
      requirement: 'Experience shipping a consumer product end to end',
      evidence: TONEE.bullets[0],
    },
  });
  assert.equal(leadAlignmentIssues(trimmed, JD).length, 1);
  assert.match(leadAlignmentIssues(trimmed, JD, { afterRender: true })[0], /evidence is not one of the bullets/);
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
    }, dashJd),
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
   real citations as arbitrary; see comparisonTerms for the packet it was measured on. */
test('three-letter technical terms and "end" still count as shared', () => {
  assert.deepEqual(
    sharedCitationTerms('Own a scoped project end to end', 'Shipped a consumer app end-to-end in 8 weeks'),
    ['end'],
  );
  assert.deepEqual(sharedCitationTerms('Experience with SQL', 'Wrote SQL against a warehouse'), ['sql']);
  assert.deepEqual(sharedCitationTerms('GPU programming', 'Profiled GPU kernels'), ['gpu']);
});

/* ONE TOKENIZER FOR BOTH SIDES.
 *
 * Selection used to keep a sentence-final period inside its token and validation used to drop it,
 * so the same word read as two different words depending on which half of this file was asking.
 * Measured on packet 1d1de862: `reliability.` failed to match `reliability` and destroyed a true
 * pairing, while `improvements.` matched `improvements.` and created a false one. */
test('a sentence-final period is not part of the word, on either side of the check', () => {
  assert.deepEqual(
    sharedCitationTerms('improve testing efficiency and reliability.', 'surfaced reliability gaps for triage'),
    ['reliability'],
  );
  assert.deepEqual(
    sharedCitationTerms('Document findings and recommend improvements.', 'inform UX improvements.'),
    ['improvement'],
  );
  // And the period is not smuggled in as extra length either: the term is the bare word.
  assert.ok(!sharedCitationTerms('recommend improvements.', 'shipped improvements.')[0]?.includes('.'));
});

/* A dot INSIDE a token says "technical name": it yields the joined form AND its parts, and neither
 * is singularised. Before this the selector turned Node.js into `node.j`. */
test('a dotted technical name is one term and keeps the letters it is spelled with', () => {
  assert.deepEqual(sharedCitationTerms('Experience with Node.js', 'Built node.js services'), ['nodejs', 'node']);
  assert.deepEqual(sharedCitationTerms('Next.js on the frontend', 'Shipped Next.js pages'), ['nextjs', 'next']);
  assert.deepEqual(sharedCitationTerms('Serve traffic from ASP.NET', 'Maintained asp.net endpoints'), ['aspnet', 'asp', 'net']);
  assert.deepEqual(sharedCitationTerms('Strong C++ skills.', 'Wrote C++ kernels'), ['c++']);
  // C# is below the three-character floor, as it always has been. What matters is that the '#'
  // stays attached rather than leaving a stray `c` behind to match anything else spelled with one.
  assert.deepEqual(sharedCitationTerms('C# desktop work', 'C# desktop tooling'), ['desktop']);
});

/* THE PARTS ARE WHAT KEEP THE VALIDATION PATH WORKING. A posting writing "Node.js" and a bullet
 * writing "Node" named the same thing under the old tokenizer, which split on the dot. Emitting
 * only the joined form silently took that away, and because sharedCitationTerms gates
 * MIN_SHARED_CITATION_TERMS, an empty result is an accusation that a correct citation proves
 * nothing. Reachable without any preceding selection through runnerLeadAlignmentIssues. */
test('a dotted name still matches its bare stem on the validation path', () => {
  assert.deepEqual(sharedCitationTerms('Strong experience with Node.js', 'Built a Node backend'), ['node']);
  assert.deepEqual(sharedCitationTerms('Next.js on the frontend', 'Shipped Next pages'), ['next']);
  assert.deepEqual(sharedCitationTerms('Serve traffic from ASP.NET', 'Maintained .NET endpoints'), ['net']);
  assert.ok(sharedCitationTerms('Ship React.js interfaces', 'Shipped React interfaces').includes('react'));
});

/* No English plural ends in `js`, so the singulariser must not treat one as a plural. These used to
 * key as `nodej`, `reactj` and `vuej`, which match nothing any document can write. */
test('a bare -js framework name is not singularised', () => {
  assert.deepEqual(sharedCitationTerms('Use reactjs and vuejs', 'Wrote reactjs and vuejs'), ['reactjs', 'vuejs']);
  assert.deepEqual(sharedCitationTerms('Experience with nodejs', 'Built nodejs services'), ['nodejs']);
});

/* THE `program` HOMONYM. The stemmer is right that "programming" reduces to "program"; the trouble
 * is that "program" is also an unrelated noun. Separating the doubled spelling keeps both senses
 * working, which stopping the word did not: it deleted them both. */
test('writing code and running a programme are not the same word', () => {
  // The code sense joins to itself across its own forms.
  assert.deepEqual(sharedCitationTerms('any other programming language', 'Programmed CUDA kernels'), ['programm']);
  assert.deepEqual(sharedCitationTerms('Strong programming skills', 'Worked as a programmer'), ['programm']);
  // The scheme sense still joins to itself.
  assert.deepEqual(sharedCitationTerms('Run the mentorship program', 'Ran the onboarding program'), ['program']);
  // And the two senses no longer touch. This pairing led a software internship with a Program
  // Management entry on packets fa354c82 and c3cdd427.
  assert.deepEqual(
    sharedCitationTerms('Strong problem solving and programming skills.', 'Analyzed 183 program surveys using RICE.'),
    [],
  );
});

/* THE TIE-BREAK IS NOT LENGTH.
 *
 * Both entries below are supported by exactly one term, so the decision falls to the third rule.
 * `stakeholder` is eleven characters and both entries use it, which means it separates them by
 * nothing; `gpu` is three characters and only one entry has it, which is the whole of the evidence.
 * The old rule summed characters and led with the wrong entry. */
test('the tie-break prefers the term that distinguishes an entry, not the longer string', () => {
  const opsDesk = {
    type: 'job' as const,
    org: 'Ops Desk',
    title: 'Coordinator',
    date_range: '2024',
    bullets: ['Kept stakeholder groups informed.'],
  };
  const kernelLab = {
    type: 'job' as const,
    org: 'Kernel Lab',
    title: 'Performance Engineer',
    date_range: '2025',
    bullets: ['Profiled GPU cache misses.', 'Briefed stakeholder groups weekly.'],
  };
  const jd = `Performance Engineer

Responsibilities:
- Maintain stakeholder alignment across the product organisation
- Profile GPU throughput and tune the hot paths you find

Requirements:
- Experience with performance tooling`;
  const selected = selectJdAlignedLead(spec({ experience: [opsDesk, kernelLab] }), jd, {
    company: 'Acme', role: 'Performance Engineer',
  });
  assert.deepEqual(selected.issues, []);
  assert.equal(selected.spec.experience[0]?.org, 'Kernel Lab');
  assert.deepEqual(selected.supported_terms, ['gpu']);
  assert.equal(selected.spec.lead_alignment?.evidence, kernelLab.bullets[0]);
});

/* THE ADDED DECISION STOPWORDS, one test each. Every one of these pairings shares exactly one word
 * and nothing else, so if the word still counted the selector would name a lead on it. Each count
 * in the comment on LEAD_DECISION_STOPWORDS was measured over 158 production packets. */
for (const [word, requirement, evidence] of [
  // A preposition. Cloudflare and DRW both led with a Program Management entry on it.
  ['through', 'Deliver outcomes through disciplined iteration', 'Recovered accounts through weekly outreach.'],
  // An intensifier, used in two unrelated senses on the two sides.
  ['critical', 'Superior analytical and critical thinking', 'Cut latency on a path critical to playback.'],
  // "cross-functional" describes how a team is arranged, not what it does. Both halves are needed
  // because the shared tokenizer cuts the compound at its hyphen.
  ['cross-functional', 'Partner with cross-functional groups', 'Ran cross-functional initiative tracking.'],
] as const) {
  test(`"${word}" cannot decide which experience leads`, () => {
    const only = {
      type: 'job' as const,
      org: 'Coincidence Co',
      title: 'Analyst',
      date_range: '2025',
      bullets: [evidence],
    };
    const jd = `Backend Engineer\n\nResponsibilities:\n- ${requirement}\n\nRequirements:\n- Experience with Kafka and Postgres`;
    const asks = leadRequirementCandidates(jd, { company: 'Acme', role: 'Backend Engineer' });
    assert.ok(asks.some((ask) => ask === requirement), `the posting must actually state "${requirement}"`);
    assert.ok(sharedCitationTerms(requirement, evidence).length > 0, 'the pairing must share this word');
    const selected = selectJdAlignedLead(spec({ experience: [only] }), jd, {
      company: 'Acme', role: 'Backend Engineer',
    });
    assert.equal(selected.spec.lead_alignment, null);
    assert.match(selected.issues[0], /no selected bullet shares supported domain evidence/);
  });
}

/* PERKS ARE NOT REQUIREMENTS. Both Cloudflare packets in production cited the mentorship clause
 * below as the requirement their lead entry proved, and a Program Management internship won a
 * software posting on it. The guard is that the applicant appears as the BENEFICIARY, not that the
 * clause mentions a mentor, so an ask that asks her to work with one is untouched. */
test('a clause that offers the applicant something is not a requirement she can prove', () => {
  assert.equal(
    offersRatherThanRequires('Work closely with a mentor to guide you through the internship and help with career goals.'),
    true,
  );
  assert.equal(offersRatherThanRequires("Meaningful projects: You'll receive a challenging project to complete."), true);
  assert.equal(offersRatherThanRequires('Engage in professional development sessions aimed at helping you envision your future'), true);
  assert.equal(offersRatherThanRequires('We will offer you a mentor for the duration of the programme.'), true);
  // A statement about the terms of the engagement: determiner opener, engagement noun in the
  // subject, copula after it.
  assert.equal(offersRatherThanRequires('The annual base salary for this position is $225,000.'), true);
  assert.equal(
    offersRatherThanRequires('The range of hourly base salary for this position is below. Please note that base hourly pay may vary.'),
    true,
  );
});

test('a real requirement is kept even when it names a mentor, a workshop or a date', () => {
  // The false-capture guard. She is the AGENT in every one of these.
  assert.equal(offersRatherThanRequires('Work with your mentor to design and ship a production feature.'), false);
  assert.equal(offersRatherThanRequires('Mentor junior engineers through code review.'), false);
  assert.equal(offersRatherThanRequires('Run a workshop for the data team on experiment design.'), false);
  assert.equal(offersRatherThanRequires('Present your findings to engineering leadership.'), false);
  /* AN ELIGIBILITY GATE ASKS SOMETHING OF HER. It is unprovable by any bullet, which makes it a
   * weak citation, not a benefit. Deleting it took the only lexical bridge off Virtu packets
   * 04204e04 and d73e66ca, whose ordering was correct and shipped, and turned both into a
   * resume_quality_hold. */
  assert.equal(
    offersRatherThanRequires('Rising juniors, or students expected to be ready for full time employment between December 2027 - June 2028.'),
    false,
  );
  assert.equal(offersRatherThanRequires('Reliable and predictable availability'), false);
  // A responsibility phrased passively, with no offering subject: DRW, packet c1a8628b.
  assert.equal(
    offersRatherThanRequires('Be given immediate responsibility through assignments like position tracking and calculating risk'),
    false,
  );
  // Phrased as an offer, but it states what the work IS. Dropping it moved six packets off a
  // correct lead, which is why the rule demands the applicant by name.
  assert.equal(
    offersRatherThanRequires('This role provides mentorship and exposure to customer-facing technical problem solving.'),
    false,
  );
});

/* THE OFFER IN A RELATIVE CLAUSE BELONGS TO THE DELIVERABLE, NOT TO HER. "Build internal tooling
 * that gives you feedback" is an instruction to build something; only the tooling gives anything.
 * A rule that read the whole clause deleted these, and they are the most role-defining asks a
 * developer-tools employer writes. */
test('a requirement whose deliverable does something for its user is still a requirement', () => {
  assert.equal(offersRatherThanRequires('Build internal tooling that gives you feedback on every commit.'), false);
  assert.equal(offersRatherThanRequires('Design a CI system that gives you a green signal in under ten minutes.'), false);
  assert.equal(offersRatherThanRequires('Build a dashboard that helps you triage incidents faster.'), false);
});

/* THE ENGAGEMENT NOUNS ARE TOPICAL, SO THEY NEED THE CLAUSE'S SHAPE TO AGREE WITH THEM. Every
 * sentence below is an instruction whose OBJECT happens to be a benefit, a payroll or an insurance
 * system. This does not fire on the current corpus, where all six dropped clauses are genuine
 * perks; it fires on any HR-tech, payroll, benefits, insurance or compensation employer, and it
 * matters beyond this check because leadRequirementCandidates also builds the closed list of asks
 * the tailoring prompt shows the model. */
test('work performed ON a benefit or a payroll is not a benefit offered TO the applicant', () => {
  for (const requirement of [
    'Own the benefits enrollment service used by 3 million members.',
    'Improve the health insurance claims adjudication pipeline.',
    'Instrument the paid time off accrual service.',
    'Model compensation bands for the pay range recommendation product.',
    'Ship the 401(k) rollover flow end to end.',
    'Automate relocation case management for HR operations.',
  ]) {
    assert.equal(offersRatherThanRequires(requirement), false, requirement);
  }
  // The shape is what decides, not the noun: a determiner opener with a copula is a statement.
  assert.equal(offersRatherThanRequires('The benefits package is reviewed annually.'), true);
  // ... and a determiner opener without one is not.
  assert.equal(offersRatherThanRequires('The engineer will own the benefits enrollment service.'), false);
});

test('the perk clause is removed from the posting asks and the real work is not', () => {
  const jd = `Software Engineer Intern

What you will do:
- Work closely with a mentor to guide you through the internship and help with career goals.
- Build and ship backend services in Python.
- Own the benefits enrollment service used by 3 million members.

Requirements:
- Work with your mentor to design and ship a production feature.`;
  const asks = leadRequirementCandidates(jd, { company: 'Cloudflare', role: 'Software Engineer Intern' });
  assert.ok(!asks.some((ask) => /guide you through the internship/.test(ask)), 'the perk must be gone');
  assert.ok(asks.some((ask) => /backend services in Python/.test(ask)), 'the work must remain');
  assert.ok(asks.some((ask) => /benefits enrollment service/.test(ask)), 'work on a benefits system must remain');
  assert.ok(asks.some((ask) => /design and ship a production feature/.test(ask)), 'the mentor ask must remain');
});
