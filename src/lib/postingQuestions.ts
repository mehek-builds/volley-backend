/**
 * THE PRE-SCRIPT: a posting's application questions, known before anybody clicks Apply.
 *
 * Everything in this file is pure. The browser call and the database live in
 * routes/postingQuestions.ts; what is here is the two decisions that are worth testing without
 * either: what a stored question set looks like and when it goes stale, and how that set splits
 * into "Litos already has this" and "only she can answer this" for one applicant.
 *
 * ---------------------------------------------------------------------------------------------
 * THE COST DECISION, written down here because it is the part of this feature most likely to be
 * quietly reversed by someone who thinks pre-scanning everything would be tidier.
 *
 * The board carries 22,644 active postings. A discovery pass is a managed browser run: a real page
 * load against an employer's ATS, a DOM walk, and on Greenhouse two rounds of option probes.
 *
 *   Eager sweep of the whole board.  The submission cron is a daily Vercel Hobby job with
 *   maxDuration 300s. At the ~15s a page load and walk actually take, that window clears about 20
 *   postings a day. 22,644 / 20 is over three years, and the median posting is gone from the board
 *   in weeks. The sweep never catches up with its own input. It is not an expensive plan, it is a
 *   plan that does not terminate, and no amount of budget fixes it inside this deployment.
 *
 *   Scan whatever the board surfaces.  Cheaper, and still wrong-shaped. A board page is 50 rows and
 *   she applies to one or two of them; scanning the page is 25 to 50 wasted browser runs per scroll,
 *   paid at browse time, when she is not waiting for an answer and gets nothing back for it.
 *
 *   Lazy per posting, cached, shared.  What this module does. One run per posting she actually
 *   applies to, kept and reused by every later applicant, every regenerated packet, and every
 *   retry. At the observed 25 applications in a run, that is 25 runs against 22,644 - about a tenth
 *   of one percent of the eager plan - and the cache means the second application to the same
 *   posting costs nothing at all.
 *
 * NEON TRANSFER. The free tier's 5 GB monthly ceiling has been exhausted once already by a much
 * smaller read (docs/incidents/2026-08-04-neon-transfer-quota.md), so the storage question is
 * really a read question. A stored question set is a couple of kilobytes; reading one per Apply is
 * about 50 KB a day, which is noise against 5 GB. Reading fifty of them into every board page would
 * be roughly 100 KB per load on the single most-loaded surface in the product, against the 1.1 MB
 * worst-case ranked load that egressBudget.test.ts pins. That is the whole reason the pre-script is
 * fetched on its own endpoint on the Apply path and is not a field on a board row.
 * ---------------------------------------------------------------------------------------------
 */

import {
  discoveredFieldIsRequired,
  isCoreIdentityField,
  isOpenEndedQuestion,
  normalizeDiscoveredLabel,
  normalizeReviewQuestionLabel,
  resolveKnownAnswer,
  type ApplicationProfileLike,
  type DiscoveredQuestion,
} from './questionDiscovery';
import { isSelfDeclarationQuestion, selfDeclarationSkipReason } from './selfDeclaration';
import { answerReuseScope, savedAnswerFor, type AnswerReuseContext } from './answerReuse';

/** One control on an employer's application form, as the pre-script remembers it. */
export type PostingQuestion = {
  /** The employer's question, normalized the way a stored review question is. */
  label: string;
  /** 'text' | 'textarea' | 'select' | 'combobox' | 'radio' | 'checkbox' | ... */
  input_type: string;
  /** The control's real option texts when it has a closed list, else null. */
  options: string[] | null;
  /** Whether the employer marks the field required. */
  required: boolean;
  /** The control's maxlength, when it declares one. Null otherwise. */
  max_length: number | null;
};

export type PostingQuestionsDiscoveryStatus = 'ok' | 'form_not_reached' | 'failed';

export type PostingQuestionsRecord = {
  job_id: string;
  apply_url: string;
  portal: string | null;
  questions: PostingQuestion[];
  discovery_status: PostingQuestionsDiscoveryStatus;
  discovered_at: Date;
};

