import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { PACKET_VISIBLE_QUESTION_FIELDS, type PacketAudit } from './packetAudit';
import type { RequiredDocumentAsk } from './requiredDocuments';
import type { SubmissionStopRecord } from './submissionStop';
import type { EmployerDeliveryBindings } from './employerDeliveryIdentity';
import type { QuestionMetadataBlocker } from './questionMetadata';
/* The one function that knows what the applicant was actually shown. Every read path serves this
 * file's questions through normalizeStoredPortalQuestions, so the label in a submit body is the
 * normalizer's output rather than the bytes on the row; see servedLabelMatchesStoredControl. */
import { servedLabelMatchesStoredControl } from './questionDiscovery';
import {
  canonicalSupportedPortalUrl,
  detectPortal,
  isPortalSupported,
  type AutofillApplicantSnapshot,
  type SubmissionPacket,
} from './portalSubmission';

export type ApplicationReviewQuestion = {
  id: string;
  question: string;
  answer: string;
  kind: 'essay' | 'required';
  required: boolean;
  portal_selector?: string;
  portal_input_type?: string;
  ats_api_field?: string;
  /**
   * THE OPTIONS THE EMPLOYER'S OWN CONTROL OFFERS, so the answers screen can show her a list to
   * pick from instead of an empty box.
   *
   * Discovery reads these already - it is how "3.89" resolves against a band reading
   * "3.81 - 3.9" - and then dropped them, so a question Litos could not answer arrived at the
   * applicant as a bare textarea with no hint of what the control accepts. Measured on a live
   * Optiver Greenhouse form 2026-08-19: the acknowledgement rows offer "I consent to the above."
   * and "Yes, I have read and agree to Optiver's privacy policies, notices and disclaimers.", and
   * a person handed a blank box types "Yes", which matches neither and fails silently. The
   * pre-script path already carried options for exactly this reason (lib/api.ts); this is the same
   * field on the path a managed run produces.
   *
   * DISPLAY ONLY, AND THEREFORE NOT PACKET IDENTITY. The employer receives the value she chose,
   * never the menu it came from, so hashing this would spend every stored acknowledgement the
   * first time a board reordered its own list - the deadlock PACKET_VISIBLE_QUESTION_FIELDS was
   * narrowed to prevent. It is classified below as its own kind rather than squeezed into the
   * provenance list, because it is not a claim about how the answer got there.
   */
  options?: string[] | null;
  /** Previous text retained only for a reopened exact-choice question in the dashboard. */
  answer_draft?: string;
  /** Dashboard workflow for an optional answer that Litos must not silently decide. */
  answer_state?: 'unanswered' | 'skipped' | 'litos_refused';
  /* WHO PUT THIS ANSWER HERE, when it was not simply resolved from the profile.
   *
   * 'applicant_review' is her, typing on the review screen. 'consent_permission' is Litos accepting
   * an employer's privacy statement, applicant terms or code of conduct under the permission she
   * granted once at onboarding, and it exists so that the packet audit shows an acceptance made on
   * her behalf rather than a tick that reads as if she had made it herself.
   *
   * 'litos_draft' is A PARAGRAPH LITOS WROTE THAT SHE HAS NOT APPROVED. It is the only value here
   * that makes an answer LESS sendable than no value at all: an absent answer_source means "some
   * machine put this here and we cannot say which", which the packet acknowledgement already sorts
   * into ask-her-next-round, while this one says "Litos composed these words in her name", and
   * submissionSafety counts it as an unanswered required question until she replaces it or confirms
   * it. It exists because the essay drafter used to push its paragraph with no flag at all, so a
   * drafted answer and a profile relay were the same record to every reader.
   *
   * It is REPLACED, never annotated: an edit or an explicit confirmation mints 'applicant_review'
   * over it, and from that moment the answer is byte-identical in status to anything she typed. */
  answer_source?: 'applicant_review' | 'consent_permission' | 'litos_draft';
  answer_reviewed_at?: string;
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
  /**
   * The RESOLVER VALUE this answer was typed over, when the applicant corrected a machine-resolved
   * answer on the review screen. "Bachelor of Science in Computer Science" beside an answer of
   * "Bachelor's Degree".
   *
   * WHY IT IS NOT answer_option_source, which looks like the same thing and is its opposite. That
   * field records what an answer was DERIVED FROM, and applicationReview.test.ts pins it dropping
   * the moment the answer is replaced, because a derivation beside a value it was not derived for is
   * a lie the next reader cannot detect. An override is defined by being a replacement, so the two
   * rules cannot share a field: writing one here would assert that resolution snapped this answer
   * onto a control's list, and nothing resolved anything - she typed it.
   *
   * WHAT IT IS FOR. refreshKnownQuestionAnswers overwrites a known question's answer with the
   * profile's, which is what makes the profile the source of truth. That rule has to yield to an
   * explicit correction and must not yield forever: an override kept on the applicant claim alone
   * would still be sent after she fixes the profile fact underneath it. Recording what she overrode
   * makes staleness decidable in the same way answer_option_source does for a band - "does the
   * resolver still say what it said when she disagreed with it" - so the override survives while the
   * profile agrees and is recomputed when it moves.
   *
   * An ANSWER-CLAIM, so it dies with the answer it describes. Optional forever; absence reads as
   * "cannot prove current", which recomputes. jsonb, so no migration.
   */
  answer_override_of?: string;
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
  /**
   * THE EXACT QUESTION TEXT SHE WAS LOOKING AT WHEN SHE CONFIRMED THIS ANSWER, and nothing else.
   *
   * WHAT IT IS FOR, which is one thing only: it is the single piece of provenance the sensitive
   * question gate is allowed to accept as "the applicant made this declaration herself". See
   * applicantConfirmedSensitiveAnswer in questionDiscovery.ts.
   *
   * WHY answer_source WAS NOT ENOUGH, and this is the whole reason the field exists rather than a
   * refinement of one that does. 'applicant_review' is minted by three different writers and two of
   * them are blanket: applyApplicantReviewedAnswers stamps EVERY non-blank answer in a PUT /review
   * body, and applicantSuppliedAnswer below mints on any answer that merely differs from the stored
   * one. Both are correct for what they claim - a review round happened, an answer moved - and
   * neither can distinguish "she read this legal declaration and affirmed it" from "a list went past
   * her". That distinction is the entire content of the sensitive gate, so keying the gate on
   * 'applicant_review' would have let a machine-derived legal declaration through the one gate built
   * to stop exactly that. The 802-answer laundering documented at the mint site is what that looks
   * like in production, and 'do you now or will you in the future require immigration sponsorship'
   * -> 'Yes' was one of the 802.
   *
   * SO IT HAS EXACTLY ONE WRITER: applicantConfirmedAnswer below, which fires only on a request that
   * carried `confirmed: true` for this specific question. That flag is accepted by exactly one body
   * schema, reviewAnswersBodySchema on PUT /applications/:id/review/answers, and set by exactly one
   * control, the dashboard's per-question CONFIRM. No resolver, no drafter, no fill, no rebuild and
   * no blanket stamp can produce it, because none of them submits that flag. Unmintable by a machine
   * is a property of the writer list, not of the value, which is why the value is deliberately
   * boring.
   *
   * IT STORES THE LABEL RATHER THAN A BARE `true`, and that is what makes it self-verifying. As an
   * ANSWER-CLAIM it dies when the answer changes, which covers half of what a confirmation asserts;
   * the other half is WHICH QUESTION she was answering, and an answer-claim survives a rename by
   * rule. A confirmation of "do you require sponsorship in the United States?" must not carry over
   * to "do you require sponsorship in the United Kingdom?" still reading "Yes" - for this applicant
   * those two have different true answers, which is the whole reason the resolver refuses the
   * multi-country wording. So the reader compares this against the question's CURRENT text and a
   * rename breaks the proof on its own, without depending on any carry rule remembering to.
   *
   * NO TIMESTAMP, deliberately. answer_reviewed_at already dates the round, and a second date would
   * be a second copy of the frozen-round defect (submittedAnswers.ts computes
   * `questions_reviewed_at ?? now()`, so the round does not advance and every later claim carries the
   * first review's date). One thing to fix is better than two, and the gate does not need a date:
   * what it needs is that this answer, under this text, was affirmed.
   *
   * Optional forever, jsonb, no migration. Absence reads as "not confirmed", which is what every
   * record written before this field existed honestly is.
   */
  answer_confirmed_of?: string;
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
  | 'answer_option_source'
  | 'answer_override_of'
  | 'consent_permission_granted_at'
  | 'consent_permission_version'
  | 'answer_confirmed_of';

/** Keyed on RECORD IDENTITY. Falsified by a rename or a stale review round. */
export const APPLICANT_CLAIM_FIELDS = ['answer_source', 'answer_reviewed_at'] as const;
/** Keyed on THE ANSWER. Falsified only by replacing the answer.
 *
 * answer_confirmed_of is on THIS list and not the other one, which looks backwards for something
 * whose whole subject is what the applicant did, and is not. An applicant-claim is keyed on record
 * identity, which includes the review ROUND, and a confirmation that expired every time the round
 * moved would put the sensitive gate straight back into the dead end this field exists to open: she
 * confirms, the round advances for an unrelated reason, and the send refuses again with no action
 * left for her to take. What must falsify a confirmation is the answer changing, which is exactly
 * the answer-claim rule; the other half - that the QUESTION has not been renamed underneath it - the
 * field carries in its own value and its reader checks directly, so it needs no help from the carry
 * rule here. */
export const ANSWER_CLAIM_FIELDS = [
  'answer_option_source',
  'answer_override_of',
  'consent_permission_granted_at',
  'consent_permission_version',
  'answer_confirmed_of',
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
/* A THIRD KIND, and it is a third kind rather than a convenience.
 *
 * The partition below used to read "either the employer receives it, or it records how the answer
 * got there". `options` is neither: it is what the employer's control OFFERS, carried so the
 * answers screen can render a list instead of a blank box. Filing it under provenance would have
 * forced it into APPLICANT_CLAIM_FIELDS or ANSWER_CLAIM_FIELDS, which key staleness - and a menu
 * changing is not the applicant's claim going stale.
 *
 * Kept OUT of PACKET_VISIBLE_QUESTION_FIELDS deliberately: the employer receives the value she
 * chose, never the list, so hashing it would spend every stored acknowledgement the first time a
 * board reordered its own options. That is precisely the deadlock the allow-list was narrowed to
 * prevent, and a test in packetAudit.test.ts pins it. */
type QuestionDisplayField = 'options' | 'answer_draft' | 'answer_state';
type QuestionFieldClassification =
  PacketVisibleQuestionField | AnswerProvenanceField | QuestionDisplayField;
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
    /* The employer's option list rides across the collision the same way the portal metadata does,
     * whichever side wins the answer. mergeDiscoveredPortalQuestions puts her reviewed row FIRST so
     * her answer survives - and her row was stored before options existed, so first-wins on the
     * whole object dropped the menu on exactly the questions she is being asked to answer. The
     * later read is the fresher read of the employer's own control, so it wins when present. */
    const optionsMeasured = Object.prototype.hasOwnProperty.call(question, 'options');
    const options = optionsMeasured ? (question.options ?? null) : existing.options;
    /* AN ANSWERED QUESTION MAY STILL BE ONE SHE CHOSE TO LEAVE ALONE.
     *
     * This used to clear the state outright whenever an answer was present, on the reading that an
     * answer resolves the question. That holds for the two MACHINE states: 'unanswered' and
     * 'litos_refused' both describe Litos having nothing to type, and an answer really does settle
     * them. It does not hold for 'skipped', which is the applicant's own instruction about the
     * CONTROL rather than about the answer: "I know what the value is, the portal will not take it,
     * leave it." Dropping that turned her decision into a fact the record could not hold, so
     * discovery re-raised the same question on every fill and the row never became sendable.
     *
     * Nothing types differently as a result: packetQuestionsForFill does not carry answer_state, so
     * the answer beside it still reaches the form exactly as before. */
    const mergedAnswerState = question.answer_state ?? existing.answer_state;
    const answerState = !question.answer.trim() || mergedAnswerState === 'skipped'
      ? mergedAnswerState
      : undefined;
    const { answer_state: _existingAnswerState, ...existingWithoutAnswerState } = existing;
    if ((question.required && !existing.required) || (!existing.answer.trim() && question.answer.trim())) {
      const next = {
        ...existingWithoutAnswerState,
        required: existing.required || question.required,
        answer: existing.answer.trim() ? existing.answer : question.answer,
      };
      normalized[existingIndex] = {
        ...next,
        ...(portalSelector ? { portal_selector: portalSelector } : {}),
        ...(portalInputType ? { portal_input_type: portalInputType } : {}),
        ...(atsApiField ? { ats_api_field: atsApiField } : {}),
        ...(optionsMeasured ? { options } : {}),
        ...(answerState ? { answer_state: answerState } : {}),
      };
    } else if (
      (portalSelector && portalSelector !== existing.portal_selector)
      || (portalInputType && portalInputType !== existing.portal_input_type)
      || (atsApiField && atsApiField !== existing.ats_api_field)
      || (optionsMeasured && options !== existing.options)
      || answerState !== existing.answer_state
    ) {
      normalized[existingIndex] = {
        ...existingWithoutAnswerState,
        ...(portalSelector ? { portal_selector: portalSelector } : {}),
        ...(portalInputType ? { portal_input_type: portalInputType } : {}),
        ...(atsApiField ? { ats_api_field: atsApiField } : {}),
        ...(optionsMeasured ? { options } : {}),
        ...(answerState ? { answer_state: answerState } : {}),
      };
    }
  }
  return normalized;
}

