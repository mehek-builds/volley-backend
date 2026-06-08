import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';
import path from 'path';

async function runMigrations() {
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: path.join(__dirname, '../../drizzle') });
  console.log('Migrations complete.');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
