const pg = require('pg');
const userId = process.argv[2];
const grantOnly = process.argv.includes('--grant-only');
if (!/^[0-9a-f-]{36}$/.test(userId || '')) { console.error('bad user id'); process.exit(2); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  await c.connect();
  if (!grantOnly) {
    await c.query('delete from "experience_bank" where "user_id" = $1', [userId]);
    await c.query(`update "profiles" set "parsed_json" = '{}'::jsonb, "base_resume_json" = null, "skills" = null where "user_id" = $1`, [userId]);
  }
  await c.query('update "users" set "onboarding_build_granted_at" = null where "id" = $1', [userId]);
  console.log('reset');
  await c.end();
})().catch((e) => { console.error(String(e.message).replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]')); process.exit(1); });
