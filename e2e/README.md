# End-to-end tests

Tests that need a real database and the real Fastify app. They are deliberately **not** part of
`npm test`, which stays dependency-free so CI needs no Postgres.

```bash
npm run test:e2e
```

## Setup, once

```bash
createdb litos_e2e_jobid
DATABASE_URL="postgresql://$(whoami)@localhost:5432/litos_e2e_jobid" npx drizzle-kit push --force
createdb litos_alias_e2e
DATABASE_URL="postgresql://$(whoami)@localhost:5432/litos_alias_e2e" npx drizzle-kit push --force
```

The test connects to `litos_e2e_jobid` on localhost and **truncates its tables on every run**. It
never reads `.env`, so it cannot reach the dev database or prod: the URL, the JWT secret and the
encryption key are all set inside the test file to throwaway values. Do not point it at a database
holding anything you want to keep.

## What `grouped-inventory.e2e.mts` covers

Phase 1 reports two inventory interpretations: raw postings and distinct roles grouped by
employer, title, and ATS family. The test inserts two Greenhouse location postings for one role
and one Lever posting with the same employer and title. It then proves that the public grouped API
reports two roles across three openings and that the cron inventory query returns the same totals.

## What `packet-alias.e2e.mts` covers

Every generated packet must have a Litos alias row, or the applicant's personal address ends up on
the employer's form and Litos cannot read the security code the employer mails back.

It connects to `litos_alias_e2e` and deletes from three tables on every run.

The BEFORE side runs `origin/main`'s own `body.application` gate and refuses to start unless it
still finds that gate in `git show origin/main:src/routes/resume.ts`, so the comparison cannot
quietly become a story about code that no longer exists. The AFTER side runs the real
`planPacketApplicantEmail` and the real `ensureApplicationEmailAlias` against the real foreign key.

`POST /resume/generate` is not called over HTTP here either, for the same reason as below: its
alias code sits behind a live Anthropic call, a PDF render and a blob upload.

## What `applied-badge.e2e.mts` covers

The jobs list shows a green "Applied" state on postings the student already applied to. It used to
decide that by matching `company + role`, so applying to one Google "Software Engineer" posting
marked the same title in every other city too. A false "Applied" means the student never applies,
which is the one failure on that page that cannot be undone.

The bug lived in the seam between two repositories: the board stored `{company, role}` and the
jobs list matched on `{company, role}`, and each side was internally consistent. Unit tests on
either side pass both before and after the fix. Only running the real projection over a real row
and feeding the real response into the real frontend decision shows the sibling going dark, which
is why this exists as an e2e rather than two unit suites.

Real in this test: Postgres, the app from `buildApp()` driven over HTTP via `inject()`, real
`requireAuth` with a signed JWT, the real `GET /applications/board` handler and its projection, and
the website's own badge logic (vendored, see below).

Not covered: `POST /resume/generate` is never called. Reaching the line that writes `job_context`
needs a live Anthropic call, a PDF render and a blob upload. Rows are inserted in the exact shape
that route builds; the request-schema half is covered by `src/routes/resumeRequestSchema.test.ts`.

## The two questions this covers

They are different questions, on different endpoints, and both were wrong the same way:

- **"Has this posting been applied to?"** reads `GET /applications/board` and feeds
  `buildAppliedIndex` / `isJobApplied`. Wrong answer showed a green "Applied" on a posting the
  student never applied to, so they never applied.
- **"Does a packet already exist for this posting?"** reads `GET /resume/history` and feeds
  `packetMatchesJob`. Wrong answer made "Apply now" reuse a resume tailored to a *different*
  posting and skip building one for the posting actually opened.

## The vendored files

`website-job-rows.vendored.ts` and `website-daily-matches.vendored.ts` are copies from the
`role-quick-website` repo, each with only its type-only import line replaced. A test spanning two
repos cannot import across them, and a shared package is more machinery than one test justifies.

**Nothing detects drift.** If either piece of logic changes on the website side, re-copy it. Each
header carries the commit it was taken from and the exact `diff` command to check it.
