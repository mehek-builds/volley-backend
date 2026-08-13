import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { PACKET_VISIBLE_QUESTION_FIELDS, type PacketAudit } from './packetAudit';
import type { RequiredDocumentAsk } from './requiredDocuments';
import type { SubmissionStopRecord } from './submissionStop';
import { canonicalSupportedPortalUrl, detectPortal, isPortalSupported, type AutofillApplicantSnapshot } from './portalSubmission';

export type ApplicationReviewQuestion = {
  id: string;
  question: string;
  answer: string;
  kind: 'essay' | 'required';
  required: boolean;
  portal_selector?: string;
  portal_input_type?: string;
  ats_api_field?: string;
  /* WHO PUT THIS ANSWER HERE, when it was not simply resolved from the profile.
   *
   * 'applicant_review' is her, typing on the review screen. 'consent_permission' is Litos accepting
   * an employer's privacy statement, applicant terms or code of conduct under the permission she
   * granted once at onboarding, and it exists so that the packet audit shows an acceptance made on
   * her behalf rather than a tick that reads as if she had made it herself. */
  answer_source?: 'applicant_review' | 'consent_permission';
  answer_reviewed_at?: string;
  /**
   * SHE READ THIS MACHINE-WRITTEN DRAFT AND LET IT STAND. A DIFFERENT CLAIM FROM WRITING IT.
   *
   * A SEPARATE FIELD RATHER THAN A THIRD `answer_source` VALUE, and the reason is the 802 answers.
   * `answer_source` names where the text CAME FROM, and an approved draft came from Litos. Spelling
   * approval as a source value would put a value in that field for 223 machine-written essay answers
   * across 93 live packets, and every reader that asks "which answers are attributed to the
   * applicant" by testing that field for presence - the shape of the blanket-stamp regression this
   * codebase already paid for once - would start counting them as hers. Left absent, it cannot be
   * misread. Nothing here says she wrote a word of it; it says she saw it and did not object.
   *
   * IT ALSO COMPOSES, which one enum field cannot. An answer she typed into a blank in round R and
   * then approved carries `answer_source: 'applicant_review'` AND this, and the record states both
   * facts instead of picking one.
   *
   * AN APPLICANT-CLAIM, keyed exactly like the other two: on record identity, against the round in
   * `answer_reviewed_at`. Approving is a statement about a record - this id, this label, this answer
   * - so a rename or a replaced answer falsifies it and it drops. The approval route writes
   * `answer_reviewed_at` beside it for that reason, and writes no `answer_source`.
   */
  answer_approved_at?: string;
  /**
   * The PROFILE VALUE this answer was snapped from, when discovery could read the control's options
   * and resolveProfileField picked one of them. "May 2028" beside an answer of
   * "January 2028 - July 2028"; "3.89" beside "3.81 - 3.9".
   *
   * It exists to make staleness DECIDABLE rather than guessed. The answer itself cannot say whether
   * it is current: "January 2027 - July 2027" is a perfectly well-formed option text long after the
   * applicant corrects her graduation to May 2028. Recording what it was derived from lets every
   * later pass ask the only question that settles it, "does the profile still say what it said when
   * this was chosen", and recompute when it does not. See refreshKnownQuestionAnswers.
   *
   * Optional forever. Every record written before this field existed lacks it, and absence is read
   * as "cannot prove current", which recomputes. jsonb, so no migration.
   *
   * A CONSENT ACCEPTANCE STILL RECORDS IT, and still does not use it to prove currency. A
   * select-shaped consent records "Yes" here beside an answer of "I agree", which is honest and
   * worth keeping, but the keep-branch this field feeds requires a date or number BAND and
   * "I agree" is neither, so borrowing it for consents made the branch unreachable and replaced the
   * employer's own option text with "Yes" on every refresh. What makes a consent current is whether
   * the permission is still granted, which refreshKnownQuestionAnswers now asks directly. See the
   * consent branch there.
   */
  answer_option_source?: string;
  /* The grant behind a 'consent_permission' answer: when she gave the permission, and the version of
   * the words she was shown when she gave it. Written per question rather than looked up later,
   * because the audit has to say what was true at the moment of the acceptance - revoking the
   * permission tomorrow must not make an application sent today unexplainable.
   *
   * ANSWER-CLAIMS, both of them, and the classification is the whole of how they are kept honest.
   * They assert that THIS ANSWER was accepted under a permission, so they live and die with the
   * answer: edit the control to "I do not agree" and they are gone, because the value they describe
   * is gone. See ANSWER_CLAIM_FIELDS below. */
  consent_permission_granted_at?: string;
  consent_permission_version?: string;
};

/* ---- the two kinds of provenance, and the rule that keys each one ----
 *
 * PR 496 shipped `answer_option_source` dropped at one site of three. PR 503 root-caused why that
 * kept happening and fixed it with the distinction below rather than with another list. This branch
 * adds two fields and classifies them rather than re-deriving anything.
 *
 * AN APPLICANT-CLAIM asserts something about the RECORD and about what the applicant did with it:
 * "she read this exact text and let it stand". A rename, a stale review round or a re-issued id can
 * falsify that without the answer changing at all, so it is keyed on record identity
 * (exactReviewedIdentityUnchanged) and drops the moment that identity moves.
 *
 * AN ANSWER-CLAIM asserts something about the ANSWER: "this value was snapped for profile value X",
 * "this value was accepted under a standing permission granted at T". Only replacing the answer can
 * falsify it, so it is keyed on `answerUnchanged` and survives exactly as long as the answer does,
 * byte for byte. Keying one of these on record identity is the PR 503 defect: an untouched Save
 * posts back a machine-resolved answer with no answer_source at all, record identity fails, and a
 * claim that was still perfectly true is discarded.
 *
 * THE CONSENT FIELDS ARE ANSWER-CLAIMS, and that classification is what closes the hole they were
 * blocked for: when the applicant edits a consent to "I do not agree" the answer changed, so the
 * acceptance grant drops with it. No strip site had to remember them.
 *
 * The two lists partition AnswerProvenanceField exactly, checked at compile time below, so a field
 * added without being classified does not build.
 */
type AnswerProvenanceField =
  | 'answer_source'
  | 'answer_reviewed_at'
  | 'answer_approved_at'
  | 'answer_option_source'
  | 'consent_permission_granted_at'
  | 'consent_permission_version';

/** Keyed on RECORD IDENTITY. Falsified by a rename or a stale review round. */
export const APPLICANT_CLAIM_FIELDS = ['answer_source', 'answer_reviewed_at', 'answer_approved_at'] as const;
/** Keyed on THE ANSWER. Falsified only by replacing the answer. */
export const ANSWER_CLAIM_FIELDS = [
  'answer_option_source',
  'consent_permission_granted_at',
  'consent_permission_version',
] as const;

/* The partition, enforced by the compiler rather than by a reviewer.
 *
 * Written as a call rather than an assignment so the error NAMES the offending field: leaving
 * `answer_translated_from` out of both lists fails with `Argument of type 'true' is not assignable
 * to parameter of type '"answer_translated_from"'`, which tells the next person what to do. An
 * assignment to `never` compiles to "Type 'true' is not assignable to type 'never'", which does not.
 *
 * Being in BOTH lists is caught the same way, from the other direction: a field keyed two ways is
 * keyed by whichever branch runs first, which is not a decision anybody made. */
