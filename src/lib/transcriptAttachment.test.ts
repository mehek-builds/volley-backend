/* THE TRANSCRIPT SHE UPLOADED AND THE FORM THAT NEVER GOT IT.
 *
 * This file is the transcript's copy of coverLetterAttachment.test.ts, and it exists because the
 * failure it fences off has already happened once to the document beside it. A cover letter was
 * attached only when `_cover_letter.approved_at` was a string; that stamp is written by the final
 * approve; the final approve refuses until filled_fields records the attachment; filled_fields can
 * only record one if the fill carried the file. 111 of the 112 packets in the corpus that held a
 * written letter on a form with a slot for one were sitting inside that circle.
 *
 * A second document is a second chance to build the same circle, so the tests below fence both
 * sides of the escape before there is anything to unwind:
 *
 *   - the attach decision reads the file's presence and nothing else,
 *   - the capability decision is separate, and it is what says whether to attach,
 *   - a run that carried the file and recorded nothing says so instead of calling itself ready,
 *   - and the budget the whole managed path lives against still holds with the file on the packet.
 *
 * Everything here is either a unit test of an exported decision or a source-text fence around one
 * this file cannot call. Where it is source text, that is said in the test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { attachedDocument, type ApplicationRow } from './documentStore';
import {
  MANAGED_ACTION_LIMIT,
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  coverLetterUploadSelector,
  managedResultHasTranscriptUpload,
  portalMayAttachTranscript,
  transcriptUploadSelector,
  type SubmissionPacket,
  type SupportedPortal,
} from './portalSubmission';
import {
  MANAGED_TRANSCRIPT_MAX_BYTES,
  documentBytesForPacket,
  packetForTranscriptCapability,
  preparationEvidenceBlockers,
  transcriptObjectKeyToAttach,
} from '../routes/submissionRunner';

// __dirname rather than import.meta.url: tsconfig.api.json compiles this tree as CommonJS. Same
// reason as coverLetterAttachment.test.ts.
const routeSource = (name: string) => readFileSync(join(__dirname, '..', 'routes', name), 'utf8');

/* The spec as the upload route writes it. Note what is NOT here and never will be: an approval
   stamp, a review status, or anything else the fill would have to wait on. */
const ATTACHED_SPEC = {
  _documents: {
    transcript: {
      document_id: '0f2a9c1e-6b1d-4d9e-9d2a-1f0c7a5e4b33',
      file_name: 'Fall 2025 unofficial transcript.pdf',
      object_key: 'users/a18f774b-a306-4804-93f3-cd6020c27fb3/documents/'
        + '5d3f0b6a-9a71-4f3a-9c2f-2b6a1d8e7c40.pdf',
      attached_at: '2026-08-11T09:14:02.118Z',
      ordered_at: null,
      employer_label: 'Unofficial transcript',
      official_requested: false,
    },
  },
};

test('an attached transcript is attached, with no second condition to satisfy first', () => {
  assert.equal(
    transcriptObjectKeyToAttach(ATTACHED_SPEC),
    'users/a18f774b-a306-4804-93f3-cd6020c27fb3/documents/5d3f0b6a-9a71-4f3a-9c2f-2b6a1d8e7c40.pdf',
  );
});

test('nothing is attached when no file was attached', () => {
  assert.equal(transcriptObjectKeyToAttach({}), null);
  assert.equal(transcriptObjectKeyToAttach(undefined), null);
  assert.equal(transcriptObjectKeyToAttach(null), null);
  assert.equal(transcriptObjectKeyToAttach({ _documents: {} }), null);
  assert.equal(transcriptObjectKeyToAttach({ _documents: { transcript: {} } }), null);
  // Shapes a hand-edited or partially written spec can hold. None of them may reach a blob read.
  assert.equal(transcriptObjectKeyToAttach({ _documents: [] }), null);
  assert.equal(transcriptObjectKeyToAttach({ _documents: { transcript: [] } }), null);
  assert.equal(transcriptObjectKeyToAttach({ _documents: { transcript: 'users/x.pdf' } }), null);
  assert.equal(transcriptObjectKeyToAttach({ _documents: { transcript: { object_key: 42 } } }), null);
  // A blank key is not a key. resolveBlobUrl would list the whole store on an empty prefix.
  assert.equal(transcriptObjectKeyToAttach({ _documents: { transcript: { object_key: '   ' } } }), null);
});

