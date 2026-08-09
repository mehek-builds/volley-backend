/* THE TEN MEASURED DEFECTS, RUN AGAINST THE PRODUCTION CODE THAT SHIPPED THEM.
 *
 * Every case below reproduces one defect that reached a real employer's form while the controlled
 * portal passed. Each drives the harness page for that shape (role-quick-website,
 * app/qa/portal-submission/shape-form.tsx) with the ACTUAL production decision code, and prints
 * PASS or FAIL. Nothing here is a mock: the readiness gate, the fill, the submit choice and the
 * managed action list are all imported, and the managed executor is the byte-for-byte SANDBOX_RUNNER
 * out of the stratus-browser-cloud checkout.
 *
 *   BASE=http://localhost:3999 npx tsx scripts/trial-portal-shapes.mts
 *   BASE=https://trylitos.com  npx tsx scripts/trial-portal-shapes.mts select-jd-decoy
 *
 *   BASE           harness origin. Defaults to http://localhost:3999.
 *   STRATUS_REPO   checkout of stratus-browser-cloud, for the managed engine. Defaults to
 *                  ../stratus-browser-cloud. Missing means the managed cases SKIP, loudly, and
 *                  count as failures rather than quietly disappearing.
 *
 * THREE ENGINES, AND THE REASON THERE ARE THREE.
 *
 *   gate     Loads the page and runs READ_SUBMIT_READINESS_SCRIPT, the pre-submit gate, verbatim.
 *            This is the only engine for the gate defects: the question is whether the gate can SEE
 *            the state of the form, and routing that through a filler that may itself be broken
 *            would not say which of the two failed.
 *   direct   fillPortal + clickFinalSubmit against a real Chromium. This is the path
 *            submissionRunner's prepareControlled/submitControlled take when the managed provider is
 *            not configured (shouldUseLocalControlledBrowser).
 *   managed  The real action list from buildManagedPortalActions, executed by the real
 *            SANDBOX_RUNNER. This is the path production actually takes, and all four react-select
 *            defects live inside that runner's fillCustomChoice.
 *
 * NO SECOND READER. Everything a verdict rests on comes out of the run that actually happened.
 * The managed engine reads the fixture's own event log through `extract`, which is the only DOM read
 * the real runner offers, rather than replaying the actions locally and reading the replay. A replay
 * would be a second implementation of the runner, and two readers that disagree is a mistake this
 * codebase has already had to delete once.
 *
 * WHAT THIS TRIAL CANNOT CLAIM. It drives the page directly. Production goes through a forked
 * sandbox, a cookie preflight, an Apply click and a 120-action budget, and this repo has been bitten
 * once by a fix that passed a direct replay and still failed in production for exactly that reason.
 * So a PASS here is necessary and not sufficient, and the shapes still have to be run end to end
 * through a real submission with LITOS_ENABLE_TEST_PORTAL=true. What this trial IS good for is the
 * other direction, which is the direction that matters today: a FAIL here is proof.
 *
 * Nothing is ever submitted to an employer. Every page is on the harness origin, and the harness
 * form has no action attribute and makes no network write of any kind.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import type { ManagedBrowserAction } from '../src/lib/browserbase';
import {
  READ_SUBMIT_READINESS_SCRIPT,
  buildManagedPortalActions,
  clickFinalSubmit,
  fillPortal,
  type SubmissionPacket,
} from '../src/lib/portalSubmission';

const require = createRequire(import.meta.url);
const BASE = process.env.BASE ?? 'http://localhost:3999';
const STRATUS_REPO = process.env.STRATUS_REPO ?? resolve(process.cwd(), '..', 'stratus-browser-cloud');

/* The applicant this trial fills as. Real shape, invented person. The phone is deliberately the
   +971 number Cresta rejected, because case 8 turns on what gets written into a phone field that
   already has a country selector holding +971. */
