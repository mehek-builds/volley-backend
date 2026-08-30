import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBullets,
  bankEntriesFrom,
  planBankReconciliation,
  publicResumeProfile,
  resumeTextWithLayout,
  resumeUploadKeyFromHeader,
} from './profile';
import type { ParsedProfile } from '../llm/parse';
import { CATEGORIES, targetingBodySchema } from './targeting';

const UID = '00000000-0000-4000-8000-000000000001';

function profile(over: Partial<ParsedProfile> = {}): ParsedProfile {
  return {
    full_name: 'Mehek Mandal',
    experience: [],
    skills: [],
    projects: [],
    school: 'University of Southern California',
    grad_year: 2028,
    target_roles: [],
    ...over,
  };
}

describe('toBullets', () => {
  test('splits a multi-line description into one variant per bullet', () => {
    assert.deepEqual(toBullets('Built the thing\nShipped the thing'), ['Built the thing', 'Shipped the thing']);
  });

  test('strips leading bullet markers', () => {
    assert.deepEqual(toBullets('- Built it\n• Shipped it\n* Measured it'), ['Built it', 'Shipped it', 'Measured it']);
  });

  test('falls back to the whole description when there is nothing to split on', () => {
    assert.deepEqual(toBullets('One single sentence.'), ['One single sentence.']);
  });

  test('drops blank lines rather than seeding empty variants', () => {
    assert.deepEqual(toBullets('Built it\n\n\nShipped it'), ['Built it', 'Shipped it']);
  });

  test('empty description yields no variants at all', () => {
    assert.deepEqual(toBullets(''), []);
    assert.deepEqual(toBullets('   \n  '), []);
  });
});

describe('resumeTextWithLayout', () => {
  test('groups an already sorted page without duplicating items across rows', () => {
    const text = resumeTextWithLayout([[
      { text: 'World', x: 50, y: 100, width: 20, height: 10 },
      { text: 'Hello', x: 10, y: 101, width: 20, height: 10 },
      { text: 'Next', x: 10, y: 90, width: 20, height: 10 },
    ]]);
    assert.equal(text, 'Hello World\nNext');
  });

  test('declines layout reconstruction above the geometry ceiling', () => {
    const item = { text: 'x', x: 1, y: 1, width: 1, height: 1 };
    assert.equal(resumeTextWithLayout([Array.from({ length: 50_001 }, () => item)]), '');
  });

  test('declines layout reconstruction above the decoded-text ceiling', () => {
    const item = { text: 'x'.repeat(500_001), x: 1, y: 1, width: 1, height: 1 };
    assert.equal(resumeTextWithLayout([[item]]), '');
  });
});

// Before this mapping existed, POST /profile wrote parsed_json and nothing else, while
// /resume/generate and /application/answer both hard-400 on an empty bank. Every account made
// through the web app looked set up and could generate nothing.
describe('bankEntriesFrom', () => {
  test('maps experience to job entries with a joined date range', () => {
    const entries = bankEntriesFrom(
      profile({
        experience: [
          { company: 'Traeco', title: 'Founder', start: '2025', end: '2026', description: 'Built it\nShipped it' },
        ],
      }),
      UID,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'job');
    assert.equal(entries[0].org, 'Traeco');
    assert.equal(entries[0].title, 'Founder');
    assert.equal(entries[0].date_range, '2025 - 2026');
    assert.deepEqual(entries[0].bullet_variants, ['Built it', 'Shipped it']);
    assert.equal(entries[0].user_id, UID);
  });

  test('maps projects to project entries', () => {
    const entries = bankEntriesFrom(
      profile({ projects: [{ name: 'Litos', description: 'Autofills applications' }] }),
      UID,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'project');
    assert.equal(entries[0].org, 'Litos');
    assert.equal(entries[0].title, null);
    assert.equal(entries[0].date_range, null);
  });

  test('drops entries with no org - an unnamed row cannot ground anything', () => {
    const entries = bankEntriesFrom(
      profile({
        experience: [{ company: '  ', title: 'Ghost', start: '', end: '', description: 'Did things' }],
        projects: [{ name: '', description: 'Nameless' }],
      }),
      UID,
    );
    assert.equal(entries.length, 0);
  });

  test('drops entries with no bullets - bullet_variants is notNull and min(1)', () => {
    const entries = bankEntriesFrom(
      profile({ experience: [{ company: 'Traeco', title: 'Founder', start: '', end: '', description: '' }] }),
      UID,
    );
    assert.equal(entries.length, 0);
  });

  test('a missing date range is null, not the string " - "', () => {
    const entries = bankEntriesFrom(
      profile({ experience: [{ company: 'Traeco', title: '', start: '', end: '', description: 'Did it' }] }),
      UID,
    );
    assert.equal(entries[0].date_range, null);
    assert.equal(entries[0].title, null);
  });

  test('jobs and projects both land, jobs first', () => {
    const entries = bankEntriesFrom(
      profile({
        experience: [{ company: 'Traeco', title: 'Founder', start: '2025', end: '2026', description: 'Built it' }],
        projects: [{ name: 'Litos', description: 'Autofills' }],
      }),
      UID,
    );
    assert.deepEqual(entries.map((e) => e.type), ['job', 'project']);
  });

  test('handles a parse with no experience or projects at all', () => {
    assert.deepEqual(bankEntriesFrom(profile(), UID), []);
  });
});

