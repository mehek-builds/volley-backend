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
  "Abnormal AI": "abnormal.ai",
  "Abridge": "abridge.com",
  "Access Bank PLC": "accessbankplc.com",
  "Adyen": "adyen.com",
  "Aerones": "aerones.com",
  "Affirm": "affirm.com",
  "AI Acquisition": "aiacquisition.com",
  "Airbnb": "airbnb.com",
  "Airtable": "airtable.com",
  "Airwallex": "airwallex.com",
  "Alloy": "alloy.com",
  "Amplitude": "amplitude.com",
  "Anduril Industries": "anduril.com",
  "Anthropic": "anthropic.com",
  "anydesk": "anydesk.com",
  "Anyscale": "anyscale.com",
  "aptoslabs": "aptoslabs.com",
  "AQR": "aqr.com",
  "Asana": "asana.com",
  "Assembled": "assembled.com",
  "Astranis": "astranis.com",
  "astronomer": "astronomer.io",
  "atlan": "atlan.com",
  "attio": "attio.com",
  "Axios": "axios.com",
  "Baseten": "baseten.co",
  "Betterment": "betterment.com",
  "binalyze": "binalyze.com",
  "bishopfox": "bishopfox.com",
  "bitgo": "bitgo.com",
  "Bitpanda": "bitpanda.com",
  "Blend": "blend.com",
  "Block": "block.xyz",
  "Box": "box.com",
  "Braintrust": "usebraintrust.com",
  "Braze": "braze.com",
  "Brex": "brex.com",
  "btgpactual": "btgpactual.com",
  "buildkite": "buildkite.com",
  "Calendly": "calendly.com",
  "calm": "calm.com",
  "Capgemini": "capgemini.com",
  "Carta": "carta.com",
  "causaly": "causaly.com",
  "Cerebras": "cerebras.com",
  "Chainguard": "chainguard.com",
  "Chan Zuckerberg Initiative": "chanzuckerberg.com",
  "Checkr": "checkr.com",
  "Chime": "chime.com",
  "cleo": "cleo.com",
  "Clickhouse": "clickhouse.com",
  "Cloudflare": "cloudflare.com",
  "Clover Health": "cloverhealth.com",
  "Code for America": "codeforamerica.org",
  "Coder": "coder.com",
  "Cohere": "cohere.com",
  "Coinbase": "coinbase.com",
  "Common App": "commonapp.org",
  "consensys": "consensys.com",
  "cresta": "cresta.com",
  "crisp": "crisp.com",
  "Crusoe": "crusoe.com",
  "cultureamp": "cultureamp.com",
  "Cursor": "cursor.com",
  "Databricks": "databricks.com",
  "Datadog": "datadoghq.com",
  "dataiku": "dataiku.com",
  "decagon": "decagon.ai",
  "Deepgram": "deepgram.com",
  "Digital": "digital.ai",
  "Discord": "discord.com",
  "Doppler": "doppler.com",
  "Doximity": "doximity.com",
  "Dropbox": "dropbox.com",
  "DRW": "drw.com",
  "Duolingo": "duolingo.com",
  "DV Trading": "dvtrading.com",
  "Elastic": "elastic.co",
  "elationhealth": "elationhealth.com",
  "Elevation Capital": "elevationcapital.com",
  "ElevenLabs": "elevenlabs.io",
  "elicit": "elicit.com",
  "Epic Games": "epicgames.com",
  "EPOS": "epos.com",
  "Etched": "etched.com",
  "Everlane": "everlane.com",
  "evervault": "evervault.com",
  "Facet": "facet.com",
  "Faire": "faire.com",
  "Fastly": "fastly.com",
  "Figma": "figma.com",
  "Figure": "figure.com",
  "fireblocks": "fireblocks.com",
  "Fireworks": "fireworks.ai",
  "Five Rings": "fiverings.com",
  "Fivetran": "fivetran.com",
  "Flexport": "flexport.com",
  "Flow Traders": "flowtraders.com",
  "Formlabs": "formlabs.com",
  "found": "found.com",
  "freenome": "freenome.com",
  "Fuse Energy": "fuseenergy.com",
  "Gemini": "gemini.com",
  "Geotab": "geotab.com",
  "GitLab": "gitlab.com",
  "GiveDirectly": "givedirectly.org",
  "Gong": "gong.com",
  "gorgias": "gorgias.com",
  "Grafana Labs": "grafana.com",
  "graphcore": "graphcore.com",
  "Gusto": "gusto.com",
  "Harvey": "harvey.ai",
  "Headway": "headway.com",
  "HelloFresh": "hellofresh.com",
  "Hermeus": "hermeus.com",
  "HubSpot": "hubspot.com",
  "Hudson River Trading": "hudsonrivertrading.com",
  "Huzzle": "huzzle.com",
  "IMC Trading": "imc.com",
  "imply": "imply.com",
  "Infisical": "infisical.com",
  "Instacart": "instacart.com",
  "Instawork": "instawork.com",
  "ionq": "ionq.com",
  "Jane Street": "janestreet.com",
  "jfrog": "jfrog.com",
  "Jump Crypto": "jumpcrypto.com",
  "Jump Trading": "jumptrading.com",
  "justworks": "justworks.com",
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
  "LRN Corporation": "lrn.com",
  "Lyft": "lyft.com",
  "Man Group": "man.com",
  "Marqeta": "marqeta.com",
  "Match Group": "mtch.com",
  "Maven Clinic": "mavenclinic.com",
  "Mercor": "mercor.com",
  "Mercury": "mercury.com",
  "Middle Seat": "middleseat.com",
  "Mixpanel": "mixpanel.com",
  "Modal": "modal.com",
  "Modern Family Law": "modernfamilylaw.com",
  "modernhealth": "modernhealth.com",
  "MongoDB": "mongodb.com",
  "Monzo": "monzo.com",
  "Motional": "motional.com",
  "Motive": "motive.com",
  "N26": "n26.com",
  "Namespace": "namespace.com",
  "nanonets": "nanonets.com",
  "natera": "natera.com",
  "Nava PBC": "navapbc.com",
  "Navan": "navan.com",
  "Netlify": "netlify.com",
  "Newsela": "newsela.com",
  "Notion": "notion.so",
  "Nuro": "nuro.com",
  "Okta": "okta.com",
  "omadahealth": "omadahealth.com",
  "onemedical": "onemedical.com",
  "OpenAI": "openai.com",
  "OpenGov": "opengov.com",
  "Optiver": "optiver.com",
  "Oscar Health": "hioscar.com",
  "PagerDuty": "pagerduty.com",
  "Palantir": "palantir.com",
  "papa": "papa.com",
  "parsleyhealth": "parsleyhealth.com",
  "Pearl": "pearl.com",
  "Peloton": "peloton.com",
  "Perplexity": "perplexity.ai",
  "phonepe": "phonepe.com",
  "Physical Intelligence": "physicalintelligence.com",
  "Pinely": "pinely.com",
  "Pinterest": "pinterest.com",
  "Planet": "planet.com",
  "PlanetScale": "planetscale.com",
  "Point72": "point72.com",
  "Portless": "portless.com",
  "postman": "postman.com",
  "Protolabs": "protolabs.com",
  "psiquantum": "psiquantum.com",
  "Qube Research & Technologies": "qube-rt.com",
  "quintoandar": "quintoandar.com.br",
  "Ramp": "ramp.com",
  "Recorded Future": "recordedfuture.com",
  "Recursion": "recursion.com",
  "Reddit": "reddit.com",
  "Redwood Materials": "redwoodmaterials.com",
  "Relativity Space": "relativityspace.com",
  "Remote": "remote.com",
  "Render": "render.com",
  "Rent the Runway": "renttherunway.com",
  "Replit": "replit.com",
  "Resend": "resend.com",
  "Riot Games": "riotgames.com",
  "ripple": "ripple.com",
  "Robinhood": "robinhood.com",
  "Roblox": "roblox.com",
  "Rocket Lab": "rocketlabcorp.com",
  "Rockstar": "rockstargames.com",
  "rogo": "rogo.com",
  "Roku": "roku.com",
  "Rubrik": "rubrik.com",
  "safebreach": "safebreach.com",
  "Sago": "sago.com",
  "salesloft": "salesloft.com",
  "Samsara": "samsara.com",
  "SAP Fioneer": "sapfioneer.com",
  "Saronic": "saronic.com",
  "Scale AI": "scale.com",
  "Schonfeld": "schonfeld.com",
  "Science 37": "science37.com",
  "scopely": "scopely.com",
  "SeatGeek": "seatgeek.com",
  "semgrep": "semgrep.com",
  "Sierra": "sierra.ai",
  "Sigma": "sigmacomputing.com",
  "signoz": "signoz.com",
  "Skydio": "skydio.com",
  "Snowflake": "snowflake.com",
  "SoFi": "sofi.com",
  "Sophos": "sophos.com",
  "SpaceX": "spacex.com",
  "Spotify": "spotify.com",
  "Squarespace": "squarespace.com",
  "starburst": "starburst.com",
  "stone": "stone.com",
  "Stripe": "stripe.com",
  "suki": "suki.com",
  "Suno": "suno.com",
  "Supabase": "supabase.com",
  "SupportYourApp": "supportyourapp.com",
  "sweetgreen": "sweetgreen.com",
  "talkspace": "talkspace.com",
  "tebra": "tebra.com",
  "tenstorrent": "tenstorrent.com",
  "The New York Times": "nytco.com",
  "Toast": "toasttab.com",
  "Tower Research": "towerresearch.com",
  "Town Web": "townweb.com",
  "TransMarket Group": "transmarketgroup.com",
  "TripAdvisor": "tripadvisor.com",
  "Trustly": "trustly.com",
  "truveta": "truveta.com",
  "Twilio": "twilio.com",
  "Twist Bioscience": "twistbioscience.com",
  "Twitch": "twitch.tv",
  "Udemy": "udemy.com",
  "Vanta": "vanta.com",
  "Varda Space Industries": "varda.com",
  "Vatic Labs": "vaticlabs.com",
  "veracode": "veracode.com",
  "veracyte": "veracyte.com",
  "Vercel": "vercel.com",
  "Verkada": "verkada.com",
  "Virtu": "virtu.com",
  "Vox Media Group": "voxmedia.com",
  "Waymo": "waymo.com",
  "Weaviate": "weaviate.com",
  "Webflow": "webflow.com",
  "Wiz": "wiz.io",
  "workboard": "workboard.com",
  "WorkMotion": "workmotion.com",
  "WorkOS": "workos.com",
  "WorldQuant": "worldquant.com",
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