function packetFor(overrides: Partial<SubmissionPacket> = {}): SubmissionPacket {
  return {
    fullName: 'Priya Raman',
    email: 'priya.raman@example.invalid',
    phone: '+971 567417451',
    city: 'Dubai',
    country: 'United Arab Emirates',
    linkedinUrl: 'https://www.linkedin.com/in/example',
    school: 'University of Southern California',
    degree: "Bachelor's Degree",
    major: 'Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    resume: Buffer.from('%PDF-1.4\n% Litos controlled shape fixture\n%%EOF\n'),
    resumeName: 'resume.pdf',
    questions: [],
    ...overrides,
  };
}

type Verdict = { pass: boolean; detail: string };

type ManagedRun = {
  /** Straight out of stratus-result.json. What the run REPORTED. */
  filledFields: string[];
  blockers: string[];
  skipped: string[];
  /** The fixture's own log, read by the same run through `extract`. What actually HAPPENED. */
  events: string[];
  /** One entry per data-litos-qa-* attribute the run extracted. */
  state: Record<string, string | null>;
};

type Ctx = {
  gate: (shape: string, query?: Record<string, string>) => Promise<{ blocking: string[]; stale: string[] }>;
  direct: <T>(shape: string, body: (page: Page) => Promise<T>, query?: Record<string, string>) => Promise<T>;
  managed: (
    shape: string,
    actions: ManagedBrowserAction[],
    reads: Array<[key: string, attribute: string]>,
    query?: Record<string, string>,
  ) => Promise<ManagedRun>;
};

type Case = {
  id: string;
  /** The defect number in the brief, so a report can be matched to it without re-deriving. */
  defect: string;
  engine: 'gate' | 'direct' | 'managed';
  run: (ctx: Ctx) => Promise<Verdict>;
};

const eventsCount = (run: ManagedRun, name: string) =>
  run.events.filter((entry) => entry === name || entry.startsWith(`${name}=`)).length;

/* ─── the cases ─────────────────────────────────────────────────────────────────────────────── */

