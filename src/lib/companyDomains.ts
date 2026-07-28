/**
 * The employer's own web domain, per company, so a job row can show that employer's logo.
 *
 * WHY A FILE AND NOT A COLUMN
 * ---------------------------
 * The domain is genuinely absent from the system. `career_page_sources.career_url` is the field
 * that looks like it should hold it, and on 2026-07-28 all 51 enabled sources had a JOB BOARD there
 * (`job-boards.greenhouse.io/lyft`, `jobs.ashbyhq.com/linear`) rather than a company site, because
 * that is what a careers URL honestly is for these employers. The `companies` table, which does
 * hold real domains, covered 6 of the 51. So every row fell back to an initial and the logo feature
 * rendered nothing at all.
 *
 * A column was the first instinct and is currently unsafe: this repo changes schema with `db:push`,
 * and `scripts/check-schema-drift.mjs` reports 12 undeclared columns live in production (one of
 * them holding real consent data for 20 users). A push from here would DROP them. This mapping
 * changes about as often as the source list does, is reviewable in a diff, and needs no migration,
 * so it does not have to wait for that to be cleaned up.
 *
 * HOW THESE WERE ESTABLISHED, because a wrong logo is worse than no logo: it tells a job seeker
 * this row is a different company than it is. Nothing here was typed from memory and left at that.
 * Every entry was checked on 2026-07-28 by at least one of:
 *
 *   board backlink  the company's own careers page links to THIS company's board on THIS ATS
 *                   (`ashbyhq.com/linear`). A lookalike domain cannot fake that, and it is what
 *                   caught `linear.app` when a name-similarity check had confidently said
 *                   `linear.io`.
 *   homepage        the domain resolves, answers 2xx, and its <title> or og:site_name names the
 *                   company.
 *   favicon+DNS     the site refuses automated requests (common for fintech), so it was confirmed
 *                   by DNS plus the favicon service returning a real icon rather than its stock
 *                   globe placeholder.
 *
 * The name-similarity check alone was tried first and REJECTED: it accepted `chime.ai` for Chime,
 * `sofi.io` for SoFi, `gusto.ai` for Gusto and `linear.io` for Linear, because any lookalike site
 * mentions the word. Do not reintroduce it.
 *
 * ADDING AN ENTRY: verify it, do not guess it. An unmapped company is not a bug — it falls back to
 * its initial, which is honest and legible. A wrong entry is the only real failure here.
 */

/** Company name exactly as the job board reports it, mapped to the employer's own domain. */
const COMPANY_DOMAINS: Record<string, string> = {
  "Affirm": "affirm.com",                            // homepage
  "Airbnb": "airbnb.com",                            // homepage
  "Airtable": "airtable.com",                        // homepage
  "Amplitude": "amplitude.com",                      // board backlink
  "Anthropic": "anthropic.com",                      // board backlink
  "Asana": "asana.com",                              // homepage
  "Baseten": "baseten.co",                           // board backlink
  "Betterment": "betterment.com",                    // homepage
  "Brex": "brex.com",                                // homepage
  "Carta": "carta.com",                              // board backlink
  "Checkr": "checkr.com",                            // homepage
  "Chime": "chime.com",                              // favicon+DNS
  "Cloudflare": "cloudflare.com",                    // homepage
  "Coinbase": "coinbase.com",                        // favicon+DNS
  "Cursor": "cursor.com",                            // homepage
  "Datadog": "datadoghq.com",                        // homepage
  "Discord": "discord.com",                          // homepage
  "Doximity": "doximity.com",                        // homepage
  "Duolingo": "duolingo.com",                        // homepage
  "Faire": "faire.com",                              // homepage
  "Figma": "figma.com",                              // board backlink
  "Flexport": "flexport.com",                        // homepage
  "Gemini": "gemini.com",                            // homepage
  "GitLab": "gitlab.com",                            // homepage
  "Gusto": "gusto.com",                              // favicon+DNS
  "IMC Trading": "imc.com",                          // homepage
  "Instacart": "instacart.com",                      // homepage
  "Khan Academy": "khanacademy.org",                 // homepage
  "Linear": "linear.app",                            // board backlink
  "Lyft": "lyft.com",                                // homepage
  "Marqeta": "marqeta.com",                          // homepage
  "Match Group": "mtch.com",                         // homepage
  "MongoDB": "mongodb.com",                          // homepage
  "Notion": "notion.so",                             // homepage
  "Palantir": "palantir.com",                        // homepage
  "Perplexity": "perplexity.ai",                     // favicon+DNS
  "Pinterest": "pinterest.com",                      // homepage
  "Point72": "point72.com",                          // homepage
  "Qube Research & Technologies": "qube-rt.com",     // favicon+DNS
  "Ramp": "ramp.com",                                // homepage
  "Reddit": "reddit.com",                            // homepage
  "Render": "render.com",                            // homepage
  "Replit": "replit.com",                            // homepage
  "Robinhood": "robinhood.com",                      // homepage
  "Scale AI": "scale.com",                           // homepage
  "SoFi": "sofi.com",                                // favicon+DNS
  "Stripe": "stripe.com",                            // homepage
  "Supabase": "supabase.com",                        // homepage
  "Twitch": "twitch.tv",                             // homepage
  "Vanta": "vanta.com",                              // homepage
  "Zocdoc": "zocdoc.com",                            // favicon+DNS
};

/**
 * Names are matched loosely enough that "Airbnb, Inc." and "airbnb" find the same employer.
 *
 * The legal suffix is stripped as a TRAILING WORD, before punctuation is removed — order matters.
 * Removing punctuation first turns "Airbnb, Inc." into "airbnbinc", where there is no word boundary
 * left to anchor to, and stripping mid-string would fold "Incentro" into "entro".
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+(inc|llc|ltd|limited|corp|corporation|co|plc|gmbh|sa|ag|bv|pte)\s*$/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const BY_NORMALIZED = new Map(
  Object.entries(COMPANY_DOMAINS).map(([name, domain]) => [normalize(name), domain]),
);

/**
 * The employer's domain, or null when we do not have a verified one.
 *
 * Null is a perfectly good answer and callers must render it as one: the row shows the company's
 * initial instead. Guessing here would be the only way to produce a wrong logo.
 */
export function companyDomainFor(companyName: string | null | undefined): string | null {
  if (!companyName) return null;
  return BY_NORMALIZED.get(normalize(companyName)) ?? null;
}

/** Exported for the test that keeps the map honest. */
export { COMPANY_DOMAINS };
