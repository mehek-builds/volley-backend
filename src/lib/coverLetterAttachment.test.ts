/* THE COVER LETTER THAT WAS WRITTEN AND NEVER ATTACHED.
 *
 * Cresta packet 8142004c-3358-4538-8778-16df5e31c5bb, 2026-08-09: status ready_for_final_approval,
 * cover_letter_supported true, a complete 294-word letter with a live 3121-byte PDF in blob storage,
 * filled_fields ["first_name","last_name","preferred_first_name","email","phone","resume"], and a
 * Send button that returned 422 FINAL_APPROVAL_VERIFICATION_FAILED with "The filled form did not
 * record the cover letter attachment."
 *
 * The gate was right. The fill was wrong, and it was wrong at exactly one term.
 *
 * buildPacket attached a cover letter only when `_cover_letter.approved_at` was a string.
 * `approved_at` is written in one place: approvedReviewSpec in routes/applications.ts, on the FINAL
 * APPROVE. Final approve refuses until filled_fields records a cover entry. filled_fields can only
 * record one if the fill carried the file. So the file could not be carried until the approval was
 * granted, and the approval could not be granted until the file had been carried. A closed circle,
 * and 111 of the 112 packets in the corpus that hold a written letter on a form that has a slot for
 * one were sitting inside it.
 *
 * These tests are the fence around each side of that circle.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { storedCoverLetter } from './coverLetterService';
import {
  MANAGED_ACTION_LIMIT,
  buildManagedPortalActions,
  coverLetterUploadSelector,
  type SubmissionPacket,
} from './portalSubmission';
import { coverLetterObjectKeyToAttach, preparationEvidenceBlockers } from '../routes/submissionRunner';

// __dirname rather than import.meta.url: tsconfig.api.json compiles this tree as CommonJS. Same
// reason as portalSupport.test.ts.
const routeSource = (name: string) => readFileSync(join(__dirname, '..', 'routes', name), 'utf8');

/* The row as prod actually holds it. approved_at is ABSENT, because generateStoredCoverLetter
   persists with approved=false and nothing before the final approve ever sets it. */
const CRESTA_SPEC = {
  _cover_letter: {
    body: 'Dear Cresta hiring team, ...',
    word_count: 294,
    warnings: [],
    generated_at: '2026-08-08T22:10:04.860Z',
    object_key:
      'users/a18f774b-a306-4804-93f3-cd6020c27fb3/resumes/'
      + '8142004c-3358-4538-8778-16df5e31c5bb-cover-letter-1786227004770.pdf',
    file_name: 'Mehek_Mandal_Data_Science_Intern_Cover_Letter.pdf',
  },
};

test('a written cover letter is attached without waiting for an approval that cannot come first', () => {
  assert.equal(
    coverLetterObjectKeyToAttach(CRESTA_SPEC),
    'users/a18f774b-a306-4804-93f3-cd6020c27fb3/resumes/'
    + '8142004c-3358-4538-8778-16df5e31c5bb-cover-letter-1786227004770.pdf',
  );
});

test('nothing is attached when there is nothing written', () => {
  assert.equal(coverLetterObjectKeyToAttach({}), null);
  assert.equal(coverLetterObjectKeyToAttach(undefined), null);
  assert.equal(coverLetterObjectKeyToAttach(null), null);
  assert.equal(coverLetterObjectKeyToAttach({ _cover_letter: {} }), null);
  // A blank key is not a key. resolveBlobUrl would list the whole store on an empty prefix.
  assert.equal(coverLetterObjectKeyToAttach({ _cover_letter: { object_key: '   ' } }), null);
});

/* THE TWO SIDES OF THE CIRCLE MUST READ THE SAME FACT.
 *
 * routes/applications.ts decides the letter is REQUIRED from storedCoverLetter(row), which reads
 * body + object_key + file_name and never looks at approved_at. buildPacket decided the letter was
 * SENDABLE from approved_at. Two predicates over one artifact, disagreeing, with the applicant in
 * the gap. This pins them back together from both ends.
 */
