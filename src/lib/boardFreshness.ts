/* The one read behind every "is the board still being fed" answer.
 *
 * Shared by the /internal/job-monitor/ingestion-health route and by the in-process stall monitor
 * so the two can never drift into disagreeing about what freshness means. If the endpoint and the
 * alarm sampled the board differently, a red run would stop meaning exactly one thing, which is
 * the property the alert is built around.
 *
 * NO MONITOR LOCK, for the route's original reason: this is a read, and a health check that
 * cannot run while the thing it watches is busy goes quiet exactly when it matters most.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { monitored_jobs } from '../db/schema';
import type { BoardFreshness } from './ingestionStallMonitor';

export async function readBoardFreshness(): Promise<BoardFreshness> {
  const [row] = await db.select({
    newest_seen_at: sql<Date | null>`max(${monitored_jobs.last_seen_at})`,
    active_jobs: sql<number>`count(*)::int`,
  }).from(monitored_jobs).where(eq(monitored_jobs.is_active, true));
  return { newest_seen_at: row?.newest_seen_at ?? null, active_jobs: row?.active_jobs ?? 0 };
}
