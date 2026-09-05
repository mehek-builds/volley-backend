import assert from 'node:assert/strict';
import test from 'node:test';
import type { SubmissionPacket } from './portalSubmission';
import {
  createEmployerDeliveryBindings,
  employerDeliveryBindingIssue,
  employerDeliveryEnvelope,
  employerDeliveryProjection,
  employerDeliverySha256,
  extensionBoundApplicationSpec,
  packetForEmployerDelivery,
  extensionEmployerDeliveryProjection,
  extensionEmployerDeliveryBindingIssue,
  transportBoundEmployerPacket,
  employerDeliveryFieldDigests,
  employerDeliveryDriftFields,
} from './employerDeliveryIdentity';

function packet(): SubmissionPacket {
  return {
    fullName: 'Mehek Mandal',
    email: 'apply@example.com',
    phone: '+971 50 111 1111',
    roleLocation: 'Dubai',
    referralSourceEvidence: {
      kind: 'litos_job_board',
      value: 'Job board',
      jobId: 'job-1',
      sourceId: 'source-1',
      sourceUrl: 'https://trylitos.com/jobs/1',
      observedAt: '2026-08-21T00:00:00.000Z',
    },
    applicationProfile: { phone: '+971 50 111 1111', eeo_prefs: { gender: 'Female' } },
    applicantSnapshot: {
      profile: { full_name: 'Mehek Mandal', email: 'mehek@example.com', experience: [], skills: [], school: 'USC', grad_year: 2026 },
      application_profile: { phone: '+971 50 111 1111', eeo_prefs: { gender: 'Female' } },
    },
    jdText: 'Build trading systems.',
    resume: Buffer.from('resume'),
    resumeName: 'Mehek-Mandal-Resume.pdf',
    coverLetter: Buffer.from('letter'),
    coverLetterName: 'Mehek-Mandal-Cover-Letter.pdf',
    transcript: Buffer.from('transcript'),
    transcriptName: 'Mehek-Mandal-Transcript.pdf',
    eeoPrefs: { gender: 'Female' },
    mostRecentRole: { company: 'Litos', title: 'Founder' },
    questions: [{ question: 'Why us?', answer: 'Because.' }],
  };
}

test('projection hashes file bytes without serializing them and includes every behavior field', () => {
  const projection = employerDeliveryProjection(packet());
  assert.deepEqual(projection.resume, {
    sha256: 'a83a31320d921b888a48fa5edd0b4b5a29984de6e96bf7b8ac7d29ba06caf616',
    sizeBytes: 6,
  });
  assert.equal(projection.phone, '+971 50 111 1111');
  assert.deepEqual(projection.eeoPrefs, { gender: 'Female' });
  assert.deepEqual(projection.mostRecentRole, { company: 'Litos', title: 'Founder' });
});

test('absent and measured-empty managed form inventories have one delivery identity', () => {
  const absent = packet();
  const measuredEmpty = {
    ...packet(),
    fieldOptions: {},
    failedFields: [],
  };
  const envelope = employerDeliveryEnvelope({
    channel: 'browser:stratus-managed',
    destinationUrl: 'https://apply.workable.com/example/j/123',
    portalFamily: 'workable',
  });

  assert.deepEqual(employerDeliveryProjection(absent), employerDeliveryProjection(measuredEmpty));
  assert.equal(employerDeliverySha256(absent, envelope), employerDeliverySha256(measuredEmpty, envelope));
});

test('nonempty managed form inventories remain bound to exact options and failures', () => {
  const envelope = employerDeliveryEnvelope({
    channel: 'browser:stratus-managed',
    destinationUrl: 'https://apply.workable.com/example/j/123',
    portalFamily: 'workable',
  });
  const base = {
    ...packet(),
    fieldOptions: { work_authorization: ['Yes', 'No'] },
    failedFields: [{ controlId: 'office', label: 'Preferred office', selector: '#office' }],
  };
  const changedOption = {
    ...packet(),
    fieldOptions: { work_authorization: ['No', 'Yes'] },
    failedFields: base.failedFields,
  };
  const changedFailure = {
    ...packet(),
    fieldOptions: base.fieldOptions,
    failedFields: [{ controlId: 'location', label: 'Preferred office', selector: '#office' }],
  };

  assert.notEqual(employerDeliverySha256(base, envelope), employerDeliverySha256(changedOption, envelope));
  assert.notEqual(employerDeliverySha256(base, envelope), employerDeliverySha256(changedFailure, envelope));
});

