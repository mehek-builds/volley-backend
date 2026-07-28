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

const ENTRIES: Entry[] = [
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
];

function careerUrl(ats: JobSourceInput['ats_name'], token: string): string {
  if (ats === 'greenhouse') return `https://job-boards.greenhouse.io/${token}`;
  if (ats === 'lever') return `https://jobs.lever.co/${token}`;
  return `https://jobs.ashbyhq.com/${token}`;
}

export const JOB_SOURCES: JobSourceInput[] = ENTRIES.map(([company_name, ats_name, board_token]) => ({
  company_name,
  ats_name,
  board_token,
  career_url: careerUrl(ats_name, board_token),
  enabled: true,
}));
