import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { preservedApplicationSpecKeys } from './applications';
import { transcriptObjectKeyToAttach } from './submissionRunner';
import { attachedDocument, storedDocuments, type ApplicationRow } from '../lib/documentStore';

/* SHE ATTACHED THE TRANSCRIPT, THEN FIXED A BULLET, AND THE TRANSCRIPT WAS GONE.
 *
 * PATCH /applications/:id/resume does not edit the stored packet. It rebuilds it: the edited
 * content comes back from the renderer as a ResumeSpec, and normalizeSpec (llm/resumeSpec.ts:194)
 * reconstructs a ResumeSpec field by field from a fixed allowlist, so every underscore-prefixed key
 * the packet was carrying is absent from it. What the route puts back is whatever its own list
 * names. `_documents` was not on that list, because the list is written inline at the rebuild and
 * the transcript feature added its key somewhere else.
 *
 * The result had no error in it anywhere. The PATCH answered 200. The spec came back without
 * `_documents`, so the review screen stopped showing the attachment, the packet builder found no
 * object key to fetch, and the send gate asked her for the transcript again - on the same
 * application she had already given it to, with nothing on screen to say what had happened to the
 * first copy.
 *
 * WHY THE TESTS BELOW ARE SHAPED LIKE THIS. The route itself is not reachable from a test: getting
 * to the rebuild needs a database, an experience bank, a PDF renderer and a PDF text extractor, and
 * that is exactly why an omission in a nine-line object literal survived review. So the carry-over
 * is now one pure exported function, tested here against the real readers the dashboard and the
 * packet builder use, and the route's use of it is fenced in source text so the next edit cannot
 * quietly re-inline an allowlist.
 */

/* The spec as it stands after she has attached a transcript to an application that already had a
 * cover letter and a pinned application email. Every underscore key this codebase writes is on it,
 * so a rebuild that drops any of them is visible below rather than only the one that was dropped. */
const STORED_BEFORE_EDIT = {
  target_role: 'Data Analyst Intern',
  school: 'A University',
  experience: [{ type: 'job', org: 'A Lab', title: 'Intern', bullets: ['Did a thing'] }],
  skills: ['Python'],
  _contact: { full_name: 'A Student', email: 'a@student.test', phone: '+1 555 0100' },
  _applicant_email: { address: 'a.student.4f2a@apply.trylitos.test', source: 'litos_alias' },
  _application_email: { alias_id: '2b6a1d8e-7c40-4f3a-9c2f-5d3f0b6a9a71' },
  _cover_letter: {
    body: 'Dear hiring team,',
    word_count: 3,
    warnings: [],
    generated_at: '2026-08-10T11:00:00.000Z',
    approved_at: '2026-08-10T11:05:00.000Z',
    object_key: 'users/a18f774b/resumes/letter.pdf',
    file_name: 'letter.pdf',
  },
  _documents: {
    transcript: {
      document_id: '0f2a9c1e-6b1d-4d9e-9d2a-1f0c7a5e4b33',
      file_name: 'Fall 2025 unofficial transcript.pdf',
      object_key: 'users/a18f774b/documents/5d3f0b6a.pdf',
      attached_at: '2026-08-11T09:14:02.118Z',
      ordered_at: null,
      employer_label: 'Unofficial transcript',
      official_requested: false,
    },
  },
  _review: { status: 'ready_to_submit', questions: [], jd_text: 'A posting' },
  _quality: { atsCoverage: 71, specIssues: [] },
} as Record<string, unknown>;

/* The rebuild, composed exactly as routes/applications.ts composes it: the renormalized content
 * first, then the contact block, then the carried-over keys, then the two the edit recomputes.
 * `rendered.spec` is stood in for by an object with no underscore keys at all, which is precisely
 * what normalizeSpec returns and precisely why the carry-over has to exist. */
