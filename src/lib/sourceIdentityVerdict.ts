/**
 * WHAT MAKES THE SOURCE-IDENTITY CHECK RED.
 *
 * `npm run sources:verify` asks 1000+ third-party job boards who they are. Two very different
 * things can go wrong in that sentence, and until now they shared an exit code:
 *
 *   OURS      a board belongs to a company that is not the one we filed it under. `sas` was
 *             Superior Alarm Systems, `bcg` was Bohen Consulting Group, `disney` was a board
 *             called "Sgt. Pepper's Lonely Hearts Club Band". A job seeker applies to the wrong
 *             employer. This is the failure the check exists for.
 *
 *   THEIRS    a board has no postings this week, or its token stopped resolving. Nothing we
 *             wrote is wrong. Somebody has to look, eventually, and nobody has to look today.
 *
 * Mixing them cost the check its authority. `dead` failed the build, and a single 404 among
 * 1048 boards is close to a certainty on any given day, so main went red for hours at a time
 * over one third-party board and every session working this repo learned to say "source-identity
 * is red on main, ignore it". A required check that is ignored by policy protects nothing: the
 * day `named-mismatch` goes to 1, it lands inside a signal nobody reads.
 *
 * MEASURED, on main, before this split (job logs, `source-identity` job):
 *
 *   greenhouse/marqeta     404 at 06:19 on 2026-09-01, red until the re-point merged at 10:23.
 *   greenhouse/clickhouse  404 at 15:06 on 2026-09-01, red until the re-point merged at 19:11.
 *   greenhouse/solarisbank 404 at 13:08 on 2026-09-03, still red 5 hours later.
 *
 * Three boards, three red half-days, zero mislabelled sources in any of them.
 *
 * AND THE INVERSE, which is the part that should worry anybody: between 06:29 and 09:35 on
 * 2026-09-01, seven consecutive runs found 204 of 1048 boards empty, 196 of them Greenhouse,
 * including Airbnb, Asana and AQR. Airbnb does not have zero open roles. That is a fetch path
 * or a provider falling over, it would have blinded ingestion, and `source-identity` reported
 * SUCCESS on every one of those seven runs, because no single empty board is fatal and nothing
 * counted them. The check was loud about one dead board and silent about 196 broken ones.
 *
 * SO THE RULE IS NOW:
 *
 *   1. `named-mismatch` fails. Always, at one. It is the only verdict that states a fact about
 *      OUR data, and it is the reason this check is required.
 *   2. A source THIS pull request added that 404s fails. A token nobody has ever polled and that
 *      does not resolve is a typo in a hand-written string, which is the same class of bug as a
 *      mislabelling and is ours to fix before it merges. An already-catalogued board that starts
 *      404ing is the company moving, and is not.
 *   3. A bucket over its ceiling fails, as a NON-RESULT rather than a verdict. One empty board is
 *      a quiet week; a fifth of the catalog empty at once is the measurement broken, and that is
 *      the 2026-09-01 event above. Same argument the `unreachable` ceiling has always made.
 *   4. Everything else prints and annotates. `empty`, `dead` and `cannot-tell` are real findings
 *      that a human should act on, and the action is to re-point the board or retire it
 *      (RETIRED_ENTRIES in jobSources.ts), not to block an unrelated pull request.
 *
 * The ceilings are set off the measured baseline, not off a round number. The stable empty set on
 * main is 11 boards of 1048, the same 11 in every run sampled between 2026-09-01 10:41 and
 * 2026-09-03 18:36. A 5% ceiling gives that baseline almost five times its own size in headroom
 * and still catches the 204-board event nearly four times over.
 */

export const SOURCE_VERDICTS = [
  'named-ok', 'prose-ok', 'cleared-by-hand',
  'named-mismatch', 'cannot-tell', 'empty', 'unreachable', 'dead',
] as const;

export type SourceVerdict = (typeof SOURCE_VERDICTS)[number];

export interface VerifiedSource {
  company_name: string;
  ats_name: string;
  board_token: string;
  verdict: SourceVerdict;
  detail: string | null;
}

export interface LivenessCeilings {
  empty: number;
  dead: number;
  unreachable: number;
}

