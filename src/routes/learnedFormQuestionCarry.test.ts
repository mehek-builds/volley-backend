/* THE APPROVAL SHE GAVE CARRIES ACROSS LITOS READING THE SAME FORM BETTER, AND ACROSS NOTHING ELSE.
 *
 * MEASURED IN PROD 2026-09-02 03:00 UTC. Four of the campaign's ten boards were stuck on one hold
 * each, every one after an approve that ran discovery and then refused to fill or send, every one
 * carrying the identical review shape: attention_categories ["evidence_gap"], no
 * packet_audit_acknowledgement, no preview_screenshot_url, and the sentence "This application
 * changed after you approved the exact packet Litos prepared, so it was not sent. What changed: the
 * questions this form asks, how Litos reaches this employer."
 *
 *   4a79eec1  Hudson River Trading  greenhouse  21 questions  4 react-select demographic controls
 *                                                             whose ids are bare numbers 245/248/249/250
 *   c9b0c807  Confluence Technologies  pinpoint  9 questions   one "country" combobox
 *   6703778e  TixTrack  teamtailor  9 questions               candidate_answers_attributes_4_choice_1
 *   0a5081aa  Apollo Research  lever  12 questions            cards[<uuid>][field0], no readable label
 *
 * Nothing any of them approved had moved. The discovery pass had read the form more thoroughly than
 * the inventory the approval was taken against, and because the employer-delivery hash covers the
 * question rows, the new rows manufactured a second "issue" that was their own shadow. The pair put
 * the run on the drift path, which clears the acknowledgement, so a packet with nothing wrong in it
 * was described to her as changed and sent her to a screen with nothing on it to fix.
 *
 * One test per measured shape, driving the real decision functions over real audits: the approval
 * carries, the audit is re-issued over the merged set, and the hold that stopped these four no
 * longer fires. Then the negatives, which are the whole point of the carry being narrow.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewQuestion } from '../lib/applicationReview';
import {
  createEmployerDeliveryBindings,
  employerDeliveryEnvelope,
  type EmployerDeliveryEnvelope,
} from '../lib/employerDeliveryIdentity';
import { createPacketAudit, type PacketAudit } from '../lib/packetAudit';
import { relearnedFormReadingAcknowledgement } from '../lib/packetResumeRestore';
import { submissionQuestionGate } from '../lib/submissionSafety';
import type { SubmissionPacket } from '../lib/portalSubmission';
import {
  approvedPacketBeforeDiscovery,
  deliveryDriftIsLitosLearnedOnly,
  learnedFormQuestionRows,
  packetDriftAttentionReason,
  packetDriftIsQuestionAskOnly,
  packetQuestionsForFill,
  verifiedBuiltPacketIssues,
  PACKET_QUESTIONS_UNACKNOWLEDGED_ISSUE,
} from './submissionRunner';

const RESUME = Buffer.from('%PDF-1.7\nthe exact resume she approved');
const JD = 'Build reliable systems for people who ship.';
const REVIEWED_AT = '2026-09-01T20:11:00.000Z';
const SNAPSHOT = {
  profile: {
    full_name: 'Mehek Mandal',
    email: 'mehek@example.com',
    experience: [],
    skills: [],
    school: 'USC',
    grad_year: 2028,
  },
  application_profile: { phone: '+12135746270' },
};
const AT = '2026-09-02T03:00:00.000Z';

/** A row the approval covered: she read it and the answer is hers. */
function answered(id: string, question: string, answer: string): ApplicationReviewQuestion {
  return {
    id,
    question,
    answer,
    kind: 'required',
    required: true,
    portal_selector: `#${id}`,
    answer_source: 'applicant_review',
    answer_reviewed_at: REVIEWED_AT,
  };
}

/** A row discovery learned after she approved: a question, with nothing in it. */
function learnedAsk(
  id: string,
  question: string,
  over: Partial<ApplicationReviewQuestion> = {},
): ApplicationReviewQuestion {
  return {
    id,
    question,
    answer: '',
    kind: 'required',
    required: true,
    portal_selector: `#${id}`,
    ...over,
  };
}

