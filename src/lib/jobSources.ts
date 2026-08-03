import type { JobSourceInput } from './jobMonitor';

/* The companies Litos watches.
 *
 * career_page_sources was empty in production from the day the table shipped:
 * the poller reads JOB_MONITOR_SOURCES_JSON, that variable was never set, so
 * the daily cron woke up, found nothing to poll, and returned success. GET
 * /jobs answered `{"jobs":[]}` for months and no alarm anywhere fired, because
 * an empty board and a working board look identical to every check we had.
 * That is why the list lives in the repo now rather than in an env var: it is
 * reviewable, diffable, and a missing entry shows up in a pull request.
 *
 * Every token below was fetched from the live ATS endpoint on 2026-07-28 and
 * answered with at least one posting. A token that 404s is not a silent zero
 * for the whole board — pollSource records last_error per source — but it is
 * still a hole in the board, so re-run scripts/seed-job-sources.mts --check
 * before adding to this list.
 *
 * Chosen for spread, not just headcount: consumer tech, fintech, infra, dev
 * tools, health, marketplaces, and a quant/trading block, so a job seeker who
 * is not a software engineer still finds their own field on the board.
 */

type Entry = [company: string, ats: JobSourceInput['ats_name'], token: string];

/* FOUR TOKENS WERE REMOVED ON 2026-07-29, and this note is here so nobody adds them back.
 *
 *   sas    -> the board is Superior Alarm Systems, a security-systems integrator
 *   bcg    -> Bohen Consulting Group, four postings, two of them called "Test Job Live"
 *   tcs    -> Thornbury Community Services, UK care work
 *   disney -> a board named "Sgt. Pepper's Lonely Hearts Club Band" with two test postings
 *
 * The companies somebody meant - SAS Institute, Boston Consulting Group, Tata Consultancy, Disney -
 * do not publish on Greenhouse, Lever or Ashby at all, which is exactly why a guessed token landed
 * on someone else. Checked 2026-07-29: sasinstitute, bostonconsultinggroup, bcgx,
 * tataconsultancyservices, waltdisney and disneyparks are all 404.
 *
 * Three more were RENAMED rather than removed, because the board is a real company and only our
 * label was wrong: `latch` is LatchBio, `assembledhq` is Assembled, and science37 writes itself
 * "Science 37" with a space.
 *
 * `npm run sources:verify` is what catches this now. It asks each board who it is - Greenhouse
 * publishes `company_name` on every posting - rather than the old check's "does the token return
 * postings?", which every wrong token also answers yes to. */