test('the send gate and the fill agree about what counts as a cover letter', () => {
  const service = readFileSync(join(__dirname, 'coverLetterService.ts'), 'utf8');
  const storedFn = service.slice(
    service.indexOf('export function storedCoverLetter'),
    service.indexOf('export function canGenerateCoverLetter'),
  );
  assert.ok(storedFn.length > 0, 'storedCoverLetter must still exist to be compared against');
  assert.doesNotMatch(
    storedFn,
    /approved_at/,
    'the send gate does not require an approval, so the fill must not require one either',
  );

  const runner = routeSource('submissionRunner.ts');
  const attach = runner.slice(
    runner.indexOf('export function coverLetterObjectKeyToAttach'),
    runner.indexOf('export async function buildPacket'),
  );
  assert.ok(attach.length > 0, 'the attach decision must live in one named place');
  const body = attach.slice(attach.indexOf('{', attach.indexOf('coverLetterObjectKeyToAttach(')));
  assert.doesNotMatch(
    body,
    /typeof meta\.approved_at|meta\.approved_at ===|\bapproved_at\b\s*(?:===|!==|\?)/,
    'approved_at is written by the approve that this condition blocks. It cannot be its precondition.',
  );

  // And the artifact this test calls complete really is complete by the send gate's own reading.
  assert.ok(storedCoverLetter({ spec: CRESTA_SPEC } as Parameters<typeof storedCoverLetter>[0]));
});

/* GREENHOUSE'S COVER-LETTER CONTROL IS NOT AN OPEN FILE INPUT, and the resume proves the shape
   works. Read off the live Cresta form on 2026-08-09
   (job-boards.greenhouse.io/embed/job_app?for=cresta&token=5213417008): both controls sit behind an
   "Attach / Dropbox / Enter manually" trio, and both are

     <input id="resume"       class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf">
     <input id="cover_letter" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf">

   setInputFiles does not need the input to be visible, which is why the resume has always attached.
   The cover letter never did, and the selector was never the reason. */
test('the greenhouse cover-letter selector matches the control the live form actually renders', () => {
  const selector = coverLetterUploadSelector('greenhouse');
  assert.ok(
    selector.split(',').map((part) => part.trim()).includes('input#cover_letter[type="file"]'),
    `greenhouse must target the id the live form uses; selector is ${selector}`,
  );
});

function crestaPacket(overrides: Partial<SubmissionPacket> = {}): SubmissionPacket {
  return {
    fullName: 'Mehek Mandal',
    email: 'applicant@example.invalid',
    phone: '+971 567417451',
    city: 'Dubai',
    country: 'United Arab Emirates',
    linkedinUrl: 'https://linkedin.com/in/example',
    githubUrl: 'https://github.com/example',
    portfolioUrl: 'https://example.dev',
    school: 'University of Southern California',
    degree: "Bachelor's Degree",
    major: 'Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    currentlyEnrolled: true,
    referralSourceDefault: 'Company website',
    roleLocation: 'San Francisco, CA',
    resume: Buffer.from('%PDF resume'),
    resumeName: 'resume.pdf',
    coverLetter: Buffer.from('%PDF cover'),
    coverLetterName: 'cover.pdf',
    questions: [],
    ...overrides,
  } as SubmissionPacket;
}

/* THE BUDGET. Greenhouse is the portal that lives against MANAGED_ACTION_LIMIT, and the Cresta
   packet carries zero custom questions and lands at 119 without a cover letter. One upload action
   takes it to exactly 120, which the runner accepts; 121 is rejected with HTTP 400
   TOO_MANY_ACTIONS before a browser opens, and the whole run is lost. Measured both ways so a
   future addition cannot spend the last slot without this failing. */