const CASES: Case[] = [
  {
    id: 'required-empty',
    defect: '1. a required field left empty must be caught',
    engine: 'gate',
    async run(ctx) {
      const { blocking } = await ctx.gate('required-empty');
      const named = (pattern: RegExp) => blocking.some((entry) => pattern.test(entry));
      const location = named(/current location/i);
      const authorization = named(/legally authorized/i);
      // Marked with a red asterisk and NOTHING else, which is what a real Greenhouse form does.
      const sponsorship = named(/sponsorship/i);
      return {
        pass: location && authorization && sponsorship,
        detail:
          `location=${location} legally-authorized=${authorization} sponsorship(asterisk only)=${sponsorship}; `
          + `blocking=${JSON.stringify(blocking)}`,
      };
    },
  },
  {
    id: 'select-late-menu',
    defect: '2. a react-select whose menu renders 555 to 563 ms after the click',
    engine: 'managed',
    async run(ctx) {
      const run = await ctx.managed(
        'select-late-menu',
        /* "Physics" is deliberately NOT option 0. The last action in the production react-select
           sequence is a blind click on #react-select-<id>-option-0, so a value that happens to be
           first on the list is answered correctly by a run that never read the menu at all, and the
           case would pass without exercising the timing it exists to test. */
        disciplineActions('Physics'),
        [['value', 'data-litos-qa-value-discipline--0']],
      );
      return {
        pass: run.state.value === 'Physics',
        detail:
          `control reads ${JSON.stringify(run.state.value)}; menu_ready=${eventsCount(run, 'menu_ready')} `
          + `option_clicked=${eventsCount(run, 'option_clicked')}; filled=${JSON.stringify(run.filledFields)}`,
      };
    },
  },
  {
    id: 'select-jd-decoy',
    defect: '3. a react-select must not be answerable from the job description',
    engine: 'managed',
    async run(ctx) {
      const run = await ctx.managed(
        'select-jd-decoy',
        disciplineActions('Mathematics'),
        [['value', 'data-litos-qa-value-discipline--0']],
      );
      const decoys = eventsCount(run, 'decoy_clicked');
      const wrongAnswer = Boolean(run.state.value) && run.state.value !== 'Mathematics';
      return {
        pass: decoys === 0 && run.state.value === 'Mathematics',
        detail:
          `job-description bullets clicked=${decoys}; wanted "Mathematics", control reads `
          + `${JSON.stringify(run.state.value)}${wrongAnswer ? ' (THE WRONG DISCIPLINE)' : ''}; `
          + `filled=${JSON.stringify(run.filledFields)}`,
      };
    },
  },
  {
    id: 'select-preserve',
    defect: '4. a choice already made must not be undone',
    engine: 'managed',
    async run(ctx) {
      /* School arrives ALREADY ANSWERED with the same value the packet holds. A run that recognises
         that and leaves it alone clears nothing. Both mechanisms measured in production are live on
         this page: fill('') reaches the combobox as a Delete keypress, and the widget's own
         aria-label="Clear selections" control is inside the managed sweep's control list. */
      const run = await ctx.managed(
        'select-preserve',
        schoolActions('University of Southern California'),
        [['value', 'data-litos-qa-value-school--0']],
      );
      const cleared = run.events.filter((entry) => entry.startsWith('value_cleared'));
      return {
        pass: cleared.length === 0 && run.state.value === 'University of Southern California',
        detail:
          `value_cleared=${cleared.length} ${JSON.stringify(cleared)}; `
          + `school reads ${JSON.stringify(run.state.value)}`,
      };
    },
  },
  {
    id: 'select-search-echo',
    defect: '5. a choice never made must never be reported as filled',
    engine: 'managed',
    async run(ctx) {
      /* This control's option list cannot contain the answer, so no selection is possible and the
         only question is what the run REPORTS. filled_fields naming the control while it still reads
         "Select..." is the defect, and the search box holding the typed text is how it happened. */
      const run = await ctx.managed(
        'select-search-echo',
        disciplineActions('Computer Science'),
        [
          ['value', 'data-litos-qa-value-discipline--0'],
          ['search', 'data-litos-qa-search-discipline--0'],
        ],
      );
      const claimed = run.filledFields.some((field) => field.startsWith('education_discipline_combo'));
      const answered = Boolean(run.state.value);
      return {
        pass: !claimed && !answered,
        detail:
          `filled_fields claims it: ${claimed}; control holds ${JSON.stringify(run.state.value)}; `
          + `search box holds ${JSON.stringify(run.state.search)}; skipped=${JSON.stringify(run.skipped)}`,
      };
    },
  },
  {
    id: 'segmented-yesno',
    defect: '6. a segmented Yes/No control, as Ashby renders work authorization',
    engine: 'gate',
    async run(ctx) {
      const unanswered = await ctx.gate('segmented-yesno', { board: 'ashby' });
      const answered = await ctx.gate('segmented-yesno', { board: 'ashby', answered: '1' });
      const matches = (list: string[]) => list.some((entry) => /legally authorized/i.test(entry));
      const blocksWhenEmpty = matches(unanswered.blocking);
      const clearsWhenAnswered = !matches(answered.blocking);
      return {
        pass: blocksWhenEmpty && clearsWhenAnswered,
        detail:
          `unanswered blocks: ${blocksWhenEmpty}; answered clears: ${clearsWhenAnswered}; `
          + `answered still blocking: ${JSON.stringify(answered.blocking.filter((e) => /authorized/i.test(e)))}`,
      };
    },
  },
  {
    id: 'date-overlay',
    defect: '7. a date picker that leaves an overlay open across the next question',
    engine: 'managed',
    async run(ctx) {
      const run = await ctx.managed(
        'date-overlay',
        graduationYearActions('2028'),
        [['covers', 'data-litos-qa-covers-next']],
      );
      return {
        pass: run.state.covers === 'no',
        detail:
          `calendar covering the next question at the end of the run: ${run.state.covers}; `
          + `opened=${eventsCount(run, 'calendar_opened')} dismissed=${eventsCount(run, 'calendar_dismissed')}`,
      };
    },
  },
  {
    id: 'phone-country',
    defect: '8. a phone input with a separate country selector',
    engine: 'direct',
    async run(ctx) {
      return ctx.direct('phone-country', async (page) => {
        await fillPortal(page, 'controlled_test', packetFor());
        const written = await page.locator('#phone-national').inputValue().catch(() => '');
        let submitError: string | null = null;
        try {
          await clickFinalSubmit(page);
        } catch (error) {
          submitError = (error as Error).message.split('\n')[0];
        }
        const received = await page.getByText('Your application was received').count();
        const rejected = await page.getByText('Phone number is too short').count();
        return {
          pass: received > 0 && rejected === 0,
          detail:
            `wrote ${JSON.stringify(written)} into a field whose country selector already holds +971; `
            + `"too short" shown: ${rejected > 0}; receipt: ${received > 0}`
            + (submitError ? `; submit said: ${submitError}` : ''),
        };
      });
    },
  },
  {
    id: 'security-code',
    defect: '9. an emailed security code and a two-phase submit',
    engine: 'direct',
    async run(ctx) {
      return ctx.direct('security-code', async (page) => {
        await fillPortal(page, 'controlled_test', packetFor());
        let submitError: string | null = null;
        try {
          await clickFinalSubmit(page);
        } catch (error) {
          submitError = (error as Error).message.split('\n')[0];
        }
        const received = await page.getByText('Your application was received').count();
        const codeFieldShown = await page.locator('#security_code').count();
        const attempts = await page.locator('#litos-qa-log')
          .getAttribute('data-litos-qa-submit-attempts').catch(() => null);
        return {
          pass: received > 0 && Number(attempts ?? 0) >= 2,
          detail:
            `receipt: ${received > 0}; submit presses: ${attempts ?? 0} (a pass needs 2); `
            + `security-code field still on screen: ${codeFieldShown > 0}`
            + (submitError ? `; submit said: ${submitError}` : ''),
        };
      });
    },
  },
  {
    id: 'stale-error',
    defect: '10a. stale "This field is required." under five FILLED controls must not block',
    engine: 'gate',
    async run(ctx) {
      const { blocking, stale } = await ctx.gate('stale-error');
      const wronglyBlocked = blocking.filter((entry) =>
        /phone|current location|linkedin|school|discipline/i.test(entry));
      return {
        pass: wronglyBlocked.length === 0 && stale.length > 0,
        detail: `wrongly blocked=${JSON.stringify(wronglyBlocked)}; stale messages seen=${stale.length}`,
      };
    },
  },
  {
    id: 'stale-error-real',
    defect: '10b. a real "This field is required." under an EMPTY unmarked control must block',
    engine: 'gate',
    async run(ctx) {
      const { blocking } = await ctx.gate('stale-error-real');
      const caught = blocking.some((entry) => /why do you want to work here/i.test(entry));
      const wronglyBlocked = blocking.filter((entry) =>
        /phone|current location|linkedin|school|discipline/i.test(entry));
      return {
        pass: caught && wronglyBlocked.length === 0,
        detail: `real blocker caught: ${caught}; wrongly blocked=${JSON.stringify(wronglyBlocked)}`,
      };
    },
  },
  {
    id: 'cover-letter-attach',
    defect: '11. a cover letter that is written and never attached',
    engine: 'managed',
    async run(ctx) {
      /* Both uploads, because the two ways to fail here are opposite. Cresta packet
         8142004c-3358-4538-8778-16df5e31c5bb attached nothing, and the shape next door to that is a
         selector loose enough to put the letter into the wrong control. A run that only checked the
         cover letter would call the second one a pass.

         The verdict is read off the FIXTURE, not off filledFields: the runner pushes an upload's
         label the moment setInputFiles returns, so its own report cannot distinguish "the file is
         in the control" from "the call did not throw". */
      const run = await ctx.managed(
        'cover-letter-attach',
        uploadActions(packetFor({
          coverLetter: Buffer.from('%PDF-1.4\n% Litos controlled cover letter fixture\n%%EOF\n'),
          coverLetterName: 'cover.pdf',
        })),
        [
          ['cover', 'data-litos-qa-cover-file'],
          ['resume', 'data-litos-qa-resume-file'],
          ['extra', 'data-litos-qa-extra-file'],
        ],
      );
      const attached = run.state.cover === 'cover.pdf';
      const resumeIntact = run.state.resume === 'resume.pdf';
      // The letter must not land in "Additional documents". Null means the decoy was never touched.
      const misfiled = Boolean(run.state.extra);
      return {
        pass: attached && resumeIntact && !misfiled,
        detail:
          `cover letter control holds ${JSON.stringify(run.state.cover)} (wanted "cover.pdf"); `
          + `resume control holds ${JSON.stringify(run.state.resume)}; `
          + `decoy "Additional documents" holds ${JSON.stringify(run.state.extra)}`
          + `${misfiled ? ' (THE LETTER WENT TO THE WRONG CONTROL)' : ''}; `
          + `filled=${JSON.stringify(run.filledFields)} skipped=${JSON.stringify(run.skipped)}`,
      };
    },
  },
  {
    id: 'eeo-radio-groups',
    defect: '12. two Ashby EEO radio groups under one preamble',
    engine: 'managed',
    async run(ctx) {
      /* Skydio packet 13bccb2d-d726-4c47-80bc-e8090ae1463e. Two runs, because the two failures this
         shape carries are opposite and a case that only checked one would pass on the other.

         RUN A is the production packet: an answer for each group, and the two groups share a
         "Decline to self-identify" option. Measured against the live Skydio form on 2026-08-09 with
         the runner at 41d3095, the race answer set the GENDER control and race was left blank, so
         the applicant's stated gender was silently replaced by a decline she did not give. Both
         halves are checked here: each group holds its OWN answer, and neither holds anything else.

         RUN B is the qualified-option gap, kept measured rather than hidden. The stored answer is
         "Asian" and the only option that could carry it reads "Asian (Not Hispanic or Latino)".
         Neither the resolver's containment rule nor the runner's optionMatches accepts the extra
         words, so nothing can be selected. That is an OPEN GAP and the assertion here is only the
         part that is not negotiable: an unmade choice must not be claimed as filled, and must not
         be quietly redirected onto the gender group next door. */
      const runA = await ctx.managed(
        'eeo-radio-groups',
        eeoActions([['Gender', 'Female'], ['Race', 'Decline to self-identify']]),
        [['gender', 'data-litos-qa-eeo-gender'], ['race', 'data-litos-qa-eeo-race']],
        { board: 'ashby' },
      );
      const genderHeld = runA.state.gender ?? '';
      const raceHeld = runA.state.race ?? '';
      const claimed = (run: ManagedRun, question: string) =>
        run.filledFields.includes(`question:${question}`);
      const placed = genderHeld === 'Female' && raceHeld === 'Decline to self-identify';
      const reported = claimed(runA, 'Gender') && claimed(runA, 'Race');

      const runB = await ctx.managed(
        'eeo-radio-groups',
        eeoActions([['Race', 'Asian']]),
        [['gender', 'data-litos-qa-eeo-gender'], ['race', 'data-litos-qa-eeo-race']],
        { board: 'ashby' },
      );
      const gapHonest = !claimed(runB, 'Race') && !runB.state.race && !runB.state.gender;

      return {
        pass: placed && reported && gapHonest,
        detail:
          `gender group holds ${JSON.stringify(genderHeld)} (wanted "Female"); `
          + `race group holds ${JSON.stringify(raceHeld)} (wanted "Decline to self-identify")`
          + `${genderHeld === 'Decline to self-identify' ? ' (HER GENDER ANSWER WAS REPLACED BY THE RACE ANSWER)' : ''}; `
          + `filled=${JSON.stringify(runA.filledFields)} skipped=${JSON.stringify(runA.skipped)}; `
          + `open gap, stored "Asian" against "Asian (Not Hispanic or Latino)": race holds `
          + `${JSON.stringify(runB.state.race)}, gender holds ${JSON.stringify(runB.state.gender)}, `
          + `claimed filled: ${claimed(runB, 'Race')}, said: ${JSON.stringify(runB.skipped)}`,
      };
    },
  },
];