function packetFor(input: {
  questions: readonly ApplicationReviewQuestion[];
  fieldOptions?: SubmissionPacket['fieldOptions'];
  resume?: Buffer;
  coverLetter?: Buffer;
}): SubmissionPacket {
  return {
    fullName: 'Mehek Mandal',
    email: 'apply@apply.trylitos.com',
    jdText: JD,
    resume: input.resume ?? RESUME,
    resumeName: 'resume.pdf',
    applicantSnapshot: SNAPSHOT,
    questions: packetQuestionsForFill(input.questions),
    ...(input.fieldOptions ? { fieldOptions: input.fieldOptions } : {}),
    ...(input.coverLetter ? { coverLetter: input.coverLetter, coverLetterName: 'cover.pdf' } : {}),
  };
}

function auditFor(input: {
  questions: readonly ApplicationReviewQuestion[];
  packet: SubmissionPacket;
  envelope: EmployerDeliveryEnvelope;
  coverLetterSupported?: boolean;
  jdText?: string;
}): PacketAudit {
  const jdText = input.jdText ?? JD;
  return createPacketAudit({
    ownerId: 'owner-1',
    applicationId: 'application-1',
    jdText,
    spec: { target_role: 'Engineer' },
    jobContext: { company: 'Employer', role: 'Engineer' },
    questions: [...input.questions],
    applicantSnapshot: input.packet.applicantSnapshot ?? null,
    resumeEmail: 'student@example.com',
    applicantEmail: input.packet.email,
    employerDelivery: createEmployerDeliveryBindings(
      { ...input.packet, jdText },
      { cover_letter_supported: input.coverLetterSupported },
      { mode: 'browser', envelope: input.envelope },
    ),
    pdfObjectKey: 'users/owner-1/resumes/application-1.pdf',
    pdfBytes: input.packet.resume,
    editedTerms: [],
    clauses: [{ text: jdText, start: 0, end: jdText.length, verdict: 'unscoreable' }],
    rejected: [],
    degraded: false,
    terms: { covered: [], missing: [], edited: [] },
  });
}

const acknowledgementOf = (audit: PacketAudit) => ({
  ownerSha256: audit.bindings.ownerSha256,
  applicationId: audit.bindings.applicationId,
  audit_digest: audit.audit_digest,
  packet_version: audit.packet_version,
  pdfSha256: audit.bindings.pdf.sha256,
  pdfSizeBytes: audit.bindings.pdf.sizeBytes,
  acknowledged_at: REVIEWED_AT,
  source: 'applicant' as const,
});

type MeasuredShape = {
  /** The prod packet id and family this fixture reproduces. */
  packetId: string;
  portalFamily: string;
  destinationUrl: string;
  approved: ApplicationReviewQuestion[];
  learned: ApplicationReviewQuestion[];
  /** The inventory the discovery pass read on a form the approval was taken without. */
  fieldOptions: NonNullable<SubmissionPacket['fieldOptions']>;
};

/** Everything a run has in hand at the moment the old code decided to hold. */
function runOf(shape: MeasuredShape, over: {
  approvedQuestions?: ApplicationReviewQuestion[];
  mergedQuestions?: ApplicationReviewQuestion[];
  measuredPacket?: SubmissionPacket;
  approvedPacketOver?: Partial<SubmissionPacket>;
  measuredDestinationUrl?: string;
  approvedCoverLetter?: Buffer;
  coverLetterSupported?: boolean;
} = {}) {
  const approvedQuestions = over.approvedQuestions ?? shape.approved;
  const mergedQuestions = over.mergedQuestions ?? [...shape.approved, ...shape.learned];
  const envelopeFor = (
    caps: { coverLetterSupported?: boolean; transcriptSupported?: boolean },
    destinationUrl = shape.destinationUrl,
  ) => employerDeliveryEnvelope({
    channel: 'browser:stratus-managed',
    destinationUrl,
    portalFamily: shape.portalFamily,
    ...caps,
  });
  // Both capability facts were unknown when she approved; the probe learned them.
  const approvedEnvelope = envelopeFor({});
  const measuredEnvelope = envelopeFor(
    { coverLetterSupported: over.coverLetterSupported ?? false, transcriptSupported: false },
    over.measuredDestinationUrl,
  );
  const approvedPacket: SubmissionPacket = {
    ...packetFor({ questions: approvedQuestions, coverLetter: over.approvedCoverLetter }),
    ...over.approvedPacketOver,
  };
  const audit = auditFor({
    questions: approvedQuestions,
    packet: approvedPacket,
    envelope: approvedEnvelope,
    coverLetterSupported: over.coverLetterSupported,
  });
  const measuredPacket = over.measuredPacket ?? {
    ...packetFor({
      questions: mergedQuestions,
      fieldOptions: shape.fieldOptions,
      coverLetter: over.approvedCoverLetter,
    }),
  };
  /* Exactly as the runner derives it: the packet THIS RUN assembled, rolled back to the inventory
   * the review carried before the run and to the rows the approval covered. Deriving it from the
   * approved fixture instead would hide every content change the run itself introduced. */
  const approvedPacketForDrift = approvedPacketBeforeDiscovery({
    packet: measuredPacket,
    approvedQuestions,
    priorSnapshot: undefined,
  });
  return {
    approvedQuestions,
    mergedQuestions,
    approvedEnvelope,
    measuredEnvelope,
    approvedPacket,
    approvedPacketForDrift,
    audit,
    measuredPacket,
  };
}