describe('planBankReconciliation', () => {
  test('adds newly parsed leadership without replacing existing jobs', () => {
    const parsed = profile({
      experience: [{ company: 'Traeco', title: 'Founder', start: '2025', end: '2026', description: 'Built it' }],
      leadership: [{ organization: 'Women in Computing', title: 'President', start: '2026', end: 'Present', description: 'Led the team' }],
    });
    const result = planBankReconciliation(parsed, UID, [{
      id: 'job-1',
      type: 'job',
      org: 'Traeco',
      title: 'Founder',
      date_range: '2025 - 2026',
      location: null,
    }]);
    assert.deepEqual(result.inserts.map((entry) => entry.type), ['leadership']);
    assert.deepEqual(result.enrichments, []);
  });

  test('fills blank project metadata without touching stored bullet variants', () => {
    const parsed = profile({
      projects: [{ name: 'Litos', role: 'Product Lead', date_range: '2026 - Present', description: 'Built the product' }],
    });
    const result = planBankReconciliation(parsed, UID, [{
      id: 'project-1',
      type: 'project',
      org: 'litos',
      title: null,
      date_range: null,
      location: null,
    }]);
    assert.deepEqual(result.inserts, []);
    assert.deepEqual(result.enrichments, [{
      id: 'project-1',
      title: 'Product Lead',
      date_range: '2026 - Present',
    }]);
  });

  test('keeps two roles at the same company when both titles are distinct', () => {
    const parsed = profile({
      experience: [{ company: 'Acme', title: 'Product Intern', start: '2026', end: '2026', description: 'Shipped research' }],
    });
    const result = planBankReconciliation(parsed, UID, [{
      id: 'job-1',
      type: 'job',
      org: 'Acme',
      title: 'Engineering Intern',
      date_range: '2025',
      location: null,
    }]);
    assert.equal(result.inserts.length, 1);
    assert.equal(result.inserts[0].title, 'Product Intern');
  });
});