test('failed fields bind by durable control identity, not per-load selector, inputType, or label', () => {
  const envelope = employerDeliveryEnvelope({
    channel: 'browser:stratus-managed',
    destinationUrl: 'https://example.com/careers/apply',
    portalFamily: 'greenhouse',
  });
  const firstLoad = {
    ...packet(),
    failedFields: [
      { controlId: 'question_67727949', label: 'Preferred office', selector: '[data-litos-discovered-3]', inputType: 'text' },
      { controlId: 'question_67727969', label: 'Visa status', selector: '[data-litos-discovered-7]', inputType: 'text' },
    ],
  };
  const secondLoad = {
    ...packet(),
    failedFields: [
      { controlId: 'question_67727969', label: 'Visa status *', selector: '[data-litos-discovered-12]', inputType: 'combobox' },
      { controlId: 'question_67727949', label: 'Preferred office (required)', selector: '[data-litos-discovered-9]', inputType: 'combobox' },
      { controlId: 'question_67727949', label: 'Preferred office', selector: '[data-litos-discovered-9]', inputType: 'combobox' },
    ],
  };
  // (a) selector renumbering, inputType flapping, label recomposition, ordering, and duplicate
  // rediscovery of the same control are all one delivery identity across page loads.
  assert.deepEqual(
    employerDeliveryProjection(firstLoad).failedFields,
    ['question_67727949', 'question_67727969'],
  );
  assert.equal(employerDeliverySha256(firstLoad, envelope), employerDeliverySha256(secondLoad, envelope));

  // (b) a changed SET of failed controls still changes the hash.
  const extraFailure = {
    ...packet(),
    failedFields: [...firstLoad.failedFields, { controlId: 'question_99', label: 'New question' }],
  };
  const differentFailure = {
    ...packet(),
    failedFields: [firstLoad.failedFields[0]],
  };
  assert.notEqual(employerDeliverySha256(firstLoad, envelope), employerDeliverySha256(extraFailure, envelope));
  assert.notEqual(employerDeliverySha256(firstLoad, envelope), employerDeliverySha256(differentFailure, envelope));

  // (c) an empty failed-fields set is still omitted: hash equals the absent case.
  const measuredEmpty = { ...packet(), failedFields: [] };
  assert.equal(employerDeliveryProjection(measuredEmpty).failedFields, undefined);
  assert.equal(employerDeliverySha256(measuredEmpty, envelope), employerDeliverySha256(packet(), envelope));
});

