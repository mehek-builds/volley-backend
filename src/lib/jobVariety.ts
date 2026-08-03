export const JOB_FAMILIES = [
  'software_engineering',
  'data_analytics',
  'product',
  'design',
  'sales_business_development',
  'marketing_communications',
  'finance_accounting',
  'operations_supply_chain',
  'people_recruiting',
  'legal_compliance',
  'healthcare_clinical',
  'hardware_manufacturing',
  'customer_success_support',
  'research_science',
  'education',
  'other',
] as const;

export type JobFamily = typeof JOB_FAMILIES[number];

export const EMPLOYER_INDUSTRIES = [
  'financial_services',
  'healthcare_life_sciences',
  'aerospace_mobility',
  'consumer_marketplaces',
  'media_gaming',
  'education',
  'technology',
  'unclassified',
] as const;

export type EmployerIndustry = typeof EMPLOYER_INDUSTRIES[number];

/** Coverage warnings are operational signals, not inventory floors. */
export const MINIMUM_JOB_FAMILY_CLASSIFICATION_COVERAGE = 0.8;
export const MINIMUM_INDUSTRY_CLASSIFICATION_COVERAGE = 0.7;
export const MINIMUM_ACTIVE_JOB_FAMILIES = 10;
export const MINIMUM_ACTIVE_EMPLOYER_INDUSTRIES = 6;

type VarietyRow = {
  company_name: string;
  title: string;
  department?: string | null;
  employment_type?: string | null;
  remote: boolean;
  job_country: string;
  ats_name: string;
};

const FINANCIAL = new Set([
  'affirm', 'adyen', 'akuna', 'alloy', 'aqr', 'betterment', 'bitgo', 'block', 'blend',
  'brex', 'btgpactual', 'carta', 'chime', 'cleo', 'coinbase', 'column', 'fireblocks',
  'flow traders', 'found', 'gemini', 'groww', 'imc trading', 'jane street', 'jump trading',
  'man group', 'marqeta', 'marshall wace', 'mercury', 'monzo', 'n26', 'old mission',
  'phonepe', 'point72', 'quadrature', 'qube research & technologies', 'ramp', 'ripple',
  'robinhood', 'sofi', 'stone', 'stripe', 'suade', 'tower research', 'trustly', 'virtu',
  /* The quant and prop-trading half of the 2026-08-03 internship-density round. Sourced as one
     block because it is the densest internship tier the board has, so it is also the block most
     likely to grow again. */
  'optiver', 'worldquant', 'schonfeld', 'squarepoint capital', 'transmarket group',
  'gsa capital', 'vatic labs', 'engineers gate', 'dv trading', 'jump crypto', 'airwallex',
]);

const HEALTH = new Set([
  'abridge', 'amwell', 'betterhelp', 'calm', 'curative', 'doximity', 'elationhealth',
  'freenome', 'ginkgo', 'honor', 'komodohealth', 'modernhealth', 'natera', 'omadahealth',
  'onemedical', 'openevidence', 'papa', 'parsleyhealth', 'recursion', 'science 37',
  'suki', 'talkspace', 'tebra', 'truveta', 'veracyte', 'zocdoc',
  'twist bioscience',
]);

const AEROSPACE_MOBILITY = new Set([
  'flexport', 'ionq', 'lightmatter', 'lucid', 'lyft', 'nuro', 'psiquantum', 'rocket lab',
  'samsara', 'spacex', 'tenstorrent', 'waymo',
  /* Space, defense and robotics from the 2026-08-03 round. Formlabs and Protolabs are advanced
     manufacturing rather than mobility, but this is the set that carries hardware employers and a
     seventh industry for two sources would be a taxonomy change, not a classification. */
  'astranis', 'figure', 'hermeus', 'shield ai', 'vannevar labs', 'skydio', 'motional',
  'formlabs', 'protolabs',
]);