type Classified = (typeof APPLICANT_CLAIM_FIELDS)[number] | (typeof ANSWER_CLAIM_FIELDS)[number];
type Unclassified =
  | Exclude<AnswerProvenanceField, Classified>
  | Exclude<Classified, AnswerProvenanceField>
  | ((typeof APPLICANT_CLAIM_FIELDS)[number] & (typeof ANSWER_CLAIM_FIELDS)[number]);
function assertEveryProvenanceFieldIsClassifiedExactlyOnce(
  _classified: [Unclassified] extends [never] ? true : Unclassified,
): void { void _classified; }
assertEveryProvenanceFieldIsClassifiedExactlyOnce(true);

/* The second partition, enforced exactly like the one above and for the same reason.
 *
 * Every key of ApplicationReviewQuestion is either something the employer receives - which makes it
 * part of packet identity, hashed into packet_version - or something the record remembers about how
 * the answer got there, which does not. The list itself lives in packetAudit.ts beside the hash it
 * governs; this is the half that has to be here, because this is where the question type is and
 * `keyof` is what makes the check exhaustive.
 *
 * Adding `answer_translated_from` to the type without putting it on one of the two lists fails with
 * `Argument of type 'true' is not assignable to parameter of type '"answer_translated_from"'`, which
 * names the field and states the decision the next person has to make. Putting it on both lists is
 * caught the same way from the other direction. */
type PacketVisibleQuestionField = (typeof PACKET_VISIBLE_QUESTION_FIELDS)[number];
type QuestionFieldClassification = PacketVisibleQuestionField | AnswerProvenanceField;
type UnclassifiedQuestionField =
  | Exclude<keyof ApplicationReviewQuestion, QuestionFieldClassification>
  | Exclude<QuestionFieldClassification, keyof ApplicationReviewQuestion>
  | (PacketVisibleQuestionField & AnswerProvenanceField);
function assertEveryQuestionFieldIsPacketVisibleOrProvenance(
  _classified: [UnclassifiedQuestionField] extends [never] ? true : UnclassifiedQuestionField,
): void { void _classified; }
assertEveryQuestionFieldIsPacketVisibleOrProvenance(true);

export type ApplicationAttentionCategory =
  | 'captcha'
  /* The portal will not expose an application form until the applicant signs in, creates an
   * account, or completes the account recovery step. This is not a required application field and
   * it is not evidence that anything has reached the employer. */
  | 'account_login'
  /* The portal is waiting for the applicant to make a legal privacy choice before it exposes the
   * application form. Litos may describe and hand off this gate, but never operates it. */
  | 'privacy_consent'
  /* The employer emailed a security code and will not file the application until it is entered and
   * the form is submitted again. Distinct from 'captcha' on purpose: a CAPTCHA is a widget on the
   * page and the applicant has to go and solve it there, while this is an email round trip that
   * Litos can finish for her the moment she types eight characters. Three packets on 2026-08-08
   * (Redwood Materials, Scale AI, Cresta) sat in this state wearing 'ready_for_final_approval' and
   * no category at all. */
  | 'security_code'
  /* The run never got to the application form at all: no field was typed, no control was located,
   * nothing was discovered. Deliberately NOT 'evidence_gap', which means the opposite - the form
   * was reached and the evidence of specific fields is missing. Five owner packets on 2026-08-06
   * (Akuna x3, Jump Trading, Nuro) were filed as evidence_gap with three sentences describing a
   * filled form, when the preview screenshots show a job description page and, for Jump Trading, a
   * branded careers page with no form on it at all. */
  | 'form_not_reached'
  /* The run threw and stopped. Every terminal state owes a cause, and before this existed a run
   * could end in status 'failed' with attention_reason unset, which is unactionable for the
   * applicant and undebuggable for us. */
  | 'run_failed'
  /* This user has already sent an application to this posting, and Litos refused to send a second.
   * Deliberately NOT 'run_failed': nothing broke. Twelve packets existed for one Akuna posting on
   * 2026-08-06, and had any of them reached the send they would all have gone, against an employer
   * whose own form carries a season-long exclusivity acknowledgement. */
  | 'duplicate_application'
  /* Litos pressed submit, or may have, and cannot say what came back. Its own category rather than
   * 'unknown' because it is the one attention state whose next step is a person LOOKING at
   * something rather than a person fixing something, and because a state this expensive to be in
   * has to be countable. */
  | 'unverified_submission'
  /* The packet's generated resume passed its 30-day retention window and the file was deleted, so
   * there was nothing to send and nothing was sent. Deliberately NOT 'required_document', which
   * means an EMPLOYER is waiting on a document from the applicant, and deliberately not
   * 'run_failed', which is the "Litos broke, try again" bucket: retrying changes nothing here and
   * only regenerating does. It is also the one attention state that is a promise being kept rather
   * than a defect, so it has to be countable separately from the defects. */
  | 'packet_expired'
  | 'required_document'
  | 'sensitive_attestation'
  | 'required_field'
  | 'evidence_gap'
  | 'cover_letter'
  | 'unknown';

export function normalizeApplicationReviewQuestions(
  questions: readonly ApplicationReviewQuestion[],
): ApplicationReviewQuestion[] {
  const normalized: ApplicationReviewQuestion[] = [];
  const indexByQuestion = new Map<string, number>();
  for (const question of questions) {
    const key = questionKey(question.question);
    if (!key) {
      normalized.push(question);
      continue;
    }
    const existingIndex = indexByQuestion.get(key);
    if (existingIndex === undefined) {
      indexByQuestion.set(key, normalized.length);
      normalized.push(question);
      continue;
    }
    const existing = normalized[existingIndex];
    const portalSelector = preferredPortalSelector(existing.portal_selector, question.portal_selector);
    const portalInputType = question.portal_input_type ?? existing.portal_input_type;
    const atsApiField = question.ats_api_field ?? existing.ats_api_field;
    if ((question.required && !existing.required) || (!existing.answer.trim() && question.answer.trim())) {
      const next = {
        ...existing,
        required: existing.required || question.required,
        answer: existing.answer.trim() ? existing.answer : question.answer,
      };
      normalized[existingIndex] = {
        ...next,
        ...(portalSelector ? { portal_selector: portalSelector } : {}),
        ...(portalInputType ? { portal_input_type: portalInputType } : {}),
        ...(atsApiField ? { ats_api_field: atsApiField } : {}),
      };
    } else if (
      (portalSelector && portalSelector !== existing.portal_selector)
      || (portalInputType && portalInputType !== existing.portal_input_type)
      || (atsApiField && atsApiField !== existing.ats_api_field)
    ) {
      normalized[existingIndex] = {
        ...existing,
        ...(portalSelector ? { portal_selector: portalSelector } : {}),
        ...(portalInputType ? { portal_input_type: portalInputType } : {}),
        ...(atsApiField ? { ats_api_field: atsApiField } : {}),
      };
    }
  }
  return normalized;
}