test('field options bind by option content, not by per-load addressing keys', () => {
  const envelope = employerDeliveryEnvelope({
    channel: 'browser:stratus-managed',
    destinationUrl: 'https://jobs.ashbyhq.com/example/123',
    portalFamily: 'ashby',
  });
  // (a) the same option lists under different per-load name keys (Ashby embeds a per-page-load
  // instance UUID in the name-attribute prefix) are one delivery identity, whatever the key order.
  const firstLoad = {
    ...packet(),
    fieldOptions: {
      'name:03af8549-1c2d-4e5f-8a9b-0c1d2e3f4a5b_a05e892e': ['Yes', 'No'],
      'name:03af8549-1c2d-4e5f-8a9b-0c1d2e3f4a5b_b16f903f': ['Dubai', 'London', 'Remote'],
    },
  };
  const secondLoad = {
    ...packet(),
    fieldOptions: {
      'name:36604d41-9f8e-4d7c-b6a5-4c3b2a190807_b16f903f': ['Dubai', 'London', 'Remote'],
      'name:36604d41-9f8e-4d7c-b6a5-4c3b2a190807_a05e892e': ['Yes', 'No'],
    },
  };
  assert.deepEqual(
    employerDeliveryProjection(firstLoad).fieldOptions,
    [['Dubai', 'London', 'Remote'], ['Yes', 'No']],
  );
  assert.equal(employerDeliverySha256(firstLoad, envelope), employerDeliverySha256(secondLoad, envelope));

  // (b) changed option content, reordered options within a list (option order is employer
  // content), or an added control still changes the hash.
  const changedOption = {
    ...packet(),
    fieldOptions: {
      'name:03af8549-1c2d-4e5f-8a9b-0c1d2e3f4a5b_a05e892e': ['Yes', 'No'],
      'name:03af8549-1c2d-4e5f-8a9b-0c1d2e3f4a5b_b16f903f': ['Dubai', 'London', 'Hybrid'],
    },
  };
  const reorderedOptions = {
    ...packet(),
    fieldOptions: {
      'name:03af8549-1c2d-4e5f-8a9b-0c1d2e3f4a5b_a05e892e': ['No', 'Yes'],
      'name:03af8549-1c2d-4e5f-8a9b-0c1d2e3f4a5b_b16f903f': ['Dubai', 'London', 'Remote'],
    },
  };
  const addedControl = {
    ...packet(),
    fieldOptions: { ...firstLoad.fieldOptions, extra_control: ['A', 'B'] },
  };
  assert.notEqual(employerDeliverySha256(firstLoad, envelope), employerDeliverySha256(changedOption, envelope));
  assert.notEqual(employerDeliverySha256(firstLoad, envelope), employerDeliverySha256(reorderedOptions, envelope));
  assert.notEqual(employerDeliverySha256(firstLoad, envelope), employerDeliverySha256(addedControl, envelope));

  // (c) it is a MULTISET: two different controls carrying identical option lists do not collapse
  // into one entry, so two identical lists and one identical list hash differently.
  const twoIdenticalLists = {
    ...packet(),
    fieldOptions: { control_a: ['Yes', 'No'], control_b: ['Yes', 'No'] },
  };
  const oneList = {
    ...packet(),
    fieldOptions: { control_a: ['Yes', 'No'] },
  };
  assert.deepEqual(
    employerDeliveryProjection(twoIdenticalLists).fieldOptions,
    [['Yes', 'No'], ['Yes', 'No']],
  );
  assert.notEqual(employerDeliverySha256(twoIdenticalLists, envelope), employerDeliverySha256(oneList, envelope));

  // (d) a measured-empty inventory is still omitted: hash equals the absent case.
  const measuredEmpty = { ...packet(), fieldOptions: {} };
  assert.equal(employerDeliveryProjection(measuredEmpty).fieldOptions, undefined);
  assert.equal(employerDeliverySha256(measuredEmpty, envelope), employerDeliverySha256(packet(), envelope));
});

test('managed form snapshots do not alter the separate attended extension payload', () => {
  const base = {
    target_role: 'Engineer',
    _review: { status: 'ready_for_final_approval', questions: [] },
  };
  const withManagedSnapshot = {
    ...base,
    _review: {
      ...base._review,
      managed_form_snapshot: {
        version: 1,
        field_options: { office: ['Dubai', 'London'] },
        failed_fields: [],
      },
    },
  };
  assert.deepEqual(
    extensionBoundApplicationSpec(withManagedSnapshot),
    extensionBoundApplicationSpec(base),
  );
});

