import type { UserDocumentKind } from './documentStore';

/* WHICH DOCUMENT THE EMPLOYER ASKED FOR, DERIVED FROM ITS OWN WORDS, AS A STRUCTURED FACT.
 *
 * THIS EXISTS BECAUSE `attention_categories` CANNOT BE THE TRIGGER. The obvious way to draw a
 * "she still owes this form a transcript" row is to branch on
 * `attention_categories.includes('required_document')`, and that category is wrong in two
 * independent directions, both measured off this repo rather than guessed at:
 *
 *   1. The classifier that writes it, lib/submissionTerminalCause.ts, matched the bare substring
 *      `file`, with no word boundary. `"LinkedIn Profile" is required and is still empty` therefore
 *      classified as required_document, because `profile` contains `file`. Every packet stopped on
 *      an empty LinkedIn field would have drawn an upload row for a document nobody asked for.
 *   2. withholdInvalidLeadAlignment (routes/submissionRunner.ts:227) writes
 *      `attention_categories: ['required_document']` for a resume lead-experience alignment
 *      failure, which has nothing to do with documents at all. No regex fix reaches that one: the
 *      category is simply being used as a generic "held back" marker there.
 *
 * The first is repaired alongside this module so the counts are right. Neither repair is enough to
 * make the category safe to render a control off, because the category answers "roughly what sort
 * of stop was this" and the screen needs "which file, named how, and does it have to be sealed".
 * So the screen reads what this module returns, and the category is left to the counting it was
 * built for.
 *
 * WORD BOUNDARIES, EVERYWHERE, WITHOUT EXCEPTION. That is the one rule this file has. Every
 * false positive worth naming in this problem is a substring match: `file` inside `profile`,
 * `official` inside `unofficial`. A pattern added here without \b on both ends is the defect
 * coming back.
 */

/* The kind is the storage key, not a description. `spec._documents` is keyed by it and
 * user_documents.kind holds it, so an ask whose kind is not one this product can store is an ask
 * with nowhere to put the answer: a row on the dashboard that opens a modal that cannot serve it.
 * Typed off documentStore's union on purpose, so a kind can never be invented here that the store
 * would refuse. Type-only import: nothing at runtime, so this module stays free of the database and
 * the blob client and can be unit tested as the pure function it is. */
export type RequiredDocumentAsk = {
  /* The employer's own label for the control, as close to verbatim as anything upstream still
   * holds. See REQUIRED_DOCUMENT_LABEL_MAX_LENGTH for what has already happened to it. */
  label: string;
  kind: UserDocumentKind;
  /* The label asked for an OFFICIAL copy, meaning one a registrar sends under seal. Litos cannot
   * produce that and must not pretend otherwise; this is what turns the ask into the variant that
   * offers "I've ordered it" instead of only an upload. */
  official_requested: boolean;
};

/* 200, and the number is a payload budget rather than a display choice.
 *
 * This value rides inside `_review` on generated_resumes.spec, and GET /resume/history returns the
 * whole spec for up to fifty rows (routes/resume.ts). db/schema.ts:1122 records that a board list
 * query has already exhausted Neon's 5 GB monthly transfer ceiling once. Nothing large belongs in
 * here: no bytes, no URL, and no employer paragraph.
 *
 * The label has usually been clipped twice before it arrives, and this is the honest account of
 * what a screen may promise about it. A blocker-derived label passed humanFieldLabel
 * (lib/fieldLabel.ts:99), which caps at 120 and appends a literal ellipsis; a question-derived one
 * passed normalizeReviewQuestionLabel, which caps at 500. The original text is not stored anywhere
 * recoverable. So this is a name for the thing, not a quotation of the form, and no copy may claim
 * it is quoting the employer. */
export const REQUIRED_DOCUMENT_LABEL_MAX_LENGTH = 200;

/* The vocabulary a transcript ask is allowed to be recognised by, and deliberately nothing wider.
 *
 * Absent from this list on purpose: `document`, `upload`, `attach`, `file`, `record`. Those are the
 * words that made the attention category unusable. A form's "Additional documents" control is a
 * real required upload and this will not match it, which is the correct answer today: Litos stores
 * one kind of document, so an ask it cannot name is an ask it cannot serve, and drawing a transcript
 * row for it would be a guess wearing a control.
 *
 * `academic record` and `grade report` are here because they are what a transcript is called on
 * forms that avoid the word; `marksheet` because it is what it is called on South Asian forms, which
 * is most of the international student population this product is for. */
const TRANSCRIPT_ASK = /\b(?:transcripts?|marks?\s?sheets?|academic\s+records?|grade\s+reports?)\b/i;

/* \b in front of `official` is not decoration, it is the whole test.
 *
 * `/official/i` matches inside `unofficial`, and "unofficial transcript" is the single most common
 * phrasing a US student meets on an application form. Without the boundary this flips true on
 * exactly the labels that mean the opposite, and the screen offers a registrar-order flow to
 * someone whose employer explicitly said a downloaded copy is fine. `\bofficial\b` does not match
 * `unofficial`, because the position before `o` sits between two word characters.
 *
 * Residual, stated rather than papered over: a label reading "official or unofficial transcript"
 * answers true here. That errs toward showing the extra "I've ordered it" option, which is additive
 * and costs a student nothing; erring the other way hides the only honest answer available to
 * someone who cannot upload a sealed file. */
const OFFICIAL_ASK = /\bofficial\b/i;

function clipLabel(label: string): string {
  if (label.length <= REQUIRED_DOCUMENT_LABEL_MAX_LENGTH) return label;
  return `${label.slice(0, REQUIRED_DOCUMENT_LABEL_MAX_LENGTH - 3)}...`;
}

