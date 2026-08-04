import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  academicSeedFrom,
  applyParsedProfilePatch,
  declaredSkillsForPatch,
  normalizeEditableList,
  parsedProfilePatchSchema,
} from './profile';

test('the parsed profile correction accepts the safe editable fields', () => {
  const result = parsedProfilePatchSchema.safeParse({
    full_name: 'Mehek Mandal',
    phone: '+1 213 555 0100',
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'May 2027',
    objective: 'Builder interested in investing and technology.',
    skills: ['Python', 'Financial modeling'],
    target_roles: [
      'Private Equity Associate',
      'Growth Equity Analyst',
      'Venture Capital Analyst',
      'Investment Banking Analyst',
      'Strategy Associate',
    ],
  });

  assert.equal(result.success, true);
});

test('any real role title is valid, including private equity', () => {
  const result = parsedProfilePatchSchema.safeParse({
    target_roles: [
      'Private Equity Associate',
      'Search Fund Intern',
      'Chief of Staff',
      'Quantitative Researcher',
      'Technical Program Manager',
    ],
  });
  assert.equal(result.success, true);
});

test('target roles remain a complete five-title targeting set', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ target_roles: ['Private Equity Associate'] }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ target_roles: Array.from({ length: 6 }, (_, i) => `Role ${i}`) }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ target_roles: ['Role 1', 'Role 2', 'Role 3', 'Role 4', 'role 1'] }).success, false);
});

test('account and structured work fields cannot be changed through the parsed profile route', () => {
  /* Each of these is asserted with a REASON, not just a false. A single-unknown-key payload is
   * rejected by two independent rules: `.strict()` refuses the key, and the non-empty refine
   * refuses the `{}` that stripping the key would leave behind. So `success === false` alone does
   * not prove `.strict()` is alive. Delete `.strict()` and these three still fail, for the wrong
   * rule. Pinning the message is what makes them mean what they say. */
  for (const forbidden of [{ email: 'other@example.com' }, { experience: [] }, { grad_year: 2035 }]) {
    const result = parsedProfilePatchSchema.safeParse(forbidden);
    assert.equal(result.success, false);
    assert.match(
      result.success ? '' : result.error.issues[0].message,
      /Unrecognized key/,
      `${JSON.stringify(forbidden)} must be refused for being an unknown key, not for being empty ` +
        'after the key was silently stripped',
    );
  }
});

test('skills and objective may be deliberately cleared', () => {
  const result = parsedProfilePatchSchema.safeParse({ skills: [], objective: '' });
  assert.equal(result.success, true);
});

test('editable lists are trimmed and deduplicated without role taxonomy filtering', () => {
  assert.deepEqual(
    normalizeEditableList([' Private Equity ', 'private equity', 'Chief of Staff']),
    ['Private Equity', 'Chief of Staff'],
  );
});

test('a profile patch preserves unsent fields and keeps graduation year in sync', () => {
  const next = applyParsedProfilePatch(
    { email: 'verified@example.com', school: 'USC', grad_year: 2026, skills: ['Old'] },
    { grad_date: 'August 2024 - May 2028', skills: [' Python ', 'python', 'SQL'] },
  );

  assert.equal(next.email, 'verified@example.com');
  assert.equal(next.school, 'USC');
  assert.equal(next.grad_year, 2028);
  assert.deepEqual(next.skills, ['Python', 'SQL']);
});

test('clearing graduation text also clears the derived eligibility year', () => {
  const next = applyParsedProfilePatch({ grad_date: 'May 2027', grad_year: 2027 }, { grad_date: '' });

  assert.equal(next.grad_date, '');
  assert.equal('grad_year' in next, false);
});

/* ISSUE-027. `languages` had no test at all against this schema, which is the one field the review
 * screen added most recently and the one it now sends on EVERY save. The schema is .strict(), so
 * the failure mode is not a bad value quietly stored - it is a 400 on the whole patch, on every
 * save, for every student, from a payload shape nothing here was asserting. */