const CONSUMER = new Set([
  'airbnb', 'calendly', 'duolingo', 'faire', 'instacart', 'match group', 'peloton',
  'pinterest', 'quintoandar', 'reddit', 'remote', 'squarespace', 'tripadvisor',
]);

const MEDIA_GAMING = new Set([
  'discord', 'epic games', 'lottie', 'riot games', 'roblox', 'roku', 'scopely', 'spotify',
  'suno', 'take-two', 'twitch',
]);

const EDUCATION = new Set(['elicit', 'khan academy']);

const TECHNOLOGY = new Set([
  'abnormal ai', 'airtable', 'amplitude', 'anthropic', 'asana', 'ashby', 'baseten',
  'braze', 'checkr', 'clickhouse', 'cloudflare', 'cursor', 'databricks', 'datadog',
  'dataiku', 'dropbox', 'elastic', 'elevenlabs', 'figma', 'fivetran', 'gitlab', 'gusto',
  'harvey', 'klaviyo', 'linear', 'mongodb', 'netlify', 'notion', 'openai', 'pagerduty',
  'perplexity', 'postman', 'replit', 'render', 'scale ai', 'supabase', 'twilio', 'vanta',
  'vercel', 'webflow', 'zoominfo',
  // Phase 2 technology employers. Keeping this reviewed list explicit prevents an unknown company
  // from being labelled technology merely because it happens to publish software roles.
  'palantir', 'pure storage', 'sophos', 'verkada', 'cerebras', 'justworks', 'cresta',
  'sigma', 'fastly', 'singlestore', 'jfrog', 'cockroachlabs', 'launchdarkly', 'salesloft',
  'cultureamp', 'nanonets', 'yugabyte', 'veracode', 'starburst', 'buildkite', 'anydesk',
  'bishopfox', 'instabase', 'circleci', 'dremio', 'imply', 'aptoslabs', 'lattice',
  'workboard', 'safebreach', 'openzeppelin', 'consensys', 'blueconic', 'figment', 'decagon',
  'langchain', 'deepgram', 'reflection ai', 'fireworks', 'mixpanel', 'attio', 'modal', 'gamma',
  'astronomer', 'sanity', 'physical intelligence', 'workos', 'crisp', 'braintrust', 'socket',
  'assembled', 'anyscale', 'incident', 'merge', 'semgrep', 'gorgias', 'poolside', 'doppel',
  'blacksmith', 'opal', 'signoz', 'coder', 'llamaindex', 'validio', 'helpscout', 'resend',
  'namespace', 'planetscale', 'railway', 'infisical', 'unit', 'skyflow', 'pinecone', 'stytch',
  'prefect', 'atlan', 'sifflet', 'unstructured', 'kustomer', 'weaviate', 'knock', 'doppler',
  'datafold', 'checkly', 'inkeep', 'zed', 'depot', 'evervault', 'binalyze', 'inngest',
  'hightouch', 'opslevel', 'anomalo', 'orca', 'rutter', 'fullstory', 'graphcore',
  'chainguard', 'sierra', 'crusoe', 'okta', 'box', 'rubrik', 'grafana labs', 'hubspot',
  'mozilla', 'recorded future', 'gong', 'wiz', 'opengov', 'code for america',
  // Infra, security and AI from the 2026-08-03 internship-density round.
  'zscaler', 'etched', 'snowflake', 'cohere', 'together ai',
]);

export function classifyEmployerIndustry(company: string): EmployerIndustry {
  const key = company.trim().toLowerCase();
  if (FINANCIAL.has(key)) return 'financial_services';
  if (HEALTH.has(key)) return 'healthcare_life_sciences';
  if (AEROSPACE_MOBILITY.has(key)) return 'aerospace_mobility';
  if (CONSUMER.has(key)) return 'consumer_marketplaces';
  if (MEDIA_GAMING.has(key)) return 'media_gaming';
  if (EDUCATION.has(key)) return 'education';
  if (TECHNOLOGY.has(key)) return 'technology';
  return 'unclassified';
}