test('every scalar, provenance, filename, question, and file mutation stops before transport', async () => {
  const original = packet();
  const envelope = employerDeliveryEnvelope({
    channel: 'unsupported_email',
    destinationUrl: 'jobs@example.com',
    portalFamily: 'unsupported',
  });
  const base = employerDeliverySha256(original, envelope);
  const bindings = createEmployerDeliveryBindings(original, {}, { mode: 'full', envelope });
  const mutations: Array<[string, (candidate: SubmissionPacket) => void]> = [
    ['phone', (candidate) => { candidate.phone = '+971 50 222 2222'; }],
    ['EEO', (candidate) => { candidate.eeoPrefs = { gender: 'Male' }; }],
    ['role', (candidate) => { candidate.mostRecentRole = { company: 'Elsewhere', title: 'Founder' }; }],
    ['provenance', (candidate) => {
      candidate.referralSourceEvidence = {
        kind: 'employer_career_site',
        value: 'Company website',
        jobId: 'job-1',
        sourceId: 'source-2',
        sourceUrl: 'https://example.com/jobs/1',
        observedAt: '2026-08-21T00:00:00.000Z',
      };
    }],
    ['resume name', (candidate) => { candidate.resumeName = 'different.pdf'; }],
    ['cover letter bytes', (candidate) => { candidate.coverLetter = Buffer.from('changed'); }],
    ['transcript bytes', (candidate) => { candidate.transcript = Buffer.from('changed'); }],
    ['question', (candidate) => { candidate.questions = [{ question: 'Why us?', answer: 'Changed.' }]; }],
  ];
  let transports = 0;
  for (const [name, mutate] of mutations) {
    const candidate = packet();
    mutate(candidate);
    assert.notEqual(employerDeliverySha256(candidate, envelope), base, name);
    await assert.rejects(
      () => transportBoundEmployerPacket(candidate, bindings, 'full', envelope, async () => {
        transports += 1;
      }),
      /payload changed/,
      name,
    );
  }
  assert.equal(transports, 0);
  const sent = await transportBoundEmployerPacket(original, bindings, 'full', envelope, async (exactPacket) => {
    transports += 1;
    return exactPacket;
  });
  assert.strictEqual(sent, original);
  assert.equal(transports, 1);
});

test('one selected delivery mode binds exact attachment policy and refuses channel switching', () => {
  const original = packet();
  const review = { cover_letter_supported: false, transcript_supported: true };
  const extension = extensionEmployerDeliveryProjection({
    resume: original.resume,
    fileName: original.resumeName,
    spec: { target_role: 'Engineer' },
    applicationSpec: { _review: { questions: [] } },
    applicantSnapshot: original.applicantSnapshot,
  });
  const browserEnvelope = employerDeliveryEnvelope({
    channel: 'browser:browserbase',
    destinationUrl: 'https://example.com/apply',
    portalFamily: 'greenhouse',
  });
  const bindings = createEmployerDeliveryBindings(original, review, { mode: 'browser', envelope: browserEnvelope });
  const browser = packetForEmployerDelivery(original, review, 'browser');
  assert.equal(browser.coverLetter, undefined);
  assert.ok(browser.transcript);
  assert.equal(employerDeliveryBindingIssue(browser, bindings, 'browser', browserEnvelope), null);
  assert.match(employerDeliveryBindingIssue(original, bindings, 'browser', browserEnvelope) ?? '', /payload changed/);
  assert.match(employerDeliveryBindingIssue(original, bindings, 'full', browserEnvelope) ?? '', /cannot authorize/);
  const extensionEnvelope = employerDeliveryEnvelope({
    channel: 'extension',
    destinationUrl: 'https://example.com/apply',
    portalFamily: 'workday',
  });
  const extensionBindings = createEmployerDeliveryBindings(original, review, {
    mode: 'extension',
    envelope: extensionEnvelope,
    extensionProjection: extension,
  });
  assert.equal(extensionEmployerDeliveryBindingIssue(extension, extensionBindings, extensionEnvelope), null);
  assert.match(
    extensionEmployerDeliveryBindingIssue({ ...extension, fileName: 'different.pdf' }, extensionBindings, extensionEnvelope) ?? '',
    /changed/,
  );
  assert.match(extensionEmployerDeliveryBindingIssue(extension, bindings, extensionEnvelope) ?? '', /cannot authorize/);
});

