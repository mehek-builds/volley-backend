import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { specWithoutDocumentPointers } from '../lib/documentStore';
import { normalizeSpec } from '../llm/resumeSpec';

/* A source-text contract, in the shape of profileRetentionContract.test.ts, and for the same class
 * of promise: something the product has told a student it will not do, which no runtime test can
 * prove about the route that has not been written yet.
 *
 * What it guards is that a Blob pointer never leaves this service. @vercel/blob can only write
 * `access: 'public'` on the version this repo is on, so an object key plus the store's stable base
 * URL is permanent unauthenticated access to a student's transcript, and blob_url IS that URL.
 * The spec has to hold the key because the packet builder fetches the bytes; a response body has no
 * such need, and there is no schema on these routes to stop one being added.
 *
 * THIS FILE HAS NOW BEEN WRONG TWICE, IN THE SAME WAY, AND THE SECOND TIME IS WHY IT IS SHAPED
 * LIKE THIS.
 *
 * The first version fenced the routes that MENTION documents, on the assumption that a leak would
 * come from one of them. The leak came from GET /resume/history, which does not mention documents
 * at all: it returns the whole spec of up to fifty applications, so it began serving
 * _documents.transcript.object_key the day the first transcript was attached, and every assertion
 * here stayed green throughout.
 *
 * The second version fixed that route and named it. Two more were still open, for exactly the same
 * reason: GET /applications/:id/submission/extension-packet shipped the raw spec under
 * `application`, and GET /account/export spread every generated_resumes row whole. A fence written
 * as a list of the routes somebody remembered is a fence that has to be rewritten every time the
 * class gains a member, and the class gains members without anyone noticing, because the pointer is
 * never visible in the line that ships it.
 *
 * So the assertions below no longer name routes. They enumerate `src/routes/` from disk and put a
 * rule on the SHAPE - "a spec in a response goes through specWithoutDocumentPointers", "a spread
 * stored row overrides its spec" - so a route added next month is covered by the test on the day
 * it lands rather than on the day somebody remembers to add it here.
 *
 * THE THIRD VERSION IS THIS ONE, AND IT EXISTS BECAUSE SOMEBODY SAT DOWN TO BEAT THE SECOND AND
 * BEAT IT SEVEN TIMES OUT OF EIGHT. Eight probe routes were planted, each written the way an
 * engineer shipping a feature would write it rather than the way somebody evading a test would.
 * The scan caught exactly one: the only probe that put `spec:` literally inside a `.send(`.
 *
 * What each widening below cost, and the probe that bought it:
 *
 *   subdirectories      readdir was not recursive, so src/routes/internal/anything.ts was not a
 *                       route module as far as this file was concerned, and the plainest possible
 *                       leak survived being moved one directory down.
 *   returned literals   Fastify serializes whatever the handler resolves to. `return { spec }` with
 *                       no reply.send anywhere in the file is a complete answer, and it was a
 *                       complete blind spot, in a scan whose only anchor was the string `.send(`.
 *   one hop into a      `.send({ application: applicationPayload(row) })` is the ordinary shape of
 *   local function      the second route that needs the same envelope. The `spec:` moves into the
 *                       helper, and the old scan never opened one.
 *
 * All three are free on this tree: they raise the number of response specs policed from 4 to 7 and
 * flag nothing.
 *
 * WHAT STILL GETS THROUGH, measured with probes rather than imagined, and all of it one weakness:
 * a value laundered through a LOCAL VARIABLE between where it is built and where it is answered
 * with. The scan follows text, and an assignment is where the text stops.
 *
 *   - `const packet = row.spec;` then `send({ application_id, packet })`. No property named spec,
 *     no `.spec` inside the send, nothing to match. A rule on the local's NAME was written and then
 *     thrown away on the evidence: resume.ts binds `spec` once in a module-level helper and again
 *     inside the generate handler, so the rule flagged five honest sends on a name collision alone.
 *     A fence that cannot be left green is a fence somebody deletes, and then there is none.
 *   - a helper that spreads the row, whose result is pushed into an array before the send. The one
 *     hop reaches a helper only when the response fragment NAMES it.
 *   - a spread under a local name the file never once writes as `<name>.spec`, which is the only
 *     textual evidence available that the thing being copied is a generated_resumes row at all.
 *   - a response assembled in src/lib/ or src/middleware/ and handed to a route already built. The
 *     scan is scoped to src/routes/, which is where every response in this codebase is currently
 *     shaped, and that is an observation about today rather than a guarantee.
 *
 * Every one of those is a real hole and none of them closes by writing a better regex. What would
 * close them is a shape where a raw stored spec is hard to reach: a read that hands back the
 * sanitized spec by default and makes the unsanitized one a named, awkward call. That is a larger
 * change than the feature this file shipped with, so it is written down here rather than done.
 *
 * The two leaks that have actually happened are both closed. This file is the second line of that
 * defence and it should not be read as the first.
 */

