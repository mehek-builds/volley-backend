/* ONE DEFINITION OF "THE SAME COMPANY", because two would drift.
 *
 * This is lib/duplicateApplication.ts's own `normalizeText`, moved rather than copied. It is the
 * company half of that file's `company_role` tier - the rule that already decides, on production
 * rows, whether two packets are for the same employer - and it now also decides whether Litos'
 * history shows an application already at the employer a prior-application question is asking
 * about (see previouslyAppliedAnswer in lib/questionDiscovery.ts).
 *
 * It lives here rather than in duplicateApplication.ts so that the resolver can use it without
 * importing a module that opens a database pool at load. questionDiscovery.ts is deliberately free
 * of `db`, and a question-answering rule is not a reason to change that.
 *
 * Case and punctuation are folded, and nothing else is. Equality on the folded string is EXACT,
 * which is the whole property the rule needs: "IMC", "IMC Trading" and "Imcorp" are three
 * identities here, not one. A substring or prefix test collapses them, and the collapse is not
 * cosmetic - it answers a live employer's question from a different company's history, which is
 * exactly the confidently wrong answer this codebase keeps deleting.
 */
export function companyIdentity(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
}

/**
 * Whether two employer names, however each of them was written, name the same company.
 *
 * An unreadable or empty name on either side is never a match. "No company recorded" must not
 * become "the same company as every other packet with no company recorded".
 */
export function isSameCompany(left: unknown, right: unknown): boolean {
  const identity = companyIdentity(left);
  return identity.length > 0 && identity === companyIdentity(right);
}
