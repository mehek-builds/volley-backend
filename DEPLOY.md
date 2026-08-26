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
| `SUBMISSION_CUTOVER_MODE` | submission migration fence: `off`, `drain`, or `freeze`; unset is `off`, and any other nonempty value fails closed to effective `freeze` |
| `LITOS_ATS_API_SUBMISSION_ENABLED` | set to literal `true` only when employer-authorized ATS submission channels may POST applications |
| `LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON` | JSON array of allowlisted Greenhouse, Ashby, or Lever submit channels; references key env names, never raw secrets |
| `LITOS_APPLICATION_EMAIL_ROUTE_MODE` | nonsecret route selector: `managed_resend`, `custom_domain`, or `mailbox` |
| `LITOS_RESEND_MANAGED_RECEIVING_DOMAIN` | exact one-label `*.resend.app` receiving domain selected by `managed_resend` |
| `LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN` | stable hidden 32+ character random token deriving the dedicated managed receiving canary recipient |
| `LITOS_APPLICATION_EMAIL_DOMAIN` | domain that receives employer application mail for generated aliases, for example `apply.trylitos.com` |
| `LITOS_APPLICATION_EMAIL_MAILBOX` | rollback mailbox route using plus-addressed per-application aliases |
| `LITOS_APPLICATION_EMAIL_ALIAS_SECRET` | stable secret used to mint opaque per-application alias local parts |
| `RESEND_WEBHOOK_SECRET` | Resend `email.received` webhook signing secret, returned when the webhook is created |
| `PUBLIC_API_BASE` | absolute origin of THIS API, for example `https://api.trylitos.com`. **Required by the notification subsystem** and optional for everything else, so a deployment that has never needed it will not have it set. A cron has no inbound request to read a host from, and an alert whose unsubscribe link is relative is an alert nobody can stop, so `/internal/strong-match-notifications` answers 503 `{"missing":"public_api_base"}` rather than running and mailing nobody |
| `LITOS_NOTIFICATION_UNSUBSCRIBE_SECRET` | optional dedicated secret signing unsubscribe links. Falls back to `JWT_SIGNING_SECRET`, which is domain separated and present everywhere, so the feature works on the deploy that ships it. Rotating either invalidates every unsubscribe link already in somebody's inbox |
| `LITOS_INBOUND_EMAIL_WEBHOOK_SECRET` | compatibility HMAC secret for signed non-Resend `POST /application-email/inbound` calls |
| `LEMONSQUEEZY_CHECKOUT_URL` | legacy reusable product URL, retained only for real legacy subscriptions |
| `LEMONSQUEEZY_VARIANT_ID` | legacy variant ID, retained only for real legacy subscriptions |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | signing secret for legacy Lemon Squeezy lifecycle events |
| `LITOS_BILLING_ENABLED` | literal `true` only after the migration, three Prices, webhook, portal, and return URLs are verified |
| `STRIPE_SECRET_KEY` | restricted or secret live Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | signing secret for the live Litos+ webhook endpoint |
| `STRIPE_PLUS_WEEKLY_PRICE_ID` | active recurring USD Price for $19.99 every week |
| `STRIPE_PLUS_MONTHLY_PRICE_ID` | active recurring USD Price for $39.99 every month |
| `STRIPE_PLUS_QUARTERLY_PRICE_ID` | active recurring USD Price for $89.99 every three months |
| `LITOS_BILLING_SUCCESS_URL` | `https://trylitos.com/billing/return?session_id={CHECKOUT_SESSION_ID}` |
| `LITOS_BILLING_CANCEL_URL` | `https://trylitos.com/billing/return?status=cancelled` |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | `https://trylitos.com/dashboard/settings#plan` |
| `ENTITLEMENT_V2_CUTOVER_AT` | one recorded UTC instant used by the idempotent grandfathering migration, never changed afterward |
| `UPSTASH_REDIS_REST_URL` | optional, turns on the ranking cache's shared tier; see below |
| `UPSTASH_REDIS_REST_TOKEN` | optional, pairs with the URL above |
| `NODE_ENV` | `production` |

### Submission ledger cutover fence

The fence must be live before the submission-attempt ledger migration. First deploy the isolated
fence release with `SUBMISSION_CUTOVER_MODE=off`. Then merge the runtime-neutral migration-only
release and verify its exact revision still reports `{"mode":"off","config_valid":true}`. Do not
combine the first fence deployment with a production drain. A Vercel environment change reaches
the running service only after a deployment.

Deploy the correlation-aware Stratus build with
`STRATUS_SUBMISSION_CORRELATION_MODE=compat` and leave `STRATUS_SUBMISSION_QUIESCED` unset. This
lets the old backend finish accepted work without requiring identities it does not yet send.
`STRATUS_SUBMISSION_CORRELATION_MODE` must be `compat` or `required`; if it is missing, Stratus
defaults to required correlation. Only `STRATUS_SUBMISSION_QUIESCED=1` is quiesced. An unset or
non-`1` value is live, so a mistyped quiesce value does not stop submissions. Every environment
change requires a Stratus redeploy.

