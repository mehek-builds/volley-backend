# Deploying the Litos backend to Vercel

The app is a Fastify server wrapped as a single Vercel serverless function
(`api/index.ts`); `vercel.json` rewrites every path to it and raises the function
timeout to 300s (job polling and resume generation can be long-running). Postgres must be a hosted
serverless database. Your laptop's local Postgres is not reachable from Vercel.

## One-time setup (steps only you can do: account + billing)

### 1. Create a serverless Postgres
Use **Vercel Postgres** (Storage tab → Create → Postgres) or **Neon** (neon.tech).
Copy the **pooled** connection string (Neon: the host ending in `-pooler`). It must
include `sslmode=require`.

The job monitor also uses a dedicated PostgreSQL session for its advisory lock. For Neon, the app
derives the direct hostname by removing `-pooler` from `DATABASE_URL`. For another provider, set
`DATABASE_DIRECT_URL` to a direct, session-pinned connection instead.

### 2. Provision the schema (run once from your machine)
The DB starts empty. From this folder, point drizzle at the new DB and push the schema:

```bash
DATABASE_URL="<your-neon-pooled-url>" npm run db:push
```

Before any later schema change, run the two-direction drift guard. Do not push when
it reports drift:

```bash
npm run schema:check
```

For column or table changes, review the generated SQL before running `db:push`.
For the performance indexes declared in `src/db/schema.ts`, use the idempotent
concurrent installer so production reads and writes can continue:

```bash
npm run db:indexes
```

Install the career-page monitoring tables before enabling the job feed:

```bash
DATABASE_URL="<your-neon-pooled-url>" npm run db:job-monitor
```

### 3. Import the repo on Vercel
vercel.com → Add New → Project → import **mehek-builds/volley-backend**.
Framework preset: **Other**. Leave build/output settings default (Vercel detects
`api/` functions automatically, so no build command is needed).

### 4. Add Environment Variables (Project → Settings → Environment Variables)
Set these for Production (and Preview if you want):

| Key | Value |
|-----|-------|
| `DATABASE_URL` | your Neon/Vercel Postgres **pooled** URL |
| `DATABASE_DIRECT_URL` | optional direct, session-pinned Postgres URL; omit for Neon because it is derived from `DATABASE_URL` |
| `JWT_SIGNING_SECRET` | any 32+ char random string |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID, must match the website's `NEXT_PUBLIC_GOOGLE_CLIENT_ID` |
| `ENCRYPTION_KEY` | any 32+ char random string, encrypts `application_profile` columns at rest |
| `BLOB_READ_WRITE_TOKEN` | Vercel Storage tab -> Create -> Blob; stores generated resume files |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `HUNTER_API_KEY` | your Hunter key |
| `REOON_API_KEY` | your Reoon key (optional) |
| `BOUNCEBAN_API_KEY` | your BounceBan key (optional) |
| `APOLLO_API_KEY` | your Apollo key (optional fallback) |
| `INTERNAL_CRON_SECRET` | random secret shared with the GitHub Actions job-monitor workflow |
| `JOB_MONITOR_SOURCES_JSON` | optional JSON array of extra Greenhouse, Lever, Ashby, or Workable boards loaded by each daily monitor run |
| `LEMONSQUEEZY_CHECKOUT_URL` | reusable live product URL containing `/checkout/buy/` |
| `LEMONSQUEEZY_VARIANT_ID` | numeric ID of the $49.99 monthly Pro variant |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | signing secret configured on the Lemon Squeezy webhook |
| `NODE_ENV` | `production` |

The reviewed source list lives in `src/lib/jobSources.ts`; use `JOB_MONITOR_SOURCES_JSON` only for
temporary additions that cannot wait for a code review. In GitHub, add `INTERNAL_CRON_SECRET` as an
Actions secret with the same value used by Vercel. Optionally set the `LITOS_API_BASE` Actions
variable when the API is not hosted at `https://student-outreach-backend.vercel.app`.

Vercel starts the monitor daily at 06:00 UTC. The GitHub Actions workflow starts ten minutes later
and makes up to five bounded follow-up passes to drain a large source queue. It fails visibly when
sources fail, polling remains incomplete, or the 14-day surfaced board drops below an inventory
floor. Each pass writes raw postings, distinct grouped roles, sponsor-only postings, and variety
metrics to the workflow summary. The hard full-board floors are 10,000 postings and 10,000 grouped
roles. Posting headroom warns below 12,000, while grouped-role headroom warns below 11,000.

Before enabling Google sign-in, add the identity column without touching existing users:

```bash
npm run db:google-auth
```

Before deploying password-auth code, apply its additive migration first:

```bash
vercel env run -e production -- node scripts/apply-password-auth-migration.mjs
```

The migration adds nullable `password_hash` and non-null `session_version`
columns. It is safe to run more than once and old application versions ignore
both columns, so the required order is migration first, API deploy second, web
deploy last. Roll back application code without rolling back these columns.

Password authentication uses these contracts:

- `POST /auth/password/login` accepts `{ "email": "...", "password": "..." }`.
  It returns `{ "token": "...", "email": "..." }` or the same
  `invalid_credentials` response for an unknown email and a wrong password.
- `PUT /auth/password` requires a Bearer session and accepts
  `{ "password": "...", "current_password": "..." }`. A Google or email-code
  session issued within the last 15 minutes may omit `current_password` for
  first-time setup or recovery.
- A successful password update rotates `session_version`. The response token
  replaces the caller's old token, and every older token becomes invalid.
- Passwords are normalized with Unicode NFC, must be 15 to 128 characters, and
  are stored only as salted Argon2id hashes. Configure the rate-limit variables
  documented in `.env.example` when production needs limits other than defaults.

Before enabling Lemon Squeezy checkout, add the subscription state columns:

```bash
npm run db:lemon-squeezy
```

In Lemon Squeezy, configure a webhook at
`https://student-outreach-backend.vercel.app/billing/lemonsqueezy-webhook` and
subscribe to `subscription_created` and `subscription_updated`. Use the same
secret for the webhook and `LEMONSQUEEZY_WEBHOOK_SECRET`. Keep
`LEMONSQUEEZY_ACCEPT_TEST_MODE` unset in production.

`VERCEL` is set automatically by Vercel. That disables the local listener.
Do **not** set `PORT`/`HOST` (serverless ignores them).

### 5. Deploy
Click Deploy. Then verify:

```bash
curl https://<your-app>.vercel.app/health      # -> {"status":"ok",...}
```

## Point the extension at the deployed backend
In `student-outreach-extension`, create `.env` with:

```
VITE_API_BASE=https://<your-app>.vercel.app
```

Then rebuild: `npm run build`, and reload the unpacked extension in Chrome
(`chrome://extensions` → Litos → reload). The popup + Apply flow now hit Vercel.

## Notes
- **Cold starts:** the free tier sleeps; first request after idle is slow (~1-3s).
- **CORS** allows configured web origins and Chrome extension origins.
- **Function timeout** is 300s. Polling stops starting new work early enough to return metrics and
  leave deferred sources for the next bounded pass.