/* THE SIDE OF THE CIRCLE THAT HAS TO STAY OPEN.
 *
 * The cover letter's version of this test compares the send gate's reading of the artifact against
 * the fill's. Here the two readers are attachedDocument, which is what the dashboard row and the
 * checklist see, and transcriptObjectKeyToAttach, which is what the packet builder sees. They are
 * allowed to disagree in exactly one direction and one case, and this pins both halves.
 */
test('the dashboard reader and the fill agree about what counts as an attached transcript', () => {
  const row = { spec: ATTACHED_SPEC } as unknown as ApplicationRow;
  assert.ok(attachedDocument(row, 'transcript'));
  assert.ok(transcriptObjectKeyToAttach(ATTACHED_SPEC));

  /* THE ONE DELIBERATE DISAGREEMENT. "I have ordered it" records an acknowledgement so the row
     stops asking, and it is not a file: document_id and object_key are both null by construction.
     The dashboard must still see it, because that is the whole point of the button, and the fill
     must still see nothing, because Litos cannot put a registrar's sealed envelope on a form. If
     this ever starts attaching, an application goes out claiming a document that does not exist. */
  const orderedSpec = {
    _documents: {
      transcript: {
        document_id: null,
        file_name: null,
        object_key: null,
        attached_at: null,
        ordered_at: '2026-08-11T09:20:00.000Z',
        employer_label: 'Official transcript',
        official_requested: true,
      },
    },
  };
  assert.ok(attachedDocument({ spec: orderedSpec } as unknown as ApplicationRow, 'transcript'));
  assert.equal(transcriptObjectKeyToAttach(orderedSpec), null);
});

/* THE TERM THAT MUST NEVER BE ADDED, asserted against the source because the only way to test the
   absence of a future condition is to read the condition. Same fence as the cover letter's, and
   deliberately wider: approved_at is the term that did the damage there, but any of these would
   rebuild the same circle for this document, since every one of them is written by something that
   happens after a fill. */
test('the transcript attach decision has one term, and it is the file', () => {
  const runner = routeSource('submissionRunner.ts');
  const attach = runner.slice(
    runner.indexOf('export function transcriptObjectKeyToAttach'),
    runner.indexOf('function referralIdentity'),
  );
  assert.ok(attach.length > 0, 'the attach decision must live in one named place');
  const body = attach.slice(attach.indexOf('{', attach.indexOf('transcriptObjectKeyToAttach(')));
  for (const forbidden of [/\bapproved_at\b/, /\battached_at\b/, /\bfinal_approved_at\b/, /\bstatus\b/]) {
    assert.doesNotMatch(
      body,
      forbidden,
      'attaching may depend on the file existing and on nothing that a later step writes',
    );
  }
});

function transcriptPacket(overrides: Partial<SubmissionPacket> = {}): SubmissionPacket {
  return {
    fullName: 'Mehek Mandal',
    email: 'applicant@example.invalid',
    phone: '+971 567417451',
    city: 'Dubai',
    country: 'United Arab Emirates',
    school: 'University of Southern California',
    degree: "Bachelor's Degree",
    major: 'Computer Science',
    graduationDate: 'May 2028',
    gpa: '3.89',
    currentlyEnrolled: true,
    roleLocation: 'San Francisco, CA',
    resume: Buffer.from('%PDF resume'),
    resumeName: 'resume.pdf',
    coverLetter: Buffer.from('%PDF cover'),
    coverLetterName: 'cover.pdf',
    transcript: Buffer.from('%PDF transcript'),
    transcriptName: 'Mehek_Mandal_Data_Science_Intern_Transcript.pdf',
    questions: [],
    ...overrides,
  } as SubmissionPacket;
}