After every Stratus release-control redeploy, require the exact source commit and the expected
health flags from this table:

| Redeployed Stratus state | Correlation value | Quiesce value | `submissionQuiesced` | `submissionCorrelationRequired` |
|---|---|---|---:|---:|
| Compatibility, live | `compat` | unset or non-`1` | `false` | `false` |
| Compatibility, quiesced | `compat` | `1` | `true` | `false` |
| Required, quiesced | `required` | `1` | `true` | `true` |
| Required, live | `required` or missing | unset or non-`1` | `false` | `true` |

Use the intended row for `EXPECTED_QUIESCED` and `EXPECTED_CORRELATION_REQUIRED`:

```bash
EXPECTED_STRATUS_COMMIT="<Stratus commit SHA>"
EXPECTED_QUIESCED=false
EXPECTED_CORRELATION_REQUIRED=false
STRATUS_JSON="$(curl -fsS https://stratus-browser-cloud.vercel.app/api/health)"
STRATUS_COMMIT="$(jq -er '.commit | select(type == "string" and length > 0)' <<<"$STRATUS_JSON")"
test "$STRATUS_COMMIT" = "$EXPECTED_STRATUS_COMMIT"
jq -e \
  --argjson quiesced "$EXPECTED_QUIESCED" \
  --argjson correlation "$EXPECTED_CORRELATION_REQUIRED" \
  '.submissionQuiesced == $quiesced and .submissionCorrelationRequired == $correlation' \
  <<<"$STRATUS_JSON"
```

Stop if `commit` is null, empty, or different from `EXPECTED_STRATUS_COMMIT`, even when both flags
look correct. Then promote the exact migration-only backend revision with
`SUBMISSION_CUTOVER_MODE=drain` and verify:

```bash
EXPECTED_REVISION="<migration-only merge commit SHA>"
CUTOVER_JSON="$(curl -sS https://student-outreach-backend.vercel.app/health)"
CUTOVER_REVISION="$(jq -er '.revision' <<<"$CUTOVER_JSON")"
test "$CUTOVER_REVISION" = "$EXPECTED_REVISION"
jq -e '.submission_cutover == {"mode":"drain","config_valid":true}' <<<"$CUTOVER_JSON"
```

Keep drain active for at least 310 seconds, then require the same revision and cutover state again:

```bash
sleep 310
curl -sS https://student-outreach-backend.vercel.app/health \
  | jq -e --arg revision "$CUTOVER_REVISION" \
    '.revision == $revision and .submission_cutover == {"mode":"drain","config_valid":true}'
```

Drain refuses every application mutation, application detail read, resume route, dashboard
bootstrap, and internal worker. It leaves open only exact existing-attempt evidence sinks,
application list reads, inbound application mail, and legacy autofill evidence. The 310-second wait
clears old backend requests, but it does not prove external capabilities are gone.

Set `STRATUS_SUBMISSION_QUIESCED=1` while correlation remains `compat`, redeploy, and require
`submissionQuiesced:true` plus `submissionCorrelationRequired:false` on the exact Stratus commit.
Terminate every accepted Stratus run, or wait at least eight minutes after its last accepted work.
Then enumerate and terminate every retained Browserbase session. If session enumeration or
termination cannot be proven, wait the full
60-minute Browserbase maximum from the last session creation. Eight minutes does not replace the
Browserbase step. Confirm there are no future handoff expiries or recently active claims. Never
clear a claim to make a check pass. Employer pages already open in a person's own browser have no
revocable lease, so the backfill must preserve every nonterminal generated capability as an
unresolved hold.

Next, promote the same migration-only backend revision with `SUBMISSION_CUTOVER_MODE=freeze`.
Verify the exact revision and `{"mode":"freeze","config_valid":true}`, then start the migration
workflow. The workflow owns the final 310-second old-instance drain and verifies that same frozen
revision both before and after it. Freeze also refuses evidence sinks, legacy autofill, and the
inbound application-email webhook. Queue those webhook deliveries for idempotent replay after the
ledger-aware backend is live and unfrozen.