const BASE_ENTRIES: Entry[] = [
  // Consumer + marketplaces
  ['Airbnb', 'greenhouse', 'airbnb'],
  ['Pinterest', 'greenhouse', 'pinterest'],
  ['Reddit', 'greenhouse', 'reddit'],
  ['Lyft', 'greenhouse', 'lyft'],
  ['Instacart', 'greenhouse', 'instacart'],
  /* No DoorDash: their Greenhouse token 404s (checked 2026-07-28, they have
     moved off the public board API). Left recorded here so the next person to
     notice a famous name missing does not spend the afternoon re-deriving it. */
  ['Twitch', 'greenhouse', 'twitch'],
  ['Discord', 'greenhouse', 'discord'],
  ['Duolingo', 'greenhouse', 'duolingo'],
  ['Faire', 'greenhouse', 'faire'],
  ['Flexport', 'greenhouse', 'flexport'],
  ['Match Group', 'lever', 'matchgroup'],

  // Fintech
  ['Stripe', 'greenhouse', 'stripe'],
  ['Brex', 'greenhouse', 'brex'],
  ['Affirm', 'greenhouse', 'affirm'],
  ['Coinbase', 'greenhouse', 'coinbase'],
  ['Robinhood', 'greenhouse', 'robinhood'],
  ['Chime', 'greenhouse', 'chime'],
  ['SoFi', 'greenhouse', 'sofi'],
  ['Carta', 'greenhouse', 'carta'],
  ['Betterment', 'greenhouse', 'betterment'],
  ['Marqeta', 'greenhouse', 'marqeta'],
  ['Gemini', 'greenhouse', 'gemini'],
  ['Ramp', 'ashby', 'ramp'],

  // Quant + trading. Their own block on purpose: these are the postings the
  // finance-track job seeker comes for, and a board of pure SWE roles reads as
  // a board that is not for them.
  ['Point72', 'greenhouse', 'point72'],
  ['IMC Trading', 'greenhouse', 'imc'],
  ['Qube Research & Technologies', 'greenhouse', 'quberesearchandtechnologies'],
  ['Palantir', 'lever', 'palantir'],

  // Infra, data and dev tools
  ['Cloudflare', 'greenhouse', 'cloudflare'],
  ['GitLab', 'greenhouse', 'gitlab'],
  ['MongoDB', 'greenhouse', 'mongodb'],
  ['Datadog', 'greenhouse', 'datadog'],
  ['Asana', 'greenhouse', 'asana'],
  ['Airtable', 'greenhouse', 'airtable'],
  ['Amplitude', 'greenhouse', 'amplitude'],
  ['Notion', 'ashby', 'notion'],
  ['Linear', 'ashby', 'linear'],
  ['Vanta', 'ashby', 'vanta'],
  ['Supabase', 'ashby', 'supabase'],
  ['Replit', 'ashby', 'replit'],
  ['Render', 'ashby', 'render'],

  // AI labs and AI products
  ['Anthropic', 'greenhouse', 'anthropic'],
  ['Scale AI', 'greenhouse', 'scaleai'],
  ['Perplexity', 'ashby', 'perplexity'],
  ['Cursor', 'ashby', 'cursor'],
  ['Baseten', 'ashby', 'baseten'],

  // Design, HR and health
  ['Figma', 'greenhouse', 'figma'],
  ['Gusto', 'greenhouse', 'gusto'],
  ['Checkr', 'greenhouse', 'checkr'],
  ['Zocdoc', 'greenhouse', 'zocdoc'],
  ['Doximity', 'greenhouse', 'doximity'],
  ['Khan Academy', 'greenhouse', 'khanacademy'],
  /* ── Added 2026-07-28 ──────────────────────────────────────────────────
   * 188 boards, every token probed live before landing here (scripts/seed-job-sources.mts
   * --check does the same probe). Grouped by company size on purpose: the board is meant to
   * carry startups through multinationals, not just whichever tier is easiest to source,
   * so the grouping is what makes a thin tier visible in a diff.
   *
   * ~1,050 candidate tokens were probed to find these. Hit rate is low and very uneven:
   * large corporates mostly run Workday/Taleo, which have no public board API, so the
   * multinational tier is the hardest to grow and the one to watch. */
  // Bulge-bracket and quant/trading (11 boards, ~649 postings)
  ['Jane Street', 'greenhouse', 'janestreet'],
  ['Jump Trading', 'greenhouse', 'jumptrading'],
  ['Tower Research', 'greenhouse', 'towerresearchcapital'],
  ['Man Group', 'greenhouse', 'mangroup'],
  ['AQR', 'greenhouse', 'aqr'],
  ['Virtu', 'greenhouse', 'virtu'],
  ['Flow Traders', 'greenhouse', 'flowtraders'],
  ['Akuna', 'greenhouse', 'akunacapital'],
  ['Old Mission', 'greenhouse', 'oldmissioncapital'],
  ['Quadrature', 'greenhouse', 'quadraturecapital'],
  ['Marshall Wace', 'greenhouse', 'marshallwace'],
  // Multinational corporates (16 boards, ~4404 postings)
  ['SpaceX', 'greenhouse', 'spacex'],
  ['Waymo', 'greenhouse', 'waymo'],
  ['Pure Storage', 'greenhouse', 'purestorage'],
  ['Lucid', 'greenhouse', 'lucidmotors'],
  ['Adyen', 'greenhouse', 'adyen'],
  ['Roblox', 'greenhouse', 'roblox'],
  ['Block', 'greenhouse', 'block'],
  ['Riot Games', 'greenhouse', 'riotgames'],
  ['Epic Games', 'greenhouse', 'epicgames'],
  ['Spotify', 'lever', 'spotify'],
  ['Sophos', 'lever', 'sophos'],
  ['TripAdvisor', 'greenhouse', 'tripadvisor'],
  ['Take-Two', 'greenhouse', 'taketwo'],
  // Mid-size and scale-ups (80 boards, ~5923 postings)
  ['Databricks', 'greenhouse', 'databricks'],
  ['Rocket Lab', 'greenhouse', 'rocketlab'],
  ['onemedical', 'greenhouse', 'onemedical'],
  ['Samsara', 'greenhouse', 'samsara'],
  ['Verkada', 'greenhouse', 'verkada'],
  ['Braze', 'greenhouse', 'braze'],
  ['Remote', 'greenhouse', 'remotecom'],
  ['Roku', 'greenhouse', 'roku'],
  ['natera', 'greenhouse', 'natera'],
  ['Elastic', 'greenhouse', 'elastic'],
  ['betterhelp', 'greenhouse', 'betterhelp'],
  ['Fivetran', 'greenhouse', 'fivetran'],
  ['Twilio', 'greenhouse', 'twilio'],
  ['Klaviyo', 'greenhouse', 'klaviyo'],
  ['ripple', 'greenhouse', 'ripple'],
  ['Cerebras', 'ashby', 'cerebras'],
  ['justworks', 'greenhouse', 'justworks'],
  ['cresta', 'greenhouse', 'cresta'],
  ['zoominfo', 'greenhouse', 'zoominfo'],
  ['Nuro', 'greenhouse', 'nuro'],
  ['Sigma', 'greenhouse', 'sigmacomputing'],
  ['Monzo', 'greenhouse', 'monzo'],
  ['N26', 'greenhouse', 'n26'],
  ['fireblocks', 'greenhouse', 'fireblocks'],
  ['Peloton', 'greenhouse', 'peloton'],
  ['Fastly', 'greenhouse', 'fastly'],
  ['Science 37', 'greenhouse', 'science37'],
  ['truveta', 'greenhouse', 'truveta'],
  ['singlestore', 'greenhouse', 'singlestore'],
  ['bitgo', 'greenhouse', 'bitgo'],
  ['jfrog', 'greenhouse', 'jfrog'],
  ['komodohealth', 'greenhouse', 'komodohealth'],
  ['cockroachlabs', 'greenhouse', 'cockroachlabs'],
  ['veracyte', 'greenhouse', 'veracyte'],
  ['launchdarkly', 'greenhouse', 'launchdarkly'],
  ['omadahealth', 'greenhouse', 'omadahealth'],
  ['Dropbox', 'greenhouse', 'dropbox'],
  ['freenome', 'greenhouse', 'freenome'],
  ['salesloft', 'greenhouse', 'salesloft'],
  ['tebra', 'greenhouse', 'tebra'],
  ['Webflow', 'greenhouse', 'webflow'],
  ['cultureamp', 'greenhouse', 'cultureamp'],
  ['Recursion', 'greenhouse', 'recursionpharmaceuticals'],
  ['Squarespace', 'greenhouse', 'squarespace'],
  ['Ginkgo', 'greenhouse', 'ginkgobioworks'],
  ['PagerDuty', 'greenhouse', 'pagerduty'],
  ['Trustly', 'lever', 'trustly'],
  ['nanonets', 'greenhouse', 'nanonets'],
  ['yugabyte', 'greenhouse', 'yugabyte'],
  ['Calendly', 'greenhouse', 'calendly'],
  ['veracode', 'greenhouse', 'veracode'],
  ['elationhealth', 'greenhouse', 'elationhealth'],
  ['amwell', 'greenhouse', 'amwell'],
  ['honor', 'greenhouse', 'honor'],
  ['starburst', 'greenhouse', 'starburst'],
  ['modernhealth', 'greenhouse', 'modernhealth'],
  ['buildkite', 'greenhouse', 'buildkite'],
  ['suki', 'greenhouse', 'suki'],
  ['talkspace', 'greenhouse', 'talkspace'],
  ['parsleyhealth', 'greenhouse', 'parsleyhealth'],
  ['anydesk', 'greenhouse', 'anydesk'],
  ['bishopfox', 'greenhouse', 'bishopfox'],
  ['instabase', 'greenhouse', 'instabase'],
  ['circleci', 'greenhouse', 'circleci'],
  ['dremio', 'greenhouse', 'dremio'],
  ['imply', 'greenhouse', 'imply'],
  ['aptoslabs', 'greenhouse', 'aptoslabs'],
  ['Blend', 'greenhouse', 'blend'],
  ['lattice', 'greenhouse', 'lattice'],
  ['found', 'greenhouse', 'found'],
  ['cleo', 'greenhouse', 'cleo'],
  ['papa', 'greenhouse', 'papa'],
  ['workboard', 'greenhouse', 'workboard'],
  ['safebreach', 'greenhouse', 'safebreach'],
  ['openzeppelin', 'greenhouse', 'openzeppelin'],
  ['consensys', 'greenhouse', 'consensys'],
  ['curative', 'greenhouse', 'curative'],
  ['blueconic', 'greenhouse', 'blueconic'],
  ['figment', 'greenhouse', 'figment'],
  ['calm', 'greenhouse', 'calm'],
  // Startups (81 boards, ~2273 postings)
  ['Harvey', 'ashby', 'harvey'],
  ['ElevenLabs', 'ashby', 'elevenlabs'],
  ['Clickhouse', 'greenhouse', 'clickhouse'],
  ['decagon', 'ashby', 'decagon'],
  ['LangChain', 'ashby', 'langchain'],
  ['Vercel', 'greenhouse', 'vercel'],
  ['Deepgram', 'ashby', 'deepgram'],
  ['rogo', 'ashby', 'rogo'],
  ['Suno', 'ashby', 'suno'],
  ['Reflection AI', 'ashby', 'reflectionai'],
  ['Ashby', 'ashby', 'ashby'],
  ['Mercury', 'greenhouse', 'mercury'],
  ['Fireworks', 'ashby', 'fireworksai'],
  ['Abridge', 'ashby', 'abridge'],
  ['Mixpanel', 'greenhouse', 'mixpanel'],
  ['attio', 'ashby', 'attio'],
  ['Modal', 'ashby', 'modal'],
  ['gamma', 'ashby', 'gamma'],
  ['astronomer', 'ashby', 'astronomer'],
  ['sanity', 'ashby', 'sanity'],
  ['Physical Intelligence', 'ashby', 'physicalintelligence'],
  ['WorkOS', 'ashby', 'workos'],
  ['crisp', 'ashby', 'crisp'],
  ['Braintrust', 'ashby', 'braintrust'],
  ['socket', 'ashby', 'socket'],
  ['Assembled', 'ashby', 'assembledhq'],
  ['Alloy', 'greenhouse', 'alloy'],
  ['Column', 'ashby', 'column'],
  ['Anyscale', 'ashby', 'anyscale'],
  ['incident', 'ashby', 'incident'],
  ['Merge', 'ashby', 'merge'],
  ['semgrep', 'ashby', 'semgrep'],
  ['gorgias', 'ashby', 'gorgias'],
  ['Poolside', 'ashby', 'poolside'],
  ['doppel', 'ashby', 'doppel'],
  ['Blacksmith', 'ashby', 'blacksmith'],
  ['opal', 'ashby', 'opal'],
  ['signoz', 'ashby', 'signoz'],
  ['Coder', 'ashby', 'coder'],
  ['llamaindex', 'ashby', 'llamaindex'],
  ['validio', 'ashby', 'validio'],
  ['OpenEvidence', 'ashby', 'openevidence'],
  ['elicit', 'ashby', 'elicit'],
  ['helpscout', 'ashby', 'helpscout'],
  ['Resend', 'ashby', 'resend'],
  ['Namespace', 'ashby', 'namespace'],
  ['intro', 'ashby', 'intro'],
  ['PlanetScale', 'greenhouse', 'planetscale'],
  ['Railway', 'ashby', 'railway'],
  ['Infisical', 'ashby', 'infisical'],
  ['causaly', 'ashby', 'causaly'],
  ['Unit', 'ashby', 'unit'],
  ['skyflow', 'ashby', 'skyflow'],
  ['Netlify', 'greenhouse', 'netlify'],
  ['Pinecone', 'ashby', 'pinecone'],
  ['Stytch', 'ashby', 'stytch'],
  ['prefect', 'ashby', 'prefect'],
  ['atlan', 'ashby', 'atlan'],
  ['sifflet', 'ashby', 'sifflet'],
  ['unstructured', 'ashby', 'unstructured'],
  ['kustomer', 'ashby', 'kustomer'],
  ['codat', 'ashby', 'codat'],
  ['Weaviate', 'ashby', 'weaviate'],
  ['lottie', 'ashby', 'lottie'],
  ['Knock', 'ashby', 'knock'],
  ['Doppler', 'ashby', 'doppler'],
  ['datafold', 'ashby', 'datafold'],
  ['checkly', 'ashby', 'checkly'],
  ['inkeep', 'ashby', 'inkeep'],
  ['LatchBio', 'lever', 'latch'],
  ['Zed', 'ashby', 'zed'],
  ['Depot', 'ashby', 'depot'],
  ['evervault', 'ashby', 'evervault'],
  ['binalyze', 'ashby', 'binalyze'],
  ['Inngest', 'ashby', 'inngest'],
  ['Hightouch', 'ashby', 'hightouch'],
  ['Opslevel', 'ashby', 'opslevel'],
  ['anomalo', 'ashby', 'anomalo'],
  ['orca', 'ashby', 'orca'],
  ['rutter', 'ashby', 'rutter'],
  ['fullstory', 'ashby', 'fullstory'],
  // Added later on 2026-07-28, large-board round (14 boards, ~1,700 postings)
  ['stone', 'greenhouse', 'stone'],
  ['btgpactual', 'greenhouse', 'btgpactual'],
  ['graphcore', 'greenhouse', 'graphcore'],
  ['scopely', 'greenhouse', 'scopely'],
  ['tenstorrent', 'greenhouse', 'tenstorrent'],
  ['postman', 'greenhouse', 'postman'],
  ['ionq', 'greenhouse', 'ionq'],
  ['psiquantum', 'greenhouse', 'psiquantum'],
  ['quintoandar', 'greenhouse', 'quintoandar'],
  ['phonepe', 'greenhouse', 'phonepe'],
  ['lightmatter', 'greenhouse', 'lightmatter'],
  ['dataiku', 'greenhouse', 'dataiku'],
  ['groww', 'greenhouse', 'groww'],

  /* ADDED 2026-07-29, and every one was probed BEFORE it was written down - which is the workflow
     the new gate exists to make normal. Two more candidates were dropped in the same pass:
     lever/sardine and lever/attentive both answer with something that is not a postings array. */
  ['Chainguard', 'greenhouse', 'chainguard'],
  ['Abnormal AI', 'greenhouse', 'abnormalsecurity'],
  ['OpenAI', 'ashby', 'openai'],
  ['Sierra', 'ashby', 'sierra'],
  ['Mercor', 'ashby', 'mercor'],
  ['Crusoe', 'ashby', 'crusoe'],

  /* Workable publishes the account name with its public jobs feed, so identity is verified from
     the portal rather than inferred from the token. This source also exercises the new ingestion
     path in production instead of leaving the fetcher dormant until a later sourcing round. */
  ['Suade', 'workable', 'suade'],
];