/* THE BUDGET, AGAIN, AND WITH ONE LESS SLOT TO SPARE THAN LAST TIME.
 *
 * MANAGED_ACTION_LIMIT is 120 and the runner answers a longer list with HTTP 400 TOO_MANY_ACTIONS
 * before a browser opens - the whole run lost, and lost invisibly, since the discovery call is taken
 * with a catch. The Cresta packet measured 119 without a cover letter and exactly 120 with one, so
 * this document is being added to the family that was already sitting on the ceiling. The trim is
 * what absorbs it, and this pins the two things that must survive that trim: the list fits, and the
 * upload is still in it. */
test('carrying the transcript keeps the greenhouse fill inside the runner ceiling', () => {
  for (const submit of [false, true]) {
    const actions = buildManagedPortalActions('greenhouse', transcriptPacket(), submit);
    assert.ok(
      actions.length <= MANAGED_ACTION_LIMIT,
      `greenhouse fill with a transcript is ${actions.length} actions (submit=${submit}), `
      + `and the runner rejects anything over ${MANAGED_ACTION_LIMIT}`,
    );
    const uploads = actions.filter((action) => action.label === 'transcript');
    assert.equal(uploads.length, 1, `the transcript upload must survive the trim (submit=${submit})`);
    assert.equal(uploads[0]?.type, 'upload');
    assert.equal(uploads[0]?.file?.name, 'Mehek_Mandal_Data_Science_Intern_Transcript.pdf');
    // Never anything but the file she handed over.
    assert.equal(uploads[0]?.file?.base64, Buffer.from('%PDF transcript').toString('base64'));
    assert.equal(uploads[0]?.selector, transcriptUploadSelector('greenhouse'));
  }
});

/* ORDER, AND WHY IT IS NOT A STYLE CHOICE. GREENHOUSE_RESUME_SELECTOR and ASHBY_RESUME_SELECTOR
   both contain input[type="file"][name*="resume" i]; uploadFirst takes the first selector that
   matches and accepts; setInputFiles REPLACES what a control was holding. So an upload ordered
   before the resume's does not merely miss, it can take the resume's slot and send the wrong file
   to the employer under the right name. */
test('every document upload is pushed after the resume, and none of them shares its control', () => {
  for (const portal of ['greenhouse', 'ashby', 'lever', 'workable'] as const) {
    const actions = buildManagedPortalActions(portal, transcriptPacket());
    const labelIndex = (label: string) => actions.findIndex((action) => action.label === label);
    const resumeIndex = labelIndex('resume');
    const transcriptIndex = labelIndex('transcript');
    assert.ok(resumeIndex >= 0, `${portal} must still upload the resume`);
    assert.ok(transcriptIndex > resumeIndex, `${portal} must upload the transcript after the resume`);
    const coverIndex = labelIndex('cover_letter');
    if (coverIndex >= 0) {
      assert.ok(transcriptIndex > coverIndex, `${portal} must upload the transcript after the cover letter`);
    }
    const selectorFor = (label: string) => actions.find((action) => action.label === label)?.selector;
    assert.notEqual(selectorFor('transcript'), selectorFor('resume'));
    assert.notEqual(selectorFor('transcript'), selectorFor('cover_letter'));
  }
});

test('ashby pays exactly one action for the transcript and nothing else', () => {
  const withTranscript = buildManagedPortalActions('ashby', transcriptPacket());
  const without = buildManagedPortalActions('ashby', transcriptPacket({
    transcript: undefined,
    transcriptName: undefined,
  }));
  assert.equal(withTranscript.length - without.length, 1);
  assert.equal(withTranscript.filter((action) => action.label === 'transcript').length, 1);
});

/* A PORTAL THAT CANNOT TAKE ONE PAYS NOTHING AND CLAIMS NOTHING.
 *
 * Two separate promises. The action list must not spend one of 120 slots on a selector that
 * provably matches nothing, and the capability must read false no matter what comes back, because
 * transcript_supported is what the submit run re-derives its attach decision from. A family that
 * says yes and cannot attach records an application as carrying a document it never sent. */
