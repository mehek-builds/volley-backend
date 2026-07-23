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

/** True when a string is a machine identifier rather than something a person wrote. */
export function isOpaqueIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (UUID_RE.test(trimmed)) return true;
  if (LONG_HEX_RE.test(trimmed)) return true;
  if (NUMERIC_ID_RE.test(trimmed)) return true;
  if (MACHINE_SHAPE_RE.test(trimmed)) return true;
  // No letters at all, or a single token with no vowel: "xyzzt", "1234". Real labels have words.
  if (!/[a-z]/i.test(trimmed)) return true;
  if (!trimmed.includes(' ') && !/[aeiou]/i.test(trimmed)) return true;
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
