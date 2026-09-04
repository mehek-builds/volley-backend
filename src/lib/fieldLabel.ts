// Turning a blocked form field into words the student can act on.
//
// R-048, found in live QA 2026-07-23. The blocker line was built as
//   (aria-label ?? name ?? 'required field') + ' is required'
// which produced two unusable outcomes on real portals:
//
//   "required field is required"
//     - the literal fallback string flowed straight into the sentence.
//   "5a326a1d-1a9e-42b1-a918-ca74022064dc is required"
//     - Greenhouse and Ashby name their custom question inputs with UUIDs, so the raw `name`
//       attribute is an opaque token, not a label.
//
// The blocker screen is the entire handoff-to-human surface. A blocker the user cannot identify
// forces them to open the portal manually and defeats the product. The visible <label> is where the
// human-readable text actually lives, so prefer it, and refuse to dress an opaque token up as one.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{12,}$/i;
const NUMERIC_ID_RE = /^[a-z]{0,4}[-_]?\d{5,}$/i;
// Framework-generated handles: question[12], _systemfield_x, cf-1234, job_application[answers][0]
const MACHINE_SHAPE_RE = /^(_|cf[-_]|question\[|job_application\[|answers?\[|field[-_]?\d)/i;
// The same handles after a framework flattens brackets into underscores when rendering the `id`,
// e.g. Rails turning job_application[answers_attributes][0][text_value] into
// job_application_answers_attributes_0_text_value. portalSubmission offers `id` as a candidate, so
// the bracketed form alone was not enough to keep these out of the user's blocker text.
const FLATTENED_HANDLE_RE = /^(job_application|answers?)_|_attributes_|(^|_)\d+(_|$)/i;
// A single unspaced token carrying structural punctuation is a handle, not something a person
// wrote: urn:li:answer:9911, some.nested.path[0]. The punctuation must be INTERNAL (something
// follows it), because a trailing colon is ordinary label decoration: "Degree:" is a label.
const STRUCTURAL_TOKEN_RE = /^\S*[[\]:]\S/;
// customQuestion12345, applicantAnswer42: a long lowerCamel run ending in digits.
const LONG_CAMEL_WITH_DIGITS_RE = /^[a-z]{4,}[A-Z][A-Za-z]*\d+$/;
/* THE TYPE PREFIX A UUID STRIP LEAVES STANDING.
 *
 * Crelate names every custom control `<type>-<uuid>` (short-, number-, yesno-, single-, date-,
 * rating-), so once INLINE_UUID_RE has cleared the uuid out of the concatenated label the handle
 * is a bare word ending in the separator that used to join the two halves. Measured on Blueprint
 * Hires (packet e3a22025, 2026-09-02): the stored question was the single token "yesno-", which
 * the dashboard rendered as a heading with an empty answer box and a disabled Save.
 *
 * A single token ending in a hyphen or underscore is never something a person wrote, so this is
 * positive evidence of a handle rather than an absence of evidence of a label. It is judged only
 * inside the unspaced-token branch below, so a real question that happens to end in a dash
 * ("What is your work status - ") is out of its reach. */
const DANGLING_HANDLE_PREFIX_RE = /^[a-z][a-z0-9]*[-_]$/i;
// Browser fallback prose injected by an icon component when its SVG cannot render. This can sit
// inside a real <label>, but it names no form field and must never become user-facing blocker text.
const PROVIDER_RENDERING_NOISE_RE = /^SVGs?\s+not supported by this browser\.?$/i;

// Generic placeholders providers substitute when THEY could not read a label either. They are
// grammatical English, so no shape rule catches them, but they name nothing: quoting one back
// produces '"required field" is required and is still empty', which is the original R-048 sentence
// wearing quotation marks.
const PLACEHOLDER_LABELS: ReadonlySet<string> = new Set([
  'required field',
  'required',
  'field',
  'this field',
  'input',
  'value',
  'unknown',
  'unnamed field',
  'untitled',
]);

/** True when a string is a machine identifier or a generic placeholder, not a real label. */
export function isOpaqueIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_LABELS.has(trimmed.toLowerCase())) return true;
  if (PROVIDER_RENDERING_NOISE_RE.test(trimmed)) return true;
  if (UUID_RE.test(trimmed)) return true;
  if (LONG_HEX_RE.test(trimmed)) return true;
  if (NUMERIC_ID_RE.test(trimmed)) return true;
  if (MACHINE_SHAPE_RE.test(trimmed)) return true;
  // Unspaced tokens only: a real label may contain a colon ("Degree: ") or digits, and must not be
  // judged by rules written for identifiers.
  if (!/\s/.test(trimmed)) {
    if (FLATTENED_HANDLE_RE.test(trimmed)) return true;
    if (STRUCTURAL_TOKEN_RE.test(trimmed)) return true;
    if (LONG_CAMEL_WITH_DIGITS_RE.test(trimmed)) return true;
    if (DANGLING_HANDLE_PREFIX_RE.test(trimmed)) return true;
  }
  // No letters in ANY script. \p{L} rather than [a-z]: an ASCII-only test classified every
  // non-Latin label as a machine id, so a localised Greenhouse or Ashby posting told the student
  // "no label Litos can read" while 姓名, Фамилия or الاسم sat right there on the form.
  if (!/\p{L}/u.test(trimmed)) return true;
  // A "single token with no vowel is machine-generated" rule was tried here and removed. It is
  // wrong far too often on real forms: "CV", "SSN", "PhD" and "MD" are all legitimate labels with
  // no vowel, and suppressing one costs the user the name of the very field blocking their
  // application. Every rule above keys on positive evidence of a machine identifier; absence of a
  // vowel is not that. When in doubt, show the label.
  return false;
}

/* ---------------------------------------------------------------------------------------------
 * THE CONTROL'S OWN name AND id, TRAILING THE EMPLOYER'S QUESTION.
 *
 * Discovery names a control by concatenating everything that might be its label, and the last two
 * parts of that join are the control's `name` and `id` attributes (see the `parts` join in the
 * managed runner's questionLabel). On a control that carries NO written label those handles are
 * all there is, and the existing PROVIDER_HANDLE_STRIPPERS already reduce that case to nothing.
 * On a control that DOES carry a written label the handles are simply welded onto the end of a
 * perfectly good question, and nothing removed them. Measured live on account
 * a18f774b-a306-4804-93f3-cd6020c27fb3, 2026-09-02, four boards:
 *
 *   personio, xolife       "available from* (required) available_from field-available_from"
 *   personio, xolife       "expected salary* (required) salary_expectations field-salary_expectations"
 *   pinpoint, Confluence   "phone application_form[application][phone] application_form_application_phone"
 *   teamtailor, TixTrack   "cover letter* required candidate[job_applications_attributes][0][cover_letter]
 *                           candidate_job_applications_attributes_0_cover_letter"
 *
 * Every one of those is a real question the applicant was shown with a machine handle glued to it.
 *
 * THE SAFETY INVARIANT: THE STRIP ONLY EVER RUNS WHEN IT LEAVES TEXT BEHIND. If removing the
 * trailing run would empty the label, the strip is abandoned and the original stands unchanged. So
 * this can never turn a readable question into an unreadable one, and it can never disagree with
 * isProviderHandleOnly: a label the page script calls handle-only is one this module already
 * normalizes to '', and a label with words in front of its handles is one neither of them touches
 * the verdict on. That is why nothing here is added to PROVIDER_HANDLE_STRIPPERS, whose list is
 * shared verbatim with the page script and whose two halves have to keep agreeing.
 *
 * UNDERSCORE IS MACHINE, HYPHEN IS HUMAN, and that asymmetry is the whole reason the generic slug
 * shape accepts only `_`. "self-employed", "part-time" and "e-mail" are words a person writes and
 * routinely end a real question; `available_from` and `salary_expectations` are not. A hyphenated
 * handle is recognised only behind an explicit `field-` prefix, or on the positive evidence below.
 *
 * BOUNDED, because an unbounded text rule is how a consent paragraph becomes a question: at most
 * MAX_TRAILING_HANDLE_TOKENS tokens are removed (a `name` and an `id` is two, and a flattened id
 * can split into no more), and a token longer than MAX_HANDLE_TOKEN_LENGTH is prose, not a handle.
 */
const MAX_TRAILING_HANDLE_TOKENS = 4;
const MAX_HANDLE_TOKEN_LENGTH = 200;
const FORM_ATTRIBUTE_HANDLE_SHAPES: readonly RegExp[] = [
  // A bracketed attribute path: application_form[application][phone], candidate[job_application][cover_letter]
  /^[a-z][a-z0-9_]*(?:\[[a-z0-9_.-]*\])+$/i,
  // An explicitly field-prefixed slug, which is the one place a hyphen is trusted: field-available_from
  /^field[-_][a-z0-9]+(?:[-_][a-z0-9]+)*$/i,
  // A bare snake_case slug: available_from, salary_expectations, application_form_application_phone
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i,
  // The type prefix a uuid strip leaves standing: "enter a number number-", "maximum 400 characters short-"
  /^[a-z][a-z0-9]*[-_]$/i,
];
/* HANDLES THAT ARE READ BACK OUT OF THE STORED LABEL, and so must survive it.
 *
 * managedOptionProbeControlId recovers a control id from the label when the provider addressed the
 * element by data attribute and left no selector to read, and on the stored-question path that
 * label is this one, already normalized. Greenhouse's five self-identification controls are named
 * by exactly the snake_case shape above ("are you hispanic/latino? hispanic_ethnicity"), so
 * stripping them would silently skip the option probe for gender, ethnicity, veteran and
 * disability status, which is the defect PR #428's plumbing exists to prevent. Kept as the same
 * explicit five-id ATS-family fact portalSubmission states, not as a pattern.
 *
 * The other recoverable shapes need no entry here: `discipline--0` and `question_12` are already
 * gone before this runs, and a trailing six-digit id matches none of the shapes above. */
const LABEL_RECOVERABLE_CONTROL_HANDLES = /^(?:gender|hispanic_ethnicity|veteran_status|disability_status|race)$/i;
const HYPHENATED_SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i;

const comparableWords = (value: string): string => ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * Whether one trailing token is the control's handle rather than a word of the question.
 *
 * `preceding` is everything to the left of the token, and it is read for ONE purpose: a hyphenated
 * slug is trusted as a handle only when the words it spells are ALREADY IN THE LABEL. Pinpoint's
 * optional summary is stored as "personal summary this section is optional. use it to tell us a
 * little more about yourself. application_form[application][summary] personal-summary", where
 * `personal-summary` is the id and repeats the heading verbatim, and where refusing every
 * hyphenated token also stranded the bracketed `name` behind it. "are you currently self-employed"
 * has no "self employed" anywhere to its left, so the word stays and the walk stops there. The
 * evidence is what separates the two; shape alone cannot.
 */
function tokenIsFormAttributeHandle(token: string, preceding: readonly string[]): boolean {
  if (FORM_ATTRIBUTE_HANDLE_SHAPES.some((shape) => shape.test(token))) return true;
  if (!HYPHENATED_SLUG_RE.test(token)) return false;
  return comparableWords(preceding.join(' ')).includes(comparableWords(token.split('-').join(' ')));
}

function stripTrailingFormAttributeHandles(value: string): string {
  const tokens = value.split(' ').filter(Boolean);
  let kept = tokens.length;
  while (kept > 0) {
    const token = tokens[kept - 1] as string;
    if (token.length > MAX_HANDLE_TOKEN_LENGTH) break;
    if (LABEL_RECOVERABLE_CONTROL_HANDLES.test(token)) break;
    if (!tokenIsFormAttributeHandle(token, tokens.slice(0, kept - 1))) break;
    kept -= 1;
    /* A RUN LONGER THAN THE CAP IS TRUSTED NOT AT ALL, rather than trimmed back to the cap.
     *
     * Trimming to the cap was the first shape and it was wrong twice over. It made this function
     * NON-IDEMPOTENT, because the tokens the cap refused came off on the next application, and
     * normalizeDiscoveredLabel is applied once at mint and again on every stored read: the label
     * discovery wrote was not the label any later read produced, which is exactly the packet
     * identity drift #902 closed for the repeat collapse. It was also the more aggressive reading
     * of an anomalous string, in a file whose whole rule is to leave text alone when the evidence
     * runs out. A `name` and an `id` is two tokens and every measured join is two; a run of five is
     * not a handle join this function understands, so it declines the whole thing.
     *
     * This is what keeps the total bound at four even though the normalizer now iterates: a run of
     * four or fewer comes off in one pass and leaves no handle for the next, and a longer run is
     * refused identically on every pass. So iterating cannot eat another four. */
    if (tokens.length - kept > MAX_TRAILING_HANDLE_TOKENS) return value;
  }
  // Nothing but handles: the label is left exactly as it was. A single meaningful attribute name is
  // often the only thing naming a core identity control ("first_name", "linkedin_url"), and
  // isCoreIdentityField and classifyField both read it off this string.
  if (kept === 0 || kept === tokens.length) return value;
  return tokens.slice(0, kept).join(' ');
}

/**
 * The employer's question with the control's own `name` and `id` taken off the end of it.
 *
 * IDEMPOTENT, and that is load-bearing rather than tidiness. A stored question is normalized again
 * on every read, so a strip that moved a label it had already produced would make the minted label
 * and the read-back label two different questions to every comparison keyed on the employer's
 * words, including the one deciding whether the packet about to be filled is the packet she
 * approved. The all-or-nothing cap above is what buys it: a trusted run comes off whole, and an
 * untrusted one is refused identically every time.
 *
 * Called by the two human-facing label surfaces: normalizeDiscoveredLabel for the stored question
 * text, and humanFieldLabel for the blocker sentence, which keeps the two saying the same words
 * about the same control. It is NOT folded into tidyLabel, so that tidyLabel stays purely about
 * decoration and each surface applies the strip explicitly.
 *
 * normalizeDiscoveredLabel has to run it BEFORE collapseRepeatedLabel. Personio stores "phone phone
 * field-phone" and "location location field-location": that is one label rendered twice with the id
 * behind it, and collapseRepeatedLabel halves on an EVEN word count, so the handle made the count
 * three and the doubled label survived into the stored question.
 */
export function stripFormAttributeHandles(value: string): string {
  return stripTrailingFormAttributeHandles(value.replace(/\s+/g, ' ').trim());
}

/**
 * Collapse whitespace and strip the decoration portals hang off required labels.
 *
 * THE ORDER IS THE FIX, not iteration. The original removed a trailing "*" BEFORE it removed a
 * trailing "(required)", so a label carrying both came out still wearing the asterisk: personio's
 * "available from* (required)" tidied to "available from*". Removing the parenthesised marker first
 * settles both in one pass. An earlier cut wrapped this in a loop as well, and a review measured
 * that the loop was doing nothing that the reordering had not already done, so it is gone rather
 * than left standing untested. normalizeDiscoveredLabel iterates the whole chain around this.
 */
export function tidyLabel(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\(required\)$/i, '')
    /* A BARE "required" ONLY BEHIND THE EMPLOYER'S OWN ASTERISK. Teamtailor renders the marker as
     * "Cover letter* Required", and the asterisk is the evidence that the word is a chip rather
     * than prose. Without that evidence the word stays: "is a visa required" is a question. */
    .replace(/\*\s*required[\s.:]*$/i, '')
    .replace(/[\s*:]+$/g, '') // trailing "*", ":" and the space before them
    .replace(/^[\s*]+/, '')
    .trim();
}