/* A SUBMITTED QUESTION MAY CARRY ONE THING A STORED QUESTION NEVER DOES: the applicant's explicit
 * word that she read this answer and let it stand.
 *
 * `confirmed` is a REQUEST field, not a record field. It exists because the mint rule below is
 * deliberately deaf to an untouched Save - an answer that round-trips unchanged, or round-trips the
 * resolver's own value, proves nothing about what she chose, and stamping it anyway is the
 * 802-answer laundering documented at the mint site. That deafness had a cost measured on the DV
 * Trading packet on 2026-08-17: the dashboard's CONFIRM control opens the review screen, she reads
 * the work-eligibility answers, presses Save, and the save posts back the exact values she was
 * shown - which is indistinguishable from a save she never looked at, so no claim was ever minted
 * and the CONFIRM ask re-rendered forever. The flag is the distinguishing byte: the client sets it
 * only on a question she explicitly confirmed, so "she read it and let it stand" arrives as her own
 * statement instead of being inferred from a diff that an unedited confirmation cannot produce.
 *
 * It is consumed here and never stored: the merge writes the CLAIM it licenses
 * (answer_source/answer_reviewed_at) and drops the flag itself, in both branches that touch a
 * submitted question. */
export type SubmittedApplicationReviewQuestion = ApplicationReviewQuestion & { confirmed?: boolean };