/* Phase 2 supply expansion, verified against live ATS feeds on 2026-07-31.
 * Suade remains in the base catalog, so these 49 entries bring Workable to exactly 50 employers.
 * The provider publishes one shared rate limit across accounts. jobPollScheduler spaces Workable
 * request starts by 1.1 seconds, which keeps this larger catalog inside that limit. */
const PHASE_2_WORKABLE_ENTRIES: readonly Entry[] = [
  ['Huzzle', 'workable', 'huzzle'],
  ['SupportYourApp', 'workable', 'supportyourapp'],
  ['Digital', 'workable', 'digital-368'],
  ['Capgemini', 'workable', 'capgemini-insurance'],
  ['Pearl', 'workable', 'pearltalent'],
  ['Manila Recruitment', 'workable', 'manilarecruitment'],
  ['Domes Resorts & Reserves', 'workable', 'domes-resorts'],
  ['SAP Fioneer', 'workable', 'fioneer'],
  ['Fuse Energy', 'workable', 'fuseenergy'],
  ['Peter Lucas Project Management Inc.', 'workable', 'peterlucas'],
  ['Remote Raven', 'workable', 'remote-raven'],
  ['Rockstar', 'workable', 'rockstar-3'],
  ['Aerones', 'workable', 'aerones'],
  ['Modern Family Law', 'workable', 'modern-family-law-1'],
  ['WorkMotion', 'workable', 'workmotion'],
  ['GoGlobal', 'workable', 'goglobal'],
  ['LRN Corporation', 'workable', 'lrn-corporation'],
  ['Sago', 'workable', 'sago-group'],
  ['Base.com', 'workable', 'base-com'],
  ['C-Serv', 'workable', 'c-serv'],
  ['D-ploy', 'workable', 'd-ploy'],
  ['EPOS', 'workable', 'epos'],
  ['Impact Clients', 'workable', 'impact-clients'],
  ['Financeit', 'workable', 'financeit'],
  ['Access Bank PLC', 'workable', 'access-bank'],
  ['AI Acquisition', 'workable', 'ai-acquisition'],
  ['AD Education', 'workable', 'icmp-6'],
  ['Common App', 'workable', 'commonapp'],
  ['Sedona Digital', 'workable', 'sedona-digital'],
  ['Skylight', 'workable', 'skylight-frame'],
  ['webook.com', 'workable', 'webook'],
  ['Mercata', 'workable', 'mercata'],
  ['Create Wellness, Inc.', 'workable', 'create-wellness-inc'],
  ['Facet', 'workable', 'facetwealth'],
  ['payabl.', 'workable', 'payabl'],
  ['Portless', 'workable', 'portless'],
  ['Street Child', 'workable', 'streetchildcareers'],
  ['Wrisk', 'workable', 'wrisk'],
  ['Blink - The Employee App', 'workable', 'joinblink'],
  ['Runware', 'workable', 'runware'],
  ['Elevation Capital', 'workable', 'elevation-capital-3'],
  ['Huckberry', 'workable', 'huckberry'],
  ['Lifely', 'workable', 'lifely'],
  ['Mercari, Inc. (India)', 'workable', 'mercari-india'],
  ['Vitesse PSP', 'workable', 'vitesse-psp'],
  ['Pinely', 'workable', 'pinely'],
  ['Town Web', 'workable', 'town-web'],
  ['Foundation', 'workable', 'foundation'],
  ['Middle Seat', 'workable', 'middle-seat'],
];

