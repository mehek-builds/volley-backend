/* A FOLLOW-UP FIELD THE EMPLOYER LEFT OPTIONAL, REPORTED BACK AS REQUIRED AND EMPTY.
 *
 * WHAT WAS MEASURED, read-only against the live Greenhouse markup on 2026-08-13, and against
 * account a18f774b's blocked packets on the same day.
 *
 * Scale AI packet 9ddffb88 (job-boards.greenhouse.io/embed/job_app?for=scaleai&token=4703343005)
 * stopped on one sentence:
 *
 *     "If yes, please provide further explanation below." is required and is still empty
 *     1 required field has no question you can answer in Litos: "If yes, please provide further
 *     explanation below."
 *
 * That field is `question_8788020005`. In the employer's own markup it carries
 * `aria-required="false"`, NO `required` attribute, and a `<label>` with no asterisk in it. The
 * employer does not require it. Neither does Litos's discovery pass think so: the raw discovered
 * label carries no `*`, so labelMarksRequired is false and discoveredFieldIsRequired is false, and
 * that is precisely WHY no question record exists for it. Both halves of the packet's complaint
 * come from one false premise.
 *
 * WHERE THE PREMISE IS MANUFACTURED. The readiness gate's last loop reads any LEAF element whose
 * text matches its field-error vocabulary as a validation message and blocks on that element's
 * widget (READ_SUBMIT_READINESS_SCRIPT in portalSubmission.ts, and its twin in the managed
 * provider, which is what actually ran here). `ERROR_TEXT` contains `please provide`. An employer's
 * own `<label>` is a leaf element exactly when the field is optional, because a REQUIRED Greenhouse
 * label carries `<span aria-hidden="true">*</span>` inside it and is therefore not a leaf. So the
 * loop reads the employer's QUESTION as the employer's COMPLAINT, and it can only ever do so on
 * fields the employer marked optional. Three forms, one shape:
 *
 *   Scale AI   question_8788020005  "If yes, please provide further explanation below."
 *                                   aria-required=false, no asterisk, leaf label  -> false blocker
 *   DV Trading question_8954179005  "If yes, please provide your visa type and expiration date."
 *                                   aria-required=false, no asterisk, leaf label  -> false blocker
 *   Akuna      question_67727968    "If you answered "Yes" above to requiring visa sponsorship..."
 *                                   aria-required=TRUE, asterisk, non-leaf label  -> REAL, and this
 *                                   module must never touch it.
 *
 * The vocabulary explains the corpus exactly. Of the optional conditional follow-ups on those three
 * forms, only the two containing "please provide" are reported; "If other, please explain", "If you
 * selected 'Other', please list your University:" and "If yes, select your most recent proprietary
 * trading firm experience" are not, and none of them appear in any blocked packet.
 *
 * WHAT THIS MODULE IS ALLOWED TO DO ABOUT IT, and why it is this narrow. The sentence arrives from
 * a browser provider this repo does not own, so it cannot be prevented here; it can only be
 * refused. Refusing a required-field blocker is the most dangerous edit in this codebase - being
 * wrong means an employer receives an incomplete application the applicant can never withdraw - so
 * the refusal is a conjunction of four independent facts, and the absence of ANY of them keeps the
 * blocker:
 *
 *   1. Litos's own discovery pass saw this exact field, once and unambiguously.
 *   2. Every required marker the employer publishes is absent from it (discoveredFieldIsRequired).
 *      This is the load-bearing one. It is the employer's own statement, read by our own pass, and
 *      it is what separates Scale AI and DV Trading from Akuna.
 *   3. The label OPENS with an anaphor whose referent is the question above it: "if yes", "if so",
 *      "if you answered yes". Anchored at the start and closed to a yes/no/so referent, so "If
 *      applicable", "If other", "If you have a current work authorization" match nothing.
 *   4. The question above it - the nearest PRECEDING discovered field that the packet has a
 *      question record for - carries a determinate answer of the opposite polarity.
 *
 * Fact 4 is the one the caller usually cannot supply, and that is honest rather than unfortunate.
 * Over the 7 measured instances: 4 have a gating question that was itself left unanswered (a legal
 * declaration Litos refuses to answer for her), so the condition is UNDETERMINED and the follow-up
 * keeps blocking; 2 answer the sponsorship gate "Yes", so the condition is MET and the follow-up
 * genuinely applies; and exactly 1, Scale AI 9ddffb88, answers its gate "No" and is provably unmet.
 * A wrongly-required field costs a question; a wrongly-skipped one costs an application.
 *
 * A KNOWN LIMIT, RECORDED RATHER THAN FIXED. "Nearest preceding question record" is a heuristic and
 * it can pick the wrong gate: a sponsorship question answered "Yes", an unrelated question answered
 * "No" rendered between the two, and an "If yes" follow-up after it, and this reads the unrelated
 * "No" and drops a blocker it should have kept. No form in the measured corpus has that shape, and
 * fact 2 bounds the damage in the only direction that matters: the field is one the employer's own
 * markers say is optional, so the application cannot become incomplete by the employer's own
 * reckoning. What is lost is the same thing already lost on every optional follow-up that keeps its
 * blocker - a question she has no record to type into anyway. Closing it properly needs the
 * employer's own conditional wiring (a `data-conditional-on` or the ATS's own show/hide rule),
 * which neither discovery pass reports today.
 *
 * NO SENSITIVE GATE IS WEAKENED. A consent, an EEO self-identification, a work-authorization
 * question and a sponsorship question are never phrased as an anaphor, so fact 3 excludes all of
 * them outright. A sponsorship FOLLOW-UP ("if yes, provide your visa type") is reachable, and is
 * dropped only where the employer marked it optional AND the sponsorship answer was "No" - under
 * which the employer's own form asks nothing. Akuna's sponsorship follow-up is marked required and
 * is answered "Yes", so it fails facts 2 and 4 both.
 */