/* ─── action lists, taken from the real builder rather than typed here ───────────────────────── */

/* buildManagedPortalActions is the production builder, so these carry production's own selectors,
 * values, timeouts and optional flags. Filtering by label keeps a shape page's run to the control
 * under test: a real Greenhouse packet already lands at exactly MANAGED_ACTION_LIMIT (120) with
 * preferred_first_name and preferred_last_name shaved off the end, and a run that spent 120 actions
 * missing selectors this fixture deliberately does not have would be measuring the budget rather
 * than the defect. Every shape page adds at most four actions over its board's plain form, so the
 * budget is never the thing under test here.
 */
function actionsMatching(prefix: string, packet: SubmissionPacket): ManagedBrowserAction[] {
  const all = buildManagedPortalActions('controlled_test', packet);
  const picked = all.filter((action) => (action.label ?? '').startsWith(prefix));
  if (picked.length === 0) throw new Error(`no production action carries the label prefix ${prefix}`);
  return picked;
}

const disciplineActions = (major: string) =>
  actionsMatching('education_discipline_combo', packetFor({ major }));
const schoolActions = (school: string) =>
  actionsMatching('education_school_combo', packetFor({ school }));
const graduationYearActions = (year: string) =>
  actionsMatching('education_end_year_field', packetFor({ graduationYear: year }));