function documentKindForLabel(label: string): UserDocumentKind | null {
  if (TRANSCRIPT_ASK.test(label)) return 'transcript';
  return null;
}

/**
 * The document asks in a set of employer labels, at most one per kind.
 *
 * Input is whatever the run measured as required and unanswerable: the labels lifted out of the
 * portal's own "is required and is still empty" blockers, and the labels of required file questions
 * the discovery pass recorded. Both arrive as plain strings and neither is trusted to be tidy,
 * unique, or non-empty.
 *
 * ONE ASK PER KIND, and that is a narrowing beyond deduplicating the labels. A form carrying both
 * "Official transcript" and "Unofficial transcript (PDF)" is one file, asked for twice, and both
 * rows would write the same `spec._documents.transcript` key. She attaches the file, one row
 * clears, and the second keeps asking for something she has already given with no control left that
 * can clear it. That is the shape of defect this codebase has unwound twice; one row per kind is
 * the version that can actually reach done. The first label seen names the row, and
 * official_requested is true if ANY label for that kind asked for a sealed copy.
 *
 * CLASSIFY ON THE WHOLE LABEL, CLIP ONLY WHAT IS STORED, and in that order. Clipping first is the
 * obvious way to write this and it is wrong: a question label may run to five hundred characters
 * and put the word "transcript" at the end of them, so a clip applied before the match reads
 * "Please upload your most recent ... transcript" as naming no document at all. The clip is a
 * payload budget, never a decision.
 */
/* What one application already carries for one kind, as the two decisions below need to read it.
 *
 * Structural rather than documentStore's AttachedDocument, so this module stays a pure function of
 * its arguments with no database, no blob client and no import cycle: documentStore already imports
 * nothing from here and must go on being able to. */
export type DocumentMark = { attached_at?: string | null; ordered_at?: string | null };

/* The measured capability, per kind, out of the review state.
 *
 * TRI-STATE, AND ONLY `false` IS AN ANSWER. `undefined` is every packet prepared before the
 * measurement existed, and every kind nothing has measured; reading unknown as "no control" would
 * refuse a form that was perfectly able to take the file. Same discipline as cover_letter_required.
 *
 * A LOOKUP RATHER THAN A FIELD READ, because the wire field is named for one kind while asks are a
 * list of kinds. A second document type is a second field and one more arm; until then every other
 * kind is honestly unmeasured. The website's submission-checklist.ts holds the identical function
 * for the identical reason, and the two have to agree: this one decides what the run attaches, that
 * one decides what the screen says about it. */
export function documentControlSupported(
  review: { transcript_supported?: boolean },
  kind: UserDocumentKind,
): boolean | undefined {
  return kind === 'transcript' ? review.transcript_supported : undefined;
}

/**
 * The asks a stored file could answer without asking her a second time.
 *
 * An ask qualifies when this application carries NO RECORD AT ALL for the kind. Not "no file": no
 * record. A mark exists only because she did something - attached a file, or pressed "I've ordered
 * it" - and reuse must never overwrite either answer. Attaching over an attachment would replace a
 * file she chose with one she did not; attaching over an order would quietly answer a question she
 * had already answered differently.
 *
 * A FORM WITH NO CONTROL IS NOT REUSED INTO. `transcript_supported === false` means the run looked
 * for somewhere to put the file and found nothing, so recording an attachment there would write down
 * that this employer is getting the transcript when nothing on either send path can deliver it. The
 * ask stays outstanding and the screen says why, which is the honest state. `undefined` reuses,
 * because unmeasured is not "no".
 */
export function documentAsksOpenToReuse(
  review: { required_documents?: RequiredDocumentAsk[]; transcript_supported?: boolean },
  documents: Readonly<Record<string, DocumentMark>>,
): RequiredDocumentAsk[] {
  return (review.required_documents ?? []).filter((ask) => (
    documentControlSupported(review, ask.kind) !== false && !documents[ask.kind]
  ));
}

/**
 * The asks this application is held on that no upload can clear.
 *
 * TWO CAUSES, ONE CONSEQUENCE. The employer's form has no control Litos can fill, or she has told
 * Litos her registrar is sending a sealed copy. Either way there is nothing left for Litos to do and
 * nothing left for her to press, and until this existed the application simply sat at
 * ready_for_final_approval with a permanently grey Send button and no control on the screen that
 * could finish it - while the modal that put it there said "This application then finishes with you
 * rather than with Litos."
 *
 * This is the gate on the route that records that finish. It is deliberately narrow: an ask she can
 * still satisfy by attaching a file is NOT here, because that application has a working door already.
 */
export function documentAsksLitosCannotResolve(
  review: { required_documents?: RequiredDocumentAsk[]; transcript_supported?: boolean },
  documents: Readonly<Record<string, DocumentMark>>,
): RequiredDocumentAsk[] {
  return (review.required_documents ?? []).filter((ask) => {
    if (documentControlSupported(review, ask.kind) === false) return true;
    const mark = documents[ask.kind];
    return Boolean(mark?.ordered_at) && !mark?.attached_at;
  });
}

export function requiredDocumentAsks(labels: readonly string[]): RequiredDocumentAsk[] {
  const seenLabels = new Set<string>();
  const byKind = new Map<UserDocumentKind, RequiredDocumentAsk>();

  for (const raw of labels) {
    if (typeof raw !== 'string') continue;
    const label = raw.replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);

    const kind = documentKindForLabel(label);
    if (!kind) continue;

    const official = OFFICIAL_ASK.test(label);
    const existing = byKind.get(kind);
    if (existing) {
      existing.official_requested = existing.official_requested || official;
      continue;
    }
    byKind.set(kind, { label: clipLabel(label), kind, official_requested: official });
  }

  return [...byKind.values()];
}