export function classifyJobFamily(title: string, department?: string | null): JobFamily {
  const value = `${title} ${department ?? ''}`.toLowerCase();
  if (/\b(nurse|nursing|clinical|clinician|physician|medical|pharmacy|pharmacist|therapist|caregiver|dentist|patient care)\b/.test(value)) return 'healthcare_clinical';
  if (/\b(counsel|attorney|legal|paralegal|compliance|regulatory|privacy officer)\b/.test(value)) return 'legal_compliance';
  if (/\b(recruit|talent acquisition|human resources|people operations|people partner|hrbp)\b/.test(value)) return 'people_recruiting';
  if (/\b(accounting|accountant|finance|financial|controller|treasury|tax|audit|investment|trader|trading|portfolio|quantitative)\b/.test(value)) return 'finance_accounting';
  if (/\b(customer success|customer support|customer experience|technical support|support engineer|client success|implementation specialist)\b/.test(value)) return 'customer_success_support';
  if (/\b(sales|account executive|account manager|business development|partnerships?|solutions consultant|pre-sales|sales development)\b/.test(value)) return 'sales_business_development';
  if (/\b(marketing|communications?|public relations|content|brand|growth manager|seo|social media)\b/.test(value)) return 'marketing_communications';
  if (/\b(product design|designer|design|ux|ui|creative director|art director)\b/.test(value)) return 'design';
  if (/\b(product manager|product management|product owner|product operations)\b/.test(value)) return 'product';
  if (/\b(data|analytics|analyst|business intelligence|machine learning|ml engineer|artificial intelligence)\b/.test(value)) return 'data_analytics';
  if (/\b(software|developer|development engineer|frontend|front-end|backend|back-end|fullstack|full-stack|devops|site reliability|sre|platform engineer|security engineer|cloud engineer|mobile engineer|ios|android)\b/.test(value)) return 'software_engineering';
  if (/\b(hardware|manufacturing|mechanical|electrical|robotics|avionics|semiconductor|silicon|fabrication|quality engineer|test engineer)\b/.test(value)) return 'hardware_manufacturing';
  if (/\b(operations|supply chain|logistics|procurement|facilities|warehouse|program manager|project manager)\b/.test(value)) return 'operations_supply_chain';
  if (/\b(research|scientist|science|laboratory|lab technician|biologist|chemist|physics|economist)\b/.test(value)) return 'research_science';
  if (/\b(teacher|teaching|education|educator|curriculum|instructor|tutor|professor)\b/.test(value)) return 'education';
  return 'other';
}

function emptyCounts<T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}

function employmentBucket(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (/intern/.test(normalized)) return 'internship';
  if (/contract|temporary|freelance/.test(normalized)) return 'contract';
  if (/part[ -]?time/.test(normalized)) return 'part_time';
  if (/full[ -]?time/.test(normalized)) return 'full_time';
  return 'unstated';
}