/* Fifty additional employers chosen for both fresh yield and breadth. The catalog adds healthcare,
 * hospitality, defense, climate, aerospace, travel, logistics, education, media, retail, finance,
 * government technology, and nonprofits instead of optimizing only for software companies. */
const PHASE_2_UNDERREPRESENTED_ENTRIES: readonly Entry[] = [
  ['Anduril Industries', 'greenhouse', 'andurilindustries'],
  ['Relativity Space', 'greenhouse', 'relativity'],
  ['Okta', 'greenhouse', 'okta'],
  ['Toast', 'greenhouse', 'toast'],
  ['Navan', 'greenhouse', 'tripactions'],
  ['HelloFresh', 'greenhouse', 'hellofresh'],
  ['The New York Times', 'greenhouse', 'thenewyorktimes'],
  ['Oscar Health', 'greenhouse', 'oscar'],
  ['Redwood Materials', 'greenhouse', 'redwoodmaterials'],
  ['Box', 'greenhouse', 'boxinc'],
  ['Geotab', 'greenhouse', 'geotab'],
  ['Rubrik', 'greenhouse', 'rubrik'],
  ['FanDuel', 'greenhouse', 'fanduel'],
  ['Planet', 'greenhouse', 'planetlabs'],
  ['Motive', 'greenhouse', 'gomotive'],
  ['Grafana Labs', 'greenhouse', 'grafanalabs'],
  ['Clover Health', 'greenhouse', 'cloverhealth'],
  ['HubSpot', 'greenhouse', 'hubspotjobs'],
  ['GetYourGuide', 'greenhouse', 'getyourguide'],
  ['Mozilla', 'greenhouse', 'mozilla'],
  ['sweetgreen', 'greenhouse', 'sweetgreen'],
  ['Recorded Future', 'greenhouse', 'recordedfuture'],
  ['Gong', 'greenhouse', 'gongio'],
  ['DRW', 'greenhouse', 'drweng'],
  ['Varda Space Industries', 'greenhouse', 'vardaspace'],
  ['Saronic', 'ashby', 'saronic'],
  ['Bitpanda', 'greenhouse', 'bitpanda'],
  ['Hudson River Trading', 'greenhouse', 'wehrtyou'],
  ['Wiz', 'greenhouse', 'wizinc'],
  ['Instawork', 'greenhouse', 'instawork'],
  ['StockX', 'greenhouse', 'stockx'],
  ['Maven Clinic', 'greenhouse', 'mavenclinic'],
  ['Five Rings', 'greenhouse', 'fiveringsllc'],
  ['Crunchyroll', 'greenhouse', 'crunchyroll'],
  ['OpenGov', 'ashby', 'opengov'],
  ['Newsela', 'greenhouse', 'newsela'],
  ['GiveDirectly', 'greenhouse', 'givedirectly'],
  ['Udemy', 'greenhouse', 'udemy'],
  ['Chan Zuckerberg Initiative', 'greenhouse', 'chanzuckerberginitiative'],
  ['Rent the Runway', 'greenhouse', 'renttherunway'],
  ['Epirus', 'greenhouse', 'epirus'],
  ['Nava PBC', 'greenhouse', 'navapbc'],
  ['Everlane', 'greenhouse', 'everlane'],
  ['SeatGeek', 'greenhouse', 'seatgeek'],
  ['Code for America', 'greenhouse', 'codeforamerica'],
  ['Vox Media Group', 'greenhouse', 'voxmedia'],
  ['Axios', 'greenhouse', 'axios'],
  ['Rondo Energy', 'greenhouse', 'rondoenergy'],
  ['Tala', 'lever', 'tala'],
  ['Headway', 'ashby', 'headway'],
];

