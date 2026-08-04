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
| `UPSTASH_REDIS_REST_URL` | optional, turns on the ranking cache's shared tier; see below |
| `UPSTASH_REDIS_REST_TOKEN` | optional, pairs with the URL above |
| `NODE_ENV` | `production` |

### The ranking cache's shared tier is OPTIONAL and ships OFF

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are not set by default, and until
both are, `src/lib/rankingCache.ts` runs its L1 tier only: a process `Map` with a 60 second
TTL, on serverless. That map is cold far more often than warm, and every cold miss re-reads
scoring text for the whole ranking pool out of Neon.

That is what exhausted Neon's 5 GB/month transfer allowance on 2026-08-04 and suspended the
database, so **this is the largest single saving available and it is inert until configured.**
Create a database at upstash.com (free tier: 256 MB, 500k commands/month), copy its REST URL
and token into the Vercel project, and redeploy.

**Verify it actually took effect**, because env var changes on Vercel do not reach a
running deployment until it is rebuilt, so the dashboard can show them set while the
function still runs L1 only:

```bash
curl -s https://student-outreach-backend.vercel.app/health
```

`"ranking_cache": "shared"` means L1 plus Upstash. `"local"` means L1 only and the
variables have not reached the running build. The field reports names, never values. Nothing else changes: unconfigured, the code
path is a deliberate no-op, which is why it was safe to ship ahead of the database existing.

The reviewed source list lives in `src/lib/jobSources.ts`; use `JOB_MONITOR_SOURCES_JSON` only for
temporary additions that cannot wait for a code review. In GitHub, add `INTERNAL_CRON_SECRET` as an
Actions secret with the same value used by Vercel. Optionally set the `LITOS_API_BASE` Actions
variable when the API is not hosted at `https://student-outreach-backend.vercel.app`.

Vercel starts the monitor daily at 06:00 UTC. The GitHub Actions workflow starts ten minutes later
and makes up to five bounded follow-up passes to drain a large source queue. It fails visibly when
sources fail, polling remains incomplete, or the 14-day surfaced board drops below an inventory
floor. Each pass writes raw postings, distinct grouped roles, sponsor-only postings, and variety
metrics to the workflow summary. Each invocation selects at most 400 oldest sources, so source 401
starts a follow-up segment rather than extending one serverless run. Follow-up passes carry the
first response's `drain_started_at` watermark, so each source is attempted once per drain run. The hard full-board floors are
10,000 postings and 10,000 grouped roles. Posting headroom warns below 12,000, while grouped-role
headroom warns below 11,000. The summary also warns when job-family or employer-industry coverage
misses its configured threshold, or when any distinct user-entered target role returns zero jobs.
If the bounded target-role query times out, monitoring reports `measurement_available=false` and
keeps that coverage threshold unhealthy without aborting the inventory monitor.

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

### `description_digest` — MIGRATION MUST RUN BEFORE THE NEXT API DEPLOY

**Pass `DATABASE_URL` explicitly. Do not run this bare.** Like every script in
`scripts/`, this one does `import 'dotenv/config'`, which loads `.env` — and the
`DATABASE_URL` in `.env` is a LOCAL Postgres. Run bare, it connects to localhost,
reports `ready: column present`, and production is untouched. Production is the
Neon URL in `.env.local`:

```bash
DATABASE_URL="<the DATABASE_URL from .env.local>" npm run db:description-digest
```

The script prints the database and host it connected to before it changes
anything, which is the check that catches this. Applied to production on
2026-08-04: `connected to neondb`, then `0 of 22134 active postings have a
digest`, which is the correct output (see the no-backfill note below).

**This one is not optional and the order is not symmetrical with the case above.**
`GET /jobs` selects `monitored_jobs.description_digest` directly, so deploying the
API against a database that does not have the column makes every ranked board
request fail. An old application version ignores the column safely; a new one
cannot tolerate its absence.

So: **migration first, API deploy second.** The script uses
`ADD COLUMN IF NOT EXISTS`, so it is safe to run repeatedly and safe to run
against a database that already has it.

The column is nullable and **deliberately not backfilled**. Backfilling would
read every description out of Neon to compute a value the daily poll rewrites
for free, spending the exact transfer allowance the column exists to save. The
read path coalesces to the old capped prefix, so the board is correct from the
moment the column lands, and it fills itself within one poll cycle. Expect
`0 of N active postings have a digest` immediately after the migration; that is
the correct output, not a failure.

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

## Shipping a change