export function summarizeJobVariety(rows: readonly VarietyRow[]) {
  const jobFamilies = emptyCounts(JOB_FAMILIES);
  const industries = emptyCounts(EMPLOYER_INDUSTRIES);
  const employmentTypes: Record<string, number> = {
    full_time: 0,
    part_time: 0,
    contract: 0,
    internship: 0,
    unstated: 0,
  };
  const geographies: Record<string, number> = { us: 0, non_us: 0, unknown: 0 };
  const ats: Record<string, number> = {};
  const employers = new Map<string, number>();
  let remote = 0;
  let classifiedJobFamilyPostings = 0;
  let classifiedIndustryPostings = 0;

  for (const row of rows) {
    const family = classifyJobFamily(row.title, row.department);
    jobFamilies[family] += 1;
    if (family !== 'other') classifiedJobFamilyPostings += 1;
    const industry = classifyEmployerIndustry(row.company_name);
    industries[industry] += 1;
    if (industry !== 'unclassified') classifiedIndustryPostings += 1;
    employmentTypes[employmentBucket(row.employment_type)] += 1;
    const geography = row.job_country in geographies ? row.job_country : 'unknown';
    geographies[geography] += 1;
    ats[row.ats_name] = (ats[row.ats_name] ?? 0) + 1;
    const employer = row.company_name.trim().toLowerCase();
    employers.set(employer, (employers.get(employer) ?? 0) + 1);
    if (row.remote) remote += 1;
  }

  const rankedEmployers = [...employers.entries()].sort((a, b) => b[1] - a[1]);
  const top = rankedEmployers[0] ?? [null, 0];
  const total = rows.length;
  let cumulative = 0;
  let employersForHalf = 0;
  for (const [, count] of rankedEmployers) {
    if (cumulative >= total / 2) break;
    cumulative += count;
    employersForHalf += 1;
  }

  return {
    total_postings: total,
    distinct_employers: employers.size,
    job_families: jobFamilies,
    employer_industries: industries,
    job_family_classification_coverage: total === 0
      ? 0
      : Number((classifiedJobFamilyPostings / total).toFixed(3)),
    industry_classification_coverage: total === 0 ? 0 : Number((classifiedIndustryPostings / total).toFixed(3)),
    employment_types: employmentTypes,
    geographies,
    ats,
    remote_postings: remote,
    remote_share: total === 0 ? 0 : Number((remote / total).toFixed(3)),
    concentration: {
      top_employer: top[0],
      top_employer_postings: top[1],
      top_employer_share: total === 0 ? 0 : Number((top[1] / total).toFixed(3)),
      employers_for_half_of_inventory: employersForHalf,
    },
  };
}

export type JobVarietySummary = ReturnType<typeof summarizeJobVariety>;

export function classificationCoverage(summary: JobVarietySummary) {
  const classifiedJobFamilies = summary.total_postings - summary.job_families.other;
  const classifiedIndustries = summary.total_postings - summary.employer_industries.unclassified;
  const jobFamilyMet = summary.total_postings > 0
    && classifiedJobFamilies / summary.total_postings
      >= MINIMUM_JOB_FAMILY_CLASSIFICATION_COVERAGE;
  const industryMet = summary.total_postings > 0
    && classifiedIndustries / summary.total_postings
      >= MINIMUM_INDUSTRY_CLASSIFICATION_COVERAGE;
  const activeJobFamilies = JOB_FAMILIES
    .filter((family) => family !== 'other' && summary.job_families[family] > 0).length;
  const activeEmployerIndustries = EMPLOYER_INDUSTRIES
    .filter((industry) => industry !== 'unclassified' && summary.employer_industries[industry] > 0).length;
  const jobFamilyBreadthMet = activeJobFamilies >= MINIMUM_ACTIVE_JOB_FAMILIES;
  const industryBreadthMet = activeEmployerIndustries >= MINIMUM_ACTIVE_EMPLOYER_INDUSTRIES;
  return {
    minimum_job_family_classification_coverage: MINIMUM_JOB_FAMILY_CLASSIFICATION_COVERAGE,
    minimum_industry_classification_coverage: MINIMUM_INDUSTRY_CLASSIFICATION_COVERAGE,
    minimum_active_job_families: MINIMUM_ACTIVE_JOB_FAMILIES,
    minimum_active_employer_industries: MINIMUM_ACTIVE_EMPLOYER_INDUSTRIES,
    active_job_families: activeJobFamilies,
    active_employer_industries: activeEmployerIndustries,
    job_family_coverage_met: jobFamilyMet,
    industry_coverage_met: industryMet,
    job_family_breadth_met: jobFamilyBreadthMet,
    industry_breadth_met: industryBreadthMet,
    all_coverage_thresholds_met: jobFamilyMet
      && industryMet
      && jobFamilyBreadthMet
      && industryBreadthMet,
  };
}