Run the stable-state preflight and ledger migration only while that exact frozen revision remains
live. The release owns an exclusive backend change window from the migration workflow's first frozen
health check through verified frozen health on the exact PR2 revision. During that window, make no
unrelated backend merge, redeploy, rollback, or Vercel environment edit. The only permitted backend
change after the workflow's final frozen check is the planned promotion of the exact verified PR2
revision with freeze still set. A transient unfreeze can admit a legacy write even if a later health
check looks frozen again. Keep freeze active while deploying the ledger-aware backend and both
clients. Set `STRATUS_SUBMISSION_CORRELATION_MODE=required` while
`STRATUS_SUBMISSION_QUIESCED=1`, redeploy, and require both Stratus health flags to be `true` on the
exact commit. Then unset `STRATUS_SUBMISSION_QUIESCED`, redeploy, and require
`submissionQuiesced:false` plus `submissionCorrelationRequired:true` on that same exact commit
before running a non-employer correlated canary. Then switch the backend to `off`, verify the exact
ledger-aware revision and off mode, recover inbound application confirmations, and run the
controlled application canary. Keep the Resend `email.received` endpoint configured throughout the
freeze and record the exact freeze start and end timestamps. After the exact PR2 revision reports
valid `off` health, inspect Resend deliveries for that interval. Manually replay every failed
`email.received` delivery so Resend creates a fresh signed request, and require HTTP 202 from each
replay. Do not resend captured webhook headers or a saved raw request: signed inbound requests older
than five minutes fail the freshness check. For every replay, verify that the inbound message is
stored once after deduplication and that the matching application has its durable ledger
confirmation. Do not run the application canary while any delivery in the interval is failed or
unaccounted for. Never replay into a frozen webhook. Never continue when health reports
`config_valid:false`; any invalid nonempty mode takes effect as freeze.

If rollback is needed after the ledger-aware backend is live, set
`STRATUS_SUBMISSION_QUIESCED=1`, redeploy the exact correlation-aware Stratus revision, and require
`submissionQuiesced:true` plus the correlation flag for its current mode. Then freeze the exact PR2
backend and verify its
revision and valid freeze mode. Keep that pair live for at least 310 seconds so every accepted
backend invocation exits. Drain or terminate all retained Stratus runs and Browserbase sessions
before rolling code. While Stratus remains quiesced, set correlation to `compat`, redeploy, and
require `submissionQuiesced:true` plus `submissionCorrelationRequired:false` on the exact commit.
Then roll the backend back only to the migration-only fence revision with freeze still set. Do not
roll Stratus back to a build without the quiesce and correlation controls. Keep that containment
build and fix forward. Do not reopen the old submission runtime after the append-only marker exists.
The additive ledger tables and immutable evidence remain in place while the fix moves forward.

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

### Stripe subscriptions

Litos+ uses one feature bundle with three recurring terms. In Stripe live mode, create and
activate these exact recurring USD Prices:

- `litos_plus_week`: $19.99 every one week
- `litos_plus_month`: $39.99 every one month
- `litos_plus_quarter`: $89.99 every three months

Apply the additive schema and grandfathering migration before deploying code that reads the new
tables. Record one UTC cutover instant and keep it unchanged on every retry:

```bash
DATABASE_URL="<your-neon-pooled-url>" \
ENTITLEMENT_V2_CUTOVER_AT="2026-08-14T00:00:00.000Z" \
npm run db:litos-plus-v2
```

Activate the default Stripe customer portal configuration and add a live webhook endpoint at
`https://student-outreach-backend.vercel.app/billing/stripe-webhook` for these events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.payment_action_required`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PLUS_WEEKLY_PRICE_ID`,
`STRIPE_PLUS_MONTHLY_PRICE_ID`, `STRIPE_PLUS_QUARTERLY_PRICE_ID`,
`LITOS_BILLING_SUCCESS_URL`, `LITOS_BILLING_CANCEL_URL`, and
`STRIPE_BILLING_PORTAL_RETURN_URL` in Production. The API reads each live Price from Stripe and
rejects checkout if its amount, currency, active state, interval, or interval count differs from
the server-owned catalog. Only then set `LITOS_BILLING_ENABLED=true`.

The old `LITOS_PAY_*`, `STRIPE_WEEKLY_PRICE_ID`, and `STRIPE_MONTHLY_PRICE_ID` variables are legacy
compatibility settings. They do not configure the new three-term Litos+ checkout.
Set `STRIPE_AUTOMATIC_TAX_ENABLED=true` only after Stripe Tax is registered and configured.
Production rejects Stripe test keys and test-mode webhook events.

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

### Submission attempt ledger cutover

The backend reads `application_submission_attempt_events` on normal submission and duplicate-risk
paths. The additive schema and deterministic positive-evidence backfill must therefore complete
before any backend build containing those reads reaches production.

First land and deploy the isolated submission fence as PR0 with mode `off`. Then land the migration
script, package command, workflow, and this runbook as PR1, without runtime ledger readers or
`src/db/schema.ts`. That runtime-neutral deploy is safe because the old backend ignores the
additive table. Deploy the correlation-aware Stratus build in compatibility mode, then complete the
drain, provider quiesce, Browserbase termination, and backend freeze described above.