export function mergeSubmittedApplicationReviewQuestions(
  stored: readonly ApplicationReviewQuestion[],
  submitted: readonly ApplicationReviewQuestion[],
  questionsReviewedAt?: string,
): ApplicationReviewQuestion[] {
  const submittedByQuestion = new Map<string, { question: ApplicationReviewQuestion; index: number }>();
  const submittedByUniqueId = new Map<string, { question: ApplicationReviewQuestion; index: number } | undefined>();
  for (const [index, question] of submitted.entries()) {
    const key = questionKey(question.question);
    if (key) submittedByQuestion.set(key, { question, index });
    submittedByUniqueId.set(
      question.id,
      submittedByUniqueId.has(question.id) ? undefined : { question, index },
    );
  }
  const consumedSubmittedIndexes = new Set<number>();
  const merged = stored.map((question) => {
    // The normalized text is the ordinary semantic identity. The id fallback exists only so a
    // public caller cannot evade invalidation by renaming a reviewed question while retaining its
    // server-issued id. Ambiguous duplicate ids are intentionally not matched.
    const submittedMatch = submittedByQuestion.get(questionKey(question.question))
      ?? submittedByUniqueId.get(question.id);
    if (!submittedMatch) {
      /* APPLICANT-CLAIMS ONLY. This branch does not replace the answer, so every answer-claim on it
       * is still true and survives, INCLUDING the consent grant - a stored consent that no submit
       * body mentioned was not edited, and its acceptance record is as valid as it was. Stripping
       * answer-claims here is the PR 496 defect that PR 503 root-caused; it must not be re-added
       * for the consent fields by "being thorough". */
      const {
        answer_source: _answerSource,
        answer_reviewed_at: _answerReviewedAt,
        answer_approved_at: _answerApprovedAt,
        ...questionWithoutProvenance
      } = question;
      return questionWithoutProvenance;
    }
    const { question: submittedQuestion, index: submittedIndex } = submittedMatch;
    consumedSubmittedIndexes.add(submittedIndex);
    const portalSelector = preferredPortalSelector(question.portal_selector, submittedQuestion.portal_selector);
    const portalInputType = submittedQuestion.portal_input_type ?? question.portal_input_type;
    const atsApiField = question.ats_api_field;
    /* AN APPLICANT-CLAIM ON THIS RECORD, ANCHORED TO THE ROUND A READER CAN CHECK IT AGAINST.
     *
     * Two ways to hold one: she supplied the answer ('applicant_review'), or she approved the draft
     * Litos wrote ('answer_approved_at'). Both are statements about what SHE did with this record,
     * both are only readable beside the `questions_reviewed_at` they equal, and both are therefore
     * keyed the same way, on the exact reviewed identity below.
     *
     * THE APPROVAL IS AN `||`, NOT A WIDENING OF THE MINT RULE. Nothing here creates a claim; this
     * only decides whether a claim ALREADY on the record survives being posted back. What may mint
     * one is unchanged: applicantSuppliedAnswer below, for a blank she filled, and nothing else on
     * this path. An approval is minted by the approval route, one answer per request. */
    const provenanceMatchesCurrentReview = (
      question.answer_source === 'applicant_review'
      || typeof question.answer_approved_at === 'string'
    )
      && typeof question.answer_reviewed_at === 'string'
      && question.answer_reviewed_at === questionsReviewedAt;
    const exactReviewedIdentityUnchanged = provenanceMatchesCurrentReview
      && submittedQuestion.id === question.id
      && submittedQuestion.question === question.question
      && questionKey(submittedQuestion.question) === questionKey(question.question)
      && submittedQuestion.answer === question.answer;
    /* answer_option_source goes with the answer it describes, and `answer` is replaced below.
     *
     * A derivation that outlives its value claims a snap that never happened for what the record now
     * holds. Nothing downstream can detect that from the record alone, and storedOptionAnswerIsCurrent
     * would read the inherited derivation as proof the answer is current. So the test is the only one
     * that settles it: is the answer being written the answer it was derived for.
     *
     * THAT TEST IS `answerUnchanged`, AND IT IS NOT exactReviewedIdentityUnchanged. The two agree on
     * every record the applicant has already hand-edited once and disagree on every other record,
     * because exactReviewedIdentityUnchanged also demands answer_source 'applicant_review'. The
     * ordinary question record is machine-resolved and has no answer_source at all - on 2026-08-12
     * that was 2790 of 2790 in production - so keying the derivation on it dropped the derivation
     * from a record whose answer had not moved by so much as a byte.
     *
     * Which is exactly what a save from the review screen looks like. questionSchema strips every
     * provenance key, so an untouched screen posts back the answer alone; the merge stripped the
     * derivation, and refreshKnownQuestionAnswers, called on this function's output at the same call
     * site, then found a band with nothing to prove it current and replaced it with the raw profile
     * fact. "January 2028 - July 2028" became "May 2028", which is not on that control's option list
     * and never could be. Pressing Save and changing nothing undid the resolution.
     *
     * answer_source and answer_reviewed_at stay keyed on the stricter identity. They are a claim
     * about the APPLICANT ("she read this exact text and let it stand"), which a rename or a
     * stale review round can falsify. This is a claim about the ANSWER ("it was snapped for profile
     * value X"), and only replacing the answer can falsify that. Different claims, different tests. */
    const answerUnchanged = submittedQuestion.answer === question.answer;
    /* FILLING A BLANK IS THE ONE THING A HELD QUESTION IS ASKING FOR, AND ONLY SHE CAN DO IT.
     *
     * refreshKnownQuestionAnswers blanks every answer to a question the resolver holds unless the
     * record proves the applicant supplied it, and it runs on this function's OUTPUT at the same
     * call site in routes/applications.ts, which then persists what comes back. So a submit body
     * that fills one of those blanks had its value adopted here, stripped of any claim about where
     * it came from, and deleted one line later - on the request that reaches the employer.
     *
     * Measured on 2026-08-12 on the IMC prior-application question: merged answer "No", refreshed
     * answer "". That is the whole human-owned category - every question Litos deliberately hands
     * back - unanswerable through the send path.
     *
     * NOTHING IS INVENTED HERE AND NOTHING CAN BE. The value is the caller's own bytes, adopted
     * verbatim below whatever this decides; this only records that they came from her, so the
     * refusal branch can tell "she answered it" from "an earlier run resolved it". Litos still
     * writes no answer of its own for a held question, which is the property the hold exists for.
     *
     * A BLANK STORED ANSWER, DELIBERATELY, AND NOT MERELY A CHANGED ONE. answer_source is an
     * APPLICANT-CLAIM keyed on the exact reviewed identity, and a REPLACED answer invalidates that
     * identity by rule - see the classification in ANSWER_CLAIM_FIELDS and the tests in
     * answerProvenanceClasses.test.ts, which pin "I agree" edited to "I do not agree" dropping the
     * claim. Filling a blank is the one case that does not collide with it: there was no reviewed
     * identity to invalidate, so recording who filled it asserts nothing the old rule denied.
     *
     * WHAT THAT LEAVES OPEN, STATED. Replacing an EXISTING answer to a held question still loses the
     * claim and is still blanked. Closing that means reclassifying answer_source, which is a
     * deliberate design decision with its own test suite behind it and is not this fix's to make.
     *
     * AND ONLY AGAINST A REVIEW ROUND THAT EXISTS. `answer_reviewed_at` is only meaningful beside the
     * `questions_reviewed_at` it equals; writing one without the other would leave a claim no reader
     * can check, and the refusal branch would discard it anyway. */
    const applicantSuppliedAnswer = Boolean(
      questionsReviewedAt && !question.answer.trim() && submittedQuestion.answer.trim(),
    );
    const {
      answer_source: _answerSource,
      answer_reviewed_at: _answerReviewedAt,
      /* Stripped here for the same reason as the two above it, and it is the reason the approval is
       * worth recording at all: this branch runs when the reviewed identity MOVED, which for an
       * approval means the words she approved are not the words being stored. An approval that
       * survived that would say she signed off on text she never saw. */
      answer_approved_at: _answerApprovedAt,
      answer_option_source: _answerOptionSource,
      consent_permission_granted_at: _consentGrantedAt,
      consent_permission_version: _consentVersion,
      ...questionWithoutProvenance
    } = question;
    /* Every ANSWER-CLAIM rides on `answerUnchanged`, by the rule above rather than field by field.
     * The consent grant is one of them: an applicant who edits this control to "I do not agree" has
     * changed the answer, so the record stops saying it was accepted under a machine permission. */
    const carriedAnswerClaims: Partial<Pick<ApplicationReviewQuestion, (typeof ANSWER_CLAIM_FIELDS)[number]>> = {};
    if (answerUnchanged) {
      for (const field of ANSWER_CLAIM_FIELDS) {
        const value = question[field];
        if (value !== undefined) carriedAnswerClaims[field] = value;
      }
    }
    const carriedForward = exactReviewedIdentityUnchanged
      ? question
      : { ...questionWithoutProvenance, ...carriedAnswerClaims };
    return {
      ...carriedForward,
      answer: submittedQuestion.answer,
      kind: submittedQuestion.kind,
      required: question.required || submittedQuestion.required,
      // The stored label is the form identity. A public submit body may update an answer but cannot
      // rename that control, including by changing only case or whitespace, then inherit the proof
      // attached to the exact text the applicant reviewed.
      question: question.question,
      ...(portalSelector ? { portal_selector: portalSelector } : {}),
      ...(portalInputType ? { portal_input_type: portalInputType } : {}),
      ...(atsApiField ? { ats_api_field: atsApiField } : {}),
      // Last, so it wins over anything carriedForward brought along. See applicantSuppliedAnswer.
      ...(applicantSuppliedAnswer
        ? { answer_source: 'applicant_review' as const, answer_reviewed_at: questionsReviewedAt }
        : {}),
    };
  });
  const storedKeys = new Set(stored.map((question) => questionKey(question.question)).filter(Boolean));
  for (const [index, question] of submitted.entries()) {
    if (consumedSubmittedIndexes.has(index)) continue;
    const key = questionKey(question.question);
    if (!key || storedKeys.has(key)) continue;
    /* A question that exists only in the submit body brings no provenance with it, including the
     * option derivation. The three above are stripped because a caller must not assert that the
     * applicant reviewed or approved something; this one because a derivation is a claim that
     * resolution snapped this answer onto a control's own option list, and nothing here resolved
     * anything. The route's questionSchema drops the key before this is ever called, but this
     * function is exported and this is the one branch that copies a submitted question wholesale. */
    const {
      answer_source: _answerSource,
      answer_reviewed_at: _answerReviewedAt,
      answer_approved_at: _answerApprovedAt,
      answer_option_source: _answerOptionSource,
      consent_permission_granted_at: _consentGrantedAt,
      consent_permission_version: _consentVersion,
      ...submittedWithoutProvenance
    } = question;
    merged.push(submittedWithoutProvenance);
  }
  return normalizeApplicationReviewQuestions(merged);
}