/* ── Added 2026-08-03: sourced FOR INTERNSHIP DENSITY ────────────────────────
 *
 * Every earlier round picked sources by postings-per-board, and that metric selects
 * against internships about as hard as any metric could. Measured across all 355
 * sources on 2026-08-03: 36,435 live postings carry 367 internships, 1.0%. The
 * biggest boards are the thinnest - Stripe publishes 1 internship in 545 postings,
 * Databricks 2 in 807, Anthropic 0 in 397 - because a company's main board is its
 * experienced-hire board.
 *
 * DENSITY VARIES ~100x BY SECTOR, and that is the whole lever. Measured live:
 *   quant / prop trading   Jump 29/105, Virtu 13/48, Akuna 8/34, Optiver 12/177
 *   space / defense hw     Astranis 23/94, Rocket Lab 32/387
 *   large tech             Stripe 0.2%, Databricks 0.25%
 * So probe a quant shop with 40 postings before a platform company with 800.
 *
 * 1,501 candidate tokens were probed to find the 26 below; 112 answered (7.5%) and
 * 26 carried an internship. That hit rate is WORSE than the general-sourcing rounds
 * and it is not a sign the method is wrong - it is the supply being genuinely thin.
 * Do not read the low count here as a round that was run lazily.
 *
 * Identity was checked per token, not just "did it return postings?" - the failure
 * that put Superior Alarm Systems on the board under `sas`. All 26 answered as
 * themselves.
 */