describe('targeting schema', () => {
  test('accepts the five answers /start collects', () => {
    const r = targetingBodySchema.safeParse({
      categories: ['software-engineering', 'data-ml'],
      titles: ['Software Engineer Intern', 'ML Engineer Intern'],
      role_types: ['internship', 'co-op'],
      locations: ['Dubai', 'London'],
      remote_only: false,
      primary_period: 'summer-2027',
      backup_period: 'spring-2027',
    });
    assert.equal(r.success, true);
  });

  test('a period must be a slug, not a display label', () => {
    assert.equal(targetingBodySchema.safeParse({ primary_period: 'summer-2027' }).success, true);
    assert.equal(targetingBodySchema.safeParse({ primary_period: 'Summer 2027' }).success, false);
    assert.equal(targetingBodySchema.safeParse({ primary_period: 'summer-27' }).success, false);
    assert.equal(targetingBodySchema.safeParse({ primary_period: 'whenever' }).success, false);
  });

  /* "immediately" is the only non-seasonal period the column accepts, and it has to be accepted on
     BOTH fields: the onboarding screen offers the same chip row for the main period and the backup,
     so a body carrying it in backup_period is a body a student can produce in two clicks. */
  test('immediately is a valid period on either field, and nothing else non-seasonal is', () => {
    assert.equal(targetingBodySchema.safeParse({ primary_period: 'immediately' }).success, true);
    assert.equal(targetingBodySchema.safeParse({ backup_period: 'immediately' }).success, true);
    assert.equal(targetingBodySchema.safeParse({ primary_period: 'Immediately' }).success, false);
    assert.equal(targetingBodySchema.safeParse({ primary_period: 'immediate' }).success, false);
    assert.equal(targetingBodySchema.safeParse({ primary_period: 'asap' }).success, false);
  });

  test('role_types is a closed set', () => {
    assert.equal(targetingBodySchema.safeParse({ role_types: ['internship'] }).success, true);
    assert.equal(targetingBodySchema.safeParse({ role_types: ['contract'] }).success, false);
  });

  test('null clears a field; omission leaves it alone', () => {
    assert.equal(targetingBodySchema.safeParse({ primary_period: null }).success, true);
    assert.equal(targetingBodySchema.safeParse({}).success, true);
  });

  test('titles take as many as a student wants, up to the payload guard', () => {
    assert.equal(targetingBodySchema.safeParse({ titles: Array(13).fill('Engineer') }).success, true);
    assert.equal(targetingBodySchema.safeParse({ titles: Array(201).fill('Engineer') }).success, false);
  });

  // Categories and role types used to cap at 3 and 2 as a product rule. They no longer cap at all
  // (2026-08-02): a wide preference is still a preference, and the old rule disabled a chip under
  // the cursor rather than letting a student say what they meant.
  test('every category at once is accepted', () => {
    assert.equal(targetingBodySchema.safeParse({ categories: [...CATEGORIES] }).success, true);
  });

  test('every role type at once is accepted', () => {
    assert.equal(
      targetingBodySchema.safeParse({ role_types: ['internship', 'co-op', 'new-grad', 'full-time'] }).success,
      true,
    );
  });

  test('the closed lists still reject junk', () => {
    assert.equal(targetingBodySchema.safeParse({ categories: ['everything'] }).success, false);
    assert.equal(targetingBodySchema.safeParse({ role_types: ['contract'] }).success, false);
  });

  test('clearing still works', () => {
    assert.equal(targetingBodySchema.safeParse({ categories: null, role_types: null }).success, true);
    assert.equal(targetingBodySchema.safeParse({ categories: [], role_types: [] }).success, true);
  });

  test('locations take as many places as a student wants, up to a payload guard', () => {
    assert.equal(targetingBodySchema.safeParse({ locations: ['Dubai', 'London'] }).success, true);
    assert.equal(targetingBodySchema.safeParse({ locations: Array(6).fill('Dubai') }).success, true);
    assert.equal(targetingBodySchema.safeParse({ locations: Array(50).fill('Dubai') }).success, true);
    // Not a product rule, just a bound on a client-controlled jsonb column.
    assert.equal(targetingBodySchema.safeParse({ locations: Array(201).fill('Dubai') }).success, false);
    assert.equal(targetingBodySchema.safeParse({ locations: [''] }).success, false);
    assert.equal(targetingBodySchema.safeParse({ remote_only: true }).success, true);
  });

  test('Remote is a place a student can save, not only the checkbox', () => {
    assert.equal(targetingBodySchema.safeParse({ locations: ['Remote', 'London, UK'] }).success, true);
  });
});

/* An existing row is the ONLY way most students will ever get a location: their bank was built
   before the column existed, and every org they re-upload matches and takes the enrichment branch.
   Location shipped on the insert path alone and was therefore unreachable for all 135 real rows,
   which is what these pin. */
describe('planBankReconciliation: location', () => {
  test('backfills a location onto a row that has none', () => {
    const parsed = profile({
      experience: [{ company: 'Tri Coast Capital', title: 'Analyst', location: 'Los Angeles, CA', start: '2024', end: 'Present', description: 'Did the work' }],
    });
    const result = planBankReconciliation(parsed, UID, [{
      id: 'job-1', type: 'job', org: 'Tri Coast Capital', title: 'Analyst',
      date_range: '2024 - Present', location: null,
    }]);
    assert.deepEqual(result.inserts, []);
    assert.deepEqual(result.enrichments, [{ id: 'job-1', location: 'Los Angeles, CA' }]);
  });

  test('a later resume that omits the place does not erase the stored one', () => {
    const parsed = profile({
      experience: [{ company: 'Tri Coast Capital', title: 'Analyst', start: '2024', end: 'Present', description: 'Did the work' }],
    });
    const result = planBankReconciliation(parsed, UID, [{
      id: 'job-1', type: 'job', org: 'Tri Coast Capital', title: 'Analyst',
      date_range: '2024 - Present', location: 'Los Angeles, CA',
    }]);
    assert.deepEqual(result.enrichments, []);
  });

  test('a stored place is never overwritten by a different one', () => {
    const parsed = profile({
      experience: [{ company: 'Tri Coast Capital', title: 'Analyst', location: 'New York, NY', start: '2024', end: 'Present', description: 'Did the work' }],
    });
    const result = planBankReconciliation(parsed, UID, [{
      id: 'job-1', type: 'job', org: 'Tri Coast Capital', title: 'Analyst',
      date_range: '2024 - Present', location: 'Los Angeles, CA',
    }]);
    assert.deepEqual(result.enrichments, []);
  });
});

