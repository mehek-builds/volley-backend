# Controlled security-code E2E

This harness proves the complete local backend flow: a guest packet enters a controlled portal, the
remote managed Stratus runner pauses for a fresh security code, a signed inbound message reaches the
exact generated alias, the message is forwarded through a loopback capture adapter, the same remote
continuation resumes, and the application reaches submitted with a receipt.

It never submits to an employer. The API, website, database, and email capture service must be local.
Only the controlled portal tunnel and dedicated nonproduction Stratus runner are remote.

## Safety contract

- `DATABASE_URL` must use `localhost`, `127.0.0.1`, or `::1`, and the database name must start with
  `litos_qa_`.
- `litos_qa_control` must contain the exact per-run marker and an expiry within 24 hours.
- `trylitos.com` and `www.trylitos.com` are always rejected as harness tunnel origins.
- Controlled portal recognition is disabled when `NODE_ENV=production`.
- Email forwarding goes only to `http://127.0.0.1:<port>/emails`, protected by a per-run token.
- The Stratus origin must exactly match `QA_EXPECTED_STRATUS_ORIGIN`, use HTTPS, and be declared as
  `QA_STRATUS_CREDENTIAL_SCOPE=dedicated-nonproduction`.
- No production environment pull, production API key, production database, or real mailbox is
  required or allowed by this procedure.

## Provisioning blocker

A dedicated nonproduction Stratus service credential is external infrastructure. Obtain either a
short-lived `VERCEL_OIDC_TOKEN` issued for that test service or its dedicated test-only
`STRATUS_API_KEY`, plus the exact service origin. If neither exists, the harness exits with a
`Provisioning blocker` error. Do not replace it with a production secret.

## Local setup

Create a disposable database and apply the required schemas:

```bash
export QA_LOCAL_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/litos_qa_security_code'
createdb -h 127.0.0.1 -U postgres litos_qa_security_code
DATABASE_URL="$QA_LOCAL_DATABASE_URL" npm run db:migrate
DATABASE_URL="$QA_LOCAL_DATABASE_URL" npm run db:guest-mode
DATABASE_URL="$QA_LOCAL_DATABASE_URL" npm run db:automatic-verification
DATABASE_URL="$QA_LOCAL_DATABASE_URL" npm run schema:apply-automation-consent
DATABASE_URL="$QA_LOCAL_DATABASE_URL" npm run db:application-email
DATABASE_URL="$QA_LOCAL_DATABASE_URL" npm run db:application-email-forwarding
DATABASE_URL="$QA_LOCAL_DATABASE_URL" npm run db:application-email-receiving-proof
```

Create the expiring marker:

```bash
export QA_CONTROLLED_DATABASE_MARKER="$(openssl rand -hex 16)"
psql "$QA_LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -v marker="$QA_CONTROLLED_DATABASE_MARKER" -c "create table if not exists litos_qa_control (scope text primary key, marker text not null, expires_at timestamptz not null); insert into litos_qa_control(scope, marker, expires_at) values ('security-code-e2e', :'marker', now() + interval '2 hours') on conflict(scope) do update set marker=excluded.marker, expires_at=excluded.expires_at;"
```

Generate local-only secrets and configure both local processes from the same shell:

```bash
export DATABASE_URL="$QA_LOCAL_DATABASE_URL"
export NODE_ENV=development
export JWT_SIGNING_SECRET="$(openssl rand -hex 32)"
export ENCRYPTION_KEY="$(openssl rand -hex 32)"
export LITOS_ENABLE_TEST_PORTAL=true
export LITOS_TEST_PORTAL_BINDING_SECRET="$(openssl rand -hex 32)"
export LITOS_APPLICATION_EMAIL_ROUTE_MODE=managed_resend
export LITOS_RESEND_MANAGED_RECEIVING_DOMAIN=litos-qa.resend.app
export LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN="$(openssl rand -hex 32)"
export LITOS_APPLICATION_EMAIL_ALIAS_SECRET="$(openssl rand -hex 32)"
export RESEND_WEBHOOK_SECRET="$(openssl rand -hex 32)"
export RESEND_FROM=onboarding@resend.dev
export LITOS_APPLICATION_EMAIL_WEBHOOK_URL=https://litos-qa.invalid/webhooks/application-email/inbound
export LITOS_APPLICATION_EMAIL_INBOUND_ENABLED=true
export LITOS_QA_EMAIL_CAPTURE_ENABLED=true
export LITOS_QA_EMAIL_CAPTURE_URL=http://127.0.0.1:4317/emails
export LITOS_QA_EMAIL_CAPTURE_TOKEN="$(openssl rand -hex 32)"
export BROWSER_PROVIDER=stratus-managed
export QA_STRATUS_CREDENTIAL_SCOPE=dedicated-nonproduction
export STRATUS_BASE_URL='https://DEDICATED-NONPRODUCTION-STRATUS.example'
export QA_EXPECTED_STRATUS_ORIGIN="$STRATUS_BASE_URL"
export VERCEL_OIDC_TOKEN='SHORT-LIVED-NONPRODUCTION-TOKEN'
unset STRATUS_API_KEY
```

The OIDC token can come from a dedicated nonproduction Vercel project or environment. Do not run
`vercel env pull --environment=production`. If the dedicated test service issues an API key instead,
unset `VERCEL_OIDC_TOKEN` and set only its test-only `STRATUS_API_KEY`.

Start the website on port 3300 and expose that local port through a temporary HTTPS tunnel. Then set
both origins to the exact assigned tunnel origin:

```bash
export QA_PORTAL_PUBLIC_BASE='https://ASSIGNED-TUNNEL.example'
export LITOS_TEST_PORTAL_PUBLIC_ORIGIN="$QA_PORTAL_PUBLIC_BASE"
```

Seed the exact controlled receiving proof before the backend starts:

```bash
QA_API_BASE=http://127.0.0.1:3301 \
QA_WEBSITE_BASE=http://127.0.0.1:3300 \
QA_CONTROLLED_PORTAL_PUBLIC=1 \
QA_CONTROLLED_DATABASE=1 \
npm run qa:security-code:prepare
```

This ordering is part of the test contract. The backend warms application-email deliverability at
startup, and a proof inserted after startup would leave its fail-closed cached answer unchanged for
the undeliverable TTL. The trial verifies the exact preseeded row and never clears or bypasses the
production cache.

Only after preparation succeeds, start the backend:

```bash
PORT=3301 npm run dev
```

Run exactly one trial from a second shell with the same environment:

```bash
QA_API_BASE=http://127.0.0.1:3301 \
QA_WEBSITE_BASE=http://127.0.0.1:3300 \
QA_CONTROLLED_PORTAL_PUBLIC=1 \
QA_CONTROLLED_DATABASE=1 \
QA_RUNS=1 \
QA_AUTO_APPLY=1 \
QA_PORTAL_SHAPE=security-code \
QA_APPLICATION_EMAIL_FORWARD_TO=qa-recipient@example.test \
QA_EVIDENCE_PATH=/tmp/security-code-one-run.json \
node scripts/qa-guest-submissions.mjs
```

The harness itself owns the loopback capture port while it runs. A successful evidence file records
`runner_auth_mode`, the exact runner origin, continuation fingerprint, continuation completion,
email receipt, local forwarding capture, submitted status, and receipt source. It never records a
credential or security code.

Only after this one-run evidence says `passed: true` may the same command be repeated with
`QA_RUNS=25` and a new evidence path.