function specAfterEdit(stored: Record<string, unknown>): Record<string, unknown> {
  return {
    target_role: 'Data Analyst Intern',
    school: 'A University',
    experience: [{ type: 'job', org: 'A Lab', title: 'Intern', bullets: ['Did a different thing'] }],
    skills: ['Python', 'SQL'],
    _contact: stored._contact,
    ...preservedApplicationSpecKeys(stored),
    _review: { status: 'ready_to_submit', questions: [], jd_text: 'A posting', edited_terms: ['SQL'] },
    _quality: { atsCoverage: 74, specIssues: [] },
  };
}

test('a transcript attached before an edit is still attached after it', () => {
  const edited = specAfterEdit(STORED_BEFORE_EDIT);

  /* The packet builder's own reader, not a hand-written lookup. This is the question the submission
   * run asks, and before the fix its answer on an edited packet was null: the file was in her
   * library, the row said nothing about it, and the form went out without it. */
  assert.equal(
    transcriptObjectKeyToAttach(edited),
    'users/a18f774b/documents/5d3f0b6a.pdf',
    'the edit must not detach the transcript the packet builder is about to send',
  );

  /* And the dashboard's reader, which is what decides whether the checklist row keeps asking. */
  const row = { spec: edited } as ApplicationRow;
  const attachment = attachedDocument(row, 'transcript');
  assert.ok(attachment, 'the review screen must still see the attachment after an edit');
  assert.equal(attachment.file_name, 'Fall 2025 unofficial transcript.pdf');
  assert.equal(attachment.attached_at, '2026-08-11T09:14:02.118Z');
  assert.equal(attachment.employer_label, 'Unofficial transcript');
  assert.deepEqual(Object.keys(storedDocuments(row)), ['transcript']);
});

test('an acknowledgement with no file survives an edit too', () => {
  /* "I've ordered it" writes an attachment with document_id and object_key both null. It is the
   * record that stops the row nagging, so losing it to an edit puts the same question back on
   * screen with no way for her to tell she has already answered it. */
  const edited = specAfterEdit({
    ...STORED_BEFORE_EDIT,
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
  });

  const attachment = attachedDocument({ spec: edited } as ApplicationRow, 'transcript');
  assert.ok(attachment);
  assert.equal(attachment.ordered_at, '2026-08-11T09:20:00.000Z');
  assert.equal(attachment.official_requested, true);
  // Nothing to fetch, and that is correct: an order is not a file.
  assert.equal(transcriptObjectKeyToAttach(edited), null);
});

test('the edit carries every stored key it does not recompute, and recomputes the rest', () => {
  const preserved = preservedApplicationSpecKeys(STORED_BEFORE_EDIT);
  assert.deepEqual(
    Object.keys(preserved).sort(),
    ['_applicant_email', '_application_email', '_cover_letter', '_documents'],
  );

  const edited = specAfterEdit(STORED_BEFORE_EDIT);
  // Carried, unchanged.
  assert.deepEqual(edited._applicant_email, STORED_BEFORE_EDIT._applicant_email);
  assert.deepEqual(edited._application_email, STORED_BEFORE_EDIT._application_email);
  assert.deepEqual(edited._cover_letter, STORED_BEFORE_EDIT._cover_letter);
  assert.deepEqual(edited._documents, STORED_BEFORE_EDIT._documents);
  // Recomputed, so the pre-edit values must NOT be what came back. Carrying these forward would
  // write the old review status and the old quality figures back over the edit's own.
  assert.deepEqual(
    (edited._review as Record<string, unknown>).edited_terms,
    ['SQL'],
    'the review must be the edit\'s, not the one the packet arrived with',
  );
  assert.equal((edited._quality as Record<string, unknown>).atsCoverage, 74);
  // The edited content itself, which is the whole point of the route.
  assert.deepEqual(edited.skills, ['Python', 'SQL']);
});