/* THREE WRITERS TOUCH THE BANK, and a field has to be in all of them.
 *
 *   bankEntriesFrom          inserts rows on upload
 *   planBankReconciliation   enriches rows that already exist
 *   PUT /profile/experience-bank  DELETES THE WHOLE BANK and rewrites it
 *
 * location shipped in the first only. That looked fine on a new account and was invisible
 * everywhere else: existing rows never gained one (enrichment ignored it), and one trip through
 * the work-history editor erased the rest, because a replace-everything route drops whatever its
 * schema omits. Measured live: 17 rows recreated in a single batch with every city gone.
 *
 * Source-scanned rather than executed because the third writer is an HTTP handler with a database
 * transaction in it, and the property worth pinning is textual anyway: does the field appear in
 * every writer.
 */
import { readFileSync } from 'node:fs';

describe('every bank writer carries every bank field', () => {
  const BANK_FIELDS = ['location'] as const;
  const writers = {
    'bankEntriesFrom (insert on upload)': readFileSync('src/routes/profile.ts', 'utf8'),
    'PUT /profile/experience-bank (replace)': readFileSync('src/routes/experienceBank.ts', 'utf8'),
  };

  for (const field of BANK_FIELDS) {
    for (const [name, source] of Object.entries(writers)) {
      test(`${name} writes ${field}`, () => {
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert.ok(
          new RegExp(`\\b${field}\\b`).test(code),
          `${name} does not mention ${field}; a writer that omits a field erases or never sets it`,
        );
      });
    }
  }

  test('the replace route accepts the field from the client, or it cannot round-trip', () => {
    const source = readFileSync('src/routes/experienceBank.ts', 'utf8');
    const schema = source.slice(source.indexOf('const entrySchema'), source.indexOf('const putBodySchema'));
    assert.match(
      schema.replace(/\/\*[\s\S]*?\*\//g, ''),
      /location:/,
      'zod strips unknown keys, so a field absent from entrySchema is dropped before the insert',
    );
  });
});

describe('resume upload retry safety', () => {
  const source = readFileSync('src/routes/profile.ts', 'utf8');

  test('a disconnected request stops before durable profile writes', () => {
    const disconnectGuard = source.indexOf('if (disconnectController.signal.aborted) return;');
    const profileInsert = source.indexOf('.insert(profiles)', disconnectGuard);
    assert.ok(disconnectGuard >= 0 && profileInsert > disconnectGuard);
  });

  test('experience reconciliation is serialized per user inside a transaction', () => {
    const reconciliation = source.slice(
      source.indexOf('const result = await db.transaction(async (tx) => {'),
      source.indexOf("'failed to persist parsed profile and experience bank'"),
    );
    assert.match(reconciliation, /pg_advisory_xact_lock\(hashtextextended/);
    assert.match(reconciliation, /await tx\.insert\(experience_bank\)/);
    assert.doesNotMatch(reconciliation, /await db\.insert\(experience_bank\)/);
  });

  test('only deterministic SHA-256 upload keys enter the replay path', () => {
    const key = 'a'.repeat(64);
    assert.equal(resumeUploadKeyFromHeader(key), key);
    assert.equal(resumeUploadKeyFromHeader([key]), key);
    assert.equal(resumeUploadKeyFromHeader('not-a-digest'), null);
  });

  test('the private retry key never enters the public profile response', () => {
    const stored = { ...profile(), _litos_resume_upload_key: 'b'.repeat(64) };
    const visible = publicResumeProfile(stored);
    assert.equal('_litos_resume_upload_key' in visible, false);
  });
});
