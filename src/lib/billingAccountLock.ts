import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/node-postgres';
import { connectDedicatedDatabaseClient, db } from '../db';
import * as schema from '../db/schema';

type LockClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => void | Promise<void>;
};

type LockConnector = () => Promise<LockClient>;

const heldAccountLocks = new AsyncLocalStorage<ReadonlyMap<string, typeof db>>();

/**
 * Serialize checkout decisions with every local billing projection for one account.
 *
 * Checkout terms are a snapshot of entitlement and provider ownership. The lock protects each
 * local reservation or projection decision that reads and then writes that state. Stripe I/O stays
 * outside the lock; checkout reacquires it after Stripe returns and validates the reserved policy
 * before any URL can leave the process. A dedicated PostgreSQL session is required because the
 * protected work can span several pooled queries and transactions.
 *
 * Nested calls are common: checkout may reconcile an older completed Session while it already
 * owns this account lock. Async-local ownership makes that path reentrant without trying to acquire
 * the same advisory lock from a second database session and deadlocking itself.
 */
export async function withBillingAccountLock<T>(
  userId: string,
  operation: (lockedDb: typeof db) => Promise<T>,
  connect: LockConnector = connectDedicatedDatabaseClient,
): Promise<T> {
  const lockName = `entitlement:${userId}`;
  const inherited = heldAccountLocks.getStore();
  const inheritedDb = inherited?.get(lockName);
  if (inheritedDb) return operation(inheritedDb);

  const client = await connect();
  let acquired = false;
  try {
    await client.query(
      'select pg_advisory_lock(hashtextextended($1, 0::bigint))',
      [lockName],
    );
    acquired = true;
    const lockedDb = drizzle(client as never, { schema }) as unknown as typeof db;
    const owned = new Map(inherited ?? []);
    owned.set(lockName, lockedDb);
    return await heldAccountLocks.run(owned, () => operation(lockedDb));
  } finally {
    try {
      if (acquired) {
        const result = await client.query(
          'select pg_advisory_unlock(hashtextextended($1, 0::bigint)) as released',
          [lockName],
        );
        if (result.rows[0]?.released !== true) {
          throw new Error('Billing account advisory lock was not owned by its dedicated database session');
        }
      }
    } finally {
      await client.end();
    }
  }
}
