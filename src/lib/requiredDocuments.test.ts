/* THE FENCE AROUND THE TRIGGER.
 *
 * The dashboard draws an upload control off this function's output, so a false positive here is a
 * student being told an employer wants a transcript that no employer asked for, and a false
 * negative is the whole feature never firing. The two named traps are both substring matches that
 * shipped in this repo:
 *
 *   `file` inside `profile`      lib/submissionTerminalCause.ts classified
 *                                `"LinkedIn Profile" is required and is still empty` as
 *                                required_document.
 *   `official` inside `unofficial`  the phrasing on most US student application forms. A match here
 *                                inverts the meaning of the row: it offers a registrar-order flow
 *                                to someone whose employer said a downloaded PDF is fine.
 *
 * Both have a test below, and neither may be deleted without the other.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUIRED_DOCUMENT_LABEL_MAX_LENGTH,
  requiredDocumentAsks,
} from './requiredDocuments';
import { USER_DOCUMENT_KINDS } from './documentStore';

test('"LinkedIn Profile" is not a document ask, however the label reaches us', () => {
  // The blocker label as unansweredRequiredBlockerLabels lifts it out of the portal's sentence,
  // and the question label as the discovery pass records it. Same label, both sources, no ask.
  assert.deepEqual(requiredDocumentAsks(['LinkedIn Profile']), []);
  assert.deepEqual(requiredDocumentAsks(['LinkedIn Profile URL', 'Profile', 'GitHub profile']), []);
});

test('the words that made the attention category unusable are not the trigger', () => {
  // Every one of these is a real required field on some form and none of them names a document
  // Litos can store. The old regex matched all five.
  assert.deepEqual(
    requiredDocumentAsks(['Upload', 'Attachments', 'Supporting documents', 'File', 'Employment record']),
    [],
  );
});

test('a document Litos does not store produces no ask, rather than a transcript row', () => {
  // Not an oversight. An ask with no storable kind is a row that opens a modal that cannot serve
  // it, which is worse than the row being absent.
  assert.deepEqual(requiredDocumentAsks(['Resume/CV', 'Cover letter', 'Writing sample', 'Portfolio']), []);
});

test('a transcript ask carries the label, the storage kind, and nothing else', () => {
  const asks = requiredDocumentAsks(['Transcript']);
  assert.deepEqual(asks, [{ label: 'Transcript', kind: 'transcript', official_requested: false }]);
  // The kind is the storage key, so it has to be one the store would accept.
  assert.ok(USER_DOCUMENT_KINDS.includes(asks[0]!.kind));
});

test('the words a form uses when it avoids the word "transcript"', () => {
  for (const label of ['Academic Records', 'Academic record', 'Grade report', 'Marksheet', 'Mark sheet', 'Marks sheet']) {
    assert.equal(requiredDocumentAsks([label]).length, 1, `${label} is a transcript ask`);
  }
});

test('word boundaries hold on both ends of the transcript vocabulary', () => {
  // `transcription` is a different word about a different thing, and an interview-recording
  // consent checkbox is a required field on plenty of forms.
  assert.deepEqual(requiredDocumentAsks(['Interview transcription consent']), []);
  assert.deepEqual(requiredDocumentAsks(['Benchmark sheets reviewed']), []);
});

test('unofficial is not official, which is the whole reason for the boundary', () => {
  const [ask] = requiredDocumentAsks(['Unofficial transcript']);
  assert.equal(ask?.kind, 'transcript');
  assert.equal(ask?.official_requested, false, 'a bare /official/i test matches inside "unofficial"');

  const [sealed] = requiredDocumentAsks(['Official transcript']);
  assert.equal(sealed?.official_requested, true);
});

test('a label offering either copy asks for the official variant, deliberately', () => {
  // Additive, not a gate: it puts "I've ordered it" on the row next to the upload. Erring the other
  // way removes the only honest answer for a student who cannot produce a sealed file.
  const [ask] = requiredDocumentAsks(['Official or unofficial transcript (PDF)']);
  assert.equal(ask?.official_requested, true);
});

test('the same label written three ways is one ask', () => {
  assert.deepEqual(
    requiredDocumentAsks(['Transcript', 'transcript', '  Transcript  ', 'TRANSCRIPT']),
    [{ label: 'Transcript', kind: 'transcript', official_requested: false }],
  );
  // Interior whitespace is collapsed before the comparison, because the two sources tidy it
  // differently and a doubled space is not a second document.
  assert.equal(requiredDocumentAsks(['Academic  record', 'Academic record']).length, 1);
});

test('two labels for one file are one row, and the sealed ask survives the collapse', () => {
  /* A form carrying both controls writes one `spec._documents.transcript` key. Two rows would mean
     she attaches the file, one clears, and the other keeps asking with no control left that can
     clear it. The first label names the row; official_requested is the union. */
  assert.deepEqual(
    requiredDocumentAsks(['Unofficial transcript (PDF)', 'Official transcript']),
    [{ label: 'Unofficial transcript (PDF)', kind: 'transcript', official_requested: true }],
  );
});