test('a portal with no transcript control spends no action and reports no capability', () => {
  for (const portal of ['jazzhr', 'breezy', 'bamboohr', 'smartrecruiters', 'icims'] as const) {
    assert.equal(portalMayAttachTranscript(portal), false);
    const actions = buildManagedPortalActions(portal, transcriptPacket());
    assert.equal(actions.some((action) => action.label === 'transcript'), false, portal);
    const discovery = buildManagedDiscoveryActions(portal, transcriptPacket());
    assert.equal(discovery.some((action) => action.label === 'transcript_capability'), false, portal);
    assert.equal(
      managedResultHasTranscriptUpload(
        { extracted: [{ label: 'transcript_capability', value: 'file' }] } as never,
        portal,
      ),
      false,
      `${portal} must not claim a capability its fill path cannot use`,
    );
  }
});

test('a portal that can take one reads the capability off the page', () => {
  const discovery = buildManagedDiscoveryActions('greenhouse', transcriptPacket());
  const probe = discovery.find((action) => action.label === 'transcript_capability');
  assert.deepEqual(probe, {
    type: 'extract',
    selector: transcriptUploadSelector('greenhouse'),
    attribute: 'type',
    label: 'transcript_capability',
    optional: true,
    timeout: 10_000,
  });
  assert.ok(discovery.length <= MANAGED_ACTION_LIMIT, `discovery is over budget at ${discovery.length}`);
  assert.equal(
    managedResultHasTranscriptUpload(
      { extracted: [{ label: 'transcript_capability', value: 'file' }] } as never,
      'greenhouse',
    ),
    true,
  );
  // Absence is a no, and so is a control that is not a file input.
  assert.equal(managedResultHasTranscriptUpload({ extracted: [] } as never, 'greenhouse'), false);
  assert.equal(managedResultHasTranscriptUpload(null, 'greenhouse'), false);
  assert.equal(
    managedResultHasTranscriptUpload(
      { extracted: [{ label: 'transcript_capability', value: 'text' }] } as never,
      'greenhouse',
    ),
    false,
  );
});

/* THE SELECTOR MAY NOT REACH THE RESUME. Every arm is checked rather than the map as a whole,
   because one broad arm is enough: the transcript is uploaded last, so a match on the resume's own
   input overwrites a resume that had already been attached correctly. */
test('no transcript selector can match a resume or cover-letter control', () => {
  const portals: SupportedPortal[] = [
    'greenhouse', 'lever', 'ashby', 'workable', 'paylocity', 'rippling', 'recruitee',
    'manual_recruitee', 'teamtailor', 'personio', 'pinpoint', 'comeet', 'controlled_test',
    'controlled_lever', 'controlled_ashby', 'controlled_workable', 'controlled_paylocity',
    'controlled_rippling', 'smartrecruiters', 'controlled_smartrecruiters', 'jazzhr',
    'controlled_jazzhr', 'breezy', 'controlled_breezy', 'bamboohr', 'controlled_bamboohr',
    'zoho_recruit', 'bullhorn', 'sap_successfactors', 'oracle_taleo', 'adp_recruiting', 'avature',
    'jobvite', 'icims', 'oraclecloud', 'ultipro',
  ];
  for (const portal of portals) {
    const selector = transcriptUploadSelector(portal);
    assert.ok(selector, `${portal} must answer the question one way or the other`);
    assert.notEqual(selector, coverLetterUploadSelector(portal), portal);
    if (!portalMayAttachTranscript(portal)) continue;
    for (const arm of selector.split(', ')) {
      assert.match(arm, /transcript/i, `${portal} arm matches on something other than the word: ${arm}`);
      // The tokens may appear only inside the exclusions, never as something the arm selects on.
      const selecting = arm.replace(/:not\([^)]*\)/g, '');
      assert.doesNotMatch(selecting, /resume/i, `${portal} arm can reach the resume control: ${arm}`);
      assert.doesNotMatch(selecting, /cover/i, `${portal} arm can reach the cover letter control: ${arm}`);
      assert.match(arm, /:not\(\[name\*="resume" i\]\)/, `${portal} arm is missing the resume exclusion: ${arm}`);
      assert.match(arm, /:not\(\[name\*="cover" i\]\)/, `${portal} arm is missing the cover exclusion: ${arm}`);
    }
  }
});

/* READY-BUT-MISSING-THE-DOCUMENT IS THE OUTCOME THAT MUST NOT SURVIVE.
 *
 * Both upload paths fail quietly by construction: uploadFirst steps over a non-file element with a
 * bare `continue` and swallows a failed setInputFiles with `catch { continue; }`, and the managed
 * runner reports a non-matching optional selector into `skipped`. This sentence is the only signal
 * there is. It does not prove the employer's own uploader registered the file, and nothing on either
 * path can prove that; it proves the run did not record the attachment. */