/** Run the carry exactly as the runner's prepare does, and return what it decided. */
function carry(shape: MeasuredShape, over: Parameters<typeof runOf>[1] = {}) {
  const run = runOf(shape, over);
  const learned = learnedFormQuestionRows({
    mergedQuestions: run.mergedQuestions,
    approvedQuestions: run.approvedQuestions,
    packetQuestions: run.measuredPacket.questions,
  });
  if (!learned) {
    return {
      ...run,
      learned: null,
      measuredQuestions: null,
      carried: null,
      reissued: null,
      issuesAfter: null,
    };
  }
  const measuredQuestions = [...run.approvedQuestions, ...learned];
  const learnedOnly = deliveryDriftIsLitosLearnedOnly({
    packet: run.measuredPacket,
    approvedPacket: run.approvedPacketForDrift,
    audit: run.audit,
    measuredQuestions,
    approvedQuestions: run.approvedQuestions,
    mode: 'browser',
    approvedEnvelope: run.approvedEnvelope,
    measuredEnvelope: run.measuredEnvelope,
  });
  if (!learnedOnly) {
    return { ...run, learned, measuredQuestions, carried: null, reissued: null, issuesAfter: null };
  }
  const reissued = auditFor({
    questions: measuredQuestions,
    packet: { ...run.measuredPacket, questions: packetQuestionsForFill(measuredQuestions) },
    envelope: run.measuredEnvelope,
    coverLetterSupported: over.coverLetterSupported,
  });
  const carried = relearnedFormReadingAcknowledgement({
    priorAudit: run.audit,
    priorAcknowledgement: acknowledgementOf(run.audit),
    reissuedAudit: reissued,
    acknowledgedAt: AT,
    learnedQuestions: { acknowledged: run.approvedQuestions, reissued: measuredQuestions },
  });
  return {
    ...run,
    learned,
    measuredQuestions,
    carried,
    reissued,
    issuesAfter: verifiedBuiltPacketIssues(
      run.measuredPacket, reissued, measuredQuestions, 'browser', run.measuredEnvelope,
    ),
  };
}

/* ---- the four measured shapes ------------------------------------------------------------ */

/* job-boards.greenhouse.io renders the EEOC self-identification set as react-select comboboxes
 * whose ids are bare numbers, and publishes their option lists only through the board API, so the
 * live read files missing_exact_options on all four and leaves them blank. */
const HUDSON_RIVER_TRADING: MeasuredShape = {
  packetId: '4a79eec1',
  portalFamily: 'greenhouse',
  destinationUrl: 'https://job-boards.greenhouse.io/hudsonrivertrading/jobs/4577001007',
  approved: [
    answered('q-hrt-1', 'Are you legally authorized to work in the United States?', 'Yes'),
    answered('q-hrt-2', 'Will you now or in the future require sponsorship?', 'Yes'),
  ],
  learned: [
    learnedAsk('245', 'What is your gender?', { portal_input_type: 'combobox' }),
    learnedAsk('248', 'Are you a veteran?', { portal_input_type: 'combobox' }),
    learnedAsk('249', 'Do you have a disability?', { portal_input_type: 'combobox' }),
    learnedAsk('250', 'What is your race/ethnicity?', { portal_input_type: 'combobox' }),
  ],
  fieldOptions: { 'question_4577001007': ['Yes', 'No'] },
};