const INTERNSHIP_DENSITY_ENTRIES: Entry[] = [
  // Quant, prop trading and systematic funds. The densest tier that exists.
  ['Optiver', 'greenhouse', 'optiverus'],
  ['WorldQuant', 'greenhouse', 'worldquant'],
  ['Schonfeld', 'greenhouse', 'schonfeld'],
  ['Squarepoint Capital', 'greenhouse', 'squarepointcapital'],
  ['TransMarket Group', 'greenhouse', 'transmarketgroup'],
  ['GSA Capital', 'greenhouse', 'gsacapital'],
  ['Vatic Labs', 'greenhouse', 'vaticlabs'],
  ['Engineers Gate', 'greenhouse', 'engineersgate'],
  ['DV Trading', 'greenhouse', 'dvtrading'],
  ['Jump Crypto', 'greenhouse', 'jumpcrypto'],

  // Space, defense and robotics. Hardware programs run large intern cohorts.
  ['Astranis', 'greenhouse', 'astranis'],
  ['Figure', 'greenhouse', 'figureai'],
  ['Hermeus', 'lever', 'hermeus'],
  ['Shield AI', 'lever', 'shieldai'],
  ['Vannevar Labs', 'greenhouse', 'vannevarlabs'],
  ['Skydio', 'ashby', 'skydio'],
  ['Motional', 'greenhouse', 'motional'],

  // Advanced manufacturing and life sciences.
  ['Formlabs', 'greenhouse', 'formlabs'],
  ['Protolabs', 'lever', 'protolabs'],
  ['Twist Bioscience', 'greenhouse', 'twistbioscience'],

  // Infra, security and AI with live intern reqs.
  ['Zscaler', 'greenhouse', 'zscaler'],
  ['Etched', 'ashby', 'etched'],
  ['Snowflake', 'ashby', 'snowflake'],
  ['Cohere', 'ashby', 'cohere'],
  ['Together AI', 'greenhouse', 'togetherai'],
  ['Airwallex', 'ashby', 'airwallex'],
];