test('the languages field is accepted in the shapes the review screen actually sends', () => {
  // Empty is a real answer: a resume with no language line, or a student clearing a bad parse.
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: [] }).success, true);
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: ['English', 'Hindi', 'French'] }).success, true);
  // Exactly at the cap, and one past it. A list this long is a parse failure, not a polyglot.
  assert.equal(
    parsedProfilePatchSchema.safeParse({ languages: Array.from({ length: 30 }, (_, i) => `Language ${i}`) }).success,
    true,
  );
  assert.equal(
    parsedProfilePatchSchema.safeParse({ languages: Array.from({ length: 31 }, (_, i) => `Language ${i}`) }).success,
    false,
  );
});

test('a mistyped languages value is rejected rather than stored', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: 'English' }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: [7] }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: [''] }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: ['x'.repeat(81)] }).success, false);
});

test('the full editor save the review screen sends validates against the strict schema', () => {
  // Every field the resume page puts in one PATCH body, together, in the shape it sends them. A
  // .strict() schema fails the WHOLE patch on one unexpected key, so the fields have to be
  // exercised as a payload and not only one at a time.
  const result = parsedProfilePatchSchema.safeParse({
    full_name: 'Mehek Mandal',
    phone: '+1 213 555 0100',
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'May 2027',
    objective: 'Builder interested in investing and technology.',
    skills: ['Python', 'Figma', 'Financial modeling'],
    languages: ['English', 'Hindi', 'French'],
    target_roles: [
      'Private Equity Associate',
      'Growth Equity Analyst',
      'Venture Capital Analyst',
      'Investment Banking Analyst',
      'Strategy Associate',
    ],
  });

  assert.equal(result.success, true);
});

/* ISSUE-020b. ISSUE-020 stopped the PARSER filing spoken languages under skills. It did not stop
 * them being PROMOTED into the declared profiles.skills column through this patch, and that path is
 * the worse one: the declared column is read with no parsed fallback, so a re-upload cannot repair
 * it, and the review screen sends `skills` unconditionally on every save. */
test('a spoken language cannot be promoted into the declared skills list', () => {
  const next = applyParsedProfilePatch(
    {},
    { skills: ['Python', 'Hindi', 'Figma', 'Spanish (conversational)'] },
  );

  assert.deepEqual(next.skills, ['Python', 'Figma']);
  // Moved, not dropped: the student left the word on their own review screen, so it goes to the
  // field that screen already edits rather than being deleted behind their back.
  assert.deepEqual(next.languages, ['Hindi', 'Spanish (conversational)']);
});

test('a programming language is not mistaken for a spoken one on the promotion path', () => {
  const next = applyParsedProfilePatch({}, { skills: ['Java', 'R', 'Go', 'Swift', 'Javanese'] });

  assert.deepEqual(next.skills, ['Java', 'R', 'Go', 'Swift']);
  assert.deepEqual(next.languages, ['Javanese']);
});

test('an explicit languages edit leads the union and the recovered entries dedupe against it', () => {
  const next = applyParsedProfilePatch(
    {},
    { skills: ['Python', 'english', 'Tamil'], languages: ['English'] },
  );

  assert.deepEqual(next.skills, ['Python']);
  // The student's own spelling of English wins; Tamil follows because it was only ever in skills.
  assert.deepEqual(next.languages, ['English', 'Tamil']);
});

test('a save that only touches skills does not wipe the stored language list', () => {
  const next = applyParsedProfilePatch(
    { languages: ['English', 'Hindi'] },
    { skills: ['Python', 'French'] },
  );

  assert.deepEqual(next.skills, ['Python']);
  assert.deepEqual(next.languages, ['English', 'Hindi', 'French']);
});

/* The declared column, which is the write ISSUE-020b is actually about.
 *
 * parsed_json is self-healing - the next resume upload rewrites it wholesale - so every test above
 * this one is about a value that repairs itself. profiles.skills does not: routes/resume.ts reads
 * it with no parsed fallback, so a spoken language that reaches it is there forever. These tests
 * exist because the five behavioural ones above all exercise applyParsedProfilePatch in isolation
 * and a mutation of the handler's own skills expression survived every one of them. */