/**
 * How much of one bucket stops being news about the boards and starts being news about us.
 *
 * `unreachable` was capped first and for a reason worth keeping: "not fatal" one board at a time is
 * not the same as "not fatal" for the whole catalog. A runner with no egress, or a provider
 * changing its response envelope so every normalizer throws, would put every source in one bucket
 * and exit 0 having verified nothing. That is the silent zero this check was written to end. The
 * sources table sat empty in production for months because an empty board and a working board
 * looked identical to everything that watched them.
 *
 * `empty` and `dead` get the same treatment now, because they can go wrong the same way and did:
 * 204 boards empty at once on 2026-09-01 was a silent zero wearing a different bucket's name.
 *
 * Floors, not just fractions, so a `--only stripe,notion` run of two sources cannot trip a ceiling
 * on a single flaky board. The `unreachable` shape is unchanged from when it was the only ceiling.
 */
export function livenessCeilings(selectedCount: number): LivenessCeilings {
  return {
    empty: Math.max(25, Math.ceil(selectedCount * 0.05)),
    dead: Math.max(10, Math.ceil(selectedCount * 0.02)),
    unreachable: Math.max(5, Math.floor(selectedCount * 0.1)),
  };
}

export interface VerdictReport {
  exitCode: number;
  /** One line per reason the build is red. Empty when the run passed. */
  failures: string[];
  counts: Record<SourceVerdict, number>;
  mislabelled: VerifiedSource[];
  /** Sources this pull request added whose board does not resolve. */
  deadOnArrival: VerifiedSource[];
  /** Lines to print, correctness verdict first. */
  report: string[];
  /** GitHub Actions workflow commands, for the pull request's own annotations. */
  annotations: string[];
  /** Markdown for $GITHUB_STEP_SUMMARY, where a growing EMPTY list is actually legible. */
  stepSummary: string;
}

const key = (row: { ats_name: string; board_token: string }) => `${row.ats_name}/${row.board_token}`;

/** `::warning ...` and friends read the rest of the line as data, so a newline would truncate it. */
const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/**
 * GitHub keeps only ten annotations per level per step and drops the rest without saying so.
 *
 * Measured on this pull request's own first run: eleven boards were empty, eleven `::warning`
 * commands were written, and ten annotations came back from the API. `lever/trustly` vanished.
 * A check whose argument is "liveness became more visible, not less" cannot then lose the
 * eleventh board quietly, so the last slot is spent saying how many did not fit rather than on
 * one more row. The full list is in the log and in the step summary either way.
 */
const ANNOTATION_LIMIT = 10;

function withinAnnotationLimit(annotations: readonly string[], level: 'error' | 'warning'): string[] {
  const mine = annotations.filter((line) => line.startsWith(`::${level} `));
  if (mine.length <= ANNOTATION_LIMIT) return [...annotations];
  const dropped = mine.length - (ANNOTATION_LIMIT - 1);
  const kept = new Set(mine.slice(0, ANNOTATION_LIMIT - 1));
  return [
    ...annotations.filter((line) => !line.startsWith(`::${level} `) || kept.has(line)),
    `::${level} title=More not shown::${dropped} further ${level === 'error' ? 'failures' : 'findings'} `
    + 'are in the step summary and the job log. GitHub shows at most ten annotations per step.',
  ];
}

/**
 * Decide the exit code, and say plainly which of the two questions it answers.
 *
 * `addedKeys` is the set of `ats/token` this pull request introduced, or null when the base
 * revision was not available to compare against. Null means rule 2 above cannot be evaluated, so
 * it is skipped and the run says so: a missing diff must not invent a failure, and the ceilings
 * still cover the case where everything is dead at once.
 */
