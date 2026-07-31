import { connectDedicatedDatabaseClient } from '../db';

const JOB_MONITOR_LOCK_ID = 74_826_531;

type LockClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => void | Promise<void>;
};

type LockConnector = () => Promise<LockClient>;

/**
 * Hold one PostgreSQL session for the whole monitor run so separate serverless invocations cannot
 * independently consume the same provider rate limit. The returned release function is idempotent
 * because both normal completion and an error path may attempt cleanup.
 */
export async function tryAcquireJobMonitorLock(
  connect: LockConnector = connectDedicatedDatabaseClient,
): Promise<(() => Promise<void>) | null> {
  const client = await connect();
  try {
    const result = await client.query(
      'select pg_try_advisory_lock($1) as acquired',
      [JOB_MONITOR_LOCK_ID],
    );
    if (result.rows[0]?.acquired !== true) {
      await client.end();
      return null;
    }
  } catch (error) {
    await client.end();
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const result = await client.query(
        'select pg_advisory_unlock($1) as released',
        [JOB_MONITOR_LOCK_ID],
      );
      if (result.rows[0]?.released !== true) {
        throw new Error('Job-monitor advisory lock was not owned by its dedicated database session');
      }
    } finally {
      await client.end();
    }
  };
}