/**
 * HOW LONG A SCAN IS BELIEVED.
 *
 * Fourteen days for a good one. An employer's application form changes when the ATS template
 * changes or the req is edited, which is rare, while the posting itself usually leaves the board
 * inside a month. A shorter life would buy freshness the form does not actually need and pay for it
 * in browser runs; a longer one outlives the posting and is never consulted anyway.
 *
 * Six hours for a scan that never reached a form. That result is far more often about the moment
 * than about the posting - a slow page, a login wall that a session would have cleared, a provider
 * hiccup - so it is remembered just long enough to stop a retry loop from paying for the same
 * failure ten times in one session, and no longer.
 */
export const POSTING_QUESTIONS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const POSTING_QUESTIONS_FAILED_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Is a stored scan still usable for this apply URL?
 *
 * The URL is compared as well as the age. A poll that rewrites monitored_jobs.apply_url has changed
 * which page the questions came from, and a question set discovered against a different page is
 * stale however recently it was written.
 */
export function postingQuestionsAreFresh(
  record: Pick<PostingQuestionsRecord, 'apply_url' | 'discovery_status' | 'discovered_at'> | null | undefined,
  applyUrl: string,
  now: Date = new Date(),
): boolean {
  if (!record) return false;
  if (record.apply_url !== applyUrl) return false;
  const ttl = record.discovery_status === 'ok' ? POSTING_QUESTIONS_TTL_MS : POSTING_QUESTIONS_FAILED_TTL_MS;
  const age = now.getTime() - new Date(record.discovered_at).getTime();
  return Number.isFinite(age) && age >= 0 && age < ttl;
}

/**
 * Turn a raw discovery result into the form inventory that gets stored.
 *
 * Normalization happens HERE, once, on the write side, so that every later reader compares the same
 * strings. Core identity fields (name, email) are dropped: the fixed-field pass types those from
 * the packet on every run, and carrying them into the pre-script would turn "here is what only you
 * can answer" into a list that opens with her own name.
 */
export function postingQuestionsFromDiscovered(discovered: readonly DiscoveredQuestion[]): PostingQuestion[] {
  const byLabel = new Map<string, PostingQuestion>();
  for (const field of discovered) {
    const raw = field?.label ?? '';
    const label = normalizeReviewQuestionLabel(raw);
    if (!label) continue;
    if (isCoreIdentityField(normalizeDiscoveredLabel(raw))) continue;
    const options = Array.isArray(field.options)
      ? [...new Set(field.options.map((option) => (option ?? '').trim()).filter(Boolean))]
      : [];
    const next: PostingQuestion = {
      label,
      input_type: (field.inputType ?? 'text').trim() || 'text',
      options: options.length > 0 ? options : null,
      // Read off the RAW label, before normalization strips the employer's `*` marker.
      required: discoveredFieldIsRequired({ label: raw, required: field.required }),
      max_length: typeof field.maxLength === 'number' && field.maxLength > 0 ? field.maxLength : null,
    };
    const key = label.toLowerCase();
    const existing = byLabel.get(key);
    if (!existing) {
      byLabel.set(key, next);
      continue;
    }
    // Two controls under one label: keep the richer record rather than the later one. A radio group
    // discovered control-by-control arrives as several rows, and only some of them carry options.
    byLabel.set(key, {
      ...existing,
      options: existing.options ?? next.options,
      required: existing.required || next.required,
      max_length: existing.max_length ?? next.max_length,
    });
  }
  return [...byLabel.values()];
}

/** Why a question is being put in front of the applicant. Drives the copy beside it. */
export type PrescriptAskReason =
  | 'self_declaration'
  | 'choice_for_you'
  | 'nothing_on_file'
  | 'needs_your_words';

/** One row of the pre-script, resolved for one applicant. */
export type PrescriptQuestion = {
  label: string;
  input_type: string;
  options: string[] | null;
  required: boolean;
  max_length: number | null;
  /** True when this question needs the applicant. False when Litos already has the answer. */
  ask: boolean;
  /** Present only when `ask` is true. */
  reason?: PrescriptAskReason;
  /**
   * The answer that will go in. For an ask, this is a REMEMBERED answer she gave on an earlier
   * posting and nothing else: never a profile inference, never a draft, never a default.
   */
  answer: string;
  /** Whether an answer given here will be remembered for the next posting. */
  reusable: boolean;
  /** True when `answer` came out of the saved-answer store rather than being typed just now. */
  remembered: boolean;
};