test('carrying the cover letter keeps the greenhouse fill inside the runner ceiling', () => {
  for (const submit of [false, true]) {
    const actions = buildManagedPortalActions('greenhouse', crestaPacket(), submit);
    assert.ok(
      actions.length <= MANAGED_ACTION_LIMIT,
      `greenhouse fill with a cover letter is ${actions.length} actions (submit=${submit}), `
      + `and the runner rejects anything over ${MANAGED_ACTION_LIMIT}`,
    );
    const uploads = actions.filter((action) => action.label === 'cover_letter');
    assert.equal(uploads.length, 1, `the cover letter upload must survive the trim (submit=${submit})`);
    assert.equal(uploads[0]?.type, 'upload');
    assert.equal(uploads[0]?.file?.name, 'cover.pdf');
    // Never anything but her own generated artifact.
    assert.equal(uploads[0]?.file?.base64, Buffer.from('%PDF cover').toString('base64'));
    assert.equal(uploads[0]?.selector, coverLetterUploadSelector('greenhouse'));
    // And it must not be pointed at the resume control.
    const resumeUpload = actions.find((action) => action.label === 'resume');
    assert.notEqual(uploads[0]?.selector, resumeUpload?.selector);
  }
});

test('ashby pays exactly one action for the cover letter and nothing else', () => {
  const withCover = buildManagedPortalActions('ashby', crestaPacket());
  const without = buildManagedPortalActions('ashby', crestaPacket({
    coverLetter: undefined,
    coverLetterName: undefined,
  }));
  assert.equal(withCover.length - without.length, 1);
  assert.equal(withCover.filter((action) => action.label === 'cover_letter').length, 1);
});

/* READY-BUT-UNSENDABLE IS THE OUTCOME THAT MUST NOT SURVIVE.
 *
 * If the file genuinely cannot be attached on some form, the applicant is owed a sentence and a
 * status she can act on, not a green Send button wired to a 422. Both halves are asserted: the
 * per-field sentence exists, and it reaches the decision that sets the status. */
test('a fill that carried a cover letter and recorded none is reported, not hidden', () => {
  const issues = preparationEvidenceBlockers(
    {
      text: 'Apply for this job. First Name Last Name Email Phone Resume Cover Letter Submit application',
      filledFields: ['first_name', 'last_name', 'preferred_first_name', 'email', 'phone', 'resume'],
      blockers: [],
      discovered: [],
      extracted: [],
    },
    crestaPacket(),
  );
  assert.deepEqual(issues, ['The filled form did not record the cover letter attachment.']);
  // The same run with the attachment recorded is clean, so the sentence is about the attachment and
  // not about something else the fixture happens to be missing.
  assert.deepEqual(
    preparationEvidenceBlockers(
      {
        text: 'Apply for this job. First Name Last Name Email Phone Resume Cover Letter Submit application',
        filledFields: ['first_name', 'last_name', 'email', 'phone', 'resume', 'cover_letter'],
        blockers: [],
        discovered: [],
        extracted: [],
      },
      crestaPacket(),
    ),
    [],
  );
});

test('a cover letter Litos could not attach stops the packet being called ready', () => {
  const runner = routeSource('submissionRunner.ts');

  // Managed path: the term is in the `safe` conjunction, not only in attention_reason.
  const managedSafe = runner.match(/const safe = blockers\.length === 0[\s\S]{0,400}?;/)?.[0] ?? '';
  assert.ok(managedSafe, 'the managed prepare must still compute a `safe`');
  assert.match(
    managedSafe,
    /coverLetterAttention\.length === 0/,
    'on a form with a cover-letter control, no cover letter means /submission/approve returns 422, '
    + 'so the run must not describe the packet as ready',
  );

  // Direct path: same fact, folded into the attention count directPreparationIsSafe reads.
  const directSafe = runner.match(/const safe = directPreparationIsSafe\(\{[\s\S]{0,1200}?\}\);/)?.[0] ?? '';
  assert.ok(directSafe, 'the direct prepare must still compute a `safe`');
  assert.match(directSafe, /attentionCount: discoveryAttention\.length \+ coverLetterAttention\.length/);
});

/* The degrade that became reachable the moment the approved_at term came out. buildPacket now goes
   to blob storage for the letter on every supported form and throws if the object key resolves to
   nothing, so the call that follows generation has to be caught the same way generation is. An
   unhandled throw here would abort a fully filled application over one attachment. */
