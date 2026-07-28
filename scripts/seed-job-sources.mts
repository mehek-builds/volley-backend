/* Load the watched companies into career_page_sources and poll them once.
 *
 *   npx tsx scripts/seed-job-sources.mts --check   probe every board, write nothing
 *   npx tsx scripts/seed-job-sources.mts --seed    upsert the sources only
 *   npx tsx scripts/seed-job-sources.mts           seed, then poll all of them
 *
 * Reads .env.local first, because .env points at localhost and running this
 * against localhost looks exactly like success: it seeds a database nobody
 * serves and production stays empty. Pass --env .env to override.
 *
 * The poll itself is the SAME upsertSources/pollSource the cron uses, imported
 * rather than reimplemented, so a fix to the is_active sweep can never apply to
 * only one of them.
 */

import { config } from 'dotenv';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const envFlag = args.indexOf('--env');
const envFile = envFlag >= 0 ? args[envFlag + 1] : '.env.local';
if (!existsSync(envFile)) {
  console.error(`No ${envFile}. Production credentials live in .env.local; .env is localhost.`);
  process.exit(1);
}
config({ path: envFile });

if (!process.env.DATABASE_URL) {
  console.error(`${envFile} has no DATABASE_URL.`);
  process.exit(1);
}

const { JOB_SOURCES } = await import('../src/lib/jobSources');
const { fetchSourceJobs } = await import('../src/lib/jobMonitor');

const host = process.env.DATABASE_URL.replace(/.*@/, '').split('/')[0];
console.log(`database: ${host}`);
console.log(`sources:  ${JOB_SOURCES.length}\n`);

const checkOnly = args.includes('--check');
const seedOnly = args.includes('--seed');

if (checkOnly) {
  let live = 0;
  let dead = 0;
  let jobs = 0;
  const queue = [...JOB_SOURCES];
  const worker = async () => {
    while (queue.length) {
      const source = queue.shift()!;
      try {
        const found = await fetchSourceJobs(source);
        live += 1;
        jobs += found.length;
        console.log(`  ok    ${String(found.length).padStart(4)}  ${source.ats_name}/${source.board_token}`);
      } catch (error) {
        dead += 1;
        console.log(`  DEAD        ${source.ats_name}/${source.board_token}: ${(error as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`\n${live} live boards, ${jobs} postings, ${dead} dead.`);
  process.exit(dead > 0 ? 1 : 0);
}

const { db } = await import('../src/db/index');
const { career_page_sources } = await import('../src/db/schema');
const { upsertSources, pollSource } = await import('../src/routes/jobMonitor');
const { eq, inArray } = await import('drizzle-orm');
const { pool } = await import('../src/db/index');

await upsertSources(JOB_SOURCES);
console.log(`seeded ${JOB_SOURCES.length} sources.`);

if (seedOnly) {
  await pool.end();
  process.exit(0);
}

const tokens = JOB_SOURCES.map((s) => s.board_token);
const rows = await db.select().from(career_page_sources)
  .where(inArray(career_page_sources.board_token, tokens));

console.log(`polling ${rows.length} sources...\n`);
const started = Date.now();
const results: { company: string; jobs: number; ok: boolean; error?: string }[] = [];
for (let index = 0; index < rows.length; index += 8) {
  const batch = await Promise.all(rows.slice(index, index + 8).map(pollSource));
  for (const r of batch) {
    results.push(r);
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${String(r.jobs).padStart(4)}  ${r.company}${r.ok ? '' : `: ${r.error}`}`);
  }
}

const total = results.reduce((sum, r) => sum + r.jobs, 0);
const failed = results.filter((r) => !r.ok);
console.log(`\n${total} postings from ${results.length - failed.length} sources in ${Math.round((Date.now() - started) / 1000)}s.`);
if (failed.length) console.log(`${failed.length} failed: ${failed.map((f) => f.company).join(', ')}`);

const active = await db.select({ n: career_page_sources.id }).from(career_page_sources).where(eq(career_page_sources.enabled, true));
console.log(`${active.length} sources enabled.`);
await pool.end();
process.exit(failed.length === results.length ? 1 : 0);