/**
 * The first candidate that reads like something a person wrote, in the caller's order of
 * preference. Returns null when every candidate is opaque or empty, so the caller can say so
 * honestly instead of inventing a name.
 */
export function humanFieldLabel(candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    /* The blocker sentence and the stored question have to name the control the same way, or the
     * dashboard shows '"available from* (required) available_from field-available_from" is required
     * and is still empty' beside a row it has already cleaned up to "Available from" and treats them
     * as two different pieces of work. */
    const tidy = tidyLabel(stripFormAttributeHandles(candidate));
    if (!tidy || isOpaqueIdentifier(tidy)) continue;
    return tidy.length > 120 ? `${tidy.slice(0, 117)}...` : tidy;
  }
  return null;
}

/**
 * The user-facing blocker sentence. Never emits "required field is required", and never shows a
 * UUID: an unnamed field is described by what the user can use to find it instead.
 */
export function describeRequiredBlocker(label: string | null, hint?: { type?: string | null }): string {
  if (label) return `"${label}" is required and is still empty`;
  const kind = hint?.type && !isOpaqueIdentifier(hint.type) ? `${hint.type} ` : '';
  return `A required ${kind}field on the form has no label Litos can read, and is still empty`;
}

/**
 * One line for however many unlabelled required fields were found. These all produce an identical
 * sentence, so deduping them as strings collapsed five blocked fields into one and the student
 * would fix the single named thing, resubmit, and fail again learning nothing. The count is the
 * information: it tells them how many times to look.
 */