test('the declared skills column never takes a spoken language from a patch', () => {
  assert.deepEqual(
    declaredSkillsForPatch({ skills: ['Python', 'Hindi', 'Figma', 'Spanish (conversational)'] }, ['Stored']),
    ['Python', 'Figma'],
  );
  // Programming languages are not spoken languages, on this path as on every other.
  assert.deepEqual(declaredSkillsForPatch({ skills: ['Java', 'R', 'Go', 'Javanese'] }, null), ['Java', 'R', 'Go']);
});

test('a patch that omits skills leaves the declared column exactly as it was', () => {
  // An omitted field is not an instruction to clear a permanent column.
  const stored = ['Python', 'Figma'];
  assert.equal(declaredSkillsForPatch({ objective: 'Builder.' }, stored), stored);
  assert.equal(declaredSkillsForPatch({ languages: ['Hindi'] }, null), null);
  // An EMPTY array is an instruction, and a different one: the student cleared the box.
  assert.deepEqual(declaredSkillsForPatch({ skills: [] }, stored), []);
});

test('the declared column and the parsed skills list cannot drift apart', () => {
  // Two call sites, one decision. If either side stops sorting languages the other becomes a lie,
  // and the pair is exactly what serveProfileJson chooses between when it serves a profile.
  for (const skills of [
    ['Python', 'Hindi', 'Figma'],
    ['English', 'Spanish', 'French'],
    ['Java', 'Javanese', 'R'],
    [],
  ]) {
    assert.deepEqual(
      declaredSkillsForPatch({ skills }, null),
      applyParsedProfilePatch({}, { skills }).skills,
      `the declared and parsed skills lists disagree for ${JSON.stringify(skills)}`,
    );
  }
});