test('an absent or null key is left absent rather than written in as null', () => {
  /* The conditional spreads this replaced tested `'_applicant_email' in stored` for two keys and
   * truthiness for the third. Both coincide on every packet that exists - all four keys are written
   * as objects or not at all - and the behaviour kept is the one that cannot introduce a null into
   * jsonb that readers would then have to defend against. */
  assert.deepEqual(preservedApplicationSpecKeys({}), {});
  assert.deepEqual(preservedApplicationSpecKeys({ _documents: null, _cover_letter: undefined }), {});
  assert.deepEqual(
    preservedApplicationSpecKeys({ _documents: { transcript: { document_id: 'd1' } } }),
    { _documents: { transcript: { document_id: 'd1' } } },
  );
});

test('the resume edit route still rebuilds through the shared carry-over list', () => {
  /* Source text, because the composition is what was wrong and the composition is not callable.
   * A future edit that re-inlines `...(stored._something ? ... : {})` beside the call would be a
   * second list to keep in step with the first, which is the defect this file exists for. */
  const source = readFileSync(join(__dirname, 'applications.ts'), 'utf8');
  const route = source.slice(
    source.indexOf("'/applications/:id/resume'"),
    source.indexOf("fastify.put("),
  );
  assert.ok(route.length > 0, 'the resume edit route must still be found');
  assert.match(route, /\.\.\.preservedApplicationSpecKeys\(stored\),/);
  assert.doesNotMatch(
    route,
    /\.\.\.\('_[a-z_]+' in stored|\.\.\.\(stored\._[a-z_]+ \?/,
    'the rebuild grew a second carry-over list beside the shared one',
  );
  // The rebuilt spec now carries a Blob pointer, so the response has to strip it.
  assert.match(route, /spec: specWithoutDocumentPointers\(updatedSpec\)/);
});

test('every underscore key any module reads off a spec is classified by the edit path', () => {
  /* THE CHECK THAT WOULD HAVE CAUGHT THIS ONE. The defect was not a mistake in the list, it was a
   * key added by one feature and a list owned by another. So the list is measured against the keys
   * the codebase actually reads off a stored spec: a sibling feature that adds `_portfolio` fails
   * here until somebody decides, out loud, whether an edit carries it or recomputes it. */
  const roots = ['routes', 'lib'].map((name) => join(__dirname, '..', name));
  const found = new Set<string>();
  for (const root of roots) {
    for (const file of readdirSync(root)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const source = readFileSync(join(root, file), 'utf8');
      // The receivers a stored spec is bound to across this codebase. Narrow on purpose: a wider
      // pattern picks up every underscore-prefixed field of every unrelated object.
      for (const match of source.matchAll(/(?<![\w$])(?:stored|spec|record|value)\.(_[a-z_]+)(?![\w$])/g)) {
        found.add(match[1]);
      }
    }
  }

  /* Read out of the route rather than restated here. A copy of the list in the test would go green
   * on a list that had lost a key, which is precisely the failure being fenced. */
  const source = readFileSync(join(__dirname, 'applications.ts'), 'utf8');
  const declaration = source.slice(source.indexOf('const PRESERVED_APPLICATION_SPEC_KEYS = ['));
  const carried = [...declaration.slice(0, declaration.indexOf('] as const;')).matchAll(/'(_[a-z_]+)'/g)]
    .map((match) => match[1]);
  assert.ok(carried.length >= 4, `expected the carry-over list to be read, got ${carried.join(',')}`);

  /* The three the edit writes itself, each with the line that writes it: _contact from the stored
   * contact block, _review from the edited review, _quality from the fresh render. Carrying any of
   * them would put the pre-edit value back over the edit's own. */
  const recomputed = ['_contact', '_review', '_quality'];
  assert.deepEqual(
    [...found].sort(),
    [...carried, ...recomputed].sort(),
    'a spec key is neither carried forward by an edit nor recomputed by one, so saving an edit '
    + 'deletes it. Add it to PRESERVED_APPLICATION_SPEC_KEYS in routes/applications.ts, or to '
    + '`recomputed` here with the line that rebuilds it.',
  );
});