test('the label is clipped, because this rides inside a spec that is returned fifty at a time', () => {
  const long = `Please upload your ${'most recent '.repeat(40)}transcript`;
  assert.ok(long.length > REQUIRED_DOCUMENT_LABEL_MAX_LENGTH);
  const [ask] = requiredDocumentAsks([long]);
  assert.equal(ask?.label.length, REQUIRED_DOCUMENT_LABEL_MAX_LENGTH);
  assert.ok(ask?.label.endsWith('...'));
});

test('the match reads the whole label, and only what is stored is clipped', () => {
  /* This is the ordering bug, written down. A question label may run to normalizeReviewQuestionLabel's
     five hundred characters with the one word that matters at the end of them. Clipping before the
     match, which is the obvious way to write it, drops the ask entirely. */
  const long = `Please upload your ${'most recent '.repeat(40)}transcript`;
  const asks = requiredDocumentAsks([long]);
  assert.equal(asks.length, 1, 'the word "transcript" sits past the clip and still has to be read');
  assert.doesNotMatch(asks[0]!.label, /transcript/i, 'and the stored label genuinely does not contain it');

  // Same ordering for the official test: the word may also be past the clip.
  const sealed = requiredDocumentAsks([`Transcript. ${'Please note: '.repeat(20)}An official copy is required.`]);
  assert.equal(sealed[0]?.official_requested, true);
});

test('two labels that agree for two hundred characters do not produce two rows', () => {
  // Both sources hand over labels that have already been truncated upstream, so labels that agree
  // for their first two hundred characters are the expected case, not a contrived one.
  const prefix = `Transcript ${'x'.repeat(300)}`;
  assert.equal(requiredDocumentAsks([`${prefix}A`, `${prefix}B`]).length, 1);
});

test('empty, blank and non-string labels are skipped rather than thrown on', () => {
  // This is fed straight off provider output on two code paths. Neither is trusted to be tidy.
  const junk = ['', '   ', '\n\t', null, undefined, 42] as unknown as string[];
  assert.deepEqual(requiredDocumentAsks(junk), []);
  assert.deepEqual(requiredDocumentAsks([]), []);
  assert.equal(requiredDocumentAsks([...junk, 'Transcript']).length, 1);
});

test('a real blocker sentence label reads correctly end to end', () => {
  // The exact shape unansweredRequiredBlockerLabels yields: the inner text of
  // `"<label>" is required and is still empty`, already past humanFieldLabel's 120-char clip.
  assert.deepEqual(
    requiredDocumentAsks([
      'First Name',
      'Upload your unofficial transcript',
      'LinkedIn Profile',
      'Resume/CV',
    ]),
    [{ label: 'Upload your unofficial transcript', kind: 'transcript', official_requested: false }],
  );
});