test('destination, runtime, capability policy, and every email envelope field block before transport', async () => {
  const original = packet();
  const envelope = employerDeliveryEnvelope({
    channel: 'unsupported_email',
    destinationUrl: 'jobs@example.com',
    portalFamily: 'unsupported',
    runtime: { provider: 'resend', region: 'iad1' },
    coverLetterSupported: true,
    transcriptSupported: false,
    email: {
      from: 'Litos <applications@apply.trylitos.com>',
      to: ['jobs@example.com'],
      replyTo: 'mehek@example.com',
      subject: 'Application',
      text: 'Application body',
      html: '<p>Application body</p>',
      attachments: [{ filename: original.resumeName, content: original.resume.toString('base64') }],
    },
  });
  const bindings = createEmployerDeliveryBindings(original, {}, { mode: 'full', envelope });
  const mutations: Array<[string, typeof envelope]> = [
    ['destination', { ...envelope, destinationUrl: 'other@example.com' }],
    ['channel', { ...envelope, channel: 'controlled_browser' }],
    ['portal family', { ...envelope, portalFamily: 'greenhouse' }],
    ['runtime', { ...envelope, runtime: { provider: 'resend', region: 'fra1' } }],
    ['capability', { ...envelope, capabilityPolicy: { ...envelope.capabilityPolicy, transcriptSupported: true } }],
    ...(['from', 'to', 'replyTo', 'subject', 'text', 'html'] as const).map((key) => [
      `email ${key}`,
      { ...envelope, email: { ...(envelope.email as Record<string, unknown>), [key]: `changed-${key}` } },
    ] as [string, typeof envelope]),
  ];
  let transports = 0;
  for (const [name, changed] of mutations) {
    await assert.rejects(
      () => transportBoundEmployerPacket(original, bindings, 'full', changed, async () => {
        transports += 1;
      }),
      /payload changed/,
      name,
    );
  }
  assert.equal(transports, 0);
});

/* THE DELIVERY HASH WAS THE SECOND DOOR THE SEND LOG CAME THROUGH.
 *
 * `application_profile.submitted_application_companies` is Litos' own send log, read live from the
 * database on every buildPacket, so any row anywhere in the account landing rewrites it. It reaches
 * this projection twice - as `applicationProfile` and again nested inside `applicantSnapshot` - and
 * binding either made every approved packet in the account read as "how Litos reaches this employer
 * changed" the moment a different application landed. Worse, claimSubmission opens THIS employer's
 * attempt before buildPacket runs, so a send could arrange its own refusal. Measured on The Maven
 * Group 305dae5e, 2026-09-02, which refused on BOTH the snapshot and the delivery payload. */
test('the send log does not move the employer-delivery binding, through either field', () => {
  const envelope = employerDeliveryEnvelope({
    channel: 'browser:stratus-managed',
    destinationUrl: 'https://job-boards.greenhouse.io/embed/job_app?for=dvtrading',
    portalFamily: 'greenhouse',
  });
  const withLog = (companies: string[]): SubmissionPacket => {
    const base = packet();
    return {
      ...base,
      applicationProfile: { ...base.applicationProfile, submitted_application_companies: companies },
      applicantSnapshot: {
        ...(base.applicantSnapshot as Record<string, unknown>),
        application_profile: {
          /* Through `unknown`: applicantSnapshot is AutofillApplicantSnapshot | undefined, and
             ApplicationProfileLike has no index signature, so the direct assertion is the TS2352 the
             compiler asks to be written this way. The helper only reshapes a fixture. */
          ...((base.applicantSnapshot as unknown as { application_profile: Record<string, unknown> }).application_profile),
          submitted_application_companies: companies,
        },
      },
    } as SubmissionPacket;
  };
  const review = { cover_letter_supported: false, transcript_supported: false };
  // The send narrows with packetForEmployerDelivery before it asserts, and createEmployerDeliveryBindings
  // narrows the same way internally, so the compare has to be made on the narrowed pair.
  const before = packetForEmployerDelivery(withLog(['Akuna', 'Databricks']), review, 'browser');
  const afterOneLanded = packetForEmployerDelivery(
    withLog(['Akuna', 'Databricks', 'DV Trading']), review, 'browser',
  );

  assert.equal(
    employerDeliverySha256(before, envelope),
    employerDeliverySha256(afterOneLanded, envelope),
    'an employer joining the send log mid-run must not park every packet in the account',
  );
  const bindings = createEmployerDeliveryBindings(before, review, { mode: 'browser', envelope });
  assert.equal(
    employerDeliveryBindingIssue(afterOneLanded, bindings, 'browser', envelope),
    null,
    'this is the exact compare the send makes after claimSubmission has already opened the attempt',
  );
});