import { discoveredFieldIsRequired, normalizeReviewQuestionLabel } from './questionDiscovery';

/**
 * The employer's own "this field is missing" sentence, as every path in this repo renders it.
 *
 * Lives here rather than beside its first caller because two files now have to agree, character for
 * character, about which blocker lines name a field: the runner counts them
 * (unansweredRequiredBlockerLabels) and this module refuses a subset of them. Two copies of one
 * rule is one copy too many when disagreeing between them means a blocker is dropped from the send
 * gate and still counted as unanswerable.
 */
export const REQUIRED_AND_EMPTY_BLOCKER = /^"(.+)" is required and is still empty$/;

/**
 * Shortest label worth comparing by prefix. A provider truncates a long blocker label - Akuna's
 * arrives clipped at 120 characters - so a discovered field and a blocker naming the same control
 * agree only on their opening. Below this length that agreement is a coincidence. Deliberately the
 * same threshold the runner's own blocker matching uses.
 */
const BLOCKER_PREFIX_MATCH_MIN_LENGTH = 8;

/**
 * THE ANAPHOR, and nothing else in the label.
 *
 * A conditional follow-up names no subject of its own: it opens by pointing back at the question
 * printed above it and says which of that question's answers makes it apply. That pointing is the
 * whole grammar, it lives entirely in the opening clause, and it is closed - the referent is `yes`,
 * `no`, `not` or `so` and there is no fifth. Anything the employer wrote after the comma is
 * ignored, which is what keeps this from becoming a vocabulary of topics.
 *
 * Anchored at the start on purpose. "Please explain if yes" is a question that happens to contain
 * the words and is not an anaphor; it returns null and the field keeps blocking.
 *
 * The optional verb group exists because employers spell the same pointing three ways - "If yes,",
 * "If you answered "Yes" above,", "If the answer above is yes," - and every alternative in it is a
 * verb of ANSWERING. No verb of having, being or doing, so "If you have a current work
 * authorization/status, when does it expire?" and "If you are an undergraduate considering a
 * master's degree" are not anaphors, which is correct: their condition is not the answer to the
 * question above, and nothing in this module could evaluate it.
 *
 * MEASURED against every conditional label on the three forms in the corpus: 4 match (Scale AI's
 * and DV Trading's explanation fields, Akuna's sponsorship follow-up, and DV's trading-firm
 * follow-up), 8 do not ("If applicable...", "If other...", "If you selected 'Other'...", "If you
 * have upcoming deadlines...", and the rest). Not matching costs a blocker that stays; it can never
 * drop one.
 */
const FOLLOW_UP_ANAPHOR = new RegExp(
  String.raw`^\s*if\s+`
  + String.raw`(?:you\s+(?:answered?|selected?|checked?|indicated?|replied|responded?|said|chose|choose|marked?)\s+)?`
  + String.raw`(?:the\s+(?:answer|response)\s+(?:above\s+)?(?:is|was)\s+)?`
  + String.raw`["'‘’“”]*\s*(yes|no|not|so)\b`,
  'i',
);

/**
 * Which answer to the question above makes this follow-up apply, or null when the label is not
 * pointing back at anything.
 */
export function conditionalFollowUpPolarity(label: string): 'yes' | 'no' | null {
  const referent = (label ?? '').match(FOLLOW_UP_ANAPHOR)?.[1]?.toLowerCase();
  if (!referent) return null;
  // "If so" restates the question above rather than negating it, so it is the affirmative branch.
  if (referent === 'yes' || referent === 'so') return 'yes';
  return 'no';
}

