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
| `POSTHOG_PROJECT_TOKEN` | public PostHog ingestion token (`phc_...`), the same one the website bundle ships. **Account-creation events are silently not sent without it**, by design, so the module is safe to deploy first and switch on after |
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
| `LITOS_ATS_API_SUBMISSION_ENABLED` | set to literal `true` only when employer-authorized ATS submission channels may POST applications |
| `LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON` | JSON array of allowlisted Greenhouse, Ashby, or Lever submit channels; references key env names, never raw secrets |
| `LITOS_APPLICATION_EMAIL_ROUTE_MODE` | nonsecret route selector: `managed_resend`, `custom_domain`, or `mailbox` |
| `LITOS_RESEND_MANAGED_RECEIVING_DOMAIN` | exact one-label `*.resend.app` receiving domain selected by `managed_resend` |
| `LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN` | hidden 32+ character random token deriving the exact one-time managed receiving canary recipient |
| `LITOS_APPLICATION_EMAIL_DOMAIN` | domain that receives employer application mail for generated aliases, for example `apply.trylitos.com` |
| `LITOS_APPLICATION_EMAIL_MAILBOX` | rollback mailbox route using plus-addressed per-application aliases |
| `LITOS_APPLICATION_EMAIL_ALIAS_SECRET` | stable secret used to mint opaque per-application alias local parts |
| `RESEND_WEBHOOK_SECRET` | Resend `email.received` webhook signing secret, returned when the webhook is created |
| `LITOS_INBOUND_EMAIL_WEBHOOK_SECRET` | compatibility HMAC secret for signed non-Resend `POST /application-email/inbound` calls |
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
Provision it through the Vercel marketplace rather than copying a token by hand. This
creates the database, connects it, and injects the credentials in one step:

```bash
vercel integration add upstash/upstash-kv --plan free -m primaryRegion=iad1 \
  -m autoUpgrade=false -m eviction=true -e production \
  -n litos-ranking-cache --no-env-pull
```

`autoUpgrade=false` is deliberate and must not be dropped: it defaults to TRUE, which moves
the resource onto Pay As You Go ($0.2 per 100K commands) on hitting free limits.
`--no-env-pull` is also deliberate: env pull writes a local env file and can clobber the
`.env.local` holding the Neon production URL. `iad1` matches where the functions execute and
where Neon lives. `-e production` only, so preview deployments do not share cached rankings
with production while running different ranking code.

The integration injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`, NOT the
`UPSTASH_REDIS_REST_*` names. The code accepts either pair, so nothing needs renaming.

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
curl -i https://<your-app>.vercel.app/health   # -> 200 {"status":"ok","database":"ok",...}
```

`/health` queries the database (`select 1`) and answers **503 with `"status":"degraded"`** when it
cannot reach it. That is deliberate: before 2026-08-04 this endpoint touched nothing, so it answered
200 through a 75-minute outage in which every other route returned 500. `database_reason` narrows it
immediately: `quota` means the Neon transfer allowance is spent, `refused` a dead or unreachable
compute, `timeout` a saturated one. See docs/incidents/2026-08-04-neon-transfer-quota.md.

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
the merge commit rather than assuming the deploy landed. Every identity field is present on a 503 as
well as a 200, so this still works while the database is down, which is exactly when you are most
likely to be deploying:

```bash
curl -s https://student-outreach-backend.vercel.app/health | jq -r '.revision, .build'
git rev-parse origin/main
```

`revision` is the git SHA and is the one to read: it compares to `git rev-parse origin/main` without
leaving the terminal. `revision_source` tells you which mechanism supplied it, which is what makes a
missing SHA diagnosable instead of merely disappointing:

| `revision_source` | what it means |
|---|---|
| `vercel-git` | The GitHub integration deployed it. The normal path. |
| `git-sha` | A CLI deploy that went through `npm run deploy:prod`. |
| `none` | A bare `vercel --prod`. The SHA is genuinely unknown; use `build`. |

**Manual deploys must target the real backend project.** `npm run deploy:prod` refuses to run unless
`.vercel/project.json` points at `student-outreach-backend` with project id
`prj_5gPI7ADAT5M26VIxhiAKe1efsJPi`. A temporary worktree without that file can create a new
temp-named Vercel project instead of shipping Litos production.

**ATS API submit config is opt-in and exact.** `LITOS_ATS_API_SUBMISSION_ENABLED` must be the
literal string `true`; an empty variable, `1`, or `false` leaves ATS API posting disabled. Public
job-board reads can work without this, but application POSTs still need an allowlisted channel in
`LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON` plus the referenced employer-authorized key env vars.