test('a cover letter that cannot be fetched degrades the run instead of aborting it', () => {
  const runner = routeSource('submissionRunner.ts');
  const fn = runner.slice(
    runner.indexOf('async function packetForCoverLetterCapability'),
    runner.indexOf('function strippedCoverLetterSpec'),
  );
  assert.ok(fn.length > 0, 'packetForCoverLetterCapability must still exist');
  assert.match(fn, /try \{\s*return \{ packet: await buildPacket\(rows\[0\], controlledTest\) \};\s*\} catch \(error\) \{/);
  const issue = fn.match(/coverLetterIssue: '([^']*)'/g) ?? [];
  assert.equal(issue.length, 2, 'both failures owe the applicant a sentence');
  for (const sentence of issue) {
    assert.ok(!sentence.includes('${'), 'the applicant-facing sentence must not interpolate anything');
    assert.ok(!/error\.message/.test(sentence), 'the raw error must not reach the applicant');
  }
  // The detail is not thrown away either.
  assert.match(fn, /fastify\.log\.warn\(\{ error, applicationId: row\.id \}[\s\S]{0,140}could not be attached/);
});

/* THE POST-DISCOVERY REBUILD MUST KEEP THE CONTROLLED RESUME DECISION.
 *
 * prepareManaged builds once before discovery, then packetForCoverLetterCapability rebuilds after
 * discovery. The first build correctly used the QA fixture while this second one silently dropped
 * the flag and tried to read qa/<id>.pdf from Vercel Blob. Pin every exit from this helper, because
 * unsupported forms, generation failure, attachment success and attachment failure all return a
 * separately rebuilt packet. */
test('every cover-letter capability rebuild preserves the caller controlled-resume decision', () => {
  const runner = routeSource('submissionRunner.ts');
  const fn = runner.slice(
    runner.indexOf('async function packetForCoverLetterCapability'),
    runner.indexOf('function strippedCoverLetterSpec'),
  );
  assert.ok(fn.length > 0, 'packetForCoverLetterCapability must still exist');
  assert.match(fn, /fastify: FastifyInstance,\s*controlledTest: boolean,/);

  assert.match(
    fn,
    /if \(!supported\) return \{ packet: omitCoverLetter\(await buildPacket\(row, controlledTest\)\) \};/,
    'a controlled form with no cover-letter input must keep fixture resume bytes after discovery',
  );
  assert.match(
    fn,
    /Cover letter generation failed[\s\S]{0,240}omitCoverLetter\(await buildPacket\(row, controlledTest\)\)/,
    'the generation-error degrade must keep the same resume source',
  );
  assert.match(
    fn,
    /return \{ packet: await buildPacket\(rows\[0\], controlledTest\) \}/,
    'the supported cover-letter success branch must keep the same resume source',
  );
  assert.match(
    fn,
    /strippedCoverLetterSpec\(rows\[0\]\.spec\)[\s\S]{0,100}controlledTest/,
    'the attachment-error degrade must remove only the cover letter, not the controlled resume decision',
  );
  assert.equal(fn.match(/buildPacket\(/g)?.length, 4, 'the helper has exactly four packet rebuild exits');
  assert.equal(
    fn.match(/\bcontrolledTest\b/g)?.length,
    5,
    'the explicit parameter must be used by all four packet rebuilds',
  );

  const managedCall = runner.slice(
    runner.indexOf('async function prepareManaged('),
    runner.indexOf('\nasync function prepare(', runner.indexOf('async function prepareManaged(')),
  );
  assert.match(
    managedCall,
    /packetForCoverLetterCapability\([\s\S]{0,180}packetUsesControlledResumeFixture\(portal\)/,
  );
  const directCall = runner.slice(
    runner.indexOf('async function prepare('),
    runner.indexOf('\nasync function submitControlled(', runner.indexOf('async function prepare(')),
  );
  assert.match(
    directCall,
    /packetForCoverLetterCapability\([\s\S]{0,180}packetUsesControlledResumeFixture\(portal\)/,
  );
  assert.doesNotMatch(
    `${managedCall}\n${directCall}`,
    /packetForCoverLetterCapability\([^;]*,\s*(?:true|false)\s*\)/,
    'callers must derive fixture use from the detected portal, not choose it ad hoc',
  );
});