/* THE EEO QUESTIONS, THROUGH THE ASHBY BUILDER.
 *
 * `controlled_ashby` rather than `controlled_test`, because portalFamily maps controlled_test to
 * greenhouse and the greenhouse arm answers a demographic question through its react-select ladder -
 * a control this shape does not have and Ashby does not render. The Ashby arm emits exactly what
 * production emitted for packet 13bccb2d: one `fillByLabelText` per question, labelled
 * `question:<the question>`, which is the action whose failure the packet reported.
 *
 * Filtered to those fills alone. The builder also fans out a `select` and nine `fill` alternatives
 * per question at selectors this fixture deliberately does not have; they are optional no-ops that
 * would put forty actions on a page whose defect needs two, and MANAGED_ACTION_LIMIT would then be
 * closer to the thing under test than the radio group is.
 */
function eeoActions(pairs: Array<[question: string, answer: string]>): ManagedBrowserAction[] {
  const packet = packetFor({ questions: pairs.map(([question, answer]) => ({ question, answer })) });
  const all = buildManagedPortalActions('controlled_ashby', packet);
  const picked = all.filter((action) =>
    action.type === 'fillByLabelText'
    && pairs.some(([question]) => action.label === `question:${question}`));
  if (picked.length !== pairs.length) {
    throw new Error(`the production Ashby builder emitted ${picked.length} question fills, not ${pairs.length}`);
  }
  return picked;
}