test('the PATCH /profile/parsed handler computes the declared column through the guard', () => {
  /* A source-level assertion, for the same reason the jd-match suite reads index.ts: the defect
   * this guards against is not a wrong value, it is the handler computing the value SOMEWHERE
   * ELSE. Reverting that one line to the unguarded spelling restores the permanent-pollution bug
   * and leaves every behavioural test above green, because none of them can see the handler.
   *
   * Standing the route up for real would need the db, the auth middleware and field crypto, none of
   * which profileRoutes takes by injection today. Until it does, the composition root is the only
   * place the wiring is visible, so this reads it. */
  const source = readFileSync(path.join(__dirname, 'profile.ts'), 'utf8');
  /* Scoped to the one handler, so nothing below can be satisfied by an identically spelled line
   * elsewhere in an 1100-line file.
   *
   * The terminator is a route-level `fastify.` at TWO-SPACE indent, not any `fastify.`. The loose
   * version ended the slice at the first mention of the identifier anywhere, so a single
   * `fastify.log.info(...)` added inside this handler truncated the slice to the route prologue and
   * failed the call assertion while the call itself sat untouched three lines below. It survived at
   * all only because line 1062 happens to read `applicationRowForProfile(userId, fastify)` with a
   * closing paren rather than a dot. A one-character margin on a guard is not a guard. */
  const start = source.indexOf("fastify.patch('/profile/parsed'");
  assert.notEqual(start, -1, 'PATCH /profile/parsed must exist for this guard to mean anything');
  const nextRoute = source.slice(start + 1).search(/\n {2}fastify\./);
  const handler = nextRoute === -1 ? source.slice(start) : source.slice(start, start + 1 + nextRoute);

  /* Whitespace-insensitive and tolerant of a non-null assertion, on purpose. The first cut of this
   * pinned the exact one-line spelling, which then failed on a Prettier reflow across three lines
   * and on the `rows[0]!.skills` that a strictNullChecks tightening produces. Failing closed on
   * innocent formatting work is how a guard gets loosened by an irritated maintainer and then
   * protects nothing, so it flexes on layout while staying rigid about the call. */
  assert.match(
    handler,
    /const skills = declaredSkillsForPatch\(\s*patch,\s*rows\[0\]!?\.skills,?\s*\)/,
    'the declared profiles.skills value must be COMPUTED by declaredSkillsForPatch',
  );

  /* Computing the guarded value is only half of it. The value has to REACH the column, and there
   * are more ways for it not to than the obvious one. Each assertion below closes a specific hole
   * that a green suite and a clean tsc both missed:
   *
   *  - `skills: patch.skills ?? rows[0].skills` at the write, guard line untouched. The guarded
   *    local just becomes unused, which this tsconfig does not flag.
   *  - a SECOND `tx.update(profiles).set(...)` after the guarded one, which is what an ordinary
   *    follow-up write to the same table looks like and is the likeliest of these to happen for
   *    real. Whoever writes it will not know this column is special.
   *  - a decoy first write on a dead `.where(sql`false`)`, with the live write re-deriving.
   *  - a trailing `...(patch.skills ? { skills: patch.skills } : {})` spread that overrides the
   *    honest property from the right.
   *  - a block around the write redeclaring `const skills` from the raw patch, shadowing the guard.
   *
   * So: exactly one write to this table in the handler, exactly one `skills` binding, and inside
   * that write's object every mention of `skills` is one of the accepted spellings of "the guarded
   * local". */
  const writes = handler.match(/\.update\(profiles\)/g) ?? [];
  assert.equal(
    writes.length,
    1,
    'exactly one write to profiles in this handler. A second .update(profiles) can set the ' +
      'declared skills column again, after the guarded write and out of its reach.',
  );

  const declarations = handler.match(/\bconst skills\b/g) ?? [];
  assert.equal(
    declarations.length,
    1,
    'exactly one `skills` binding in this handler, so no inner block can shadow the guarded one',
  );

  // Balanced-brace extraction, not a non-greedy regex. A non-greedy `\}\)` stops at the first
  // `}` that happens to be followed by `)`, which an inner `: {})` supplies, silently truncating
  // the object under examination to a prefix that looks innocent.
  const setAt = handler.indexOf('.set({', handler.indexOf('.update(profiles)'));
  assert.notEqual(setAt, -1, 'the profiles write must go through a .set({ ... }) call');
  const objectStart = handler.indexOf('{', setAt);
  let depth = 0;
  let objectEnd = -1;
  for (let i = objectStart; i < handler.length; i++) {
    if (handler[i] === '{') depth += 1;
    else if (handler[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        objectEnd = i;
        break;
      }
    }
  }
  assert.notEqual(objectEnd, -1, 'the .set({ ... }) object literal must be balanced');
  const setObject = handler.slice(objectStart + 1, objectEnd);

  /* All three spellings mean the same thing and all three are correct code: the shorthand the
   * handler uses today, the `skills: skills` longhand, and a `...{ skills }` spread. An earlier cut
   * accepted only the shorthand and failed the other two while telling the author their correct
   * code was "an expression at the call", which is both wrong and the kind of message that gets a
   * check deleted rather than obeyed. */
  const ACCEPTED = /(^|,)\s*(?:skills|skills\s*:\s*skills|\.\.\.\s*\{\s*skills\s*\})\s*(?=,|$)/g;
  assert.match(
    setObject,
    new RegExp(ACCEPTED.source),
    'profiles.skills must be written from the guarded `skills` local. Accepted: the `skills` ' +
      'shorthand, `skills: skills`, or `...{ skills }`. Anything else re-derives the value at the ' +
      'write and bypasses declaredSkillsForPatch.',
  );
  assert.ok(
    !/\bskills\b/.test(setObject.replace(ACCEPTED, '$1')),
    'the write object mentions `skills` somewhere other than the guarded local. A duplicate key, ' +
      'a computed `["skills"]`, or a trailing conditional spread all override the honest property ' +
      'and put the unsorted list back in the permanent column.',
  );

  assert.ok(
    !source.includes('normalizeEditableList(patch.skills)'),
    'Forbidden spelling. normalizeEditableList trims and dedupes but does NOT sort spoken ' +
      'languages out, so this expression promotes a language into whichever list it feeds. On the ' +
      'declared column that is permanent (routes/resume.ts reads profiles.skills with no parsed ' +
      'fallback, and no re-upload rewrites it), and on the parsed path it drops the recovered ' +
      'languages instead of moving them to `languages`. Both correct paths already exist: use ' +
      'declaredSkillsForPatch for the column and applyParsedProfilePatch for parsed_json. If you ' +
      'are here because you tripped this, fix the call rather than deleting the check.',
  );
});