Run the `Submission attempt ledger migration` workflow from `main` only while that exact PR1 merge
revision is serving in valid freeze mode. It uses the protected `production` environment, reads the
connection only from `SCHEMA_CHECK_DATABASE_URL`, proves the full schema and backfill contract
against an isolated PostgreSQL-compatible database with a standalone test that imports no runtime
ledger readers:

```bash
npm run test:submission-attempt-ledger-migration
```

Only after that proof passes does the workflow run:

```bash
npm run db:submission-attempt-ledger
```

The production step exits nonzero unless every required column, unique/index key, vocabulary
constraint, and append-only trigger is present after the idempotent backfill. Its final successful
line is `Ready: immutable submission attempt ledger schema is present.` Preserve that workflow run
as the migration evidence for the release.

Old backend behavior remains byte-equivalent throughout this first release because its file set is
limited to the additive migration script, standalone proof, package command, protected workflow,
and this runbook. In particular, PR1 omits `src/db/schema.ts`. Runtime schema readers and writers
belong to the later backend cutover release.

Prepare PR2 before applying the migration, then rebase it onto the deployed PR1 revision before its
final test run. After the workflow creates the additive tables, the old main schema model will
temporarily report them as EXTRA until PR2 lands. Do not run `db:push` or any schema reconciliation
command during that window. Run PR2's schema-drift check against the migrated database, then merge
PR2 promptly while the backend stays frozen and Stratus stays quiesced.

The required release order is:

1. Deploy PR0 fence with backend mode `off`.
2. Deploy PR1 migration-only revision with backend mode `off`.
3. Deploy correlation-aware Stratus in compatibility mode, unquiesced.
4. Set the PR1 backend to `drain`; after 310 seconds, quiesce Stratus and drain or terminate every provider capability.
5. Set the same PR1 backend revision to `freeze`; run the migration workflow, which verifies the frozen revision and owns the final 310-second drain.
6. Rebase, verify, and deploy PR2 ledger writers and duplicate-risk gate while backend freeze remains active.
7. Deploy the website and extension retry-safety clients while backend freeze remains active.
8. Change Stratus to required correlation while it remains quiesced.
9. Unquiesce Stratus and pass a non-employer correlated canary.
10. Set the exact PR2 backend revision to `off`, recover every failed inbound delivery from the recorded freeze interval with fresh signed replays, and pass one controlled real application canary.

Do not merge PR2 before the migration workflow succeeds, because the GitHub integration deploys
every main merge automatically. An old backend safely ignores the additive table, but reopening old
submission behavior would recreate the duplicate-risk gap. On rollback, keep the fence frozen and
fix forward. Never remove or rewrite ledger evidence.

The backfill preserves current evidence plus conservative openings for every nonterminal generated
packet, every nonterminal canonical portal capability, and every legacy extension record whose
`auto_submitted` value is exactly true. Each source gets a distinct deterministic attempt so a safe
resolution for one cannot release another. A blank legacy extension identity remains a user-wide
fail-closed hold because it cannot be compared safely. The Max Borges Agency Workable packet
`c43b9eeb-c1f3-4fd9-b9ba-d74e4dd0ad30` has a deterministic operational hold for the vault-recorded
pressed and unverified attempt on 2026-08-20. That hold remains blocked until a person records an
exact resolution.

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
`email.received` webhook for the exact dedicated canary recipient stores a recent durable proof, and
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

The managed receiving proof table and append-only route index have a separate migration:

```bash
npm run db:application-email-receiving-proof
```

After its workflow is present on `main`, an operator may run
`Application email receiving proof migration` from GitHub Actions. The workflow refuses non-main
refs, reads the database connection only from `SCHEMA_CHECK_DATABASE_URL`, and applies only the
idempotent `application_email_receiving_proofs` schema. It removes the obsolete unique
`route_fingerprint` index, creates a non-unique lookup index, and verifies that provider message
hashes remain unique while multiple immutable proof events can exist for one route.

After applying that migration, configure a stable hidden canary token before enabling managed
receiving. The setup command sends the random token to Vercel over stdin and never prints the token
or derived recipient. It does not deploy or send a canary by itself:

```bash
npm run setup:application-email-receiving-canary
```

After a deployment containing that token, invoke `/internal/managed-receiving-canary` through the
authorized cron or operator route and wait for the signed inbound webhook. Proof storage first reads
the canary through the configured Receiving API key. The signed webhook records only a message-ID
hash, route fingerprint, proof version, domain, and timestamp. Health, errors, logs, and the database
never contain the canary recipient or token. The daily 15:00 UTC cron reuses the dedicated recipient
when the newest proof enters its two-day refresh window. An ordinary accepted inbound delivery on
the managed domain may renew the same append-only proof ledger during that window. Each proof event
expires after seven days, but the canary token does not. Rotate it only after exposure or an intended
route reconfiguration, then establish a new proof for the new route fingerprint.

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
