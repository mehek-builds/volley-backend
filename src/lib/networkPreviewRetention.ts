import { and, eq, isNull, lte } from 'drizzle-orm';
import { db } from '../db';
import { network_imports } from '../db/schema';

export async function purgeExpiredNetworkImportPreviews(now = new Date()): Promise<number> {
  const rows = await db.update(network_imports).set({
    status: 'expired',
    preview_rows: null,
  }).where(and(
    eq(network_imports.status, 'previewed'),
    isNull(network_imports.deleted_at),
    lte(network_imports.expires_at, now),
  )).returning({ id: network_imports.id });
  return rows.length;
}