function questionKey(question: string): string {
  return question.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isTemporaryPortalSelector(selector: string | undefined): boolean {
  return selector?.trim().startsWith('[data-litos-discovered-') === true;
}

function preferredPortalSelector(existing: string | undefined, next: string | undefined): string | undefined {
  if (!next) return existing;
  if (!existing || isTemporaryPortalSelector(existing)) return next;
  if (!isTemporaryPortalSelector(next)) return next;
  return existing;
}

/* One attempt at the emailed code, and what the page did with it.
 *
 * The code is never stored, only a salted digest of it (securityCodeFingerprint). That digest is
 * what makes the endpoint idempotent: the same code supplied twice is recognised and answered from
 * here rather than driving a second run at a live employer's form. */
export type SecurityCodeAttempt = {
  at: string;
  fingerprint: string;
  /* 'accepted' - the challenge was gone after the resubmit, which is the only thing that counts as
   *   accepted, and it is read off the control rather than off any success message.
   * 'rejected' - the code was typed, the form was sent again, and the challenge was still there.
   * 'not_entered' / 'no_control' - the run could not put the code into the page at all, which is a
   *   Litos defect and not the applicant's mistake, and must not be reported to her as a bad code.
   * 'superseded' - the code was never typed BECAUSE IT COULD NOT BE. Greenhouse issues a new code
   *   on every send and invalidates the last one, measured on a live Cresta application on
   *   2026-08-09 (20:24:03, 21:13:07, 21:13:53, three codes, each one killing its predecessor), and
   *   a code control only exists on a page that has just been sent. So a code handed to Litos out
   *   of band is dead the moment the run that could use it has to send the form to reach a field to
   *   type it into. This is recorded rather than silently dropped for one reason: the fingerprint is
   *   what stops the same dead code triggering a second send, and every send costs her another
   *   email. It is never her mistake and must never be reported as a wrong code.
   * 'error' - the run threw. */
  outcome: 'accepted' | 'rejected' | 'not_entered' | 'no_control' | 'superseded' | 'error';
};

export type SecurityCodeState = {
  /* How many characters the CONTROL asked for. 0 means the page did not say. */
  digits: number;
  /* The address the employer said it sent the code to, read from inside the control's own group. */
  sent_to?: string;
  /* When the submit that triggered this happened. */
  requested_at: string;
  /* Whether that submit came from the authorized path. False is a defect report; see
   * beginSecurityCodeState. */
  submit_was_authorized: boolean;
  attempts?: SecurityCodeAttempt[];
};

export type ApplicationReviewState = {
  jd_text: string;
  role?: string;
  portal_url?: string;
  ats_name?: string;
  status:
    | 'resume_ready'
    | 'questions_ready'
    | 'ready_to_submit'
    | 'submit_requested'
    | 'preparing'
    | 'filling'
    | 'needs_attention'
    | 'ready_for_final_approval'
    /* SUBMITTED ONCE, NOT FILED, WAITING ON AN EMAILED CODE.
     *
     * Its own status rather than a flavour of needs_attention, because the two safety questions
     * have opposite answers here. needs_attention before a click is re-runnable, and this must
     * never be: the form has already been sent to the employer once. needs_attention is also
     * offered as "open the portal and finish it yourself", and this needs the opposite - Litos can
     * finish it, it just needs eight characters out of her mailbox.
     *
     * And emphatically not the ready-for-final-approval status above, which is what all three
     * measured packets were wearing on 2026-08-08 while the employer had already received a
     * submission and was waiting on a code. That status renders a green "Send it" button, and
     * pressing it submits again with no code: another code email, and still nothing filed.
     *
     * (Status names are spelled out rather than quoted in this block on purpose:
     * submissionTerminalCause.test.ts parses this union out of the source by scanning for quoted
     * lowercase tokens, so a quoted name in a comment reads as a member of the union.) */
    | 'awaiting_security_code'
    | 'submitting'
    | 'submission_claimed'
    | 'submitted'
    | 'failed';
  edited_terms: string[];
  questions: ApplicationReviewQuestion[];
  questions_reviewed_at?: string;
  skipped_reasons: string[];
  /* THE RAW PROVIDER TEXT FOR THE ANSWERS NOBODY ACCOUNTED FOR, and nothing else raw.
   *
   * skipped_reasons is the sanitized, human-facing set. It was the ONLY thing this row kept, and
   * that is why three separate rounds of investigation each had to re-derive what the managed
   * provider had actually said about a lost value: the sanitizer had already thrown the evidence
   * away by the time anything was written down. Storing the whole of `result.skipped` was never the
   * answer either, since a large Greenhouse packet emits well over a hundred lines of "this
   * optional selector matched nothing".
   *
   * So this keeps the provider's own words for exactly the labels where Litos typed a value, the
   * form did not keep it, and the run offered no explanation. That is a set of size zero or one on
   * a healthy run. Diagnostic, never displayed: managedUnexplainedAnswerReasons writes the sentence
   * she reads. See R-122. */
  unexplained_fills?: { label: string; question: string; raw: string[] }[];
  updated_at: string;
  /* WHICH BUILD WROTE THIS REVIEW, so a reader can tell "this stopped for a reason" apart from
   * "this has not been tried since the fix".
   *
   * updated_at alone cannot make that distinction. A packet whose run was REFUSED keeps the
   * attention_reason, the filled_fields and the blocker sentences of the last run that actually
   * happened, and nothing on the row says which code produced them. On 2026-08-08 that produced an
   * identical results distribution reported twice from two different builds, and very nearly the
   * conclusion that a shipped fix had failed when it had never executed.
   *
   * Written by the runner on every review it writes (see nextReview in submissionRunner.ts), which
   * is the only writer whose output is evidence ABOUT a build. Compare it to the `revision` field of
   * GET /health, or to the board's own `revision`, both of which come from lib/buildInfo: equal
   * means this review is evidence about the code running now, different means it is evidence about
   * an older one and the packet has to be re-run before its findings mean anything.
   *
   * Absent on every packet written before this shipped, and on any deployment that supplied no SHA
   * at all (see resolveRevision). Absent means unknown, never "current". */
  run_revision?: string;
  submitted_at?: string;
  submission_error?: string;
  submission_run_id?: string;
  browser_context_id?: string;
  browser_session_id?: string;
  /* The exact application-form URL observed by the managed runner when a network-reputation page
   * stopped it. This is server evidence, not a URL supplied by the extension. SmartRecruiters uses
   * an opaque publication UUID that cannot be derived from its public posting URL, so an attended
   * refill may use this URL only when it exactly matches the form currently open in Chrome. */
  extension_handoff_url?: string;
  /** Server-owned digest of the exact attended URL and typed cause observed for this application. */
  extension_handoff_binding?: {
    version: 'dashboard_handoff_v1';
    sha256: string;
  };
  attention_reason?: string;
  attention_categories?: ApplicationAttentionCategory[];
  /* The TYPED half of attention_reason, which is prose and always will be.
   *
   * attention_reason is written for a person and is the right thing to show them. It is the wrong
   * thing to count: "how often does a challenge stop us, on which boards, and how long until it
   * clears" cannot be answered by grepping sentences. This is the machine-readable companion.
   * Nothing here is meant for DISPLAY, but it is not server-private either: the whole review object
   * is serialized to the dashboard and the extension, so this reaches clients.
   *
   * stalled_at is the QUEUE'S SORT KEY, not a duplicate of updated_at. updated_at moves on every
   * write, including writes that have nothing to do with the stall, so ordering a "waiting on you"
   * list by it would reshuffle the queue under the applicant. It survives re-observation of the
   * same challenge and only restarts after a resolved stall.
   *
   * A stall is CLOSED (resolved_at), never deleted, when the application stops waiting on a human.
   * See settleStall in applicationStall.ts: deleting it broke the clock and threw away the
   * time-to-resolution measurement. The queue selects on status, so a resolved stall is invisible
   * to it without needing to be destroyed. */
  stall?: {
    kind: 'human_verification';
    stalled_at: string;
    /* Where it stopped, because the two surfaces owe the applicant different next actions: a
     * server run needs them to open the portal themselves, an extension stall is already in front
     * of them. Only 'server_run' is written today; the extension writes 'extension' in step 4. */
    surface: 'server_run' | 'extension';
    provider: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'arkose' | 'unknown';
    /* 'before_fill' means nothing was filled and the form is still blank. Governs which sentence
     * the applicant gets, and stops the queue promising a filled form that does not exist.
     *
     * THE TEST IS WHAT THE RUN ACTUALLY DID, not where in the code the write happens. A stall
     * written during prepare is 'at_submit' whenever that prepare filled the form and captured the
     * preview, on either browser provider, because by then the applicant has a screenshot of her own
     * filled application. 'before_fill' is for the stops that never touched the page: the
     * pre-browser gate on CAPTCHA-gated families, and the submit path's probe. Getting this
     * backwards is not a cosmetic mislabel - it is what puts "nothing is filled in yet" in the nudge
     * email about a form Litos completed and showed her. */
    stage: 'before_fill' | 'at_submit';
    /* Whether the provider was seen on a live page or inferred from the portal family. An inferred
     * label must never be counted as evidence a family really uses that provider. */
    source: 'observed' | 'assumed';
    /* Set when the application stops waiting on a human. Presence means "this stall is over", and
     * resolved_at minus stalled_at is the time-to-resolution the instrumentation needs. */
    resolved_at?: string;
    /* When the applicant was emailed about this one. Written back after a successful send, and the
     * reason the nudge is not a daily letter: without it every open stall re-qualifies on every
     * run, so someone who saw the check and decided not to finish that application would hear about
     * it again every day forever. */
    nudged_at?: string;
  };
  /* WHEN A SUBMIT PROVABLY REACHED THE EMPLOYER, whoever made it and whether or not it was allowed.
   *
   * Deliberately separate from submitted_at, which means "filed, and here is the receipt", and from
   * submission_claimed_at, which means "a claim was taken immediately before a click we authorized".
   * Neither could describe the three packets of 2026-08-08: all three had every one of those fields
   * null, and all three had a Greenhouse security-code email timestamped to the minute of the run.
   * An application had reached an employer and no field in this object could say so. */
  submission_attempted_at?: string;
  /* WHERE THE LAST RUN STOPPED, TYPED, and whether that stop provably preceded the final click.
   *
   * The companion to submission_attempted_at above and its exact opposite in intent: that field
   * records that a submit MAY have landed, this one records a stop that is structurally ahead of the
   * click. Written by the runner at failure time, which is the only moment the answer is known for
   * certain, and read by submissionProvablyNotSent.
   *
   * IT EXISTS BECAUSE THE ONLY PRIOR PROOF WAS A SENTENCE. A row read back out of the database
   * carried nothing about its stop except attention_reason, which is prose, and submission_error,
   * which is whatever text the runner happened to throw - and a Stratus error crosses the HTTP
   * boundary stringified, so `Error: ` on the front of it was enough to make the one predicate that
   * read it answer false at the writer AND at the reader. A typed field cannot be reworded.
   *
   * ABSENT MEANS UNKNOWN, NEVER "nothing was sent". Every row written before this shipped has no
   * record, and no reader may treat that as a pre-click stop. See lib/submissionStop.ts.
   *
   * Cleared, not carried, whenever a new send run takes the claim: a stop is evidence about ONE
   * attempt, and a stale one read as current would be the same false certainty this whole field
   * exists to remove. */
  submission_stop?: SubmissionStopRecord;
  security_code?: SecurityCodeState;
  handoff_expires_at?: string;
  final_approved_at?: string;
  /* WHETHER THIS FORM HAS A COVER-LETTER FILE CONTROL LITOS CAN ATTACH TO. Nothing more.
   *
   * Written from hasCoverLetterUpload / managedResultHasCoverLetterUpload, both of which count file
   * inputs matching COVER_LETTER_UPLOAD_SELECTORS. It is a statement about the PORTAL's capability
   * and about Litos's ability to use it, and it is deliberately FALSE on JazzHR and Breezy, whose
   * employers do accept a cover letter but take it as a textarea Litos cannot attach a PDF to.
   *
   * It has never meant "the employer requires a cover letter", and reading it that way is what made
   * Cresta packet 8142004c-3358-4538-8778-16df5e31c5bb unsendable: a complete Greenhouse form, every
   * required field filled, a live cover letter control that carried no required marker while First
   * Name, Last Name and Email all did, and POST /submission/approve refusing it 422 forever. See
   * cover_letter_required below, which is the field that answers the question the approve gate was
   * asking this one. */
  cover_letter_supported?: boolean;
  /* WHETHER THE EMPLOYER MARKED THE COVER LETTER REQUIRED, measured on their own form.
   *
   * Read off the run's blocker list rather than off a new browser capability, because the blocker
   * list is already the product's single answer to "which fields did this employer mark required":
   * native `required`, `aria-required`, Ashby's `_required_` label class, and Greenhouse's asterisk
   * printed into a label. Both providers compute it, both write it into attention_reason, and the
   * fill run never attaches an unapproved letter - so on a form that requires one, the control is
   * empty when the scan runs and the scan names it. Absence of that line, on a form that HAS the
   * control and had it empty, is therefore evidence the control is optional.
   *
   * Tri-state on purpose. `undefined` means no run has measured it (every packet stored before this
   * field existed, and every portal with no cover-letter control at all), and undefined must never
   * block a send: an application that is otherwise complete is not made wrong by a cover letter
   * nobody asked for. Only `true` blocks. If the measurement is ever wrong in the quiet direction,
   * the submit-time readiness gate still fails closed on a required-and-empty control, so the cost
   * is a handoff rather than a half-blank application at an employer. */
  cover_letter_required?: boolean;
  /* WHETHER THE RUN THAT FILLED THIS FORM ACTUALLY CARRIED A COVER LETTER.
   *
   * buildPacket attaches a letter only once `_cover_letter.approved_at` is set, so a generated but
   * unreviewed draft is NOT sent and the form correctly records no cover-letter field. The approve
   * gate used to assert "the filled form recorded the cover letter attachment" whenever a letter
   * existed on the row at approve time, which asserts something that never happened and is exactly
   * how Cresta failed. Recorded here, at the run, so the evidence check can ask what the run did
   * rather than infer it from state that has since moved. */
  cover_letter_attached?: boolean;
  /* Whether Litos can fill in this posting's application page AT ALL, derived from portal_url.
   *
   * Unlike cover_letter_supported, which can only be answered by looking at a live form mid-run,
   * this one is knowable the moment the packet exists - and not knowing it was the bug. Packets on
   * company-owned careers pages sat in the Tracker labelled "Ready" behind a live send button and
   * only revealed themselves after a multi-minute run failed with "This portal is not supported
   * yet". Honest at creation beats honest at minute three.
   *
   * Derived on read (see readApplicationReview) rather than only written at creation, so packets
   * created before this existed answer correctly too, with no migration. */
  portal_supported?: boolean;
  submission_claimed_at?: string;
  submission_claim_id?: string;
  /** Exact server-audited packet reserved by an extension submission claim. */
  submission_packet_version?: string;
  /* WHICH ADDRESS THE EMPLOYER WAS GIVEN, and why that one.
   *
   * Litos prefers a per-application alias so replies come back through the product and can be
   * shown next to the application. On 2026-08-08 the alias domain had no MX record, so the address
   * on every submitted form could not receive mail at all, and nothing anywhere recorded that.
   * The fallback to the applicant's real address is now automatic, and it is written down here
   * because a SILENT fallback is its own defect: `tracked` false means the thread is in her own
   * mailbox and Litos will never see it, and no surface may promise otherwise.
   *
   * Absent on every packet prepared before this shipped, and on packets whose run never reached a
   * prepare step. Absent means unknown, not alias. */
  applicant_email?: {
    address: string;
    source: 'litos_alias' | 'contact_email' | 'account_email';
    /* 'deliverable' when the alias was used; otherwise the measured reason it was not, e.g.
     * 'no_mx_record', 'domain_not_verified_in_resend', 'inbound_route_missing',
     * 'check_unavailable'. */
    reason: string;
    tracked: boolean;
    decided_at: string;
  };
  /** Immutable applicant facts captured by the same preparation that froze this handoff. */
  applicant_snapshot?: AutofillApplicantSnapshot;
  /** Server-owned proof that the exact JD, saved resume, answers, and stored PDF were audited. */
  packet_audit?: PacketAudit;
  /** Applicant acknowledgement of the exact rendered packet audit and PDF bytes. */
  packet_audit_acknowledgement?: {
    ownerSha256: string;
    applicationId: string;
    audit_digest: string;
    packet_version: string;
    pdfSha256: string;
    pdfSizeBytes: number;
    acknowledged_at: string;
    /* WHO LOOKED. Absent means the applicant did, which is what every acknowledgement written
     * before this field meant, so old rows keep their meaning without a backfill.
     *
     * 'auto_restored' is written by restoreExpiredPacketResume when a packet's file had aged out of
     * the 30-day window and was rebuilt from the frozen spec at send time. Nobody re-read that PDF.
     * The content is identical by construction, since every render input is frozen on the row, but
     * "a human confirmed these bytes" and "a machine rebuilt these bytes" are different facts and a
     * corpus that cannot tell them apart can never answer which packets were actually reviewed. */
    source?: 'applicant' | 'auto_restored';
  };
  filled_fields?: string[];
  /* THE DOCUMENTS THIS FORM DEMANDS AND THIS RUN LEFT HER NO WAY TO GIVE IT.
   *
   * Beside filled_fields on purpose: that field is what the run DID leave on the form, and this is
   * the matching account of what it could not. Derived by requiredDocumentAsks off the employer's
   * own labels, from two sources merged at the prepare sites - the portal's "is required and is
   * still empty" blockers that no question record answers, and required file questions the
   * discovery pass saw.
   *
   * A STRUCTURED FIELD RATHER THAN attention_categories, and that choice is the feature. Reading
   * `attention_categories.includes('required_document')` is the obvious trigger and it is wrong
   * twice over: the classifier matched `file` inside `profile` until this shipped, and
   * withholdInvalidLeadAlignment writes that category for a resume alignment failure that involves
   * no document at all. See lib/requiredDocuments.ts for both, measured.
   *
   * Tri-state, following cover_letter_required directly above. `undefined` means no prepare on this
   * build has measured it, which is every packet older than this field, and it must never be read
   * as "nothing is owed". An empty array is the measured answer.
   */
  required_documents?: RequiredDocumentAsk[];
  /* Whether the live form has a control a transcript could be attached to, measured mid-run.
   *
   * The same distinction cover_letter_supported and cover_letter_required draw, and for the same
   * reason: "this form has a slot" and "this form will not be accepted without one" are different
   * facts, and a gate built on the first refuses sends the employer would have taken. `undefined`
   * means unmeasured, never false. */
  transcript_supported?: boolean;
  /** Latest managed-run preview shown while the form is still being filled. */
  progress_screenshot_url?: string;
  /** Short, applicant-facing description of the current fill stage. */
  progress_stage?: string;
  /** Time the progress preview or stage last changed. */
  progress_updated_at?: string;
  preview_screenshot_url?: string;
  submission_authorization?: {
    source: 'standing_consent' | 'per_application_approval' | 'user_initiated_extension';
    authorized_at: string;
    consented_at?: string;
    consent_version?: string;
  };
  verification?: {
    status: 'not_needed' | 'searching' | 'verification_pending' | 'completed' | 'handoff';
    provider?: 'gmail' | 'outlook' | 'litos';
    requested_at?: string;
    retry_count?: number;
    completed_at?: string;
    runner?: 'stratus-managed';
    continuation_fingerprint?: string;
    continuation_resumed?: boolean;
  };
  receipt?: {
    confirmation_text: string;
    final_url: string;
    screenshot_url?: string;
    captured_at: string;
    reference_id?: string;
    source?: 'managed_browser' | 'chrome_extension' | 'email_fallback' | 'ats_api' | 'attended_handoff';
  };
  /* A SUBMIT WHOSE OUTCOME IS GENUINELY UNKNOWN, RECORDED AS A FACT RATHER THAN AS A SENTENCE.
   *
   * Skydio packet 13bccb2d, 2026-08-09. The run was killed mid-submit, so `submitted_at` was null,
   * `receipt` was null, `submission_attempted_at` was null, and the only trace of the whole episode
   * was one line of prose in attention_reason. Nothing on the row could be queried, counted, or
   * acted on, and the packet's status - needs_attention AFTER a claim - is one submitRequestDisposition
   * refuses to re-run. So the applicant was told to check the portal and try again, and the system
   * she was talking to had already decided she could not.
   *
   * This is the missing fact and the way out of it. `resolution` is the applicant's answer after she
   * has looked, and it is the only thing that can move the packet: nothing here is ever decided by
   * guessing on her behalf.
   *
   *   undefined  - not looked at yet. The packet is waiting on a person, which is the truth.
   *   'sent'     - she found the application in the employer's portal or her mailbox. Recorded as
   *                submitted with the source named, so the receipt never claims Litos verified it.
   *   'not_sent' - she looked and it is not there. The claim is released and one re-run is allowed,
   *                which is the case that was previously a dead end.
   */
  unverified_submission?: {
    /* When the run that may have submitted stopped. */
    at: string;
    /* Why the outcome could not be established, in machine-readable form. */
    cause: 'run_timed_out' | 'no_confirmation_state' | 'provider_error';
    /* Where she has to look. Carried here so the message and the link cannot drift apart. */
    portal_url?: string;
    submission_run_id?: string;
    resolution?: 'sent' | 'not_sent';
    resolved_at?: string;
  };
};

const TERM_RE = /[A-Za-z][A-Za-z0-9+#./-]*/g;
const STOPWORDS = new Set(
  'the a an and or but to of in on for with from by as at is are was were be been being this that these those your our their'.split(
    ' ',
  ),
);

function terms(value: string): string[] {
  return (value.match(TERM_RE) ?? [])
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

function overlapScore(left: string, right: string): number {
  const a = new Set(terms(left));
  const b = new Set(terms(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

/**
 * The words this job's tailoring is responsible for, in the resume as rendered.
 *
 * TWO THINGS COUNT AS TAILORING AT THE BULLET LAYER, and for a long time this function could only
 * see one of them.
 *
 * 1. REWORDING. A rendered bullet says something its source variant did not. Those words are the
 *    diff, and finding them is what this function was originally written to do.
 *
 * 2. SELECTION. Measured 2026-08-08 over the 25 most recent real packets: 245 of 267 rendered
 *    bullets are BYTE-IDENTICAL to a stored experience-bank variant, and the 22 that are not reduce
 *    to one bullet whose only difference is an em dash written as a comma. Tailoring below the
 *    skills line is not rewriting, it is CHOOSING which of the student's own phrasings to put on
 *    this page, which is exactly what gapEvidence.ts means by "SELECTION, NOT INVENTION". So
 *    rewording found nothing to report, `edited_terms` came back `[]` on all 25 - honestly - and
 *    the green tone in the review legend ("wording Litos changed for this job") had never rendered
 *    on a real packet. A student was shown a swatch for a colour that does not exist.
 *
 * WHAT MAKES A SELECTION ATTRIBUTABLE TO THIS JOB, and what stops this from fabricating one.
 * `bullet_variants` is ordered, and its head is the student's own default phrasing: it is what the
 * base resume renders (llm/baseResume.ts) and what the deterministic floor fills from
 * (engine/resumePolicy.ts enforceExperienceBulletFloor). So the bullets any job would have got are
 * `variants.slice(0, renderedCount)`. A rendered bullet sourced from OUTSIDE that prefix is one the
 * JD reached past the default to pick, and the words that carry the difference are the ones in it
 * that the default set never says. A bullet whose source IS in the default prefix reports nothing,
 * because nothing about this job caused it, which is the rule "do not mark a bullet as edited when
 * the same variant would have been chosen for any job".
 *
 * An entry with one variant, or one whose variants are all on the page, can produce no selection
 * edit at all: there was no choice to make. Every reported word is a word the student wrote and the
 * page actually shows. Grounding is still enforced by resumeValidate.ts; this is metadata for the
 * review UI only.
 */
export function deriveEditedTerms(
  spec: ResumeSpec,
  bank: ExperienceBankEntry[],
): string[] {
  const introduced = new Map<string, string>();

  for (const entry of spec.experience) {
    const sourceEntry = bank.find(
      (candidate) => candidate.org.trim().toLowerCase() === entry.org.trim().toLowerCase(),
    );
    if (!sourceEntry) continue;

    const variants = Array.isArray(sourceEntry.bullet_variants)
      ? sourceEntry.bullet_variants.filter((item): item is string => typeof item === 'string')
      : [];

    // What this entry would have rendered for any job at all, and every word it would have said.
    const defaultChoice = variants.slice(0, entry.bullets.length);
    const defaultTerms = new Set(defaultChoice.flatMap((variant) => terms(variant)));
    const isDefaultChoice = (variant: string) => defaultChoice.includes(variant);

    for (const bullet of entry.bullets) {
      const source = variants
        .map((variant) => ({ variant, score: overlapScore(bullet, variant) }))
        .sort((a, b) => b.score - a.score)[0]?.variant;
      if (!source) continue;

      // Rewording: what the page says that its own source variant does not.
      // Selection: what the page says that the default set never would have said. Only for a
      // bullet the JD reached past the default to pick, so a default bullet reports nothing.
      const baseline = isDefaultChoice(source)
        ? new Set(terms(source))
        : new Set([...terms(source)].filter((term) => defaultTerms.has(term)));

      for (const rendered of bullet.match(TERM_RE) ?? []) {
        const normalized = rendered.toLowerCase();
        if (
          normalized.length > 2 &&
          !STOPWORDS.has(normalized) &&
          !baseline.has(normalized)
        ) {
          introduced.set(normalized, rendered);
        }
      }
    }
  }

  return [...introduced.values()].slice(0, 80);
}

export function readApplicationReview(spec: unknown): ApplicationReviewState | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const review = (spec as Record<string, unknown>)._review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const state = review as ApplicationReviewState;
  // Derived here, at the one choke point every caller already goes through, so a packet stored
  // before portal_supported existed still answers the question correctly and no backfill migration
  // is needed. A stored value always wins: this only fills a gap, it never overrides a decision.
  if (state.portal_supported === undefined && state.portal_url) {
    return { ...state, portal_supported: isPortalSupported(state.portal_url) };
  }
  return state;
}

function normalizedFilledFields(fields: readonly string[] | undefined): Set<string> {
  return new Set((fields ?? []).map((field) => field.toLowerCase().replace(/[^a-z0-9]/g, '')));
}

/**
 * Did the run record filling the fields it must have filled?
 *
 * Lives here, beside the state it reads, so the send gate can be exercised without standing a route
 * up. `coverLetterAttached` is what the RUN carried, read off review.cover_letter_attached, and NOT
 * whether a letter exists on the row now. buildPacket attaches a letter only once it is approved,
 * so a generated but unreviewed draft was never sent and the form is correct to record no
 * cover-letter field. Asking the second question instead of the first is what refused the Cresta
 * packet 8142004c-3358-4538-8778-16df5e31c5bb: it held a 1,918 character unapproved draft, so the
 * gate read "a cover letter exists" as "the run attached one" and demanded evidence of something
 * that had deliberately not happened.
 */
export function finalApprovalFieldIssues(
  review: ApplicationReviewState,
  coverLetterAttached: boolean,
): string[] {
  const normalized = normalizedFilledFields(review.filled_fields);
  const has = (needle: string) => [...normalized].some((field) => field.includes(needle));
  const issues: string[] = [];
  if (!has('email')) issues.push('The filled form did not record an email field.');
  if (!has('resume')) issues.push('The filled form did not record a resume upload.');
  if (!has('name') && !(has('first') && has('last'))) {
    issues.push('The filled form did not record the applicant name fields.');
  }
  if (coverLetterAttached && !has('cover')) {
    issues.push('The filled form did not record the cover letter attachment.');
  }
  return issues;
}

/**
 * The one sentence the send gate may say about a cover letter, or none.
 *
 * TWO DIFFERENT FACTS, and the gate used to run on the wrong one. `cover_letter_supported` means
 * the form HAS a cover-letter file control Litos can attach to; it has never meant the employer
 * wants one, and it is deliberately false on JazzHR and Breezy, whose employers do take a cover
 * letter but as a textarea. Blocking on it made every complete application on a form that merely
 * OFFERS the control unsendable. Cresta is the measured case: a Greenhouse form offering Attach /
 * Dropbox / Enter manually with no required marker, while First Name, Last Name and Email all
 * carried one, refused 422 with every required field filled.
 *
 * `cover_letter_required` is the fact the gate wanted, measured by the run off the employer's own
 * required-field scan. It is tri-state and only `true` refuses: `undefined` is every packet filled
 * before the field existed, and treating unknown as required is the same refusal wearing a new
 * name. If the measurement is ever wrong in the quiet direction the submit-time readiness gate
 * still fails closed on a required-and-empty control, so the cost is a handoff and not a half-blank
 * application at an employer.
 *
 * `hasCoverLetter` is the STORED letter, approved or not, because approving is what this endpoint
 * does: approvedReviewSpec stamps `_cover_letter.approved_at` on the way through, and the submit
 * run rebuilds the packet afterwards and attaches it. A draft waiting on the row is a letter that
 * will be sent.
 */
export function finalApprovalCoverLetterIssue(
  review: ApplicationReviewState,
  hasCoverLetter: boolean,
): string | null {
  if (review.cover_letter_required !== true) return null;
  if (hasCoverLetter) return null;
  return 'This employer requires a cover letter. Write one before sending.';
}

export type ApplicationReviewEdit = {
  ats_name?: string;
  portal_url?: string;
  questions: ApplicationReviewQuestion[];
  skipped_reasons: string[];
};

/**
 * THE REVIEW ROUND ITSELF, WITHOUT AN OPINION ABOUT WHAT THE PACKET SHOULD DO NEXT.
 *
 * Two things happen when the applicant presses Save on a screen of answers, and only one of them
 * belongs to the edit route. The first is the record: every answer she left standing came from her,
 * so it is stamped 'applicant_review' against a review round, and the round is written beside it as
 * `questions_reviewed_at`. Both halves or neither - an `answer_reviewed_at` with no round to equal
 * is a claim no reader can check, and mergeSubmittedApplicationReviewQuestions and
 * refreshKnownQuestionAnswers both discard it.
 *
 * The second is the status move to 'questions_ready'/'ready_to_submit', which is right for an edit
 * that also rewrites the portal URL and the ATS name, and wrong for a packet stopped at
 * needs_attention: that status is the record of a run that stopped and of what it is still owed, and
 * a save of answers is not an answer to it. Writing it anyway is how PUT /review would silently
 * clear a stall while claiming only to have stored an answer.
 *
 * So the record lives here on its own and the status move stays with the edit route below.
 */
export function applyApplicantReviewedAnswers(
  current: ApplicationReviewState,
  questions: readonly ApplicationReviewQuestion[],
  reviewedAt: string = new Date().toISOString(),
): ApplicationReviewState {
  return {
    ...current,
    questions: questions.map((question) => question.answer.trim()
      ? { ...question, answer_source: 'applicant_review' as const, answer_reviewed_at: reviewedAt }
      : question),
    questions_reviewed_at: reviewedAt,
    updated_at: reviewedAt,
  };
}

/**
 * The third write path for portal_supported, and the one that can contradict itself.
 *
 * Creation writes the flag from the URL it was handed, and readApplicationReview derives it for
 * packets stored before the field existed. An EDIT is different: the body carries a new portal_url
 * and no portal_supported, so merging it over the stored review leaves the old verdict sitting next
 * to the new URL, and then persists it. Persisting is what makes it permanent, because the
 * derivation above only fills a gap: once the value is defined it is never recomputed, so re-saving
 * the URL cannot repair it.
 *
 * Both directions are wrong, but they are not equally bad. Supported edited to unsupported shows a
 * live send button on a packet that cannot be filled, and submit-request already refuses that in
 * front of the run. Unsupported edited to a working Greenhouse URL is the trap: the dashboard gates
 * the send button on this exact field, so a packet that would now submit fine is locked out with no
 * self-serve way back. Re-derive from the URL that is actually being stored.
 */
export function applyApplicationReviewEdit(
  current: ApplicationReviewState,
  edit: ApplicationReviewEdit,
): ApplicationReviewState {
  const canonicalPortalUrl = edit.portal_url === undefined
    ? undefined
    : canonicalSupportedPortalUrl(edit.portal_url, edit.ats_name ?? current.ats_name) ?? edit.portal_url;
  const reviewedAt = new Date().toISOString();
  const mergedQuestions = mergeSubmittedApplicationReviewQuestions(
    current.questions,
    edit.questions,
    current.questions_reviewed_at,
  );
  return {
    /* The MERGED list, not the edit's own. #533 put the merge in front of this stamp so an edit
     * cannot drop the provenance a run wrote (the option band an answer was snapped from, the ATS
     * field binding), and the stamp still has to run over whatever survives that merge. Handing
     * `edit.questions` to the record below would put the merge back where it was before #533. */
    ...applyApplicantReviewedAnswers({ ...current, ...edit }, mergedQuestions, reviewedAt),
    ...(canonicalPortalUrl === undefined ? {} : {
      portal_url: canonicalPortalUrl,
      ats_name: isPortalSupported(canonicalPortalUrl) ? detectPortal(canonicalPortalUrl) : edit.ats_name ?? current.ats_name,
    }),
    // Only when the edit carries a URL. Deriving from an absent one would write false over a
    // perfectly good stored true, which is the same lockout arriving by a different door.
    ...(canonicalPortalUrl === undefined ? {} : { portal_supported: isPortalSupported(canonicalPortalUrl) }),
    status: edit.questions.length > 0 ? 'questions_ready' : 'ready_to_submit',
  };
}