/* Both file uploads, in the order the production builder emits them. Not filtered to the cover
   letter alone: the misfiling failure - the letter landing in the resume control, or the resume in
   the cover-letter control - is only visible when both documents are in flight, and it is the
   failure a selector widened to fix the missing attachment would produce. */
function uploadActions(packet: SubmissionPacket): ManagedBrowserAction[] {
  const all = buildManagedPortalActions('controlled_test', packet);
  const picked = all.filter((action) => action.type === 'upload');
  const labels = picked.map((action) => action.label);
  if (!labels.includes('resume') || !labels.includes('cover_letter')) {
    throw new Error(`the production builder emitted ${JSON.stringify(labels)}, not a resume and a cover letter`);
  }
  return picked;
}

/* ─── the managed engine: the real SANDBOX_RUNNER, not a copy of it ─────────────────────────── */

/* Extracted as TEXT from the stratus checkout rather than imported. Importing the module would drag
 * in @vercel/sandbox and the rest of that service's dependency tree, which this repo does not have;
 * copying the script into this repo would create the second reader this codebase has already had to
 * delete once. The runner is a String.raw template with no interpolation, so the text between the
 * delimiters IS the script, byte for byte, and the assertion below fails loudly the day that stops
 * being true. */
function sandboxRunnerSource(): string {
  const file = join(STRATUS_REPO, 'src', 'managed-browser.js');
  const source = readFileSync(file, 'utf8');
  const open = 'export const SANDBOX_RUNNER = String.raw`';
  const start = source.indexOf(open);
  if (start < 0) throw new Error(`SANDBOX_RUNNER not found in ${file}`);
  const body = source.slice(start + open.length);
  const end = body.indexOf('`;');
  if (end < 0) throw new Error(`SANDBOX_RUNNER is not terminated in ${file}`);
  const script = body.slice(0, end);
  if (script.includes('${')) {
    throw new Error('SANDBOX_RUNNER now interpolates, so this text extraction is no longer exact');
  }
  return script;
}

