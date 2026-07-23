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

/** Collapse whitespace and strip the decoration portals hang off required labels. */
export function tidyLabel(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s*:]+$/g, '') // trailing "*", ":" and the space before them
    .replace(/^[\s*]+/, '')
    .replace(/\s*\(required\)$/i, '')
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
    const tidy = tidyLabel(candidate);
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

  for (const raw of blockers) {
    const line = typeof raw === 'string' ? raw.trim() : '';
    if (!line) continue;

    // The shape every provider uses for a missing required field: "<something> is required".
    const match = line.match(/^(.*?)\s+is required\.?$/i);
    if (match) {
      const label = humanFieldLabel([match[1]]);
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