test('the merged language list stays inside the shape the next save may send back', () => {
  // The union can add entries the caller never sent, which is the only way this list can cross the
  // schema cap. A stored value one entry over it would 400 the student's next save on our own data.
  const next = applyParsedProfilePatch(
    { languages: Array.from({ length: 30 }, (_, i) => `Declared ${i}`) },
    { skills: ['Python', 'Hindi', 'Tamil'] },
  );

  assert.equal((next.languages as string[]).length, 30);
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: next.languages }).success, true);
});

test('a recovered language past the cap is dropped outright, which is the chosen tradeoff', () => {
  /* Asserted so the loss stays visible rather than being discovered later as a surprise. Past the
   * cap the entries are DELETED, not moved: they were already taken out of skills, and the slice
   * then takes them off the end of the union, so they survive in neither field.
   *
   * Kept on purpose. Reaching it needs a student who already stores 30 languages, which the schema
   * calls a parse failure rather than a polyglot, and the alternative is storing 31 and 400ing
   * every later save of their entire profile. A truncated list they can still edit beats a profile
   * they can no longer save. What survives is their own declared list, never the recovered guess. */
  const declared = Array.from({ length: 30 }, (_, i) => `Declared ${i}`);
  const next = applyParsedProfilePatch(
    { languages: declared },
    { skills: ['Python', 'Tamil', 'Telugu', 'Kannada'] },
  );

  assert.deepEqual(next.skills, ['Python'], 'the languages left skills, as on every other path');
  assert.deepEqual(next.languages, declared, 'the student declaration is what survives the cap');
  for (const lost of ['Tamil', 'Telugu', 'Kannada']) {
    assert.ok(
      !(next.skills as string[]).includes(lost) && !(next.languages as string[]).includes(lost),
      `"${lost}" is gone from BOTH fields: real loss, accepted over a profile that cannot be saved`,
    );
  }
});

/* The resume editor sends `languages` on EVERY save, including as an empty array, and this schema
 * is .strict(). So the field is not optional in practice: drop it or rename it and Zod answers
 * "Unrecognized key(s) in object: 'languages'" and every student save 400s, no matter what else
 * the payload got right. The ISSUE-020 deploy on 2026-08-03 only missed that outage through deploy
 * ordering. These cases exist so the next person to touch the field breaks a test instead. */
test('an empty languages array parses, because the resume editor sends one on every save', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: [] }).success, true);
});

test('a spoken language list the student corrected parses', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: ['Hindi', 'Arabic'] }).success, true);
});

// The payload shape the editor actually PUTs, languages included. The single-field cases above
// would still pass if the strict schema rejected this combination, so pin the real one too.
test('the whole editor save payload parses with languages alongside every other field', () => {
  const result = parsedProfilePatchSchema.safeParse({
    full_name: 'Mehek Mandal',
    phone: '+1 213 555 0100',
    school: 'University of Southern California',
    degree: 'BS Computer Science and Business Administration',
    grad_date: 'May 2027',
    objective: 'Builder interested in investing and technology.',
    skills: ['Python', 'Financial modeling'],
    languages: [],
    target_roles: [
      'Private Equity Associate',
      'Growth Equity Analyst',
      'Venture Capital Analyst',
      'Investment Banking Analyst',
      'Strategy Associate',
    ],
  });

  assert.equal(result.success, true);
});

/* ISSUE-027 negative control. Everything above about `languages` asserts that a shape is ACCEPTED,
 * and every one of those assertions gets MORE true as the schema gets looser. Delete `.strict()`
 * and they all stay green, which was verified by mutation rather than assumed: the whole 1505-test
 * backend suite passed with `.strict()` removed from parsedProfilePatchSchema.
 *
 * That matters because the two failure modes here are opposites and the fix for one is the sabotage
 * of the other. Dropping `languages` from the schema 400s every save while `.strict()` stands;
 * dropping `.strict()` makes `languages` parse again while also making every typo, every renamed
 * field and every stale client key parse silently into a patch that then writes nothing. A future
 * maintainer who hits the 400 and reaches for `.strict()` instead of the field has to break this. */