**Application email routing is separate from ATS submission.** Set
`LITOS_APPLICATION_EMAIL_ROUTE_MODE` to select exactly one route. `managed_resend` uses only
`LITOS_RESEND_MANAGED_RECEIVING_DOMAIN`; the legacy `LITOS_APPLICATION_EMAIL_DOMAIN` and
`LITOS_APPLICATION_EMAIL_MAILBOX` values may remain deployed for rollback and are ignored until
their matching mode is selected. Managed receiving remains disabled until a fresh, signed
`email.received` webhook for the exact one-time canary recipient stores a recent durable proof, and
the exact active `email.received` webhook is verified. The proof is bound to mode, domain, alias
secret, canary token, endpoint, webhook signing secret, and Receiving API key, so rotating any of
them fails closed. The proof is stored only after the canary content can be fetched through Resend's
Receiving API. A sending-only key or a key from the wrong Resend account therefore cannot make
health report the route as deliverable. An invalid mode selects no route. With no mode, the previous
compatibility behavior remains: legacy mailbox precedes legacy domain, managed receiving works only
when neither legacy route is present, and ambiguous managed-plus-legacy configuration fails closed.

When the selected route is proven deliverable, submission packets use a per-application Litos alias
as the applicant email and keep the user's verified account email as the forwarding destination.
Point the inbound email provider for that domain at `POST /webhooks/application-email/inbound`. The caller must
send Resend's `svix-id`, `svix-timestamp`, and `svix-signature` headers, verified against
`RESEND_WEBHOOK_SECRET`. Non-Resend test providers can send `X-Litos-Webhook-Timestamp` as epoch milliseconds and `X-Litos-Webhook-Signature` as
`hex(hmac_sha256(LITOS_INBOUND_EMAIL_WEBHOOK_SECRET, timestamp + "." + JSON.stringify(body)))`
within a five minute freshness window. The webhook stores the inbound message against the
application, forwards it to the user through Resend, and sets replies to go back to the original
employer sender. This handles receipts, ordinary verification-code emails, and recruiter replies;
it does not solve CAPTCHA, account walls, or missing employer-authorized ATS API channels.

`RESEND_RECEIVING_API_KEY` may hold a dedicated key from the Resend account that owns the managed
receiving domain. When it is absent, inbound reads fall back to `RESEND_API_KEY`. The selected key
must be authorized for `GET /emails/receiving/:id`; `RESEND_API_KEY` remains the outbound sending
key.

To create or reuse the Resend webhook when a readable `RESEND_API_KEY` is available locally:

```bash
npm run setup:application-email-resend
```

That script registers `email.received` for
`https://student-outreach-backend.vercel.app/webhooks/application-email/inbound` and stores the
returned signing secret in Vercel as `RESEND_WEBHOOK_SECRET`.

The managed receiving proof table has a separate additive migration:

```bash
npm run db:application-email-receiving-proof
```

After its workflow is present on `main`, an operator may run
`Application email receiving proof migration` from GitHub Actions. The workflow refuses non-main
refs, reads the database connection only from `SCHEMA_CHECK_DATABASE_URL`, and applies only the
idempotent `application_email_receiving_proofs` table and its two indexes.

After applying that migration, configure a fresh hidden canary token before enabling managed
receiving. The setup command sends the random token to Vercel over stdin and never prints the token
or derived recipient. It does not deploy or send a canary by itself:

```bash
npm run setup:application-email-receiving-canary
```

After a deployment containing that token, deliver one canary to the exact derived recipient using
a trusted operator-only process. Proof storage first reads the canary through the configured
Receiving API key. The signed webhook records only a message-ID hash, route
fingerprint, proof version, domain, and timestamp. Health, errors, logs, and the database never
contain the canary recipient or token. A proof expires after seven days; rotate the one-time token
and repeat the canary when renewing it.

**Why a hand deploy used to report `null`.** Measured 2026-08-04 across the last 12 production
deployments: Vercel fills the `VERCEL_GIT_*` variables from the **GitHub integration's** metadata,
whose keys carry a `github` prefix. A `vercel --prod` from a laptop attaches its own git metadata
under a shorter `git` prefix read from the local checkout, and that shape is not projected into the
environment. 11 of the 12 were `source: git` and reported a revision; the 1 `source: cli` did not.
This is no longer a mystery and `npm run deploy:prod` closes it by passing the SHA explicitly.