**Merging to `main` deploys production.** The Vercel project is connected to
`mehek-builds/volley-backend` with `main` as the production branch, so a merged PR builds and
promotes on its own. Nothing needs to be run by hand.

That connection was missing between an unknown date and 2026-08-04: the project's `link` was
`null`, so pushes to `main` deployed nothing and production silently sat on whatever commit was
last pushed with `vercel deploy --prod`. PRs #151 and #153 both merged without shipping. If a merge
ever stops deploying again, check the link first, because the symptom is silence rather than a
failure:

```bash
vercel git connect          # from a checkout whose origin is the GitHub repo
```

**Always confirm what actually shipped.** `/health` returns the deployed commit, so compare it to
the merge commit rather than assuming the deploy landed:

```bash
curl -s https://student-outreach-backend.vercel.app/health | jq -r '.revision, .build'
git rev-parse origin/main
```

`revision` is the git SHA and is the one to read: it compares to `git rev-parse origin/main` without
leaving the terminal. **It is sometimes `null` on a hand deploy**, and that is not a failed deploy.
It caught us on 2026-08-04: the deployment was live, correct and serving the production alias while
`/health` said `null`, and confirming what shipped took three Vercel API calls. The condition is not
fully pinned down — of two `vercel deploy --prod` deployments that afternoon, the one whose Vercel
metadata carried `gitCommitSha` served `null` and the one carrying `githubCommitSha` was never
polled before the alias moved on.

`build` is what to use then. It is the deployment id (or the deployment hostname on older builds)
and is always present, so an empty `revision` never leaves you with nothing:

```bash
BUILD=$(curl -s https://student-outreach-backend.vercel.app/health | jq -r .build)
vercel inspect "$BUILD"        # resolves to the deployment, and through it to the commit
```

Both being `null` means the API is not running on Vercel at all, which is the one case that really
is a problem.

To deploy by hand anyway (a rollback, or a hotfix that must not wait for review), use a throwaway
clone so your own working tree, which is often on another branch with uncommitted work, is left
alone. Copy `.vercel/project.json` into it, and **not** `.env.production.local`:

```bash
git clone https://github.com/mehek-builds/volley-backend.git /tmp/ship && cd /tmp/ship
mkdir -p .vercel && cp <repo>/.vercel/project.json .vercel/
vercel deploy --prod
```

## How the database TLS config actually resolves

Worth reading before touching `DATABASE_URL` or the `ssl` option, because the precedence is the
opposite of what the code looks like.

`src/db/index.ts` passes **both** a `connectionString` and an `ssl` option. pg resolves them with
`Object.assign({}, config, parse(config.connectionString))` (`connection-parameters.js:58`), so the
**connection string wins** and the `ssl` option is only a fallback.

`withVerifiedSslMode` therefore makes the string say what we mean: it rewrites
`require`/`prefer`/`verify-ca` to `verify-full` (which pg already treats them as, so nothing changes
about how it connects), **and declares `sslmode=verify-full` when the URL declares nothing**.

| `DATABASE_URL` | resolved `ssl` at `tls.connect` | certificate verified? |
|---|---|---|
| `?sslmode=require` | `{}` | **yes** |
| `?sslmode=verify-full` | `{}` | **yes** |
| no `sslmode` | `{}` | **yes** (was **no** before 2026-08-04) |
| `?sslmode=disable` | `false` | no TLS, honoured as configured |

**The row that changed is the third.** Verification used to be on only by accident of Neon putting
`sslmode` in the URL. Dropping that one parameter from the environment would have silently turned
certificate checking off, with no error, no log line and no failing test. The code now states the
intent, and the environment cannot quietly override it downward. `sslmode=disable` is still
honoured, because it means something and is a deliberate choice where it appears.

The `ssl` option is `{ rejectUnauthorized: true }` (`sslOptionForHost`) and is mostly dead: the
string beats it wherever it parses. It decides only for a connection string `new URL` cannot read (a
multi-host string, or a password with an unencoded `/`), and there it fails **safe**. It used to
fail open.

An earlier version of this section, and of the code, claimed the explicit `ssl` option won and
therefore **deleted** `sslmode`. That was backwards and would have ended certificate verification on
every production connection. `src/db/index.test.ts` asserts on `ConnectionParameters` (what pg
derives) rather than on `pool.options` (what you passed in), and reads the fallback from
`sslOptionForHost` rather than redeclaring it — both are the difference between a test with teeth
and a tautology.

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