export function judgeSourceIdentity(
  results: readonly VerifiedSource[],
  selectedCount: number,
  addedKeys: ReadonlySet<string> | null = null,
): VerdictReport {
  const bucket = (name: SourceVerdict) => results.filter((row) => row.verdict === name);
  const counts = Object.fromEntries(
    SOURCE_VERDICTS.map((name) => [name, bucket(name).length]),
  ) as Record<SourceVerdict, number>;

  const ceilings = livenessCeilings(selectedCount);
  const mislabelled = bucket('named-mismatch');
  const dead = bucket('dead');
  const deadOnArrival = addedKeys ? dead.filter((row) => addedKeys.has(key(row))) : [];

  const failures: string[] = [];
  const annotations: string[] = [];
  const report: string[] = [];

  /* THE HEADLINE IS THE CORRECTNESS VERDICT, and it is the first line printed, because the whole
     point of the split is that a reader can tell in one glance whether the alarm is ours or the
     internet's without scrolling through a weather report on a thousand boards. */
  const headline = mislabelled.length === 0
    ? `IDENTITY: PASS. 0 of ${selectedCount} sources are mislabelled.`
    : `IDENTITY: FAIL. ${mislabelled.length} of ${selectedCount} sources `
      + `${mislabelled.length === 1 ? 'is' : 'are'} mislabelled.`;
  report.push(headline);

  for (const row of mislabelled) {
    failures.push(`${row.company_name} (${key(row)}) is not us: the portal says ${JSON.stringify(row.detail)}`);
    annotations.push(`::error title=Mislabelled source::${oneLine(`${row.company_name} (${key(row)}) `
      + `is filed under a name the board does not use. The portal says ${JSON.stringify(row.detail)}. `
      + 'Either the token belongs to another company, or the label needs correcting.')}`);
  }

  for (const row of deadOnArrival) {
    failures.push(`${row.company_name} (${key(row)}) was added by this pull request and its board does not resolve`);
    annotations.push(`::error title=New source does not resolve::${oneLine(`${row.company_name} (${key(row)}) `
      + 'is new in this pull request and the board returns 404. A token nobody has polled before '
      + 'that does not resolve is a typo, not a board that moved.')}`);
  }

  for (const [name, ceiling] of [
    ['empty', ceilings.empty],
    ['dead', ceilings.dead],
    ['unreachable', ceilings.unreachable],
  ] as const) {
    if (counts[name] <= ceiling) continue;
    const line = `NOT A RESULT: ${counts[name]} of ${selectedCount} boards came back ${name}, over the `
      + `ceiling of ${ceiling}. At that scale it is the measurement that broke, not the boards.`;
    failures.push(line);
    report.push(line);
    annotations.push(`::error title=Source check did not measure anything::${oneLine(line)}`);
  }

  /* Liveness prints and annotates, every run, and fails nothing. The cost of that is a board empty
     for good decaying quietly rather than loudly, which is what the printed list and the step
     summary are for: retire it in RETIRED_ENTRIES and it stops being reported as news. */
  const livenessTitle: Record<string, string> = {
    'cannot-tell': 'Board identity unresolved',
    empty: 'Board returned no postings',
    unreachable: 'Board could not be reached',
    dead: 'Board no longer resolves',
  };
  const onArrival = new Set(deadOnArrival.map(key));
  for (const name of ['cannot-tell', 'empty', 'unreachable', 'dead'] as const) {
    for (const row of bucket(name)) {
      if (onArrival.has(key(row))) continue; // already reported as an error above
      annotations.push(`::warning title=${livenessTitle[name]}::${oneLine(`${row.company_name} `
        + `(${key(row)}): ${row.detail ?? 'no detail'}`)}`);
    }
  }

  report.push(
    `LIVENESS: ${counts['cannot-tell']} cannot-tell, ${counts.empty} empty, `
    + `${counts.unreachable} unreachable, ${counts.dead} dead. Reported, not fatal below `
    + `${ceilings.empty}/${ceilings.dead}/${ceilings.unreachable}.`,
  );
  report.push(
    `${results.length} sources: ${SOURCE_VERDICTS.map((name) => `${counts[name]} ${name}`).join(', ')}.`,
  );
  if (!addedKeys) {
    report.push('Base revision unavailable, so a board added by this change and already dead was '
      + 'not distinguished from one that died on its own.');
  }

  const livenessRows = (['dead', 'empty', 'cannot-tell', 'unreachable'] as const)
    .flatMap((name) => bucket(name).map((row) => `| ${name} | ${row.company_name} | \`${key(row)}\` |`));
  const stepSummary = [
    `### source-identity: ${mislabelled.length === 0 ? 'identity PASS' : 'identity FAIL'}`,
    '',
    headline,
    '',
    ...(livenessRows.length === 0 ? ['Every board answered.'] : [
      'These are third-party liveness, not build failures. Re-point the board, or retire it in',
      '`RETIRED_ENTRIES` (src/lib/jobSources.ts) so it stops being reported every run.',
      '',
      '| verdict | company | board |',
      '| --- | --- | --- |',
      ...livenessRows,
    ]),
    '',
  ].join('\n');

  return {
    exitCode: failures.length > 0 ? 1 : 0,
    failures,
    counts,
    mislabelled,
    deadOnArrival,
    report,
    annotations: withinAnnotationLimit(withinAnnotationLimit(annotations, 'error'), 'warning'),
    stepSummary,
  };
}