const CONFLUENCE: MeasuredShape = {
  packetId: 'c9b0c807',
  portalFamily: 'pinpoint',
  destinationUrl: 'https://confluence.pinpointhq.com/postings/9c1f/applications/new',
  approved: [answered('q-conf-1', 'Why are you interested in this role?', 'I want to build reliable systems.')],
  learned: [learnedAsk('country', 'Country', { portal_input_type: 'combobox' })],
  fieldOptions: { 'first_name': [] as string[] },
};

const TIXTRACK: MeasuredShape = {
  packetId: '6703778e',
  portalFamily: 'teamtailor',
  destinationUrl: 'https://tixtrack.teamtailor.com/jobs/8287889/applications/new',
  approved: [answered('q-tix-1', 'How did you hear about this role?', 'Job board')],
  learned: [learnedAsk(
    'candidate_answers_attributes_4_choice_1',
    'Which of these states do you currently live in?* Required',
    { portal_input_type: 'radio' },
  )],
  fieldOptions: { 'candidate_answers_attributes_2': ['Yes', 'No'] },
};

const APOLLO_RESEARCH: MeasuredShape = {
  packetId: '0a5081aa',
  portalFamily: 'lever',
  destinationUrl: 'https://jobs.lever.co/apollo-research/ab017e9f/apply',
  approved: [answered('q-apollo-1', 'What draws you to safety research?', 'The work compounds.')],
  learned: [learnedAsk(
    'name:cards[ab017e9f-3f2b-4d1e-9c7a-77b0d5ee1a24][field0]',
    'cards field0',
    { portal_input_type: 'text' },
  )],
  fieldOptions: { 'name:urls[LinkedIn]': [] as string[] },
};

const SHAPES = [HUDSON_RIVER_TRADING, CONFLUENCE, TIXTRACK, APOLLO_RESEARCH];

for (const shape of SHAPES) {
  test(`${shape.packetId} ${shape.portalFamily}: the approval carries and the audit is re-issued`, () => {
    const before = runOf(shape);
    /* What prod actually reported on this packet, and it is two issues, not one: the ask, plus the
     * delivery-payload shadow the ask manufactures. That pair is what made the old carry
     * unreachable, so pin it before asserting the fix. */
    const issuesBefore = verifiedBuiltPacketIssues(
      before.measuredPacket, before.audit, before.approvedQuestions, 'browser', before.measuredEnvelope,
    );
    assert.deepEqual(issuesBefore, [
      PACKET_QUESTIONS_UNACKNOWLEDGED_ISSUE,
      'browser employer-delivery payload changed after packet approval',
    ]);
    assert.match(
      packetDriftAttentionReason(issuesBefore),
      /the questions this form asks, how Litos reaches this employer/,
      'the exact prod sentence, so the fix below is measured against it',
    );

    const result = carry(shape);
    assert.deepEqual(
      result.learned?.map((question) => question.question),
      shape.learned.map((question) => question.question),
      'exactly the rows discovery learned, and nothing of hers',
    );
    assert.ok(result.carried, 'her approval carried onto the re-issued audit');
    assert.equal(result.carried!.source, 'form_reading_measured');
    assert.equal(result.carried!.packet_version, result.reissued!.packet_version);
    assert.equal(result.carried!.audit_digest, result.reissued!.audit_digest);
    assert.equal(result.carried!.pdfSha256, before.audit.bindings.pdf.sha256, 'the same file she read');
    assert.equal(result.carried!.acknowledged_at, AT);
    /* The audit now binds the merged set, so the hold that stopped these four does not fire and the
     * run goes on to fill, screenshot and surface the questions. */
    assert.deepEqual(result.issuesAfter, []);
  });

  test(`${shape.packetId} ${shape.portalFamily}: what discovery learned still reaches her, unanswered`, () => {
    const result = carry(shape);
    const review = {
      questions: result.measuredQuestions!,
      question_metadata_blockers: [],
    };
    const gate = submissionQuestionGate(review);
    assert.equal(gate.clear, false, 'a learned required row with no answer can never reach the employer');
    assert.deepEqual(
      gate.requiredQuestionLabels,
      shape.learned.map((question) => question.question),
      'and it reaches her by name, on the answers screen',
    );
    // Nothing was auto-answered to make the carry possible.
    for (const question of result.learned ?? []) {
      assert.equal(question.answer, '');
      assert.equal(question.answer_source, undefined);
    }
  });
}

/* ---- the negatives: what must still hold ------------------------------------------------- */

