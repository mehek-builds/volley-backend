/* VENDORED COPY. Source of truth: role-quick-website `lib/job-rows.ts` (origin/main @ b9a0344).
 *
 * Copied here, not imported, because this test spans two repositories and the backend cannot
 * resolve a module out of the website's tree. The single line changed from the original is the
 * type-only `import type { MonitoredJob } from "./api"`, replaced by the local alias below; the
 * runtime logic is byte-identical.
 *
 * DRIFT IS THE KNOWN COST. Nothing here fails if the website's copy changes, so if the badge logic
 * is edited there, re-copy this file. Verify with:
 *   diff <(git -C <website> show origin/main:lib/job-rows.ts | tail -n +2) <(tail -n +2 e2e/website-job-rows.vendored.ts)
 * The alternative, a shared package across two repos, is more machinery than one test justifies.
 */
type MonitoredJob = { first_seen_at: string };

/* The pure logic behind a row on the jobs list.
 *
 * These lived in `app/dashboard/jobs/page.tsx` and `components/app/CompanyLogo.tsx` and were
 * therefore untestable: this repo's runner is `node --experimental-strip-types`, which strips
 * types but cannot parse JSX, so nothing in a .tsx file can be imported by a test. They carry the
 * two decisions on that page a student would actually notice getting wrong — whether a row says
 * "Applied", and whose logo is on it — so "untestable" was the wrong place for them. */

/** Job boards, not employers. A careers URL on one of these tells us nothing about the company. */
const ATS_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "myworkdayjobs.com",
  "myworkdaysite.com",
  "workday.com",
  "workable.com",
  "jazzhr.com",
  "applytojob.com",
  "paylocity.com",
  "bamboohr.com",
  "smartrecruiters.com",
  "icims.com",
  "taleo.net",
  "jobvite.com",
  "recruitee.com",
  "breezy.hr",
  "teamtailor.com",
  "successfactors.com",
  "avature.net",
  "oraclecloud.com",
  "rippling.com",
  "ripplingats.com",
];

/**
 * The employer's domain for a job row, or null when we do not have one.
 *
 * PREFERS THE SERVER'S ANSWER, and that is the whole fix. This used to derive the domain from
 * `career_url` alone, and on 2026-07-28 every one of the 51 polled sources had a JOB BOARD in that
 * field — `job-boards.greenhouse.io/lyft`, `jobs.ashbyhq.com/linear` — because that is what a
 * careers URL honestly is for these employers. So this function correctly returned null on 100 rows
 * out of 100 and the logo never once appeared. The backend now resolves the employer's real domain
 * from a verified mapping and sends it as `company_domain`.
 *
 * The careers-URL path is kept as a fallback rather than deleted: an operator may yet register a
 * real company careers page, and when they do it is a perfectly good source. It keeps the ATS guard
 * for the same reason it always had it.
 */
export function companyDomainForRow(row: {
  company_domain?: string | null;
  career_url?: string | null;
}): string | null {
  const served = row.company_domain?.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (served && served.includes(".") && !isAtsHost(served)) return served;
  return companyDomain(row.career_url);
}

function isAtsHost(host: string): boolean {
  return ATS_HOSTS.some((ats) => host === ats || host.endsWith(`.${ats}`));
}

/**
 * The host a careers URL is served from, lowercased and minus `www.`, or null when the URL does not
 * identify a company.
 *
 * NOT the registrable domain, despite how it reads. Reducing `careers.acme.co.uk` to `acme.co.uk`
 * needs a public-suffix list, which is deliberately not shipped here, so subdomain variants of one
 * employer are distinct results and will fetch distinct icons. That is a cosmetic cost; the thing
 * this function exists to prevent is worse and it does prevent it.
 *
 * What it prevents: a posting's apply and posting URLs both point at the job board, so anything
 * derived from them paints one board's icon on every row in the list. Only the careers URL can
 * carry the employer's own domain, and operators sometimes register the board URL there too, which
 * is why ATS hosts are rejected rather than trusted. A wrong logo is worse than no logo: it tells
 * the student this row is a different company than it is.
 */