`build` is the deployment id and is always present, so an empty `revision` never leaves you with
nothing:

```bash
BUILD=$(curl -s https://student-outreach-backend.vercel.app/health | jq -r .build)
vercel inspect "$BUILD"        # resolves to the deployment, and through it to the commit
```

`build` being `null` too means the API is not running on Vercel at all, which is the one case that
really is a problem.

### Deploying by hand

Use the script. It ships the working tree, so it refuses a dirty one, refuses a tree that is not a
descendant of `origin/main`, and passes the SHA so `/health` can identify it:

```bash
npm run deploy:prod
```

**The ancestor guard is the important one.** A CLI deploy ships your tree, not a branch, and these
checkouts are worked by several agents at once. Deploying from a checkout that is behind `main`
silently reverts whatever landed in between, and nothing in the Vercel UI would show it: the
deployment is green, Ready and holding the alias. On 2026-08-04 a CLI deploy replaced a GitHub
deployment of the same commit 18 seconds after it, which was harmless only because the trees
happened to match.

For a deliberate rollback to an older commit, that guard is exactly what you want to skip:

```bash
FORCE=1 npm run deploy:prod
```

## Employer-portal accounts (iCIMS)

iCIMS shows no application form until an account exists on the employer's tenant, so Litos can
register one. The account address is the per-application Litos alias, which keeps verification,
confirmation and interview mail arriving on the same route as every other employer message. The
password is generated per tenant from the CSPRNG and stored as AES-256-GCM ciphertext in
`portal_credentials`, under the same `ENCRYPTION_KEY` as the encrypted profile columns.

**`ENCRYPTION_KEY` is not rotatable on its own** (see `src/lib/fieldCrypto.ts`). Losing it now also
means losing every stored portal password, and those open accounts that still exist on employer
systems. Treat it accordingly.

The table has its own additive migration:

```bash
npm run db:portal-credentials
```

After its workflow is present on `main`, an operator may run `Portal credentials migration` from
GitHub Actions. The workflow refuses non-main refs, reads the connection only from
`SCHEMA_CHECK_DATABASE_URL`, and applies only the idempotent `portal_credentials` table and its two
indexes.

Two routes serve the owner, and only the owner: `GET /portal-credentials` lists the accounts and
never returns a password, and `POST /portal-credentials/:id/reveal` returns exactly one password,
rate limited hourly and counted on the row. A credential is readable only by the user who owns it.

Registration itself is behind `LITOS_ICIMS_ACCOUNT_REGISTRATION`, which is off unless it is exactly
`1` or `true`. Before turning it on: capture a live iCIMS account form and confirm the three
unverified selectors in `src/lib/icimsAccountRegistration.ts`, and update the privacy policy on the
website, because storing an employer-portal password is a new category of stored data. Creating an
account is not submitting an application: `programmaticSubmit` stays false for iCIMS.

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

`uselibpqcompat=true` is left alone entirely: under it `require` carries real libpq semantics, so
rewriting it would silently tighten a connection someone deliberately loosened.

**The row that changed is the third.** Verification used to be on only by accident of Neon putting
`sslmode` in the URL. Dropping that one parameter from the environment would have silently turned
certificate checking off, with no error, no log line and no failing test. The code now states the
intent, and the environment cannot quietly override it downward. `sslmode=disable` is still
honoured, because it means something and is a deliberate choice where it appears.

The `ssl` option is `{ rejectUnauthorized: true }` (`sslOptionForHost`) and is mostly dead: the
string beats it wherever pg can read a mode out of it. It decides only in the corners — an `SSLMODE`
written in the wrong case (pg's lookup is case-sensitive), or `uselibpqcompat` with no mode — and in
each it fails **safe**. It used to fail open.

It does **not** decide for a connection string `new URL` cannot read, which an earlier version of
this section claimed: pg parses with `new URL` too, so a multi-host string throws inside pg before
`ssl` is resolved at all.

Duplicate `sslmode` parameters collapse to the value pg would have used (the last one), so
`?sslmode=require&sslmode=disable` normalises to `disable` rather than silently discarding it.

Production was verified against the live environment on 2026-08-04 before this shipped:
`DATABASE_URL` carries `sslmode=require`, no `uselibpqcompat`, and `DATABASE_DIRECT_URL` is unset —
so production sits on the first row and nothing about how it connects changed. All five migration scripts in `scripts/` were updated to match, each guarded so a local Postgres
with a self-signed certificate still connects; `check-schema-drift.mjs` in particular runs against
the real database before every schema change, so it is the last place that should be the loose one.

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