test('a resume file that is not the one she read refuses the carry', () => {
  const result = carry(HUDSON_RIVER_TRADING, {
    measuredPacket: packetFor({
      questions: [...HUDSON_RIVER_TRADING.approved, ...HUDSON_RIVER_TRADING.learned],
      fieldOptions: HUDSON_RIVER_TRADING.fieldOptions,
      resume: Buffer.from('%PDF-1.7\na different file entirely'),
    }),
  });
  assert.equal(result.carried, null);
});

test('an answer of hers that moved refuses the carry, whatever else the form taught', () => {
  const [first, second] = HUDSON_RIVER_TRADING.approved;
  const rewritten = { ...second, answer: 'No' };
  const result = carry(HUDSON_RIVER_TRADING, {
    mergedQuestions: [first, rewritten, ...HUDSON_RIVER_TRADING.learned],
  });
  assert.equal(result.learned, null, 'a moved answer is drift, never a learned row');
  assert.equal(result.carried, null);
});

test('a cover letter the employer would receive instead of the approved one refuses the carry', () => {
  const approvedLetter = Buffer.from('%PDF-1.7\nthe letter she approved');
  const result = carry(TIXTRACK, {
    coverLetterSupported: true,
    approvedCoverLetter: approvedLetter,
    measuredPacket: packetFor({
      questions: [...TIXTRACK.approved, ...TIXTRACK.learned],
      fieldOptions: TIXTRACK.fieldOptions,
      coverLetter: Buffer.from('%PDF-1.7\na letter written after she approved'),
    }),
  });
  assert.equal(result.carried, null);
});

test('a different employer endpoint is never something the form taught Litos', () => {
  const result = carry(APOLLO_RESEARCH, {
    measuredDestinationUrl: 'https://jobs.lever.co/someone-else/ab017e9f/apply',
  });
  assert.equal(result.carried, null);
});

test('an option removed under an answer she already chose still holds', () => {
  /* reopenUnfitClosedChoiceQuestions blanks a stored answer that matches no exact option and moves
   * it to answer_draft, so the row arrives with her answer gone. That is a change to what she
   * approved, and it must read as drift rather than as a row Litos learned. */
  const [chosen] = TIXTRACK.approved;
  const reopened: ApplicationReviewQuestion = {
    ...chosen,
    answer: '',
    answer_draft: chosen.answer,
    answer_state: 'unanswered',
    answer_source: undefined,
    options: ['Recruiter', 'Referral'],
  };
  const result = carry(TIXTRACK, { mergedQuestions: [reopened, ...TIXTRACK.learned] });
  assert.equal(result.learned, null);
  assert.equal(result.carried, null);
});

test('a learned row that arrived with an answer on it is content she has not seen, and holds', () => {
  const withAnswer = [
    ...CONFLUENCE.approved,
    { ...CONFLUENCE.learned[0], answer: 'United Arab Emirates' },
  ];
  const result = carry(CONFLUENCE, { mergedQuestions: withAnswer });
  assert.equal(result.learned, null, 'a machine answer is not a question, and is never carried');
  assert.equal(result.carried, null);
});

test('a row she approved that vanished from the form is drift, not a better reading', () => {
  const result = carry(HUDSON_RIVER_TRADING, {
    mergedQuestions: [HUDSON_RIVER_TRADING.approved[0], ...HUDSON_RIVER_TRADING.learned],
  });
  assert.equal(result.learned, null);
});

/* ---- the sentence ------------------------------------------------------------------------ */

test('the ask no longer wears its own shadow as a second fault', () => {
  const issues = [
    PACKET_QUESTIONS_UNACKNOWLEDGED_ISSUE,
    'browser employer-delivery payload changed after packet approval',
  ];
  assert.equal(
    packetDriftIsQuestionAskOnly({ issues, mode: 'browser', approvedStillBinds: true }),
    true,
  );
  assert.match(
    packetDriftAttentionReason(issues, true),
    /^This company form asks questions your approved packet did not cover/,
  );
  // Without the proof that the approved packet still binds, nothing is collapsed.
  assert.equal(
    packetDriftIsQuestionAskOnly({ issues, mode: 'browser', approvedStillBinds: false }),
    false,
  );
  // A real drift riding alongside is never collapsed, proof or no proof.
  assert.equal(
    packetDriftIsQuestionAskOnly({
      issues: [...issues, 'resume file changed after packet approval'],
      mode: 'browser',
      approvedStillBinds: true,
    }),
    false,
  );
});