test('an unknown key is refused even alongside a valid languages value', () => {
  /* The key detail is that this payload carries a VALID field too. Strip the unknown key and what
   * remains is `{ languages: [] }`, which is non-empty and parses fine, so the non-empty refine
   * cannot rescue this assertion the way it rescues a lone-unknown-key payload. `.strict()` is the
   * only rule that can fail this, which is what makes it a real control. */
  const withValidField = parsedProfilePatchSchema.safeParse({ languages: [], unexpected_field: 'x' });
  assert.equal(
    withValidField.success,
    false,
    'a patch carrying an unknown key must be refused whole. If this passes, `.strict()` is gone and ' +
      'every "languages is accepted" case above has stopped proving anything.',
  );
  assert.match(
    withValidField.success ? '' : withValidField.error.issues[0].message,
    /Unrecognized key/,
    'refused for the unknown key specifically, not incidentally by some other rule',
  );

  // The same control with a full, otherwise-perfect editor payload, so the guard is not satisfied
  // by the minimal case alone.
  const fullPayload = parsedProfilePatchSchema.safeParse({
    full_name: 'Mehek Mandal',
    skills: ['Python'],
    languages: ['English', 'Hindi'],
    linkedin_url: 'https://linkedin.com/in/example',
  });
  assert.equal(fullPayload.success, false, 'one unknown key fails the WHOLE patch, however valid the rest is');
});

test('languages absent entirely is accepted and is not coerced into an empty list', () => {
  /* The field is `.optional()`, and absence has to stay a real third state. A save from a client
   * that predates the field must still parse, and it must NOT arrive at the handler looking like
   * `languages: []`, because applyParsedProfilePatch reads an empty array as "the student cleared
   * the box" and would wipe a stored language list that nobody touched. */
  const result = parsedProfilePatchSchema.safeParse({ skills: ['Python'], objective: 'Builder.' });
  assert.equal(result.success, true);
  assert.equal(
    result.success && 'languages' in result.data,
    false,
    'an omitted languages field must stay omitted, not become an empty array that clears stored data',
  );
});

test('a blank language is rejected rather than stored as whitespace', () => {
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: [' '] }).success, false);
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: ['a'.repeat(81)] }).success, false);
});

test('a languages list past thirty is a parse failure, not a polyglot', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => `Language ${i}`);
  assert.equal(parsedProfilePatchSchema.safeParse({ languages: thirty }).success, true);
  assert.equal(
    parsedProfilePatchSchema.safeParse({ languages: [...thirty, 'Language 30'] }).success,
    false,
  );
});

test('a languages correction is trimmed and deduplicated like every other editable list', () => {
  const next = applyParsedProfilePatch(
    { school: 'USC', languages: ['Old'] },
    { languages: [' Hindi ', 'hindi', 'Arabic'] },
  );

  assert.deepEqual(next.languages, ['Hindi', 'Arabic']);
  assert.deepEqual(next.languages, normalizeEditableList([' Hindi ', 'hindi', 'Arabic']));
  assert.equal(next.school, 'USC');
});

/* A resume line is not a fluency claim. Languages corrected here land in parsed_json only;
 * application_profile.languages stays the student's own declaration from onboarding, and the one
 * writer this route has into that table is the academic seed, which cannot carry the field. */
test('a languages correction never becomes a declared fluency on application_profile', () => {
  const next = applyParsedProfilePatch({}, { languages: ['Hindi'] });
  assert.deepEqual(Object.keys(next), ['languages']);

  // gpa is left out only because it is encrypted on the way in and this case is about the shape of
  // the seed, not the ciphertext. The parse being seeded from carries languages, as a real one does.
  const parseWithLanguages = { gpa_scale: '4.0', major: 'Computer Science', languages: ['Hindi'] };
  const seed = academicSeedFrom(parseWithLanguages, undefined);
  assert.deepEqual(Object.keys(seed).sort(), ['gpa_scale', 'major']);
});