test('a fill that carried a transcript and recorded none is reported, not hidden', () => {
  const issues = preparationEvidenceBlockers(
    {
      text: 'Apply for this job. First Name Last Name Email Phone Resume Cover Letter Transcript Submit application',
      filledFields: ['first_name', 'last_name', 'email', 'phone', 'resume', 'cover_letter'],
      blockers: [],
      discovered: [],
      extracted: [],
    },
    transcriptPacket(),
  );
  assert.deepEqual(issues, ['The filled form did not record the transcript attachment.']);
  // The same run with the attachment recorded is clean, so the sentence is about the transcript and
  // not about something else the fixture happens to be missing.
  assert.deepEqual(
    preparationEvidenceBlockers(
      {
        text: 'Apply for this job. First Name Last Name Email Phone Resume Cover Letter Transcript Submit application',
        filledFields: ['first_name', 'last_name', 'email', 'phone', 'resume', 'cover_letter', 'transcript'],
        blockers: [],
        discovered: [],
        extracted: [],
      },
      transcriptPacket(),
    ),
    [],
  );
  // And an application with no transcript is never asked about one.
  assert.deepEqual(
    preparationEvidenceBlockers(
      {
        text: 'Apply for this job. First Name Last Name Email Phone Resume Submit application',
        filledFields: ['first_name', 'last_name', 'email', 'phone', 'resume'],
        blockers: [],
        discovered: [],
        extracted: [],
      },
      transcriptPacket({ transcript: undefined, transcriptName: undefined, coverLetter: undefined, coverLetterName: undefined }),
    ),
    [],
  );
});

/* THE CAPABILITY DECISION, WHICH IS THE OTHER HALF OF THE ESCAPE. Attaching asks "is there a file";
   this asks "does this form have anywhere to put it", and keeping them apart is what makes the
   first one unable to deadlock. */
test('a form with nowhere to put a transcript carries none, and says nothing about it', () => {
  const outcome = packetForTranscriptCapability(transcriptPacket(), false);
  assert.equal(outcome.packet.transcript, undefined);
  assert.equal(outcome.packet.transcriptName, undefined);
  assert.equal(outcome.transcriptIssue, undefined);
  // The rest of the packet is untouched: this decision is about one document.
  assert.equal(outcome.packet.coverLetter?.toString('utf8'), '%PDF cover');
  assert.equal(outcome.packet.resume.toString('utf8'), '%PDF resume');
});

test('a form that asks for one carries it', () => {
  const outcome = packetForTranscriptCapability(transcriptPacket(), true);
  assert.equal(outcome.packet.transcript?.toString('utf8'), '%PDF transcript');
  assert.equal(outcome.packet.transcriptName, 'Mehek_Mandal_Data_Science_Intern_Transcript.pdf');
  assert.equal(outcome.transcriptIssue, undefined);
});

/* THE DEAD POINTER, which is reachable by design rather than by accident: removing a document
   deletes its blob and tombstones the row, and deliberately does NOT rewrite the spec of every
   application that already carried it, because a sent application still has to be able to say what
   went out with it. So the file goes missing under a live pointer, and the run has to degrade rather
   than abort - buildPacket is called bare at nine sites and only one of them catches anything. */
test('a transcript that cannot be loaded degrades the run and owes her a sentence', () => {
  const outcome = packetForTranscriptCapability(
    transcriptPacket({ transcript: undefined, transcriptName: undefined, transcriptUnavailableReason: 'That file could not be downloaded' }),
    true,
  );
  assert.equal(outcome.packet.transcript, undefined);
  assert.equal(outcome.packet.transcriptUnavailableReason, undefined, 'a stripped packet carries neither the file nor the reason');
  assert.ok(outcome.transcriptIssue);
  assert.ok(!outcome.transcriptIssue!.includes('${'), 'the applicant-facing sentence must not interpolate anything');
  assert.doesNotMatch(outcome.transcriptIssue!, /could not be downloaded/, 'the raw error must not reach the applicant');

  // On a form with no transcript control the same failure is not worth a word: nothing was going to
  // be attached there anyway, and a sentence on every such packet is noise.
  assert.equal(
    packetForTranscriptCapability(
      transcriptPacket({ transcript: undefined, transcriptName: undefined, transcriptUnavailableReason: 'That file is unavailable' }),
      false,
    ).transcriptIssue,
    undefined,
  );
});

