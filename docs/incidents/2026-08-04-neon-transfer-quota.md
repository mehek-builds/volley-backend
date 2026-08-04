# 2026-08-04: Neon data transfer quota exhausted, public board down

**Impact.** Every database-backed route answered HTTP 500 for roughly 75 minutes. That includes
`GET /jobs`, `/jobs/grouped` and `/jobs/facets`, which are the public board at
trylitos.com/browse-jobs and the extension dashboard. `/health` and `/v1/meta` kept answering 200
throughout, because neither touches Postgres.

**Cause.** The project exhausted its Neon monthly public network transfer allowance. Neon then
refuses connections at the pool, so the failure is a fast, hard error rather than a timeout:

```
error: Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.
    at node_modules/pg-pool/index.js:45:11
```

**Resolution.** A plan change. There was no code fix available while the database refused every
connection, and deploys were separately rate limited at the time. The project now runs on the
Vercel-managed Neon organisation on the **Launch** plan (500 GB transfer per project per month),
not the free tier that was exhausted.

---

## Why nothing caught it

This failure mode is invisible to every guard the repo had.

A query that reads 20,000 characters per row instead of 6,000 has the same shape, the same plan, the
same tests and the same response body. It is not slower in any way a developer notices. Raising such
a cap is a one-character edit that reviews cleanly. The cost accumulates on an invoice nobody reads
daily, and then arrives once, as a total outage.

`/health` returning 200 actively hid it. The service was up; only its database was refused. Any
uptime check pointed at `/health` would have reported all-clear for the entire incident.

---

## Where the bytes went, measured

Taken from the live database on 2026-08-04, after recovery:

| Fact | Value |
| --- | --- |
| `monitored_jobs` total size | 216 MB |
| Live rows | 23,561 |
| `description` column | **84 MB, 67.6% of all row bytes** |
| Average description | 3,728 bytes |
| Largest description | 10,183 bytes |
| Sequential tuples read (lifetime) | 444,057,781 |

**`description` is the transfer bill.** Any code path that reads that column for many rows is the
thing that matters; everything else on the row is rounding error.

### The dominant reader

Ranked `GET /jobs` scored `left(description, SCORING_CHARS)` across the whole candidate pool on
every cache miss, behind a process-local `Map` with a 60 second TTL. On serverless that cache is
cold far more often than warm, so close to every board load paid the full read.

| Shape | Bytes per cold load | Cold loads to exhaust 5 GB |
| --- | --- | --- |
| Pre-incident (pool 300, 20k chars) | **5.78 MB** | **885** |
| After #174 (pool 150, 6k chars) | 937.5 KB | 5,592 |

885 cold board loads is not a traffic spike. It is an ordinary week.

### The secondary reader, and an honest correction

`scripts/check-logo-coverage.mjs` paged the entire board through `GET /jobs` on every CI run and
every local run, to read two columns: `company_name` and a row count. Measured against production:
**222 requests, 29.6 MB per pass.**

During the investigation of the flaky `logo-coverage` job on 2026-08-03/04, that script was run
about ten times, roughly 296 MB, which is about 5.8% of a 5 GB month. It was a contributor and not
the cause, and it was initially described in this session as though it were the cause. The
arithmetic above is what settled it, and it should have been done before assigning blame.

It is fixed anyway: `GET /jobs/facets?counts=true` answers the same question in **15,538 bytes**, a
~2,000x reduction, and returns an exact grouped snapshot rather than a paged read that can be skewed
by the poller writing underneath it.

---

## What is now enforced in code

Three things, all of which fail a normal `npm test` run.

**1. `src/lib/egressBudget.test.ts`** imports `RANKING_POOL`, `SCORING_CHARS`, `BOARD_PREVIEW_CHARS`
and `MAX_PAGE_SIZE` from the route itself, recomputes the worst-case bytes of one uncached ranked
board load, and fails when it exceeds the ceiling. It asserts explicitly that the pre-incident shape
would fail, so the guard cannot quietly become a rubber stamp. Raising a cap is still allowed; the
test names what the new number costs in cold board loads per month and makes you raise the ceiling
on purpose.

The budget is sized against the **free** 5 GB allowance even though the project is now on Launch.
Sizing to 500 GB would let the board drift back into a shape that cannot survive a downgrade, a new
project, or a second environment on the free tier.

**2. Named caps.** `MAX_PAGE_SIZE` and `BOARD_PREVIEW_CHARS` were bare literals inside a Zod schema
and a SQL fragment. They are now exported constants, because a guard cannot pin a magic number.

**3. The cheap measurement path.** `check-logo-coverage.mjs` asks for the grouped count and only
falls back to a full scan against a deployment that does not offer it.

---

## What is still not guarded

Stated plainly, because a partial guard that reads as total is worse than none.

- **No alert on actual consumption.** These guards bound what the code *can* read per request. They
  cannot see traffic volume, a crawler, or a runaway cron. Nothing in this repo watches the Neon
  usage figure itself, and there is no Neon API key available to it.
- **`/health` still reports 200 with a dead database**, so it remains a misleading uptime signal. A
  probe that touches Postgres would have named this incident in seconds.
- **The daily poll and purge are unbudgeted.** They write and delete far more than the board serves,
  and no test prices them.

## If it happens again

1. `GET /health` will be 200 and every `/jobs*` route 500. That combination means the database is
   refusing connections, not that the service is down.
2. Confirm with `vercel logs <deployment> --json` and grep for `quota`. The Fastify error boundary
   hides the underlying Postgres message from the HTTP response on purpose, so the response body
   alone will not tell you.
3. Neon usage lives in the console, not in this repo. The project is `bold-art-39393393` under the
   Vercel-managed organisation.
4. Do not run `npm run logo:check` while investigating. It is cheap now, but the reflex to re-run the
   failing check is what spends the allowance you are trying to preserve.