const ROUTES_DIR = __dirname;

const routeSource = (name: string) => readFile(path.join(ROUTES_DIR, name), 'utf8');

/* Every route module, read off disk. Not a list, so a new one is covered the day it is added, and
 * RECURSIVE, because the flat version stopped at the directory boundary: a probe route identical to
 * the plainest leak this file knows about walked straight past it by sitting in src/routes/internal/.
 * There is no such directory today. There does not need to be one for the hole to be real. */
async function routeFiles(directory: string = ROUTES_DIR, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await routeFiles(path.join(directory, entry.name), relative));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(relative);
  }
  return out;
}

/** The text from `at` through the matching close, `at` being the index of the opening character. */
function balanced(source: string, at: number, open: string, close: string): string {
  let depth = 0;
  for (let i = at; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return '';
}

/** A stretch of source that a rule is applied to, with `via` naming the helper it was found in. */
type Fragment = { at: number; text: string; via?: string };

/** The argument text of every call to `marker` in a file, paren-balanced rather than line-based. */
function callArguments(source: string, marker: string): Fragment[] {
  const out: Fragment[] = [];
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
    // Not `reply.send(`: most of the answers here are `reply.status(400).send(...)`, and a scan
    // that only found the bare form would pass while saying nothing about the ones it missed.
    const text = balanced(source, at + marker.length - 1, '(', ')');
    if (text) out.push({ at, text });
  }
  return out;
}

/** The argument region of every route declaration, handler included. */
function handlerRegions(source: string): Fragment[] {
  const out: Fragment[] = [];
  const declaration = /\bfastify\.(?:get|post|put|patch|delete)\s*(?:<[^(]*>)?\(/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const text = balanced(source, match.index + match[0].length - 1, '(', ')');
    if (text) out.push({ at: match.index, text });
  }
  return out;
}

/** Every `return { ... }` object literal in a stretch of source. */
function returnedLiterals(source: string): Fragment[] {
  const out: Fragment[] = [];
  const marker = /\breturn\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source)) !== null) {
    const text = balanced(source, match.index + match[0].length - 1, '{', '}');
    if (text) out.push({ at: match.index, text });
  }
  return out;
}

/* Every function DECLARED in a file, by name, with its body. Both spellings, because which one a
 * helper is written in is a matter of the author's habit and not of what it can leak. */
function localFunctions(source: string): Map<string, Fragment> {
  const out = new Map<string, Fragment>();
  const declaration = /(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:async\s*)?\()/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const name = match[1] ?? match[2];
    const brace = source.indexOf('{', match.index + match[0].length);
    if (brace < 0) continue;
    const text = balanced(source, brace, '{', '}');
    if (text) out.set(name, { at: brace, text });
  }
  return out;
}

/**
 * Everything a route in this file can answer with.
 *
 * Three sources, and the second and third are the whole of the third version of this file:
 *
 *   the arguments of every `.send(`, which is what the previous version scanned and all it scanned;
 *   every `return { ... }` inside a route declaration, because Fastify serializes what the handler
 *     resolves to and a route that never touches `reply` is an ordinary route;
 *   the `return { ... }` of every locally declared function NAMED inside one of the above, because
 *     moving the envelope into a helper is a refactor rather than an evasion and it took the spec
 *     clean out of view.
 *
 * The hop is deliberately one deep and deliberately textual: a helper is followed only when a
 * response fragment writes its name. Two hops, or a helper reached through a local, is the hole the
 * header names and does not claim to close.
 */
