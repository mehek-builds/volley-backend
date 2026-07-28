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
  "Abridge": "abridge.com",
  "Adyen": "adyen.com",
  "Affirm": "affirm.com",
  "Airbnb": "airbnb.com",
  "Airtable": "airtable.com",
  "Alloy": "alloy.com",
  "Amplitude": "amplitude.com",
  "anomalo": "anomalo.com",
  "Anthropic": "anthropic.com",
  "Anyscale": "anyscale.com",
  "aptoslabs": "aptoslabs.com",
  "AQR": "aqr.com",
  "Asana": "asana.com",
  "atlan": "atlan.com",
  "attio": "attio.com",
  "Baseten": "baseten.co",
  "betterhelp": "betterhelp.com",
  "Betterment": "betterment.com",
  "binalyze": "binalyze.com",
  "bishopfox": "bishopfox.com",
  "bitgo": "bitgo.com",
  "Blend": "blend.com",
  "blueconic": "blueconic.com",
  "Braze": "braze.com",
  "Brex": "brex.com",
  "btgpactual": "btgpactual.com",
  "buildkite": "buildkite.com",
  "Calendly": "calendly.com",
  "calm": "calm.com",
  "Carta": "carta.com",
  "causaly": "causaly.com",
  "Cerebras": "cerebras.com",
  "Checkr": "checkr.com",
  "Chime": "chime.com",
  "circleci": "circleci.com",
  "Clickhouse": "clickhouse.com",
  "Cloudflare": "cloudflare.com",
  "Coder": "coder.com",
  "Coinbase": "coinbase.com",
  "consensys": "consensys.com",
  "cresta": "cresta.com",
  "crisp": "crisp.com",
  "cultureamp": "cultureamp.com",
  "curative": "curative.com",
  "Cursor": "cursor.com",
  "Datadog": "datadoghq.com",
  "datafold": "datafold.com",
  "Deepgram": "deepgram.com",
  "Discord": "discord.com",
  "Disney": "disney.com",
  "doppel": "doppel.com",
  "Doppler": "doppler.com",
  "Doximity": "doximity.com",
  "dremio": "dremio.com",
  "Dropbox": "dropbox.com",
  "Duolingo": "duolingo.com",
  "elationhealth": "elationhealth.com",
  "elicit": "elicit.com",
  "evervault": "evervault.com",
  "Faire": "faire.com",
  "Figma": "figma.com",
  "fireblocks": "fireblocks.com",
  "Fivetran": "fivetran.com",
  "Flexport": "flexport.com",
  "Flow Traders": "flowtraders.com",
  "found": "found.com",
  "freenome": "freenome.com",
  "Gemini": "gemini.com",
  "GitLab": "gitlab.com",
  "gorgias": "gorgias.com",
  "graphcore": "graphcore.com",
  "Gusto": "gusto.com",
  "Harvey": "harvey.ai",
  "Hightouch": "hightouch.com",
  "IMC Trading": "imc.com",
  "imply": "imply.com",
  "Infisical": "infisical.com",
  "inkeep": "inkeep.com",
  "Inngest": "inngest.com",
  "Instacart": "instacart.com",
  "ionq": "ionq.com",
  "Jane Street": "janestreet.com",
  "jfrog": "jfrog.com",
  "Jump Trading": "jumptrading.com",
  "Khan Academy": "khanacademy.org",
  "Klaviyo": "klaviyo.com",
  "komodohealth": "komodohealth.com",
  "kustomer": "kustomer.com",
  "LangChain": "langchain.com",
  "lattice": "lattice.com",
  "launchdarkly": "launchdarkly.com",
  "lightmatter": "lightmatter.com",
  "Linear": "linear.app",
  "lottie": "lottie.com",
  "Lyft": "lyft.com",
  "Man Group": "man.com",
  "Marqeta": "marqeta.com",
  "Match Group": "mtch.com",
  "Mercury": "mercury.com",
  "Mixpanel": "mixpanel.com",
  "Modal": "modal.com",
  "modernhealth": "modernhealth.com",
  "MongoDB": "mongodb.com",
  "Monzo": "monzo.com",
  "Namespace": "namespace.com",
  "nanonets": "nanonets.com",
  "natera": "natera.com",
  "Netlify": "netlify.com",
  "Notion": "notion.so",
  "Nuro": "nuro.com",
  "omadahealth": "omadahealth.com",
  "onemedical": "onemedical.com",
  "openzeppelin": "openzeppelin.com",
  "Opslevel": "opslevel.com",
  "PagerDuty": "pagerduty.com",
  "Palantir": "palantir.com",
  "papa": "papa.com",
  "parsleyhealth": "parsleyhealth.com",
  "Peloton": "peloton.com",
  "Perplexity": "perplexity.ai",
  "phonepe": "phonepe.com",
  "Physical Intelligence": "physicalintelligence.com",
  "Pinterest": "pinterest.com",
  "PlanetScale": "planetscale.com",
  "Point72": "point72.com",
  "postman": "postman.com",
  "psiquantum": "psiquantum.com",
  "Qube Research & Technologies": "qube-rt.com",
  "Railway": "railway.com",
  "Ramp": "ramp.com",
  "Recursion": "recursion.com",
  "Reddit": "reddit.com",
  "Remote": "remote.com",
  "Render": "render.com",
  "Replit": "replit.com",
  "Resend": "resend.com",
  "Riot Games": "riotgames.com",
  "ripple": "ripple.com",
  "Robinhood": "robinhood.com",
  "Roblox": "roblox.com",
  "rogo": "rogo.com",
  "Roku": "roku.com",
  "rutter": "rutter.com",
  "safebreach": "safebreach.com",
  "Samsara": "samsara.com",
  "sanity": "sanity.com",
  "Scale AI": "scale.com",
  "science37": "science37.com",
  "scopely": "scopely.com",
  "semgrep": "semgrep.com",
  "signoz": "signoz.com",
  "skyflow": "skyflow.com",
  "SoFi": "sofi.com",
  "Sophos": "sophos.com",
  "SpaceX": "spacex.com",
  "Squarespace": "squarespace.com",
  "starburst": "starburst.com",
  "stone": "stone.com",
  "Stripe": "stripe.com",
  "Stytch": "stytch.com",
  "suki": "suki.com",
  "Suno": "suno.com",
  "Supabase": "supabase.com",
  "talkspace": "talkspace.com",
  "tebra": "tebra.com",
  "tenstorrent": "tenstorrent.com",
  "Tower Research": "towerresearch.com",
  "Trustly": "trustly.com",
  "truveta": "truveta.com",
  "Twilio": "twilio.com",
  "Twitch": "twitch.tv",
  "Unit": "unit.com",
  "Vanta": "vanta.com",
  "veracode": "veracode.com",
  "veracyte": "veracyte.com",
  "Vercel": "vercel.com",
  "Verkada": "verkada.com",
  "Virtu": "virtu.com",
  "Waymo": "waymo.com",
  "Weaviate": "weaviate.com",
  "Webflow": "webflow.com",
  "workboard": "workboard.com",
  "WorkOS": "workos.com",
  "yugabyte": "yugabyte.com",
  "Zocdoc": "zocdoc.com",
  "zoominfo": "zoominfo.com",
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