/**
 * The polarity of a stored answer, and null for everything this cannot read as a plain yes or no.
 *
 * THE TWO DIRECTIONS ARE NOT SYMMETRICAL, and the asymmetry is the safety argument. Reading an
 * answer as NEGATIVE is what lets a blocker be dropped, so the negative set is exact: the whole
 * answer, and nothing else. Reading one as AFFIRMATIVE can only ever keep a blocker, because it is
 * used to confirm that a follow-up really does apply, so "Yes, I will require sponsorship" is
 * allowed to lead with its word.
 *
 * Everything else - an empty answer, "Prefer not to say", a free-text sentence - is undetermined,
 * which keeps the follow-up required. That is the common case on this corpus, not the exception.
 */
export function gatingAnswerPolarity(answer: string | undefined): 'yes' | 'no' | null {
  const value = (answer ?? '').trim().toLowerCase().replace(/[.\s]+$/u, '');
  if (!value) return null;
  if (/^(?:no|n|false)$/.test(value)) return 'no';
  if (/^(?:yes|y|true)\b/.test(value)) return 'yes';
  return null;
}

export type ConditionalFollowUpDiscoveredField = { label: string; required?: boolean };
export type ConditionalFollowUpQuestion = { question: string; answer?: string };

function labelsAgree(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < BLOCKER_PREFIX_MATCH_MIN_LENGTH || right.length < BLOCKER_PREFIX_MATCH_MIN_LENGTH) return false;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * The blocker sentences whose condition this run can PROVE the employer's form does not impose.
 *
 * Returns the subset of `blockers` to drop, never a rewritten list, so the caller keeps every other
 * sentence in the order the provider produced it and can log exactly what was refused.
 *
 * `discovered` must be the discovery pass's field list in DOCUMENT ORDER, because that order is the
 * only evidence of which question a follow-up is pointing back at. Greenhouse renders a follow-up
 * immediately after its gate, and Litos's own walk is a document-order querySelectorAll, so "the
 * nearest preceding discovered field that the packet has a question record for" is that gate.
 * Verified on Scale AI packet 9ddffb88, whose nine stored questions sit in exactly the order their
 * `question_878801*` ids appear in the live form.
 *
 * The scan backwards stops at the FIRST discovered field the packet has a question record for,
 * answered or not. It does not keep looking for one that happens to carry a yes or a no: an
 * unanswered question standing between the follow-up and an older answer means the referent is
 * unknown, and reaching past it would attribute a follow-up to a question that is not above it.
 */
export function unmetConditionalFollowUpBlockers(
  blockers: readonly string[],
  discovered: readonly ConditionalFollowUpDiscoveredField[],
  questions: readonly ConditionalFollowUpQuestion[],
): string[] {
  const answerByLabel = new Map<string, string>();
  for (const question of questions) {
    const key = normalizeReviewQuestionLabel(question.question ?? '').toLowerCase();
    if (!key || answerByLabel.has(key)) continue;
    answerByLabel.set(key, question.answer ?? '');
  }
  const fields = discovered.map((field) => ({
    field,
    key: normalizeReviewQuestionLabel(field.label ?? '').toLowerCase(),
  }));
  const dropped: string[] = [];
  for (const blocker of blockers) {
    const named = blocker.match(REQUIRED_AND_EMPTY_BLOCKER)?.[1];
    if (!named) continue;
    const needle = normalizeReviewQuestionLabel(named).toLowerCase();
    if (!needle) continue;
    // Fact 1. Unknown to discovery, or matching two controls at once, is not something this can
    // reason about: it cannot say which field the employer marked how, nor which question stands
    // above it.
    const matched = fields.filter((entry) => entry.key && labelsAgree(entry.key, needle));
    if (matched.length !== 1) continue;
    const index = fields.indexOf(matched[0]!);
    // Fact 2. The employer's own required markers, read off the RAW discovered label by the same
    // predicate the rest of the runner uses. Present means required, full stop - a conditional
    // field an employer chose to mark required is required unconditionally, and Akuna's is.
    if (discoveredFieldIsRequired(matched[0]!.field)) continue;
    // Fact 3.
    const condition = conditionalFollowUpPolarity(needle);
    if (!condition) continue;
    // Fact 4.
    let gate: string | undefined;
    for (let above = index - 1; above >= 0; above -= 1) {
      const key = fields[above]!.key;
      if (!key || !answerByLabel.has(key)) continue;
      gate = answerByLabel.get(key);
      break;
    }
    const polarity = gatingAnswerPolarity(gate);
    if (polarity === null || polarity === condition) continue;
    dropped.push(blocker);
  }
  return [...new Set(dropped)];
}
