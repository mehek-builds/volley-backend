// Shared "does this claim trace back to the student's real data" helpers, used by the resume
// validator (engine/resumeValidate.ts) and the application-answer drafter (llm/applicationAnswer.ts).
// The product's hard rule (Mehek's #1 promise): never output an org, title, or number the student
// didn't actually provide. These functions turn that promise into deterministic checks instead of
// trusting the model prompt alone.

const STOPWORDS = new Set(
  `the and for with you your our are will from that this have they their who whom able strong good
using use used per via etc into across within a an of to in on at by as is be we i my me it its
also however than then them these those about when while after before`
    .split(/\s+/)
    .filter(Boolean),
);

// Content words (lowercased, stopwords + very short tokens removed). Used for org/title/proper-noun
// grounding by set membership.
export function wordSet(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9+#.&/-]*/g) ?? []) as string[];
  return new Set(
    words
      .map((w) => w.replace(/[.+#&/-]+$/g, ''))
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w)),
  );
}

// A "metric" number: something quantitative, not an incidental digit inside an identifier. Matches
// $-amounts, k/m/b/x/% suffixed numbers (commas allowed), and bare 2+ digit numbers or decimals
// (commas allowed, so "40,000" is captured whole - not clipped to "40"). The leading lookbehind
// rejects digits glued to letters (S3, EC2, GPT-4-style tokens) so tech names aren't mistaken for
// fabricated metrics. Single bare digits (1-9) are ignored on purpose (too noisy to be a
// meaningful fabrication signal).
// The k/m/b/x/% suffix must be attached (no space) and not part of a longer word - otherwise
// "40,000 ms" would swallow the "m" of "ms" as a millions suffix.
const METRIC_NUMBER_RE =
  /(?<![a-z0-9])(?:\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?(?:k|m|b|x|%)(?![a-z])|\d[\d,]*\d(?:\.\d+)?|\d+\.\d+)\+?/gi;

// Every comparable signature of a single number string. "40K", "40,000" and "40000" all reduce to
// the same expanded signature, so a grounded number written one way still matches its source
// written another way.
function signaturesOf(raw: string): string[] {
  const t = raw.toLowerCase().replace(/[$,\s]/g, '').replace(/\+$/, '');
  if (!/\d/.test(t)) return [];
  const sigs = [t]; // raw normalized form, e.g. "40k", "25%", "3x"
  // Only unit-less numbers and k/m/b magnitudes expand to a comparable integer ("40k" <-> "40000").
  // A percentage or multiplier is a distinct quantity from a bare count: "25%" must NOT be treated
  // as grounded by "a team of 25", and "3x" must not be grounded by "3 projects". So we skip the
  // integer expansion when the token carries a % or x unit (the exact "25%"/"3x" form still has to
  // appear in the source to ground).
  if (!/[%x]$/.test(t)) {
    const m = t.match(/^(\d+\.?\d*)(k|m|b)?$/);
    if (m) {
      let val = parseFloat(m[1]);
      if (m[2] === 'k') val *= 1e3;
      else if (m[2] === 'm') val *= 1e6;
      else if (m[2] === 'b') val *= 1e9;
      if (Number.isFinite(val)) sigs.push(String(Math.round(val)));
    }
  }
  return sigs;
}

// The set of numeric signatures present in a source corpus (experience bank text, JD, etc.).
export function numberSignatures(text: string): Set<string> {
  const sigs = new Set<string>();
  for (const raw of text.match(METRIC_NUMBER_RE) ?? []) {
    for (const s of signaturesOf(raw)) sigs.add(s);
  }
  return sigs;
}

// The metric numbers in `generated` whose signatures are NOT present in `sourceSignatures`.
// Empty result = every number is grounded in the source.
export function ungroundedNumbers(generated: string, sourceSignatures: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of generated.match(METRIC_NUMBER_RE) ?? []) {
    const sigs = signaturesOf(raw);
    const grounded = sigs.some((s) => sourceSignatures.has(s));
    if (!grounded) out.push(raw.trim());
  }
  return out;
}

// Sentence/pronoun capitalization that isn't an organization or proper noun of interest.
const COMMON_CAPS = new Set(
  `I A The A An My Our We You Your This That It Its They Their As At In On Of To With For And But So
After Before When While Also However Here There If Then Because During Since Given Building Working
Using Leading Since`.split(/\s+/),
);

// Best-effort proper-noun grounding for free-text essays: capitalized multi-word phrases (or
// all-caps acronyms) whose content words don't appear in the corpus. Heuristic, so callers treat
// the result as review WARNINGS, never a hard block - it can over-flag legitimate phrasing.
export function ungroundedProperNouns(text: string, corpus: Set<string>): string[] {
  const found = new Set<string>();
  const re = /\b([A-Z][a-zA-Z0-9&.]+(?:\s+[A-Z][a-zA-Z0-9&.]+){0,3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const phrase = m[1];
    const words = phrase.split(/\s+/);
    const isAcronym = words.length === 1 && /^[A-Z]{2,}$/.test(words[0]);
    // Only consider multi-word Capitalized phrases and standalone all-caps acronyms; a single
    // ordinary Capitalized word is almost always sentence-initial, not an org.
    if (words.length < 2 && !isAcronym) continue;
    const contentWords = words.filter((w) => !COMMON_CAPS.has(w));
    if (contentWords.length === 0) continue;
    const allGrounded = contentWords.every((w) => corpus.has(w.toLowerCase().replace(/[.&]/g, '')));
    if (!allGrounded) found.add(phrase);
  }
  return [...found];
}