/* ── Added 2026-08-04: sourced OUTSIDE THE US, because that is where the internships are ──────
 *
 * Measured on the live board the day this landed: non-US postings are 3.53% internships and US
 * postings are 1.67%. TWICE the density, and the catalog was weighted the wrong way - 14,039 US
 * postings against 6,351 non-US. The board had been sourced almost entirely from US tech, which
 * is both the thinnest internship tier AND the one everybody else already lists.
 *
 * The probe yield says the same thing. 593 international tokens returned 130 live boards (22%)
 * and 46 fresh internships; the equivalent US round earlier returned 6% and needed 1,054 probes
 * for 26. Roughly three times the internships per probe.
 *
 * BUT IT DECAYS AS FAST AS ANYTHING ELSE, and the second round is the honest half of the story:
 * another 603 tokens, this time regional names rather than international tech (Brazilian retail,
 * LatAm banks, German energy), returned 24 boards and ONE with internships. Companies outside the
 * US tech orbit mostly do not publish on Greenhouse, Lever, Ashby or Workable at all. Probe
 * international COMPANIES ON THESE FOUR ATSs, not international companies.
 */
const INTERNATIONAL_INTERNSHIP_ENTRIES: Entry[] = [
  // Europe
  ['Celonis', 'greenhouse', 'celonis'],
  ['Enpal', 'ashby', 'enpal'],
  ['Alan', 'ashby', 'alan'],
  ['Solaris', 'greenhouse', 'solarisbank'],
  ['Raisin', 'greenhouse', 'raisin'],
  ['Mollie', 'ashby', 'mollie'],
  ['Ledger', 'ashby', 'ledger'],
  ['Sorare', 'ashby', 'sorare'],
  ['trivago', 'greenhouse', 'trivago'],
  ['Musixmatch', 'lever', 'musixmatch'],
  ['Cabify', 'greenhouse', 'cabify'],

  // Latin America. btgpactual alone carries 16 internships, all titled "Estágio ...", which is
  // what surfaced the multilingual gap in the title rule in the first place.
  ['Inter', 'greenhouse', 'inter'],
  ['Wildlife Studios', 'greenhouse', 'wildlifestudios'],
  ['VTEX', 'greenhouse', 'vtex'],
  ['Wellhub', 'greenhouse', 'gympass'],
  ['Despegar', 'lever', 'despegar'],

  // Southeast Asia
  ['Ninja Van', 'lever', 'ninjavan'],
];

const ENTRIES: readonly Entry[] = [
  ...BASE_ENTRIES,
  ...PHASE_2_WORKABLE_ENTRIES,
  ...PHASE_2_UNDERREPRESENTED_ENTRIES,
  ...INTERNSHIP_DENSITY_ENTRIES,
  ...INTERNATIONAL_INTERNSHIP_ENTRIES,
];

function careerUrl(ats: JobSourceInput['ats_name'], token: string): string {
  switch (ats) {
    case 'greenhouse': return `https://job-boards.greenhouse.io/${token}`;
    case 'lever': return `https://jobs.lever.co/${token}`;
    case 'ashby': return `https://jobs.ashbyhq.com/${token}`;
    case 'workable': return `https://apply.workable.com/${token}/`;
  }
}

export const JOB_SOURCES: JobSourceInput[] = ENTRIES.map(([company_name, ats_name, board_token]) => ({
  company_name,
  ats_name,
  board_token,
  career_url: careerUrl(ats_name, board_token),
  enabled: true,
}));