export function companyDomain(careerUrl: string | null | undefined): string | null {
  if (!careerUrl) return null;
  let host: string;
  try {
    host = new URL(careerUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  /* The trailing dot is the fully-qualified form of the same host ("greenhouse.io." is
     "greenhouse.io"), and it matches neither arm of the check below, so without stripping it the
     board's own domain sails through and every row from that source draws the board's logo. */
  host = host.replace(/\.$/, "");
  if (!host.includes(".")) return null;
  if (isAtsHost(host)) return null;
  return host;
}

/* Legal suffixes, stripped only as a trailing token. */
const LEGAL_SUFFIX = /\s+(inc|llc|ltd|corp|corporation|co)$/;

function flatten(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEGAL_SUFFIX, "")
    .trim();
}

/**
 * The identity two records of the same application share, so a row the student already applied to
 * can say so.
 *
 * THE FALLBACK, not the primary rule any more. Applications started from the jobs list since
 * 2026-07-28 carry the posting's own id (`BoardCard.job_id`) and are matched on that instead, by
 * `buildAppliedIndex` below. This is what remains for rows that have no id and never will: every
 * application recorded before that date, plus anything generated from the extension or a
 * hand-typed link, where there is no monitored posting to point at.
 *
 * On those rows the original imprecision still stands, and it is unfixable rather than merely
 * unfixed: the data to tell two reqs apart was never written. Company and role are all there is,
 * so two postings sharing both are indistinguishable and applying to one marks both. That is why
 * the id path exists and why it must not fall through to here when it has an id to use.
 *
 * Given that, the flattening stays as narrow as it can be. It folds "Airbnb, Inc." into "Airbnb"
 * and collapses runs of whitespace, and nothing else:
 *
 *  - a legal suffix is stripped only at the END, never mid-string. The earlier `\b(...)\b` form
 *    treated hyphens as word boundaries, so "Co-op Software Engineer" became "-op software
 *    engineer" and "Corp Dev Analyst" became "dev analyst", which then collided with a genuinely
 *    different "Dev Analyst" posting at the same company.
 *  - flattening never returns an empty string for a non-empty input, because a company literally
 *    named "Co" would otherwise share one key with every other such employer.
 */
export function applicationKey(company: string, role: string): string {
  const safeFlatten = (value: string) => {
    const flat = flatten(value);
    return flat.length > 0 ? flat : value.toLowerCase().trim();
  };
  return `${safeFlatten(company)}::${safeFlatten(role)}`;
}

/** Board stages that mean an application was actually sent.
 *
 *  A WHITELIST, deliberately. The previous rule was `stage !== "saved"`, which counted `closed` as
 *  applied — and `closed` is where a student puts a posting that expired, that they lost interest
 *  in, or that was a duplicate. Those they never applied to, and the row would have shown the green
 *  "Applied" statement with no control on it at all, so they could not have applied even if they
 *  wanted to. A missed application is the one failure on this page that cannot be undone. */
const APPLIED_STAGES = new Set(["applied", "interview", "offer"]);

export function isAppliedStage(stage: string): boolean {
  return APPLIED_STAGES.has(stage);
}

/** What the applied check needs off a board card. Structural on purpose, so the tests can build one
 *  without importing the whole API surface. `BoardCard` satisfies it. */
type AppliedCard = {
  job_id?: string | null;
  company: string;
  role: string;
  stage: string;
};

/** What the applied check needs off a job row. `MonitoredJob` satisfies it. */
type AppliedJob = {
  id: string;
  company_name: string;
  title: string;
};

/**
 * The two ways a board card can claim a jobs-list row, kept apart.
 *
 * `ids` holds postings the student demonstrably applied to. `keys` is the company+role fallback
 * described on `applicationKey`, and it is lossy.
 */
export type AppliedIndex = { ids: Set<string>; keys: Set<string> };

/**
 * Index the applied cards so a row can ask whether it is one of them.
 *
 * THE LOAD-BEARING LINE IS THE `else`. A card that carries a job id contributes to `ids` ONLY, and
 * deliberately does not also register its company+role. Registering both would mean an application
 * to the Mountain View posting still put "Airbnb::Software Engineer" in the fallback set, and the
 * NYC posting would match on that and show "Applied" exactly as it wrongly did before. Adding the
 * id would then have changed nothing a student could see. Precise identity, where we have it, has
 * to REPLACE the imprecise one rather than sit alongside it.
 *
 * The reverse is also why the fallback cannot simply be deleted: a card with no id (anything
 * recorded before ids were written, and anything from the extension) would match nothing at all,
 * and every one of those applications would silently stop being marked.
 */
export function buildAppliedIndex(cards: AppliedCard[]): AppliedIndex {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const card of cards) {
    if (!isAppliedStage(card.stage)) continue;
    if (card.job_id) ids.add(card.job_id);
    else keys.add(applicationKey(card.company, card.role));
  }
  return { ids, keys };
}

/**
 * Whether this row is one the student already applied to.
 *
 * A null index means the board has not answered yet, which is NOT "you have applied to nothing":
 * it returns false, so the row offers to apply. That asymmetry is the whole point of this page's
 * error handling: a needless second visit to a posting is recoverable, a wrongly-shown "Applied"
 * is a missed application and is not.
 */
export function isJobApplied(job: AppliedJob, index: AppliedIndex | null): boolean {
  if (!index) return false;
  if (index.ids.has(job.id)) return true;
  return index.keys.has(applicationKey(job.company_name, job.title));
}

/**
 * How many of these postings were first seen since local midnight.
 *
 * Counts THE ROWS IT IS GIVEN, which is the page currently loaded, not the whole board. On a
 * ranked list those rows are the best-fitting ones rather than the newest, so this is "new today
 * among the roles in view" — which is what the badge says, because a number the reader cannot
 * reconcile with what is on screen is worse than a smaller true one.
 */
export function countNewToday(jobs: Pick<MonitoredJob, "first_seen_at">[]): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return jobs.filter((job) => {
    const seen = new Date(job.first_seen_at).getTime();
    // NaN fails this comparison, so a row we cannot date is never counted as new.
    return seen >= midnight.getTime();
  }).length;
}