test('every other applicationProfile and applicantSnapshot byte still moves the delivery binding', () => {
  const envelope = employerDeliveryEnvelope({
    channel: 'browser:stratus-managed',
    destinationUrl: 'https://job-boards.greenhouse.io/embed/job_app?for=dvtrading',
    portalFamily: 'greenhouse',
  });
  const base = packet();
  const movedProfile = {
    ...base,
    applicationProfile: { ...base.applicationProfile, phone: '+1 000 000 0000' },
  } as SubmissionPacket;
  const movedSnapshot = {
    ...base,
    applicantSnapshot: {
      ...(base.applicantSnapshot as Record<string, unknown>),
      profile: { full_name: 'Someone Else' },
    },
  } as SubmissionPacket;
  assert.notEqual(employerDeliverySha256(base, envelope), employerDeliverySha256(movedProfile, envelope));
  assert.notEqual(employerDeliverySha256(base, envelope), employerDeliverySha256(movedSnapshot, envelope));
});


/* Measured 2026-09-04/05 on this account: Belvedere c4413bff (22:27Z, 22:32Z) and Covenant House
 * c24e48a2 (01:56Z) each parked their first approve on "browser employer-delivery payload changed
 * after packet approval" with nothing anywhere naming which of the ~40 projected parts had moved.
 * The whole-payload hash stays the authority; these pin that the binding now carries one digest per
 * part beside it, that a drift can be named from them, and that nothing but digests is stored. */
test('a browser binding carries one digest per projected part, and a drift is named by part', () => {
  const sample = packet();
  const review = { cover_letter_supported: true, transcript_supported: false } as Parameters<typeof createEmployerDeliveryBindings>[1];
  const envelope = employerDeliveryEnvelope({
    channel: 'browser:stratus-managed', destinationUrl: 'https://jobs.example.com/apply', portalFamily: 'lever',
    coverLetterSupported: true, transcriptSupported: false,
  });
  const bindings = createEmployerDeliveryBindings(sample, review, { mode: 'browser', envelope });
  assert.ok(bindings.fields, 'per-part digests ride beside the whole-payload hash');
  const delivered = packetForEmployerDelivery(sample, review, 'browser');
  assert.deepEqual(bindings.fields, employerDeliveryFieldDigests(delivered, envelope));
  for (const [key, digest] of Object.entries(bindings.fields!)) {
    assert.match(digest, /^[a-f0-9]{64}$/, `${key} is a digest, never content`);
  }
  assert.ok(Object.keys(bindings.fields!).includes('questions'));
  assert.ok(Object.keys(bindings.fields!).includes('envelope'));
  // Unchanged: nothing moved.
  assert.deepEqual(employerDeliveryDriftFields(delivered, bindings, envelope), []);
  // One answer changed: exactly the questions part is named, and the whole-payload check still refuses.
  const moved = { ...delivered, questions: delivered.questions.map((q, i) => (i === 0 ? { ...q, answer: `${q.answer} (edited)` } : q)) };
  assert.deepEqual(employerDeliveryDriftFields(moved, bindings, envelope), ['questions']);
  assert.ok(employerDeliveryBindingIssue(moved, bindings, 'browser', envelope));
  // A moved envelope names the envelope; a moved phone names phone.
  const otherEnvelope = { ...envelope, destinationUrl: 'https://jobs.example.com/other' };
  assert.deepEqual(employerDeliveryDriftFields(delivered, bindings, otherEnvelope), ['envelope']);
  assert.deepEqual(employerDeliveryDriftFields({ ...delivered, phone: '+1 000 000 0000' }, bindings, envelope), ['phone']);
  // A binding minted before per-part digests names nothing rather than guessing.
  assert.equal(employerDeliveryDriftFields(moved, { version: 'employer_delivery_v1', mode: 'browser', sha256: bindings.sha256 }, envelope), null);
  // The extension binding is unchanged: no per-part digests, no drift naming.
  const extension = createEmployerDeliveryBindings(sample, review, {
    mode: 'extension', envelope, extensionProjection: { resume: { sha256: 'x', sizeBytes: 1 } },
  });
  assert.equal(extension.fields, undefined);
});
