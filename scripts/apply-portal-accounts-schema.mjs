#!/usr/bin/env node

/* The account Litos holds for an account-walled portal family.
 *
 * ---------------------------------------------------------------------------------------------
 * HOW TO RUN THIS: BY HAND, AGAINST PRODUCTION, BEFORE MERGING THE BRANCH THAT DECLARES THE TABLE.
 *
 *   DATABASE_URL='<the production connection string>' npm run db:portal-accounts
 *
 * Same ordering, and for the same reason, as apply-restrictive-agreements-schema.mjs. A NEW TABLE is
 * gentler than a new column - Drizzle cannot name a table nobody inserts into - but the ordering
 * still holds: the moment portalAccountVault ships, any route that reaches it 500s if the table is
 * absent, and a 500 on a credential path is the worst place to discover a migration was skipped.
 *
 * Safe to run more than once. Every statement is IF NOT EXISTS and the verification below asserts
 * the shape rather than the act, so a re-run on a database that already has the table is a no-op
 * that still proves the table is right.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE TABLE LOOKS LIKE THIS.
 *
 * ONE ROW PER (user, family, tenant). These portals scope an account to the employer's own tenant:
 * an iCIMS login at one company is worthless at the next, so "one account per portal" would be
 * wrong and "one per application" would mint a new account for every posting at the same employer.
 * The unique index is load-bearing rather than decorative - it is what makes ensurePortalAccount
 * idempotent, and these portals lock an address after a few failed sign-ins, so minting a second
 * password for an account that already has one is precisely how an address gets locked.
 *
 * secret_ciphertext IS NULLABLE, and null is a real state: the row may exist before a credential
 * does. It holds AES-256-GCM output from encryptField, the same primitive the application profile
 * uses for phone and address. It is never stored in plaintext and never leaves the server; the only
 * function that decrypts it is readSecretForManagedRun, which exists so the managed runner can type
 * it into the portal's own login form.
 *
 * status DEFAULTS TO 'pending' AND NOTHING HERE PROMOTES IT. Creating a row is bookkeeping. Claiming
 * the account exists at the employer is a claim about the outside world, and this codebase's rule is
 * that such a claim comes from an observation, not from the act that hoped to produce it. Only an
 * observed sign-in moves a row to 'active'.
 *
 * NO INDEX ON login_email ON PURPOSE. It is a Litos alias, it is already covered by the identity
 * index for every lookup this module performs, and a standalone index on an address is a convenient
 * way to enumerate them.
 */

import pg from 'pg';

const REQUIRED_COLUMNS = {
  id: { data_type: 'uuid', is_nullable: 'NO' },
  user_id: { data_type: 'uuid', is_nullable: 'NO' },
  portal_family: { data_type: 'text', is_nullable: 'NO' },
  tenant: { data_type: 'text', is_nullable: 'NO' },
  login_email: { data_type: 'text', is_nullable: 'NO' },
  // Nullable is the point: a row may exist before a credential does.
  secret_ciphertext: { data_type: 'text', is_nullable: 'YES' },
  status: { data_type: 'text', is_nullable: 'NO' },
  last_verified_at: { data_type: 'timestamp with time zone', is_nullable: 'YES' },
  created_at: { data_type: 'timestamp with time zone', is_nullable: 'NO' },
  updated_at: { data_type: 'timestamp with time zone', is_nullable: 'NO' },
};

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`
      create table if not exists portal_accounts (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        portal_family text not null,
        tenant text not null,
        login_email text not null,
        secret_ciphertext text,
        status text not null default 'pending',
        last_verified_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await client.query(`
      create index if not exists portal_accounts_user_id_idx on portal_accounts (user_id)
    `);
    await client.query(`
      create unique index if not exists portal_accounts_identity_idx
        on portal_accounts (user_id, portal_family, tenant)
    `);
    await client.query('commit');

    const { rows } = await client.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_name = 'portal_accounts'`,
    );
    const found = new Map(rows.map((row) => [row.column_name, row]));
    for (const [column, expected] of Object.entries(REQUIRED_COLUMNS)) {
      const row = found.get(column);
      if (!row) throw new Error(`portal_accounts.${column} is missing`);
      if (row.data_type !== expected.data_type) {
        throw new Error(`portal_accounts.${column} is ${row.data_type}, expected ${expected.data_type}`);
      }
      if (row.is_nullable !== expected.is_nullable) {
        throw new Error(
          `portal_accounts.${column} nullability is ${row.is_nullable}, expected ${expected.is_nullable}`,
        );
      }
    }

    /* The unique index is asserted by NAME rather than by counting indexes, because the idempotence
     * of ensurePortalAccount rests on it and a table that merely has "an index" is not the same
     * claim. Without this, a partially applied migration reports success and the first duplicate
     * credential is discovered by a locked employer account. */
    const { rows: indexes } = await client.query(
      `select indexname from pg_indexes where tablename = 'portal_accounts'`,
    );
    const names = new Set(indexes.map((row) => row.indexname));
    for (const required of ['portal_accounts_identity_idx', 'portal_accounts_user_id_idx']) {
      if (!names.has(required)) throw new Error(`portal_accounts is missing index ${required}`);
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  console.log('Ready: portal_accounts is present with its identity index.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Portal accounts schema failed:', message);
  process.exit(1);
});