function responseFragments(source: string): Fragment[] {
  const handlers = handlerRegions(source);
  const fragments: Fragment[] = [...callArguments(source, '.send(')];
  for (const literal of returnedLiterals(source)) {
    if (handlers.some((region) => literal.at > region.at && literal.at < region.at + region.text.length)) {
      fragments.push(literal);
    }
  }

  const locals = localFunctions(source);
  const named = new Set<string>();
  for (const fragment of fragments) {
    // Bare identifiers, not just called ones: `rows.map(withDisplayFields)` names its helper without
    // a paren after it, and that is the form the probe used.
    const identifier = /(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g;
    let match: RegExpExecArray | null;
    while ((match = identifier.exec(fragment.text)) !== null) {
      if (locals.has(match[1])) named.add(match[1]);
    }
  }
  for (const name of named) {
    const local = locals.get(name)!;
    for (const literal of returnedLiterals(local.text)) {
      fragments.push({ at: local.at + literal.at, text: literal.text, via: name });
    }
  }
  return fragments;
}

const sendBodies = (source: string) => callArguments(source, '.send(').map((call) => call.text);

const lineOf = (source: string, at: number) => source.slice(0, at).split('\n').length;

const where = (file: string, source: string, fragment: Fragment) =>
  `${file}:${lineOf(source, fragment.at)}${fragment.via ? ` (in ${fragment.via})` : ''}`;

/** The value expression of every `spec:` property in a fragment, at any nesting depth. */
function specValues(fragment: string): string[] {
  const out: string[] = [];
  // The lookbehind is what keeps `body.spec` and `rendered.spec` out: this is about a property
  // being WRITTEN into a response, not about one being read.
  const property = /(?<![\w$.])spec\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = property.exec(fragment)) !== null) {
    let depth = 0;
    let value = '';
    for (let i = match.index + match[0].length; i < fragment.length; i += 1) {
      const character = fragment[i];
      if ('([{'.includes(character)) depth += 1;
      else if (')]}'.includes(character)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === ',' && depth === 0) break;
      value += character;
    }
    out.push(value.trim());
  }
  return out;
}

/* The two response specs that are allowed not to be stripped, with the reason each is safe. Both
 * reasons are asserted below rather than taken on trust, because an exemption whose justification
 * has quietly stopped being true is worse than no exemption at all. */
const UNSTRIPPED_SPEC_EXEMPTIONS: Record<string, Record<string, string>> = {
  'applications.ts': {
    'editableResumeSpec(stored)':
      'normalizeSpec rebuilds a ResumeSpec field by field from a fixed allowlist, so no '
      + 'underscore-prefixed key of the stored packet survives it.',
  },
  'baseResume.ts': {
    'profile.base_resume_json':
      'a profiles column, not a generated_resumes spec. Nothing ever attaches a document to it.',
  },
};

test('every spec a route answers with leaves through the one stripper', async () => {
  const offenders: string[] = [];
  let counted = 0;

  for (const file of await routeFiles()) {
    const source = await routeSource(file);
    for (const fragment of responseFragments(source)) {
      for (const value of specValues(fragment.text)) {
        counted += 1;
        if (value.startsWith('specWithoutDocumentPointers(')) continue;
        if (UNSTRIPPED_SPEC_EXEMPTIONS[file]?.[value]) continue;
        offenders.push(`${where(file, source, fragment)} answers with \`spec: ${value}\``);
      }
      /* Shorthand would walk straight past the rule above, and it is the form somebody reaches for
       * when the value already sits in a local called `spec`. There is none today; this is here so
       * that the first one is a failing test rather than a leak. */
      assert.doesNotMatch(
        fragment.text,
        /(?<![\w$.])spec\s*[,}]/,
        `${where(file, source, fragment)} sends a spec in shorthand, which the strip rule cannot read`,
      );
    }
  }

  /* A scan that stopped finding anything would pass every assertion above by saying nothing. The
   * floor is deliberately well under the real count, which is 7 as this is written and was 4 before
   * the fragment set was widened: set tight, it fires FIRST on a tree that has lost one of these
   * calls, and the failure then reports an arithmetic surprise instead of naming the route that
   * leaked. Measured both ways rather than guessed. */
  assert.ok(counted >= 4, `expected the routes' response specs to be found, got ${counted}`);
  assert.deepEqual(
    offenders,
    [],
    'a stored spec reached a response without specWithoutDocumentPointers. Add the call, or add an '
    + 'exemption to UNSTRIPPED_SPEC_EXEMPTIONS with a reason that is asserted.',
  );
});