export function mergeSubmittedApplicationReviewQuestions(
  stored: readonly ApplicationReviewQuestion[],
  submitted: readonly SubmittedApplicationReviewQuestion[],
  questionsReviewedAt?: string,
  /**
   * What the resolver answers for a question, from questionDiscovery.knownAnswerLookup.
   *
   * OPTIONAL, AND WHAT IT COSTS TO OMIT IT. Two decisions below are strictly better with it and
   * neither is wrong without it: an applicant claim is minted for a submitted answer that merely
   * round-trips the resolver's own value, and an override records nothing unless the stored record
   * already proves what it corresponds to. Callers on the paths that matter - the review-answers
   * route and the send path - pass it. applyApplicationReviewEdit does not, because it has no
   * profile to build it from and it stamps every non-empty answer itself anyway.
   */
  resolverAnswerFor?: (question: ApplicationReviewQuestion) => string | undefined,
  /**
   * What Litos itself would WRITE INTO THIS CONTROL for the question, from
   * submittedAnswers.machineAnswerLookup.
   *
   * THE OTHER HALF OF resolverAnswerFor, and it exists because those two are different strings on
   * every snapped control. resolverAnswerFor is `resolveKnownAnswer`: what the answer IS, from the
   * profile. This is `resolveProfileField`: the same answer written in the employer's own option
   * text. The fill, the runner and the packet audit all resolve through the second one, and the
   * review screen therefore DISPLAYS the second one - so a body that merely echoes the screen
   * carries a string the first lookup has never heard of.
   *
   * READ BY ONE LINE, `applicantSuppliedAnswer`, and deliberately not by the override below: an
   * override has to name the PRE-SNAP value it was made against or its own currency check can never
   * pass. See machineAnswerLookup for the production record that forced this, and the mint gate for
   * why an echo is not a choice.
   */
  machineAnswerFor?: (question: ApplicationReviewQuestion) => string | undefined,
): ApplicationReviewQuestion[] {
  const submittedByQuestion = new Map<string, { question: SubmittedApplicationReviewQuestion; index: number }>();
  const submittedByUniqueId = new Map<string, { question: SubmittedApplicationReviewQuestion; index: number } | undefined>();
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
        ...questionWithoutProvenance
      } = question;
      /* EXCEPT THE DRAFT MARKER, WHICH IS NOT A CLAIM ABOUT HER AND SO CANNOT GO STALE THE WAY ONE
       * DOES. Stripping it here would be the whole feature undone by omission: a save that never
       * mentions the drafted question would silently turn "Litos wrote this and she has not read it"
       * into "some machine put this here", and the send gate would open on a paragraph nobody
       * approved. Nothing about this record moved, so what it says about itself still holds. */
      return question.answer_source === 'litos_draft' && question.answer.trim()
        ? { ...questionWithoutProvenance, answer_source: 'litos_draft' as const }
        : questionWithoutProvenance;
    }
    const { question: submittedQuestion, index: submittedIndex } = submittedMatch;
    consumedSubmittedIndexes.add(submittedIndex);
    const portalSelector = preferredPortalSelector(question.portal_selector, submittedQuestion.portal_selector);
    const portalInputType = submittedQuestion.portal_input_type ?? question.portal_input_type;
    const atsApiField = question.ats_api_field;
    const provenanceMatchesCurrentReview = question.answer_source === 'applicant_review'
      && typeof question.answer_reviewed_at === 'string'
      && question.answer_reviewed_at === questionsReviewedAt;
    /* THE LABEL HALF OF THIS IDENTITY IS THE SERVER'S OWN, NOT THE ROW'S BYTES, and reading it as
     * the row's bytes is the second turn of the loop documented at servedLabelMatchesStoredControl: on a
     * row whose stored label carries a required marker this test can never pass, so a claim minted
     * by one save was stripped again by the next one and the packet forgot she had ever confirmed
     * anything.
     *
     * THE `questionKey` CLAUSE GOES WITH IT, and it is being removed rather than kept "for safety".
     * Byte equality implied it, so beside `===` it asserted nothing and cost nothing. Beside the
     * server's own normalization it is a strictly DIFFERENT fold - case and whitespace, and the
     * required marker left exactly where it was - so keeping it would reject precisely the packet
     * this change exists for while still looking like a belt beside braces. One identity, stated
     * once. */
    const exactReviewedIdentityUnchanged = provenanceMatchesCurrentReview
      && submittedQuestion.id === question.id
      && servedLabelMatchesStoredControl(question.question, submittedQuestion.question)
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
     * ANY ANSWER THIS REQUEST CHANGED, AND THAT IS THE RECLASSIFICATION THIS COMMENT USED TO DEFER.
     *
     * It was a blank stored answer only, on the reasoning that answer_source is an APPLICANT-CLAIM
     * keyed on the exact reviewed identity and a REPLACED answer invalidates that identity by rule.
     * That reasoning is right about CARRYING a claim forward and wrong about MINTING one. Carrying
     * asserts "she read the text that is still on this record and let it stand", which a replacement
     * does falsify. Minting asserts "she supplied the bytes in this request", which a replacement is
     * the clearest possible case of: she typed them, on the screen built for typing them.
     *
     * THE DEFECT THAT FORCED THE DECISION. With minting restricted to blanks, no applicant edit of a
     * machine-resolved answer recorded anything, so refreshKnownQuestionAnswers - which runs on this
     * output at four read sites and on the fill that reaches the employer - recomputed every one of
     * them away. Measured on the live Lever degree control: PUT /applications/:id/review/answers
     * stored "Bachelor's Degree", answered 200, and every reader afterwards showed the raw profile
     * degree. The supported edit path could not move a single resolved answer in the product.
     *
     * THE 802-ANSWER LAUNDERING IS STILL SHUT OUT, and it takes BOTH tests below rather than the
     * first one alone. That incident came from applyApplicantReviewedAnswers stamping every question
     * carrying a NON-EMPTY answer, which claimed 802 machine-resolved values across 174 packets as
     * hers - gender, disability status, veteran status, sponsorship, compensation.
     *
     * `!answerUnchanged` ALONE LETS IT BACK IN, which is not obvious and was measured. It compares
     * the submitted answer with the STORED one, and the screen was not shown the stored one:
     * GET /applications/:id/submission refreshes on read and does not persist, so a row holding a
     * stale "Male" is displayed as the resolved value, and the client posts back the whole list it
     * was shown. An untouched Save then looks like an edit on every question whose stored value the
     * refresh had corrected, and stamps a self-identification she never made.
     *
     * So the second test asks whether the submitted answer is the resolver's OWN value. If it is,
     * this request changed nothing she can be said to have chosen, whatever the row happened to
     * hold. Strict equality on the trimmed strings, matching the refresh's own strictness, because a
     * case difference is a different string on the employer's form.
     *
     * AND ONLY AGAINST A REVIEW ROUND THAT EXISTS. `answer_reviewed_at` is only meaningful beside the
     * `questions_reviewed_at` it equals; writing one without the other would leave a claim no reader
     * can check, and the refusal branch would discard it anyway. */
    const resolverAnswer = resolverAnswerFor?.(question)?.trim() || undefined;
    const submittedAnswer = submittedQuestion.answer.trim();
    const submittedIsResolverValue = resolverAnswer !== undefined && submittedAnswer === resolverAnswer;
    /* AND THE SAME TEST AGAINST THE STRING THE MACHINE ACTUALLY WRITES, which on a snapped control
     * is not the string above.
     *
     * THE DEFECT, MEASURED IN PRODUCTION 2026-09-03 on packet 4a79eec1 (Hudson River Trading,
     * greenhouse). The required gender control offers Woman / Man / Non-binary / I don't wish to
     * answer; her profile says `Female`; the packet came back holding
     *
     *   answer "Woman", answer_source "applicant_review", answer_override_of "Female",
     *   answer_reviewed_at "2026-09-01T21:28:12.934Z", equal to questions_reviewed_at
     *
     * asserting she reviewed that control two days earlier and overrode `Female` with `Woman`. She
     * did not, and on 2026-09-01 no code in the repo could produce `Woman` for this label. This
     * expression and the round it stamps are the whole of it, reproduced byte for byte in
     * applicantClaimIsNotAnEcho.test.ts.
     *
     * WHY THE LINE ABOVE MISSED IT, in one step. `resolveKnownAnswer` decides what the answer IS
     * from the profile; `resolveProfileField` decides how that same answer is WRITTEN into this
     * particular control, snapping it onto the employer's own option text. Every path that fills a
     * form or shows her a packet resolves through the second one, so the review screen renders
     * `Woman` - and the client posts back the whole list it was rendering. The gate above asked only
     * the first, so a snapped value looked like bytes she had typed.
     *
     * WHY THAT ONE FALSE STAMP IS NOT SELF-CORRECTING, which is what makes it worth a second
     * lookup. refreshKnownQuestionAnswers returns a question untouched when
     * `applicantReviewedCurrentAnswer && reviewedAnswerIsAnOfferedOption(...)`, ahead of every
     * recompute rule. A machine value that acquires this claim is therefore immune to correction by
     * any resolver Litos ships afterwards, permanently. On the HRT record the value happened to be
     * right; the mechanism stamps whatever the resolver produced, right or wrong, and the same
     * merge writes gender, disability and veteran answers.
     *
     * SEPARATE FROM submittedIsResolverValue rather than folded into it, because they have
     * different readers. Only this line reads the snapped value: `applicantConfirmedAnswer` below
     * stays deaf to both, so an explicit per-question confirmation still mints her claim over a
     * machine value, and the override branch still names the PRE-SNAP resolver value, which is the
     * only string its own currency check can recompute. */
    const bodyChangedTheAnswer = Boolean(
      questionsReviewedAt && submittedAnswer && !answerUnchanged && !submittedIsResolverValue,
    );
    /* Asked LAST and only of a body that has already survived every cheaper test, because the
     * lookup runs a full profile resolution per question and the overwhelming majority of rows in a
     * save are untouched. Nothing about the order changes the verdict. */
    const submittedIsMachineValue = bodyChangedTheAnswer
      && submittedAnswer === (machineAnswerFor?.(question)?.trim() || undefined);
    const applicantSuppliedAnswer = bodyChangedTheAnswer && !submittedIsMachineValue;
    /* HER EXPLICIT CONFIRMATION, WHICH NO DIFF CAN EXPRESS. The two tests above exist to stop an
     * untouched Save being read as a choice, and they are right - but a CONFIRMED question is not an
     * untouched Save. The client sets the flag only on a question she deliberately confirmed, so the
     * request itself says what the diff cannot: she read exactly these bytes and let them stand,
     * which is the applicant-claim's own definition. Deliberately NOT gated on answerUnchanged or on
     * submittedIsResolverValue - the review screen displays the refreshed value rather than the
     * stored one, so a confirmation of what she was SHOWN routinely arrives as either shape, and
     * refusing those is the measured DV Trading loop: confirm, save, "Saved.", and the same CONFIRM
     * ask again, indefinitely. The laundering stays shut out because the flag is per-question and
     * absent by default: a whole-list Save with no flags mints exactly what it minted before, which
     * is nothing. See SubmittedApplicationReviewQuestion. */
    const applicantConfirmedAnswer = Boolean(
      questionsReviewedAt && submittedAnswer && submittedQuestion.confirmed === true
      /* AND ONLY UNDER A LABEL THIS SERVER ITSELF SHOWED HER FOR THIS ROW. The claim is persisted
       * against the stored label (`question: question.question` below), and the id fallback lets a
       * submitted question match while carrying a DIFFERENT label - so without this test a public
       * body could rename a control, flag it confirmed, and mint "she read this exact text" onto
       * text its own request never contained. That guard is unchanged; what changed is what counts
       * as the text she was shown.
       *
       * THIS USED TO READ `submittedQuestion.question === question.question`, on the stated premise
       * that "the review screen posts back the stored label verbatim". It does not. Every read path
       * serves these rows through normalizeStoredPortalQuestions, which rewrites the label and
       * persists nothing, so on a row whose stored label carries a required marker the premise is
       * false on every request and this test could never pass. Measured on Exa packet 73768339:
       * twelve `confirmed: true` saves, twelve 200s, nothing minted, the same four essays back
       * again. See servedLabelMatchesStoredControl for the full account and for why the set it admits -
       * the stored label and the server's own normalization of it, both server-produced - is the
       * honest bar rather than a loosening. A real rename still fails it. */
      && servedLabelMatchesStoredControl(question.question, submittedQuestion.question),
    );
    /* WHAT SHE WAS OVERRIDING, so her correction cannot outlive the fact it was made against.
     *
     * The claim above is necessary and not sufficient. refreshKnownQuestionAnswers keeps an
     * overridden answer only while the resolver still computes the value it replaced, which is what
     * stops "Bachelor's Degree" being sent forever after she corrects her profile to a master's.
     *
     * ITS OWN FIELD AND NOT answer_option_source. Those two are near-opposites and a shared field
     * would make one of them a lie; see the doc on answer_override_of.
     *
     * THE RESOLVER'S VALUE, NEVER THE STORED ANSWER, and that distinction is the whole rule. They are
     * the same string on a plainly resolved record and different on every SNAPPED one: a band record
     * holds "January 2028 - July 2028" while the resolver says "May 2028". Recording the stored answer
     * there wrote a value the profile never produces, currency could never be proved, and her edit was
     * recomputed away - so the override worked on the degree case and silently failed on exactly the
     * graduation and GPA shapes these packets are full of.
     *
     * THE LOOKUP OUTRANKS BOTH STORED NOTES, and getting that order wrong reopens the same hole from
     * the other side. A row can carry a STALE answer_override_of indefinitely: the refresh drops one
     * the moment it stops matching, but the readers that run the refresh do not persist its output, so
     * only the SERVED copy is corrected and the row keeps the old note. Preferring that note over a
     * live resolution recorded "she overrode Bachelor of Science" on a profile that now says master's,
     * currency failed, and her fresh edit was recomputed away - which is the defect this branch exists
     * to fix, arriving through the row's own history. A live resolution cannot be stale by
     * construction, so it wins; the stored notes are what a caller without a lookup falls back to, and
     * for a second correction the lookup answers the same value the chain would have anyway.
     *
     * NOTHING IS RECORDED WHEN NO RESOLVER VALUE CAN BE NAMED, rather than guessing with the stored
     * answer. Absence reads as "cannot prove current" in derivationIsCurrent, exactly as it does for a
     * band with no derivation, and the cost is one recomputation. It also keeps essays out of this
     * field entirely: the resolver answers nothing for an essay label, and copying a 20,000-character
     * answer into a record no branch will ever read for an essay is pure weight in the packet spec.
     *
     * A HELD QUESTION NEEDS NONE OF THIS. The refusal branch keeps her answer on the claim alone. */
    const overriddenResolverValue = applicantSuppliedAnswer
      ? (resolverAnswer
        || question.answer_override_of?.trim()
        || question.answer_option_source?.trim()
        || '')
      /* A CONFIRMATION OF A VALUE THE RESOLVER CURRENTLY DISPUTES IS AN OVERRIDE TOO, and without
       * this branch it was a claim the next read threw away. The refresh keeps a claimed non-band
       * answer only when it equals the resolver's value or when answer_override_of proves which
       * resolution she disagreed with - so a confirm of a stale-tab value, or one racing a profile
       * edit, minted its claim, answered 200, and was recomputed away on the very next read: the
       * CONFIRM loop again, in a narrower shape. Only the live resolver value is recorded, exactly
       * as the edit branch above records it, and only when one exists and disagrees: a confirmation
       * of the resolver's own value needs no override (the refresh keeps it by equality), and a
       * held question needs none (the refusal branch keeps her answer on the claim alone). */
      : applicantConfirmedAnswer && !submittedIsResolverValue && resolverAnswer
        ? resolverAnswer
        : '';
    const {
      answer_source: _answerSource,
      answer_reviewed_at: _answerReviewedAt,
      answer_option_source: _answerOptionSource,
      answer_override_of: _answerOverrideOf,
      consent_permission_granted_at: _consentGrantedAt,
      consent_permission_version: _consentVersion,
      answer_confirmed_of: _answerConfirmedOf,
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
    /* A CONFIRMED ANSWER IS HERS, SO THE MACHINE'S GRANT RECORD GOES. The grant fields exist so the
     * audit shows "an acceptance made on her behalf rather than a tick that reads as if she had made
     * it herself" - and a confirmation is precisely her making it herself. Carrying them under the
     * freshly minted 'applicant_review' would produce a record no other writer can produce and no
     * reader has a ruling for: her claim next to a machine-permission grant for the same answer.
     * Only the two grant fields drop; answer_option_source stays, because "this value was snapped
     * from the control's list" is as true after she confirms it as before. */
    if (applicantConfirmedAnswer) {
      delete carriedAnswerClaims.consent_permission_granted_at;
      delete carriedAnswerClaims.consent_permission_version;
    }
    const carriedForward = exactReviewedIdentityUnchanged
      ? question
      : { ...questionWithoutProvenance, ...carriedAnswerClaims };
    const { answer_state: _carriedAnswerState, ...carriedForwardWithoutAnswerState } = carriedForward;
    /* THE WRITER BEHIND PUT /review/answers, and the reason a skip never reached the record.
     *
     * Same rule as normalizeApplicationReviewQuestions, and it has to be the same or the skip dies
     * here instead of there: 'unanswered' and 'litos_refused' are the machine saying it had nothing
     * to type, and an answer settles them. 'skipped' is the applicant speaking about the CONTROL
     * ("the value is right, the portal's menu will not take it, leave the field alone"), which an
     * answer beside it does not settle. Dropping it on save meant she could mark a question skipped,
     * be told "Saved", and have the record come back without it, so discovery raised the same
     * question on the next fill and the row never became sendable. */
    const storedSkipStillBound = question.answer_state === 'skipped'
      && submittedQuestion.answer.trim() === question.answer.trim();
    const submittedAnswerStateForSave = submittedQuestion.answer_state
      ?? (!submittedQuestion.answer.trim() || storedSkipStillBound ? question.answer_state : undefined);
    /* And the binding cuts the other way on an EDIT. The dashboard un-skips by omitting the key
     * (its `answer_state: undefined` never survives JSON), so a bare `??` fallback would resurrect
     * the stored skip over an answer she just typed to replace it, and the question could never be
     * un-skipped from the product at all. A skip from the stored side therefore stands only while
     * the answer is still the one it was taken against; posting 'skipped' explicitly is the skip
     * action itself and stands on its own. */
    const nextAnswerState = !submittedQuestion.answer.trim()
      || submittedAnswerStateForSave === 'skipped'
      ? submittedAnswerStateForSave
      : undefined;
    return {
      ...carriedForwardWithoutAnswerState,
      answer: submittedQuestion.answer,
      ...(nextAnswerState ? { answer_state: nextAnswerState } : {}),
      kind: submittedQuestion.kind,
      required: question.required || submittedQuestion.required,
      // The stored label is the form identity. A public submit body may update an answer but cannot
      // rename that control, including by changing only case or whitespace, then inherit the proof
      // attached to the exact text the applicant reviewed.
      question: question.question,
      ...(portalSelector ? { portal_selector: portalSelector } : {}),
      ...(portalInputType ? { portal_input_type: portalInputType } : {}),
      ...(atsApiField ? { ats_api_field: atsApiField } : {}),
      // Last, so it wins over anything carriedForward brought along. See applicantSuppliedAnswer
      // and applicantConfirmedAnswer: an edit and an explicit confirmation mint the same claim,
      // because they are the same assertion made through two different controls.
      ...(applicantSuppliedAnswer || applicantConfirmedAnswer
        ? { answer_source: 'applicant_review' as const, answer_reviewed_at: questionsReviewedAt }
        /* AND OTHERWISE THE DRAFT MARKER SURVIVES THE SAVE, byte for byte, exactly as long as the
         * paragraph does. This is the laundering door for the drafting feature and it is the same
         * door the 802-answer incident came through: the review screen posts back the whole list it
         * was shown, so an untouched Save reaches here with the drafted answer unchanged and no
         * confirmation flag. Without this clause the strip above would leave answer_source absent -
         * indistinguishable from a profile relay - and a paragraph she never read would clear the
         * gate. Keyed on `answerUnchanged` because a REPLACED answer is her own bytes, and that case
         * is already the applicantSuppliedAnswer branch above. */
        : question.answer_source === 'litos_draft' && answerUnchanged && submittedAnswer
          ? { answer_source: 'litos_draft' as const }
          : {}),
      /* Beside the claim and never without it, because it is only meaningful as the other half of
       * that claim. See overriddenResolverValue. */
      ...(overriddenResolverValue ? { answer_override_of: overriddenResolverValue } : {}),
      /* AND WHEN THE GATE ABOVE REFUSED THE CLAIM, THE MACHINE'S OWN RECORD TAKES ITS PLACE.
       *
       * REFUSING A CLAIM IS NOT A NO-OP, and that is the whole of this clause. `submittedIsMachineValue`
       * can only be true while `bodyChangedTheAnswer` is true, so every save it fires on is one where
       * the answer on the row is being REPLACED - which means `answerUnchanged` is false, which means
       * the strip above has already dropped `answer_option_source` with the rest of the answer-claims.
       * Leaving it dropped hands refreshKnownQuestionAnswers a bare string with no provenance at all:
       * every keep branch misses, the answer is recomputed to the UN-SNAPPED profile wording, and on a
       * strict closed control reopenUnfitClosedChoiceQuestions then blanks it. Measured end to end on
       * the HRT round with `eeo_prefs.gender = "Female"`, before this clause existed:
       *
       *   stored "Man",  body "Woman"                        ->  ""    (draft "Female")
       *   stored "",     body "Woman"  (the re-opened row)   ->  ""
       *   veteran, body "I am not a protected veteran"       ->  "No"  (on no option the control offers)
       *   disability, body "No, I do not have a disability"  ->  "No"  (same)
       *
       * So declining to say SHE chose it was destroying the answer or rewriting it to a string the
       * employer's control does not offer, which is the ANSWERED-with-nothing-selected divergence the
       * self-identification keep branch exists to prevent.
       *
       * The honest record is not silence, it is the OTHER provenance: this value is a machine snap, and
       * `answer_option_source` is the field that says so. The value written is `resolverAnswer`, the
       * pre-snap string, because that is precisely what refreshKnownQuestionAnswers recomputes to test
       * whether the snap is still current - the same rule, the same string and the same reason as
       * optionSnapClaim on the fill path, which records `profileKnown.value` beside the snapped answer.
       * With it, the employer's own spelling stands on the row and the packet says truthfully that
       * Litos put it there.
       *
       * ONLY WHEN A PRE-SNAP STRING EXISTS, and refusing without writing one is safe there rather than
       * a second version of the bug. `resolveProfileField` returns null unless `resolveKnownAnswer`
       * gave it a value, and `knownAnswerLookup` asks that same resolver, so a row with no
       * `resolverAnswer` is one the refresh also has no value for - and the refresh leaves such a row
       * exactly as it stands. Measured: a "rate your C++ skill level" select resolves to nothing on
       * both lookups, the refresh returns it untouched, and an edit of it still mints her claim. No
       * resolver value means nothing recomputes, so there is nothing for a derivation record to
       * protect, and a derivation that cannot be checked is the kind of claim this file exists to
       * keep off a packet. Written last so it wins over anything carriedForward brought along, and
       * never on a branch that minted an applicant claim: the two are alternatives, not neighbours. */
      ...(submittedIsMachineValue && resolverAnswer ? { answer_option_source: resolverAnswer } : {}),
      /* THE ONE WRITER OF THE ONE PROVENANCE THE SENSITIVE GATE ACCEPTS.
       *
       * Gated on applicantConfirmedAnswer ALONE, and deliberately not on applicantSuppliedAnswer
       * beside it, which is the difference between this field and the answer_source above. An edit
       * mints an applicant-claim because an answer moved and only she moves answers, and that is a
       * true and useful thing to record - but it is inferred from a diff, and a diff cannot tell
       * "she read this legal declaration and chose Yes" from "something posted a different string".
       * For a REFUSED question the second test that normally guards the inference is dead by
       * construction: the resolver returns no value, so submittedIsResolverValue is always false and
       * `!answerUnchanged` is the only barrier left. A confirmation is not inferred from anything -
       * the request states it, per question, for this exact text - and that is the whole reason the
       * gate can accept it.
       *
       * `question.question` and not the submitted label, matching the `question:` line above. The
       * stored text is the form identity; applicantConfirmedAnswer has already required the two to
       * be equal, so this is that decision written down rather than a second copy of it.
       *
       * Recorded for EVERY confirmed answer, not only the sensitive ones. What it asserts - she was
       * shown these words and affirmed this value - is equally true of a confirmed graduation date,
       * and a writer that has to work out whether a label is sensitive before recording the truth
       * about it is a writer that will get that test wrong somewhere. The gate does the selecting. */
      ...(applicantConfirmedAnswer ? { answer_confirmed_of: question.question } : {}),
    };
  });
  const storedKeys = new Set(stored.map((question) => questionKey(question.question)).filter(Boolean));
  for (const [index, question] of submitted.entries()) {
    if (consumedSubmittedIndexes.has(index)) continue;
    const key = questionKey(question.question);
    if (!key || storedKeys.has(key)) continue;
    /* A question that exists only in the submit body brings no provenance with it, including the
     * option derivation. The two above are stripped because a caller must not assert that the
     * applicant reviewed something; this one because a derivation is a claim that resolution snapped
     * this answer onto a control's own option list, and nothing here resolved anything. The override
     * record goes for the third reason: there is no stored answer here to have overridden, so a
     * caller sending one would be claiming it overrode a resolution that never ran. The route's
     * questionSchema drops the key before this is ever called, but this function is exported and
     * this is the one branch that copies a submitted question wholesale. */
    const {
      answer_source: _answerSource,
      answer_reviewed_at: _answerReviewedAt,
      answer_option_source: _answerOptionSource,
      answer_override_of: _answerOverrideOf,
      consent_permission_granted_at: _consentGrantedAt,
      consent_permission_version: _consentVersion,
      /* And this one for a fourth reason that matters more than the other three: it is the only
       * provenance the sensitive question gate accepts, so a caller allowed to send it could open
       * that gate by asserting its own conclusion. There is no stored question here for her to have
       * been shown, which is precisely why a confirmation of one cannot be true. */
      answer_confirmed_of: _answerConfirmedOf,
      /* The request flag, spent above and never stored: a persisted `confirmed` would be a second,
       * uncheckable copy of the claim answer_source already carries. */
      confirmed: _confirmed,
      answer_state: submittedAnswerState,
      ...submittedWithoutProvenance
    } = question;
    merged.push({
      ...submittedWithoutProvenance,
      // Same rule for a question arriving for the first time: her skip stands beside an answer.
      ...((!submittedWithoutProvenance.answer.trim() || submittedAnswerState === 'skipped')
        && submittedAnswerState
        ? { answer_state: submittedAnswerState }
        : {}),
    });
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

export type ManagedFormSnapshotV1 = {
  version: 1;
  field_options: NonNullable<SubmissionPacket['fieldOptions']>;
  failed_fields: NonNullable<SubmissionPacket['failedFields']>;
  cover_letter_supported?: boolean;
  transcript_supported?: boolean;
};

const MANAGED_FORM_SNAPSHOT_MAX_CONTROLS = 80;
/* Greenhouse school inventories routinely exceed 512 exact employer options. Keep the per-control
 * bound high enough to preserve those closed lists, while the independent 512 KiB snapshot limit
 * below remains the final payload-size guard. */
const MANAGED_FORM_SNAPSHOT_MAX_OPTIONS_PER_CONTROL = 4_096;
const MANAGED_FORM_SNAPSHOT_MAX_CONTROL_ID_LENGTH = 500;
const MANAGED_FORM_SNAPSHOT_MAX_SELECTOR_LENGTH = 500;
const MANAGED_FORM_SNAPSHOT_MAX_LABEL_LENGTH = 2_000;
const MANAGED_FORM_SNAPSHOT_MAX_OPTION_LENGTH = 2_000;
const MANAGED_FORM_SNAPSHOT_MAX_INPUT_TYPE_LENGTH = 100;
const MANAGED_FORM_SNAPSHOT_MAX_BYTES = 512 * 1024;

function compareSnapshotIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
  /**
   * Exact employer-question metadata that the latest complete form read could not prove.
   *
   * This is structured separately from attention_reason so a missing question label cannot be
   * presented as if it were the employer's question, and a closed control with no exact option
   * inventory cannot be rendered as a free-text box. An empty array means a complete read measured
   * no metadata gaps. Absence means this run did not complete discovery and made no such claim.
   */
  question_metadata_blockers?: QuestionMetadataBlocker[];
  /* THE APPLICANT'S OWN TICKS ON THE "Your turn" PANEL, keyed by the dashboard's checklist row id
   * (which is derived from the attention sentence, so the key names the sentence it is about).
   *
   * This exists because the panel's checkbox was scenery: `<input type="checkbox">` with no
   * handler, no state and no request, measured on the Easy Dynamics rippling packet on 2026-08-20.
   * Ticking a box wrote nothing, and the next poll re-rendered the panel with the box cleared.
   *
   * DISPLAY-ONLY, DELIBERATELY. An acknowledgement is the applicant saying "I handled this on the
   * employer's page myself". It is her claim, not a measurement, and the send gate keeps reading
   * the run's measurements: a required field the run found empty still blocks a send whether or
   * not the row that names it is ticked. What the tick changes is what the panel counts and
   * colours as outstanding, which is the only thing the dead checkbox ever pretended to do.
   *
   * SCOPED TO ONE RUN'S REPORT. attention_reason is a run's account of the employer's form, and a
   * tick is only meaningful beside the report it was made against - the same discipline the
   * per-answer applicant claim is held to via its review round. So applyReviewPatch drops this map
   * whenever a patch carries a fresh attention_reason, and freshSubmitRequestReview clears it with
   * the rest of the run-scoped state. A re-run that re-measures the same blocker starts her
   * checklist clean rather than inheriting a claim made about an older report. */
  attention_acknowledgements?: Record<string, { label: string; acknowledged_at: string }>;
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
  /* AN INFORMATIONAL NOTE, NEVER A GATE. The other half of a cover-letter prepare failure: the run's
   * own coverLetterIssue sentence (packetForCoverLetterCapability, routes/submissionRunner.ts), kept
   * ONLY when cover_letter_required is not true.
   *
   * A REQUIRED failure still travels through attention_reason/attention_categories and gates `safe`
   * below `ready_for_final_approval` - required_document is the right stop for a document the
   * employer's own form asked for and does not have. An OPTIONAL failure is Litos's problem, not
   * evidence the application is incomplete, and folding it into the same blocking machinery is
   * exactly what parked Sage packet aae653a3-2d5a-4f3e-ba3b-afea4219df37 needs_attention with 17
   * filled fields, zero unanswered required questions and a dashboard describing the letter as
   * "does not require one": a retry could never have produced a different outcome, because nothing
   * about the application was actually wrong. See lib/portalSubmission.ts's
   * coverLetterAttentionDisposition for where this split is decided, off the same cover_letter_required
   * measurement finalApprovalCoverLetterIssue already trusts.
   *
   * Written (including undefined, to clear a prior run's note) on every prepare that measured a
   * cover-letter capability, the same discipline attention_reason is held to. Absent means either no
   * prepare has measured this yet, or the last one had nothing to say. */
  cover_letter_skipped_reason?: string;
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
  /* A CLAIM THAT WAS LIFTED BY THE ROW'S OWN EVIDENCE, NAMED, so the audit trail can say what
   * happened and why without grepping prose.
   *
   * Written by releaseExpiredAttendedHandoffClaim (lib/expiredHandoffClaimRelease.ts) and by
   * nothing else. 'attended_handoff_expired' means: the run parked at an attended handoff without
   * pressing send, the row carried none of the four stored facts that mean something may already
   * be at the employer, the 55-minute handoff window was over, and no extension submission outcome
   * event existed for this application - so the claim was guarding a send that provably never
   * happened and an attended finish that could no longer happen. Measured on the Fully
   * (teamtailor) packet, 2026-08-20, where that combination was permanently un-auditable and
   * un-runnable.
   *
   * claim_id is the exact claim that was released, kept so the release can be reconciled against
   * whatever run took it. Presence of this record proves a release occurred; it is never read as a
   * licence for anything, and a later run that takes a fresh claim leaves it in place as history. */
  claim_released?: {
    cause: 'attended_handoff_expired' | 'attempt_never_reached_employer';
    claim_id?: string;
    released_at: string;
  };
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
  /** Versioned hashes for every finite employer-delivery packet mode approved in this audit. */
  employer_delivery_bindings?: EmployerDeliveryBindings;
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
    /* 'form_reading_measured' is written by the runner's prepare when the discovery pass read the
     * employer's form after she approved and learned something the approval was taken without: the
     * cover-letter and transcript capabilities, and the rows the form actually asks. The delivery
     * envelope moves by exactly those facts, nothing she looked at changed, and every learned row
     * is answerless and still has to reach her on the answers screen before any send. See
     * relearnedFormReadingAcknowledgement in lib/packetResumeRestore.ts.
     *
     * 'capabilities_measured' is the same fact under its older, narrower name, written between
     * 2026-09-01 and 2026-09-02 when the carry covered capabilities alone. It stays in the union
     * because rows carry it; nothing writes it any more. */
    source?: 'applicant' | 'auto_restored' | 'capabilities_measured' | 'form_reading_measured';
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
  /** Bounded live-form inventory frozen into every later audit and managed submit packet. */
  managed_form_snapshot?: ManagedFormSnapshotV1;
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
    continuation_execution_fingerprint?: string;
    continuation_resumed?: boolean;
    /** Database-clock window in which the one retained-session provider call may still be live. */
    continuation_call_started_at?: string;
    continuation_call_deadline_at?: string;
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
    /* What the submit request itself came back with, recorded by the runner around the press.
     * Origin plus path, method, and a status or a failure text. Evidence for the person (or the
     * next session) resolving this record: a 200 on the board's submit path reads very differently
     * from a 422 or a request that never returned. Never used to decide anything automatically. */
    network?: { method: string; url: string; status: number | null; failure?: string }[];
    /* The runner reported a rendered CAPTCHA still standing after the press. Evidence for the
     * person resolving this record, and what selects the human-check sentence. */
    challenge_on_screen?: true;
    /* What the runner saw on the page after the press (its rendered text, bounded) and where it
     * landed. Evidence for the person resolving the record - the one line the page did show is
     * usually the whole answer. Never used to decide anything automatically. */
    observed_page_text?: string;
    final_url?: string;
    resolution?: 'sent' | 'not_sent';
    resolved_at?: string;
  };
};