export type PrescriptResolution = {
  questions: PrescriptQuestion[];
  /** The subset with ask === true, in form order. What the Apply screen shows. */
  ask: PrescriptQuestion[];
};

/**
 * Split a posting's questions into the ones Litos answers and the ones she does.
 *
 * The order of the branches is the safety property, and it is the same order resolveKnownAnswer
 * uses and for the same reason: the self-declaration test runs FIRST, before any classifier, so
 * that no rule further down can reach a question whose answer is a statement about her.
 *
 *   1. A self-declaration with a remembered answer of her own -> filled, and still shown as hers.
 *   2. A self-declaration with nothing remembered -> asked, blank, always. This holds even when
 *      resolveKnownAnswer would have produced a value from a stored profile column, because the
 *      pre-script's job is to put the declaration in front of her; the runner still fills it from
 *      the profile if she leaves it alone, so nothing regresses and she gets the chance to correct
 *      it.
 *   3. Otherwise resolveKnownAnswer decides. A value means Litos has it. A skipReason or a null on
 *      a required field means she is the only one who can answer it.
 *
 * NOTHING IN THIS FUNCTION DRAFTS. There is no LLM here and no path to one. An open-ended question
 * is reported as needing her words; whether a grounded draft is offered for it later is the
 * submission runner's decision, made against the experience bank, and it is deliberately not made
 * on this screen where a drafted paragraph would look like a fact she had supplied.
 */
export function resolvePrescript(
  questions: readonly PostingQuestion[],
  profile: ApplicationProfileLike,
  savedAnswers: ReadonlyMap<string, string>,
  context: { company?: string | null; jdText?: string } = {},
): PrescriptResolution {
  const reuseContext: AnswerReuseContext = { company: context.company };
  const out: PrescriptQuestion[] = [];

  for (const question of questions) {
    const label = question.label;
    const reusable = answerReuseScope(label, reuseContext) === 'reusable';
    const remembered = savedAnswerFor(label, savedAnswers, reuseContext);
    const base = {
      label,
      input_type: question.input_type,
      options: question.options,
      required: question.required,
      max_length: question.max_length,
      reusable,
    };

    if (isSelfDeclarationQuestion(label)) {
      out.push({
        ...base,
        ask: remembered === undefined,
        reason: remembered === undefined ? 'self_declaration' : undefined,
        answer: remembered ?? '',
        remembered: remembered !== undefined,
      });
      continue;
    }

    if (remembered !== undefined) {
      out.push({ ...base, ask: false, answer: remembered, remembered: true });
      continue;
    }

    const known = resolveKnownAnswer(label, question.input_type, profile, context.jdText);
    if (known && 'value' in known) {
      out.push({ ...base, ask: false, answer: known.value, remembered: false });
      continue;
    }

    // Not answerable from anything on file. Optional fields are left alone exactly as the runner
    // leaves them: a form Litos cannot complete is a stall, and a form it merely did not embellish
    // is a submitted application.
    if (!question.required) {
      out.push({ ...base, ask: false, answer: '', remembered: false });
      continue;
    }

    const reason: PrescriptAskReason = (question.options?.length ?? 0) > 0
      ? 'choice_for_you'
      : (isOpenEndedQuestion(label) ? 'needs_your_words' : 'nothing_on_file');
    out.push({ ...base, ask: true, reason, answer: '', remembered: false });
  }

  return { questions: out, ask: out.filter((item) => item.ask) };
}

/**
 * The one-line explanation printed under a question on the Apply screen.
 *
 * Written here rather than in the website so the two paths that refuse a question - this screen and
 * the submission runner's attention reasons - cannot end up describing the same refusal in two
 * different voices.
 */
export function prescriptAskExplanation(reason: PrescriptAskReason, label: string): string {
  switch (reason) {
    case 'self_declaration':
      return selfDeclarationSkipReason(label);
    case 'choice_for_you':
      return 'this employer offers a fixed list of answers and the choice is yours';
    case 'needs_your_words':
      return 'an open question this employer wants in your own words';
    case 'nothing_on_file':
    default:
      return 'the employer requires this and nothing on your profile answers it';
  }
}