/* THE LOAD ITSELF MAY NOT THROW, which is what the degrade above depends on. The cover letter's
   fetch does throw, exactly one of buildPacket's callers catches it, and that asymmetry is the
   hazard this document is not allowed to inherit. Source text, because the alternative is a live
   Blob read inside a unit test. */
test('buildPacket records a transcript it cannot load instead of throwing', () => {
  const runner = routeSource('submissionRunner.ts');
  const build = runner.slice(
    runner.indexOf('export async function buildPacket('),
    runner.indexOf('export function readMostRecentRole'),
  );
  assert.ok(build.length > 0, 'buildPacket must still exist');
  assert.match(
    build,
    /transcript = await documentBytesForPacket\(row\.user_id, transcriptKey, controlledTest\);\s*\} catch \(error\) \{/,
    'the transcript load is inside a catch, and it is scoped to this user',
  );
  assert.match(build, /transcriptUnavailableReason = error instanceof Error \? error\.message : String\(error\)/);
  assert.match(build, /transcriptName: transcript \? transcriptFileNameForRole\(/,
    'the name and the file must go missing together, or an absent document stops being a no-op');
});

/* THE SIZE CAP. The upload route refuses a larger file at the door, so this is defence in depth
   rather than the enforcement point - and it is worth having because the number is not arbitrary.
   The managed sandbox carries an upload as base64 and rejects anything over 6,000,000 characters
   before a browser opens, with no request-body limit in front of that check, so the failure above
   the ceiling is either a 400 the run cannot explain or a platform rejection with no run record at
   all. Omit and say so beats attach and find out. */
test('a transcript too large for the managed runner is omitted with a named reason', () => {
  const oversize = Buffer.alloc(MANAGED_TRANSCRIPT_MAX_BYTES + 1, 0x20);
  const outcome = packetForTranscriptCapability(transcriptPacket({ transcript: oversize }), true);
  assert.equal(outcome.packet.transcript, undefined);
  assert.equal(outcome.packet.transcriptName, undefined);
  assert.ok(outcome.transcriptIssue);
  assert.match(outcome.transcriptIssue!, /4 MB/, 'the sentence names the limit the UI states');

  // Exactly at the cap is carried. An off-by-one here refuses a file the product promised to take.
  const atCap = Buffer.alloc(MANAGED_TRANSCRIPT_MAX_BYTES, 0x20);
  const allowed = packetForTranscriptCapability(transcriptPacket({ transcript: atCap }), true);
  assert.equal(allowed.packet.transcript?.length, MANAGED_TRANSCRIPT_MAX_BYTES);
  assert.equal(allowed.transcriptIssue, undefined);
});

test('the cap is the same number the upload route enforces', () => {
  const store = readFileSync(join(__dirname, 'documentStore.ts'), 'utf8');
  assert.match(store, /MAX_USER_DOCUMENT_BYTES = 4_000_000/);
  assert.equal(MANAGED_TRANSCRIPT_MAX_BYTES, 4_000_000);
});

/* A CONTROLLED RUN READS NO BLOB, FOR ANY FILE IT CARRIES.
 *
 * packetUsesControlledResumeFixture covers the resume alone, so the fixture branch here is what
 * stops a controlled QA run reaching for a real object and failing on the one portal that exists to
 * have no dependencies. Asserted through the injected dependencies: neither is allowed to be called.
 */
test('a controlled run takes fixture bytes for an attached document', async () => {
  const previous = process.env.LITOS_ENABLE_TEST_PORTAL;
  try {
    process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
    let resolverCalls = 0;
    let fetchCalls = 0;
    const bytes = await documentBytesForPacket('user-1', 'users/user-1/documents/a.pdf', true, {
      resolveObjectUrl: async () => {
        resolverCalls += 1;
        return 'https://blob.example.test/should-not-be-read';
      },
      fetchObject: async () => {
        fetchCalls += 1;
        return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
      },
    });
    assert.match(bytes.toString('utf8'), /Litos controlled attached-document fixture/);
    assert.equal(resolverCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
    else process.env.LITOS_ENABLE_TEST_PORTAL = previous;
  }
});

/* THE STORED POINTER IS READ BEFORE THE RESOLVER, and the ordering is the whole reason blob_url is
   a column. resolveBlobUrl goes through list({ prefix }), which is eventually consistent with no
   stated bound - reproduced still 404ing 54 seconds after the write, and R-040 was every Ashby fill
   of 2026-07-18 shipping without a resume because of it. A transcript uploaded and attached in one
   sitting is exactly that window. Source text: the read that proves it needs a database. */
test('the attached document is fetched from the URL the write returned, not from a list', () => {
  const runner = routeSource('submissionRunner.ts');
  const fn = runner.slice(
    runner.indexOf('export async function documentBytesForPacket'),
    runner.indexOf('export async function buildPacket('),
  );
  assert.ok(fn.length > 0, 'documentBytesForPacket must still exist');
  assert.match(fn, /blob_url: user_documents\.blob_url/);
  assert.match(fn, /documentBytesFromPointer\(\{ blobUrl: row\.blob_url, objectKey: row\.object_key \}/);
  const store = readFileSync(join(__dirname, 'documentStore.ts'), 'utf8');
  const pointerStart = store.indexOf('export async function documentBytesFromPointer');
  const pointerEnd = store.indexOf('export async function listUserDocuments');
  // Asserted, because a slice taken between two indexOf calls that stopped matching is a slice that
  // silently changes what the assertions below are reading rather than failing.
  assert.ok(pointerStart >= 0 && pointerEnd > pointerStart, 'documentBytesFromPointer must still be found');
  const pointer = store.slice(pointerStart, pointerEnd);
  assert.match(pointer, /pointer\.blobUrl \|\| \(await dependencies\.resolveObjectUrl\(pointer\.objectKey\)\)/);
  assert.match(pointer, /return openDocument\(/, 'the stored bytes are ciphertext and must be unsealed');
});

/* THE ASSERTION THIS TEST REPLACES IS THE POINT OF IT.
 *
 * The test above used to also assert `eq(user_documents.user_id, userId)` and call that "a spec
 * cannot name another user's file". The predicate was there and the claim was false: on a miss the
 * function passed `blobUrl: null` into documentBytesFromPointer, which falls back to resolveBlobUrl,
 * which takes an object key and nothing else. Another account's key missed the scoped row and was
 * then resolved and decrypted through the fallback. A grep for the predicate could never see that,
 * so a grep for the predicate is not what guards it any more.
 *
 * What guards it is routes/documentPacketScope.test.ts, which seeds two real users in a real
 * database, asks for one user's file with the other user's id, and counts the resolver. This is the
 * cheap structural half: the miss has to be a throw, because a fall-through of ANY shape underneath
 * it re-opens the same hole. */
test('a scoped miss refuses instead of falling through to the unscoped resolver', () => {
  const runner = routeSource('submissionRunner.ts');
  const fn = runner.slice(
    runner.indexOf('export async function documentBytesForPacket'),
    runner.indexOf('export async function buildPacket('),
  );
  assert.match(fn, /if \(!row\) throw new ForeignDocumentPointerError\(\);/);
  // The refusal comes before the only call that can reach blob storage, so there is no ordering in
  // which a refused pointer is still fetched.
  assert.ok(
    fn.indexOf('throw new ForeignDocumentPointerError()') < fn.indexOf('documentBytesFromPointer('),
    'the refusal has to precede the fetch, not follow it',
  );
  // `row?.` anywhere in here means an optional row survived, which is the shape the defect had.
  assert.doesNotMatch(fn, /row\?\./, 'the row is proven present by the throw, so it is never optional');
});

/* THE FLAG HAS TO BE WRITTEN WHERE IT IS MEASURED AND READ WHERE IT IS USED, and the failure it
 * prevents has no symptom: the transcript attaches on the preview she approves and is missing from
 * the application that is sent, with nothing recorded either way. Two prepare paths write it, three
 * submit paths read it, and there is no fourth of either. */
test('transcript_supported is written by both prepares and read by all three submits', () => {
  const runner = routeSource('submissionRunner.ts');
  assert.equal(runner.match(/transcript_supported: transcriptSupported/g)?.length, 2,
    'both the managed and the direct prepare must record what they measured');
  assert.match(runner, /const transcriptSupported = managedResultHasTranscriptUpload\(discoveryResult, portal\)/);
  assert.match(runner, /const transcriptSupported = await hasTranscriptUpload\(page, portal\)/);

  /* THE MANAGED WRITE IS GUARDED ON THE DISCOVERY PASS HAVING RUN, and that guard is the whole
   * difference between a measurement and an invention.
   *
   * runManagedBrowser's catch returns null for any failure, and managedResultHasTranscriptUpload
   * ends `=== true`, so null reads as false. Writing the flag unconditionally therefore records
   * `transcript_supported: false` whenever discovery merely errored, and false is not "unknown" to
   * anything downstream: it means "this employer's form has nowhere to put a transcript". The
   * screen states that to her as fact, files the ask undeliverable, withholds the Add control and
   * tells her to finish by hand a form that may well have accepted the file. Absent is the third
   * state and the only honest one, matching cover_letter_required in the same object literal. */
  assert.match(runner, /\.\.\.\(discoveryFailures\.length === 0 \? \{ transcript_supported: transcriptSupported \} : \{\}\),/,
    'the managed prepare must write the flag only when the discovery pass actually ran');

  assert.equal(runner.match(/transcript_supported === true/g)?.length, 3,
    'the ATS API channel and both browser submits re-derive the attach decision from the flag');
  assert.match(runner, /review\.transcript_supported === true \? withCoverLetter : omitTranscript\(withCoverLetter\)/);
  assert.equal(runner.match(/claimedReview\.transcript_supported === true/g)?.length, 2);
});

/* THE API CHANNEL IS A THIRD DELIVERY PATH AND IT SHIPS THE SAME APPLICATION. A document added only
   to the browser paths is missing from every submission that goes out through a configured board
   token, which is the same application sent two different ways depending on an environment variable.
   Three form builders, three appends, each guarded on the file, the name, and the employer's own
   name for the part.

   THE THIRD TERM IS THE ONE THIS TEST WAS REWRITTEN FOR. It used to assert the append happened under
   the literal `'transcript'` and called that carrying the document. A multipart part name an API does
   not recognise is accepted at the HTTP level and dropped, so the assertion was pinning a submission
   that returns 200, files the application and delivers nothing. What the part is CALLED cannot be
   settled here - only a real API submission can settle it - so what is fenced instead is that no
   builder posts a name nobody configured. The behavioural half is in atsSubmissionChannels.test.ts,
   which drives all three channels with and without a mapping. */
test('every ATS API form builder carries the transcript it was given, under a configured name', () => {
  const channels = readFileSync(join(__dirname, 'atsSubmissionChannels.ts'), 'utf8');
  assert.equal(
    channels.match(/if \(packet\.transcript && packet\.transcriptName && transcript(?:Field|Path)\) \{/g)?.length,
    3,
    'all three builders append the document, and none of them appends it unnamed',
  );
  // The guess, asserted absent. This is the exact literal that was there, and it is the one thing a
  // future edit could reintroduce while every behavioural test above still passed on the mapped path.
  assert.doesNotMatch(
    channels,
    /form\.append\('transcript',/,
    'a hardcoded part name is the defect this fence exists for',
  );
  // Every builder resolves the name through the same reader, so a fourth channel cannot quietly grow
  // its own rule about what an employer's form calls this document.
  assert.equal(channels.match(/transcriptFieldName\(channel\)/g)?.length, 3);
  assert.match(channels, /function transcriptFieldName\(channel: ConfiguredChannel\): string \| undefined \{\s*return trimmed\(channel\.fieldPaths\?\.transcript\);/);
  // And all three refuse the channel rather than sending an application without the document.
  assert.equal(channels.match(/\.\.\.transcriptMissingFields\(channel, packet\)/g)?.length, 3);
});