test('a route that spreads a stored application row overrides its spec', async () => {
  /* The shape both known leaks had, and the one the rule above cannot see: `{ ...row, ... }` names
   * no field at all, so it picks up whatever jsonb column exists on the day it runs. GET
   * /account/export and GET /resume/history are both this, and the export shipped every
   * attachment's object key without a line of that file ever mentioning documents.
   *
   * A spread identifier counts as a stored row when the same file uses it as `<name>.spec` or
   * `<name>.resume_object_key`, which is the only textual evidence available that the thing being
   * copied is a generated_resumes row. Restricted to spreads inside a response fragment or a
   * `.map(`, because a row rebuilt into a local variable - `{ ...claimedRow, spec: { ... } }` in
   * applications.ts, `{ ...rows[0], spec: strippedCoverLetterSpec(...) }` handed to buildPacket in
   * submissionRunner.ts - is server state on its way to a reader, not a response.
   *
   * The fragment set is the widened one, so a helper that spreads the row and is NAMED in the send
   * is now covered: `send({ applications: rows.map(withDisplayFields) })` was a probe and it got
   * through the previous version. A helper reached through a local instead of being named still
   * does. So does a spread under a name the file never writes as `<name>.spec`, which is the same
   * evidence problem stated at the top of the file. */
  const offenders: string[] = [];
  let counted = 0;

  for (const file of await routeFiles()) {
    const source = await routeSource(file);
    const serialized = [...responseFragments(source), ...callArguments(source, '.map(')]
      .map((call) => [call.at, call.at + call.text.length] as const);

    const spread = /\.\.\.([A-Za-z_$][\w$]*)(?![\w$.])/g;
    let match: RegExpExecArray | null;
    while ((match = spread.exec(source)) !== null) {
      const identifier = match[1];
      const readsLikeARow = new RegExp(`(?<![\\w$.])${identifier}\\.(spec|resume_object_key)(?![\\w$])`);
      if (!readsLikeARow.test(source)) continue;
      if (!serialized.some(([from, to]) => match!.index > from && match!.index < to)) continue;

      // Backwards to the `{` this spread is directly inside, then forwards to its match: the object
      // literal being built is the thing that either overrides the spec or does not.
      let depth = 0;
      let start = -1;
      for (let i = match.index; i >= 0; i -= 1) {
        if (source[i] === '}') depth += 1;
        else if (source[i] === '{') {
          if (depth === 0) { start = i; break; }
          depth -= 1;
        }
      }
      if (start < 0) continue;

      counted += 1;
      const literal = balanced(source, start, '{', '}');
      if (/spec:\s*specWithoutDocumentPointers\(/.test(literal)) {
        /* AFTER the spread, or the raw spec wins and the strip is decoration. One line's difference
         * between a fix and something that looks exactly like one. */
        assert.ok(
          literal.indexOf(`...${identifier}`) < literal.indexOf('spec: specWithoutDocumentPointers('),
          `${file}:${lineOf(source, match.index)} strips the spec before spreading the row over it`,
        );
        continue;
      }
      offenders.push(`${file}:${lineOf(source, match.index)} spreads ...${identifier} without overriding spec`);
    }
  }

  assert.ok(counted >= 2, `expected the row spreads to be found, got ${counted}`);
  assert.deepEqual(offenders, [], 'a whole stored row was spread into a response with its spec intact');
});

test('the reasons the two unstripped specs are exempt are still true', () => {
  /* An exemption is a claim about code somewhere else. Both are checked here so that the day one
   * stops holding, this file fails rather than continuing to wave a spec through on its strength. */
  const stripped = normalizeSpec({
    school: 'A University',
    experience: [{ org: 'A Lab', title: 'Intern', bullets: ['Did a thing'] }],
    skills: ['Python'],
    _documents: { transcript: { document_id: 'd1', object_key: 'users/a/documents/b.pdf' } },
    _cover_letter: { object_key: 'users/a/resumes/c.pdf' },
    _review: { status: 'ready_to_submit' },
  }) as unknown as Record<string, unknown>;
  assert.equal(stripped._documents, undefined, 'editableResumeSpec is exempt only while normalizeSpec drops _documents');
  assert.equal(stripped._cover_letter, undefined);
  assert.equal(stripped._review, undefined);
  assert.equal(stripped.school, 'A University');
});

test('the base resume spec is exempt because it is not an application spec', async () => {
  const source = await routeSource('baseResume.ts');
  assert.doesNotMatch(
    source,
    /from\(generated_resumes\)/,
    'baseResume.ts now reads application rows, so `spec: profile.base_resume_json` is no longer '
    + 'self-evidently a profiles column and the exemption has to be re-argued',
  );
});

test('no route outside the document surface reads the attachment map by hand', async () => {
  /* The stripper protects a spec that goes out whole. It does nothing for a route that reaches into
   * `spec._documents` itself and copies a field out, which is how a fourth leak would be written
   * now that the obvious three are closed. Reading the map is documents.ts's job, because it writes
   * it, and submissionRunner.ts's, because it spends the key on a blob fetch. */
  const allowed = new Set(['documents.ts', 'submissionRunner.ts']);
  for (const file of await routeFiles()) {
    if (allowed.has(file)) continue;
    const source = await routeSource(file);
    assert.doesNotMatch(
      source,
      /\._documents\b|\[\s*['"]_documents['"]\s*\]/,
      `${file} reads the attachment map directly; use storedDocuments or attachedDocument, which strip the pointer`,
    );
  }
});

test('no document response body can carry a Blob pointer', async () => {
  const source = await routeSource('documents.ts');
  // blob_url is never read by this file at all, so it cannot be leaked by any route in it.
  assert.doesNotMatch(source, /blob_url/);
  const bodies = sendBodies(source);
  // A file whose sends stopped being found would pass every assertion below vacuously.
  assert.ok(bodies.length >= 20, `expected the route file's sends to be found, got ${bodies.length}`);
  for (const body of bodies) {
    assert.doesNotMatch(body, /object_key|blob_url/, body);
  }
});

test('every response shape is built by the readers that strip the pointer', async () => {
  const source = await routeSource('documents.ts');
  // attachedDocument and documentSummary are the only conversions to a client-visible shape, and
  // both drop object_key. Building an attachment literal inline in a send would bypass them.
  assert.match(source, /attachedDocument\(updated\[0\], kind\)/);
  assert.match(source, /reply\.send\(\{ document: documentSummary\(document\), attachment: stored \}\)/);
  assert.match(source, /reply\.send\(\{ documents: await listUserDocuments\(userId\) \}\)/);
});

test('no route in the document surface is reachable without a session', async () => {
  /* There is no global auth hook and no auth decorator in this app, so a route declared without
   * `{ preHandler: requireAuth }` is silently public: it would answer with another student's
   * transcript to anyone who guesses an id. Counted rather than eyeballed, because the failure is
   * invisible in review and total in production. */
  const source = await routeSource('documents.ts');
  const declarations = source.match(/fastify\.(get|post|put|patch|delete)\(/g) ?? [];
  // Matched against the declaration rather than counted loose in the file: the guard has to be on
  // the route, and a mention of it in a comment is not one.
  const guarded = source.match(/fastify\.(get|post|put|patch|delete)\('[^']+', \{ preHandler: requireAuth \}/g) ?? [];
  assert.equal(declarations.length, 6);
  assert.equal(guarded.length, declarations.length);
});

test('the upload cap is the 4 MB the managed runner can carry, not the multipart limit', async () => {
  /* The global multipart limit is 10 MB and shared with the resume upload (index.ts), but the
   * managed sandbox refuses an upload over 6,000,000 base64 characters, about 4.29 MiB decoded,
   * before a browser opens. A 10 MB promise holds on direct Playwright portals and is false on
   * managed ones, so the number in the copy and the number enforced here have to be the smaller. */
  const source = await routeSource('documents.ts');
  assert.match(source, /MAX_USER_DOCUMENT_BYTES/);
  assert.match(source, /larger than the 4 MB limit/);
  assert.doesNotMatch(source, /10 \* 1024 \* 1024/);
});

test('the submission envelope hands back documents through the stripping reader', async () => {
  const source = await routeSource('applications.ts');
  assert.match(source, /documents: storedDocuments\(row\)/);
});

test('the history payload sends its specs through the stripping reader', async () => {
  /* Kept as its own named assertion on top of the class rule above, because this is the route the
   * class rule was written after. The class rule proves a spec goes through the stripper; this
   * proves it is still THIS route's spec, and that the sanitized value overrides the spread rather
   * than being overridden by it. */
  const source = await routeSource('resume.ts');
  const route = source.slice(
    source.indexOf("fastify.get('/resume/history'"),
    source.indexOf('return reply.status(200).send({ resumes });'),
  );
  assert.ok(route.length > 0, 'the history route must still be found');
  assert.match(route, /spec: specWithoutDocumentPointers\(/);
  assert.ok(
    route.indexOf('...row,') < route.indexOf('spec: specWithoutDocumentPointers('),
    'the sanitized spec has to override the spread row, not be overridden by it',
  );
});

test('the shared reader actually removes both pointers, at every kind', () => {
  /* The fence above proves the call is made. This proves the call is worth making, and it is a
   * behavioural test rather than a second grep because a stripper that silently stopped stripping
   * would satisfy every source-text assertion in this file. */
  const spec = {
    _contact: { full_name: 'A Student' },
    _documents: {
      transcript: {
        document_id: '0f2a9c1e-6b1d-4d9e-9d2a-1f0c7a5e4b33',
        file_name: 'Fall 2025 unofficial transcript.pdf',
        object_key: 'users/a18f774b/documents/5d3f0b6a.pdf',
        blob_url: 'https://blob.example.test/users/a18f774b/documents/5d3f0b6a.pdf',
        attached_at: '2026-08-11T09:14:02.118Z',
        ordered_at: null,
        employer_label: 'Unofficial transcript',
        official_requested: false,
      },
      // A second kind is a new key by design, so the strip cannot be written for one name.
      portfolio: { document_id: 'd1', object_key: 'users/a18f774b/documents/other.pdf' },
    },
  };

  const sent = specWithoutDocumentPointers(spec) as Record<string, unknown>;
  assert.doesNotMatch(JSON.stringify(sent), /object_key|blob_url/);

  const documents = sent._documents as Record<string, Record<string, unknown>>;
  // Everything the screens read is still there. A strip that took the attachment with it would show
  // a student an application that had forgotten the transcript she attached to it.
  assert.equal(documents.transcript.file_name, 'Fall 2025 unofficial transcript.pdf');
  assert.equal(documents.transcript.attached_at, '2026-08-11T09:14:02.118Z');
  assert.equal(documents.transcript.employer_label, 'Unofficial transcript');
  assert.equal(documents.transcript.official_requested, false);
  assert.equal(documents.portfolio.document_id, 'd1');
  assert.deepEqual(sent._contact, { full_name: 'A Student' });

  // The stored spec is untouched: this runs on a row the packet builder still has to read a key off.
  assert.equal(spec._documents.transcript.object_key, 'users/a18f774b/documents/5d3f0b6a.pdf');

  // A spec with nothing to strip comes back by identity, which is what keeps a fifty-row payload
  // from paying for a copy it does not need.
  const untouched = { _review: { status: 'ready' } };
  assert.equal(specWithoutDocumentPointers(untouched), untouched);
  assert.equal(specWithoutDocumentPointers(null), null);
});

test('the stripper stops at _documents, and the cover letter keeps its key on purpose', () => {
  /* Stated as a test so the boundary is a decision on the record rather than an oversight waiting
   * to be read as one. `_cover_letter.object_key` is ALSO a public Blob pointer and it is ALSO on
   * the wire, in the submission envelope and in every history row. It is left alone here because
   * removing it is a separate change with a separate blast radius - routes/resume.ts reads that key
   * to mint the cover letter's download link - and because widening this function quietly is how a
   * download link breaks with no test naming the cause. It is filed, not fixed. */
  const sent = specWithoutDocumentPointers({
    _cover_letter: { object_key: 'users/a/resumes/letter.pdf', file_name: 'letter.pdf' },
    _documents: { transcript: { document_id: 'd1', object_key: 'users/a/documents/t.pdf' } },
  }) as Record<string, Record<string, Record<string, unknown>>>;

  assert.equal(sent._documents.transcript.object_key, undefined);
  assert.equal(sent._cover_letter.object_key, 'users/a/resumes/letter.pdf');
});