export function describeUnlabelledBlockers(count: number): string {
  if (count === 1) return describeRequiredBlocker(null);
  return `${count} required fields on the form have no label Litos can read, and are still empty`;
}

/**
 * Last line of defence on blocker text, applied to whatever a browser provider hands back.
 *
 * The managed provider does its own field scanning in a separate service and returns finished
 * sentences, so it never touches the label resolution above. Live QA against a real Ashby posting
 * proved that: the dashboard showed three raw UUIDs after every other part of this fix had shipped.
 * The user must never see a machine identifier no matter which provider produced the run, and this
 * repo cannot assume it controls every one of them, so the sanitizing happens where the strings
 * enter: any "<opaque token> is required" line becomes the unlabelled description, those are
 * counted rather than repeated, and human-readable lines (a CAPTCHA notice, a real field name) pass
 * through untouched.
 */
export function sanitizeProviderBlockers(blockers: readonly string[]): string[] {
  const readable: string[] = [];
  let unlabelled = 0;

  for (const rawLine of blockers.flatMap((raw) => (typeof raw === 'string' ? raw.split(/\r?\n/) : []))) {
    const line = rawLine.trim();
    if (!line) continue;

    // Providers return both the short sentence and Litos's already-canonical blocker sentence.
    // Accept matching quote pairs so a second sanitize pass does not keep the quotes as label text.
    const match = line.match(/^(?:"([^"]+)"|'([^']+)'|(.*?))\s+is required(?:\s+and is still empty)?\.?$/i);
    if (match) {
      const label = humanFieldLabel([match[1] ?? match[2] ?? match[3]]);
      if (label) readable.push(describeRequiredBlocker(label));
      else unlabelled += 1;
      continue;
    }

    // Not a required-field line. Keep it, but never let a bare identifier through as prose.
    if (isOpaqueIdentifier(line)) {
      unlabelled += 1;
      continue;
    }
    readable.push(line);
  }

  const deduped = [...new Set(readable)];
  if (unlabelled > 0) deduped.push(describeUnlabelledBlockers(unlabelled));
  return deduped;
}