type SandboxResult = {
  filledFields: string[];
  blockers: string[];
  skipped: string[];
  extracted: Array<{ label?: string; value: string | null }>;
};

function runManagedLocally(url: string, actions: ManagedBrowserAction[]): SandboxResult {
  const dir = mkdtempSync(join(tmpdir(), 'litos-shape-'));
  // The runner does require('playwright'); this repo ships playwright-core, which is the same
  // library without the browser downloader. One shim module, so the runner text stays untouched.
  mkdirSync(join(dir, 'node_modules', 'playwright'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'playwright', 'package.json'),
    JSON.stringify({ name: 'playwright', version: '0.0.0-shim', main: 'index.js' }),
  );
  writeFileSync(
    join(dir, 'node_modules', 'playwright', 'index.js'),
    `module.exports = require(${JSON.stringify(require.resolve('playwright-core'))});\n`,
  );
  writeFileSync(join(dir, 'runner.cjs'), sandboxRunnerSource());
  writeFileSync(
    join(dir, 'stratus-input.json'),
    JSON.stringify({ url, actions, waitUntil: 'domcontentloaded' }),
  );
  const run = spawnSync(process.execPath, ['runner.cjs'], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
  if (run.status !== 0) {
    throw new Error(`managed runner exited ${run.status}: ${(run.stderr || '').split('\n')[0]}`);
  }
  return readSandboxResult(dir);
}

/**
 * THE RUNNER WRITES ONE FILE PER PHASE, AND THIS READ HAD NOT NOTICED.
 *
 * `managed-browser.js` used to write a single `stratus-result.json`. The emailed-security-code work
 * made a run two-phased and it now writes `stratus-result-<phase>.json`: phase 0 is the ordinary
 * run, phase 1 is the continuation that types the code and resubmits. Production already reads it
 * that way (`managed-browser.js:1821` and `:1875`).
 *
 * The trial did not, so against the runner's real `origin/main` every managed case threw ENOENT and
 * the score collapsed from 9 of 12 to 4 of 12 while looking like a product regression. It only kept
 * working at all because the shared checkout it defaults to was several merges behind, which is the
 * second time that stale checkout has produced a wrong measurement in one day.
 *
 * Phase 1 wins when it exists, because a continuation is the later and truer account of the run.
 * The unsuffixed name is still accepted so the trial can be pointed at an older runner without
 * silently reporting every case as broken, which is the failure this comment exists to prevent.
 */
function readSandboxResult(dir: string): SandboxResult {
  for (const name of ['stratus-result-1.json', 'stratus-result-0.json', 'stratus-result.json']) {
    const path = join(dir, name);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as SandboxResult;
  }
  throw new Error(
    'the managed runner wrote no result file; expected stratus-result-1.json, stratus-result-0.json or stratus-result.json',
  );
}

/* ─── driver ────────────────────────────────────────────────────────────────────────────────── */

function shapeUrl(shape: string, query: Record<string, string> = {}): string {
  const target = new URL('/qa/portal-submission', BASE);
  target.searchParams.set('board', query.board ?? 'greenhouse');
  target.searchParams.set('shape', shape);
  target.searchParams.set('case', shape);
  for (const [key, value] of Object.entries(query)) {
    if (key !== 'board') target.searchParams.set(key, value);
  }
  return target.toString();
}

async function main() {
  const only = process.argv.slice(2);
  const selected = only.length > 0 ? CASES.filter((entry) => only.includes(entry.id)) : CASES;
  if (selected.length === 0) {
    console.log(`no such case. known: ${CASES.map((entry) => entry.id).join(', ')}`);
    process.exit(2);
  }
  const managedAvailable = existsSync(join(STRATUS_REPO, 'src', 'managed-browser.js'));
  const browser = await chromium.launch({ headless: true });

  const ctx: Ctx = {
    async gate(shape, query) {
      const page = await browser.newPage();
      try {
        await page.goto(shapeUrl(shape, query), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(500);
        return await page.evaluate(READ_SUBMIT_READINESS_SCRIPT) as { blocking: string[]; stale: string[] };
      } finally {
        await page.close();
      }
    },
    async direct(shape, body, query) {
      const page = await browser.newPage();
      try {
        await page.goto(shapeUrl(shape, query), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return await body(page);
      } finally {
        await page.close();
      }
    },
    async managed(shape, actions, reads, query) {
      /* The reads are appended to the SAME action list, so the real runner performs them at the end
         of the real run. That is the whole reason the fixture mirrors its state onto attributes:
         `extract` is the only DOM read the managed runner has, and a verdict has to come from the
         run that happened rather than from a local re-enactment of it. */
      const withReads: ManagedBrowserAction[] = [
        /* HYDRATION FIRST. The runner navigates on domcontentloaded and acts immediately, and a
           React page that has rendered but not hydrated swallows every interaction and reports a
           clean run. Measured on the date-overlay shape: the identical action list produced
           calendar_opened=1 against a warm page and 0 against a cold one, and the cold run PASSED.
           Production opens its own Greenhouse lists with a waitForSelector for the same reason. */
        { type: 'waitForSelector', selector: 'form[data-litos-qa-ready="1"]', label: 'qa:hydrated', timeout: 20_000 },
        ...actions,
        { type: 'extract', selector: '#litos-qa-log', attribute: 'data-litos-qa-events', label: 'qa:events', optional: true },
        ...reads.map(([key, attribute]): ManagedBrowserAction => ({
          type: 'extract', selector: '#litos-qa-log', attribute, label: `qa:${key}`, optional: true,
        })),
      ];
      const result = runManagedLocally(shapeUrl(shape, query), withReads);
      const read = (label: string) => result.extracted.find((entry) => entry.label === label)?.value ?? null;
      const state: Record<string, string | null> = {};
      for (const [key] of reads) state[key] = read(`qa:${key}`);
      const events = (read('qa:events') ?? '').split('|').filter(Boolean);
      return {
        filledFields: result.filledFields ?? [],
        blockers: result.blockers ?? [],
        skipped: result.skipped ?? [],
        events,
        state,
      };
    },
  };

  let failures = 0;
  for (const entry of selected) {
    if (entry.engine === 'managed' && !managedAvailable) {
      console.log(`SKIP  ${entry.id}  [managed]\n      ${entry.defect}`);
      console.log(`      no stratus checkout at ${STRATUS_REPO}; set STRATUS_REPO. Counted as a failure.`);
      failures += 1;
      continue;
    }
    let verdict: Verdict;
    try {
      verdict = await entry.run(ctx);
    } catch (error) {
      verdict = { pass: false, detail: `threw: ${(error as Error).message.split('\n')[0]}` };
    }
    if (!verdict.pass) failures += 1;
    console.log(`${verdict.pass ? 'PASS' : 'FAIL'}  ${entry.id}  [${entry.engine}]`);
    console.log(`      ${entry.defect}`);
    console.log(`      ${verdict.detail}`);
  }

  await browser.close();
  console.log(`\n${selected.length - failures}/${selected.length} shapes pass against today's production code.`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