function managedFormSnapshotString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') throw new Error(`Managed form snapshot ${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`Managed form snapshot ${field} cannot be empty`);
  if (normalized.length > maxLength) {
    throw new Error(`Managed form snapshot ${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function managedFormSnapshotOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return managedFormSnapshotString(value, field, maxLength);
}

/**
 * Canonicalize the live managed form inventory without dropping identity-bearing evidence.
 * Oversized or malformed input stops the run instead of being truncated into an incomplete packet.
 */
export function normalizeManagedFormSnapshot(input: {
  fieldOptions?: SubmissionPacket['fieldOptions'];
  failedFields?: SubmissionPacket['failedFields'];
  coverLetterSupported?: boolean;
  transcriptSupported?: boolean;
}): ManagedFormSnapshotV1 {
  if (input.fieldOptions !== undefined
    && (input.fieldOptions === null
      || typeof input.fieldOptions !== 'object'
      || Array.isArray(input.fieldOptions))) {
    throw new Error('Managed form snapshot field options must be an object');
  }
  const optionEntries = Object.entries(input.fieldOptions ?? {});
  if (optionEntries.length > MANAGED_FORM_SNAPSHOT_MAX_CONTROLS) {
    throw new Error(`Managed form snapshot supports at most ${MANAGED_FORM_SNAPSHOT_MAX_CONTROLS} controls`);
  }
  const normalizedOptionEntries: Array<[string, string[]]> = [];
  const normalizedControlIds = new Set<string>();
  for (const [rawControlId, rawOptions] of optionEntries) {
    const controlId = managedFormSnapshotString(
      rawControlId,
      'control id',
      MANAGED_FORM_SNAPSHOT_MAX_CONTROL_ID_LENGTH,
    );
    if (normalizedControlIds.has(controlId)) {
      throw new Error(`Managed form snapshot repeats control id ${controlId}`);
    }
    normalizedControlIds.add(controlId);
    if (!Array.isArray(rawOptions)) {
      throw new Error(`Managed form snapshot options for ${controlId} must be an array`);
    }
    if (rawOptions.length > MANAGED_FORM_SNAPSHOT_MAX_OPTIONS_PER_CONTROL) {
      throw new Error(
        `Managed form snapshot supports at most ${MANAGED_FORM_SNAPSHOT_MAX_OPTIONS_PER_CONTROL} options per control`,
      );
    }
    const seen = new Set<string>();
    const options: string[] = [];
    for (const rawOption of rawOptions) {
      const option = managedFormSnapshotString(
        rawOption,
        `option for ${controlId}`,
        MANAGED_FORM_SNAPSHOT_MAX_OPTION_LENGTH,
      );
      if (seen.has(option)) continue;
      seen.add(option);
      options.push(option);
    }
    normalizedOptionEntries.push([controlId, options]);
  }
  normalizedOptionEntries.sort(([left], [right]) => compareSnapshotIdentity(left, right));
  const fieldOptions = Object.fromEntries(normalizedOptionEntries);

  if (input.failedFields !== undefined && !Array.isArray(input.failedFields)) {
    throw new Error('Managed form snapshot failed fields must be an array');
  }
  const rawFailedFields = input.failedFields ?? [];
  if (rawFailedFields.length > MANAGED_FORM_SNAPSHOT_MAX_CONTROLS) {
    throw new Error(`Managed form snapshot supports at most ${MANAGED_FORM_SNAPSHOT_MAX_CONTROLS} failed controls`);
  }
  const failedByIdentity = new Map<string, ManagedFormSnapshotV1['failed_fields'][number]>();
  for (const rawField of rawFailedFields) {
    if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) {
      throw new Error('Managed form snapshot failed field must be an object');
    }
    const controlId = managedFormSnapshotString(
      rawField.controlId,
      'failed control id',
      MANAGED_FORM_SNAPSHOT_MAX_CONTROL_ID_LENGTH,
    );
    const label = managedFormSnapshotOptionalString(
      rawField.label,
      `label for ${controlId}`,
      MANAGED_FORM_SNAPSHOT_MAX_LABEL_LENGTH,
    ) ?? controlId;
    const selector = managedFormSnapshotOptionalString(
      rawField.selector,
      `selector for ${controlId}`,
      MANAGED_FORM_SNAPSHOT_MAX_SELECTOR_LENGTH,
    );
    const inputType = managedFormSnapshotOptionalString(
      rawField.inputType,
      `input type for ${controlId}`,
      MANAGED_FORM_SNAPSHOT_MAX_INPUT_TYPE_LENGTH,
    );
    const field = {
      controlId,
      label,
      ...(selector ? { selector } : {}),
      ...(inputType ? { inputType } : {}),
    };
    failedByIdentity.set(JSON.stringify(field), field);
  }
  const failedFields = [...failedByIdentity.entries()]
    .sort(([left], [right]) => compareSnapshotIdentity(left, right))
    .map(([, field]) => field);

  const controlIdentities = new Set([...normalizedControlIds, ...failedFields.map((field) => field.controlId)]);
  if (controlIdentities.size > MANAGED_FORM_SNAPSHOT_MAX_CONTROLS) {
    throw new Error(`Managed form snapshot supports at most ${MANAGED_FORM_SNAPSHOT_MAX_CONTROLS} controls`);
  }

  if (input.coverLetterSupported !== undefined && typeof input.coverLetterSupported !== 'boolean') {
    throw new Error('Managed form snapshot cover letter capability must be boolean');
  }
  if (input.transcriptSupported !== undefined && typeof input.transcriptSupported !== 'boolean') {
    throw new Error('Managed form snapshot transcript capability must be boolean');
  }
  const snapshot: ManagedFormSnapshotV1 = {
    version: 1,
    field_options: fieldOptions,
    failed_fields: failedFields,
    ...(input.coverLetterSupported !== undefined
      ? { cover_letter_supported: input.coverLetterSupported }
      : {}),
    ...(input.transcriptSupported !== undefined
      ? { transcript_supported: input.transcriptSupported }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MANAGED_FORM_SNAPSHOT_MAX_BYTES) {
    throw new Error(`Managed form snapshot exceeds ${MANAGED_FORM_SNAPSHOT_MAX_BYTES} bytes`);
  }
  return snapshot;
}

/** Validate and read a stored snapshot, including its mirrored dashboard capability fields. */
export function readManagedFormSnapshot(
  review: Pick<ApplicationReviewState,
    'managed_form_snapshot' | 'cover_letter_supported' | 'transcript_supported'>,
): ManagedFormSnapshotV1 | undefined {
  const stored = review.managed_form_snapshot as unknown;
  if (stored === undefined) return undefined;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('Managed form snapshot must be an object');
  }
  const record = stored as Record<string, unknown>;
  if (record.version !== 1) throw new Error('Managed form snapshot version is not supported');
  if (!Object.prototype.hasOwnProperty.call(record, 'field_options')
    || !Object.prototype.hasOwnProperty.call(record, 'failed_fields')) {
    throw new Error('Managed form snapshot is missing its form inventory');
  }
  const snapshot = normalizeManagedFormSnapshot({
    fieldOptions: record.field_options as SubmissionPacket['fieldOptions'],
    failedFields: record.failed_fields as SubmissionPacket['failedFields'],
    coverLetterSupported: record.cover_letter_supported as boolean | undefined,
    transcriptSupported: record.transcript_supported as boolean | undefined,
  });
  if (snapshot.cover_letter_supported !== review.cover_letter_supported) {
    throw new Error('Managed form snapshot cover letter capability differs from the review');
  }
  if (snapshot.transcript_supported !== review.transcript_supported) {
    throw new Error('Managed form snapshot transcript capability differs from the review');
  }
  return snapshot;
}

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
  /* Derived here, at the one choke point every caller already goes through, so a packet stored
   * before portal_supported existed still answers the question correctly and no backfill migration
   * is needed.
   *
   * A STORED `true` ALWAYS WINS, and is the only value this leaves alone. Everything else -
   * `undefined` (never computed) and `false` (computed unsupported, once) - gets a fresh look on
   * every read. That second case is new as of 2026-09-05: MEASURED LIVE the same day, account
   * mehekmandal05@gmail.com, POST /resume/generate stored portal_supported: false for
   * https://covenanthouseinternational.na.teamtailor.com/jobs/686133-intern-finance because
   * HOSTS.teamtailor in lib/portalSubmission.ts did not yet recognise a regional Teamtailor tenant
   * (see that map's own comment). Widening the host regex fixes every NEW packet at generate time,
   * but a stored `false` from before the fix does not become true by itself - `state.portal_url`
   * never changes, so nothing else here would ever ask the detector again, and the dashboard would
   * keep routing an account holding the Teamtailor consent grant to the extension handoff forever
   * for a posting Litos can now send. Re-deriving is cheap (a handful of regexes, no I/O) and safe
   * in this direction: a stale false correcting to true here is the read this whole function
   * exists to give, and a detector that regresses genuinely-supported to unsupported is a separate,
   * worse bug this cannot cause - retrying downward is exactly the trap applyApplicationReviewEdit's
   * own comment names, which is why a stored `true` is still never revisited. */
  if (state.portal_supported !== true && state.portal_url) {
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
    /* THE BLANKET STAMP, MINUS THE ONE RECORD IT MUST NOT TOUCH.
     *
     * This function claims every non-blank answer in the body as hers, which is what PUT /review
     * means by a review round. A LITOS DRAFT is the exception, and skipping it is what keeps this
     * route from being a second door into the laundering the narrow answers route was fixed for: a
     * paragraph Litos composed does not become her answer because a whole-list Save went past it.
     * Approval is per-question and explicit - PUT /applications/:id/review/answers with
     * `confirmed: true`, or an edit that changes the bytes - and both of those run through
     * mergeSubmittedApplicationReviewQuestions, which mints 'applicant_review' over the marker. */
    questions: questions.map((question) => question.answer.trim() && question.answer_source !== 'litos_draft'
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
    /* THE CONFIRMATION FLAG IS NOT THIS ROUTE'S TO CARRY, stripped here rather than left to a schema
     * in another file.
     *
     * PUT /review is the BLANKET stamp path: applyApplicantReviewedAnswers below claims every
     * non-blank answer in the body as hers, which is the writer the 802-answer laundering came
     * through. `confirmed` is the one byte that mints answer_confirmed_of, and answer_confirmed_of is
     * the only provenance the sensitive question gate accepts, so a blanket route that could also
     * carry confirmations would be a blanket route that can open that gate.
     *
     * reviewBodySchema does not list the key and zod strips it, so nothing reaches here carrying one
     * today. This makes that a property of the FUNCTION rather than of a schema someone can widen
     * without ever opening this file, and it is the sort of thing worth being boring about: the cost
     * is one map, and the thing on the other side is a legal declaration on a live application.
     * Confirmations have one surface, PUT /review/answers, and it is the narrow one. */
    edit.questions.map((question) => {
      const { confirmed: _confirmed, ...withoutRequestFlag } = question as SubmittedApplicationReviewQuestion;
      return withoutRequestFlag as ApplicationReviewQuestion;
    }),
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
